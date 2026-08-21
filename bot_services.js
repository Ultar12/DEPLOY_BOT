const axios = require('axios');

const herokuApi = axios.create({
    baseURL: 'https://api.heroku.com',
    headers: {
        'Accept': 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }
});
const fs = require('fs'); // Not directly used in functions, but good to keep if needed for other utils
const path = require('path'); // Not directly used in functions, but good to keep if needed for other utils
const { Pool } = require('pg'); // Not declared here, but passed in. Good practice to show dependency.

// --- Module-level variables for dependencies passed during init ---
let pool;
let backupPool;
let bot; // The TelegramBot instance
let HEROKU_API_KEY;
let GITHUB_LEVANTER_REPO_URL;
let GITHUB_RAGANORK_REPO_URL;
let ADMIN_ID;
let TELEGRAM_CHANNEL_ID; // Added for monitoring
let defaultEnvVars; // This will now hold an object like { levanter: {}, raganork: {} }
let appDeploymentPromises;
let RESTART_DELAY_MINUTES;
let getAnimatedEmoji;
let runOrphanDbCleanup;
let animateMessage;
let moduleParams = {};
let sendAnimatedMessage;
let monitorSendTelegramAlert;
let escapeMarkdown;

/**
 * Initializes database and API helper functions.
 * @param {object} params - Object containing dependencies from bot.js.
 * @param {object} params.mainPool - The main PostgreSQL pool.
 * @param {object} params.backupPool - The backup PostgreSQL pool.
 * @param {object} params.bot - The TelegramBot instance.
 * @param {string} params.HEROKU_API_KEY - Heroku API key.
 * @param {Array} params.NEON_ACCOUNTS - Array containing all Neon account configurations.
 * @param {string} params.GITHUB_LEVANTER_REPO_URL - GitHub URL for Levanter.
 * @param {string} params.GITHUB_RAGANORK_REPO_URL - GitHub URL for Raganork.
 * @param {string} params.ADMIN_ID - Admin Telegram ID.
 * @param {string} params.TELEGRAM_CHANNEL_ID - Channel ID for monitoring.
 * @param {object} params.defaultEnvVars - Object containing fallback env vars for each bot type (e.g., { levanter: {}, raganork: {} }).
 * @param {Map} params.appDeploymentPromises - Map for deployment promises.
 * @param {number} params.RESTART_DELAY_MINUTES - Restart delay.
 * @param {function} params.getAnimatedEmoji - Function to get animated emoji/text.
 * @param {function} params.animateMessage - Function to animate message.
 * @param {function} params.sendAnimatedMessage - Function to send an animated message.
 * @param {function} params.monitorSendTelegramAlert - Function to send Telegram alerts (from bot_monitor).
 * @param {function} params.escapeMarkdown - Utility function to escape markdown characters.
 */
function init(params) {
    // Assign parameters to module-level variables
    pool = params.mainPool;
    backupPool = params.backupPool;
    bot = params.bot;
    HEROKU_API_KEY = params.HEROKU_API_KEY;
    GITHUB_LEVANTER_REPO_URL = params.GITHUB_LEVANTER_REPO_URL;
    GITHUB_HERMIT_REPO_URL = params.GITHUB_HERMIT_REPO_URL;
    GITHUB_RAGANORK_REPO_URL = params.GITHUB_RAGANORK_REPO_URL;
    ADMIN_ID = params.ADMIN_ID;
    runOrphanDbCleanup = params.runOrphanDbCleanup; 
    moduleParams = params;
    NEON_ACCOUNTS = params.NEON_ACCOUNTS;
    TELEGRAM_CHANNEL_ID = params.TELEGRAM_CHANNEL_ID;
    defaultEnvVars = params.defaultEnvVars;
    appDeploymentPromises = params.appDeploymentPromises;
    RESTART_DELAY_MINUTES = params.RESTART_DELAY_MINUTES;
    getAnimatedEmoji = params.getAnimatedEmoji;
    animateMessage = params.animateMessage;
    sendAnimatedMessage = params.sendAnimatedMessage;
    monitorSendTelegramAlert = params.monitorSendTelegramAlert;
    escapeMarkdown = params.escapeMarkdown;

    console.log('--- bot_services.js initialized! ---');
}


function extractDbNameFromUrl(dbUrl) {
    if (!dbUrl || typeof dbUrl !== 'string') return null;
    const match = dbUrl.match(/\/([^/?]+)(?:\?.*)?$/);
    return match ? match[1] : null;
}


function setHerokuApiKey(newKey) {
    HEROKU_API_KEY = newKey;
    console.log('[bot_services] HEROKU_API_KEY updated in-memory.');
}


// === DB helper functions (using 'pool' for main DB) ===

async function addUserBot(u, b, s, botType) {
  try {
    const result = await pool.query(
      `INSERT INTO user_bots(user_id, bot_name, session_id, bot_type)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (user_id, bot_name) DO UPDATE SET session_id = EXCLUDED.session_id, bot_type = EXCLUDED.bot_type, created_at = CURRENT_TIMESTAMP
       RETURNING *;`,
      [u, b, s, botType]
    );
    if (result.rows.length > 0) {
      console.log(`[DB] addUserBot: Successfully added/updated bot "${b}" for user "${u}". Bot Type: "${botType}".`);
    } else {
      console.warn(`[DB] addUserBot: Insert/update operation for bot "${b}" for user "${u}" did not return a row.`);
    }
  } catch (error) {
    console.error(`[DB] addUserBot: CRITICAL ERROR Failed to add/update bot "${b}" for user "${u}":`, error.message, error.stack);
    if (monitorSendTelegramAlert) {
      monitorSendTelegramAlert(`CRITICAL DB ERROR: Failed to add/update bot "${b}" for user "${u}". Check logs.`, ADMIN_ID);
    } else {
      console.error("monitorSendTelegramAlert not initialized in bot_services.");
    }
  }
}

// In bot_services.js
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// In bot_services.js (REPLACES the entire function)

/**
 * Automatically prunes (deletes) the external resources (Heroku app, Neon DB)
 * for bots marked as 'logged_out' in the main DB.
 * Does NOT delete local database records, only targets external resources.
 * * @returns {Promise<{pruned: number, failedHeroku: number, failedNeon: number}>} - A summary.
 */
/**
 * Automatically prunes (deletes) all resources (Heroku, Neon, and Local DB)
 * for bots marked as 'logged_out'.
 * After completion, it triggers the orphan DB cleanup.
 * @returns {Promise<{pruned: number, failedHeroku: number, failedNeon: number}>} - A summary.
 */
async function pruneLoggedOutBot() {
    console.log('[Prune] Starting scheduled job to prune ALL logged-out resources (External + Local)...');

    // 1. Get dependencies from moduleParams
    // 💡 ADDED 'runOrphanDbCleanup' to the dependencies
    const { deleteNeonDatabase, mainPool, monitorSendTelegramAlert, ADMIN_ID, herokuApi, HEROKU_API_KEY, runOrphanDbCleanup } = moduleParams; 

    // 2. Get all bots marked as 'logged_out' from the *main* database
    const loggedOutBots = await getLoggedOutBots(); // Uses main 'pool' internally

    if (loggedOutBots.length === 0) {
        console.log('[Prune] No logged-out bots found to prune.');
        return { pruned: 0, failedHeroku: 0, failedNeon: 0 };
    }

    console.log(`[Prune] Found ${loggedOutBots.length} logged-out bots. Starting external & local resource deletion...`);

    let prunedCount = 0;
    let failedHerokuCount = 0;
    let failedNeonCount = 0;

    // 3. Loop through each bot and delete its external resources
    for (const bot of loggedOutBots) {
        const { user_id, app_name } = bot;
        let herokuDeleted = false;
        let neonDeleted = false;
        let neonAccountIdToDelete = '1'; // Default

        // --- FETCH NEON ACCOUNT ID ---
        try {
            const deploymentInfo = await mainPool.query( 
                'SELECT neon_account_id FROM user_deployments WHERE user_id = $1 AND app_name = $2',
                [user_id, app_name]
            );
            if (deploymentInfo.rows.length > 0 && deploymentInfo.rows[0].neon_account_id) {
                neonAccountIdToDelete = deploymentInfo.rows[0].neon_account_id;
                console.log(`[Prune] Found Neon Account ID ${neonAccountIdToDelete} for ${app_name}.`);
            } else {
                console.warn(`[Prune] Neon account ID not found for ${app_name}. Assuming Account '1'.`);
            }
        } catch (dbError) {
            console.error(`[Prune] Error fetching Neon Account ID for ${app_name}:`, dbError.message);
        }
        // --- END Fetch ---

        // --- Part A: Delete Heroku App ---
        try {
            console.log(`[Prune] Deleting Heroku app: ${app_name} (User: ${user_id})`);
            await herokuApi.delete(`/apps/${app_name}`, {
                headers: {
                    'Authorization': `Bearer ${HEROKU_API_KEY}`,
                    'Accept': 'application/vnd.heroku+json; version=3'
                }
            });
            herokuDeleted = true;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.warn(`[Prune] Heroku app ${app_name} was already deleted.`);
                herokuDeleted = true; // Treat as success if already gone
            } else {
                console.error(`[Prune] Failed to delete Heroku app ${app_name}:`, error.message);
                failedHerokuCount++;
            }
        }

        // --- Part B: Delete Neon Database (Using Account ID) ---
        const dbName = app_name.replace(/-/g, '_');
        if (herokuDeleted) { 
            try {
                console.log(`[Prune] Deleting Neon database: ${dbName} from Account ${neonAccountIdToDelete}`);
                const neonResult = await deleteNeonDatabase(dbName, neonAccountIdToDelete); 

                if (neonResult.success) {
                    console.log(`[Prune] Successfully deleted Neon DB: ${dbName} from Account ${neonAccountIdToDelete}`);
                    neonDeleted = true;
                } else {
                     throw new Error(neonResult.error || 'Unknown Neon deletion error');
                }
            } catch (error) {
                console.error(`[Prune] Failed to delete Neon DB ${dbName} from Account ${neonAccountIdToDelete}:`, error.message);
                failedNeonCount++;
            }
        } else {
             failedNeonCount++;
             console.warn(`[Prune] Skipping Neon deletion for ${app_name} (Heroku delete failed).`);
        }


        // --- 💡 Part C: Tally & Local DB Cleanup (NEW LOGIC) 💡 ---
        if (herokuDeleted && neonDeleted) {
            prunedCount++;
            console.log(`[Prune] External resources for ${app_name} pruned. Deleting local records...`);
            
            try {
                // This function is defined in bot_services.js and deletes from all local tables
                await permanentlyDeleteBotRecord(user_id, app_name); 
                console.log(`[Prune] Successfully deleted local DB records for ${app_name}.`);
            } catch (dbError) {
                console.error(`[Prune] CRITICAL: Failed to delete local DB records for ${app_name}:`, dbError.message);
                // Alert admin that external resources are gone but local DB entry failed to delete
                if (monitorSendTelegramAlert && ADMIN_ID) {
                    monitorSendTelegramAlert(`CRITICAL PRUNE ERROR: External resources for ${app_name} were deleted, but local DB cleanup FAILED. Manual check required.`, ADMIN_ID);
                }
            }
        } else {
             console.warn(`[Prune] Failed to prune all external resources for ${app_name}. Local DB record will be kept for next cycle.`);
        }
    } // End loop

    // --- 4. Report to Admin ---
    console.log(`[Prune] Job finished. Fully pruned (External+Local): ${prunedCount} bots. Heroku fails: ${failedHerokuCount}, Neon fails: ${failedNeonCount}.`);

    if (monitorSendTelegramAlert && ADMIN_ID && (prunedCount > 0 || failedHerokuCount > 0 || failedNeonCount > 0)) {
         monitorSendTelegramAlert(
            `*Weekly Resource Prune Report*\n\n` +
            `Fully pruned (Heroku+Neon+Local DB): ${prunedCount}\n` +
            `Failed Heroku deletions: ${failedHerokuCount}\n` +
            `Failed Neon DB deletions: ${failedNeonCount}\n\n` +
            `Note: Local database records *were also deleted* for successfully pruned bots.`, // <-- UPDATED TEXT
            ADMIN_ID
         );
    }

    // --- 💡 5. Run Orphan Cleanup (NEW STEP) 💡 ---
    if (runOrphanDbCleanup) {
        console.log('[Prune] Prune job complete. Now triggering /deldb (Orphan Cleanup) function...');
        await runOrphanDbCleanup(ADMIN_ID);
    } else {
        console.error('[Prune] Cannot run orphan cleanup: runOrphanDbCleanup function was not passed to moduleParams.');
    }

    return { pruned: prunedCount, failedHeroku: failedHerokuCount, failedNeon: failedNeonCount };
}


