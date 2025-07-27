// bot_services.js

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
    defaultEnvVars = params.defaultEnvVars; // This is now an object for each bot type
    appDeploymentPromises = params.appDeploymentPromises;
    RESTART_DELAY_MINUTES = params.RESTART_DELAY_MINUTES;
    getAnimatedEmoji = params.getAnimatedEmoji;
    animateMessage = params.animateMessage;
    sendAnimatedMessage = params.sendAnimatedMessage;
    monitorSendTelegramAlert = params.monitorSendTelegramAlert;
    escapeMarkdown = params.escapeMarkdown; // Assign the utility function

    console.log('--- bot_services.js initialized! ---');
}

// === DB helper functions (using 'pool' for main DB) ===

async function addUserBot(u, b, s, botType) { // Added botType
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
      console.warn(`[DB] addUserBot: Insert/update operation for bot "${b}" for user "${u}" did not return a row. This might indicate an horrific issue.`);
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
    console.log(`[DB] getUserBots: Fetching for user_id "${u}" - Found:`, r.rows.map(x => x.bot_name));
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
        // Also fetches bot_type for categorization
        const r = await pool.query('SELECT user_id, bot_name, bot_type FROM user_bots ORDER BY created_at');
        console.log(`[DB] getAllUserBots: Fetched ${r.rows.length} bots with their types.`);
        return r.rows; // Returns [{user_id, bot_name, bot_type}, ...]
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
    console.log(`[DB] useDeployKey: Key "${key}" not found or no uses left.`);
    return null;
  }
  const left = res.rows[0].uses_left;
  if (left === 0) {
    await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]);
    console.log(`[DB] useDeployKey: Key "${key}" fully used and deleted.`);
  } else {
    console.log(`[DB] useDeployKey: Key "${key}" used. ${left} uses left.`);
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
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const res = await pool.query(
        'SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1',
        [userId]
    );
    if (res.rows.length === 0) return { can: true };
    const lastDeploy = new Date(res.rows[0].last_deploy_at);
    if (lastDeploy < fourteenDaysAgo) return { can: true };

    const nextAvailable = new Date(lastDeploy.getTime() + 14 * 24 * 60 * 60 * 1000);
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

// --- CHANGE 1: This function now ONLY saves to the main database ---
async function updateUserActivity(userId) {
  try {
    await pool.query(
      `INSERT INTO user_activity(user_id, last_seen)
       VALUES($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW();`,
      [userId]
    );
    console.log(`[DB] User activity updated for ${userId}`);
  } catch (error) {
    console.error(`[DB] Failed to update user activity for ${userId}:`, error.message);
  }
}
// --- END OF CHANGE ---

// --- CHANGE 2: Added a new function to save deploying users to the backup DB ---
async function saveUserToBackupDb(userId) {
    const backupQuery = `
      INSERT INTO all_users_backup(user_id, last_seen)
      VALUES($1, NOW())
      ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW();
    `;
    try {
        await backupPool.query(backupQuery, [userId]);
        console.log(`[DB-Backup] Saved/updated deploying user ${userId} to backup user list.`);
    } catch (error) {
        console.error(`[DB-Backup] Failed to save deploying user ${userId} to backup:`, error.message);
    }
}
// --- END OF CHANGE ---

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
        await backupPool.query(query, [userId, appName, sessionId, cleanConfigVars, botType, deployDate, expirationDate]);
        console.log(`[DB-Backup] Saved/Updated deployment for user ${userId}, app ${appName}.`);
    } catch (error) {
        console.error(`[DB-Backup] Failed to save user deployment for ${appName}:`, error.message, error.stack);
    }
}
async function getUserDeploymentsForRestore(userId) {
    try {
        const result = await backupPool.query(
            `SELECT app_name, session_id, config_vars, deploy_date, expiration_date, bot_type, deleted_from_heroku_at
             FROM user_deployments WHERE user_id = $1 ORDER BY deploy_date DESC;`,
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB-Backup] Failed to get user deployments for restore ${userId}:`, error.message);
        return [];
    }
}
async function deleteUserDeploymentFromBackup(userId, appName) {
    try {
        const result = await backupPool.query(
            'DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2 RETURNING app_name;',
            [userId, appName]
        );
        return result.rowCount > 0;
    } catch (error) {
        console.error(`[DB-Backup] Failed to permanently delete user deployment from backup for ${appName}:`, error.message);
        return false;
    }
}
async function markDeploymentDeletedFromHeroku(userId, appName) {
    try {
        await backupPool.query(
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
        const result = await backupPool.query(
            `SELECT user_id, app_name, session_id, config_vars
             FROM user_deployments WHERE bot_type = $1 ORDER BY deploy_date;`,
            [botType]
        );
        return result.rows;
    } catch (error) {
        console.error(`[DB-Backup] Failed to get all deployments for mass restore (type: ${botType}):`, error.message);
        return [];
    }
}
async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    let ownerUserId = await getUserIdByBotName(appName);
    if (!ownerUserId) {
        ownerUserId = callingChatId;
        console.warn(`[AppNotFoundHandler] Owner not found for "${appName}". Falling back to callingChatId: ${callingChatId}.`);
    }
    await deleteUserBot(ownerUserId, appName);
    await markDeploymentDeletedFromHeroku(ownerUserId, appName);
    const message = `App "${escapeMarkdown(appName)}" was not found on Heroku. It has been removed from your "My Bots" list.`;
    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId;
    if (originalMessageId) {
        await bot.editMessageText(message, { chat_id: messageTargetChatId, message_id: originalMessageId, parse_mode: 'Markdown' }).catch(err => console.error(`Failed to edit message in handleAppNotFoundAndCleanDb: ${err.message}`));
    } else {
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' }).catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `Your bot "*${escapeMarkdown(appName)}*" was not found and removed by the admin.`, { parse_mode: 'Markdown' }).catch(err => console.error(`Failed to send notification to owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
}

// === API functions ===

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
            for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
            return out;
        };
        const rows = chunkArray(apps, 3).map(r =>
            r.map(name => ({ text: name, callback_data: isRemoval ? `${callbackPrefix}:${name}:${targetUserId}` : targetUserId ? `${callbackPrefix}:${name}:${targetUserId}` : `${callbackPrefix}:${name}` }))
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
            if (messageId) {
                bot.editMessageText("Heroku API key invalid. Contact admin.", { chat_id: chatId, message_id: messageId });
            } else {
                bot.sendMessage(chatId, "Heroku API key invalid. Contact admin.");
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
  const name = vars.APP_NAME;
  const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
  const botTypeSpecificDefaults = defaultEnvVars[botType] || {};
  let buildResult = false;
  const createMsg = await sendAnimatedMessage(chatId, 'Creating application');

  try {
    const createMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Creating application');
    await axios.post('https://api.heroku.com/apps', { name }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
    clearInterval(createMsgAnimate);

    const configMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Configuring resources');
    await axios.post( `https://api.heroku.com/apps/${name}/addons`, { plan: 'heroku-postgresql' }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );
    await axios.put( `https://api.heroku.com/apps/${name}/buildpack-installations`, { updates: [ { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' }, { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' }, { buildpack: 'heroku/nodejs' } ] }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );
    clearInterval(configMsgAnimate);

    const varsMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Setting environment variables');
    const filteredVars = {};
    for (const key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && String(vars[key]).trim() !== '') {
            filteredVars[key] = vars[key];
        }
    }
    const finalConfigVars = isRestore ? filteredVars : { ...botTypeSpecificDefaults, ...filteredVars };
    await axios.patch(`https://api.heroku.com/apps/${name}/config-vars`, { ...finalConfigVars, APP_NAME: name }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );
    clearInterval(varsMsgAnimate);

    const bres = await axios.post(`https://api.heroku.com/apps/${name}/builds`, { source_blob: { url: `${githubRepoUrl}/tarball/main` } }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );
    const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
    let buildStatus = 'pending';
    const pollBuildStatus = () => new Promise(async (resolve, reject) => {
        const intervalId = setInterval(async () => {
            try {
                const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                buildStatus = poll.data.status;
                if (buildStatus !== 'pending') {
                    clearInterval(intervalId);
                    resolve(buildStatus);
                }
            } catch (error) {
                clearInterval(intervalId);
                reject(error);
            }
        }, 5000);
        setTimeout(() => {
            clearInterval(intervalId);
            reject(new Error('Build process timed out.'));
        }, 300 * 1000);
    });

    await bot.editMessageText(`Building...`, { chat_id: chatId, message_id: createMsg.message_id });
    await pollBuildStatus();

    if (buildStatus === 'succeeded') {
      await addUserBot(chatId, name, vars.SESSION_ID, botType);
      const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;
      await saveUserDeployment(chatId, name, vars.SESSION_ID, herokuConfigVars, botType);

      // --- CHANGE 3: Call the new function on successful deployment ---
      await saveUserToBackupDb(chatId);
      // --- END OF CHANGE ---

      if (isFreeTrial) { await recordFreeTrialDeploy(chatId); }
      
      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = `*Name:* ${escapeMarkdown(first_name||'')} ${escapeMarkdown(last_name||'')}\n*Username:* @${escapeMarkdown(username||'N/A')}\n*Chat ID:* \`${escapeMarkdown(chatId)}\``;
      const appDetails = `*App Name:* \`${escapeMarkdown(name)}\`\n*Session ID:* \`${escapeMarkdown(vars.SESSION_ID)}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;
      await bot.sendMessage(ADMIN_ID, `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`, { parse_mode: 'Markdown', disable_web_page_preview: true });

      const baseWaitingText = `Build successful! Waiting for bot...`;
      const animateIntervalId = await animateMessage(chatId, createMsg.message_id, baseWaitingText);
      
      try {
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error('Bot connection timed out.')), 120 * 1000);
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId, timeoutId });
        });
        await bot.editMessageText(`Your bot is now live!`, { chat_id: chatId, message_id: createMsg.message_id });
        buildResult = true;
      } catch (err) {
        await bot.editMessageText(`Bot "*${escapeMarkdown(name)}*" failed to start or session is invalid: ${escapeMarkdown(err.message)}`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${name}:${chatId}` }]] } });
        buildResult = false;
      } finally {
        const promiseData = appDeploymentPromises.get(name);
        if(promiseData) {
          clearInterval(promiseData.animateIntervalId);
          clearTimeout(promiseData.timeoutId);
          appDeploymentPromises.delete(name);
        }
      }

    } else {
      await bot.editMessageText(`Build status: ${buildStatus}. Check Heroku logs.`, { chat_id: chatId, message_id: createMsg.message_id });
      buildResult = false;
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred: ${escapeMarkdown(errorMsg)}`, {parse_mode: 'Markdown'});
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
    saveUserToBackupDb, // <-- CHANGE 4: Export the new function
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
    buildWithProgress
};
