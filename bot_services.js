// bot_services.js

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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
let animateMessage;
let moduleParams = {};
let sendAnimatedMessage;
let monitorSendTelegramAlert;
let escapeMarkdown;

/**
 * Initializes database and API helper functions.
 * @param {object} params - Object containing dependencies from bot.js.
 */
function init(params) {
    // Assign parameters to module-level variables
    pool = params.mainPool;
    backupPool = params.backupPool;
    bot = params.bot;
    HEROKU_API_KEY = params.HEROKU_API_KEY;
    GITHUB_LEVANTER_REPO_URL = params.GITHUB_LEVANTER_REPO_URL;
    GITHUB_RAGANORK_REPO_URL = params.GITHUB_RAGANORK_REPO_URL;
    ADMIN_ID = params.ADMIN_ID;
    moduleParams = params;
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

// bot_services.js

// ... other code ...
async function syncDatabaseWithHeroku() {
    console.log('[Sync] Starting full database synchronization with Heroku...');
    const syncStats = {
        addedToUserBots: 0,
        addedToDeployments: 0,
        unmatchedHerokuApps: []
    };

    try {
        // Step 1: Get all apps from Heroku
        const { herokuApi } = moduleParams; // Get herokuApi from params
        const herokuAppsResponse = await herokuApi.get('/apps', {
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
                // ❗️ FIX: Use herokuApi, not axios
                const configRes = await herokuApi.get(`/apps/${appName}/config-vars`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}` }
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
            SELECT ub.user_id, ub.bot_name, ud.email, ub.status_changed_at
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
        const { herokuApi } = moduleParams; // Get herokuApi
        const [herokuAppsRes, dbAppsRes] = await Promise.all([
            herokuApi.get('/apps', {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}` }
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
    const { herokuApi } = moduleParams; // Get herokuApi
    try {
        const response = await herokuApi.get(`/apps/${appName}/dynos`, {
            headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` }
        });
        if (response.data.length > 0 && response.data[0].state !== 'crashed') {
            return 'on';
        }
        return 'off';
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return 'deleted';
        }
        if (error.response && error.response.status === 503) {
            return 'unavailable';
        }
        console.error(`[Dyno Check] Error fetching dyno status for ${appName}:`, error.message);
        return 'error';
    }
}

// --- NEW FUNCTIONS FOR EXPIRATION REMINDERS ---

async function getExpiringBots() {
    try {
        const result = await pool.query(
            `SELECT user_id, app_name FROM user_deployments 
             WHERE warning_sent_at IS NULL AND expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days' AND paused_at IS NULL;`
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get expiring bots:`, error.message);
        return [];
    }
}

async function setExpirationWarningSent(userId, appName) {
    try {
        await pool.query(
            'UPDATE user_deployments SET warning_sent_at = NOW() WHERE user_id = $1 AND app_name = $2;',
            [userId, appName]
        );
    } catch (error) {
        console.error(`[DB] Failed to set expiration warning sent for ${appName}:`, error.message);
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

// === Backup Expiration and Warning Functions ===

async function getExpiringBackups() {
    try {
        const result = await pool.query(
            `SELECT user_id, app_name, expiration_date 
             FROM user_deployments 
             WHERE warning_sent_at IS NULL 
               AND expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
               AND paused_at IS NULL;`
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get expiring backups:`, error.message);
        return [];
    }
}


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
               AND paused_at IS NULL;`
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get expired backups:`, error.message);
        return [];
    }
}


// === Backup, Restore, and Sync Functions ===

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
        await pool.query('DELETE FROM user_bots WHERE user_id = $1 AND bot_name = $2', [userId, appName]);
        await pool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [userId, appName]);
        await backupPool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [userId, appName]);
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

async function addDeployKey(key, uses, createdBy, userId = null) {
  await pool.query(
    'INSERT INTO deploy_keys(key, uses_left, created_by, user_id) VALUES($1, $2, $3, $4)',
    [key, uses, createdBy, userId]
  );
  console.log(`[DB] addDeployKey: Added key "${key}" for user "${userId || 'General'}" with ${uses} uses by "${createdBy}".`);
}


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