/**
 * Fetches all bots marked as 'logged_out' from the database.
 * @returns {Promise<Array<{user_id: string, app_name: string}>>}
 */
async function getLoggedOutBots() {
    try {
        // We select 'bot_name' and rename it to 'app_name' for consistency
        const result = await pool.query(
            `SELECT user_id, bot_name AS app_name 
             FROM user_bots 
             WHERE status = 'logged_out';`
        );
        console.log(`[DB] Found ${result.rows.length} logged-out bots.`);
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get logged-out bots:`, error.message);
        return [];
    }
}


async function processBotSwitch(userId, appName, targetType, newSessionId) {
    console.log(`[Switch] Starting AWS clean slate switch for ${appName} to ${targetType}...`);
    const { deleteSelfHostedDatabase } = moduleParams; 
    
    try {
        // 1. Clear user state to prevent input collisions
        if (moduleParams.userStates && moduleParams.userStates[userId]) {
            delete moduleParams.userStates[userId];
        }

        // 2. DELETE OLD APP FROM HEROKU
        try {
            await herokuApi.delete(`/apps/${appName}`, {
                 headers: { 
                    'Authorization': `Bearer ${process.env.HEROKU_API_KEY}`, 
                    'Accept': 'application/vnd.heroku+json; version=3' 
                }
            });
            console.log(`[Switch] Deleted Heroku app: ${appName}`);
        } catch (e) {
            console.log(`[Switch] Heroku app ${appName} already gone or inaccessible.`);
        }

        // 3. AWS DATABASE DELETE (The "Clean Slate" Logic)
        const dbNameForDeletion = appName.replace(/-/g, '_');
        console.log(`[Switch] Requesting AWS deletion for DB: ${dbNameForDeletion}`);
        
        // Use your specific AWS deletion function
        const awsDeleteResult = await deleteSelfHostedDatabase(dbNameForDeletion);
        
        if (awsDeleteResult.success) {
            console.log(`[Switch] AWS Database ${dbNameForDeletion} wiped successfully.`);
        } else {
            console.warn(`[Switch] AWS Delete warning: ${awsDeleteResult.error}`);
        }

        // 4. GENERATE NEW UNIQUE NAME
        // Heroku often prevents immediate reuse of a deleted name; a suffix fixes this.
        const randomSuffix = require('crypto').randomBytes(2).toString('hex');
        const newAppName = `${appName.substring(0, 20)}-${randomSuffix}`;
        
        console.log(`[Switch] Migrating identity: ${appName} -> ${newAppName}`);

        // 5. UPDATE LOCAL DATABASE RECORDS
        // We update the existing record with the new name and type
        await pool.query(
            `UPDATE user_bots SET bot_name = $1, bot_type = $2, session_id = $3, status = 'Building' 
             WHERE bot_name = $4 AND user_id = $5`,
            [newAppName, targetType, newSessionId, appName, userId]
        );
        
        await pool.query(
            `UPDATE user_deployments SET app_name = $1, bot_type = $2, session_id = $3 
             WHERE app_name = $4 AND user_id = $5`,
            [newAppName, targetType, newSessionId, appName, userId]
        );

        // 6. PREPARE FRESH CONFIG
        // We omit DATABASE_URL here. buildWithProgress will detect this and 
        // trigger the AWS createDatabase logic for the new type.
        const targetDefaults = moduleParams.defaultEnvVars[targetType] || {};
        const newVars = {
            ...targetDefaults,
            SESSION_ID: newSessionId,
            APP_NAME: newAppName
        };

        // 7. TRIGGER FRESH BUILD
        // We pass isRestore = false to force new database provisioning
        await buildWithProgress(userId, newVars, false, false, targetType);
        
    } catch (error) {
        console.error(`[Switch Error] ${appName}:`, error.message);
        moduleParams.bot.sendMessage(userId, `❌ Switch failed: ${error.message}. Please contact Admin.`);
    }
}


async function getAwsDbConnectionString(appName) {
    // Runs the AWS-DB lookup against a given pool. Returns the connection string,
    // or null if there's no usable AWS_MAIN record for this app in that pool.
    const lookupInPool = async (dbPool) => {
        const result = await dbPool.query(
            `SELECT config_vars FROM user_deployments 
             WHERE app_name = $1 AND neon_account_id = 'AWS_MAIN'`,
            [appName]
        );

        if (result.rows.length === 0) return null;

        const configVars = result.rows[0].config_vars;
        return configVars?.DATABASE_URL || null;
    };

    // 1. Try the main database first
    let mainDbError = null;
    try {
        const dbUrl = await lookupInPool(pool);
        if (dbUrl) {
            return { success: true, dbUrl: dbUrl };
        }
        console.warn(`[DB] getAwsDbConnectionString: No usable AWS record for "${appName}" in main DB. Checking backup DB...`);
    } catch (error) {
        mainDbError = error;
        console.error(`[DB] getAwsDbConnectionString: Main DB error for "${appName}": ${error.message}. Falling back to backup DB...`);
    }

    // 2. Main DB came up empty or errored — fall back to backupPool
    if (!backupPool) {
        console.error('[DB-Backup] getAwsDbConnectionString: backupPool is not initialized, cannot fall back.');
        return {
            success: false,
            message: mainDbError
                ? `Main DB error: ${mainDbError.message}`
                : "Bot not found or is not currently hosted on the AWS platform ('AWS_MAIN' identifier missing)."
        };
    }

    try {
        const dbUrl = await lookupInPool(backupPool);
        if (dbUrl) {
            console.log(`[DB-Backup] getAwsDbConnectionString: Found AWS record for "${appName}" in backup DB.`);
            return { success: true, dbUrl: dbUrl };
        }
        return {
            success: false,
            message: "Bot not found or is not currently hosted on the AWS platform ('AWS_MAIN' identifier missing) in either main or backup DB."
        };
    } catch (backupError) {
        console.error(`[DB-Backup] getAwsDbConnectionString: Backup DB error for "${appName}": ${backupError.message}`);
        return {
            success: false,
            message: `Database error — main: ${mainDbError ? mainDbError.message : 'no record'}, backup: ${backupError.message}`
        };
    }
}




async function removeBlacklistedName(chatId, nameFragment) {
  try {
    const result = await pool.query(
      'DELETE FROM group_blacklist WHERE chat_id = $1 AND name_fragment = $2 RETURNING *',
      [chatId, nameFragment.toLowerCase()]
    );
    // Return success: true only if a row was actually deleted
    return { success: result.rowCount > 0 };
  } catch (error) {
    console.error(`[DB] Failed to remove blacklist name ${nameFragment} for chat ${chatId}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function getBlacklistedNames(chatId) {
  try {
    const result = await pool.query(
      'SELECT name_fragment FROM group_blacklist WHERE chat_id = $1 ORDER BY added_at ASC',
      [chatId]
    );
    // Return an array of the names
    return result.rows.map(row => row.name_fragment);
  } catch (error) {
    console.error(`[DB] Failed to get blacklist for chat ${chatId}:`, error.message);
    return [];
  }
}


async function syncDatabaseWithHeroku() {
    console.log('[Sync] Starting full database synchronization with Heroku...');
    const syncStats = {
        addedToUserBots: 0,
        addedToDeployments: 0,
        unmatchedHerokuApps: []
    };

    try {
        // Step 1: Get all apps from Heroku
        const herokuAppsResponse = await herokuApi.get('https://api.heroku.com/apps', {
            headers: {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            }
        });
        const herokuAppNames = new Set(herokuAppsResponse.data.map(app => app.name));
        
        // Step 2: Get all app names from the local database
        const dbAppsResult = await pool.query('SELECT bot_name FROM user_bots');
        const dbAppNames = new Set(dbAppsResult.rows.map(row => row.bot_name));

        // Step 3: Find apps that are on Heroku but not in the database
        const missingApps = [...herokuAppNames].filter(appName => !dbAppNames.has(appName));

        if (missingApps.length === 0) {
            return { success: true, message: 'Database is already in sync with Heroku. No missing apps were found.' };
        }

        console.log(`[Sync] Found ${missingApps.length} apps on Heroku that are missing from the database.`);

        // Step 4: Add the missing apps to the database
        for (const appName of missingApps) {
            try {
                const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                const configVars = configRes.data;
                const sessionId = configVars.SESSION_ID || 'N/A';
                let botType = 'unknown';
                if (sessionId && sessionId.startsWith(RAGANORK_SESSION_PREFIX)) {
                    botType = 'raganork';
                } else if (sessionId && sessionId.startsWith(LEVANTER_SESSION_PREFIX)) {
                    botType = 'levanter';
                }
                
                await addUserBot(ADMIN_ID, appName, sessionId, botType);
                await saveUserDeployment(ADMIN_ID, appName, sessionId, configVars, botType);
                
                syncStats.addedToUserBots++;
                syncStats.addedToDeployments++;
                console.log(`[Sync] Added missing app "${appName}" to DB with ADMIN_ID as owner.`);
            } catch (configError) {
                console.error(`[Sync] Failed to fetch config vars for app "${appName}". Skipping.`, configError.message);
                syncStats.unmatchedHerokuApps.push(appName);
            }
        }

    } catch (error) {
        console.error('[Sync] CRITICAL ERROR during full sync:', error.message);
        return { success: false, message: `An unexpected error occurred during sync: ${error.message}` };
    }

    const finalMessage = `Synchronization complete. Added ${syncStats.addedToUserBots} missing apps to the database.`;
    console.log(`[Sync] ${finalMessage}`);
    return { success: true, message: finalMessage, stats: syncStats };
}

async function getLoggedOutBotsForEmail() {
    try {
        const result = await pool.query(`
            SELECT ub.user_id, ub.bot_name, ud.email
            FROM user_bots ub
            JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
            WHERE ub.status = 'logged_out' 
              AND ud.is_free_trial = FALSE 
              AND ud.email IS NOT NULL;
        `);
        console.log(`[DB] Found ${result.rows.length} logged-out paid bots with registered emails.`);
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get logged-out bots for email:`, error.message);
        return [];
    }
}


// --- NEW FUNCTIONS FOR REWARDS AND STATS ---

async function getUserBotCount(userId) {
    try {
        const result = await pool.query('SELECT COUNT(bot_name) as count FROM user_bots WHERE user_id = $1', [userId]);
        return parseInt(result.rows[0].count, 10) || 0;
    } catch (error) {
        console.error(`[DB] Failed to get bot count for user ${userId}:`, error.message);
        return 0;
    }
}

async function hasReceivedReward(userId) {
    try {
        const result = await pool.query('SELECT 1 FROM key_rewards WHERE user_id = $1', [userId]);
        return result.rows.length > 0;
    } catch (error) {
        console.error(`[DB] Failed to check for reward for user ${userId}:`, error.message);
        return false;
    }
}

async function recordReward(userId) {
    try {
        await pool.query('INSERT INTO key_rewards(user_id) VALUES ($1)', [userId]);
        console.log(`[DB] Recorded reward for user ${userId}.`);
    } catch (error) {
        console.error(`[DB] Failed to record reward for user ${userId}:`, error.message);
    }
}


async function reconcileDatabaseWithHeroku(botType) {
    console.log(`[Sync] Starting database reconciliation for ${botType}...`);
    try {
        const [herokuAppsRes, dbAppsRes] = await Promise.all([
            herokuApi.get('https://api.heroku.com/apps', {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            }),
            pool.query('SELECT app_name, user_id FROM user_deployments WHERE bot_type = $1', [botType])
        ]);

        const herokuApps = herokuAppsRes.data.map(app => app.name).filter(name => name.includes(botType));
        const dbApps = dbAppsRes.rows;

        const herokuAppSet = new Set(herokuApps);
        const renamedApps = [];

        for (const dbApp of dbApps) {
            if (!herokuAppSet.has(dbApp.app_name)) {
                const originalPrefix = dbApp.app_name.replace(/-\d+$/, '');
                const potentialNewNames = herokuApps.filter(hName => hName.startsWith(originalPrefix));

                if (potentialNewNames.length === 1) {
                    const newName = potentialNewNames[0];
                    console.log(`[Sync] Found renamed app: ${dbApp.app_name} -> ${newName}.`);
                    renamedApps.push({ oldName: dbApp.app_name, newName, userId: dbApp.user_id });
                }
            }
        }
        
        for (const app of renamedApps) {
            await pool.query('UPDATE user_bots SET bot_name = $1 WHERE user_id = $2 AND bot_name = $3', [app.newName, app.userId, app.oldName]);
            await pool.query('UPDATE user_deployments SET app_name = $1 WHERE user_id = $2 AND app_name = $3', [app.newName, app.userId, app.oldName]);
            console.log(`[Sync] Successfully updated DB for ${app.oldName} to ${app.newName}.`);
        }

        console.log(`[Sync] Reconciliation complete. Found and fixed ${renamedApps.length} renamed apps.`);
        return { success: true, message: `Reconciliation fixed ${renamedApps.length} renamed apps.` };
        
    } catch (error) {
        console.error('[Sync] Reconciliation failed:', error);
        return { success: false, message: error.message };
    }
}


// In bot_services.js

async function getDynoStatus(appName) {
    try {
        const response = await herokuApi.get(`https://api.heroku.com/apps/${appName}/dynos`, {
            headers: { 
                Authorization: `Bearer ${HEROKU_API_KEY}`, 
                Accept: 'application/vnd.heroku+json; version=3' 
            }
        });
        // If there are any dynos and the first one is not 'crashed', the bot is on.
        if (response.data.length > 0 && response.data[0].state !== 'crashed') {
            return 'on';
        }
        return 'off'; // No dynos running means it's off.
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return 'deleted'; // App doesn't exist on Heroku
        }
        console.error(`[Dyno Check] Error fetching dyno status for ${appName}:`, error.message);
        return 'error'; // API or other error
    }
}


