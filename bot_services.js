const axios = require('axios');

const herokuApi = axios.create({
    baseURL: 'https://api.heroku.com',
    headers: {
        'Accept': 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }
});
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// --- Module-level variables ---
let pool;
let backupPool;
let bot;
let HEROKU_API_KEY;
let GITHUB_LEVANTER_REPO_URL;
let GITHUB_RAGANORK_REPO_URL;
let ADMIN_ID;
let TELEGRAM_CHANNEL_ID;
let defaultEnvVars;
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
 */
function init(params) {
    pool = params.mainPool;
    backupPool = params.backupPool;
    bot = params.bot;
    HEROKU_API_KEY = params.HEROKU_API_KEY;
    GITHUB_LEVANTER_REPO_URL = params.GITHUB_LEVANTER_REPO_URL;
    GITHUB_RAGANORK_REPO_URL = params.GITHUB_RAGANORK_REPO_URL;
    ADMIN_ID = params.ADMIN_ID;
    moduleParams = params; // Store all params for easy access
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

// === DB Helper Functions ===

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
      console.log(`[DB] addUserBot: Added/updated bot "${b}" for user "${u}". Type: "${botType}".`);
    } else {
      console.warn(`[DB] addUserBot: Insert/update for bot "${b}" user "${u}" didn't return row.`);
    }
  } catch (error) {
    console.error(`[DB] addUserBot: CRITICAL ERROR adding/updating bot "${b}" for user "${u}":`, error.message, error.stack);
    if (monitorSendTelegramAlert) {
      monitorSendTelegramAlert(`CRITICAL DB ERROR: Failed add/update bot "${b}" for user "${u}". Check logs.`, ADMIN_ID);
    } else {
      console.error("monitorSendTelegramAlert not initialized.");
    }
  }
}