async function getAllDeployKeys() {
    try {
        const res = await pool.query('SELECT key, uses_left, created_by, user_id, created_at FROM deploy_keys ORDER BY created_at DESC');
        return res.rows;
    } catch (error) {
        console.error('[DB] getAllDeployKeys: Failed to get all deploy keys:', error.message);
        return [];
    }
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

async function canDeployFreeTrial(userId) {
    const COOLDOWN_DAYS = 90; 
    const res = await pool.query(
        'SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1',
        [userId]
    );
    if (res.rows.length === 0) return { can: true };
    const lastDeploy = new Date(res.rows[0].last_deploy_at);
    const now = new Date();
    const cooldownEnd = new Date(lastDeploy.getTime() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    if (now >= cooldownEnd) {
        return { can: true };
    } else {
        return { can: false, cooldown: cooldownEnd };
    }
}


async function recordFreeTrialDeploy(userId) {
    await pool.query(
        `INSERT INTO temp_deploys (user_id, last_deploy_at) VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_deploy_at = NOW()`,
        [userId]
    );
    console.log(`[DB] recordFreeTrialDeploy: Recorded free trial deploy for user "${userId}".`);
}

async function updateUserActivity(userId) {
  const query = `
    INSERT INTO user_activity(user_id, last_seen)
    VALUES($1, NOW())
    ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW();
  `;
  try {
    await pool.query(query, [userId]);
    console.log(`[DB] User activity updated for ${userId}.`);
  } catch (error) {
    console.error(`[DB] Failed to update user activity for ${userId}:`, error.message);
  }
}

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

async function saveUserDeployment(userId, appName, sessionId, configVars, botType, isFreeTrial = false, expirationDateToUse = null, email = null) {
    try {
        const cleanConfigVars = JSON.parse(JSON.stringify(configVars));
        const deployDate = new Date();

        // Use a provided expiration date if it exists, otherwise calculate a new one.
        const finalExpirationDate = expirationDateToUse || new Date(deployDate.getTime() + (isFreeTrial ? 35 : 35) * 24 * 60 * 60 * 1000); // 35 days for all

        const query = `
            INSERT INTO user_deployments(user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at, is_free_trial, email)
            VALUES($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9)
            ON CONFLICT (user_id, app_name) DO UPDATE SET
               session_id = EXCLUDED.session_id,
               config_vars = EXCLUDED.config_vars,
               bot_type = EXCLUDED.bot_type,
               deleted_from_heroku_at = NULL,
               is_free_trial = EXCLUDED.is_free_trial,
               email = EXCLUDED.email,
               deploy_date = user_deployments.deploy_date,
               expiration_date = user_deployments.expiration_date;
        `;
        await pool.query(query, [userId, appName, sessionId, cleanConfigVars, botType, deployDate, finalExpirationDate, isFreeTrial, email]);

        console.log(`[DB-Main] Saved/Updated deployment for app ${appName}. Is Free Trial: ${isFreeTrial}. Expiration: ${finalExpirationDate.toISOString()}.`);
    } catch (error) {
        console.error(`[DB-Main] Failed to save user deployment for ${appName}:`, error.message);
    }
}


async function getUserDeploymentsForRestore(userId) {
    try {
        // ❗️ FIX: Read from the main pool, not the backup pool
        const result = await pool.query(
            `SELECT app_name, session_id, config_vars, deploy_date, expiration_date, bot_type, deleted_from_heroku_at
             FROM user_deployments WHERE user_id = $1 ORDER BY deploy_date DESC;`,
            [userId]
        );
        console.log(`[DB] Fetched ${result.rows.length} deployments for user ${userId} for restore.`);
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get user deployments for restore ${userId}:`, error.message);
        return [];
    }
}

async function deleteUserDeploymentFromBackup(userId, appName) {
    try {
        // ❗️ FIX: This should delete from the main 'user_deployments' table
        const result = await pool.query(
            'DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2 RETURNING app_name;',
            [userId, appName]
        );
        if (result.rowCount > 0) {
            console.log(`[DB] Permanently deleted deployment for user ${userId}, app ${appName}.`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`[DB] Failed to permanently delete user deployment for ${appName}:`, error.message);
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
        console.log(`[DB] Marked deployment for user ${userId}, app ${appName} as deleted from Heroku.`);
    } catch (error) {
        console.error(`[DB] Failed to mark deployment as deleted from Heroku for ${appName}:`, error.message);
    }
}

async function getAllDeploymentsFromBackup(botType) {
    try {
        // ❗️ FIX: Read from the main pool, not the backup pool
        const result = await pool.query(
            `SELECT user_id, app_name, session_id, config_vars, bot_type, referred_by, ip_address
             FROM user_deployments 
             WHERE bot_type = $1
             ORDER BY app_name ASC;`,
            [botType]
        );
        console.log(`[DB] Fetched all ${result.rows.length} deployments for mass restore.`);
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get all deployments for mass restore:`, error.message);
        return [];
    }
}


async function recordFreeTrialForMonitoring(userId, appName, channelId) {
    try {
        await pool.query(
            `INSERT INTO free_trial_monitoring (user_id, app_name, channel_id) VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO UPDATE SET app_name = EXCLUDED.app_name, trial_start_at = CURRENT_TIMESTAMP, warning_sent_at = NULL;`,
            [userId, appName, channelId]
        );
        console.log(`[DB] Added user ${userId} with app ${appName} to free trial monitoring.`);
    } catch (error) {
        console.error(`[DB] Failed to record free trial for monitoring:`, error.message);
    }
}

async function getMonitoredFreeTrials() {
    try {
        const result = await pool.query('SELECT * FROM free_trial_monitoring;');
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get monitored free trials:`, error.message);
        return [];
    }
}

// This function replaces the previous grantReferralRewards function
async function grantReferralRewards(referredUserId, deployedBotName) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const referralSessionResult = await client.query(
            `SELECT data FROM sessions WHERE id = $1`,
            [`referral_session:${referredUserId}`]
        );

        if (referralSessionResult.rows.length > 0) {
            const inviterId = referralSessionResult.rows[0].data.inviterId;

            const inviterBotsResult = await client.query(
                `SELECT bot_name FROM user_bots WHERE user_id = $1`,
                [inviterId]
            );
            const inviterBots = inviterBotsResult.rows;

            if (inviterBots.length > 0 && inviterBots.length <= 2) {
                const inviterBotName = inviterBots[0].bot_name;
                await client.query(
                    `UPDATE user_deployments SET expiration_date = expiration_date + INTERVAL '20 days'
                     WHERE user_id = $1 AND app_name = $2 AND expiration_date IS NOT NULL`,
                    [inviterId, inviterBotName]
                );
                await bot.sendMessage(inviterId,
                    `Congratulations! A friend you invited has deployed their first bot. ` +
                    `You've received a *20-day extension* on your bot \`${escapeMarkdown(inviterBotName)}\`!`,
                    { parse_mode: 'Markdown' }
                );
                await addReferralAndSecondLevelReward(client, referredUserId, inviterId, deployedBotName);
            } else if (inviterBots.length > 2) {
                await client.query(
                    `INSERT INTO user_referrals (referred_user_id, inviter_user_id, bot_name, inviter_reward_pending) VALUES ($1, $2, $3, TRUE)
                     ON CONFLICT (referred_user_id) DO UPDATE SET inviter_reward_pending = TRUE`,
                    [referredUserId, inviterId, deployedBotName]
                );
                await bot.sendMessage(inviterId,
                    `A friend you invited has deployed a bot! Please select one of your bots below to add the *20-day extension* to.`,
                    { parse_mode: 'Markdown', reply_markup: { 
                        inline_keyboard: [[{
                            text: 'Select Bot for Reward',
                            callback_data: `show_reward_bot_list:${referredUserId}`
                        }]]
                     } }
                );
            } else {
                await client.query(
                    `INSERT INTO user_referrals (referred_user_id, inviter_user_id, bot_name) VALUES ($1, $2, $3)`,
                    [referredUserId, inviterId, deployedBotName]
                );
                await bot.sendMessage(inviterId,
                    `Congratulations! A friend you invited has deployed their first bot. ` +
                    `You've earned a *20-day extension* reward, but you have no active bots to apply it to.`,
                    { parse_mode: 'Markdown' }
                );
            }
            await client.query('DELETE FROM sessions WHERE id = $1', [`referral_session:${referredUserId}`]);
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`[Referral] Failed to grant rewards for user ${referredUserId}:`, e);
    } finally {
        client.release();
    }
}