/**
 * Pushes the expiration date to Heroku config variables.
 */
async function syncExpirationToHeroku(appName, newDateStr) {
    try {
        if (!HEROKU_API_KEY || !appName || !newDateStr) return false;
        const isoDate = new Date(newDateStr).toISOString();
        await herokuApi.patch(`/apps/${appName}/config-vars`, 
            { EXPIRATION_DATE: isoDate },
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );
        console.log(`[Expiration] Synced EXPIRATION_DATE to Heroku for ${appName}`);
        return true;
    } catch (e) {
        console.error(`[Expiration] Failed to sync EXPIRATION_DATE to Heroku for ${appName}:`, e.message);
        return false;
    }
}


async function getExpiringBots() {
    try {
        const result = await pool.query(
            `SELECT user_id, app_name FROM user_deployments 
             WHERE warning_sent_at IS NULL AND expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days';`
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get expiring bots:`, error.message);
        return [];
    }
}


async function getExpiringBackups() {
    try {
        // This query now fetches bots that are expiring AND
        // have not received the 7-day warning (level 0) OR
        // have received the 7-day warning but not the 3-day (level 7).
        const result = await pool.query(
            `SELECT user_id, app_name, expiration_date, warning_level 
             FROM user_deployments 
             WHERE expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
               AND paused_at IS NULL
               AND warning_level IN (0, 7);` // <-- CHANGED THIS LINE
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get expiring backups:`, error.message);
        return [];
    }
}

// REPLACE setBackupWarningSent with this new function
async function setBackupWarningLevel(userId, appName, level) {
    try {
        await pool.query(
            'UPDATE user_deployments SET warning_level = $1 WHERE user_id = $2 AND app_name = $3;',
            [level, userId, appName]
        );
    } catch (error) {
        console.error(`[DB] Failed to set backup warning level for ${appName}:`, error.message);
    }
}


async function deleteUserBot(u, b) {
  try {
    await pool.query(
      'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2'
      ,[u, b]
    );
    console.log(`[DB] deleteUserBot: Successfully deleted bot "${b}" for user "${u}".`);
  } catch (error) {
    console.error(`[DB] deleteUserBot: Failed to delete bot "${b}" for user "${u}":`, error.message);
  }
}

async function getUserBots(u) {
  try {
    const r = await pool.query(
      'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at'
      ,[u]
    );
    console.log(`[DB] getUserBots: Fetching for user_id "${u}" - Found:`, r.rows.map(x => x.bot_name));
    return r.rows.map(x => x.bot_name);
  }
  catch (error) {
    console.error(`[DB] getUserBots: Failed to get bots for user "${u}":`, error.message);
    return [];
  }
}

// === Backup Expiration and Warning Functions ==


async function setBackupWarningSent(userId, appName) {
    try {
        await pool.query(
            'UPDATE user_deployments SET warning_sent_at = NOW() WHERE user_id = $1 AND app_name = $2;',
            [userId, appName]
        );
    } catch (error) {
        console.error(`[DB] Failed to set backup warning sent for ${appName}:`, error.message);
    }
}