async function backupHerokuDbToRenderSchema(appName) {
    const { mainPool, herokuApi, HEROKU_API_KEY } = moduleParams;
    const mainDbUrl = process.env.DATABASE_URL;
    const schemaName = appName.replace(/-/g, '_'); // Use sanitized app name directly

    try {
        const configRes = await herokuApi.get(`/apps/${appName}/config-vars`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
        const herokuDbUrl = configRes.data.DATABASE_URL;
        if (!herokuDbUrl) throw new Error("DATABASE_URL not found in Heroku config vars.");

        const client = await mainPool.connect();
        try {
            await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE;`);
            await client.query(`CREATE SCHEMA ${schemaName};`);
        } finally {
            client.release();
        }

        console.log(`[DB Backup] Starting data pipe for ${appName} to schema ${schemaName}...`);
        const command = `pg_dump "${herokuDbUrl}" --clean | psql "${mainDbUrl}" -c "SET search_path TO ${schemaName};"`;
        const { stderr } = await execPromise(command, { maxBuffer: 1024 * 1024 * 10 });

        if (stderr && (stderr.toLowerCase().includes('error') || stderr.toLowerCase().includes('fatal'))) {
            throw new Error(stderr);
        }

        console.log(`[DB Backup] Successfully backed up ${appName} to schema ${schemaName}.`);
        return { success: true, message: 'Database backup successful.' };
    } catch (error) {
        console.error(`[DB Backup] FAILED to back up ${appName}:`, error.message);
        return { success: false, message: error.message };
    }
}

async function restoreHerokuDbFromRenderSchema(originalBaseName, newAppName) {
    const { herokuApi, HEROKU_API_KEY, bot, mainPool } = moduleParams;
    const mainDbUrl = process.env.DATABASE_URL;
    let schemaName = null;
    let client;

    try {
        console.log(`[DB Restore] Searching for schema matching base name: '${originalBaseName}'`);
        const baseNameForSearch = originalBaseName.replace(/-/g, '_');
        client = await mainPool.connect();
        try {
            const schemaRes = await client.query(
                `SELECT nspname FROM pg_catalog.pg_namespace
                 WHERE nspname LIKE $1 || '%' OR nspname LIKE 'backup_' || $1 || '%'
                 ORDER BY nspname DESC LIMIT 1`,
                [baseNameForSearch]
            );
            if (schemaRes.rowCount === 0) throw new Error(`No backup schema found matching '${baseNameForSearch}%' OR 'backup_${baseNameForSearch}%'.`);
            schemaName = schemaRes.rows[0].nspname;
            console.log(`[DB Restore] Found matching schema: '${schemaName}'`);
        } finally {
            if (client) client.release();
        }

        let newHerokuDbUrl = null;
        console.log(`[DB Restore] Waiting for app '${newAppName}' config vars...`);
        for (let i = 0; i < 18; i++) {
            try {
                const configRes = await herokuApi.get(`/apps/${newAppName}/config-vars`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
                newHerokuDbUrl = configRes.data.DATABASE_URL;
                if (newHerokuDbUrl) { console.log(`[DB Restore] App '${newAppName}' ready.`); break; }
            } catch (e) {
                if (e.response?.status !== 404) throw e;
                console.log(`[DB Restore] App '${newAppName}' not ready (404), retrying...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
        if (!newHerokuDbUrl) throw new Error(`Could not find DATABASE_URL for '${newAppName}' after 3 minutes.`);

        console.log(`[DB Restore] Starting data pipe from schema ${schemaName} to ${newAppName}...`);
        const command = `PGOPTIONS="--search_path=${schemaName},public" pg_dump "${mainDbUrl}" --no-owner --clean | psql "${newHerokuDbUrl}" --set ON_ERROR_STOP=off`;
        const { stderr } = await execPromise(command, { maxBuffer: 1024 * 1024 * 10 });

        if (stderr && (stderr.toLowerCase().includes('error') || stderr.toLowerCase().includes('fatal'))) {
            const actualErrors = stderr.split('\n').filter(line =>
                !line.includes('does not exist') && !line.includes('ACL objects') && !line.includes('owner') &&
                (line.toLowerCase().includes('error') || line.toLowerCase().includes('fatal'))
            ).join('\n');
            if (actualErrors) throw new Error(actualErrors);
            else console.log(`[DB Restore] pg_dump/psql completed with expected warnings (ignored).`);
        }

        console.log(`[DB Restore] Successfully restored data for ${newAppName} from schema ${schemaName}.`);
        return { success: true, message: 'Database restore successful.' };
    } catch (error) {
        console.error(`[DB Restore] FAILED to restore ${newAppName}:`, error.message);
        return { success: false, message: error.message };
    }
}

// ... (Keep all other functions like syncDatabaseWithHeroku, getLoggedOutBotsForEmail, etc. exactly as they were before) ...

async function syncDatabaseWithHeroku() {
    console.log('[Sync] Starting full database synchronization with Heroku...');
    const syncStats = { addedToUserBots: 0, addedToDeployments: 0, unmatchedHerokuApps: [] };
    try {
        const herokuAppsResponse = await herokuApi.get('/apps', { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
        const herokuAppNames = new Set(herokuAppsResponse.data.map(app => app.name));
        const dbAppsResult = await pool.query('SELECT bot_name FROM user_bots');
        const dbAppNames = new Set(dbAppsResult.rows.map(row => row.bot_name));
        const missingApps = [...herokuAppNames].filter(appName => !dbAppNames.has(appName));
        if (missingApps.length === 0) return { success: true, message: 'DB already in sync.' };
        console.log(`[Sync] Found ${missingApps.length} missing apps.`);
        for (const appName of missingApps) {
            try {
                const configRes = await herokuApi.get(`/apps/${appName}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                const configVars = configRes.data;
                const sessionId = configVars.SESSION_ID || 'N/A';
                let botType = 'unknown'; // Add logic to determine type if possible
                await addUserBot(ADMIN_ID, appName, sessionId, botType); // Assign to admin for now
                await saveUserDeployment(ADMIN_ID, appName, sessionId, configVars, botType);
                syncStats.addedToUserBots++; syncStats.addedToDeployments++;
                console.log(`[Sync] Added missing app "${appName}" to DB.`);
            } catch (configError) {
                console.error(`[Sync] Failed fetch config for "${appName}". Skipping.`, configError.message);
                syncStats.unmatchedHerokuApps.push(appName);
            }
        }
    } catch (error) { console.error('[Sync] CRITICAL ERROR:', error.message); return { success: false, message: `Sync error: ${error.message}` }; }
    const finalMessage = `Sync complete. Added ${syncStats.addedToUserBots} apps.`;
    console.log(`[Sync] ${finalMessage}`); return { success: true, message: finalMessage, stats: syncStats };
}

async function getLoggedOutBotsForEmail() {
    try { const result = await pool.query(`SELECT ub.user_id, ub.bot_name, ud.email FROM user_bots ub JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name WHERE ub.status = 'logged_out' AND ud.is_free_trial = FALSE AND ud.email IS NOT NULL;`); console.log(`[DB] Found ${result.rows.length} logged-out paid bots for email.`); return result.rows; } catch (error) { console.error(`[DB] Failed get logged-out bots:`, error.message); return []; }
}

async function getUserBotCount(userId) { try { const result = await pool.query('SELECT COUNT(bot_name) as count FROM user_bots WHERE user_id = $1', [userId]); return parseInt(result.rows[0].count, 10) || 0; } catch (error) { console.error(`[DB] Failed get bot count user ${userId}:`, error.message); return 0; } }
async function hasReceivedReward(userId) { try { const result = await pool.query('SELECT 1 FROM key_rewards WHERE user_id = $1', [userId]); return result.rows.length > 0; } catch (error) { console.error(`[DB] Failed check reward user ${userId}:`, error.message); return false; } }
async function recordReward(userId) { try { await pool.query('INSERT INTO key_rewards(user_id) VALUES ($1)', [userId]); console.log(`[DB] Recorded reward user ${userId}.`); } catch (error) { console.error(`[DB] Failed record reward user ${userId}:`, error.message); } }

async function reconcileDatabaseWithHeroku(botType) {
    console.log(`[Sync] Reconciling DB for ${botType}...`); try { const [herokuAppsRes, dbAppsRes] = await Promise.all([ herokuApi.get('/apps', { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }), pool.query('SELECT app_name, user_id FROM user_deployments WHERE bot_type = $1', [botType]) ]); const herokuApps = herokuAppsRes.data.map(app => app.name).filter(name => name.includes(botType)); const dbApps = dbAppsRes.rows; const herokuAppSet = new Set(herokuApps); const renamedApps = []; for (const dbApp of dbApps) { if (!herokuAppSet.has(dbApp.app_name)) { const originalPrefix = dbApp.app_name.replace(/-\d+$/, ''); const potentialNewNames = herokuApps.filter(hName => hName.startsWith(originalPrefix)); if (potentialNewNames.length === 1) { const newName = potentialNewNames[0]; console.log(`[Sync] Found rename: ${dbApp.app_name} -> ${newName}.`); renamedApps.push({ oldName: dbApp.app_name, newName, userId: dbApp.user_id }); } } } for (const app of renamedApps) { await pool.query('UPDATE user_bots SET bot_name = $1 WHERE user_id = $2 AND bot_name = $3', [app.newName, app.userId, app.oldName]); await pool.query('UPDATE user_deployments SET app_name = $1 WHERE user_id = $2 AND app_name = $3', [app.newName, app.userId, app.oldName]); console.log(`[Sync] Updated DB ${app.oldName} -> ${app.newName}.`); } console.log(`[Sync] Reconcile complete. Fixed ${renamedApps.length} apps.`); return { success: true, message: `Fixed ${renamedApps.length} apps.` }; } catch (error) { console.error('[Sync] Reconcile failed:', error); return { success: false, message: error.message }; }
}

async function getDynoStatus(appName) { try { const response = await herokuApi.get(`/apps/${appName}/dynos`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }); if (response.data.length > 0 && response.data[0].state !== 'crashed') return 'on'; return 'off'; } catch (error) { if (error.response?.status === 404) return 'deleted'; console.error(`[Dyno Check] Error ${appName}:`, error.message); return 'error'; } }
async function getExpiringBots() { try { const result = await pool.query(`SELECT user_id, app_name FROM user_deployments WHERE warning_sent_at IS NULL AND expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days';`); return result.rows; } catch (error) { console.error(`[DB] Failed get expiring bots:`, error.message); return []; } }
async function setExpirationWarningSent(userId, appName) { try { await pool.query('UPDATE user_deployments SET warning_sent_at = NOW() WHERE user_id = $1 AND app_name = $2;', [userId, appName]); } catch (error) { console.error(`[DB] Failed set exp warning ${appName}:`, error.message); } }
async function deleteUserBot(u, b) { try { await pool.query('DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2', [u, b]); console.log(`[DB] Deleted bot "${b}" user "${u}".`); } catch (error) { console.error(`[DB] Failed delete bot "${b}" user "${u}":`, error.message); } }
async function getUserBots(u) { try { const r = await pool.query('SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at', [u]); console.log(`[DB] Get bots user "${u}" Found:`, r.rows.map(x => x.bot_name)); return r.rows.map(x => x.bot_name); } catch (error) { console.error(`[DB] Failed get bots user "${u}":`, error.message); return []; } }
async function getExpiringBackups() { try { const result = await pool.query(`SELECT user_id, app_name, expiration_date FROM user_deployments WHERE warning_sent_at IS NULL AND expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days' AND paused_at IS NULL;`); return result.rows; } catch (error) { console.error(`[DB] Failed get expiring backups:`, error.message); return []; } }
async function setBackupWarningSent(userId, appName) { try { await pool.query('UPDATE user_deployments SET warning_sent_at = NOW() WHERE user_id = $1 AND app_name = $2;', [userId, appName]); } catch (error) { console.error(`[DB] Failed set backup warning ${appName}:`, error.message); } }
async function getExpiredBackups() { try { const result = await pool.query(`SELECT user_id, app_name FROM user_deployments WHERE expiration_date <= NOW() AND paused_at IS NULL;`); return result.rows; } catch (error) { console.error(`[DB] Failed get expired backups:`, error.message); return []; } }
async function getUserIdByBotName(botName) { try { const r = await pool.query('SELECT user_id FROM user_bots WHERE bot_name=$1 ORDER BY created_at DESC LIMIT 1', [botName]); const userId = r.rows.length > 0 ? r.rows[0].user_id : null; console.log(`[DB] Get user by bot "${botName}", found: "${userId}".`); return userId; } catch (error) { console.error(`[DB] Failed get user by bot "${botName}":`, error.message); return null; } }
async function getAllUserBots() { try { const r = await pool.query('SELECT user_id, bot_name, bot_type FROM user_bots ORDER BY created_at'); console.log(`[DB] Fetched ${r.rows.length} bots.`); return r.rows; } catch (error) { console.error('[DB] Failed get all bots:', error.message); return []; } }
async function getBotNameBySessionId(sessionId) { try { const r = await pool.query('SELECT bot_name FROM user_bots WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1', [sessionId]); const botName = r.rows.length > 0 ? r.rows[0].bot_name : null; console.log(`[DB] Get bot by session "${sessionId}", found: "${botName}".`); return botName; } catch (error) { console.error(`[DB] Failed get bot by session "${sessionId}":`, error.message); return null; } }
async function permanentlyDeleteBotRecord(userId, appName) { try { await pool.query('DELETE FROM user_bots WHERE user_id = $1 AND bot_name = $2', [userId, appName]); await pool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [userId, appName]); if (backupPool) await backupPool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [userId, appName]); else console.warn('[DB-Cleanup] backupPool not init, skipping backup delete.'); console.log(`[DB-Cleanup] Permanently deleted ${appName}.`); return true; } catch (error) { console.error(`[DB-Cleanup] Failed permanent delete ${appName}:`, error.message); return false; } }
async function updateUserSession(u, b, s) { try { await pool.query('UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3', [s, u, b]); console.log(`[DB] Updated session bot "${b}" user "${u}".`); } catch (error) { console.error(`[DB] Failed update session bot "${b}" user "${u}":`, error.message); } }
async function addDeployKey(key, uses, createdBy, userId = null) { await pool.query('INSERT INTO deploy_keys(key, uses_left, created_by, user_id) VALUES($1, $2, $3, $4)', [key, uses, createdBy, userId]); console.log(`[DB] Added key "${key}" user "${userId || 'General'}" uses ${uses} by "${createdBy}".`); }
async function useDeployKey(key, userId) { const res = await pool.query(`UPDATE deploy_keys SET uses_left = uses_left - 1 WHERE key = $1 AND uses_left > 0 AND (user_id = $2 OR user_id IS NULL) RETURNING uses_left`, [key, userId]); if (res.rowCount === 0) { console.log(`[DB] Key "${key}" invalid/used/unauth user "${userId}".`); return null; } const left = res.rows[0].uses_left; if (left === 0) { await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]); console.log(`[DB] Key "${key}" user "${userId}" used/deleted.`); } else console.log(`[DB] Key "${key}" user "${userId}" used. ${left} left.`); return left; }
async function getAllDeployKeys() { try { const res = await pool.query('SELECT key, uses_left, created_by, user_id, created_at FROM deploy_keys ORDER BY created_at DESC'); return res.rows; } catch (error) { console.error('[DB] Failed get all keys:', error.message); return []; } }
async function deleteDeployKey(key) { try { const result = await pool.query('DELETE FROM deploy_keys WHERE key = $1 RETURNING key', [key]); if (result.rowCount > 0) { console.log(`[DB] Deleted key "${key}".`); return true; } console.warn(`[DB] Key "${key}" not found.`); return false; } catch (error) { console.error(`[DB] Failed delete key "${key}":`, error.message); return false; } }
async function canDeployFreeTrial(userId) { const COOLDOWN_DAYS = 90; const res = await pool.query('SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1', [userId]); if (res.rows.length === 0) return { can: true }; const lastDeploy = new Date(res.rows[0].last_deploy_at); const now = new Date(); const cooldownEnd = new Date(lastDeploy.getTime() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000); return now >= cooldownEnd ? { can: true } : { can: false, cooldown: cooldownEnd }; }
async function recordFreeTrialDeploy(userId) { await pool.query(`INSERT INTO temp_deploys (user_id, last_deploy_at) VALUES ($1, NOW()) ON CONFLICT (user_id) DO UPDATE SET last_deploy_at = NOW()`, [userId]); console.log(`[DB] Recorded free trial deploy user "${userId}".`); }
async function updateUserActivity(userId) { const query = `INSERT INTO user_activity(user_id, last_seen) VALUES($1, NOW()) ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW();`; try { await pool.query(query, [userId]); console.log(`[DB] User activity updated ${userId}.`); } catch (error) { console.error(`[DB] Failed update user activity ${userId}:`, error.message); } }
async function getUserLastSeen(userId) { try { const result = await pool.query('SELECT last_seen FROM user_activity WHERE user_id = $1', [userId]); return result.rows.length > 0 ? result.rows[0].last_seen : null; } catch (error) { console.error(`[DB] Failed get last seen ${userId}:`, error.message); return null; } }
async function isUserBanned(userId) { try { const result = await pool.query('SELECT 1 FROM banned_users WHERE user_id = $1', [userId]); return result.rows.length > 0; } catch (error) { console.error(`[DB] Error check ban ${userId}:`, error.message); return false; } }
async function banUser(userId, bannedByAdminId) { try { await pool.query('INSERT INTO banned_users(user_id, banned_by) VALUES($1, $2) ON CONFLICT (user_id) DO NOTHING;', [userId, bannedByAdminId]); console.log(`[Admin] User ${userId} banned by ${bannedByAdminId}.`); return true; } catch (error) { console.error(`[Admin] Error banning ${userId}:`, error.message); return false; } }
async function unbanUser(userId) { try { const result = await pool.query('DELETE FROM banned_users WHERE user_id = $1 RETURNING user_id;', [userId]); if (result.rowCount > 0) { console.log(`[Admin] User ${userId} unbanned.`); return true; } return false; } catch (error) { console.error(`[Admin] Error unbanning ${userId}:`, error.message); return false; } }

async function saveUserDeployment(userId, appName, sessionId, configVars, botType, isFreeTrial = false, expirationDateToUse = null, email = null) {
    try {
        const cleanConfigVars = JSON.parse(JSON.stringify(configVars));
        const deployDate = new Date();
        const finalExpirationDate = expirationDateToUse instanceof Date ? expirationDateToUse : // Use if valid Date
                                  expirationDateToUse ? new Date(expirationDateToUse) : // Try parsing if string/number
                                  new Date(deployDate.getTime() + (isFreeTrial ? 3 : 35) * 24 * 60 * 60 * 1000); // Default calculation

        // Ensure finalExpirationDate is valid, otherwise default again
        const validFinalExpirationDate = !isNaN(finalExpirationDate.getTime()) ? finalExpirationDate : new Date(deployDate.getTime() + (isFreeTrial ? 3 : 35) * 24 * 60 * 60 * 1000);

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
               expiration_date = EXCLUDED.expiration_date; -- Update expiration on conflict too
        `;
        await pool.query(query, [userId, appName, sessionId, cleanConfigVars, botType, deployDate, validFinalExpirationDate, isFreeTrial, email]);
        console.log(`[DB] Saved/Updated deployment ${appName} user ${userId}. Free: ${isFreeTrial}. Expires: ${validFinalExpirationDate.toISOString()}.`);
    } catch (error) {
        console.error(`[DB] FAILED save deployment ${appName} user ${userId}:`, error.message);
    }
}

async function getUserDeploymentsForRestore(userId) { try { const result = await pool.query(`SELECT app_name, session_id, config_vars, deploy_date, expiration_date, bot_type, deleted_from_heroku_at FROM user_deployments WHERE user_id = $1 ORDER BY deploy_date DESC;`, [userId]); console.log(`[DB] Fetched ${result.rows.length} deployments user ${userId} for restore.`); return result.rows; } catch (error) { console.error(`[DB] Failed get deployments user ${userId} for restore:`, error.message); return []; } }
async function deleteUserDeploymentFromBackup(userId, appName) { try { const result = await pool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2 RETURNING app_name;', [userId, appName]); if (result.rowCount > 0) { console.log(`[DB] Permanently deleted deployment user ${userId}, app ${appName} from backup.`); return true; } console.log(`[DB] No deployment user ${userId}, app ${appName} found in backup.`); return false; } catch (error) { console.error(`[DB] Failed permanent delete user ${userId} app ${appName} from backup:`, error.message); return false; } }
async function markDeploymentDeletedFromHeroku(userId, appName) { try { await pool.query(`UPDATE user_deployments SET deleted_from_heroku_at = NOW() WHERE user_id = $1 AND app_name = $2;`, [userId, appName]); console.log(`[DB] Marked deployment user ${userId}, app ${appName} deleted from Heroku.`); } catch (error) { console.error(`[DB] Failed mark deleted ${appName}:`, error.message); } }
async function getAllDeploymentsFromBackup(botType) { try { const result = await pool.query(`SELECT user_id, app_name, session_id, config_vars, referred_by FROM user_deployments WHERE bot_type = $1 ORDER BY app_name ASC;`, [botType]); console.log(`[DB] Fetched ${result.rows.length} ${botType} deployments for mass restore.`); return result.rows; } catch (error) { console.error(`[DB] Failed get all deployments restore:`, error.message); return []; } }
async function recordFreeTrialForMonitoring(userId, appName, channelId) { try { await pool.query(`INSERT INTO free_trial_monitoring (user_id, app_name, channel_id) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET app_name = EXCLUDED.app_name, trial_start_at = CURRENT_TIMESTAMP, warning_sent_at = NULL;`, [userId, appName, channelId]); console.log(`[DB] Added user ${userId} app ${appName} to free trial monitor.`); } catch (error) { console.error(`[DB] Failed record free trial monitor:`, error.message); } }
async function getMonitoredFreeTrials() { try { const result = await pool.query('SELECT * FROM free_trial_monitoring;'); return result.rows; } catch (error) { console.error(`[DB] Failed get monitored free trials:`, error.message); return []; } }

async function grantReferralRewards(referredUserId, deployedBotName) {
    const client = await pool.connect(); try { await client.query('BEGIN'); const refSessRes = await client.query(`SELECT data FROM sessions WHERE id = $1`, [`referral_session:${referredUserId}`]); if (refSessRes.rows.length > 0) { const inviterId = refSessRes.rows[0].data.inviterId; const invBotsRes = await client.query(`SELECT bot_name FROM user_bots WHERE user_id = $1`, [inviterId]); const invBots = invBotsRes.rows; if (invBots.length > 0 && invBots.length <= 2) { const invBotName = invBots[0].bot_name; await client.query(`UPDATE user_deployments SET expiration_date = expiration_date + INTERVAL '20 days' WHERE user_id = $1 AND app_name = $2 AND expiration_date IS NOT NULL`, [inviterId, invBotName]); await bot.sendMessage(inviterId, `Congrats! Friend deployed. +20 days on \`${escapeMarkdown(invBotName)}\`!`, { parse_mode: 'Markdown' }); await addReferralAndSecondLevelReward(client, referredUserId, inviterId, deployedBotName); } else if (invBots.length > 2) { await client.query(`INSERT INTO user_referrals (referred_user_id, inviter_user_id, bot_name, inviter_reward_pending) VALUES ($1, $2, $3, TRUE) ON CONFLICT (referred_user_id) DO UPDATE SET inviter_reward_pending = TRUE`, [referredUserId, inviterId, deployedBotName]); const buttons = invBots.map(bot => ([{ text: bot.bot_name, callback_data: `apply_referral_reward:${bot.bot_name}:${referredUserId}` }])); await bot.sendMessage(inviterId, `Friend deployed! Select bot for +20 days:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }); } else { await client.query(`INSERT INTO user_referrals (referred_user_id, inviter_user_id, bot_name) VALUES ($1, $2, $3)`, [referredUserId, inviterId, deployedBotName]); await bot.sendMessage(inviterId, `Congrats! Friend deployed. Earned +20 days, apply to next bot!`, { parse_mode: 'Markdown' }); } await client.query('DELETE FROM sessions WHERE id = $1', [`referral_session:${referredUserId}`]); } await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK'); console.error(`[Referral] Failed grant rewards user ${referredUserId}:`, e); } finally { client.release(); }
}

async function addReferralAndSecondLevelReward(client, referredUserId, inviterId, deployedBotName) {
    await client.query(`INSERT INTO user_referrals (referred_user_id, inviter_user_id, bot_name) VALUES ($1, $2, $3)`, [referredUserId, inviterId, deployedBotName]); const grandInvRes = await client.query(`SELECT inviter_user_id FROM user_referrals WHERE referred_user_id = $1`, [inviterId]); if (grandInvRes.rows.length > 0) { const grandInvId = grandInvRes.rows[0].inviter_user_id; const grandInvBotsRes = await client.query(`SELECT bot_name FROM user_bots WHERE user_id = $1`, [grandInvId]); const grandInvBots = grandInvBotsRes.rows; if (grandInvBots.length > 0 && grandInvBots.length <= 2) { const grandInvBotName = grandInvBots[0].bot_name; await client.query(`UPDATE user_deployments SET expiration_date = expiration_date + INTERVAL '7 days' WHERE user_id = $1 AND app_name = $2 AND expiration_date IS NOT NULL`, [grandInvId, grandInvBotName]); await bot.sendMessage(grandInvId, `Bonus! Friend of friend deployed. +7 days on \`${escapeMarkdown(grandInvBotName)}\`!`, { parse_mode: 'Markdown' }); } else if (grandInvBots.length > 2) { await client.query(`INSERT INTO user_referrals (referred_user_id, inviter_user_id, inviter_reward_pending) VALUES ($1, $2, TRUE) ON CONFLICT (referred_user_id) DO UPDATE SET inviter_reward_pending = TRUE`, [inviterId, grandInvId]); const buttons = grandInvBots.map(bot => ([{ text: bot.bot_name, callback_data: `apply_referral_reward:${bot.bot_name}:${inviterId}:second_level` }])); await bot.sendMessage(grandInvId, `Bonus! Friend of friend deployed. Select bot for +7 days:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }); } }
}

async function updateFreeTrialWarning(userId) { try { await pool.query('UPDATE free_trial_monitoring SET warning_sent_at = NOW() WHERE user_id = $1;', [userId]); } catch (error) { console.error(`[DB] Failed update free trial warning:`, error.message); } }
async function removeMonitoredFreeTrial(userId) { try { await pool.query('DELETE FROM free_trial_monitoring WHERE user_id = $1;', [userId]); console.log(`[DB] Removed user ${userId} from free trial monitor.`); } catch (error) { console.error(`[DB] Failed remove free trial monitor:`, error.message); } }

async function backupAllPaidBots() {
    console.log('[DB-Backup] Starting backup ALL Heroku apps...'); let backedUpCount = 0; let failedCount = 0; let notFoundCount = 0; const herokuAppList = []; const typeStats = { levanter: { backedUp: [], failed: [] }, raganork: { backedUp: [], failed: [] }, unknown: { backedUp: [], failed: [] } }; try { const allAppsRes = await herokuApi.get('/apps', { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }); herokuAppList.push(...allAppsRes.data.map(app => app.name)); console.log(`[DB-Backup] Found ${herokuAppList.length} apps on Heroku.`); if (herokuAppList.length === 0) return { success: true, message: 'No apps found.' }; } catch (error) { console.error('[DB-Backup] CRITICAL fetch apps:', error); return { success: false, message: `Failed fetch apps: ${error.message}` }; } for (const appName of herokuAppList) { let userId = ADMIN_ID; let botType = 'unknown'; try { const localRec = await pool.query('SELECT user_id, bot_type FROM user_bots WHERE bot_name = $1', [appName]); if (localRec.rows.length > 0) { userId = localRec.rows[0].user_id; botType = localRec.rows[0].bot_type; } else { console.warn(`[DB-Backup] App "${appName}" not in local DB. Using ADMIN_ID.`); notFoundCount++; } const configRes = await herokuApi.get(`/apps/${appName}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }); const configVars = configRes.data; const sessionId = configVars.SESSION_ID || 'N/A'; await saveUserDeployment(userId, appName, sessionId, configVars, botType); console.log(`[DB-Backup] Backed up: ${appName} (Owner: ${userId})`); backedUpCount++; if (typeStats[botType]) typeStats[botType].backedUp.push(appName); else typeStats.unknown.backedUp.push(appName); } catch (error) { console.error(`[DB-Backup] Failed backup ${appName}:`, error.message); failedCount++; if (typeStats[botType]) typeStats[botType].failed.push(appName); else typeStats.unknown.failed.push(appName); } } const summary = `Backup complete! Processed ${herokuAppList.length} apps.`; console.log(`[DB-Backup] ${summary}`); return { success: true, message: summary, stats: typeStats, miscStats: { totalRelevantApps: herokuAppList.length, appsBackedUp: backedUpCount, appsNotFoundLocally: notFoundCount, appsFailed: failedCount, appsSkipped: 0 } };
}

async function createAllTablesInPool(dbPool, dbName) {
    console.log(`[DB-${dbName}] Checking/creating tables...`);
    const queries = [
        `CREATE TABLE IF NOT EXISTS user_bots (user_id TEXT NOT NULL, bot_name TEXT NOT NULL, session_id TEXT, bot_type TEXT DEFAULT 'levanter', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'online', PRIMARY KEY (user_id, bot_name));`,
        `ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP;`,
        `CREATE TABLE IF NOT EXISTS deploy_keys (key TEXT PRIMARY KEY, uses_left INTEGER NOT NULL, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `ALTER TABLE deploy_keys ADD COLUMN IF NOT EXISTS user_id TEXT;`,
        `CREATE TABLE IF NOT EXISTS temp_deploys (user_id TEXT PRIMARY KEY, last_deploy_at TIMESTAMP NOT NULL);`,
        `CREATE TABLE IF NOT EXISTS user_activity (user_id TEXT PRIMARY KEY, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `ALTER TABLE user_activity ADD COLUMN IF NOT EXISTS keyboard_version INTEGER DEFAULT 0;`,
        `CREATE TABLE IF NOT EXISTS banned_users (user_id TEXT PRIMARY KEY, banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, banned_by TEXT);`,
        `CREATE TABLE IF NOT EXISTS key_rewards (user_id TEXT PRIMARY KEY, reward_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS all_users_backup (user_id TEXT PRIMARY KEY, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, username TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS user_deployments (user_id TEXT NOT NULL, app_name TEXT NOT NULL, session_id TEXT, config_vars JSONB, bot_type TEXT, deploy_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TIMESTAMP, deleted_from_heroku_at TIMESTAMP, warning_sent_at TIMESTAMP, referred_by TEXT, ip_address TEXT, email TEXT, paused_at TIMESTAMP, PRIMARY KEY (user_id, app_name));`,
        `ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS is_free_trial BOOLEAN DEFAULT FALSE;`,
        `ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS email TEXT;`,
        `ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS referred_by TEXT;`,
        `ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS ip_address TEXT;`,
        `ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS paused_at TIMESTAMP;`,
        `CREATE TABLE IF NOT EXISTS free_trial_monitoring (user_id TEXT PRIMARY KEY, app_name TEXT NOT NULL, channel_id TEXT NOT NULL, trial_start_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, warning_sent_at TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS pending_payments (reference TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS bot_type TEXT;`,
        `ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS app_name TEXT, ADD COLUMN IF NOT EXISTS session_id TEXT;`,
        `CREATE TABLE IF NOT EXISTS completed_payments (reference TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, paid_at TIMESTAMP WITH TIME ZONE NOT NULL);`,
        `CREATE TABLE IF NOT EXISTS pinned_messages (message_id BIGINT PRIMARY KEY, chat_id TEXT NOT NULL, unpin_at TIMESTAMP WITH TIME ZONE NOT NULL);`,
        `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, data JSONB, expires_at TIMESTAMP WITH TIME ZONE);`,
        `CREATE TABLE IF NOT EXISTS user_referrals (referral_id SERIAL PRIMARY KEY, referred_user_id TEXT NOT NULL UNIQUE, inviter_user_id TEXT NOT NULL, bot_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, inviter_reward_pending BOOLEAN DEFAULT FALSE);`
    ];
    for (const query of queries) { await dbPool.query(query); }
    console.log(`[DB-${dbName}] Tables checked/created.`);
}

async function syncDatabases(sourcePool, targetPool) {
    const clientSource = await sourcePool.connect(); const clientTarget = await targetPool.connect(); try { await clientTarget.query('BEGIN'); const srcTablesRes = await clientSource.query(`SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename != 'sessions';`); const srcTableNames = srcTablesRes.rows.map(row => row.tablename); if (srcTableNames.length === 0) return { success: true, message: 'Source DB empty.' }; console.log('[Sync] Tables to clone:', srcTableNames); for (const t of srcTableNames) await clientTarget.query(`DROP TABLE IF EXISTS "${t}" CASCADE;`); for (const t of srcTableNames) { console.log(`[Sync] Cloning schema ${t}...`); const colsRes = await clientSource.query(`SELECT column_name, data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position;`, [t]); let createScript = `CREATE TABLE "${t}" (`; createScript += colsRes.rows.map(c => `"${c.column_name}" ${c.data_type}` + (c.character_maximum_length ? `(${c.character_maximum_length})` : '') + (c.is_nullable === 'NO' ? ' NOT NULL' : '')).join(', '); const pkeyRes = await clientSource.query(`SELECT conname, pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE contype = 'p' AND conrelid = '${t}'::regclass;`); if (pkeyRes.rows.length > 0) createScript += `, CONSTRAINT "${pkeyRes.rows[0].conname}" ${pkeyRes.rows[0].pg_get_constraintdef}`; createScript += ');'; await clientTarget.query(createScript); } for (const t of srcTableNames) { const { rows } = await clientSource.query(`SELECT * FROM "${t}";`); if (rows.length > 0) { const cols = Object.keys(rows[0]); const colNames = cols.map(c => `"${c}"`).join(', '); const placeholders = cols.map((_, i) => `$${i + 1}`).join(', '); const insertQ = `INSERT INTO "${t}" (${colNames}) VALUES (${placeholders});`; for (const r of rows) { const vals = cols.map(c => r[c]); await clientTarget.query(insertQ, vals); } console.log(`[Sync] Copied ${rows.length} rows to "${t}".`); } } await clientTarget.query('COMMIT'); return { success: true, message: `Cloned ${srcTableNames.length} tables.` }; } catch (error) { await clientTarget.query('ROLLBACK'); console.error('[Sync] DB sync failed:', error); return { success: false, message: `Sync failed: ${error.message}` }; } finally { clientSource.release(); clientTarget.release(); }
}

async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    console.log(`[404Handler] App "${appName}". Initiated by ${callingChatId}.`); let ownerUserId = await getUserIdByBotName(appName); if (!ownerUserId) { ownerUserId = callingChatId; console.warn(`[404Handler] Owner not found DB "${appName}". Using ${callingChatId}.`); } else console.log(`[404Handler] Found owner ${ownerUserId} DB "${appName}".`); await deleteUserBot(ownerUserId, appName); await markDeploymentDeletedFromHeroku(ownerUserId, appName); console.log(`[404Handler] Removed "${appName}" DBs user "${ownerUserId}".`); const message = `App "${escapeMarkdown(appName)}" not found on Heroku. Removed from list.`; const targetId = originalMessageId ? callingChatId : ownerUserId; if (originalMessageId) await bot.editMessageText(message, { chat_id: targetId, message_id: originalMessageId, parse_mode: 'Markdown' }).catch(e => console.error(`404 edit msg fail: ${e.message}`)); else await bot.sendMessage(targetId, message, { parse_mode: 'Markdown' }).catch(e => console.error(`404 send msg fail: ${e.message}`)); if (isUserFacing && ownerUserId !== callingChatId) await bot.sendMessage(ownerUserId, `Bot "*${escapeMarkdown(appName)}*" not found on Heroku. Removed by admin.`, { parse_mode: 'Markdown' }).catch(e => console.error(`404 owner notify fail: ${e.message}`));
}

async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserId = null, isRemoval = false) {
    try { const res = await herokuApi.get('/apps', { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }); const apps = res.data.map(a => a.name); if (!apps.length) { if (messageId) return bot.editMessageText('No apps found.', { chat_id: chatId, message_id: messageId }); return bot.sendMessage(chatId, 'No apps found.'); } const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size)); const rows = chunk(apps, 3).map(r => r.map(n => ({ text: n, callback_data: `${callbackPrefix}:${n}${targetUserId ? `:${targetUserId}` : ''}` }))); const message = `Total apps: ${apps.length}\nSelect app:`; if (messageId) await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }); else await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: rows } }); } catch (e) { const errorMsg = `Error fetch apps: ${e.response?.data?.message || e.message}`; if (e.response?.status === 401) { console.error(`Heroku key invalid. User: ${chatId}`); if (messageId) bot.editMessageText("Heroku API key invalid. Contact admin.", { chat_id: chatId, message_id: messageId }); else bot.sendMessage(chatId, "Heroku API key invalid. Contact admin."); } else { if (messageId) bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId }); else bot.sendMessage(chatId, errorMsg); } }
}


