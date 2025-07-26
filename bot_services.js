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
 * @param {object} params.mainPool - The main PostgreSQL pool.
 * @param {object} params.backupPool - The backup PostgreSQL pool.
 * @param {object} params.bot - The TelegramBot instance.
 * @param {string} params.HEROKU_API_KEY - Heroku API key.
 * @param {string} params.GITHUB_LEVANTER_REPO_URL - GitHub URL for Levanter.
 * @param {string} params.GITHUB_RAGANORK_REPO_URL - GitHub URL for Raganork.
 * @param {string} params.ADMIN_ID - Admin Telegram ID.
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
async function getAllUserBots() { // Modified to fetch user_id and bot_name as object for scheduled tasks
    try {
        const r = await pool.query('SELECT user_id, bot_name FROM user_bots');
        console.log(`[DB] getAllUserBots: Fetched all bots:`, r.rows.map(x => `"${x.user_id}" - "${x.bot_name}"`));
        return r.rows; // Returns [{user_id, bot_name}, ...]
    }
    catch (error) {
        console.error('[DB] getAllUserBots: Failed to get all user bots:', error.message);
        return [];
    }
}
// NEW: Function to get bot_name by session_id
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

/**
 * Deletes a deploy key from the database.
 * @param {string} key - The deploy key to delete.
 * @returns {boolean} - True if deletion was successful, false otherwise.
 */
async function deleteDeployKey(key) {
  try {
    const result = await pool.query(
      'DELETE FROM deploy_keys WHERE key = $1 RETURNING key',
      [key]
    );
    if (result.rowCount > 0) {
      console.log(`[DB] deleteDeployKey: Successfully deleted key "${key}".`);
      return true; // Indicate success
    } else {
      console.warn(`[DB] deleteDeployKey: Key "${key}" not found for deletion.`);
      return false; // Indicate key was not found
    }
  } catch (error) {
    console.error(`[DB] deleteDeployKey: Failed to delete key "${key}":`, error.message);
    return false; // Indicate failure due to error
  }
}