// NEW HELPER FUNCTION to handle second-level rewards
async function addReferralAndSecondLevelReward(client, referredUserId, inviterId, deployedBotName) {
    const grandInviterResult = await client.query(
        `SELECT inviter_user_id FROM user_referrals WHERE referred_user_id = $1`,
        [inviterId]
    );
    if (grandInviterResult.rows.length > 0) {
        const grandInviterId = grandInviterResult.rows[0].inviter_user_id;

        const grandInviterBotsResult = await client.query(
            `SELECT bot_name FROM user_bots WHERE user_id = $1`,
            [grandInviterId]
        );
        const grandInviterBots = grandInviterBotsResult.rows;

        if (grandInviterBots.length > 0 && grandInviterBots.length <= 2) {
            const grandInviterBotName = grandInviterBots[0].bot_name;
            await client.query(
                `UPDATE user_deployments SET expiration_date = expiration_date + INTERVAL '7 days'
                 WHERE user_id = $1 AND app_name = $2 AND expiration_date IS NOT NULL`,
                [grandInviterId, grandInviterBotName]
            );
            await bot.sendMessage(grandInviterId,
                `Bonus Reward! A friend of a friend has deployed a bot. ` +
                `You've received a *7-day extension* on your bot \`${escapeMarkdown(grandInviterBotName)}\`!`,
                { parse_mode: 'Markdown' }
            );
        } else if (grandInviterBots.length > 2) {
            await client.query(
                `INSERT INTO user_referrals (referred_user_id, inviter_user_id, inviter_reward_pending) VALUES ($1, $2, TRUE)
                 ON CONFLICT (referred_user_id) DO UPDATE SET inviter_reward_pending = TRUE`,
                [inviterId, grandInviterId]
            );
            await bot.sendMessage(grandInviterId,
                `Bonus Reward! A friend of a friend has deployed a bot. Please select one of your bots below to add the *7-day extension* to.`,
                { parse_mode: 'Markdown', reply_markup: { 
                    inline_keyboard: [[{
                        text: 'Select Bot for Reward',
                        callback_data: `show_reward_bot_list:${inviterId}:second_level`
                    }]]
                 } }
            );
        }
    }
}