// ❗️❗️ REPLACED FUNCTION with ownerId fix ❗️❗️
async function buildWithProgress(ownerId, vars, isFreeTrial = false, isRestore = false, botType, inviterId = null) {
  let name = vars.APP_NAME;
  const originalName = name; // The name from the backup DB
  const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
  const botTypeSpecificDefaults = defaultEnvVars[botType] || {};
  let buildResult = false;
  // Send progress to Admin who initiated the restore/build
  const createMsg = sendAnimatedMessage
    ? await sendAnimatedMessage(ADMIN_ID, 'Creating application')
    : await bot.sendMessage(ADMIN_ID, 'Creating application...');

  try {
    // Message updates go to the admin
    await bot.editMessageText('Creating application...', { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
    const createMsgAnimate = animateMessage ? await animateMessage(ADMIN_ID, createMsg.message_id, 'Creating application') : null;

    if (isRestore) {
        let newName = originalName;
        const endsWithNumber = /-\d+$/;
        if (endsWithNumber.test(newName)) {
            const prefix = newName.replace(/-\d+$/, '');
            const newSuffix = `-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
            newName = `${prefix}${newSuffix}`;
        } else {
            const newSuffix = `-${Math.floor(Math.random() * 9999).toString().padStart(4, '0')}`;
            newName = `${newName.substring(0, 30 - newSuffix.length)}${newSuffix}`;
        }
        name = newName.toLowerCase(); // 'name' is now the NEW unique name
        vars.APP_NAME = name; // Update vars with the new name
        console.log(`[Restore] App '${originalName}' restoring as new name: "${name}".`);
        await bot.editMessageText(`Restoring app '${originalName}' as new name: "${name}"...`, { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
    }

    // Create the app with the new name
    await herokuApi.post('https://api.heroku.com/apps', { name }, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
    });
    if (createMsgAnimate) clearInterval(createMsgAnimate);

    await bot.editMessageText('Configuring resources...', { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
    const configMsgAnimate = animateMessage ? await animateMessage(ADMIN_ID, createMsg.message_id, 'Configuring resources') : null;

    // Add Postgres addon
    await herokuApi.post(`/apps/${name}/addons`, { plan: 'heroku-postgresql' }, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' }
    });

    // Add buildpacks
    await herokuApi.put(`/apps/${name}/buildpack-installations`, {
        updates: [
          { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
          { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
          { buildpack: 'heroku/nodejs' }
        ]
      }, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' }
    });
    if (configMsgAnimate) clearInterval(configMsgAnimate);

    await bot.editMessageText('Setting environment variables...', { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
    const varsMsgAnimate = animateMessage ? await animateMessage(ADMIN_ID, createMsg.message_id, 'Setting environment variables') : null;

    // Filter and merge config vars (use only provided vars for restore)
    const filteredVars = {};
    for (const key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && String(vars[key]).trim() !== '') {
            filteredVars[key] = vars[key];
        }
    }
    const finalConfigVars = isRestore ? filteredVars : { ...botTypeSpecificDefaults, ...filteredVars };

    // Set config vars, ensuring APP_NAME is the new name
    await herokuApi.patch(`/apps/${name}/config-vars`, { ...finalConfigVars, APP_NAME: name }, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' }
    });
    if (varsMsgAnimate) clearInterval(varsMsgAnimate);

    // Start the build
    await bot.editMessageText(`Starting build process for ${name}...`, { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
    const bres = await axios.post(`/apps/${name}/builds`,
      { source_blob: { url: `${githubRepoUrl}/tarball/main` } },
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
    );

    // --- Build Polling/Waiting Logic ---
    let buildStatus;
    if (botType === 'raganork') { // Simulate Raganork build time
        console.log(`[Build] Simulating build for Raganork app: ${name}`);
        buildStatus = 'pending';
        await new Promise(resolve => {
            const buildDuration = 72000; const updateInterval = 1500; let elapsedTime = 0;
            const simInt = setInterval(async () => {
                elapsedTime += updateInterval; const pct = Math.min(100, Math.floor((elapsedTime / buildDuration) * 100));
                try { await bot.editMessageText(`Building ${name}... ${pct}%`, { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{}); } catch (e) { if (!e.message.includes('not modified')) console.error("Sim build msg error:", e.message); }
                if (elapsedTime >= buildDuration) { clearInterval(simInt); buildStatus = 'succeeded'; resolve(); }
            }, updateInterval);
        });
    } else { // Poll actual Heroku build status
        const statusUrl = `/apps/${name}/builds/${bres.data.id}`;
        buildStatus = 'pending'; let currentPct = 0; let buildProgressInterval;
        try {
            buildProgressInterval = setInterval(async () => {
                try {
                    const poll = await herokuApi.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    buildStatus = poll.data.status;
                    if (buildStatus === 'pending') currentPct = Math.min(99, currentPct + Math.floor(Math.random() * 5) + 1);
                    else if (buildStatus === 'succeeded') currentPct = 100;
                    else if (buildStatus === 'failed') currentPct = 'Error';
                    await bot.editMessageText(`Building ${name}... ${currentPct}%`, { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
                    if (buildStatus !== 'pending' || currentPct === 100 || currentPct === 'Error') if (buildProgressInterval) clearInterval(buildProgressInterval);
                } catch (error) {
                    console.error(`Error polling build status for ${name}:`, error.message);
                    if (buildProgressInterval) clearInterval(buildProgressInterval);
                    await bot.editMessageText(`Building ${name}... Error`, { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
                    buildStatus = 'error';
                }
            }, 5000);
            const BUILD_COMPLETION_TIMEOUT = 600 * 1000; // Increased to 10 minutes
            let completionTimeoutId = setTimeout(() => { if (buildProgressInterval) clearInterval(buildProgressInterval); buildStatus = 'timed out'; throw new Error(`Build timed out after ${BUILD_COMPLETION_TIMEOUT / 1000}s.`); }, BUILD_COMPLETION_TIMEOUT);
            while (buildStatus === 'pending') await new Promise(r => setTimeout(r, 5000));
            clearTimeout(completionTimeoutId); if (buildProgressInterval) clearInterval(buildProgressInterval);
        } catch (err) {
            if (buildProgressInterval) clearInterval(buildProgressInterval);
            await bot.editMessageText(`Build process for "${name}" timed out or failed. Check Heroku logs.`, { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{});
            buildResult = false;
            return { success: buildResult, newAppName: name }; // Return failure object
        }
    }
    // --- End Build Polling ---

    // --- Process Build Result ---
    if (buildStatus === 'succeeded') {
        console.log(`[Flow] Build SUCCEEDED for "${name}".`);
        buildResult = true; // Mark as success for now

        // ❗️❗️ THIS IS THE CORRECTED RESTORE LOGIC with ownerId ❗️❗️
        if (isRestore) {
            let expirationDateToUse = null;
            let dynoType = 'web';

            // 'name' = new name, 'originalName' = old name from vars
            // 'ownerId' is the ORIGINAL owner ID passed into this function

            if (name !== originalName) {
                try {
                    // 1. Get expiration date using ORIGINAL ownerId
                    const originalDeploymentResult = await pool.query('SELECT expiration_date FROM user_deployments WHERE user_id = $1 AND app_name = $2', [ownerId, originalName]);
                    const originalDeployment = originalDeploymentResult.rows[0];
                    if (originalDeployment) {
                        expirationDateToUse = originalDeployment.expiration_date;
                        console.log(`[Expiration Fix] Found expiration date ${expirationDateToUse} from ${originalName} for owner ${ownerId}.`);
                    } else {
                        console.warn(`[Expiration Fix] Could not find original record for ${originalName} / owner ${ownerId}.`);
                    }

                    // 2. Delete old deployment record using ORIGINAL ownerId
                    await pool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2', [ownerId, originalName]);
                    console.log(`[DB Cleanup] Deleted old user_deployments record for ${originalName} / owner ${ownerId}.`);

                    // 3. Rename bot in user_bots table using ORIGINAL ownerId
                    await pool.query('UPDATE user_bots SET bot_name = $1, session_id = $2 WHERE user_id = $3 AND bot_name = $4', [name, vars.SESSION_ID, ownerId, originalName]);
                    console.log(`[DB Rename Fix] Renamed bot in user_bots from "${originalName}" to "${name}" for owner ${ownerId}.`);

                } catch (dbError) {
                    console.error(`[Restore DB-Cleanup] Error during DB rename/delete for ${originalName} / owner ${ownerId}:`, dbError.message);
                }
            } else { // Name didn't change (rare)
                try {
                    const originalDeploymentResult = await pool.query('SELECT expiration_date FROM user_deployments WHERE user_id = $1 AND app_name = $2', [ownerId, originalName]);
                    if (originalDeploymentResult.rows.length > 0) expirationDateToUse = originalDeploymentResult.rows[0].expiration_date;
                } catch (fetchError) { console.error(`[Restore DB-Fetch] Error fetching original expiration for ${originalName} / owner ${ownerId}:`, fetchError.message); }
                await addUserBot(ownerId, name, vars.SESSION_ID, botType); // Ensure user_bots is correct
            }

            // Scale dyno to 0 BEFORE data restore
            try {
                console.log(`[Restore] Trying 'web' dyno 0 for "${name}"...`);
                await herokuApi.patch(`/apps/${name}/formation/web`, { quantity: 0 }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}` } });
                console.log(`[Restore] Scaled 'web' dyno 0.`);
            } catch (webError) {
                try {
                    console.warn(`[Restore] Scale 'web' failed, trying 'worker'...`);
                    await herokuApi.patch(`/apps/${name}/formation/worker`, { quantity: 0 }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}` } });
                    dynoType = 'worker';
                    console.log(`[Restore] Scaled 'worker' dyno 0.`);
                } catch (workerError) { console.warn(`[Restore] Could not scale any dyno for "${name}" to 0.`); }
            }

            // Save the NEW app record using ORIGINAL ownerId and saved expirationDate
            const herokuConfigVars = (await herokuApi.get(`/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;
            await saveUserDeployment(ownerId, name, vars.SESSION_ID, herokuConfigVars, botType, isFreeTrial, expirationDateToUse);

            // Notify admin
            await bot.editMessageText(
                `Restore Phase 1 complete for *${escapeMarkdown(name)}* (Owner: \`${ownerId}\`). Proceeding to data copy...`,
                { chat_id: ADMIN_ID, message_id: createMsg.message_id, parse_mode: 'Markdown' }
            ).catch(()=>{ /* ignore */ });

            return { success: true, newAppName: name, dynoType: dynoType };
        }
        // ❗️❗️ END OF CORRECTED RESTORE LOGIC ❗️❗️

        // --- Logic for regular (non-restore) builds ---
        // Uses ownerId (passed as chatId in non-restore calls)
        await addUserBot(ownerId, name, vars.SESSION_ID, botType);
        const herokuConfigVars = (await axios.get(`/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;

        let expirationDate = null;
        if (vars.DAYS) { expirationDate = new Date(); expirationDate.setDate(expirationDate.getDate() + parseInt(vars.DAYS, 10)); }
        else if (isFreeTrial) { expirationDate = new Date(); expirationDate.setDate(expirationDate.getDate() + 3); } // Shortened free trial

        await saveUserDeployment(ownerId, name, vars.SESSION_ID, herokuConfigVars, botType, isFreeTrial, expirationDate, vars.email);

        if (isFreeTrial) await recordFreeTrialDeploy(ownerId);

        // Reward logic
        try {
            const userBotCount = await getUserBotCount(ownerId);
            const userHasReceivedReward = await hasReceivedReward(ownerId);
            if (userBotCount >= 10 && !userHasReceivedReward) {
                 // Define generateKey() or import it
                // const newKey = generateKey();
                // await addDeployKey(newKey, 1, 'AUTOMATIC_REWARD', ownerId);
                // await recordReward(ownerId);
                // ... send messages ...
            }
        } catch (rewardError) { console.error(`[Reward] Failed check/issue for user ${ownerId}:`, rewardError.message); }

        // Admin notification
        const userChat = await bot.getChat(ownerId).catch(() => ({ from: {} }));
        const { first_name = '', last_name = '', username = 'N/A' } = userChat.from || {};
        const userDetails = `*Name:* ${escapeMarkdown(first_name)} ${escapeMarkdown(last_name)}\n*Username:* @${escapeMarkdown(username)}\n*Chat ID:* \`${escapeMarkdown(ownerId)}\``;
        const appDetails = `*App:* \`${escapeMarkdown(name)}\`\n*Session:* \`${escapeMarkdown(vars.SESSION_ID)}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;
        await bot.sendMessage(ADMIN_ID, `*New App Deployed*\n\n*Details:*\n${appDetails}\n\n*By:*\n${userDetails}`, { parse_mode: 'Markdown', disable_web_page_preview: true });

        // Wait for bot connection (Notify owner via ownerId)
        const baseWaitingText = `Build successful! Waiting for bot '${name}' to connect...`;
        // Send initial waiting message to the actual owner
        const ownerWaitMsg = await bot.sendMessage(ownerId, baseWaitingText, { parse_mode: 'Markdown'}).catch(()=>{});
        const animateIntervalId = animateMessage && ownerWaitMsg ? await animateMessage(ownerId, ownerWaitMsg.message_id, baseWaitingText) : null;


        const appStatusPromise = new Promise((resolve, reject) => {
            const STATUS_CHECK_TIMEOUT = 120 * 1000;
            const timeoutId = setTimeout(() => { const p = appDeploymentPromises.get(name); if (p) { p.reject(new Error(`Bot timeout (${STATUS_CHECK_TIMEOUT/1000}s)`)); appDeploymentPromises.delete(name); } }, STATUS_CHECK_TIMEOUT);
            appDeploymentPromises.set(name, { resolve, reject, animateIntervalId, timeoutId, ownerMessageId: ownerWaitMsg?.message_id }); // Store owner msg ID
        });

        try {
            await appStatusPromise; // Wait for the bot to signal it's online
            const pData = appDeploymentPromises.get(name);
            if (pData?.timeoutId) clearTimeout(pData.timeoutId);
            if (animateIntervalId) clearInterval(animateIntervalId);
             // Edit the owner's message
            if (pData?.ownerMessageId) {
                await bot.editMessageText(`Bot *${escapeMarkdown(name)}* is live!`, { chat_id: ownerId, message_id: pData.ownerMessageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `Backup "${name}"`, callback_data: `backup_app:${name}` }]] } }).catch(()=>{});
            } else {
                 await bot.sendMessage(ownerId, `Bot *${escapeMarkdown(name)}* is live!`, {parse_mode: 'Markdown'}).catch(()=>{});
            }
            buildResult = true;

            // Referral logic
            if (inviterId && !isRestore) {
                console.log(`[Referral] Processing referral for new user ${ownerId} by inviter ${inviterId}`);
                await grantReferralRewards(ownerId, name);
            }

            // Free trial timers
            if (isFreeTrial) {
                 await recordFreeTrialForMonitoring(ownerId, name, TELEGRAM_CHANNEL_ID);
                 const TRIAL_DURATION_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
                 const ONE_HOUR_IN_MS = 1 * 60 * 60 * 1000;
                 // Admin warning timer
                 setTimeout(async () => {
                     const adminWarnMsg = `Free Trial "*${escapeMarkdown(name)}*" (User: ${ownerId}) ends in 1 hour!`;
                     const kb = { inline_keyboard: [[{ text: `Delete Now`, callback_data: `admin_delete_trial_app:${name}` }]] };
                     await bot.sendMessage(ADMIN_ID, adminWarnMsg, { reply_markup: kb, parse_mode: 'Markdown' }).catch(()=>{});
                     console.log(`[FreeTrial] Sent 1-hour warn admin ${name}.`);
                 }, TRIAL_DURATION_MS - ONE_HOUR_IN_MS);
                 // Auto-delete timer
                 setTimeout(async () => {
                     try {
                         await bot.sendMessage(ownerId, `Free Trial "*${escapeMarkdown(name)}*" ended & is being deleted.`);
                         await herokuApi.delete(`/apps/${name}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                         await deleteUserBot(ownerId, name);
                         await markDeploymentDeletedFromHeroku(ownerId, name);
                         await bot.sendMessage(ownerId, `Free Trial "*${escapeMarkdown(name)}*" deleted.`);
                         console.log(`[FreeTrial] Auto-deleted ${name} user ${ownerId}.`);
                     } catch (e) {
                         console.error(`Failed auto-delete free trial ${name}:`, e.message);
                         await bot.sendMessage(ownerId, `Could not auto-delete "*${escapeMarkdown(name)}*". Please delete manually.`, {parse_mode: 'Markdown'}).catch(()=>{});
                         if (monitorSendTelegramAlert) monitorSendTelegramAlert(`Failed auto-delete free trial "*${escapeMarkdown(name)}*" user ${escapeMarkdown(ownerId)}: ${escapeMarkdown(e.message)}`, ADMIN_ID);
                     } finally {
                        await removeMonitoredFreeTrial(ownerId); // Clean up monitoring record
                     }
                 }, TRIAL_DURATION_MS);
            }
        } catch (err) { // Catch bot connection timeout/error
            const pData = appDeploymentPromises.get(name);
            if (pData) { if (pData.animateIntervalId) clearInterval(pData.animateIntervalId); if (pData.timeoutId) clearTimeout(pData.timeoutId); }
            console.error(`App status check failed for ${name}:`, err.message);
            // Edit the owner's message
            if (pData?.ownerMessageId) {
                await bot.editMessageText(`Bot *${escapeMarkdown(name)}* failed start: ${escapeMarkdown(err.message)}\nUpdate session?`, { chat_id: ownerId, message_id: pData.ownerMessageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${name}:${ownerId}` }]] } }).catch(()=>{});
            } else {
                 await bot.sendMessage(ownerId, `Bot *${escapeMarkdown(name)}* failed start: ${escapeMarkdown(err.message)}\nUpdate session?`, {parse_mode: 'Markdown'}).catch(()=>{});
            }
            buildResult = false;
        } finally { appDeploymentPromises.delete(name); }
        // --- End non-restore logic ---

    } else { // Build failed or errored out
        await bot.editMessageText(`Build for ${name} failed: ${buildStatus}. Contact Admin.`, { chat_id: ADMIN_ID, message_id: createMsg.message_id }).catch(()=>{}); // Notify admin
        buildResult = false;
    }

  } catch (error) { // Catch errors during app creation/config/build start
    const errorMsg = error.response?.data?.message || error.message;
    console.error(`[Build] CRITICAL error during build setup for ${name}:`, errorMsg, error.stack);
    await bot.sendMessage(ADMIN_ID, `Build setup error for ${name}: ${escapeMarkdown(errorMsg)}`, {parse_mode: 'Markdown'}).catch(()=>{}); // Notify admin
    // Clean up potentially created app if possible
    try { await herokuApi.delete(`/apps/${name}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}` } }); console.log(`[Build Cleanup] Deleted failed app ${name}.`); } catch (cleanupError) { /* Ignore */ }
    buildResult = false;
  }

  // Final return object
  return { success: buildResult, newAppName: name };
}
// ❗️❗️ END OF REPLACED FUNCTION ❗️❗️


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
    restoreHerokuDbFromRenderSchema,
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
    backupHerokuDbToRenderSchema,
    removeMonitoredFreeTrial,
    syncDatabases,
    createAllTablesInPool,
    syncDatabaseWithHeroku,
    reconcileDatabaseWithHeroku,
    getExpiringBackups,
    setBackupWarningSent,
    getExpiredBackups
};
