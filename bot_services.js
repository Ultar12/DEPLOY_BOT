// bot_services.js

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

// === NEW UNIFIED DATABASE SYNC FUNCTION ===
async function updateUserAndBotData({ userId, botName = null, sessionId = null, botType = null, configVars = null, isNewDeploy = false }) {
    const mainClient = await pool.connect();
    const backupClient = await backupPool.connect();

    try {
        await mainClient.query('BEGIN');
        await backupClient.query('BEGIN');

        const userInfoQuery = `
            INSERT INTO user_activity (user_id, last_seen) VALUES ($1, NOW())
            ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW();
        `;
        await mainClient.query(userInfoQuery, [userId]);
        await backupClient.query(userInfoQuery, [userId]);

        if (botName) {
            const botQuery = `
                INSERT INTO user_bots (user_id, bot_name, session_id, bot_type) VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, bot_name) DO UPDATE 
                SET session_id = EXCLUDED.session_id, bot_type = EXCLUDED.bot_type, created_at = CURRENT_TIMESTAMP;
            `;
            await mainClient.query(botQuery, [userId, botName, sessionId, botType]);
            await backupClient.query(botQuery, [userId, botName, sessionId, botType]);

            if (isNewDeploy && configVars) {
                const cleanConfigVars = {};
                for (const key in configVars) {
                    if (Object.prototype.hasOwnProperty.call(configVars, key)) {
                        cleanConfigVars[key] = String(configVars[key]);
                    }
                }
                const deployDate = new Date();
                const expirationDate = new Date(deployDate.getTime() + 45 * 24 * 60 * 60 * 1000);
                const deployQuery = `
                    INSERT INTO user_deployments(user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at)
                    VALUES($1, $2, $3, $4, $5, $6, $7, NULL)
                    ON CONFLICT (user_id, app_name) DO UPDATE SET
                       session_id = EXCLUDED.session_id,
                       config_vars = EXCLUDED.config_vars,
                       bot_type = EXCLUDED.bot_type,
                       deleted_from_heroku_at = NULL;
                `;
                await backupClient.query(deployQuery, [userId, botName, sessionId, cleanConfigVars, botType, deployDate, expirationDate]);
            }
        }

        await mainClient.query('COMMIT');
        await backupClient.query('COMMIT');
        console.log(`[DB Sync] Synced data for user ${userId}.`);

    } catch (error) {
        await mainClient.query('ROLLBACK');
        await backupClient.query('ROLLBACK');
        console.error(`[DB Sync] CRITICAL ERROR during data sync for user ${userId}. Transaction rolled back.`, error);
        if (monitorSendTelegramAlert) {
            monitorSendTelegramAlert(`CRITICAL DB SYNC ERROR for user ${userId}. Check logs.`, ADMIN_ID);
        }
    } finally {
        mainClient.release();
        backupClient.release();
    }
}

// === DB helper functions ===

async function getUserBots(u) {
  try {
    const r = await pool.query('SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at', [u]);
    return r.rows.map(x => x.bot_name);
  }
  catch (error) {
    console.error(`[DB] getUserBots: Failed for user "${u}":`, error.message);
    return [];
  }
}

async function getUserIdByBotName(botName) {
    try {
        const r = await pool.query('SELECT user_id FROM user_bots WHERE bot_name=$1 ORDER BY created_at DESC LIMIT 1', [botName]);
        return r.rows.length > 0 ? r.rows[0].user_id : null;
    }
    catch (error) {
        console.error(`[DB] getUserIdByBotName: Failed for bot "${botName}":`, error.message);
        return null;
    }
}

async function getAllUserBots() {
    try {
        const r = await pool.query('SELECT user_id, bot_name, bot_type FROM user_bots ORDER BY created_at');
        return r.rows;
    }
    catch (error) {
        console.error('[DB] getAllUserBots: Failed:', error.message);
        return [];
    }
}

async function getBotNameBySessionId(sessionId) {
    try {
        const r = await pool.query('SELECT bot_name FROM user_bots WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1', [sessionId]);
        return r.rows.length > 0 ? r.rows[0].bot_name : null;
    } catch (error) {
        console.error(`[DB] getBotNameBySessionId: Failed for session ID "${sessionId}":`, error.message);
        return null;
    }
}

