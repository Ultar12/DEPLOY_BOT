const axios = require('axios');
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
let animateMessage;
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
    GITHUB_RAGANORK_REPO_URL = params.GITHUB_RAGANORK_REPO_URL;
    ADMIN_ID = params.ADMIN_ID;
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


// --- NEW FUNCTIONS FOR EXPIRATION REMINDERS ---

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

// === Backup Expiration and Warning Functions ===

async function getExpiringBackups() {
    try {
        const result = await pool.query(
            `SELECT user_id, app_name, expiration_date FROM user_deployments 
             WHERE warning_sent_at IS NULL AND expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days';`
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
            `SELECT user_id, app_name FROM user_deployments WHERE expiration_date <= NOW();`
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get expired backups:`, error.message);
        return [];
    }
}


// === Backup, Restore, and Sync Functions ===

async function getUserIdByBotName(botName) {
    try {
        const r = await pool.query(
            'SELECT user_id FROM user_bots WHERE bot_name=$1 ORDER BY created_at DESC LIMIT 1'
            ,[botName]
        );
        const userId = r.rows.length > 0 ? r.rows[0].user_id : null;
        console.log(`[DB] getUserIdByBotName: For bot "${botName}", found user_id: "${userId}".`);
        return userId;
    }
    catch (error) {
        console.error(`[DB] getUserIdByBotName: Failed to get user ID by bot name "${botName}":`, error.message);
        return null;
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
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days cooldown
    const res = await pool.query(
        'SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1',
        [userId]
    );
    if (res.rows.length === 0) return { can: true };
    const lastDeploy = new Date(res.rows[0].last_deploy_at);
    if (lastDeploy < tenDaysAgo) return { can: true };
    const nextAvailable = new Date(lastDeploy.getTime() + 10 * 24 * 60 * 60 * 1000);
    return { can: false, cooldown: nextAvailable };
}

async function recordFreeTrialDeploy(userId) {
    await pool.query(
        `INSERT INTO temp_deploys (user_id, last_deploy_at) VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_deploy_at = NOW()`,
        [userId]
    );
    console.log(`[DB] recordFreeTrialDeploy: Recorded free trial deploy for user "${userId}".`);
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

async function saveUserDeployment(userId, appName, sessionId, configVars, botType, isFreeTrial = false, expirationDateToUse = null) {
    try {
        const cleanConfigVars = JSON.parse(JSON.stringify(configVars));
        const deployDate = new Date();

        // Use a provided expiration date if it exists, otherwise calculate a new one.
        const finalExpirationDate = expirationDateToUse || new Date(deployDate.getTime() + (isFreeTrial ? 3 : 45) * 24 * 60 * 60 * 1000);

        const query = `
            INSERT INTO user_deployments(user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at, is_free_trial)
            VALUES($1, $2, $3, $4, $5, $6, $7, NULL, $8)
            ON CONFLICT (user_id, app_name) DO UPDATE SET
               session_id = EXCLUDED.session_id,
               config_vars = EXCLUDED.config_vars,
               bot_type = EXCLUDED.bot_type,
               deleted_from_heroku_at = NULL,
               is_free_trial = EXCLUDED.is_free_trial,
               -- Keep the original deploy_date and expiration_date on update
               deploy_date = user_deployments.deploy_date,
               expiration_date = user_deployments.expiration_date;
        `;
        await pool.query(query, [userId, appName, sessionId, cleanConfigVars, botType, deployDate, finalExpirationDate, isFreeTrial]);
        console.log(`[DB-Main] Saved/Updated deployment for app ${appName}. Is Free Trial: ${isFreeTrial}. Expiration: ${finalExpirationDate.toISOString()}.`);
    } catch (error) {
        console.error(`[DB-Main] Failed to save user deployment for ${appName}:`, error.message);
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

async function getAllDeploymentsFromBackup(botType) {
    try {
        // --- THIS IS THE FIX ---
        // It now fetches ALL bots of the specified type from your backup database,
        // ignoring whether they are active or inactive.
        const result = await pool.query(
            `SELECT user_id, app_name, session_id, config_vars
             FROM user_deployments 
             WHERE bot_type = $1
             ORDER BY app_name ASC;`,
            [botType]
        );
        // --- END OF FIX ---

        console.log(`[DB-Backup] Fetched all ${result.rows.length} deployments for mass restore from backup pool.`);
        return result.rows;
    } catch (error) {
        console.error(`[DB-Backup] Failed to get all deployments for mass restore:`, error.message);
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
        console.log(`[DB-Backup] Added user ${userId} with app ${appName} to free trial monitoring.`);
    } catch (error) {
        console.error(`[DB-Backup] Failed to record free trial for monitoring:`, error.message);
    }
}

async function getMonitoredFreeTrials() {
    try {
        const result = await pool.query('SELECT * FROM free_trial_monitoring;');
        return result.rows;
    } catch (error) {
        console.error(`[DB-Backup] Failed to get monitored free trials:`, error.message);
        return [];
    }
}

async function updateFreeTrialWarning(userId) {
    try {
        await pool.query('UPDATE free_trial_monitoring SET warning_sent_at = NOW() WHERE user_id = $1;', [userId]);
    } catch (error) {
        console.error(`[DB-Backup] Failed to update free trial warning timestamp:`, error.message);
    }
}

async function removeMonitoredFreeTrial(userId) {
    try {
        await pool.query('DELETE FROM free_trial_monitoring WHERE user_id = $1;', [userId]);
        console.log(`[DB-Backup] Removed user ${userId} from free trial monitoring.`);
    } catch (error) {
        console.error(`[DB-Backup] Failed to remove monitored free trial:`, error.message);
    }
}

// --- NEW FUNCTION for backing up all bots ---
async function backupAllPaidBots() {
    console.log('[DB-Backup] Starting backup process for all paid bots...');
    try {
        const allBots = await getAllUserBots();
        if (!allBots || allBots.length === 0) {
            console.log('[DB-Backup] No bots found in the main database to back up.');
            return { success: true, message: 'No bots to back up.' };
        }

        let backedUpCount = 0;
        let failedCount = 0;

        for (const bot of allBots) {
            const { user_id, bot_name, bot_type } = bot;
            try {
                const response = await axios.get(`https://api.heroku.com/apps/${bot_name}/config-vars`, {
                    headers: {
                        Authorization: `Bearer ${HEROKU_API_KEY}`,
                        Accept: 'application/vnd.heroku+json; version=3'
                    }
                });
                const configVars = response.data;
                const sessionId = configVars.SESSION_ID || 'N/A';

                await saveUserDeployment(user_id, bot_name, sessionId, configVars, bot_type);
                console.log(`[DB-Backup] Successfully backed up: ${bot_name}`);
                backedUpCount++;
            } catch (error) {
                failedCount++;
                if (error.response && error.response.status === 404) {
                    console.warn(`[DB-Backup] App not found on Heroku during backup: ${bot_name}. Marking as deleted.`);
                    await markDeploymentDeletedFromHeroku(user_id, bot_name);
                } else {
                    console.error(`[DB-Backup] Failed to back up bot ${bot_name} for user ${user_id}. Error: ${error.message}`);
                }
            }
        }
        const summary = `Backup complete. Success: ${backedUpCount}, Failed: ${failedCount}.`;
        console.log(`[DB-Backup] ${summary}`);
        return { success: true, message: summary };

    } catch (error) {
        console.error('[DB-Backup] CRITICAL ERROR during the backupAllPaidBots process:', error);
        return { success: false, message: `An unexpected error occurred: ${error.message}` };
    }
}