async function canDeployFreeTrial(userId) {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days
    const res = await pool.query(
        'SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1',
        [userId]
    );
    if (res.rows.length === 0) return { can: true };
    const lastDeploy = new Date(res.rows[0].last_deploy_at);
    if (lastDeploy < fourteenDaysAgo) return { can: true };

    const nextAvailable = new Date(lastDeploy.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days
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

// === NEW FUNCTIONS: For user deployments backup/restore/expiration (using 'backupPool') ===
// IMPORTANT: Updated logic as per clarification
async function saveUserDeployment(userId, appName, sessionId, configVars, botType) { // Added botType
    try {
        // Ensure configVars is a plain object, remove non-string values if any, for JSONB
        const cleanConfigVars = {};
        for (const key in configVars) {
            if (Object.prototype.hasOwnProperty.call(configVars, key)) {
                cleanConfigVars[key] = String(configVars[key]);
            }
        }

        const deployDate = new Date(); // Only used for initial insert if record doesn't exist
        const expirationDate = new Date(deployDate.getTime() + 45 * 24 * 60 * 60 * 1000); // 45 days from initial deploy

        const query = `
            INSERT INTO user_deployments(user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at)
            VALUES($1, $2, $3, $4, $5, $6, $7, NULL)
            ON CONFLICT (user_id, app_name) DO UPDATE SET
               session_id = EXCLUDED.session_id,
               config_vars = EXCLUDED.config_vars,
               bot_type = EXCLUDED.bot_type,
               deleted_from_heroku_at = NULL; -- Clear deletion flag on update/restore (deploy_date and expiration_date are NOT updated)
        `;
        // deploy_date and expiration_date are only set by DEFAULT CURRENT_TIMESTAMP on initial INSERT
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
        console.log(`[DB-Backup] Fetched ${result.rows.length} deployments for user ${userId} for restore.`);
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

// New function to mark a deployment as deleted from Heroku (but keep in backup)
async function markDeploymentDeletedFromHeroku(userId, appName) {
    try {
        await backupPool.query(
            `UPDATE user_deployments
             SET deleted_from_heroku_at = NOW()
             WHERE user_id = $1 AND app_name = $2;`, // expiration_date is NOT set to NULL here, as it's fixed
            [userId, appName]
        );
        console.log(`[DB-Backup] Marked deployment for user ${userId}, app ${appName} as deleted from Heroku.`);
    } catch (error) {
        console.error(`[DB-Backup] Failed to mark deployment as deleted from Heroku for ${appName}:`, error.message);
    }
}


// NEW HELPER FUNCTION: Handles 404 Not Found from Heroku API
async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    console.log(`[AppNotFoundHandler] Handling 404 for app "${appName}". Initiated by ${callingChatId}.`);

    let ownerUserId = await getUserIdByBotName(appName);

    if (!ownerUserId) {
        ownerUserId = callingChatId; // Fallback for notification
        console.warn(`[AppNotFoundHandler] Owner not found in DB for "${appName}". Falling back to callingChatId: ${callingChatId} for notification.`);
    } else {
        console.log(`[AppNotFoundHandler] Found owner ${ownerUserId} in DB for app "${appName}".`);
    }

    await deleteUserBot(ownerUserId, appName); // Delete from main DB (defined here)
    await markDeploymentDeletedFromHeroku(ownerUserId, appName); // NEW: Mark from backup DB as well (not delete)
    console.log(`[AppNotFoundHandler] Removed "${appName}" from user_bots (main) and marked as deleted in user_deployments (backup) DBs for user "${ownerUserId}".`);

    const message = `App "${escapeMarkdown(appName)}" was not found on Heroku. It has been automatically removed from your "My Bots" list.`; // <<< CHANGED: Escaped appName

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
            .catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb (new msg): ${err.message}`));
    }

    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `Your bot "*${escapeMarkdown(appName)}*" was not found on Heroku and has been removed from your "My Bots" list by the admin.`, { parse_mode: 'Markdown' })
             .catch(err => console.error(`Failed to send notification to original owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
}

// === API functions ===

// 8) Send Heroku apps list
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

        const chunkArray = (arr, size) => { // Defined locally or passed via init
            const out = [];
            for (let i = 0; i < arr.length; i += size) {
                out.push(arr.slice(i, i + size));
            }
            return out;
        };

        const rows = chunkArray(apps, 3).map(r =>
            r.map(name => ({
                text: name, // This 'name' is just text, not markdown.
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
            // Specific handling for 401: API key likely bad
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

// 9) Build & deploy helper with animated countdown
// IMPORTANT: This now takes botType to select the GitHub URL AND the correct defaultEnvVars
async function buildWithProgress(chatId, vars, isFreeTrial = false, isRestore = false, botType) {
  const name = vars.APP_NAME;
  const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;

  // Select the correct default environment variables based on botType
  const botTypeSpecificDefaults = defaultEnvVars[botType] || {};

  let buildResult = false;
  const createMsg = await sendAnimatedMessage(chatId, 'Creating application');

  try {
    await bot.editMessageText(`${getAnimatedEmoji()} Creating application...`, { chat_id: chatId, message_id: createMsg.message_id });
    const createMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Creating application');

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

    // Filter out undefined/null/empty strings from vars
    const filteredVars = {};
    for (const key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] !== undefined && vars[key] !== null && String(vars[key]).trim() !== '') {
            filteredVars[key] = vars[key];
        }
    }

    // Apply defaults intelligently based on isRestore
    let finalConfigVars = {};
    if (isRestore) {
        // For restore, 'vars' already comes with defaults + saved_config_vars applied in correct order.
        finalConfigVars = filteredVars; // Use the 'vars' object directly after filtering
    } else {
        // For new deploy, apply defaults, then overlay user-provided 'vars'
        finalConfigVars = {
            ...botTypeSpecificDefaults, // Apply type-specific defaults first
            ...filteredVars             // Overlay with user input (like SESSION_ID, APP_NAME, AUTO_STATUS_VIEW, etc.)
        };
    }

    await axios.patch(
      `https://api.heroku.com/apps/${name}/config-vars`,
      {
        ...finalConfigVars, // Use the carefully constructed finalConfigVars
        APP_NAME: name // <--- CRITICAL: Ensure the deployed app knows its own name
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

    const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
    let buildStatus = 'pending';
    let currentPct = 0; // Start percentage at 0

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
        await bot.editMessageText(`Build process for "${name}" timed out or encountered an error. Check Heroku logs.`, {
            chat_id: chatId,
            message_id: createMsg.message_id
        });
        buildResult = false;
        return buildResult;
    }

    if (buildStatus === 'succeeded') {
      console.log(`[Flow] buildWithProgress: Heroku build for "${name}" SUCCEEDED. Attempting to add bot to user_bots DB.`);
      await addUserBot(chatId, name, vars.SESSION_ID, botType);


      const herokuConfigVars = (await axios.get(
          `https://api.heroku.com/apps/${name}/config-vars`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
      )).data;

      await saveUserDeployment(chatId, name, vars.SESSION_ID, herokuConfigVars, botType);


      if (isFreeTrial) {
        await recordFreeTrialDeploy(chatId);
        console.log(`[FreeTrial] Recorded free trial deploy for user ${chatId}.`);
      }

      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [
        `*Name:* ${escapeMarkdown(first_name || '')} ${escapeMarkdown(last_name || '')}`,
        `*Username:* @${escapeMarkdown(username || 'N/A')}`,
        `*Chat ID:* \`${escapeMarkdown(chatId)}\``
      ].join('\n');
      const appDetails = `*App Name:* \`${escapeMarkdown(name)}\`\n*Session ID:* \`${escapeMarkdown(vars.SESSION_ID)}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;

      await bot.sendMessage(ADMIN_ID,
          `*New App Deployed (Heroku Build Succeeded)*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      // <<< Fix for "Build successful" message:
      const baseWaitingText = `Build successful! Waiting for bot to connect...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, {
        chat_id: chatId,
        message_id: createMsg.message_id,
        parse_mode: 'Markdown' // Ensure parse_mode is set
      });

      const animateIntervalId = await animateMessage(chatId, createMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          // Store timeoutId as well for clearing from bot_monitor
          const STATUS_CHECK_TIMEOUT = 120 * 1000; // Define locally if not module scope
          const timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(name);
              if (appPromise) {
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after deployment.`));
                  appDeploymentPromises.delete(name);
              }
          }, STATUS_CHECK_TIMEOUT);
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId, timeoutId }); // Add timeoutId here
      });

      // No need to redeclare STATUS_CHECK_TIMEOUT or timeoutId here, they are part of the promise constructor above.
      try {
          await appStatusPromise; // This waits for the resolution from bot.js's channel_post handler
          // Clear the specific timeoutId for this promise, if it wasn't cleared by bot_monitor
          const promiseData = appDeploymentPromises.get(name);
          if (promiseData && promiseData.timeoutId) {
             clearTimeout(promiseData.timeoutId);
          }
          clearInterval(animateIntervalId); // Clear this specific animation

          await bot.editMessageText(
            `Your bot is now live!`,
            { chat_id: chatId, message_id: createMsg.message_id }
          );
          buildResult = true;

          // Free trial expiry logic
          if (isFreeTrial) {
            setTimeout(async () => {
                const adminWarningMessage = `Free Trial App "*${escapeMarkdown(name)}*" has 5 minutes left until deletion!`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: `Delete "*${escapeMarkdown(name)}" Now`, callback_data: `admin_delete_trial_app:${name}` }]
                    ]
                };
                await bot.sendMessage(ADMIN_ID, adminWarningMessage, { reply_markup: keyboard, parse_mode: 'Markdown' });
                console.log(`[FreeTrial] Sent 5-min warning to admin for ${name}.`);
            }, 55 * 60 * 1000);

            setTimeout(async () => {
                try {
                    await bot.sendMessage(chatId, `Your Free Trial app "*${escapeMarkdown(name)}*" is being deleted now as its 1-hour runtime has ended.`);
                    await axios.delete(`https://api.heroku.com/apps/${name}`, {
                        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                    });
                    await deleteUserBot(chatId, name);
                    await markDeploymentDeletedFromHeroku(chatId, name);
                    await bot.sendMessage(chatId, `Free Trial app "*${escapeMarkdown(name)}*" successfully deleted.`);
                    console.log(`[FreeTrial] Auto-deleted app ${name} after 1 hour.`);
                } catch (e) {
                    console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                    await bot.sendMessage(chatId, `Could not auto-delete the app "*${escapeMarkdown(name)}*". Please delete it manually from your Heroku dashboard.`, {parse_mode: 'Markdown'});
                    // Assuming monitorSendTelegramAlert is correctly bound in init for this to work
                    monitorSendTelegramAlert(`Failed to auto-delete free trial app "*${escapeMarkdown(name)}*" for user ${escapeMarkdown(chatId)}: ${escapeMarkdown(e.message)}`, ADMIN_ID);
                }
            }, 60 * 60 * 1000);
          }

      } catch (err) {
          // Clear any remaining interval/timeout if error occurred.
          const promiseData = appDeploymentPromises.get(name);
          if (promiseData) {
             clearInterval(promiseData.animateIntervalId);
             if (promiseData.timeoutId) clearTimeout(promiseData.timeoutId);
          }
          console.error(`App status check failed for ${name}:`, err.message);
          await bot.editMessageText(
            `Bot "*${escapeMarkdown(name)}*" failed to start or session is invalid: ${escapeMarkdown(err.message)}\n\n` +
            `It has been added to your "My Bots" list, but you may need to learn how to update the session ID.`,
            {
                chat_id: chatId,
                message_id: createMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Change Session ID', callback_data: `change_session:${name}:${chatId}` }]
                    ]
                }
            }
          );
          buildResult = false;
      } finally {
          appDeploymentPromises.delete(name);
      }

    } else { // Heroku build failed
      await bot.editMessageText(
        `Build status: ${buildStatus}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'Markdown' } // Ensure parse_mode is set
      );
      buildResult = false;
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${escapeMarkdown(errorMsg)}\n\nPlease check the Heroku dashboard or try again.`, {parse_mode: 'Markdown'});
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
    handleAppNotFoundAndCleanDb,
    sendAppList,
    buildWithProgress
};