async function deleteUserBot(u, b) {
  const mainClient = await pool.connect();
  const backupClient = await backupPool.connect();
  try {
    await mainClient.query('BEGIN');
    await backupClient.query('BEGIN');

    await mainClient.query('DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2', [u, b]);
    await backupClient.query('DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2', [u, b]);

    await mainClient.query('COMMIT');
    await backupClient.query('COMMIT');
    console.log(`[DB Sync] Deleted bot "${b}" for user "${u}" from both databases.`);
  } catch (error) {
    await mainClient.query('ROLLBACK');
    await backupClient.query('ROLLBACK');
    console.error(`[DB Sync] Failed to delete bot "${b}" for user "${u}":`, error.message);
  } finally {
      mainClient.release();
      backupClient.release();
  }
}

async function updateUserSession(u, b, s) {
  try {
    await pool.query('UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3', [s, u, b]);
    await backupPool.query('UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3', [s, u, b]);
    console.log(`[DB Sync] Updated session for bot "${b}" in both databases.`);
  } catch (error) {
    console.error(`[DB Sync] Failed to update session for bot "${b}":`, error.message);
  }
}

async function addDeployKey(key, uses, createdBy) {
  await pool.query('INSERT INTO deploy_keys(key,uses_left,created_by) VALUES($1,$2,$3)', [key, uses, createdBy]);
  console.log(`[DB] addDeployKey: Added key "${key}" with ${uses} uses by "${createdBy}".`);
}

async function useDeployKey(key) {
  const res = await pool.query(`UPDATE deploy_keys SET uses_left = uses_left - 1 WHERE key = $1 AND uses_left > 0 RETURNING uses_left`, [key]);
  if (res.rowCount === 0) { return null; }
  const left = res.rows[0].uses_left;
  if (left === 0) { await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]); }
  return left;
}

async function getAllDeployKeys() {
    try {
        const res = await pool.query('SELECT key, uses_left, created_by, created_at FROM deploy_keys ORDER BY created_at DESC');
        return res.rows;
    } catch (error) {
        console.error('[DB] getAllDeployKeys: Failed:', error.message);
        return [];
    }
}

async function deleteDeployKey(key) {
  try {
    const result = await pool.query('DELETE FROM deploy_keys WHERE key = $1 RETURNING key', [key]);
    return result.rowCount > 0;
  } catch (error) {
    console.error(`[DB] deleteDeployKey: Failed for key "${key}":`, error.message);
    return false;
  }
}

async function canDeployFreeTrial(userId) {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const res = await pool.query('SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1', [userId]);
    if (res.rows.length === 0) return { can: true };
    const lastDeploy = new Date(res.rows[0].last_deploy_at);
    if (lastDeploy < fourteenDaysAgo) return { can: true };
    const nextAvailable = new Date(lastDeploy.getTime() + 14 * 24 * 60 * 60 * 1000);
    return { can: false, cooldown: nextAvailable };
}

async function recordFreeTrialDeploy(userId) {
    await pool.query(`INSERT INTO temp_deploys (user_id, last_deploy_at) VALUES ($1, NOW()) ON CONFLICT (user_id) DO UPDATE SET last_deploy_at = NOW()`, [userId]);
    console.log(`[DB] recordFreeTrialDeploy: Recorded for user "${userId}".`);
}

async function getUserLastSeen(userId) {
  try {
    const result = await pool.query('SELECT last_seen FROM user_activity WHERE user_id = $1', [userId]);
    return result.rows.length > 0 ? result.rows[0].last_seen : null;
  }
  catch (error) {
    console.error(`[DB] Failed to get last seen for ${userId}:`, error.message);
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
        await pool.query('INSERT INTO banned_users(user_id, banned_by) VALUES($1, $2) ON CONFLICT (user_id) DO NOTHING;', [userId, bannedByAdminId]);
        await backupPool.query('INSERT INTO banned_users(user_id, banned_by) VALUES($1, $2) ON CONFLICT (user_id) DO NOTHING;', [userId, bannedByAdminId]);
        return true;
    } catch (error) {
        console.error(`[Admin] Error banning user ${userId}:`, error.message);
        return false;
    }
}

async function unbanUser(userId) {
    try {
        await pool.query('DELETE FROM banned_users WHERE user_id = $1', [userId]);
        const result = await backupPool.query('DELETE FROM banned_users WHERE user_id = $1 RETURNING user_id;', [userId]);
        return result.rowCount > 0;
    } catch (error) {
        console.error(`[Admin] Error unbanning user ${userId}:`, error.message);
        return false;
    }
}