async function getExpiredBackups() {
    try {
        const result = await pool.query(
            `SELECT user_id, app_name 
             FROM user_deployments 
             WHERE expiration_date <= NOW()
               AND paused_at IS NULL;` // <-- This line is added to ignore paused bots
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get expired backups:`, error.message);
        return [];
    }
}



async function getUserIdByBotName(botName) {
    try {
        // 1. Check the active bots table
        let r = await pool.query(
            'SELECT user_id FROM user_bots WHERE bot_name=$1 ORDER BY created_at DESC LIMIT 1',
            [botName]
        );
        if (r.rows.length > 0 && r.rows[0].user_id) {
            return r.rows[0].user_id;
        }

        // 2. Check the deployments (backups) table
        r = await pool.query(
            'SELECT user_id FROM user_deployments WHERE app_name=$1 ORDER BY deploy_date DESC LIMIT 1',
            [botName]
        );
        if (r.rows.length > 0 && r.rows[0].user_id) {
            return r.rows[0].user_id;
        }

        // 3. IF STILL NOT FOUND, AUTO-ASSIGN TO ADMIN
        console.warn(`[DB] getUserIdByBotName: Bot "${botName}" has no owner in DB. Auto-assigning to ADMIN_ID (${ADMIN_ID}).`);
        
        try {
            // Fetch config from Heroku to restore it fully to the database
            const response = await herokuApi.get(`/apps/${botName}/config-vars`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            });
            
            const configVars = response.data;
            const sessionId = configVars.SESSION_ID || 'N/A';
            
            // Determine bot type based on session prefixes
            let botType = 'levanter'; // Default
            if (sessionId.startsWith('RGNK')) botType = 'raganork';
            else if (sessionId.startsWith('H')) botType = 'hermit';
            
            // Save it to the database under the Admin's ID automatically
            await addUserBot(ADMIN_ID, botName, sessionId, botType);
            await saveUserDeployment(ADMIN_ID, botName, sessionId, configVars, botType);
            
            console.log(`[DB] Successfully rescued orphaned bot "${botName}" and assigned it to Admin.`);
        } catch (herokuErr) {
            // If it fails (e.g., 404 not found on Heroku), still return ADMIN_ID 
            // so the calling function can cleanly delete the ghost record.
            console.warn(`[DB] Could not fetch Heroku config for "${botName}". Proceeding with Admin ID fallback.`);
        }

        return ADMIN_ID; // Fallback to Admin ID

    } catch (error) {
        console.error(`[DB] getUserIdByBotName: Failed to get user ID by bot name "${botName}":`, error.message);
        return ADMIN_ID; // Fallback to Admin ID on catastrophic DB failure
    }
}


async function getAllUserBots() {
    try {
        const r = await pool.query('SELECT user_id, bot_name, bot_type FROM user_bots ORDER BY created_at');
        console.log(`[DB] getAllUserBots: Fetched ${r.rows.length} bots with their types.`);
        return r.rows;
    }
    catch (error) {
        console.error('[DB] getAllUserBots: Failed to get all user bots:', error.message);
        return [];
    }
}

async function getBotNameBySessionId(sessionId) {
    try {
        const r = await pool.query(
            'SELECT bot_name FROM user_bots WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1'
            ,[sessionId]
        );
        const botName = r.rows.length > 0 ? r.rows[0].bot_name : null;
        console.log(`[DB] getBotNameBySessionId: For session "${sessionId}", found bot_name: "${botName}".`);
        return botName;
    } catch (error) {
        console.error(`[DB] getBotNameBySessionId: Failed to get bot name by session ID "${sessionId}":`, error.message);
        return null;
    }
}

// This new version deletes the bot record from BOTH databases.
async function permanentlyDeleteBotRecord(userId, appName) {
    try {
        // Delete from the main database (pool)
        await pool.query('DELETE FROM user_bots WHERE user_id = $1 AND bot_name = $2', [userId, appName]);
        await pool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [userId, appName]);
        
        // --- THIS IS THE NEW LOGIC ---
        // Also delete from the backup database (backupPool)
        await backupPool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [userId, appName]);
        // --- END OF NEW LOGIC ---

        console.log(`[DB-Cleanup] Permanently deleted all records for app ${appName} from all databases.`);
        return true;
    } catch (error) {
        console.error(`[DB-Cleanup] Failed to permanently delete records for ${appName}:`, error.message);
        return false;
    }
}


async function updateUserSession(u, b, s) {
  try {
    await pool.query(
      'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3'
      ,[s, u, b]
    );
    console.log(`[DB] updateUserSession: Successfully updated session for bot "${b}" (user "${u}").`);
  } catch (error) {
    console.error(`[DB] updateUserSession: Failed to update session for bot "${b}" (user "${u}"):`, error.message);
  }
}

// --- FIX: addDeployKey now accepts an optional userId ---
async function addDeployKey(key, uses, createdBy, userId = null) {
  await pool.query(
    'INSERT INTO deploy_keys(key, uses_left, created_by, user_id) VALUES($1, $2, $3, $4)',
    [key, uses, createdBy, userId]
  );
  console.log(`[DB] addDeployKey: Added key "${key}" for user "${userId || 'General'}" with ${uses} uses by "${createdBy}".`);
}


// --- FIX: useDeployKey now requires the user's ID for verification ---
async function useDeployKey(key, userId) {
  const res = await pool.query(
    `UPDATE deploy_keys
     SET uses_left = uses_left - 1
     WHERE key = $1 AND uses_left > 0 AND (user_id = $2 OR user_id IS NULL)
     RETURNING uses_left`,
    [key, userId]
  );
  if (res.rowCount === 0) {
    console.log(`[DB] useDeployKey: Key "${key}" not found, no uses left, or not authorized for user "${userId}".`);
    return null;
  }
  const left = res.rows[0].uses_left;
  if (left === 0) {
    await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]);
    console.log(`[DB] useDeployKey: Key "${key}" for user "${userId}" fully used and deleted.`);
  } else {
    console.log(`[DB] useDeployKey: Key "${key}" for user "${userId}" used. ${left} uses left.`);
  }
  return left;
}


// --- FIX: getAllDeployKeys now includes user_id ---
async function getAllDeployKeys() {
    try {
        const res = await pool.query('SELECT key, uses_left, created_by, user_id, created_at FROM deploy_keys ORDER BY created_at DESC');
        return res.rows;
    } catch (error) {
        console.error('[DB] getAllDeployKeys: Failed to get all deploy keys:', error.message);
        return [];
    }
}

/**
 * Scans all defined NEON_ACCOUNTS to see if a database with the given name exists.
 * @param {string} dbName The underscore-separated database name (e.g., 'my_app_name').
 * @returns {Promise<{exists: boolean, account_id?: string, connection_string?: string}>}
 */
async function checkIfDatabaseExists(dbName) {
    const neonDbName = dbName.replace(/-/g, '_');

    if (process.env.SELF_HOSTED_DB_URL && process.env.SELF_HOSTED_DB_SECRET) {
        try {
            const res = await axios.get(`${process.env.SELF_HOSTED_DB_URL}/getdb/${neonDbName}`, {
                headers: { 'x-api-key': process.env.SELF_HOSTED_DB_SECRET },
                timeout: 8000
            });
            if (res.data && res.data.success) {
                console.log(`[DB Check] Found existing AWS DB '${neonDbName}'.`);
                return { exists: true, account_id: 'AWS_MAIN', connection_string: res.data.connection_string };
            }
        } catch (error) {
            if (!(error.response && error.response.status === 404)) {
                console.warn(`[DB Check] AWS lookup failed for '${neonDbName}': ${error.message.substring(0, 80)}`);
            }
        }
    }

    for (const accountConfig of NEON_ACCOUNTS) {
        const accountId = String(accountConfig.id);
        const { api_key, project_id, branch_id, db_user, db_password, db_host } = accountConfig;
        const dbsUrl = `https://console.neon.tech/api/v2/projects/${project_id}/branches/${branch_id}/databases`;
        const headers = { 'Authorization': `Bearer ${api_key}`, 'Accept': 'application/json' };
        try {
            const dbsResponse = await axios.get(dbsUrl, { headers });
            const foundDb = dbsResponse.data.databases.find(db => db.name === neonDbName);
            if (foundDb) {
                const connectionString = `postgresql://${db_user}:${db_password}@${db_host}/${neonDbName}?sslmode=require`;
                console.log(`[Neon Check] Found existing DB '${neonDbName}' on Account ${accountId}.`);
                return { exists: true, account_id: accountId, connection_string: connectionString };
            }
        } catch (error) {
            console.warn(`[Neon Check] Failed to check Account ${accountId}: ${error.message.substring(0, 50)}`);
        }
    }
    return { exists: false };
}


async function deleteDeployKey(key) {
  try {
    const result = await pool.query(
      'DELETE FROM deploy_keys WHERE key = $1 RETURNING key',
      [key]
    );
    if (result.rowCount > 0) {
      console.log(`[DB] deleteDeployKey: Successfully deleted key "${key}".`);
      return true;
    } else {
      console.warn(`[DB] deleteDeployKey: Key "${key}" not found for deletion.`);
      return false;
    }
  } catch (error) {
    console.error(`[DB] deleteDeployKey: Failed to delete key "${key}":`, error.message);
    return false;
  }
}

// --- MODIFIED FUNCTION ---
async function updateUserActivity(userId) {
  const query = `
    INSERT INTO user_activity(user_id, last_seen)
    VALUES($1, NOW())
    ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW();
  `;
  try {
    // Now only writes to the main pool (DATABASE_URL)
    await pool.query(query, [userId]);
    console.log(`[DB] User activity updated for ${userId}.`);
  } catch (error) {
    console.error(`[DB] Failed to update user activity for ${userId}:`, error.message);
  }
}
// --- END OF MODIFICATION ---

async function getUserLastSeen(userId) {
  try {
    const result = await pool.query('SELECT last_seen FROM user_activity WHERE user_id = $1', [userId]);
    if (result.rows.length > 0) {
      return result.rows[0].last_seen;
    }
    return null;
  }
  catch (error) {
    console.error(`[DB] Failed to get user last seen for ${userId}:`, error.message);
    return null;
  }
}

async function isUserBanned(userId) {
    try {
        const result = await pool.query('SELECT 1 FROM banned_users WHERE user_id = $1', [userId]);
        return result.rows.length > 0;
    } catch (error) {
        console.error(`[DB-Main] Error checking ban status for user ${userId}:`, error.message);
        return false;
    }
}

async function banUser(userId, bannedByAdminId) {
    try {
        await pool.query(
            'INSERT INTO banned_users(user_id, banned_by) VALUES($1, $2) ON CONFLICT (user_id) DO NOTHING;',
            [userId, bannedByAdminId]
        );
        console.log(`[Admin] User ${userId} banned by ${bannedByAdminId}.`);
        return true;
    } catch (error) {
        console.error(`[Admin] Error banning user ${userId}:`, error.message);
        return false;
    }
}

async function unbanUser(userId) {
    try {
        const result = await pool.query('DELETE FROM banned_users WHERE user_id = $1 RETURNING user_id;', [userId]);
        if (result.rowCount > 0) {
            console.log(`[Admin] User ${userId} unbanned.`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`[Admin] Error unbanning user ${userId}:`, error.message);
        return false;
    }
}


// In bot_services.js

/**
 * Saves or updates deployment details in the main database.
 * Preserves original deploy_date and expiration_date on conflict/update.
 * @param {string} userId
 * @param {string} appName The app name used as the key.
 * @param {string} sessionId
 * @param {object} configVars
 * @param {string} botType
 * @param {boolean} [isFreeTrial=false]
 * @param {Date|null} [expirationDateToUse=null] Explicit expiration date.
 * @param {string|null} [email=null] User's email.
 * @param {string} neonAccountId The Neon Account ID (e.g., '1', '2', '34').
 */
async function saveUserDeployment(userId, appName, sessionId, configVars, botType, isFreeTrial = false, expirationDateToUse = null, email = null, neonAccountId) {
    if (!pool) {
        console.error("[DB-Main] Main pool is not initialized in bot_services.");
        return;
    }
    try {
        const accountId = neonAccountId ? String(neonAccountId) : '1';
        if (!neonAccountId) {
            console.warn(`[DB-Main] neonAccountId was not provided for ${appName}, defaulting to '1'.`);
        }

        const cleanConfigVars = JSON.parse(JSON.stringify(configVars));
        const deployDate = new Date();

        // 💡 RECOVERY LOGIC: Use Heroku's EXPIRATION_DATE if the database was wiped
        let finalExpirationDate;
        if (expirationDateToUse) {
            finalExpirationDate = new Date(expirationDateToUse);
        } else if (configVars && configVars.EXPIRATION_DATE) {
            finalExpirationDate = new Date(configVars.EXPIRATION_DATE);
        } else {
            finalExpirationDate = new Date(deployDate.getTime() + (isFreeTrial ? 1 : 30) * 24 * 60 * 60 * 1000);
        }

        const query = `

            INSERT INTO user_deployments(user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at, is_free_trial, email, neon_account_id)
            VALUES($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)
            ON CONFLICT (user_id, app_name) DO UPDATE SET
               session_id = EXCLUDED.session_id,
               config_vars = EXCLUDED.config_vars,
               bot_type = EXCLUDED.bot_type,
               deleted_from_heroku_at = NULL,
               is_free_trial = EXCLUDED.is_free_trial,
               email = EXCLUDED.email,
               neon_account_id = EXCLUDED.neon_account_id,
               deploy_date = user_deployments.deploy_date,
               expiration_date = user_deployments.expiration_date;
        `;

        // Execute query, passing the clean accountId
        await pool.query(query, [userId, appName, sessionId, cleanConfigVars, botType, deployDate, finalExpirationDate, isFreeTrial, email, accountId]);

        console.log(`[DB-Main] Saved/Updated deployment for app ${appName} (Neon Acc: ${accountId}). Is Free Trial: ${isFreeTrial}. Expiration: ${finalExpirationDate.toISOString()}.`);
    } catch (error) {
        console.error(`[DB-Main] Failed to save user deployment for ${appName}:`, error.message, error.stack);
        if (moduleParams && moduleParams.monitorSendTelegramAlert && moduleParams.ADMIN_ID) {
            moduleParams.monitorSendTelegramAlert(`CRITICAL DB ERROR saving deployment for ${appName}. Check logs.`, moduleParams.ADMIN_ID);
        } else {
             console.error("[DB-Main] Cannot send admin alert: monitorSendTelegramAlert or ADMIN_ID missing from moduleParams.");
        }
    }
}





async function getUserDeploymentsForRestore(userId) {
    try {
        const result = await pool.query(
            `SELECT app_name, session_id, config_vars, deploy_date, expiration_date, bot_type, deleted_from_heroku_at
             FROM user_deployments WHERE user_id = $1 ORDER BY deploy_date DESC;`,
            [userId]
        );
        console.log(`[DB-Backup] Fetched ${result.rows.length} deployments for user ${userId} for restore.`);
        return result.rows;
    } catch (error) {
        console.error(`[DB-Backup] Failed to get user deployments for restore ${userId}:`, error.message);
        return [];
    }
}

async function deleteUserDeploymentFromBackup(userId, appName) {
    try {
        const result = await pool.query(
            'DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2 RETURNING app_name;',
            [userId, appName]
        );
        if (result.rowCount > 0) {
            console.log(`[DB-Backup] Permanently deleted deployment for user ${userId}, app ${appName} from backup DB.`);
            return true;
        }
        console.log(`[DB-Backup] No deployment found to permanently delete for user ${userId}, app ${appName}.`);
        return false;
    } catch (error) {
        console.error(`[DB-Backup] Failed to permanently delete user deployment from backup for ${appName}:`, error.message);
        return false;
    }
}

async function markDeploymentDeletedFromHeroku(userId, appName) {
    try {
        await pool.query(
            `UPDATE user_deployments
             SET deleted_from_heroku_at = NOW()
             WHERE user_id = $1 AND app_name = $2;`,
            [userId, appName]
        );
        console.log(`[DB-Backup] Marked deployment for user ${userId}, app ${appName} as deleted from Heroku.`);
    } catch (error) {
        console.error(`[DB-Backup] Failed to mark deployment as deleted from Heroku for ${appName}:`, error.message);
    }
}

// In bot_services.js

async function getAllDeploymentsFromBackup(botType) {
    // Ensure backupPool is initialized and available
    if (!backupPool) {
        console.error('[DB-Backup] Backup pool is not initialized in bot_services.');
        return [];
    }
    try {
        // --- THIS IS THE UPDATED QUERY ---
        // Added ud.expiration_date to the selected columns
        const result = await backupPool.query(
            `SELECT ud.user_id, ud.app_name, ud.session_id, ud.config_vars, ud.bot_type, ud.expiration_date
             FROM user_deployments ud
             INNER JOIN user_bots ub ON ud.user_id = ub.user_id AND ud.app_name = ub.bot_name
             WHERE ud.bot_type = $1 AND ub.status = 'online' -- Only select bots that were 'online'
             ORDER BY ud.app_name ASC;`,
            [botType]
        );
        // --- END OF UPDATED QUERY ---

        console.log(`[DB-Backup] Fetched ${result.rows.length} 'online' deployments of type ${botType} for mass restore from backup pool.`);
        return result.rows; // Now includes expiration_date
    } catch (error) {
        console.error(`[DB-Backup] Failed to get 'online' deployments for mass restore:`, error.message);
        // Attempt to log the specific SQL error if available
        if (error.code) {
            console.error(`[DB-Backup] SQL Error Code: ${error.code}, Detail: ${error.detail || 'N/A'}`);
        }
        // Notify admin about the failure
        if (monitorSendTelegramAlert && ADMIN_ID) {
            monitorSendTelegramAlert(`CRITICAL DB ERROR during /restoreall (fetching backup): ${error.message}. Check logs.`, ADMIN_ID);
        } else {
             console.error("[DB-Backup] monitorSendTelegramAlert or ADMIN_ID not available for error notification.");
        }
        return [];
    }
}



async function getAllBotDeployments() {
    // This query depends on your table name.
    // It should get the app_name and user_id from your main bot table
    const query = 'SELECT bot_name, user_id FROM user_bots'; // Or 'deployments', etc.
    const { rows } = await pool.query(query);
    return rows;
}


// --- FIXED FUNCTION: NOW AUTO-DETECTS AND RESCUES UNKNOWN BOTS ---
async function backupAllPaidBots() {
    console.log('[DB-Backup] Starting backup process for ALL Heroku apps...');
    let backedUpCount = 0;
    let failedCount = 0;
    let notFoundCount = 0;
    const herokuAppList = [];

    // 1. ADD HERMIT to the stats object to prevent undefined errors
    const typeStats = {
        levanter: { backedUp: [], failed: [] }, 
        raganork: { backedUp: [], failed: [] }, 
        hermit: { backedUp: [], failed: [] }, // <-- ADDED HERMIT
        unknown: { backedUp: [], failed: [] }   
    };
    
    try {
        const allHerokuAppsResponse = await herokuApi.get('https://api.heroku.com/apps', {
            headers: {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            }
        });
        const herokuApps = allHerokuAppsResponse.data.map(app => app.name);
        herokuAppList.push(...herokuApps);
        
        console.log(`[DB-Backup] Found ${herokuAppList.length} apps on Heroku.`);
        if (herokuAppList.length === 0) {
            return { success: true, message: 'No apps found on Heroku to back up.' };
        }

    } catch (error) {
        console.error('[DB-Backup] CRITICAL ERROR fetching apps from Heroku:', error);
        return { success: false, message: `Failed to fetch app list from Heroku API: ${error.message}` };
    }

    for (const appName of herokuAppList) {
        let userId = ADMIN_ID;
        let botType = 'unknown';
        let isOrphan = false; // 2. Track if it needs rescuing

        try {
            const localBotRecord = await pool.query('SELECT user_id, bot_type FROM user_bots WHERE bot_name = $1', [appName]);
            if (localBotRecord.rows.length > 0) {
                userId = localBotRecord.rows[0].user_id;
                botType = localBotRecord.rows[0].bot_type;
            } else {
                console.warn(`[DB-Backup] App "${appName}" found on Heroku but not in local 'user_bots' table. Rescuing to Admin.`);
                notFoundCount++;
                isOrphan = true; // Flag it!
            }

            const response = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3'
                }
            });
            const configVars = response.data;
            const sessionId = configVars.SESSION_ID || 'N/A';

            // 3. AUTO-DETECT BOT TYPE IF UNKNOWN
            if (botType === 'unknown' || !botType) {
                if (sessionId.startsWith('levanter_')) {
                    botType = 'levanter';
                } else if (sessionId.startsWith('RGNK')) {
                    botType = 'raganork';
                } else if (sessionId.startsWith('H') || sessionId.startsWith('HQ_')) {
                    botType = 'hermit';
                } else {
                    botType = 'unknown';
                }
            }

            // 4. RESCUE THE GHOST BOT TO ADMIN
            if (isOrphan && botType !== 'unknown') {
                await addUserBot(ADMIN_ID, appName, sessionId, botType);
                console.log(`[DB-Backup] Orphaned bot "${appName}" automatically assigned to Admin.`);
            }

            // Back it up
            await saveUserDeployment(userId, appName, sessionId, configVars, botType);
            console.log(`[DB-Backup] Successfully backed up: ${appName} (Owner: ${userId}, Type: ${botType})`);
            
            backedUpCount++;
            if (typeStats[botType]) {
                typeStats[botType].backedUp.push(appName); 
            } else {
                typeStats.unknown.backedUp.push(appName); 
            }
            
        } catch (error) {
            console.error(`[DB-Backup] Failed to back up app ${appName}. Error: ${error.message}`);
            failedCount++;
            if (typeStats[botType]) {
                typeStats[botType].failed.push(appName); 
            } else {
                typeStats.unknown.failed.push(appName); 
            }
        }
    }
    
    const summary = `Backup complete! Processed ${herokuAppList.length} relevant apps on Heroku.`;
    console.log(`[DB-Backup] ${summary}`);
    
    return { 
        success: true, 
        message: summary, 
        stats: typeStats, 
        miscStats: {
            totalRelevantApps: herokuAppList.length,
            appsBackedUp: backedUpCount,
            appsNotFoundLocally: notFoundCount,
            appsFailed: failedCount,
            appsSkipped: 0
        }
    };
}



