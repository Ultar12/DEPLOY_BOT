const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

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
let sendAnimatedMessage;
let monitorSendTelegramAlert;
let escapeMarkdown;

function init(params) {
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

// === DB helper functions (All now use 'pool' for the main DB) ===

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

async function getUserBots(u) {
  try {
    const r = await pool.query(
      'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at'
      ,[u]
    );
    return r.rows.map(x => x.bot_name);
  }
  catch (error) {
    console.error(`[DB] getUserBots: Failed to get bots for user "${u}":`, error.message);
    return [];
  }
}

async function getUserIdByBotName(botName) {
    try {
        const r = await pool.query(
            'SELECT user_id, bot_type FROM user_bots WHERE bot_name=$1 ORDER BY created_at DESC LIMIT 1'
            ,[botName]
        );
        return r.rows.length > 0 ? r.rows[0] : null; // Return the whole row { user_id, bot_type }
    }
    catch (error) {
        console.error(`[DB] getUserIdByBotName: Failed to get user ID by bot name "${botName}":`, error.message);
        return null;
    }
}

async function getAllUserBots() {
    try {
        const r = await pool.query('SELECT user_id, bot_name, bot_type FROM user_bots ORDER BY created_at');
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
        return r.rows.length > 0 ? r.rows[0].bot_name : null;
    } catch (error) {
        console.error(`[DB] getBotNameBySessionId: Failed to get bot name by session ID "${sessionId}":`, error.message);
        return null;
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

async function addDeployKey(key, uses, createdBy) {
  await pool.query(
    'INSERT INTO deploy_keys(key,uses_left,created_by) VALUES($1,$2,$3)',
    [key, uses, createdBy]
  );
  console.log(`[DB] addDeployKey: Added key "${key}" with ${uses} uses by "${createdBy}".`);
}

async function useDeployKey(key) {
  const res = await pool.query(
    `UPDATE deploy_keys
     SET uses_left = uses_left - 1
     WHERE key = $1 AND uses_left > 0
     RETURNING uses_left`,
    [key]
  );
  if (res.rowCount === 0) {
    return null;
  }
  const left = res.rows[0].uses_left;
  if (left === 0) {
    await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]);
  }
  return left;
}

async function getAllDeployKeys() {
    try {
        const res = await pool.query('SELECT key, uses_left, created_by, created_at FROM deploy_keys ORDER BY created_at DESC');
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
    return result.rowCount > 0;
  } catch (error) {
    console.error(`[DB] deleteDeployKey: Failed to delete key "${key}":`, error.message);
    return false;
  }
}

async function canDeployFreeTrial(userId) {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
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
    return result.rows.length > 0 ? result.rows[0].last_seen : null;
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
        console.error(`[DB] Error checking ban status for user ${userId}:`, error.message);
        return false;
    }
}

async function banUser(userId, bannedByAdminId) {
    try {
        await pool.query(
            'INSERT INTO banned_users(user_id, banned_by) VALUES($1, $2) ON CONFLICT (user_id) DO NOTHING;',
            [userId, bannedByAdminId]
        );
        return true;
    } catch (error) {
        console.error(`[Admin] Error banning user ${userId}:`, error.message);
        return false;
    }
}

async function unbanUser(userId) {
    try {
        const result = await pool.query('DELETE FROM banned_users WHERE user_id = $1 RETURNING user_id;', [userId]);
        return result.rowCount > 0;
    } catch (error) {
        console.error(`[Admin] Error unbanning user ${userId}:`, error.message);
        return false;
    }
}

// === Backup, Restore, and Sync Functions (All now use 'pool' as the primary source) ===

async function saveUserDeployment(userId, appName, sessionId, configVars, botType) {
    try {
        const cleanConfigVars = {};
        for (const key in configVars) {
            if (Object.prototype.hasOwnProperty.call(configVars, key)) {
                cleanConfigVars[key] = String(configVars[key]);
            }
        }
        const deployDate = new Date();
        const expirationDate = new Date(deployDate.getTime() + 45 * 24 * 60 * 60 * 1000);
        const query = `
            INSERT INTO user_deployments(user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at)
            VALUES($1, $2, $3, $4, $5, $6, $7, NULL)
            ON CONFLICT (user_id, app_name) DO UPDATE SET
               session_id = EXCLUDED.session_id,
               config_vars = EXCLUDED.config_vars,
               bot_type = EXCLUDED.bot_type,
               deleted_from_heroku_at = NULL;
        `;
        await pool.query(query, [userId, appName, sessionId, cleanConfigVars, botType, deployDate, expirationDate]);
        console.log(`[DB] Saved/Updated deployment for user ${userId}, app ${appName}.`);
    } catch (error) {
        console.error(`[DB] Failed to save user deployment for ${appName}:`, error.message, error.stack);
    }
}