async function getUserDeploymentsForRestore(userId) {
    try {
        const result = await backupPool.query(`SELECT app_name, session_id, config_vars, deploy_date, expiration_date, bot_type, deleted_from_heroku_at FROM user_deployments WHERE user_id = $1 ORDER BY deploy_date DESC;`, [userId]);
        return result.rows;
    } catch (error) {
        console.error(`[DB-Backup] Failed to get user deployments for restore ${userId}:`, error.message);
        return [];
    }
}

async function deleteUserDeploymentFromBackup(userId, appName) {
    try {
        const result = await backupPool.query('DELETE FROM user_deployments WHERE user_id = $1 AND app_name = $2 RETURNING app_name;', [userId, appName]);
        return result.rowCount > 0;
    } catch (error) {
        console.error(`[DB-Backup] Failed to permanently delete user deployment from backup for ${appName}:`, error.message);
        return false;
    }
}

async function markDeploymentDeletedFromHeroku(userId, appName) {
    try {
        await backupPool.query(`UPDATE user_deployments SET deleted_from_heroku_at = NOW() WHERE user_id = $1 AND app_name = $2;`, [userId, appName]);
    } catch (error) {
        console.error(`[DB-Backup] Failed to mark deployment as deleted from Heroku for ${appName}:`, error.message);
    }
}

async function getAllDeploymentsFromBackup(botType) {
    try {
        const result = await backupPool.query(`SELECT user_id, app_name, session_id, config_vars FROM user_deployments WHERE bot_type = $1 ORDER BY deploy_date;`, [botType]);
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
    }
    await deleteUserBot(ownerUserId, appName);
    await markDeploymentDeletedFromHeroku(ownerUserId, appName);
    const message = `App "${escapeMarkdown(appName)}" was not found on Heroku. It has been removed from your "My Bots" list.`;
    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId;
    if (originalMessageId) {
        await bot.editMessageText(message, { chat_id: messageTargetChatId, message_id: originalMessageId, parse_mode: 'Markdown' }).catch(err => console.error(err.message));
    } else {
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' }).catch(err => console.error(err.message));
    }
    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `Your bot "*${escapeMarkdown(appName)}*" was not found and removed by the admin.`, { parse_mode: 'Markdown' }).catch(err => console.error(err.message));
    }
}

async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserId = null, isRemoval = false) {
    try {
        const res = await axios.get('https://api.heroku.com/apps', { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
        const apps = res.data.map(a => a.name);
        if (!apps.length) {
            if (messageId) return bot.editMessageText('No apps found.', { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, 'No apps found.');
        }
        const chunkArray = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
        const rows = chunkArray(apps, 3).map(r => r.map(name => ({ text: name, callback_data: isRemoval ? `${callbackPrefix}:${name}:${targetUserId}` : targetUserId ? `${callbackPrefix}:${name}:${targetUserId}` : `${callbackPrefix}:${name}` })));
        const message = `Total apps: ${apps.length}\nSelect an app:`;
        if (messageId) {
            await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
        } else {
            await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: rows } });
        }
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        if (messageId) { bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId }); } 
        else { bot.sendMessage(chatId, errorMsg); }
    }
}