// Helper function to create all tables in a given database pool
async function createAllTablesInPool(dbPool, dbName) {
    console.log(`[DB-${dbName}] Checking/creating all tables...`);
    
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
        session_id TEXT,
        bot_type   TEXT DEFAULT 'levanter',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status     TEXT DEFAULT 'online',
        PRIMARY KEY (user_id, bot_name)
      );
    `);
    await dbPool.query(`ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS deploy_keys (
        key        TEXT PRIMARY KEY,
        uses_left  INTEGER NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await dbPool.query(`ALTER TABLE deploy_keys ADD COLUMN IF NOT EXISTS user_id TEXT;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS temp_deploys (
        user_id       TEXT PRIMARY KEY,
        last_deploy_at TIMESTAMP NOT NULL
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_id TEXT PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await dbPool.query(`ALTER TABLE user_activity ADD COLUMN IF NOT EXISTS keyboard_version INTEGER DEFAULT 0;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        user_id TEXT PRIMARY KEY,
        banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        banned_by TEXT
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS key_rewards (
          user_id TEXT PRIMARY KEY,
          reward_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS all_users_backup (
        user_id TEXT PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        username TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_deployments (
        user_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        session_id TEXT,
        config_vars JSONB,
        bot_type TEXT,
        deploy_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expiration_date TIMESTAMP,
        deleted_from_heroku_at TIMESTAMP,
        warning_sent_at TIMESTAMP,
        PRIMARY KEY (user_id, app_name)
      );
    `);

    await dbPool.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS is_free_trial BOOLEAN DEFAULT FALSE;`);
    
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS free_trial_monitoring (
        user_id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        trial_start_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        warning_sent_at TIMESTAMP
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pending_payments (
        reference  TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        email      TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await dbPool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS bot_type TEXT;`);
    await dbPool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS app_name TEXT, ADD COLUMN IF NOT EXISTS session_id TEXT;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS completed_payments (
        reference  TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        email      TEXT NOT NULL,
        amount     INTEGER NOT NULL, -- Stored in kobo
        currency   TEXT NOT NULL,
        paid_at    TIMESTAMP WITH TIME ZONE NOT NULL
      );
    `);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        message_id BIGINT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        unpin_at TIMESTAMP WITH TIME ZONE NOT NULL
      );
    `);

    await dbPool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            data JSONB,
            expires_at TIMESTAMP WITH TIME ZONE
        );
    `);

    console.log(`[DB-${dbName}] All tables checked/created successfully.`);
}

// In bot_services.js, replace the entire syncDatabases function

async function syncDatabases(sourcePool, targetPool) {
    const clientSource = await sourcePool.connect();
    const clientTarget = await targetPool.connect();
    
    try {
        await clientTarget.query('BEGIN');

        const sourceTablesResult = await clientSource.query(`
            SELECT tablename FROM pg_catalog.pg_tables 
            WHERE schemaname = 'public' AND tablename != 'sessions';
        `);
        const sourceTableNames = sourceTablesResult.rows.map(row => row.tablename);

        if (sourceTableNames.length === 0) {
            return { success: true, message: 'Source database has no tables to copy.' };
        }
        
        console.log('[Sync] Tables to clone:', sourceTableNames);
        
        // Drop old tables in the target to ensure a clean slate
        for (const tableName of sourceTableNames) {
            await clientTarget.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE;`);
        }

        // Recreate each table's schema AND primary keys in the target database
        for (const tableName of sourceTableNames) {
            console.log(`[Sync] Cloning schema for table "${tableName}"...`);
            
            // Get column definitions
            const columnsResult = await clientSource.query(`
                SELECT column_name, data_type, character_maximum_length, is_nullable 
                FROM information_schema.columns 
                WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position;
            `, [tableName]);
            
            let createTableScript = `CREATE TABLE "${tableName}" (`;
            createTableScript += columnsResult.rows.map(col => 
                `"${col.column_name}" ${col.data_type}` +
                (col.character_maximum_length ? `(${col.character_maximum_length})` : '') +
                (col.is_nullable === 'NO' ? ' NOT NULL' : '')
            ).join(', ');

            // --- THIS IS THE FIX: Get and add the Primary Key ---
            const pkeyResult = await clientSource.query(`
                SELECT conname AS constraint_name, 
                       pg_get_constraintdef(c.oid) AS constraint_definition
                FROM pg_constraint c
                JOIN pg_namespace n ON n.oid = c.connamespace
                WHERE contype = 'p' AND conrelid = '${tableName}'::regclass;
            `);

            if (pkeyResult.rows.length > 0) {
                createTableScript += `, CONSTRAINT "${pkeyResult.rows[0].constraint_name}" ${pkeyResult.rows[0].constraint_definition}`;
            }
            // --- END OF FIX ---
            
            createTableScript += ');';
            await clientTarget.query(createTableScript);
        }

        // Copy data from source to target
        for (const tableName of sourceTableNames) {
            const { rows } = await clientSource.query(`SELECT * FROM "${tableName}";`);
            if (rows.length > 0) {
                const columns = Object.keys(rows[0]);
                const colNames = columns.map(c => `"${c}"`).join(', ');
                const valuePlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');
                const insertQuery = `INSERT INTO "${tableName}" (${colNames}) VALUES (${valuePlaceholders});`;

                for (const row of rows) {
                    const values = columns.map(col => row[col]);
                    await clientTarget.query(insertQuery, values);
                }
                console.log(`[Sync] Copied ${rows.length} rows to "${tableName}".`);
            }
        }

        await clientTarget.query('COMMIT');
        return { success: true, message: `Successfully cloned ${sourceTableNames.length} tables.` };

    } catch (error) {
        await clientTarget.query('ROLLBACK');
        console.error('[Sync] Database sync failed:', error);
        return { success: false, message: `Sync failed: ${error.message}` };
    } finally {
        clientSource.release();
        clientTarget.release();
    }
}




async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    console.log(`[AppNotFoundHandler] Handling 404 for app "${appName}". Initiated by ${callingChatId}.`);

    let ownerUserId = await getUserIdByBotName(appName);

    if (!ownerUserId) {
        ownerUserId = callingChatId;
        console.warn(`[AppNotFoundHandler] Owner not found in DB for "${appName}". Falling back to ${callingChatId}.`);
    } else {
        console.log(`[AppNotFoundHandler] Found owner ${ownerUserId} in DB for app "${appName}".`);
    }

    await deleteUserBot(ownerUserId, appName);
    await markDeploymentDeletedFromHeroku(ownerUserId, appName);
    console.log(`[AppNotFoundHandler] Removed "${appName}" from DBs for user "${ownerUserId}".`);

    const message = `App "${escapeMarkdown(appName)}" was not found on Heroku. It has been removed from your "My Bots" list.`;

    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId;
    const messageToEditId = originalMessageId;

    if (messageToEditId) {
        await bot.editMessageText(message, {
            chat_id: messageTargetChatId,
            message_id: messageToEditId,
            parse_mode: 'Markdown'
        }).catch(err => console.error(`Failed to edit message in handleAppNotFoundAndCleanDb: ${err.message}`));
    } else {
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' })
            .catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb: ${err.message}`));
    }

    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `Your bot "*${escapeMarkdown(appName)}*" was not found on Heroku and has been removed from your list by the admin.`, { parse_mode: 'Markdown' })
             .catch(err => console.error(`Failed to send notification to owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
}

// === API functions ===

async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserId = null, isRemoval = false) {
    try {
        const res = await axios.get('https://api.heroku.com/apps', {
            headers: {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            }
        });
        const apps = res.data.map(a => a.name);
        if (!apps.length) {
            if (messageId) return bot.editMessageText('No apps found.', { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, 'No apps found.');
        }

        const chunkArray = (arr, size) => {
            const out = [];
            for (let i = 0; i < arr.length; i += size) {
                out.push(arr.slice(i, i + size));
            }
            return out;
        };

        const rows = chunkArray(apps, 3).map(r =>
            r.map(name => ({
                text: name,
                callback_data: isRemoval
                    ? `${callbackPrefix}:${name}:${targetUserId}`
                    : targetUserId
                        ? `${callbackPrefix}:${name}:${targetUserId}`
                        : `${callbackPrefix}:${name}`
            }))
        );

        const message = `Total apps: ${apps.length}\nSelect an app:`;
        if (messageId) {
            await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
        } else {
            await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: rows } });
        }
    } catch (e) {
        const errorMsg = `Error fetching apps: ${e.response?.data?.message || e.message}`;
        if (e.response && e.response.status === 401) {
            console.error(`Heroku API key is invalid/expired. Cannot fetch apps. User: ${chatId}`);
            if (messageId) {
                bot.editMessageText("Heroku API key invalid. Please contact the bot admin.", { chat_id: chatId, message_id: messageId });
            } else {
                bot.sendMessage(chatId, "Heroku API key invalid. Please contact the bot admin.");
            }
        } else {
            if (messageId) {
                bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId });
            } else {
                bot.sendMessage(chatId, errorMsg);
            }
        }
    }
}

        

async function buildWithProgress(targetChatId, vars, _isFreeTrial, isRestore, botType, referredBy = null, ipAddress = null, daysToAdd = null) {
    const isFreeTrial = false;
    // 1. Get all the tools from the 'init' function
        const { 
        bot, herokuApi, HEROKU_API_KEY, GITHUB_LEVANTER_REPO_URL, GITHUB_RAGANORK_REPO_URL, GITHUB_HERMIT_REPO_URL,
        ADMIN_ID, defaultEnvVars, escapeMarkdown, animateMessage, mainPool, 
        MUST_JOIN_CHANNEL_ID, createNeonDatabase, appDeploymentPromises, getAnimatedEmoji,
        hasReceivedReward, addDeployKey, recordReward, grantReferralRewards
    } = moduleParams;

    
    let appName = vars.APP_NAME;
    const originalAppName = appName;
    
    let adminLogMsg; // The log message sent to the ADMIN_ID chat
    let primaryBuildMsg; // The message sent to the USER (targetChatId)
    
    let buildResult = false; 
    let neonAccountId = '1';
    let primaryAnimateIntervalId; // The animation for the user's message

    // --- Define which message to animate ---
    let primaryAnimChatId;
    let primaryAnimMsgId;

    try {

            // --- 💡 FIX: CHECK OWNERSHIP & RENAME IF BLOCKED 💡 ---
        try {
            // Check if the app exists and if we have access
            await herokuApi.get(`/apps/${appName}`, { 
                headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } 
            });
            
            // If isRestore is true, we usually rename anyway to be safe, 
            // but if it's a standard redeploy and we own it, we keep the name.
            if (isRestore) {
                 const newName = `${appName.split('-')[0]}-${require('crypto').randomBytes(2).toString('hex')}`;
                 console.log(`[Build] Restore mode: Renaming ${appName} -> ${newName}`);
                 appName = newName;
                 vars.APP_NAME = newName;
            }

        } catch (e) {
            if (e.response && e.response.status === 403) {
                // 🛑 403 FORBIDDEN DETECTED: We don't own this app (Old Account).
                console.warn(`[Build] 403 Forbidden for ${appName}. Ownership conflict detected. Renaming...`);
                
                const randomSuffix = require('crypto').randomBytes(2).toString('hex');
                const newAppName = `${appName.substring(0, 20)}-${randomSuffix}`;
                
                // Update DB references immediately so the user's "My Bots" list updates
                await mainPool.query('UPDATE user_bots SET bot_name = $1 WHERE bot_name = $2', [newAppName, appName]);
                await mainPool.query('UPDATE user_deployments SET app_name = $1 WHERE app_name = $2', [newAppName, appName]);
                
                appName = newAppName;
                vars.APP_NAME = newAppName;
                
                // Notify Admin
                if (String(targetChatId) !== ADMIN_ID) {
                     bot.sendMessage(ADMIN_ID, `⚠️ **Ownership Conflict Fixed**\n\nBot \`${originalAppName}\` was owned by another Heroku account. Renamed to \`${appName}\` for this deployment.`).catch(()=>{});
                }

            } else if (e.response && e.response.status === 404) {
                // 404 is good, it means the name is free (or deleted).
            } else {
                // Ignore other errors for now, let the creation step handle them
            }
        }
        // --- 💡 END OF FIX 💡 ---

        
        // --- NEW MESSAGE LOGIC ---
        // This logic determines where to send animations.
        
        if (String(targetChatId) === ADMIN_ID) {
            // The admin is deploying for themselves.
            // The "primary" message IS the admin's message.
            primaryBuildMsg = await bot.sendMessage(ADMIN_ID, `Starting build for *${escapeMarkdown(appName)}*...`, { parse_mode: 'Markdown' });
            adminLogMsg = null; // No separate log needed.
            
            primaryAnimChatId = primaryBuildMsg.chat.id;
            primaryAnimMsgId = primaryBuildMsg.message_id;
            
        } else {
            // A user is deploying.
            // Send a simple log to the admin.
            adminLogMsg = await bot.sendMessage(ADMIN_ID, `Starting build for *${escapeMarkdown(appName)}* (User: \`${targetChatId}\`)...`, { parse_mode: 'Markdown' });
            // Send the "primary" message to the user.
            primaryBuildMsg = await bot.sendMessage(targetChatId, `Your bot *${escapeMarkdown(appName)}* is being built...`, { parse_mode: 'Markdown' });
            
            primaryAnimChatId = primaryBuildMsg.chat.id;
            primaryAnimMsgId = primaryBuildMsg.message_id;
        }
        // --- END OF NEW LOGIC ---
        
        
        primaryAnimateIntervalId = await animateMessage(primaryAnimChatId, primaryAnimMsgId, `Building ${appName}...`);

        // --- Step 1: Create the Heroku app ---
        const appSetup = { name: appName, region: 'us', stack: 'heroku-24' };
        await herokuApi.post('/apps', appSetup, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
        clearInterval(primaryAnimateIntervalId);

        // --- All animations now go to the user ---
        await bot.editMessageText(`Configuring resources...`, { chat_id: primaryAnimChatId, message_id: primaryAnimMsgId });
        primaryAnimateIntervalId = await animateMessage(primaryAnimChatId, primaryAnimMsgId, 'Configuring resources');

          let actionText = "Creating";
        if (primaryAnimMsgId) {
            await bot.editMessageText(`Building ${appName}...\n\nStep 1/4: Provisioning database...`, { chat_id: primaryAnimChatId, message_id: primaryAnimMsgId, parse_mode: 'Markdown' }).catch(()=>{});
        } else {
            console.log(`[Build] Step 1/4: Provisioning database... (No message to edit)`);
        }

        const dbName = appName.replace(/-/g, '_');

        if (isRestore && vars.DATABASE_URL) {
            // Restore path: trust the DATABASE_URL already stored in user_deployments.
            // Do NOT re-provision — just carry it forward as-is.
            actionText = "Re-using existing database from backup record";
            if (vars.neon_account_id) neonAccountId = vars.neon_account_id;
            console.log(`[Build/Restore] Re-using stored DATABASE_URL for ${appName} (Account: ${neonAccountId}).`);
        } else {
            actionText = "Creating NEW database";
            console.log(`[Build/New] Creating NEW DB: ${dbName}`);
            const neonResult = await createNeonDatabase(dbName);
            if (!neonResult.success) throw new Error(`Database creation failed: ${neonResult.error}`);
            vars.DATABASE_URL = neonResult.connection_string;
            neonAccountId = neonResult.account_id;
            console.log(`[Build/New] Set DATABASE_URL for ${appName} to NEW DB (Account: ${neonAccountId}).`);
        }

        if (primaryAnimMsgId) {
             await bot.editMessageText(`Building ${appName}...\n\nStep 1/4: ${actionText}...`, { chat_id: primaryAnimChatId, message_id: primaryAnimMsgId, parse_mode: 'Markdown' }).catch(()=>{});
        }

        // --- End of Neon Logic Integration ---


        // --- Step 3: Set Buildpacks ---
        let buildpacksToInstall = [];
        
        // --- 💡 START OF FIX 💡 ---
        // This now groups Hermit with Levanter and Raganork.
        // All three bots will get the same set of buildpacks.
        if (botType === 'levanter' || botType === 'raganork' || botType === 'hermit') {
            
            console.log(`[Build] Setting full buildpacks (ffmpeg, nodejs) for ${botType} bot: ${appName}`);
            buildpacksToInstall = [
  { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
  { buildpack: 'https://github.com/heroku/heroku-buildpack-activestorage-preview.git' },
  { buildpack: 'heroku/nodejs' }
];

            
        } else {
            // This is now an error/unknown case
            console.log(`[Build] No buildpacks set for unknown bot type: ${botType}`);
        }
        // --- 💡 END OF FIX 💡 ---

        // This part remains the same
        if (buildpacksToInstall.length > 0) {
            await herokuApi.put(
              `/apps/${appName}/buildpack-installations`,
              { updates: buildpacksToInstall },
              { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
            );
        } else {
            // This will now only happen if the botType is somehow unknown
            console.log(`[Build] Skipping buildpack installation step.`);
        }
        
        // This must be outside the 'if' block so the animation always stops
        clearInterval(primaryAnimateIntervalId);


                        // --- 💡 PRE-CALCULATE EXPIRATION DATE 💡 ---
        let expirationDateToUse = null;
        if (isRestore) {
            expirationDateToUse = vars.expiration_date ? new Date(vars.expiration_date) : (vars.EXPIRATION_DATE ? new Date(vars.EXPIRATION_DATE) : null);
        } else {
            if (vars.DAYS) {
                const daysToAddVal = parseInt(vars.DAYS, 10);
                if (!isNaN(daysToAddVal) && daysToAddVal > 0) {
                    expirationDateToUse = new Date(Date.now() + daysToAddVal * 24 * 60 * 60 * 1000);
                }
            } else if (!isFreeTrial) {
                expirationDateToUse = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Default 30 days
            }
        }

        // --- Step 4: Set Environment Variables ---
        await bot.editMessageText(`Setting environment variables...`, { chat_id: primaryAnimChatId, message_id: primaryAnimMsgId });
        primaryAnimateIntervalId = await animateMessage(primaryAnimChatId, primaryAnimMsgId, 'Setting environment variables');
        
        const filteredVars = {};
        for (const key in vars) {
            if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && String(vars[key]).trim() !== '') {
                filteredVars[key] = vars[key];
            }
        }
        
        const botTypeSpecificDefaults = defaultEnvVars[botType] || {};
        const finalConfigVars = isRestore ? filteredVars : { ...botTypeSpecificDefaults, ...filteredVars };

        if (process.env.PAIRING_URL) {
            finalConfigVars.PLAY_URL = process.env.PAIRING_URL;
            finalConfigVars.PAIRING_URL = process.env.PAIRING_URL;
        }

        // 🚀 INJECT EXPIRATION DATE TO HEROKU 🚀
        if (expirationDateToUse) {
            finalConfigVars.EXPIRATION_DATE = expirationDateToUse.toISOString();
        }
        
        await herokuApi.patch(`/apps/${appName}/config-vars`, 
            { ...finalConfigVars, APP_NAME: appName },
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );
        clearInterval(primaryAnimateIntervalId);



        // --- Step 5: Trigger Build from GitHub ---
                // --- Step 5: Trigger Build from GitHub ---
        await bot.editMessageText(`Starting to build your Bot...`, { chat_id: primaryAnimChatId, message_id: primaryAnimMsgId });
        
        // --- 💡 UPDATED REPO URL LOGIC 💡 ---
        let repoUrl;
        if (botType === 'raganork') {
            repoUrl = GITHUB_RAGANORK_REPO_URL;
        } else if (botType === 'hermit') {
            // (This relies on GITHUB_HERMIT_REPO_URL being passed into init)
            repoUrl = GITHUB_HERMIT_REPO_URL; 
        } else {
            // Default to Levanter
            repoUrl = GITHUB_LEVANTER_REPO_URL;
        }
    
        
        const buildStartRes = await herokuApi.post(`/apps/${appName}/builds`, {
            source_blob: { url: `${repoUrl}/tarball/main` }
        }, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });

        // --- Step 6: Wait for Build to Finish ---
        const buildId = buildStartRes.data.id;
        const statusUrl = `/apps/${appName}/builds/${buildId}`;
        let buildStatus = 'pending';
        let currentPct = 0;
        let buildProgressInterval;

        try {
            const BUILD_COMPLETION_TIMEOUT = 600 * 1000; // 10 minutes
            const buildPromise = new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    clearInterval(buildProgressInterval);
                    reject(new Error(`Build process timed out after ${BUILD_COMPLETION_TIMEOUT / 1000} seconds.`));
                }, BUILD_COMPLETION_TIMEOUT);

                buildProgressInterval = setInterval(async () => {
                    try {
                        const poll = await herokuApi.get(statusUrl, {
                            headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` }
                        });
                        buildStatus = poll.data.status;
                        
                        if (buildStatus === 'pending') {
                            currentPct = Math.min(99, currentPct + Math.floor(Math.random() * 5) + 1);
                        } else if (buildStatus === 'succeeded') {
                            currentPct = 100;
                        } else if (buildStatus === 'failed') {
                            currentPct = 'Error';
                        }
                        
                        // --- This now edits the USER's message ---
                        await bot.editMessageText(`Building... ${currentPct}%`, {
                            chat_id: primaryAnimChatId, message_id: primaryAnimMsgId
                        }).catch(() => {});
                        
                        if (buildStatus !== 'pending') {
                            clearInterval(buildProgressInterval);
                            clearTimeout(timeoutId);
                            if (buildStatus === 'succeeded') {
                                resolve('succeeded');
                            } else {
                                reject(new Error(`Build failed with status: ${buildStatus}`));
                            }
                        }
                    } catch (error) {
                        clearInterval(buildProgressInterval);
                        clearTimeout(timeoutId);
                        reject(new Error(`Error polling build status: ${error.message}`));
                    }
                }, 10000);
            });
            await buildPromise;
        } catch (err) {
            if (buildProgressInterval) clearInterval(buildProgressInterval);
            throw err; 
        }

                 // --- Step 7: Handle Build Succeeded ---
        console.log(`[Flow] buildWithProgress: Heroku build for "${appName}" SUCCEEDED.`);

        // AUTOMATIC DYNO CONFIGURATION (LEVANTER + RAGANORK)
if (botType === 'levanter' || botType === 'raganork') {
    try {
        console.log(`[Dyno] Auto-scaling "${appName}" (${botType}) to Standard-2X...`);
        await herokuApi.patch(`/apps/${appName}/formation`, {
            updates: [{
                process: 'web',
                quantity: 1,
                size: 'standard-2x'
            }]
        }, {
            headers: {
                'Authorization': `Bearer ${HEROKU_API_KEY}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            }
        });
        console.log(`[Dyno] "${appName}" (${botType}) is now live on Standard-2X.`);
    } catch (dynoError) {
        console.error(`[Dyno Error] Could not auto-scale ${botType} "${appName}":`, dynoError.response?.data || dynoError.message);
        // Fallback: try to just turn it on if Standard-2X fails
        await herokuApi.patch(`/apps/${appName}/formation`, {
            updates: [{ process: 'web', quantity: 1 }]
        }, {
            headers: {
                'Authorization': `Bearer ${HEROKU_API_KEY}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            }
        }).catch(() => {});
    }
} 
// --- END OF DYNO LOGIC ---

        const finalConfigVarsAfterBuild = (await herokuApi.get(`/apps/${appName}/config-vars`, { 
            headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } 
        })).data;
        
        await addUserBot(targetChatId, appName, finalConfigVarsAfterBuild.SESSION_ID, botType);

        


        await saveUserDeployment(
            targetChatId, appName, finalConfigVarsAfterBuild.SESSION_ID, 
            finalConfigVarsAfterBuild, botType, isFreeTrial, 
            expirationDateToUse,
            vars.email || null, neonAccountId
        );

        // --- ✅ Reward Logic ---
        if (!isRestore) {
            try {
                const userBotCount = await getUserBotCount(targetChatId);
                const userHasReceivedReward = await hasReceivedReward(targetChatId);
                if (userBotCount >= 10 && !userHasReceivedReward) {
                    const newKey = require('crypto').randomBytes(4).toString('hex').toUpperCase();
                    await addDeployKey(newKey, 1, 'AUTOMATIC_REWARD', targetChatId);
                    await recordReward(targetChatId);
                    await bot.sendMessage(targetChatId, `Congratulations! You have deployed 10 or more bots. As a reward, here is a free deploy key:\n\n\`${newKey}\``, { parse_mode: 'Markdown' });
                    await bot.sendMessage(ADMIN_ID, `Reward issued to user \`${targetChatId}\` for 10 deployments. Key: \`${newKey}\``, { parse_mode: 'Markdown' });
                }
            } catch (rewardError) {
                console.error(`[Reward] Failed to check or issue reward:`, rewardError.message);
            }
        }
        
        // --- Referral Logic ---
        if (!isRestore && referredBy) {
            await grantReferralRewards(targetChatId, appName);
        }

        // --- Admin Notification (This is a NEW message, which is fine) ---
        if (!isRestore) {
            const userChat = await bot.getChat(targetChatId);
            const userDetails = `*Name:* ${escapeMarkdown(userChat.first_name || '')} ${escapeMarkdown(userChat.last_name || '')}\n*Username:* @${escapeMarkdown(userChat.username || 'N/A')}\n*Chat ID:* \`${escapeMarkdown(targetChatId)}\``;
            const appDetails = `*App Name:* \`${escapeMarkdown(appName)}\`\n*Session ID:* \`${escapeMarkdown(vars.SESSION_ID)}\`\n*Type:* Paid`;
            await bot.sendMessage(ADMIN_ID, `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`, { parse_mode: 'Markdown', disable_web_page_preview: true });
        }




        // --- 💡 START OF HERMIT RESTART FIX (STEP 7.5) 💡 ---
        if (botType === 'hermit') {
            console.log(`[Flow] Hermit build succeeded. Forcing an immediate restart for ${appName} to ensure connection.`);
            
            // We don't need to await this. Just send the command.
            herokuApi.delete(`/apps/${appName}/dynos`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } })
                .catch(err => console.warn(`[Flow] Failed to force-restart ${appName}: ${err.message}`));
            
            // Give Heroku a 5-second head start before we listen
            await new Promise(r => setTimeout(r, 5000));
        }
        // --- 💡 END OF HERMIT RESTART FIX 💡 ---
        // --- MODIFIED "Wait for Connect" Logic ---
        // This block now animates and edits the USER's message
        
        const baseWaitingText = `Build successful! Waiting for bot to connect...`;
        await bot.editMessageText(`${baseWaitingText} ${getAnimatedEmoji()}`, { chat_id: primaryAnimChatId, message_id: primaryAnimMsgId, parse_mode: 'Markdown' });
        primaryAnimateIntervalId = await animateMessage(primaryAnimChatId, primaryAnimMsgId, baseWaitingText); // Re-using primaryAnimateIntervalId
        
        const appStatusPromise = new Promise((resolve, reject) => {
            const STATUS_CHECK_TIMEOUT = 300 * 1000;
            const timeoutId = setTimeout(() => {
                const appPromise = appDeploymentPromises.get(appName);
                if (appPromise) {
                    appPromise.reject(new Error(`Bot did not connect within ${STATUS_CHECK_TIMEOUT / 1000} seconds (Session might be logged out).`));
                }
            }, STATUS_CHECK_TIMEOUT);
            
            appDeploymentPromises.set(appName, { resolve, reject, animateIntervalId: primaryAnimateIntervalId, timeoutId });
        });

        try {
            await appStatusPromise; // Wait for connection
            const promiseData = appDeploymentPromises.get(appName);
            if (promiseData) {
               clearTimeout(promiseData.timeoutId);
               if (promiseData.animateIntervalId) clearInterval(promiseData.animateIntervalId);
            }

            const successMessage = isRestore ? 
                `Your bot *${escapeMarkdown(appName)}* has been restored and is now live!` :
                `Your bot *${escapeMarkdown(appName)}* is now live!\n\nBackup your app for future reference.`;
            
            // Edit the USER's message to show SUCCESS
            await bot.editMessageText(
                successMessage,
                {
                    chat_id: primaryAnimChatId,
                    message_id: primaryAnimMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: isRestore ? undefined : { inline_keyboard: [[{ text: `Backup "${appName}"`, callback_data: `backup_app:${appName}` }]] }
                }
            ).catch(() => {});

            // If it was a user, update the ADMIN's log to show SUCCESS
            if (adminLogMsg) { 
                const adminSuccessMsg = isRestore ? 
                    `Restore successful for *${escapeMarkdown(appName)}* (User: \`${targetChatId}\`). Bot connected.` :
                    `Build successful for *${escapeMarkdown(appName)}* (User: \`${targetChatId}\`). Bot connected.`;
                await bot.editMessageText(adminSuccessMsg, { chat_id: ADMIN_ID, message_id: adminLogMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
            }
            
            buildResult = true;

        } catch (err) { // Connection Failed (Logged Out)
            const promiseData = appDeploymentPromises.get(appName);
            if (promiseData) {
                if (promiseData.animateIntervalId) clearInterval(promiseData.animateIntervalId);
                clearTimeout(promiseData.timeoutId);
            }

            // This is the "logged out" message you wanted
            const failMessage = `Bot *${escapeMarkdown(appName)}* failed to start: ${escapeMarkdown(err.message)}\n\nYou may need to update the session ID.`;
            
            // Send failure to USER (or admin-as-user)
            await bot.editMessageText(
                failMessage,
                {
                    chat_id: primaryAnimChatId,
                    message_id: primaryAnimMsgId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${appName}:${targetChatId}` }]] }
                }
            ).catch(() => {});

            // If it was a user, update the ADMIN's log
            if (adminLogMsg) {
                 await bot.editMessageText(`Connection failed for *${escapeMarkdown(appName)}* (User: \`${targetChatId}\`). Reason: ${escapeMarkdown(err.message)}`, { chat_id: ADMIN_ID, message_id: adminLogMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
            }
            
            buildResult = false;
        } finally {
            appDeploymentPromises.delete(appName);
        }
        // --- END OF MODIFIED BLOCK ---

    } catch (error) { // Build Failed
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[Build Error] Failed to build app ${appName}:`, errorMsg);
        if (primaryAnimateIntervalId) clearInterval(primaryAnimateIntervalId); // Stop user/admin animation
        
        // Edit the USER's message to show failure
        await bot.editMessageText(`Your bot *${escapeMarkdown(appName)}* failed to deploy.\n*Reason:* ${escapeMarkdown(errorMsg)}`, { chat_id: primaryAnimChatId, message_id: primaryAnimMsgId, parse_mode: 'Markdown' }).catch(()=>{});
        
        // If it was a user, update the ADMIN's log
        if (adminLogMsg) {
            await bot.editMessageText(`Build failed for *${escapeMarkdown(appName)}* (User: \`${targetChatId}\`).\n*Reason:* ${escapeMarkdown(errorMsg)}`, { chat_id: ADMIN_ID, message_id: adminLogMsg.message_id, parse_mode: 'Markdown' }).catch(()=>{});
        }
        buildResult = false;
    }
    
    if (isRestore) {
        return { success: buildResult, newAppName: appName };
    }
    return buildResult;
}



                    
/**
 * TRULY SILENTLY restores a Heroku app.
 * NEVER sends any message to the target user (build progress or failure).
 * Notifies ADMIN_ID only when something goes wrong (DB/build failure or connection/login failure),
 * so a mass restore stays invisible to end users while the admin can still catch problems.
 */
async function silentRestoreBuild(targetChatId, vars, botType) {
    // 1. Get all the tools from moduleParams
    const { 
        bot, herokuApi, HEROKU_API_KEY, GITHUB_LEVANTER_REPO_URL, GITHUB_RAGANORK_REPO_URL, 
        GITHUB_HERMIT_REPO_URL, // Added HERMIT URL just in case
        ADMIN_ID, defaultEnvVars, escapeMarkdown, mainPool, 
        createNeonDatabase, appDeploymentPromises
    } = moduleParams;
    
    // Require crypto for renaming
    const crypto = require('crypto');

    let appName = vars.APP_NAME;
    const originalAppName = appName;
    let buildResult = false;
    
    const isRestore = true; 
    let neonAccountId = '1';
    const isFreeTrial = false;

    try {
        // --- 💡 FIX STARTS HERE 💡 ---
        // 2. Handle app renaming logic (The "Clone" fix)
        let needsRename = false;

        try {
            // Check if the app name exists
            await herokuApi.get(`/apps/${appName}`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
            
            // If we get here (Status 200), we own the app or have access. 
            // We rename to avoid overwriting the existing running bot.
            needsRename = true;
        } catch (e) {
            if (e.response) {
                // Status 403: App exists (on OLD API KEY/Account) but we don't have access.
                // We MUST rename, otherwise we can't create an app with this name.
                if (e.response.status === 403) {
                    console.log(`[SilentRestore] Name ${appName} is taken by another account (403 Forbidden). Renaming...`);
                    needsRename = true;
                } 
                // Status 404: App does not exist. We *could* use the name, 
                // but for a clean restore, it is often safer to keep the existing logic 
                // or just proceed. Here we proceed with the current name.
                else if (e.response.status === 404) {
                    needsRename = false; 
                } 
                else {
                    // Any other error (401, 500, etc), throw it.
                    throw e;
                }
            } else {
                throw e;
            }
        }

        if (needsRename) {
            // Create a new unique name based on the old one
            // We use substring to ensure we don't exceed Heroku's 30 char limit with the suffix
            const baseName = appName.length > 20 ? appName.substring(0, 20) : appName; 
            const newName = `${baseName}-${crypto.randomBytes(2).toString('hex')}`;
            
            appName = newName;
            vars.APP_NAME = newName;
            console.log(`[SilentRestore] Logic enforced rename. Old: ${originalAppName} -> New: ${appName}`);
        }
        // --- 💡 FIX ENDS HERE 💡 ---
        
        // --- Step 1: Create the Heroku app ---
        const appSetup = { name: appName, region: 'us', stack: 'heroku-24' };
        await herokuApi.post('/apps', appSetup, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });


        // --- ❗️ STEP 2: DATABASE LOGIC (AWS-first, same pattern as buildWithProgress) ❗️ ---
        const dbName = appName.replace(/-/g, '_'); // Only used if we end up provisioning a brand new DB

        let provisionSuccess = false;

        // Look up the app's AWS database directly from user_deployments, keyed on the ORIGINAL
        // app name (that's what the backup record was saved under, before any rename above).
        console.log(`[SilentRestore] Looking up AWS database for "${originalAppName}" in user_deployments...`);
        const awsLookup = await getAwsDbConnectionString(originalAppName);

        if (awsLookup.success && awsLookup.dbUrl) {
            // A. Found the app's existing AWS-hosted database on record. Re-use it as-is.
            vars.DATABASE_URL = awsLookup.dbUrl;
            neonAccountId = 'AWS_MAIN';
            provisionSuccess = true;
            console.log(`[SilentRestore] RE-USED existing AWS DB for "${originalAppName}".`);
        } else {
            // B. No AWS record found for this app — provision a brand new database.
            console.log(`[SilentRestore] No AWS DB found for "${originalAppName}" (${awsLookup.message || 'not found'}). Creating NEW database: ${dbName}`);
            const neonResult = await createNeonDatabase(dbName);

            if (neonResult.success) {
                vars.DATABASE_URL = neonResult.connection_string;
                neonAccountId = neonResult.account_id;
                provisionSuccess = true;
                console.log(`[SilentRestore] Created NEW database: ${dbName} (Account: ${neonAccountId}).`);
            } else {
                return { success: false, error: `Database creation failed: ${neonResult.error}`, appName: appName };
            }
        }
        
        if (!provisionSuccess) {
            return { success: false, error: "Database provisioning failed unexpectedly.", appName: appName };
        }
        
        // --- Step 3: Set Buildpacks --
        // Added Check: Only install buildpacks for Levanter/Raganork/Hermit
        if (['levanter', 'raganork', 'hermit'].includes(botType)) {
            await herokuApi.put(
              `/apps/${appName}/buildpack-installations`,
              {
                updates: [
                  { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
                  { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
                  { buildpack: 'heroku/nodejs' }
                ]
              },
              { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
            );
        }

        // --- Step 4: Set Environment Variables ---
        const filteredVars = {};
        for (const key in vars) {
            if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && String(vars[key]).trim() !== '') {
                filteredVars[key] = vars[key];
            }
        }
        const finalConfigVars = filteredVars;
        await herokuApi.patch(`/apps/${appName}/config-vars`, 
            { ...finalConfigVars, APP_NAME: appName },
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );

        // --- Step 5: Trigger Build from GitHub ---
        // --- 💡 UPDATED REPO URL LOGIC 💡 ---
        let repoUrl;
        if (botType === 'raganork') {
            repoUrl = GITHUB_RAGANORK_REPO_URL;
        } else if (botType === 'hermit') {
            repoUrl = GITHUB_HERMIT_REPO_URL || GITHUB_LEVANTER_REPO_URL; // Fallback if hermit url missing
        } else {
            // Default to Levanter
            repoUrl = GITHUB_LEVANTER_REPO_URL;
        }
    
        const buildStartRes = await herokuApi.post(`/apps/${appName}/builds`, {
            source_blob: { url: `${repoUrl}/tarball/main` }
        }, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });


        // --- Step 6: Wait for Build to Finish (Silently) ---
        const buildId = buildStartRes.data.id;
        const statusUrl = `/apps/${appName}/builds/${buildId}`;
        let buildStatus = 'pending';
        let buildProgressInterval;

        try {
            const BUILD_COMPLETION_TIMEOUT = 600 * 1000; // 10 minutes
            const buildPromise = new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    clearInterval(buildProgressInterval);
                    reject(new Error(`Build timed out`));
                }, BUILD_COMPLETION_TIMEOUT);

                buildProgressInterval = setInterval(async () => {
                    try {
                        const poll = await herokuApi.get(statusUrl, {
                            headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` }
                        });
                        buildStatus = poll.data.status;
                        
                        if (buildStatus !== 'pending') {
                            clearInterval(buildProgressInterval);
                            clearTimeout(timeoutId);
                            if (buildStatus === 'succeeded') {
                                resolve('succeeded');
                            } else {
                                reject(new Error(`Build failed: ${buildStatus}`));
                            }
                        }
                    } catch (error) {
                        clearInterval(buildProgressInterval);
                        clearTimeout(timeoutId);
                        reject(new Error(`Error polling build status: ${error.message}`));
                    }
                }, 10000);
            });
            await buildPromise;
        } catch (err) {
            if (buildProgressInterval) clearInterval(buildProgressInterval);
            throw err; 
        }

        // --- Step 7: Handle Build Succeeded ---
        console.log(`[Flow] silentRestoreBuild: Heroku build for "${appName}" SUCCEEDED.`);
        const finalConfigVarsAfterBuild = (await herokuApi.get(`/apps/${appName}/config-vars`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } })).data;
        await addUserBot(targetChatId, appName, finalConfigVarsAfterBuild.SESSION_ID, botType);
        
        // Save the deployment with the NEW name
        // Use originalAppName for logging if needed, but we must save the new appName
        await saveUserDeployment(
            targetChatId, appName, finalConfigVarsAfterBuild.SESSION_ID, 
            finalConfigVarsAfterBuild, botType, isFreeTrial, vars.expiration_date, vars.email, neonAccountId
        );

        // --- "Wait for Connect" Logic (SILENT TO USER — admin is pinged only on failure) ---
        if (String(targetChatId) !== ADMIN_ID) {
            const appStatusPromise = new Promise((resolve, reject) => {
                const STATUS_CHECK_TIMEOUT = 300 * 1000;
                const timeoutId = setTimeout(() => {
                    const appPromise = appDeploymentPromises.get(appName);
                    if (appPromise) {
                        appPromise.reject(new Error(`Bot did not connect within 120s (Logged Out).`));
                    }
                }, STATUS_CHECK_TIMEOUT);
                appDeploymentPromises.set(appName, { resolve, reject, animateIntervalId: null, timeoutId });
            });

            try {
                await appStatusPromise; // Wait for bot to connect
                const promiseData = appDeploymentPromises.get(appName);
                if (promiseData) clearTimeout(promiseData.timeoutId);
                buildResult = true; // Success — stays completely silent
            } catch (err) {
                // --- FAILURE: "LOGGED OUT" — notify ADMIN only, never the user ---
                const promiseData = appDeploymentPromises.get(appName);
                if (promiseData) clearTimeout(promiseData.timeoutId);
                
                if (ADMIN_ID) {
                    await bot.sendMessage(
                        ADMIN_ID,
                        `⚠️ Silent restore: bot *${escapeMarkdown(appName)}* (User: \`${targetChatId}\`) failed to start: ${escapeMarkdown(err.message)}\n\nMay need a new session ID.`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${appName}:${targetChatId}` }]] }
                        }
                    ).catch(()=>{});
                }
                
                // Return failure
                return { success: false, error: err.message, appName: appName };
            } finally {
                appDeploymentPromises.delete(appName);
            }
        } else {
            buildResult = true; // Admin is the target, no need to wait
        }

        // Return success
        return { success: true, appName: appName };

    } catch (error) {
        // --- Main build failure — notify ADMIN only, never the user ---
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[SilentRestore Build Error] Failed to build app ${appName}:`, errorMsg);
        
        if (ADMIN_ID) {
            await bot.sendMessage(
                ADMIN_ID, 
                `⚠️ Silent restore: bot *${escapeMarkdown(appName)}* (User: \`${targetChatId}\`) failed to restore.\n*Reason:* ${escapeMarkdown(errorMsg)}`, 
                { parse_mode: 'Markdown' }
            ).catch(()=>{});
        }
        
        // Return failure
        return { success: false, error: errorMsg, appName: appName };
    }
}



module.exports = {
    init,
    addUserBot,
    getUserBots,
    setHerokuApiKey,
    silentRestoreBuild,
    getUserIdByBotName,
    getAllUserBots,
    getUserBotCount,
    pruneLoggedOutBot,
    getBotNameBySessionId,
    updateUserSession,
    addDeployKey,
    useDeployKey,
    getAllDeployKeys,
    deleteDeployKey,
    getDynoStatus,
    updateUserActivity,
    getUserLastSeen,
    getAllBotDeployments,
    getLoggedOutBots,
    isUserBanned,
    banUser,
    addReferralAndSecondLevelReward,
    unbanUser,
    checkIfDatabaseExists,
    saveUserDeployment,
    getUserDeploymentsForRestore,
    deleteUserDeploymentFromBackup,
    markDeploymentDeletedFromHeroku,
    getAllDeploymentsFromBackup,
    handleAppNotFoundAndCleanDb,
    sendAppList,
    processBotSwitch,
    permanentlyDeleteBotRecord,
    deleteUserBot,
    getLoggedOutBotsForEmail,
    grantReferralRewards,
    buildWithProgress,
    syncExpirationToHeroku,
    backupAllPaidBots,
    syncDatabases,
    getAwsDbConnectionString,
    createAllTablesInPool,
    syncDatabaseWithHeroku,
    reconcileDatabaseWithHeroku,
    getExpiringBackups,
    setBackupWarningLevel,
    getExpiredBackups,
    getBlacklistedNames,
    removeBlacklistedName,
    backupAllPaidBots // <-- FIX: Added the missing function to the exports
};