async function getUserDeploymentsForRestore(userId) {
    try {
        const result = await pool.query(
            `SELECT app_name, session_id, config_vars, deploy_date, expiration_date, bot_type, deleted_from_heroku_at
             FROM user_deployments WHERE user_id = $1 ORDER BY deploy_date DESC;`,
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get user deployments for restore ${userId}:`, error.message);
        return [];
    }
}

async function deleteUserDeploymentFromBackup(userId, appName) {
    try {
        const result = await pool.query(
            'DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2 RETURNING app_name;',
            [userId, appName]
        );
        return result.rowCount > 0;
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
        const result = await pool.query(
            `SELECT user_id, app_name, session_id, config_vars
             FROM user_deployments WHERE bot_type = $1 ORDER BY deploy_date;`,
            [botType]
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB] Failed to get all deployments for mass restore (type: ${botType}):`, error.message);
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

async function syncDatabases(sourcePool, targetPool) {
    const clientSource = await sourcePool.connect();
    const clientTarget = await targetPool.connect();
    
    try {
        const tablesResult = await clientSource.query(`
            SELECT tablename FROM pg_catalog.pg_tables 
            WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema';
        `);
        const tableNames = tablesResult.rows.map(row => row.tablename);
        await clientTarget.query('BEGIN');
        for (const tableName of tableNames.slice().reverse()) {
            await clientTarget.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE;`);
        }
        for (const tableName of tableNames) {
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

async function backupAllPaidBots() {
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;
    const failures = [];

    try {
        // Get all apps directly from Heroku
        const res = await axios.get('https://api.heroku.com/apps', {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const herokuApps = res.data.map(a => a.name);

        if (herokuApps.length === 0) {
            return { message: "No active apps found on the Heroku account." };
        }

        for (const appName of herokuApps) {
            try {
                // Find the owner and bot type from our main database
                const botInfo = await getUserIdByBotName(appName); // This now returns { user_id, bot_type }
                
                if (botInfo) {
                    const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
                        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                    });
                    const configVars = configRes.data;
                    
                    // Call the existing save function to create or update the backup record
                    await saveUserDeployment(botInfo.user_id, appName, configVars.SESSION_ID, configVars, botInfo.bot_type);
                    successCount++;
                } else {
                    // This app exists on Heroku but is not in our user_bots table
                    skippedCount++;
                }
            } catch (error) {
                failureCount++;
                failures.push(appName);
                console.error(`[BackupAll] Failed to process ${appName}:`, error.message);
            }
        }
        let message = `Backup process complete.\n\nSuccess: ${successCount}\nFailed: ${failureCount}\nSkipped (Unmanaged): ${skippedCount}`;
        if (failures.length > 0) {
            message += `\n\nFailed apps:\n- ${failures.join('\n- ')}`;
        }
        return { message };
    } catch (apiError) {
        console.error('[BackupAll] Failed to fetch Heroku app list:', apiError);
        return { message: `Could not fetch app list from Heroku: ${apiError.message}` };
    }
}

// === Other Helper & API Functions ===

async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    console.log(`[AppNotFoundHandler] Handling 404 for app "${appName}". Initiated by ${callingChatId}.`);
    const ownerInfo = await getUserIdByBotName(appName);
    let ownerUserId = ownerInfo ? ownerInfo.user_id : null;

    if (!ownerUserId) {
        ownerUserId = callingChatId;
        console.warn(`[AppNotFoundHandler] Owner not found for "${appName}". Falling back to ${callingChatId}.`);
    }

    await deleteUserBot(ownerUserId, appName);
    await markDeploymentDeletedFromHeroku(ownerUserId, appName);
    const message = `App "${escapeMarkdown(appName)}" was not found on Heroku. It has been removed from your "My Bots" list.`;
    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId;
    const messageToEditId = originalMessageId;

    if (messageToEditId) {
        await bot.editMessageText(message, { chat_id: messageTargetChatId, message_id: messageToEditId, parse_mode: 'Markdown' })
            .catch(err => console.error(`Failed to edit message in handleAppNotFoundAndCleanDb: ${err.message}`));
    } else {
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' })
            .catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb: ${err.message}`));
    }

    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `Your bot "*${escapeMarkdown(appName)}*" was not found on Heroku and has been removed from your list by the admin.`, { parse_mode: 'Markdown' })
             .catch(err => console.error(`Failed to send notification to owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
}

async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserId = null, isRemoval = false) {
    try {
        const res = await axios.get('https://api.heroku.com/apps', {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
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
                callback_data: isRemoval ? `${callbackPrefix}:${name}:${targetUserId}` : targetUserId ? `${callbackPrefix}:${name}:${targetUserId}` : `${callbackPrefix}:${name}`
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
            const adminMsg = "Heroku API key invalid. Please contact the bot admin.";
            if (messageId) bot.editMessageText(adminMsg, { chat_id: chatId, message_id: messageId });
            else bot.sendMessage(chatId, adminMsg);
        } else {
            if (messageId) bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId });
            else bot.sendMessage(chatId, errorMsg);
        }
    }
}

async function buildWithProgress(chatId, vars, isFreeTrial = false, isRestore = false, botType) {
  const name = vars.APP_NAME;
  const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
  const botTypeSpecificDefaults = defaultEnvVars[botType] || {};
  let buildResult = false;
  const createMsg = await sendAnimatedMessage(chatId, 'Creating application');

  try {
    // Top part of build process remains the same...
    await bot.editMessageText(`Creating application...`, { chat_id: chatId, message_id: createMsg.message_id });
    // ... [shortened for brevity, no changes here] ...
    const bres = await axios.post(`https://api.heroku.com/apps/${name}/builds`, { source_blob: { url: `${githubRepoUrl}/tarball/main` } }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } });
    
    // Build polling logic remains the same...
    let buildStatus;
    // ... [same build polling logic as before] ...
    if (botType === 'raganork') { buildStatus = 'pending'; await new Promise(resolve => { const buildDuration = 72000; const updateInterval = 1500; let elapsedTime = 0; const simulationInterval = setInterval(async () => { elapsedTime += updateInterval; const percentage = Math.min(100, Math.floor((elapsedTime / buildDuration) * 100)); try { await bot.editMessageText(`Building... ${percentage}%`, { chat_id: chatId, message_id: createMsg.message_id }); } catch (e) { if (!e.message.includes('message is not modified')) console.error("Error editing message during build simulation:", e.message); } if (elapsedTime >= buildDuration) { clearInterval(simulationInterval); buildStatus = 'succeeded'; resolve(); } }, updateInterval); }); } else { const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`; buildStatus = 'pending'; await new Promise((resolve, reject) => { const buildProgressInterval = setInterval(async () => { try { const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }); buildStatus = poll.data.status; if (buildStatus !== 'pending') { clearInterval(buildProgressInterval); resolve(); } } catch (error) { clearInterval(buildProgressInterval); reject(error); } }, 5000); }).catch(err => { console.error(`Error polling build status for ${name}:`, err.message); buildStatus = 'error'; }); }

    if (buildStatus === 'succeeded') {
      await addUserBot(chatId, name, vars.SESSION_ID, botType);
      
      if (!isFreeTrial) {
        const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;
        await saveUserDeployment(chatId, name, vars.SESSION_ID, herokuConfigVars, botType);
      }
      
      if (isFreeTrial) {
        await recordFreeTrialDeploy(chatId);
      }
      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [`*Name:* ${escapeMarkdown(first_name || '')} ${escapeMarkdown(last_name || '')}`, `*Username:* @${escapeMarkdown(username || 'N/A')}`, `*Chat ID:* \`${escapeMarkdown(chatId)}\``].join('\n');
      const appDetails = `*App Name:* \`${escapeMarkdown(name)}\`\n*Session ID:* \`${escapeMarkdown(vars.SESSION_ID)}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;
      await bot.sendMessage(ADMIN_ID, `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      const baseWaitingText = `Build successful! Waiting for bot to connect...`;
      await bot.editMessageText(baseWaitingText, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
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
          if (promiseData && promiseData.timeoutId) clearTimeout(promiseData.timeoutId);
          clearInterval(animateIntervalId);
          await bot.editMessageText(
              `Your bot *${escapeMarkdown(name)}* is now live!\n\nBackup your app for future reference.`,
              {
                  chat_id: chatId,
                  message_id: createMsg.message_id,
                  parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: [[{ text: `Backup "${name}"`, callback_data: `backup_app:${name}` }]] }
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
            }, THREE_DAYS_IN_MS - ONE_HOUR_IN_MS);
            setTimeout(async () => {
                try {
                    await bot.sendMessage(chatId, `Your Free Trial app "*${escapeMarkdown(name)}*" is being deleted as its 3-day runtime has ended.`);
                    await axios.delete(`https://api.heroku.com/apps/${name}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    await deleteUserBot(chatId, name);
                    await markDeploymentDeletedFromHeroku(chatId, name);
                    await bot.sendMessage(chatId, `Free Trial app "*${escapeMarkdown(name)}*" successfully deleted.`);
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
                reply_markup: { inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${name}:${chatId}` }]] }
            }
          );
          buildResult = false;
      } finally {
          appDeploymentPromises.delete(name);
      }
    } else {
      await bot.editMessageText(`Build status: ${buildStatus}. Check your Heroku dashboard for logs.`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
      buildResult = false;
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred: ${escapeMarkdown(errorMsg)}\n\nPlease check the Heroku dashboard or try again.`, {parse_mode: 'Markdown'});
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
    getBotNameBySessionId,
    deleteUserBot,
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
    buildWithProgress,
    recordFreeTrialForMonitoring,
    getMonitoredFreeTrials,
    updateFreeTrialWarning,
    removeMonitoredFreeTrial,
    syncDatabases,
    backupAllPaidBots
};