async function buildWithProgress(chatId, vars, isFreeTrial = false, isRestore = false, botType) {
  const name = vars.APP_NAME;
  const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
  const botTypeSpecificDefaults = defaultEnvVars[botType] || {};
  let buildResult = false;
  const createMsg = await sendAnimatedMessage(chatId, 'Creating application');

  try {
    await bot.editMessageText(`Creating application...`, { chat_id: chatId, message_id: createMsg.message_id });
    await axios.post('https://api.heroku.com/apps', { name }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
    
    await bot.editMessageText(`Configuring resources...`, { chat_id: chatId, message_id: createMsg.message_id });
    await axios.post( `https://api.heroku.com/apps/${name}/addons`, { plan: 'heroku-postgresql' }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );
    await axios.put( `https://api.heroku.com/apps/${name}/buildpack-installations`, { updates: [ { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' }, { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' }, { buildpack: 'heroku/nodejs' } ] }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );
    
    await bot.editMessageText(`Setting environment variables...`, { chat_id: chatId, message_id: createMsg.message_id });
    const filteredVars = Object.fromEntries(Object.entries(vars).filter(([_, v]) => v !== null && v !== undefined && String(v).trim() !== ''));
    const finalConfigVars = isRestore ? filteredVars : { ...botTypeSpecificDefaults, ...filteredVars };
    await axios.patch(`https://api.heroku.com/apps/${name}/config-vars`, { ...finalConfigVars, APP_NAME: name }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );

    await bot.editMessageText(`Starting build process for *${escapeMarkdown(name)}*...`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
    const bres = await axios.post(`https://api.heroku.com/apps/${name}/builds`, { source_blob: { url: `${githubRepoUrl}/tarball/main` } }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } } );
    const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
    let buildStatus = 'pending';

    if (botType === 'raganork') {
        const buildDuration = 90 * 1000; // 1.5 minutes
        const updateInterval = 2000; // 2 seconds
        const totalSteps = buildDuration / updateInterval;
        let currentStep = 0;
        const progressInterval = setInterval(async () => {
            currentStep++;
            const percentage = Math.min(100, Math.floor((currentStep / totalSteps) * 100));
            await bot.editMessageText(`Building Raganork Bot... ${percentage}%`, {
                chat_id: chatId, message_id: createMsg.message_id
            }).catch(() => {});
            if (percentage >= 100) clearInterval(progressInterval);
        }, updateInterval);
        await new Promise(resolve => setTimeout(resolve, buildDuration));
        clearInterval(progressInterval);
        try {
            const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
            buildStatus = poll.data.status;
        } catch (e) {
            console.error("Error fetching final build status for Raganork:", e.message);
            buildStatus = 'failed';
        }
    } else {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { clearInterval(pollInterval); reject(new Error('Build poll timed out.')); }, 300 * 1000);
            const pollInterval = setInterval(async () => {
                try {
                    const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    if (poll.data.status !== 'pending') {
                        clearInterval(pollInterval);
                        clearTimeout(timeout);
                        buildStatus = poll.data.status;
                        resolve();
                    }
                } catch (error) {
                    clearInterval(pollInterval);
                    clearTimeout(timeout);
                    reject(error);
                }
            }, 10000);
        });
    }

    if (buildStatus === 'succeeded') {
      const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${name}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })).data;
      await updateUserAndBotData({ userId: chatId, botName: name, sessionId: vars.SESSION_ID, botType: botType, configVars: herokuConfigVars, isNewDeploy: true });
      if (isFreeTrial) { await recordFreeTrialDeploy(chatId); }
      
      const { first_name, username } = (await bot.getChat(chatId));
      const userDetails = `*Name:* ${escapeMarkdown(first_name||'')}\n*Username:* @${escapeMarkdown(username||'N/A')}\n*Chat ID:* \`${escapeMarkdown(chatId)}\``;
      const appDetails = `*App Name:* \`${escapeMarkdown(name)}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;
      await bot.sendMessage(ADMIN_ID, `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`, { parse_mode: 'Markdown', disable_web_page_preview: true });

      await bot.editMessageText(`Build successful! Waiting for bot to connect...`, { chat_id: chatId, message_id: createMsg.message_id });
      
      try {
        await new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => reject(new Error('Bot connection timed out after 2 minutes.')), 120 * 1000);
          appDeploymentPromises.set(name, { resolve, reject, timeoutId });
        });
        await bot.editMessageText(`Your bot *${escapeMarkdown(name)}* is now live!`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' });
        buildResult = true;
      } catch (err) {
        await bot.editMessageText(`Bot "*${escapeMarkdown(name)}*" failed to connect: ${escapeMarkdown(err.message)}\n\nYou may need to update your session ID.`, { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${name}:${chatId}` }]] } });
        buildResult = false;
      } finally {
        const promiseData = appDeploymentPromises.get(name);
        if(promiseData) {
          clearTimeout(promiseData.timeoutId);
          appDeploymentPromises.delete(name);
        }
      }
    } else {
      await bot.editMessageText(`Build failed with status: ${buildStatus}. Check your Heroku dashboard logs for details.`, { chat_id: chatId, message_id: createMsg.message_id });
      buildResult = false;
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${escapeMarkdown(errorMsg)}`, {parse_mode: 'Markdown'});
    buildResult = false;
  }
  return buildResult;
}

module.exports = {
    init,
    updateUserAndBotData,
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
    getUserLastSeen,
    isUserBanned,
    banUser,
    unbanUser,
    getUserDeploymentsForRestore,
    deleteUserDeploymentFromBackup,
    markDeploymentDeletedFromHeroku,
    getAllDeploymentsFromBackup,
    handleAppNotFoundAndCleanDb,
    sendAppList,
    buildWithProgress
};