async function syncDatabases(sourcePool, targetPool) {
    const clientSource = await sourcePool.connect();
    const clientTarget = await targetPool.connect();
    
    try {
        // --- FIX STARTS HERE: Ensure the target DB has all the tables first ---
        console.log('[Sync] Ensuring target database schema is up-to-date...');
        await createAllTablesInPool(targetPool, 'Backup-for-Sync');
        // --- FIX ENDS HERE ---

        const tablesResult = await clientSource.query(`
            SELECT tablename FROM pg_catalog.pg_tables 
            WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema';
        `);
        const tableNames = tablesResult.rows.map(row => row.tablename);

        await clientTarget.query('BEGIN');

        for (const tableName of tableNames.slice().reverse()) {
            console.log(`[Sync] Clearing table ${tableName} in target DB...`);
            await clientTarget.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE;`);
        }

        for (const tableName of tableNames) {
            console.log(`[Sync] Copying data for table ${tableName}...`);
            const { rows } = await clientSource.query(`SELECT * FROM "${tableName}";`);

            if (rows.length > 0) {
                const columns = Object.keys(rows[0]);
                const colNames = columns.map(c => `"${c}"`).join(', ');
                const valuePlaceholders = columns.map((_, i) => `$${i + 1}`).join(', ');

                for (const row of rows) {
                    const values = columns.map(col => row[col]);
                    const insertQuery = `INSERT INTO "${tableName}" (${colNames}) VALUES (${valuePlaceholders});`;
                    await clientTarget.query(insertQuery, values);
                }
            }
            console.log(`[Sync] Copied ${rows.length} rows to ${tableName}.`);
        }

        await clientTarget.query('COMMIT');
        return { success: true, message: `Successfully synced ${tableNames.length} tables.` };

    } catch (error) {
        await clientTarget.query('ROLLBACK');
        console.error('[Sync] Database sync failed:', error);
        return { success: false, message: error.message };
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

async function buildWithProgress(chatId, vars, isFreeTrial = false, isRestore = false, botType) {
  let name = vars.APP_NAME;
  const originalName = name;
  const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;

  const botTypeSpecificDefaults = defaultEnvVars[botType] || {};

  let buildResult = false;
  const createMsg = await sendAnimatedMessage(chatId, 'Creating application');

  try {
    await bot.editMessageText(`${getAnimatedEmoji()} Creating application...`, { chat_id: chatId, message_id: createMsg.message_id });
    const createMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Creating application');

    // --- FIX STARTS HERE: Corrected logic for preemptive name change on restore ---
    if (isRestore) {
        const originalName = name;
        let newName = originalName;
        
        // This is a more robust way to handle a name change on restore
        const endsWithNumber = /-\d+$/; // Regex to match a dash followed by numbers at the end
        if (endsWithNumber.test(newName)) {
            // If the name already ends with a number suffix, replace it
            const prefix = newName.replace(/-\d+$/, '');
            const newSuffix = `-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
            newName = `${prefix}${newSuffix}`;
        } else {
            // If the name does not end with a number, add a new one
            const newSuffix = `-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
            newName = `${newName.substring(0, 30 - newSuffix.length)}${newSuffix}`;
        }

        name = newName.toLowerCase();
        vars.APP_NAME = name;
        console.log(`[Restore] App is being restored. Using new name to avoid conflict: "${name}".`);
        await bot.editMessageText(`${getAnimatedEmoji()} Restoring app with new name: "${name}"...`, { chat_id: chatId, message_id: createMsg.message_id });
    }
    // --- FIX ENDS HERE ---
    
    // Now, attempt to create the app once with the (potentially modified) name.
    await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    clearInterval(createMsgAnimate);

    await bot.editMessageText(`${getAnimatedEmoji()} Configuring resources...`, { chat_id: chatId, message_id: createMsg.message_id });
    const configMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Configuring resources');


    await axios.post(
      `https://api.heroku.com/apps/${name}/addons`,
      { plan: 'heroku-postgresql' },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    await axios.put(
      `https://api.heroku.com/apps/${name}/buildpack-installations`,
      {
        updates: [
          { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
          { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
          { buildpack: 'heroku/nodejs' }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );
    clearInterval(configMsgAnimate);

    await bot.editMessageText(`${getAnimatedEmoji()} Setting environment variables...`, { chat_id: chatId, message_id: createMsg.message_id });
    const varsMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Setting environment variables');

    const filteredVars = {};
    for (const key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && String(vars[key]).trim() !== '') {
            filteredVars[key] = vars[key];
        }
    }

    let finalConfigVars = {};
    if (isRestore) {
        finalConfigVars = filteredVars;
    } else {
        finalConfigVars = {
            ...botTypeSpecificDefaults,
            ...filteredVars
        };
    }

    await axios.patch(
      `https://api.heroku.com/apps/${name}/config-vars`,
      {
        ...finalConfigVars,
        APP_NAME: name
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );
    clearInterval(varsMsgAnimate);

    await bot.editMessageText(`Starting build process...`, { chat_id: chatId, message_id: createMsg.message_id });
    const bres = await axios.post(
      `https://api.heroku.com/apps/${name}/builds`,
      { source_blob: { url: `${githubRepoUrl}/tarball/main` } },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    let buildStatus;

    if (botType === 'raganork') {
        console.log(`[Build] Starting simulated build for Raganork app: ${name}`);
        buildStatus = 'pending';

        await new Promise(resolve => {
            const buildDuration = 72000;
            const updateInterval = 1500;
            let elapsedTime = 0;

            const simulationInterval = setInterval(async () => {
                elapsedTime += updateInterval;
                const percentage = Math.min(100, Math.floor((elapsedTime / buildDuration) * 100));
                try {
                    await bot.editMessageText(`Building... ${percentage}%`, {
                        chat_id: chatId,
                        message_id: createMsg.message_id
                    });
                } catch (e) {
                    if (!e.message.includes('message is not modified')) {
                        console.error("Error editing message during build simulation:", e.message);
                    }
                }
                if (elapsedTime >= buildDuration) {
                    clearInterval(simulationInterval);
                    buildStatus = 'succeeded';
                    resolve();
                }
            }, updateInterval);
        });

    } else {
        const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
        buildStatus = 'pending';
        let currentPct = 0;

        const buildProgressInterval = setInterval(async () => {
            try {
                const poll = await axios.get(statusUrl, {
                    headers: {
                        Authorization: `Bearer ${HEROKU_API_KEY}`,
                        Accept: 'application/vnd.heroku+json; version=3'
                    }
                });
                buildStatus = poll.data.status;
                if (buildStatus === 'pending') {
                    currentPct = Math.min(99, currentPct + Math.floor(Math.random() * 5) + 1);
                } else if (buildStatus === 'succeeded') {
                    currentPct = 100;
                } else if (buildStatus === 'failed') {
                    currentPct = 'Error';
                }
                await bot.editMessageText(`Building... ${currentPct}%`, {
                    chat_id: chatId,
                    message_id: createMsg.message_id
                }).catch(() => {});
                if (buildStatus !== 'pending' || currentPct === 100 || currentPct === 'Error') {
                    clearInterval(buildProgressInterval);
                }
            } catch (error) {
                console.error(`Error polling build status for ${name}:`, error.message);
                clearInterval(buildProgressInterval);
                await bot.editMessageText(`Building... Error`, {
                    chat_id: chatId,
                    message_id: createMsg.message_id
                }).catch(() => {});
                buildStatus = 'error';
            }
        }, 5000);

        try {
            const BUILD_COMPLETION_TIMEOUT = 300 * 1000;
            let completionTimeoutId = setTimeout(() => {
                clearInterval(buildProgressInterval);
                buildStatus = 'timed out';
                throw new Error(`Build process timed out after ${BUILD_COMPLETION_TIMEOUT / 1000} seconds.`);
            }, BUILD_COMPLETION_TIMEOUT);
            while (buildStatus === 'pending') {
                await new Promise(r => setTimeout(r, 5000));
            }
            clearTimeout(completionTimeoutId);
            clearInterval(buildProgressInterval);
        } catch (err) {
            clearInterval(buildProgressInterval);
            await bot.editMessageText(`Build process for "${name}" timed out. Check Heroku logs.`, {
                chat_id: chatId,
                message_id: createMsg.message_id
            });
            buildResult = false;
            return buildResult;
        }
    }

    if (buildStatus === 'succeeded') {
      console.log(`[Flow] buildWithProgress: Heroku build for "${name}" SUCCEEDED.`);

        // --- START OF CORRECTED RESTORE LOGIC ---
      if (isRestore) {
        let expirationDateToUse;
        if (name !== originalName) {
            try {
                const originalDeployment = (await pool.query('SELECT expiration_date FROM user_deployments WHERE user_id = $1 AND app_name = $2', [chatId, originalName])).rows[0];
                if (originalDeployment) {
                  expirationDateToUse = originalDeployment.expiration_date;
                  await pool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [chatId, originalName]);
                  console.log(`[Expiration Fix] Transferred expiration date from original deployment (${originalName}) to new deployment (${name}).`);
                }
                await pool.query('UPDATE user_bots SET bot_name = $1, session_id = $2, bot_type = $3 WHERE user_id = $4 AND bot_name = $5', [name, vars.SESSION_ID, botType, chatId, originalName]);
                console.log(`[DB Rename Fix] Renamed bot in user_bots table from "${originalName}" to "${name}".`);
            } catch (dbError) {
                console.error(`[Expiration Fix] Error fetching/deleting original deployment record for ${originalName}:`, dbError.message);
            }
        } else {
            await addUserBot(chatId, name, vars.SESSION_ID, botType);
        }
        
        const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;
        await saveUserDeployment(chatId, name, vars.SESSION_ID, herokuConfigVars, botType, isFreeTrial, expirationDateToUse);

        // Send success message immediately and exit
        await bot.editMessageText(
            `Restore successful! App *${escapeMarkdown(name)}* has been redeployed.`,
            { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' }
        );
        return true; // Mark as success and return
      }
      // --- END OF CORRECTED RESTORE LOGIC ---

      await addUserBot(chatId, name, vars.SESSION_ID, botType);
      const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;
      await saveUserDeployment(chatId, name, vars.SESSION_ID, herokuConfigVars, botType, isFreeTrial);
      if (isFreeTrial) {
        await recordFreeTrialDeploy(chatId);
      }
      
      // --- NEW REWARD LOGIC START ---
      try {
          const userBotCount = await getUserBotCount(chatId);
          const userHasReceivedReward = await hasReceivedReward(chatId);

          if (userBotCount >= 10 && !userHasReceivedReward) {
              const newKey = generateKey();
              await addDeployKey(newKey, 1, 'AUTOMATIC_REWARD', chatId); // <-- NOTE: Added chatId to link the key
              await recordReward(chatId);

              const rewardMessage = `Congratulations! You have deployed 10 or more bots with our service. As a token of our appreciation, here is a free one-time deploy key:\n\n\`${newKey}\``;
              await bot.sendMessage(chatId, rewardMessage, { parse_mode: 'Markdown' });

              await bot.sendMessage(ADMIN_ID, `Reward issued to user \`${chatId}\` for reaching 10 deployments. Key: \`${newKey}\``, { parse_mode: 'Markdown' });
              console.log(`[Reward] Issued free key to user ${chatId}.`);
          }
      } catch (rewardError) {
          console.error(`[Reward] Failed to check or issue reward to user ${chatId}:`, rewardError.message);
      }
      // --- NEW REWARD LOGIC END ---

      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [`*Name:* ${escapeMarkdown(first_name || '')} ${escapeMarkdown(last_name || '')}`, `*Username:* @${escapeMarkdown(username || 'N/A')}`, `*Chat ID:* \`${escapeMarkdown(chatId)}\``].join('\n');
      const appDetails = `*App Name:* \`${escapeMarkdown(name)}\`\n*Session ID:* \`${escapeMarkdown(vars.SESSION_ID)}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;
      await bot.sendMessage(ADMIN_ID, `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      const baseWaitingText = `Build successful! Waiting for bot to connect...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
      const animateIntervalId = await animateMessage(chatId, createMsg.message_id, baseWaitingText);
      const appStatusPromise = new Promise((resolve, reject) => {
          const STATUS_CHECK_TIMEOUT = 120 * 1000;
          const timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(name);
              if (appPromise) {
                  appPromise.reject(new Error(`Bot did not connect within ${STATUS_CHECK_TIMEOUT / 1000} seconds.`));
                  appDeploymentPromises.delete(name);
              }
          }, STATUS_CHECK_TIMEOUT);
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId, timeoutId });
      });


      try {
          await appStatusPromise;
          const promiseData = appDeploymentPromises.get(name);
          if (promiseData && promiseData.timeoutId) {
             clearTimeout(promiseData.timeoutId);
          }
          clearInterval(animateIntervalId);

          await bot.editMessageText(
              `Your bot *${escapeMarkdown(name)}* is now live!\n\nBackup your app for future reference.`,
              {
                  chat_id: chatId,
                  message_id: createMsg.message_id,
                  parse_mode: 'Markdown',
                  reply_markup: {
                      inline_keyboard: [[{ text: `Backup "${name}"`, callback_data: `backup_app:${name}` }]]
                  }
              }
          );
          buildResult = true;

          if (isFreeTrial) {
            await recordFreeTrialForMonitoring(chatId, name, TELEGRAM_CHANNEL_ID);
            const THREE_DAYS_IN_MS = 3 * 24 * 60 * 60 * 1000;
            const ONE_HOUR_IN_MS = 1 * 60 * 60 * 1000;
            
            setTimeout(async () => {
                const adminWarningMessage = `Free Trial App "*${escapeMarkdown(name)}*" has 1 hour left until deletion!`;
                const keyboard = { inline_keyboard: [[{ text: `Delete "*${escapeMarkdown(name)}" Now`, callback_data: `admin_delete_trial_app:${name}` }]] };
                await bot.sendMessage(ADMIN_ID, adminWarningMessage, { reply_markup: keyboard, parse_mode: 'Markdown' });
                console.log(`[FreeTrial] Sent 1-hour warning to admin for ${name}.`);
            }, THREE_DAYS_IN_MS - ONE_HOUR_IN_MS);

            setTimeout(async () => {
                try {
                    await bot.sendMessage(chatId, `Your Free Trial app "*${escapeMarkdown(name)}*" is being deleted as its 3-day runtime has ended.`);
                    await axios.delete(`https://api.heroku.com/apps/${name}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    await deleteUserBot(chatId, name);
                    await markDeploymentDeletedFromHeroku(chatId, name);
                    await bot.sendMessage(chatId, `Free Trial app "*${escapeMarkdown(name)}*" successfully deleted.`);
                    console.log(`[FreeTrial] Auto-deleted app ${name} after 3 days.`);
                } catch (e) {
                    console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                    await bot.sendMessage(chatId, `Could not auto-delete "*${escapeMarkdown(name)}*". Please delete it from your Heroku dashboard.`, {parse_mode: 'Markdown'});
                    monitorSendTelegramAlert(`Failed to auto-delete free trial app "*${escapeMarkdown(name)}*" for user ${escapeMarkdown(chatId)}: ${escapeMarkdown(e.message)}`, ADMIN_ID);
                }
            }, THREE_DAYS_IN_MS);
          }
      } catch (err) {
          const promiseData = appDeploymentPromises.get(name);
          if (promiseData) {
             clearInterval(promiseData.animateIntervalId);
             if (promiseData.timeoutId) clearTimeout(promiseData.timeoutId);
          }
          console.error(`App status check failed for ${name}:`, err.message);
          await bot.editMessageText(
            `Bot "*${escapeMarkdown(name)}*" failed to start: ${escapeMarkdown(err.message)}\n\nYou may need to update the session ID.`,
            {
                chat_id: chatId,
                message_id: createMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${name}:${chatId}` }]]
                }
            }
          );
          buildResult = false;
      } finally {
          appDeploymentPromises.delete(name);
      }
    } else {
      await bot.editMessageText(`Build status: ${buildStatus}. Contact Admin for support.`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
      buildResult = false;
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred: ${escapeMarkdown(errorMsg)}\n\Contact Adminfor support.`, {parse_mode: 'Markdown'});
    buildResult = false;
  }
  return buildResult;
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
    canDeployFreeTrial,
    recordFreeTrialDeploy,
    updateUserActivity,
    getUserLastSeen,
    isUserBanned,
    banUser,
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
    buildWithProgress,
    recordFreeTrialForMonitoring,
    getMonitoredFreeTrials,
    updateFreeTrialWarning,
    removeMonitoredFreeTrial,
    syncDatabases,
    getExpiringBackups,
    setBackupWarningSent,
    getExpiredBackups,
    backupAllPaidBots // <-- FIX: Added the missing function to the exports
};