async function updateFreeTrialWarning(userId) {
    try {
        await pool.query('UPDATE free_trial_monitoring SET warning_sent_at = NOW() WHERE user_id = $1;', [userId]);
    } catch (error) {
        console.error(`[DB] Failed to update free trial warning timestamp:`, error.message);
    }
}

async function removeMonitoredFreeTrial(userId) {
    try {
        await pool.query('DELETE FROM free_trial_monitoring WHERE user_id = $1;', [userId]);
        console.log(`[DB] Removed user ${userId} from free trial monitoring.`);
    } catch (error) {
        console.error(`[DB] Failed to remove monitored free trial:`, error.message);
    }
}

async function backupAllPaidBots() {
    console.log('[DB-Backup] Starting backup process for ALL Heroku apps...');
    const { herokuApi } = moduleParams; // Get herokuApi
    let backedUpCount = 0, failedCount = 0, notFoundCount = 0;
    const herokuAppList = [];

    const typeStats = {
        levanter: { backedUp: [], failed: [] },
        raganork: { backedUp: [], failed: [] },
        unknown: { backedUp: [], failed: [] }
    };
    
    try {
        const allHerokuAppsResponse = await herokuApi.get('/apps', {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}` }
        });
        const herokuApps = allHerokuAppsResponse.data.map(app => app.name);
        herokuAppList.push(...herokuApps);
        
        console.log(`[DB-Backup] Found ${herokuAppList.length} apps on Heroku.`);
        if (herokuAppList.length === 0) {
            return { success: true, message: 'No apps found on Heroku to back up.' };
        }
    } catch (error) {
        return { success: false, message: `Failed to fetch app list from Heroku: ${error.message}` };
    }

    for (const appName of herokuAppList) {
        let userId = ADMIN_ID;
        let botType = 'unknown';

        try {
            const localBotRecord = await pool.query('SELECT user_id, bot_type FROM user_bots WHERE bot_name = $1', [appName]);
            if (localBotRecord.rows.length > 0) {
                userId = localBotRecord.rows[0].user_id;
                botType = localBotRecord.rows[0].bot_type;
            } else {
                notFoundCount++;
            }

            // ❗️ FIX: Use herokuApi, not axios
            const response = await herokuApi.get(`/apps/${appName}/config-vars`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}` }
            });
            const configVars = response.data;
            const sessionId = configVars.SESSION_ID || 'N/A';

            await saveUserDeployment(userId, appName, sessionId, configVars, botType);
            
            backedUpCount++;
            typeStats[botType]?.backedUp.push(appName);
            
        } catch (error) {
            failedCount++;
            typeStats[botType]?.failed.push(appName);
        }
    }
    
    return { 
        success: true, 
        message: `Backup complete! Processed ${herokuAppList.length} apps.`, 
        stats: typeStats, 
        miscStats: { appsBackedUp: backedUpCount, appsFailed: failedCount }
    };
}


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
        
        for (const tableName of sourceTableNames) {
            await clientTarget.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE;`);
        }

        for (const tableName of sourceTableNames) {
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
            
            createTableScript += ');';
            await clientTarget.query(createTableScript);
        }

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
    console.log(`[AppNotFoundHandler] Handling 404 for app "${appName}".`);
    let ownerUserId = await getUserIdByBotName(appName);
    if (!ownerUserId) { ownerUserId = callingChatId; }

    await deleteUserBot(ownerUserId, appName);
    await markDeploymentDeletedFromHeroku(ownerUserId, appName);
    
    const message = `App "${escapeMarkdown(appName)}" was not found on Heroku. It has been removed from your "My Bots" list.`;
    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId;
    
    if (originalMessageId) {
        await bot.editMessageText(message, { chat_id: messageTargetChatId, message_id: originalMessageId, parse_mode: 'Markdown' }).catch(()=>{});
    } else {
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' }).catch(()=>{});
    }
    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `Your bot "*${escapeMarkdown(appName)}*" was not found on Heroku and has been removed by the admin.`, { parse_mode: 'Markdown' }).catch(()=>{});
    }
}

async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserId = null, isRemoval = false) {
    const { herokuApi } = moduleParams; // Get herokuApi
    try {
        const res = await herokuApi.get('/apps', {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}` }
        });
        const apps = res.data.map(a => a.name);
        if (!apps.length) {
            if (messageId) return bot.editMessageText('No apps found.', { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, 'No apps found.');
        }

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
        // herokuApi interceptor will handle 401
        const errorMsg = `Error fetching apps: ${e.response?.data?.message || e.message}`;
        if (messageId) {
            bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId });
        } else {
            bot.sendMessage(chatId, errorMsg);
        }
    }
}

// ❗️❗️ This is the new, fully corrected buildWithProgress function ❗️❗️
async function buildWithProgress(targetChatId, vars, isFreeTrial, isRestore, botType, referredBy = null, ipAddress = null) {
    const { 
        bot, herokuApi, HEROKU_API_KEY, GITHUB_LEVANTER_REPO_URL, GITHUB_RAGANORK_REPO_URL, 
        ADMIN_ID, defaultEnvVars, escapeMarkdown, animateMessage, mainPool, 
        MUST_JOIN_CHANNEL_ID 
    } = moduleParams;
    
    let appName = vars.APP_NAME;
    const originalAppName = appName; // Keep track of the original name for the backup
    let buildMsg;
    let userNotifyMsg;
    
    try {
        if (isRestore) {
            try {
                await herokuApi.get(`/apps/${appName}`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
                const newName = `${appName.split('-')[0]}-${crypto.randomBytes(2).toString('hex')}`;
                console.log(`[Restore] App ${appName} already exists. Using new name: ${newName}`);
                appName = newName;
                vars.APP_NAME = newName;
            } catch (e) {
                if (e.response?.status !== 404) throw e;
            }
        }
        
        buildMsg = await bot.sendMessage(ADMIN_ID, `Starting build for *${escapeMarkdown(appName)}*...`, { parse_mode: 'Markdown' });
        if (String(targetChatId) !== ADMIN_ID) {
            userNotifyMsg = await bot.sendMessage(targetChatId, `Your bot *${escapeMarkdown(appName)}* is being built...`, { parse_mode: 'Markdown' });
        }
        const animateIntervalId = await animateMessage(ADMIN_ID, buildMsg.message_id, `Building ${appName}...`);

        // --- Build Creation Logic ---
        const appSetup = { name: appName, region: 'us', stack: 'heroku-22' };
        await herokuApi.post('/apps', appSetup, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
        
        // --- ❗️ NEW: NEON DATABASE CREATION (if not restoring) ❗️ ---
        if (!isRestore) {
            await bot.editMessageText(`Building ${appName}...\n\nStep 1/4: Creating Neon database...`, { chat_id: ADMIN_ID, message_id: buildMsg.message_id });
            
            // ❗️ FIX: Use the 'createNeonDatabase' function from bot.js, passed via moduleParams
            const neonResult = await moduleParams.createNeonDatabase(appName.replace(/-/g, '_'));
            
            if (!neonResult.success) {
                throw new Error(`Neon DB creation failed: ${neonResult.error}`);
            }
            vars.DATABASE_URL = neonResult.connection_string;
        } else {
             await bot.editMessageText(`Building ${appName}...\n\nStep 1/4: Skipping Neon DB creation (Restore)...`, { chat_id: ADMIN_ID, message_id: buildMsg.message_id });
        }
        // --- End of Neon Logic ---

        await bot.editMessageText(`Building ${appName}...\n\nStep 2/4: Setting Heroku variables...`, { chat_id: ADMIN_ID, message_id: buildMsg.message_id });
        await herokuApi.patch(`/apps/${appName}/config-vars`, { ...defaultEnvVars[botType], ...vars }, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
        
        // --- ❗️ REMOVED: Heroku DB Creation ❗️ ---
        // We no longer create a heroku-postgresql addon

        await bot.editMessageText(`Building ${appName}...\n\nStep 3/4: Starting build from GitHub...`, { chat_id: ADMIN_ID, message_id: buildMsg.message_id });
        const repoUrl = (botType === 'raganork') ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
        const buildStartRes = await herokuApi.post(`/apps/${appName}/builds`, {
            source_blob: { url: `${repoUrl}/tarball/main` }
        }, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });

        const buildId = buildStartRes.data.id;
        const statusUrl = `/apps/${appName}/builds/${buildId}`;

        await bot.editMessageText(`Building ${appName}...\n\nStep 4/4: Waiting for build to finish...`, { chat_id: ADMIN_ID, message_id: buildMsg.message_id });
        
        // --- Polling loop to wait for build to finish ---
        let buildStatus = '';
        for (let i = 0; i < 60; i++) { // Poll for up to 10 minutes
            await new Promise(resolve => setTimeout(resolve, 10000));
            const buildCheckRes = await herokuApi.get(statusUrl, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
            buildStatus = buildCheckRes.data.status;
            if (buildStatus === 'succeeded' || buildStatus === 'failed') break;
        }

        clearInterval(animateIntervalId);

        if (buildStatus !== 'succeeded') {
            throw new Error(`Build for ${appName} failed with status: ${buildStatus}`);
        }
        
        // --- Build Succeeded ---
        await bot.editMessageText(`Build for *${escapeMarkdown(appName)}* successful!`, { chat_id: ADMIN_ID, message_id: buildMsg.message_id, parse_mode: 'Markdown' });
        if (userNotifyMsg) {
            await bot.editMessageText(`Your bot *${escapeMarkdown(appName)}* is now deployed and starting!`, { chat_id: targetChatId, message_id: userNotifyMsg.message_id, parse_mode: 'Markdown' });
        }

        const finalConfigVars = (await herokuApi.get(`/apps/${appName}/config-vars`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } })).data;

        await addUserBot(targetChatId, appName, finalConfigVars.SESSION_ID, botType);
        
        // ❗️ FIX: Pass the original app name for restores to find the correct data
        const appNameToSaveInBackup = isRestore ? originalAppName : appName;
        await saveUserDeployment(targetChatId, appNameToSaveInBackup, finalConfigVars.SESSION_ID, finalConfigVars, botType, isFreeTrial, referredBy, vars.expiration_date, ipAddress);

        if (isFreeTrial) {
            await mainPool.query(
                'INSERT INTO temp_deploys (user_id, last_deploy_at, ip_address) VALUES ($1, NOW(), $2) ON CONFLICT (user_id) DO UPDATE SET last_deploy_at = NOW(), ip_address = EXCLUDED.ip_address',
                [targetChatId, ipAddress]
            );
            await mainPool.query(
                'INSERT INTO free_trial_monitoring (user_id, app_name, channel_id) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET app_name = EXCLUDED.app_name',
                [targetChatId, appName, MUST_JOIN_CHANNEL_ID]
            );
        }
        
        return { success: true, newAppName: appName }; 

    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[Build Error] Failed to build app ${appName}:`, errorMsg);
        
        if (buildMsg) {
            clearInterval(moduleParams.appDeploymentPromises.get(appName)?.animateIntervalId);
            await bot.editMessageText(`Build failed for *${escapeMarkdown(appName)}*.\n*Reason:* ${escapeMarkdown(errorMsg)}`, { chat_id: ADMIN_ID, message_id: buildMsg.message_id, parse_mode: 'Markdown' });
        }
        if (userNotifyMsg) {
            await bot.editMessageText(`Your bot *${escapeMarkdown(appName)}* failed to deploy.\n*Reason:* ${escapeMarkdown(errorMsg)}\n\nPlease contact support.`, { chat_id: targetChatId, message_id: userNotifyMsg.message_id, parse_mode: 'Markdown' });
        }
        return { success: false, newAppName: appName };
    }
}


module.exports = {
    init,
    addUserBot,
    getUserBots,
    getUserIdByBotName,
    getAllUserBots,
    getExpiringBots,
    getUserBotCount,
    getBotNameBySessionId,
    updateUserSession,
    addDeployKey,
    useDeployKey,
    getAllDeployKeys,
    deleteDeployKey,
    getDynoStatus,
    canDeployFreeTrial,
    recordFreeTrialDeploy,
    updateUserActivity,
    getUserLastSeen,
    isUserBanned,
    banUser,
    addReferralAndSecondLevelReward,
    unbanUser,
    saveUserDeployment,
    getUserDeploymentsForRestore,
    deleteUserDeploymentFromBackup,
    markDeploymentDeletedFromHeroku,
    getAllDeploymentsFromBackup,
    handleAppNotFoundAndCleanDb,
    sendAppList,
    permanentlyDeleteBotRecord,
    deleteUserBot,
    getLoggedOutBotsForEmail,
    grantReferralRewards,
    buildWithProgress,
    recordFreeTrialForMonitoring,
    getMonitoredFreeTrials,
    updateFreeTrialWarning,
    backupAllPaidBots,
    removeMonitoredFreeTrial,
    syncDatabases,
    createAllTablesInPool,
    syncDatabaseWithHeroku,
    reconcileDatabaseWithHeroku,
    getExpiringBackups,
    setBackupWarningSent,
    getExpiredBackups,
};
