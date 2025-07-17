// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const path = require('path'); // ADDED: Import the 'path' module

// 2) Load fallback env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch (e) {
  console.warn('Could not load fallback env vars from app.json:', e.message);
}

// 3) Environment config
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL,
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// Admin SUDO numbers that cannot be removed
const ADMIN_SUDO_NUMBERS = ['234', '2349163916314'];

// Add the channel ID the bot will listen to for specific messages
const TELEGRAM_LISTEN_CHANNEL_ID = '-1002892034574'; // <--- Your channel ID here

// 4) Postgres setup & ensure tables exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    // --- IMPORTANT FOR DEVELOPMENT/DEBUGGING ---
    // Uncomment the line below ONCE if you need to completely reset your user_bots table
    // (e.g., if you suspect corrupt data or a malformed schema).
    // After running once, comment it out again to prevent data loss on future deploys.
    // await pool.query('DROP TABLE IF EXISTS user_bots;');
    // console.warn("[DB] DEVELOPMENT: user_bots table dropped (if existed).");
    // ---------------------------------------------

    // Attempt to create the user_bots table with the PRIMARY KEY constraint
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
        session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, bot_name)
      );
    `);
    console.log("[DB] 'user_bots' table checked/created with PRIMARY KEY.");

    // Add deploy_keys table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deploy_keys (
        key        TEXT PRIMARY KEY,
        uses_left  INTEGER NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[DB] 'deploy_keys' table checked/created.");

    // Add temp_deploys table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS temp_deploys (
        user_id       TEXT PRIMARY KEY,
        last_deploy_at TIMESTAMP NOT NULL
      );
    `);
    console.log("[DB] 'temp_deploys' table checked/created.");

    // Add user_activity table for last seen
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_id TEXT PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[DB] 'user_activity' table checked/created.");

    console.log("[DB] All necessary tables checked/created successfully.");

  } catch (dbError) {
    // This catch block handles errors during the *initial* CREATE TABLE IF NOT EXISTS.
    // The most common is if a table already exists but the constraint part (like PK) failed to add.

    if (dbError.code === '42P07' || (dbError.message && dbError.message.includes('already exists'))) {
        console.warn(`[DB] Table already exists or issue creating it initially. Attempting to ensure PRIMARY KEY constraint.`);
        try {
            await pool.query(`
                ALTER TABLE user_bots
                ADD CONSTRAINT user_bots_pkey PRIMARY KEY (user_id, bot_name);
            `);
            console.log("[DB] PRIMARY KEY constraint successfully added to 'user_bots'.");
        } catch (alterError) {
            if ((alterError.message && alterError.message.includes('already exists in relation "user_bots"')) || (alterError.message && alterError.message.includes('already exists'))) {
                 console.warn("[DB] PRIMARY KEY constraint 'user_bots_pkey' already exists on 'user_bots'. Skipping ALTER TABLE.");
            } else {
                 console.error("[DB] CRITICAL ERROR adding PRIMARY KEY constraint to 'user_bots':", alterError.message, alterError.stack);
                 process.exit(1);
            }
        }
    } else {
        console.error("[DB] CRITICAL ERROR during initial database table creation/check:", dbError.message, dbError.stack);
        process.exit(1);
    }
  }
})();

// 5) DB helper functions
async function addUserBot(u, b, s) {
  try {
    const result = await pool.query(
      `INSERT INTO user_bots(user_id, bot_name, session_id)
       VALUES($1, $2, $3)
       ON CONFLICT (user_id, bot_name) DO UPDATE SET session_id = EXCLUDED.session_id, created_at = CURRENT_TIMESTAMP
       RETURNING *;`,
      [u, b, s]
    );
    if (result.rows.length > 0) {
      console.log(`[DB] addUserBot: Successfully added/updated bot "${b}" for user "${u}". Row:`, result.rows[0]);
    } else {
      console.warn(`[DB] addUserBot: Insert/update operation for bot "${b}" for user "${u}" did not return a row. This might indicate an horrific issue.`);
    }
  } catch (error) {
    console.error(`[DB] addUserBot: CRITICAL ERROR Failed to add/update bot "${b}" for user "${u}":`, error.message, error.stack);
    bot.sendMessage(ADMIN_ID, `CRITICAL DB ERROR: Failed to add/update bot "${b}" for user "${u}". Check logs.`);
  }
}
async function getUserBots(u) {
  try {
    const r = await pool.query(
      'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
      [u]
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
            'SELECT user_id FROM user_bots WHERE bot_name=$1 ORDER BY created_at DESC LIMIT 1',
            [botName]
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
        const r = await pool.query('SELECT user_id, bot_name FROM user_bots');
        console.log(`[DB] getAllUserBots: Fetched all bots:`, r.rows.map(x => `"${x.user_id}" - "${x.bot_name}"`));
        return r.rows;
    }
    catch (error) {
        console.error('[DB] getAllUserBots: Failed to get all user bots:', error.message);
        return [];
    }
}

async function deleteUserBot(u, b) {
  try {
    await pool.query(
      'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
      [u, b]
    );
    console.log(`[DB] deleteUserBot: Successfully deleted bot "${b}" for user "${u}".`);
  } catch (error) {
    console.error(`[DB] deleteUserBot: Failed to delete bot "${b}" for user "${u}":`, error.message);
  }
}
async function updateUserSession(u, b, s) {
  try {
    await pool.query(
      'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
      [s, u, b]
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
}
async function useDeployKey(key) {
  const res = await pool.query(
    `UPDATE deploy_keys
     SET uses_left = uses_left - 1
     WHERE key = $1 AND uses_left > 0
     RETURNING uses_left`,
    [key]
  );
  if (res.rowCount === 0) return null;
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
}

// Function to update user last seen activity
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

// Function to get user's last seen activity
async function getUserLastSeen(userId) {
  try {
    const result = await pool.query('SELECT last_seen FROM user_activity WHERE user_id = $1', [userId]);
    if (result.rows.length > 0) {
      return result.rows[0].last_seen;
    }
    return null;
  } catch (error) {
    console.error(`[DB] Failed to get user last seen for ${userId}:`, error.message);
    return null;
  }
}


// NEW HELPER FUNCTION: Handles 404 Not Found from Heroku API
async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    console.log(`[AppNotFoundHandler] Handling 404 for app "${appName}". Initiated by ${callingChatId}.`);

    let ownerUserId = await getUserIdByBotName(appName);

    if (!ownerUserId) {
        ownerUserId = callingChatId;
        console.warn(`[AppNotFoundHandler] Owner not found in DB for "${appName}". Falling back to callingChatId: ${callingChatId} for notification.`);
    } else {
        console.log(`[AppNotFoundHandler] Found owner ${ownerUserId} in DB for app "${appName}".`);
    }

    await deleteUserBot(ownerUserId, appName);
    console.log(`[AppNotFoundHandler] Removed "${appName}" from user_bots DB for user "${ownerUserId}".`);

    const message = `App "<b>${appName}</b>" was not found on Heroku. It has been automatically removed from your "My Bots" list.`;

    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId;
    const messageToEditId = originalMessageId;

    if (messageToEditId) {
        await bot.editMessageText(message, {
            chat_id: messageTargetChatId,
            message_id: messageToEditId,
            parse_mode: 'HTML'
        }).catch(err => console.error(`Failed to edit message in handleAppNotFoundAndCleanDb: ${err.message}`));
    } else {
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'HTML' })
            .catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb (new msg): ${err.message}`));
    }

    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `Your bot "<b>${appName}</b>" was not found on Heroku and has been removed from your "My Bots" list by the admin.`, { parse_mode: 'HTML' })
             .catch(err => console.error(`Failed to send notification to original owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
}


// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {}; // chatId -> { step, data, message_id, faqPage, faqMessageId }
const authorizedUsers = new Set(); // chatIds who've passed a key

// Map to store Promises for app deployment status based on channel notifications
const appDeploymentPromises = new Map(); // appName -> { resolve, reject, animateIntervalId }

const forwardingContext = {};

const userLastSeenNotification = new Map();
const ONLINE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

async function notifyAdminUserOnline(msg) {
    const userId = msg.chat.id.toString();
    const now = Date.now();

    if (userId === ADMIN_ID) {
        return;
    }

    const lastNotified = userLastSeenNotification.get(userId) || 0;

    if (now - lastNotified > ONLINE_NOTIFICATION_COOLDOWN_MS) {
        try {
            const { first_name, last_name, username } = msg.from;

            const userDetails = `
<b>User Online:</b>
<b>ID:</b> <code>${userId}</code>
<b>Name:</b> ${first_name ? escapeHtml(first_name) : 'N/A'} ${last_name ? escapeHtml(last_name) : ''}
<b>Username:</b> ${username ? `<a href="https://t.me/${escapeHtml(username)}">@${escapeHtml(username)}</a>` : 'N/A'}
<b>Time:</b> ${new Date().toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
            `;
            await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'HTML' });
            userLastSeenNotification.set(userId, now);
            console.log(`[Admin Notification] Notified admin about user ${userId} being online.`);
        } catch (error) {
            console.error(`Error notifying admin about user ${userId} online:`, error.message);
        }
    }
}


// 7) Utilities

let emojiIndex = 0;
const animatedEmojis = ['⬜⬜⬜⬜⬜', '⬛⬜⬜⬜⬜', '⬜⬛⬜⬜⬜', '⬜⬜⬛⬜⬜', '⬜⬜⬜⬛⬜', '⬜⬜⬜⬜⬛', '⬜⬜⬜⬜⬜'];

function getAnimatedEmoji() {
    const emoji = animatedEmojis[emojiIndex];
    emojiIndex = (emojiIndex + 1) % animatedEmojis.length;
    return emoji;
}

// REDUCED ANIMATION FREQUENCY
async function animateMessage(chatId, messageId, baseText) {
    const intervalId = setInterval(async () => {
        try {
            await bot.editMessageText(`${getAnimatedEmoji()} ${baseText}`, {
                chat_id: chatId,
                message_id: messageId
            }).catch(() => {});
        } catch (e) {
            console.error(`Error animating message ${messageId}:`, e.message);
            clearInterval(intervalId);
        }
    }, 2000); // Changed from 1500ms to 2000ms
    return intervalId;
}


function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

// NEW: escapeHtml function for HTML parse_mode
function escapeHtml(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    // Escape HTML special characters
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


const MAINTENANCE_FILE = path.join(__dirname, 'maintenance_status.json');
let isMaintenanceMode = false;

async function loadMaintenanceStatus() {
    try {
        if (fs.existsSync(MAINTENANCE_FILE)) {
            const data = await fs.promises.readFile(MAINTENANCE_FILE, 'utf8');
            isMaintenanceMode = JSON.parse(data).isMaintenanceMode || false;
            console.log(`[Maintenance] Loaded status: ${isMaintenanceMode ? 'ON' : 'OFF'}`);
        } else {
            await saveMaintenanceStatus(false);
            console.log('[Maintenance] Status file not found. Created with default OFF.');
        }
    } catch (error) {
        console.error('[Maintenance] Error loading status:', error.message);
        isMaintenanceMode = false;
    }
}

async function saveMaintenanceStatus(status) {
    try {
        await fs.promises.writeFile(MAINTENANCE_FILE, JSON.stringify({ isMaintenanceMode: status }), 'utf8');
        console.log(`[Maintenance] Saved status: ${status ? 'ON' : 'OFF'}`);
    } catch (error) {
        console.error('[Maintenance] Error saving status:', error.message);
    }
}


function buildKeyboard(isAdmin) {
  const baseMenu = [
      ['Get Session', 'Deploy'],
      ['Free Trial', 'My Bots'],
      ['Support', 'FAQ'] // Added FAQ button
  ];
  if (isAdmin) {
      return [
          ['Deploy', 'Apps'],
          ['Generate Key', 'Get Session'],
          ['Support', 'FAQ'] // Added FAQ button for admin too
      ];
  }
  return baseMenu;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function sendAnimatedMessage(chatId, baseText) {
    const msg = await bot.sendMessage(chatId, `⚙️ ${baseText}...`);
    await new Promise(r => setTimeout(r, 1200));
    return msg;
}

async function startRestartCountdown(chatId, appName, messageId) {
    const totalSeconds = 60;
    const intervalTime = 5;
    const totalSteps = totalSeconds / intervalTime;

    await bot.editMessageText(`Bot "${appName}" restarting...`, {
        chat_id: chatId,
        message_id: messageId
    }).catch(() => {});

    for (let i = 0; i <= totalSteps; i++) {
        const secondsLeft = totalSeconds - (i * intervalTime);
        const minutesLeft = Math.floor(secondsLeft / 60);
        const remainingSeconds = secondsLeft % 60;

        const filledBlocks = '█'.repeat(i);
        const emptyBlocks = '░'.repeat(totalSteps - i);

        let countdownMessage = `Bot "${appName}" restarting...\n\n`;
        if (secondsLeft > 0) {
            countdownMessage += `[${filledBlocks}${emptyBlocks}] ${minutesLeft}m ${remainingSeconds}s left`;
        } else {
            countdownMessage += `[${filledBlocks}] Restart complete!`;
        }

        await bot.editMessageText(countdownMessage, {
            chat_id: chatId,
            message_id: messageId
        }).catch(() => {});

        if (secondsLeft <= 0) break;
        await new Promise(r => setTimeout(r, intervalTime * 1000));
    }
    await bot.editMessageText(`Bot "${appName}" has restarted successfully and is back online!`, {
        chat_id: chatId,
        message_id: messageId
    });
}


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
    if (messageId) {
        bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId });
    } else {
        bot.sendMessage(chatId, errorMsg);
    }
  }
}

// 9) Build & deploy helper with animated countdown
async function buildWithProgress(chatId, vars, isFreeTrial = false) {
  const name = vars.APP_NAME;

  let buildResult = false;
  const createMsg = await bot.sendMessage(chatId, `⚙️ Creating application...`);

  try {
    const createMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Creating application');

    await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    clearInterval(createMsgAnimate);

    await bot.editMessageText(`⚙️ Configuring resources...`, { chat_id: chatId, message_id: createMsg.message_id });
    const configMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Configuring resources');

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

    await bot.editMessageText(`⚙️ Setting environment variables...`, { chat_id: chatId, message_id: createMsg.message_id });
    const varsMsgAnimate = await animateMessage(chatId, createMsg.message_id, 'Setting environment variables');

    await axios.patch(
      `https://api.heroku.com/apps/${name}/config-vars`,
      {
        ...defaultEnvVars,
        ...vars
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
    // No animated emoji here, keeping it plain for the build percentage updates below.
    const bres = await axios.post(
      `https://api.heroku.com/apps/${name}/builds`,
      { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
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

    // Use a simpler setInterval for the percentage update without the animated emoji
    const buildProgressInterval = setInterval(async () => {
        try {
            const poll = await axios.get(statusUrl, {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3'
                }
            });
            buildStatus = poll.data.status;

            // Update percentage. This logic simulates progress;
            // for real-time Heroku build progress, you'd need build stream events.
            if (buildStatus === 'pending') {
                currentPct = Math.min(99, currentPct + Math.floor(Math.random() * 5) + 1); // Increment by random small amount
            } else if (buildStatus === 'succeeded') {
                currentPct = 100;
            } else if (buildStatus === 'failed') {
                currentPct = 'Error'; // Indicate an error state
            }

            // Always update the message text with the current percentage
            await bot.editMessageText(`Building... ${currentPct}%`, {
                chat_id: chatId,
                message_id: createMsg.message_id // Use createMsg.message_id to edit the initial message
            }).catch(() => {}); // Catch if message is already gone/edited

            if (buildStatus !== 'pending' || currentPct === 100 || currentPct === 'Error') {
                clearInterval(buildProgressInterval); // Stop interval once build is not pending or maxed out
            }
        } catch (error) {
            console.error(`Error polling build status for ${name}:`, error.message);
            clearInterval(buildProgressInterval); // Stop on polling error
            await bot.editMessageText(`Building... Error`, {
                chat_id: chatId,
                message_id: createMsg.message_id
            }).catch(() => {});
            buildStatus = 'error'; // Force status to error if polling fails
        }
    }, 5000); // Update every 5 seconds for smoother, steady percentage

    // Wait for the build status to be resolved (succeeded or failed)
    try {
        // This promise resolves or rejects based on channel_post updates or a timeout
        // The while loop below acts as a fallback to ensure we wait for a final status
        const BUILD_COMPLETION_TIMEOUT = 300 * 1000; // 5 minutes for build completion
        let completionTimeoutId = setTimeout(() => {
            clearInterval(buildProgressInterval); // Ensure interval is cleared on timeout
            // Reject the promise if it times out
            buildStatus = 'timed out'; // Update status for message below
            throw new Error(`Build process timed out after ${BUILD_COMPLETION_TIMEOUT / 1000} seconds.`);
        }, BUILD_COMPLETION_TIMEOUT);

        // This loop waits for the `buildStatus` variable to change from 'pending'
        // It relies on the `setInterval` above to update `buildStatus`
        while (buildStatus === 'pending') {
            await new Promise(r => setTimeout(r, 5000)); // Wait before checking again
        }
        clearTimeout(completionTimeoutId); // Clear timeout if loop breaks due to status change
        clearInterval(buildProgressInterval); // Ensure interval is cleared once status is not pending

    } catch (err) {
        clearInterval(buildProgressInterval); // Ensure interval is cleared
        await bot.editMessageText(`Build process for "<b>${name}</b>" timed out or encountered an error. Check Heroku logs.`, {
            chat_id: chatId,
            message_id: createMsg.message_id,
            parse_mode: 'HTML'
        });
        buildResult = false;
        return buildResult; // Exit early on build timeout/error
    }
    
    // Final check and messages based on buildStatus
    if (buildStatus === 'succeeded') {
      console.log(`[Flow] buildWithProgress: Heroku build for "${name}" SUCCEEDED. Attempting to add bot to user_bots DB.`);
      await addUserBot(chatId, name, vars.SESSION_ID);

      if (isFreeTrial) {
        await recordFreeTrialDeploy(chatId);
        console.log(`[FreeTrial] Recorded free trial deploy for user ${chatId}.`);
      }

      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [
        `<b>Name:</b> ${first_name ? escapeHtml(first_name) : 'N/A'} ${last_name ? escapeHtml(last_name) : ''}`,
        `<b>Username:</b> ${username ? `<a href="https://t.me/${escapeHtml(username)}">@${escapeHtml(username)}</a>` : 'N/A'}`,
        `<b>Chat ID:</b> <code>${chatId}</code>`
      ].join('\n');
      const appDetails = `<b>App Name:</b> <code>${name}</code>\n<b>Session ID:</b> <code>${vars.SESSION_ID}</code>\n<b>Type:</b> ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;

      await bot.sendMessage(ADMIN_ID,
          `<b>New App Deployed (Heroku Build Succeeded)</b>\n\n<b>App Details:</b>\n${appDetails}\n\n<b>Deployed By:</b>\n${userDetails}`,
          { parse_mode: 'HTML', disable_web_page_preview: true }
      );

      const baseWaitingText = `Build complete! Waiting for bot to connect...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, {
        chat_id: chatId,
        message_id: createMsg.message_id // Still editing the same initial message
      });

      const animateIntervalId = await animateMessage(chatId, createMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId });
      });

      const STATUS_CHECK_TIMEOUT = 120 * 1000;
      let timeoutId;

      try {
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(name);
              if (appPromise) {
                  appPromise.reject(new Error('Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after deployment.'));
                  appDeploymentPromises.delete(name);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise;
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);

          await bot.editMessageText(
            `Your bot is now live!`,
            { chat_id: chatId, message_id: createMsg.message_id }
          );
          buildResult = true;

          if (isFreeTrial) {
            setTimeout(async () => {
                const adminWarningMessage = `Free Trial App "<b>${name}</b>" has 5 minutes left until deletion!`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: `Delete "${name}" Now`, callback_data: `admin_delete_trial_app:${name}` }]
                    ]
                };
                await bot.sendMessage(ADMIN_ID, adminWarningMessage, { parse_mode: 'HTML', reply_markup: keyboard });
                console.log(`[FreeTrial] Sent 5-min warning to admin for ${name}.`);
            }, 55 * 60 * 1000);

            setTimeout(async () => {
                try {
                    await bot.sendMessage(chatId, `Your Free Trial app "<b>${name}</b>" is being deleted now as its 1-hour runtime has ended.`, { parse_mode: 'HTML' });
                    await axios.delete(`https://api.heroku.com/apps/${name}`, {
                        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                    });
                    await deleteUserBot(chatId, name);
                    await bot.sendMessage(chatId, `Free Trial app "<b>${name}</b>" successfully deleted.`, { parse_mode: 'HTML' });
                    console.log(`[FreeTrial] Auto-deleted app ${name} after 1 hour.`);
                } catch (e) {
                    console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                    await bot.sendMessage(chatId, `Could not auto-delete the app "<b>${name}</b>". Please delete it manually from your Heroku dashboard.`, { parse_mode: 'HTML' });
                    bot.sendMessage(ADMIN_ID, `Failed to auto-delete free trial app "<b>${name}</b>" for user ${chatId}: ${e.message}`, { parse_mode: 'HTML' });
                }
            }, 60 * 60 * 1000);
          }

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${name}:`, err.message);
          await bot.editMessageText(
            `Bot "<b>${name}</b>" failed to start or session is invalid: ${err.message}\n\n` +
            `It has been added to your "My Bots" list, but you may need to learn how to update the session ID.`,
            {
                chat_id: chatId,
                message_id: createMsg.message_id, // Still editing the same initial message
                parse_mode: 'HTML',
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
        { chat_id: chatId, message_id: createMsg.message_id, parse_mode: 'HTML' }
      );
      buildResult = false;
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`, { parse_mode: 'HTML' });
    buildResult = false;
  }
  return buildResult;
}

// 10) Polling error handler
bot.on('polling_error', console.error);

// --- FAQ Data and Functions ---
const FAQ_QUESTIONS = [
    {
        question: "How do I get a session ID?",
        answer: "Tap 'Get Session' and follow the prompts to provide your WhatsApp number for a pairing code. Alternatively, visit our website <a href=\"https://levanter-delta.vercel.app/\">https://levanter-delta.vercel.app/</a> to generate one yourself."
    },
    {
        question: "What is a 'Deploy Key'?",
        answer: "A Deploy Key is a special code that authorizes you to use our service to deploy a bot. You might receive it from the admin."
    },
    {
        question: "How do I deploy my bot after getting a session ID and/or deploy key?",
        answer: "Tap 'Deploy', enter your Deploy Key (if required), then paste your session ID, and finally choose a unique name for your bot."
    },
    {
        question: "What is the 'Free Trial' option?",
        answer: "The Free Trial allows you to deploy a bot for 1 hour to test the service. You can use it once every 14 days."
    },
    {
        question: "My bot failed to deploy, what should I do?",
        answer: "Check the error message provided by the bot. Common issues are incorrect session IDs, app names already taken, or Heroku API issues. Try again, or contact support if the issue persists."
    },
    {
        question: "How can I see my deployed bots?",
        answer: "Tap the 'My Bots' button to see a list of all bots you have deployed through this service."
    },
    {
        question: "My bot is offline/logged out. How do I fix it?",
        answer: "This usually means your session ID is invalid. Go to 'My Bots', select your bot, then choose 'Set Variable' and update the SESSION_ID with a new one from <a href=\"https://levanter-delta.vercel.app/\">https://levanter-delta.vercel.app/</a>."
    },
    {
        question: "What do 'Restart', 'Logs', 'Redeploy' do?",
        answer: "Restart: Restarts your bot application on Heroku.\nLogs: Shows the recent activity and error logs of your bot, useful for debugging.\nRedeploy: Rebuilds and deploys your bot from the latest code on GitHub, useful for updates or fresh installs."
    },
    {
        question: "How do I change my bot's settings/variables like AUTO_STATUS_VIEW or PREFIX?",
        answer: "Go to 'My Bots', select your bot, then choose 'Set Variable'. You can then select common variables or 'Add/Set Other Variable' for any custom environment variables."
    },
    {
        question: "What is SUDO variable and how do I manage it?",
        answer: "SUDO lists the WhatsApp numbers that have administrative control over your bot. You can add or remove numbers using the 'Set Variable' -> 'SUDO' options."
    },
    {
        question: "How do I delete my bot?",
        answer: "Go to 'My Bots', select the bot, then tap 'Delete'. Be careful, this action is permanent!"
    },
    {
        question: "I have a question not covered here. How do I get help?",
        answer: "You can 'Ask Admin a Question' directly through the bot, or 'Contact Admin Directly' via Telegram using the button in the 'Support' menu."
    },
    {
        question: "What is the 'Contact Admin to Get Key Dashboard' button for?",
        answer: "This is for administrators or users looking to manage deploy keys or access admin-specific dashboards, usually for service providers."
    },
    {
        question: "Who is the admin?",
        answer: "The primary support contact is @star_ies1."
    },
    {
        question: "When will my bot expire?",
        answer: "This depends on your subscription plan. Please contact the admin for clarification regarding your specific bot's expiration."
    },
    {
        question: "What bot is being deployed?",
        answer: "The system currently deploys Levanter Bot. If you have any other bot in mind, please use the Support button to send suggestions/feedback."
    }
];

const FAQ_ITEMS_PER_PAGE = 5;

async function sendFaqPage(chatId, messageId, page) {
    const startIndex = (page - 1) * FAQ_ITEMS_PER_PAGE;
    const endIndex = startIndex + FAQ_ITEMS_PER_PAGE;
    const currentQuestions = FAQ_QUESTIONS.slice(startIndex, endIndex);

    let faqText = "";
    currentQuestions.forEach((faq, index) => {
        // Wrap question in <b> tags for bold, and escape for HTML safety
        faqText += `<b>${startIndex + index + 1}. ${escapeHtml(faq.question)}</b>\n`;
        // Answer content is assumed to be pre-formatted for HTML, so directly append.
        // If there's any risk of unescaped HTML characters within the answer that aren't intended as tags,
        // you might need to apply escapeHtml to the answer as well, but only to characters that aren't part of intended HTML tags.
        faqText += `${faq.answer}\n\n`;
    });

    const totalPages = Math.ceil(FAQ_QUESTIONS.length / FAQ_ITEMS_PER_PAGE);

    const keyboard = [];
    const navigationRow = [];

    if (page > 1) {
        navigationRow.push({ text: 'Back', callback_data: `faq_page:${page - 1}` });
    }
    if (page < totalPages) {
        navigationRow.push({ text: 'Next', callback_data: `faq_page:${page + 1}` });
    }
    if (navigationRow.length > 0) {
        keyboard.push(navigationRow);
    }

    keyboard.push([{ text: 'Back to Main Menu', callback_data: 'back_to_main_menu' }]);


    const options = {
        parse_mode: 'HTML', // Changed to HTML
        disable_web_page_preview: false, // Keep web page preview for clickable links
        reply_markup: {
            inline_keyboard: keyboard
        }
    };

    // Initialize userStates for chatId if it doesn't exist
    if (!userStates[chatId]) {
        userStates[chatId] = {};
    }

    userStates[chatId].step = 'VIEWING_FAQ';
    userStates[chatId].faqPage = page;

    // Check if the message can be edited. Try to edit the existing message if messageId is passed and matches stored ID.
    // Otherwise, send a new message.
    if (messageId && userStates[chatId].faqMessageId === messageId) {
        await bot.editMessageText(faqText, {
            chat_id: chatId,
            message_id: messageId,
            ...options
        }).catch(err => {
            console.error(`Error editing FAQ message ${messageId}: ${err.message}. Attempting to send new message.`);
            // If editing fails (e.g., message too old or deleted by user), send a new message
            bot.sendMessage(chatId, faqText, options).then(sentMsg => {
                userStates[chatId].faqMessageId = sentMsg.message_id; // Store the new message ID
            }).catch(sendErr => console.error(`Failed to send new FAQ message after edit failure: ${sendErr.message}`));
        });
    } else {
        // Send a new message (e.g., first time opening FAQ, or previous message uneditable/not found)
        const sentMsg = await bot.sendMessage(chatId, faqText, options);
        userStates[chatId].faqMessageId = sentMsg.message_id; // Store the new message ID
    }
}
// --- End FAQ Data and Functions ---


// 11) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  await updateUserActivity(cid); // Update user activity on /start
  await notifyAdminUserOnline(msg); // Notify admin when a user uses /start
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid]; // Clear user state
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}]`);

  if (isAdmin) {
    await bot.sendMessage(cid, 'Welcome, Admin! Here is your menu:', {
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    });
  } else {
    const { first_name: userFirstName } = msg.from;
    let personalizedGreeting = `Welcome`;
    if (userFirstName) {
        personalizedGreeting += ` back, ${escapeHtml(userFirstName)}`;
    }
    personalizedGreeting += ` to our Bot Deployment Service!`;

    const welcomeImageUrl = 'https://files.catbox.moe/syx8uk.jpeg';
    const welcomeCaption = `
${personalizedGreeting}

To get started, please follow these simple steps:

1.  <b>Get Your Session:</b>
    Tap the 'Get Session' button and provide your WhatsApp number in full international format. The admin will then generate a pairing code for you.

2.  <b>Deploy Your Bot:</b>
    Once you have your session code, use the 'Deploy' button to effortlessly launch your personalized bot.

We are here to assist you every step of the way!
`;
    await bot.sendPhoto(cid, welcomeImageUrl, {
      caption: welcomeCaption,
      parse_mode: 'HTML',
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    });
  }
});

bot.onText(/^\/menu$/i, async msg => {
  const cid = msg.chat.id.toString();
  await updateUserActivity(cid);
  await notifyAdminUserOnline(msg); // Notify admin when a user uses /menu
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid]; // Clear user state
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, async msg => {
  const cid = msg.chat.id.toString();
  await updateUserActivity(cid);
  await notifyAdminUserOnline(msg); // Notify admin when a user uses /apps
  if (cid === ADMIN_ID) {
    sendAppList(cid);
  }
});

// NEW ADMIN COMMAND: /maintenance
bot.onText(/^\/maintenance (on|off)$/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    await updateUserActivity(chatId);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /maintenance
    const status = match[1].toLowerCase();

    if (chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "You are not authorized to use this command.");
    }

    if (status === 'on') {
        isMaintenanceMode = true;
        await saveMaintenanceStatus(true);
        await bot.sendMessage(chatId, "Maintenance mode is now <b>ON</b>.", { parse_mode: 'HTML' });
    } else if (status === 'off') {
        isMaintenanceMode = false;
        await saveMaintenanceStatus(false);
        await bot.sendMessage(chatId, "Maintenance mode is now <b>OFF</b>.", { parse_mode: 'HTML' });
    }
});


// New /id command
bot.onText(/^\/id$/, async msg => {
    const cid = msg.chat.id.toString();
    await updateUserActivity(cid);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /id
    await bot.sendMessage(cid, `Your Telegram Chat ID is: <code>${cid}</code>`, { parse_mode: 'HTML' });
});

// New /add <user_id> command for admin
bot.onText(/^\/add (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    await updateUserActivity(cid);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /add
    const targetUserId = match[1];

    console.log(`[Admin] /add command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /add attempt by ${cid}.`);
        return bot.sendMessage(cid, "You are not authorized to use this command.");
    }

    delete userStates[cid]; // Clear user state
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    try {
        await bot.getChat(targetUserId);
        console.log(`[Admin] Verified target user ID ${targetUserId} exists.`);
    } catch (error) {
        console.error(`[Admin] Error verifying target user ID ${targetUserId} for /add command:`, error.message);
        if (error.response && error.response.body && error.response.body.description) {
            const apiError = error.response.body.description;
            if (apiError.includes("chat not found") || apiError.includes("user not found")) {
                return bot.sendMessage(cid, `Cannot assign app: User with ID <code>${targetUserId}</code> not found or has not interacted with the bot.`, { parse_mode: 'HTML' });
            } else if (apiError.includes("bot was blocked by the user")) {
                return bot.sendMessage(cid, `Cannot assign app: The bot is blocked by user <code>${targetUserId}</code>.`, { parse_mode: 'HTML' });
            }
        }
        return bot.sendMessage(cid, `An error occurred while verifying user <code>${targetUserId}</code>: ${escapeHtml(error.message)}. Please check logs.`, { parse_mode: 'HTML' });
    }

    console.log(`[Admin] Admin ${cid} initiated /add for user ${targetUserId}. Prompting for app selection.`);

    try {
        const sentMsg = await bot.sendMessage(cid, `Select the app to assign to user <code>${targetUserId}</code>:`, { parse_mode: 'HTML' });
        userStates[cid] = {
            step: 'AWAITING_APP_FOR_ADD',
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid}:`, userStates[cid]);
        sendAppList(cid, sentMsg.message_id, 'add_assign_app', targetUserId);
    } catch (error) {
        console.error("Error sending initial /add message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the add process. Please try again.");
    }
});

bot.onText(/^\/info (\d+)$/, async (msg, match) => {
    const callerId = msg.chat.id.toString();
    await updateUserActivity(callerId);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /info
    const targetUserId = match[1];

    if (callerId !== ADMIN_ID) {
        return bot.sendMessage(callerId, "You are not authorized to use this command.");
    }

    try {
        const targetChat = await bot.getChat(targetUserId);
        const firstName = targetChat.first_name ? escapeHtml(targetChat.first_name) : 'N/A';
        const lastName = targetChat.last_name ? escapeHtml(targetChat.last_name) : 'N/A';
        const username = targetChat.username ? escapeHtml(targetChat.username) : 'N/A';
        const userIdEscaped = escapeHtml(targetUserId);

        let userDetails = `<b>Telegram User Info for ID:</b> <code>${userIdEscaped}</code>\n\n`;
        userDetails += `<b>First Name:</b> ${firstName}\n`;
        userDetails += `<b>Last Name:</b> ${lastName}\n`;
        userDetails += `<b>Username:</b> ${targetChat.username ? `<a href="https://t.me/${username}">@${username}</a>` : 'N/A'}\n`;
        userDetails += `<b>Type:</b> ${escapeHtml(targetChat.type)}\n`;

        if (targetChat.username) {
            userDetails += `<b>Profile Link:</b> <a href="https://t.me/${username}">t.me/${username}</a>\n`;
        }

        // Fetch bots deployed by this user
        const userBots = await getUserBots(targetUserId);
        if (userBots.length > 0) {
            userDetails += `\n<b>Deployed Bots:</b>\n`;
            for (const botName of userBots) {
                userDetails += `  - <code>${escapeHtml(botName)}</code>\n`;
            }
        } else {
            userDetails += `\n<b>Deployed Bots:</b> None\n`;
        }

        // Fetch user's last seen activity
        const lastSeen = await getUserLastSeen(targetUserId);
        userDetails += `<b>Last Activity:</b> ${lastSeen ? new Date(lastSeen).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' }) : 'Never seen (or no recent activity)'}\n`;


        await bot.sendMessage(callerId, userDetails, { parse_mode: 'HTML' });

    } catch (error) {
        console.error(`Error fetching user info for ID ${targetUserId}:`, error.message);

        if (error.response && error.response.body && error.response.body.description) {
            const apiError = error.response.body.description;
            if (apiError.includes("chat not found") || apiError.includes("user not found")) {
                await bot.sendMessage(callerId, `User with ID <code>${targetUserId}</code> not found or has not interacted with the bot.`, { parse_mode: 'HTML' });
            } else if (apiError.includes("bot was blocked by the user")) {
                await bot.sendMessage(callerId, `The bot is blocked by user <code>${targetUserId}</code>. Cannot retrieve info.`, { parse_mode: 'HTML' });
            } else {
                await bot.sendMessage(callerId, `An unexpected error occurred while fetching info for user <code>${targetUserId}</code>: ${escapeHtml(apiError)}`, { parse_mode: 'HTML' });
            }
        } else {
            console.error(`Full unexpected error object for ID ${targetUserId}:`, JSON.stringify(error, null, 2));
            await bot.sendMessage(callerId, `An unexpected error occurred while fetching info for user <code>${targetUserId}</code>. Please check server logs for details.`, { parse_mode: 'HTML' });
        }
    }
});

// New /remove <user_id> command for admin
bot.onText(/^\/remove (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    await updateUserActivity(cid);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /remove
    const targetUserId = match[1];

    console.log(`[Admin] /remove command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /remove attempt by ${cid}.`);
        return bot.sendMessage(cid, "You are not authorized to use this command.");
    }

    delete userStates[cid]; // Clear user state
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    const userBots = await getUserBots(targetUserId);
    if (!userBots.length) {
        return bot.sendMessage(cid, `User <code>${targetUserId}</code> has no bots deployed via this system.`, { parse_mode: 'HTML' });
    }

    console.log(`[Admin] Admin ${cid} initiated /remove for user ${targetUserId}. Prompting for app removal selection.`);

    try {
        const sentMsg = await bot.sendMessage(cid, `Select app to remove from user <code>${targetUserId}</code>'s dashboard:`, { parse_mode: 'HTML' });

        userStates[cid] = {
            step: 'AWAITING_APP_FOR_REMOVAL',
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid} for removal:`, userStates[cid]);

        const rows = chunkArray(userBots, 3).map(r => r.map(name => ({
            text: name,
            callback_data: `remove_app_from_user:${name}:${targetUserId}`
        })));

        await bot.editMessageReplyMarkup({ inline_keyboard: rows }, {
            chat_id: cid,
            message_id: sentMsg.message_id
        });

    } catch (error) {
        console.error("Error sending initial /remove message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the removal process. Please try again.");
    }
});

// NEW: /askadmin command for users to initiate support
bot.onText(/^\/askadmin (.+)$/, async (msg, match) => {
    const userQuestion = match[1];
    const userChatId = msg.chat.id.toString();
    await updateUserActivity(userChatId);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /askadmin
    const userMessageId = msg.message_id;

    if (userChatId === ADMIN_ID) {
        return bot.sendMessage(userChatId, "You are the admin, you cannot ask yourself questions!");
    }

    try {
        const adminMessage = await bot.sendMessage(ADMIN_ID,
            `<b>New Suggestion/Feedback from User:</b> <code>${userChatId}</code> (U: @${msg.from.username || msg.from.first_name || 'N/A'})\n\n` +
            `<b>Message:</b> ${escapeHtml(userQuestion)}\n\n` +
            `_Reply to this message to send your response back to the user._`,
            { parse_mode: 'HTML' }
        );

        forwardingContext[adminMessage.message_id] = {
            original_user_chat_id: userChatId,
            original_user_message_id: userMessageId,
            request_type: 'support_question'
        };
        console.log(`[Forwarding] Stored context for admin message ${adminMessage.message_id}:`, forwardingContext[adminMessage.message_id]);

        await bot.sendMessage(userChatId, 'Your suggestion/feedback has been sent to the admin. Thank you for your input!');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, 'Failed to send your suggestion/feedback to the admin. Please try again later.');
    }
});

// NEW ADMIN COMMAND: /stats
bot.onText(/^\/stats$/, async (msg) => {
    const cid = msg.chat.id.toString();
    await updateUserActivity(cid);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /stats
    if (cid !== ADMIN_ID) {
        return bot.sendMessage(cid, "You are not authorized to use this command.");
    }

    try {
        const totalUsersResult = await pool.query('SELECT COUNT(DISTINCT user_id) AS total_users FROM user_bots');
        const totalUsers = totalUsersResult.rows[0].total_users;

        const totalBotsResult = await pool.query('SELECT COUNT(bot_name) AS total_bots FROM user_bots');
        const totalBots = totalBotsResult.rows[0].total_bots;

        const activeKeys = await getAllDeployKeys();
        let keyDetails = '';
        if (activeKeys.length > 0) {
            keyDetails = activeKeys.map(k => `<code>${escapeHtml(k.key)}</code> (Uses Left: ${k.uses_left}, By: ${escapeHtml(k.created_by || 'N/A')})`).join('\n');
        } else {
            keyDetails = 'No active deploy keys.';
        }

        const totalFreeTrialUsersResult = await pool.query('SELECT COUNT(DISTINCT user_id) AS total_trial_users FROM temp_deploys');
        const totalFreeTrialUsers = totalFreeTrialUsersResult.rows[0].total_trial_users;

        const statsMessage = `
<b>Bot Statistics:</b>

<b>Total Unique Users:</b> ${totalUsers}
<b>Total Deployed Bots:</b> ${totalBots}
<b>Users Who Used Free Trial:</b> ${totalFreeTrialUsers}

<b>Active Deploy Keys:</b>
${keyDetails}
        `;

        await bot.sendMessage(cid, statsMessage, { parse_mode: 'HTML' });

    } catch (error) {
        console.error(`Error fetching stats:`, error.message);
        await bot.sendMessage(cid, `An error occurred while fetching stats: ${escapeHtml(error.message)}`);
    }
});

// NEW ADMIN COMMAND: /users
bot.onText(/^\/users$/, async (msg) => {
    const cid = msg.chat.id.toString();
    await updateUserActivity(cid);
    await notifyAdminUserOnline(msg); // Notify admin when a user uses /users
    if (cid !== ADMIN_ID) {
        return bot.sendMessage(cid, "You are not authorized to use this command.");
    }

    try {
        const userEntries = await pool.query('SELECT DISTINCT user_id FROM user_bots ORDER BY user_id');
        const userIds = userEntries.rows.map(row => row.user_id);

        if (userIds.length === 0) {
            return bot.sendMessage(cid, "No users have deployed bots yet.");
        }

        let responseMessage = '<b>Registered Users:</b>\n\n';
        const maxUsersPerMessage = 10;
        let userCounter = 0;

        for (const userId of userIds) {
            try {
                const targetChat = await bot.getChat(userId);
                const firstName = targetChat.first_name ? escapeHtml(targetChat.first_name) : 'N/A';
                const lastName = targetChat.last_name ? escapeHtml(targetChat.last_name) : 'N/A';
                const username = targetChat.username ? escapeHtml(targetChat.username) : 'N/A';
                const userIdEscaped = escapeHtml(userId);

                const bots = await getUserBots(userId);
                let botList = bots.length > 0 ? bots.map(b => `<code>${escapeHtml(b)}</code>`).join(', ') : 'None';

                const lastSeen = await getUserLastSeen(userId);
                const lastSeenText = lastSeen ? new Date(lastSeen).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' }) : 'N/A';

                responseMessage += `<b>ID:</b> <code>${userIdEscaped}</code>\n`;
                responseMessage += `<b>Name:</b> ${firstName} ${lastName}\n`;
                responseMessage += `<b>Username:</b> ${targetChat.username ? `<a href="https://t.me/${username}">@${username}</a>` : 'N/A'}\n`;
                responseMessage += `<b>Deployed Bots:</b> ${botList}\n`;
                responseMessage += `<b>Last Activity:</b> ${lastSeenText}\n\n`;

                userCounter++;

                if (userCounter % maxUsersPerMessage === 0 && userIds.indexOf(userId) < userIds.length - 1) {
                    await bot.sendMessage(cid, responseMessage, { parse_mode: 'HTML' });
                    responseMessage = '<b>Registered Users (continued):</b>\n\n';
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

                await new Promise(resolve => setTimeout(resolve, 300));

            } catch (error) {
                console.error(`Error fetching Telegram info or bots for user ${userId}:`, error.message);
                if (error.response && error.response.body && error.response.body.description && (error.response.body.description.includes("chat not found") || error.response.body.description.includes("user not found"))) {
                     responseMessage += `<b>ID:</b> <code>${escapeHtml(userId)}</code>\n<b>Status:</b> User chat not found or bot blocked.\n\n`;
                } else {
                     responseMessage += `<b>ID:</b> <code>${escapeHtml(userId)}</code>\n<b>Status:</b> Error fetching info: ${escapeHtml(error.message)}\n\n`;
                }
                 await new Promise(resolve => setTimeout(resolve, 300));
            }
        }

        if (responseMessage.trim() !== '<b>Registered Users (continued):</b>' && responseMessage.trim() !== '<b>Registered Users:</b>') {
            await bot.sendMessage(cid, responseMessage, { parse_mode: 'HTML' });
        }

    } catch (error) {
        console.error(`Error fetching user list:`, error.message);
        await bot.sendMessage(cid, `An error occurred while fetching the user list: ${escapeHtml(error.message)}`);
    }
});


// 12) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  await updateUserActivity(cid); // Update user activity on any message
  await notifyAdminUserOnline(msg); // Call the notification function here

  if (isMaintenanceMode && cid !== ADMIN_ID) {
      await bot.sendMessage(cid, "Bot is currently undergoing maintenance. Please check back later.");
      return;
  }

  const st = userStates[cid];
  const isAdmin = cid === ADMIN_ID;

  if (isAdmin && st && st.step === 'AWAITING_ADMIN_PAIRING_CODE_INPUT') {
      const pairingCode = text.trim();
      const pairingCodeRegex = /^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/;

      if (!pairingCodeRegex.test(pairingCode)) {
          return bot.sendMessage(cid, 'Invalid pairing code format. Please send a 9-character alphanumeric code with a hyphen (e.g., `ABCD-1234`).');
      }

      const { targetUserId, userWaitingMessageId, userAnimateIntervalId } = st.data;

      if (userAnimateIntervalId) {
          clearInterval(userAnimateIntervalId);
          if (userWaitingMessageId) {
              await bot.editMessageText(`Your pairing-code is now ready!`, {
                  chat_id: targetUserId,
                  message_id: userWaitingMessageId
              }).catch(err => console.error(`Failed to edit user's waiting message to "ready": ${err.message}`));
          }
      }

      try {
          await bot.sendMessage(targetUserId,
              `Your Pairing-code is:\n\n` +
              `<code>${escapeHtml(pairingCode)}</code>\n\n` +
              `Tap to Copy the CODE and paste it to your WhatsApp linked device as soon as possible!\n\n` +
              `When you are ready, tap the 'Deploy' button to continue.`,
              { parse_mode: 'HTML' }
          );
          await bot.sendMessage(cid, `Pairing code sent to user <code>${targetUserId}</code>.`, { parse_mode: 'HTML' });

          delete userStates[targetUserId];
          delete userStates[cid];
          console.log(`[Pairing] Pairing code sent by admin to user ${targetUserId}. Admin and user states cleared/updated.`);

      } catch (e) {
          console.error(`Error sending pairing code to user ${targetUserId}:`, e);
          await bot.sendMessage(cid, `Failed to send pairing code to user <code>${targetUserId}</code>. They might have blocked the bot or the chat no longer exists.`, { parse_mode: 'HTML' });
      }
      return;
  }

  if (st && st.step === 'AWAITING_OTHER_VAR_VALUE') {
      const { APP_NAME, VAR_NAME, targetUserId: targetUserIdFromState } = st.data;
      const varValue = text.trim();

      try {
          await bot.sendChatAction(cid, 'typing');
          const updateMsg = await bot.sendMessage(cid, `Updating <b>${escapeHtml(VAR_NAME)}</b> for "<b>${escapeHtml(APP_NAME)}</b>"...`, { parse_mode: 'HTML' });

          console.log(`[API_CALL] Patching Heroku config vars for ${APP_NAME}: { ${VAR_NAME}: '***' }`);
          const patchResponse = await axios.patch(
              `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
              { [VAR_NAME]: varValue },
              {
                  headers: {
                      Authorization: `Bearer ${HEROKU_API_KEY}`,
                      Accept: 'application/vnd.heroku+json; version=3',
                      'Content-Type': 'application/json'
                  }
              }
          );
          console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${APP_NAME}. Status: ${patchResponse.status}`);

          await bot.editMessageText(`Variable <b>${escapeHtml(VAR_NAME)}</b> for "<b>${escapeHtml(APP_NAME)}</b>" updated successfully!`, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'HTML'
          });
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error updating variable: ${escapeHtml(errorMsg)}`, { parse_mode: 'HTML' });
      } finally {
          delete userStates[cid];
      }
      return;
  }

  if (st && st.step === 'AWAITING_OTHER_VAR_NAME') {
      const { APP_NAME, targetUserId: targetUserIdFromState } = st.data;
      const varName = text.trim().toUpperCase();

      if (!/^[A-Z0-9_]+$/.test(varName)) {
          return bot.sendMessage(cid, 'Invalid variable name. Please use only uppercase letters, numbers, and underscores.');
      }

      if (varName === 'SUDO') {
          delete userStates[cid];
          const currentMessageId = st.message_id || msg.message_id;

          if (currentMessageId) {
            await bot.editMessageText(`The <b>SUDO</b> variable must be managed using "Add Number" or "Remove Number" options. How do you want to manage it for "<b>${escapeHtml(APP_NAME)}</b>"?`, {
                chat_id: cid,
                message_id: currentMessageId,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Add Number', callback_data: `sudo_action:add:${APP_NAME}` }],
                        [{ text: 'Remove Number', callback_data: `sudo_action:remove:${APP_NAME}` }],
                        [{ text: 'Back to Set Variable Menu', callback_data: `setvar:${APP_NAME}` }]
                    ]
                }
            }).catch(err => console.error(`Failed to edit message in AWAITING_OTHER_VAR_NAME for SUDO: ${err.message}`));
          } else {
             await bot.sendMessage(cid, `The <b>SUDO</b> variable must be managed using "Add Number" or "Remove Number" options. How do you want to manage it for "<b>${escapeHtml(APP_NAME)}</b>"?`, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Add Number', callback_data: `sudo_action:add:${APP_NAME}` }],
                        [{ text: 'Remove Number', callback_data: `sudo_action:remove:${APP_NAME}` }],
                        [{ text: 'Back to Set Variable Menu', callback_data: `setvar:${APP_NAME}` }]
                    ]
                }
            });
          }
          return;
      }

      try {
          const configRes = await axios.get(
              `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
              { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
          );
          const existingConfigVars = configRes.data;

          if (existingConfigVars.hasOwnProperty(varName)) {
              userStates[cid].step = 'AWAITING_OVERWRITE_CONFIRMATION';
              userStates[cid].data.VAR_NAME = varName;
              userStates[cid].data.APP_NAME = APP_NAME;
              userStates[cid].data.targetUserId = targetUserIdFromState;
              const message = `Variable <b>${escapeHtml(varName)}</b> already exists for "<b>${escapeHtml(APP_NAME)}</b>" with value: <code>${escapeHtml(String(existingConfigVars[varName]))}</code>\n\nDo you want to overwrite it?`;
              await bot.sendMessage(cid, message, {
                  parse_mode: 'HTML',
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Yes, Overwrite', callback_data: `overwrite_var:yes:${varName}:${APP_NAME}` }],
                          [{ text: 'No, Cancel', callback_data: `overwrite_var:no:${varName}:${APP_NAME}` }]
                      ]
                  }
              });
          } else {
              userStates[cid].step = 'AWAITING_OTHER_VAR_VALUE';
              userStates[cid].data.VAR_NAME = varName;
              userStates[cid].data.APP_NAME = APP_NAME;
              userStates[cid].data.targetUserId = targetUserIdFromState;
              return bot.sendMessage(cid, `Please enter the value for <b>${escapeHtml(varName)}</b>:`, { parse_mode: 'HTML' });
          }
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL] Error checking existence of variable ${varName} for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error checking variable existence: ${escapeHtml(errorMsg)}`, { parse_mode: 'HTML' });
          delete userStates[cid];
      }
      return;
  }

  if (st && st.step === 'AWAITING_OVERWRITE_CONFIRMATION') {
      return bot.sendMessage(cid, 'Please use the "Yes" or "No" buttons to confirm.');
  }

  if (st && st.step === 'AWAITING_SUDO_ADD_NUMBER') {
      const { APP_NAME } = st.data;
      const phoneNumber = text.trim();

      if (!/^\d+$/.test(phoneNumber)) {
          return bot.sendMessage(cid, 'Invalid input. Please enter numbers only, without plus signs or spaces. Example: <code>2349163916314</code>', { parse_mode: 'HTML' });
      }

      try {
          await bot.sendChatAction(cid, 'typing');
          const updateMsg = await bot.sendMessage(cid, `Adding number to SUDO variable for "<b>${escapeHtml(APP_NAME)}</b>"...`, { parse_mode: 'HTML' });

          const configRes = await axios.get(
              `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
              {
                  headers: {
                      Authorization: `Bearer ${HEROKU_API_KEY}`,
                      Accept: 'application/vnd.heroku+json; version=3',
                      'Content-Type': 'application/json'
                  }
              }
          );
          const currentSudo = configRes.data.SUDO || '';

          const newSudoValue = currentSudo ? `${currentSudo},${phoneNumber}` : phoneNumber;

          console.log(`[API_CALL] Patching Heroku config vars for ${APP_NAME}: { SUDO: '***' }`);
          const patchResponse = await axios.patch(
              `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
              { SUDO: newSudoValue },
              {
                  headers: {
                      Authorization: `Bearer ${HEROKU_API_KEY}`,
                      Accept: 'application/vnd.heroku+json; version=3',
                      'Content-Type': 'application/json'
                  }
              }
          );
          console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${APP_NAME}. Status: ${patchResponse.status}`);

          await bot.editMessageText(`Number added to SUDO variable for "<b>${escapeHtml(APP_NAME)}</b>" successfully! New value: <code>${escapeHtml(newSudoValue)}</code>`, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'HTML'
          });
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL] Error updating SUDO variable for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error updating SUDO variable: ${escapeHtml(errorMsg)}`, { parse_mode: 'HTML' });
      } finally {
          delete userStates[cid];
      }
      return;
  }

  if (st && st.step === 'AWAITING_SUDO_REMOVE_NUMBER') {
    const { APP_NAME } = st.data;
    const numberToRemove = text.trim();

    st.data.attempts = (st.data.attempts || 0) + 1;

    if (!/^\d+$/.test(numberToRemove)) {
        if (st.data.attempts >= 3) {
            delete userStates[cid];
            return bot.sendMessage(cid, 'Too many invalid attempts. Please try again later.');
        }
        return bot.sendMessage(cid, `Invalid input. Please enter numbers only, without plus signs or spaces. Example: <code>2349163916314</code> (Attempt ${st.data.attempts} of 3)`, { parse_mode: 'HTML' });
    }

    if (ADMIN_SUDO_NUMBERS.includes(numberToRemove)) {
        if (st.data.attempts >= 3) {
            delete userStates[cid];
            return bot.sendMessage(cid, "Too many attempts to remove an admin number. Please try again later.");
        }
        return bot.sendMessage(cid, `You cannot remove the admin number. (Attempt ${st.data.attempts} of 3)`);
    }

    try {
        await bot.sendChatAction(cid, 'typing');
        const updateMsg = await bot.sendMessage(cid, `Attempting to remove number from SUDO for "<b>${escapeHtml(APP_NAME)}</b>"...`, { parse_mode: 'HTML' });

        const configRes = await axios.get(
            `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        );
        const currentSudo = configRes.data.SUDO || '';
        let sudoNumbers = currentSudo.split(',').map(s => s.trim()).filter(Boolean);

        const initialLength = sudoNumbers.length;
        sudoNumbers = sudoNumbers.filter(num => num !== numberToRemove);

        if (sudoNumbers.length === initialLength) {
            if (st.data.attempts >= 3) {
                delete userStates[cid];
                return bot.editMessageText(`Number <code>${escapeHtml(numberToRemove)}</code> not found in SUDO variable. Too many attempts. Please try again later.`, {
                    chat_id: cid,
                    message_id: updateMsg.message_id,
                    parse_mode: 'HTML'
                });
            }
            await bot.editMessageText(`Number <code>${escapeHtml(numberToRemove)}</code> not found in SUDO variable for "<b>${escapeHtml(APP_NAME)}</b>". No changes made. You have ${3 - st.data.attempts} attempts left.`, {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'HTML'
            });
        } else {
            const newSudoValue = sudoNumbers.join(',');
            await axios.patch(
                `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
                { SUDO: newSudoValue },
                {
                    headers: {
                        Authorization: `Bearer ${HEROKU_API_KEY}`,
                        Accept: 'application/vnd.heroku+json; version=3',
                        'Content-Type': 'application/json'
                    }
                }
            );
            await bot.editMessageText(`Number <code>${escapeHtml(numberToRemove)}</code> removed from SUDO variable for "<b>${escapeHtml(APP_NAME)}</b>" successfully! New value: <code>${escapeHtml(newSudoValue)}</code>`, {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'HTML'
            });
            delete userStates[cid];
        }
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[API_CALL] Error removing SUDO number for ${APP_NAME}:`, errorMsg, e.response?.data);
        await bot.sendMessage(cid, `Error removing number from SUDO variable: ${escapeHtml(errorMsg)}`, { parse_mode: 'HTML' });
        delete userStates[cid];
    }
    return;
  }


  if (msg.reply_to_message && msg.reply_to_message.from.id.toString() === bot.options.id.toString()) {
      const repliedToBotMessageId = msg.reply_to_message.message_id;
      const context = forwardingContext[repliedToBotMessageId];

      if (context && context.request_type === 'support_question' && cid === ADMIN_ID) {
          const { original_user_chat_id, original_user_message_id } = context;
          try {
              await bot.sendMessage(original_user_chat_id, `<b>Admin replied:</b>\n${escapeHtml(msg.text)}`, {
                  parse_mode: 'HTML',
                  reply_to_message_id: original_user_message_id
              });
              await bot.sendMessage(cid, 'Your reply has been sent to the user.');
              delete forwardingContext[repliedToBotMessageId];
              console.log(`[Forwarding] Context for support question reply ${repliedToBotMessageId} cleared.`);
          } catch (e) {
              console.error('Error forwarding admin reply (support question):', e);
              await bot.sendMessage(cid, 'Failed to send your reply to the user. They might have blocked the bot or the chat no longer exists.');
          }
          return;
      }
      console.log(`Received reply to bot message ${repliedToBotMessageId} from ${cid} but not a support question reply. Ignoring.`);
      return;
  }

  if (st && st.step === 'AWAITING_ADMIN_QUESTION_TEXT') { // This is Suggestions/Feedback now
    const userQuestion = msg.text;
    const userChatId = cid;
    const userMessageId = msg.message_id;

    try {
        const adminMessage = await bot.sendMessage(ADMIN_ID,
            `<b>New Suggestion/Feedback from User:</b> <code>${userChatId}</code> (U: <a href="https://t.me/${escapeHtml(msg.from.username || msg.from.first_name || 'N/A')}">@${escapeHtml(msg.from.username || msg.from.first_name || 'N/A')}</a>)\n\n` +
            `<b>Message:</b> ${escapeHtml(userQuestion)}\n\n` +
            `<i>Reply to this message to send your response back to the user.</i>`,
            { parse_mode: 'HTML' }
        );

        forwardingContext[adminMessage.message_id] = {
            original_user_chat_id: userChatId,
            original_user_message_id: userMessageId,
            request_type: 'support_question'
        };
        console.log(`[Forwarding] Stored context for admin message ${adminMessage.message_id}:`, forwardingContext[adminMessage.message_id]);

        await bot.sendMessage(userChatId, 'Your suggestion/feedback has been sent to the admin. Thank you for your input!');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, 'Failed to send your suggestion/feedback to the admin. Please try again later.');
    } finally {
        delete userStates[cid];
    }
    return;
  }


  if (text === 'Deploy') {
    if (isAdmin) {
      userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Enter your session ID or get it from the website: <a href="https://levanter-delta.vercel.app/">https://levanter-delta.vercel.app/</a>', { parse_mode: 'HTML' });
    } else {
      userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Enter your Deploy key');
    }
  }

  if (text === 'Free Trial') {
    const check = await canDeployFreeTrial(cid);
    if (!check.can) {
        return bot.sendMessage(cid, `You have already used your Free Trial. You can use it again after: ${check.cooldown.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' })}`, { parse_mode: 'HTML' });
    }
    userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: true } };
    return bot.sendMessage(cid, 'Free Trial (1 hour runtime, 14-day cooldown) initiated. Send your session ID or get it from the website: <a href="https://levanter-delta.vercel.app/">https://levanter-delta.vercel.app/</a>', { parse_mode: 'HTML' });
  }

  if (text === 'Apps' && isAdmin) {
    return sendAppList(cid);
  }

  if (text === 'Generate Key' && isAdmin) {
    const buttons = [
      [1, 2, 3, 4, 5].map(n => ({
        text: String(n),
        callback_data: `genkeyuses:${n}`
      }))
    ];
    return bot.sendMessage(cid, 'How many uses for this key?', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  if (text === 'Get Session') {
      delete userStates[cid];
      userStates[cid] = { step: 'AWAITING_PHONE_NUMBER', data: {} };

      await bot.sendMessage(cid,
          'Please send your WhatsApp number in the full international format including the `+` e.g., `+23491630000000`.',
          {
              parse_mode: 'HTML'
          }
      );
      return;
  }

  if (text === 'My Bots') {
    console.log(`[Flow] My Bots button clicked by user: ${cid}`);
    const bots = await getUserBots(cid);
    if (!bots.length) {
        return bot.sendMessage(cid, "You have not deployed any bots yet. Would you like to deploy your first bot?", {
            reply_markup: {
                inline_keyboard: [[{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }]]
            }
        });
    }
    const rows = chunkArray(bots, 3).map(r => r.map(n => ({
      text: n,
      callback_data: `selectbot:${n}`
    })));
    return bot.sendMessage(cid, 'Your deployed bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  if (text === 'Support') {
    const supportKeyboard = {
        inline_keyboard: [
            [{ text: 'Suggestions/Feedback', callback_data: 'ask_admin_question' }], // Updated button text
            [{ text: 'Contact Admin Directly', url: 'https://t.me/star_ies1' }]
        ]
    };
    return bot.sendMessage(cid, `For help, you can contact the admin directly:`, {
        reply_markup: supportKeyboard,
        parse_mode: 'HTML'
    });
  }

  if (text === 'FAQ') {
      // Clear previous state for consistency, but retain message_id if existing for edit
      if (userStates[cid] && userStates[cid].step === 'VIEWING_FAQ') {
          // If already in FAQ, just refresh the current page, no notice
          await sendFaqPage(cid, userStates[cid].faqMessageId, userStates[cid].faqPage || 1);
      } else {
          // First time opening FAQ
          delete userStates[cid]; // Clear previous general states
          await bot.sendMessage(cid, 'Please note that your bot might go offline temporarily at the end or beginning of every month. We appreciate your patience during these periods.', { parse_mode: 'HTML' });
          await sendFaqPage(cid, null, 1); // Send first page of FAQs, null means new message
      }
      return;
  }

  if (st && st.step === 'AWAITING_PHONE_NUMBER') {
    const phoneNumber = text;
    const phoneRegex = /^\+\d{13}$/;

    if (!phoneRegex.test(phoneNumber)) {
        return bot.sendMessage(cid, 'Invalid format. Please send your WhatsApp number in the full international format `+2349163XXXXXXX` (14 characters, including the `+`), e.g., `+23491630000000`. Or get your session ID from the website: <a href="https://levanter-delta.vercel.app/">https://levanter-delta.vercel.app/</a>', { parse_mode: 'HTML' });
    }

    const { first_name, last_name, username } = msg.from;
    const userDetails = `User: <code>${cid}</code> (TG: <a href="https://t.me/${escapeHtml(username || first_name || 'N/A')}">@${escapeHtml(username || first_name || 'N/A')}</a>)`;

    const adminMessage = await bot.sendMessage(ADMIN_ID,
        `<b>Pairing Request from User:</b>\n` +
        `${userDetails}\n` +
        `<b>WhatsApp Number:</b> <code>${escapeHtml(phoneNumber)}</code>\n\n` +
        `Do you want to accept this pairing request and provide a code?`,
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Accept Request', callback_data: `pairing_action:accept:${cid}` }],
                    [{ text: 'Decline Request', callback_data: `pairing_action:decline:${cid}` }]
                ]
            }
        }
    );

    const waitingMsg = await bot.sendMessage(cid, `Your request has been sent to the admin. Please wait for the Pairing-code...`);
    const animateIntervalId = await animateMessage(cid, waitingMsg.message_id, 'Waiting for Pairing-code');
    userStates[cid].step = 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN';
    userStates[cid].data = {
        messageId: waitingMsg.message_id,
        animateIntervalId: animateIntervalId,
        isFreeTrial: st?.data?.isFreeTrial || false,
        isAdminDeploy: st?.data?.isAdminDeploy || false
    };

    const timeoutIdForPairing = setTimeout(async () => {
        if (userStates[cid] && userStates[cid].step === 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN') {
            console.log(`[Pairing Timeout] Request from user ${cid} timed out.`);
            if (userStates[cid].data.animateIntervalId) {
                clearInterval(userStates[cid].data.animateIntervalId);
            }
            if (userStates[cid].data.messageId) {
                await bot.editMessageText('Pairing request timed out. The admin did not respond in time. Or get your session ID from the website: <a href="https://levanter-delta.vercel.app/">https://levanter-delta.vercel.app/</a>', {
                    chat_id: cid,
                    message_id: userStates[cid].data.messageId,
                    parse_mode: 'HTML'
                }).catch(err => console.error(`Failed to edit user's timeout message: ${err.message}`));
            }
            await bot.sendMessage(ADMIN_ID, `Pairing request from user <code>${cid}</code> (Phone: <code>${escapeHtml(phoneNumber)}</code>) timed out after 60 seconds.`, { parse_mode: 'HTML' });
            delete userStates[cid];
            for (const key in forwardingContext) {
                if (forwardingContext[key].original_user_chat_id === cid && forwardingContext[key].request_type === 'pairing_request') {
                    delete forwardingContext[key];
                    console.log(`[Pairing Timeout] Cleaned up stale forwardingContext for admin message ${key}.`);
                    break;
                }
            }
        }
    }, 60 * 1000);

    forwardingContext[adminMessage.message_id] = {
        original_user_chat_id: cid,
        original_user_message_id: msg.message_id,
        user_phone_number: phoneNumber,
        request_type: 'pairing_request',
        user_waiting_message_id: waitingMsg.message_id,
        user_animate_interval_id: animateIntervalId,
        timeout_id_for_pairing_request: timeoutIdForPairing
    };
    console.log(`[Pairing] Stored context for admin message ${adminMessage.message_id}:`, forwardingContext[adminMessage.message_id]);

    return;
  }


    if (st && st.step === 'AWAITING_KEY') {
    const keyAttempt = text.toUpperCase();

    const verificationMsg = await bot.sendMessage(cid, `Verifying key...`);
    await bot.sendChatAction(cid, 'typing');
    const animateIntervalId = await animateMessage(cid, verificationMsg.message_id, 'Verifying key...');

    const startTime = Date.now();
    const usesLeft = await useDeployKey(keyAttempt);
    const elapsedTime = Date.now() - startTime;
    const remainingDelay = 5000 - elapsedTime;
    if (remainingDelay > 0) {
        await new Promise(r => setTimeout(r, remainingDelay));
    }

    clearInterval(animateIntervalId);

    if (usesLeft === null) {
      const contactOwnerMessage = `Invalid. Please contact the owner for a KEY.`;
      const contactOwnerKeyboard = {
          inline_keyboard: [
              [
                  { text: 'Contact Owner (WhatsApp)', url: 'https://wa.me/message/JIIC2JFMHUPEM1' },
                  { text: 'Contact Owner (Telegram)', url: 'https://t.me/star_ies1' }
              ]
          ]
      };
      await bot.editMessageText(contactOwnerMessage, {
        chat_id: cid,
        message_id: verificationMsg.message_id,
        reply_markup: contactOwnerKeyboard,
        parse_mode: 'HTML'
      });
      return;
    }


    await bot.editMessageText(`Verified! Now send your SESSION ID.`, {
        chat_id: cid,
        message_id: verificationMsg.message_id
    });
    await new Promise(r => setTimeout(r, 1000)); // Short delay before proceeding to next step.

    authorizedUsers.add(cid);
    st.step = 'SESSION_ID'; // Transition to the next state to await the session ID.

    const { first_name, last_name, username } = msg.from;
    const userDetails = [
      `<b>Name:</b> ${first_name ? escapeHtml(first_name) : 'N/A'} ${last_name ? escapeHtml(last_name) : ''}`,
      `<b>Username:</b> ${username ? `<a href="https://t.me/${escapeHtml(username)}">@${escapeHtml(username)}</a>` : 'N/A'}`,
      `<b>Chat ID:</b> <code>${cid}</code>`
    ].join('\n');

    await bot.sendMessage(ADMIN_ID,
      `<b>Key Used By:</b>\n${userDetails}\n\n<b>Uses Left:</b> ${usesLeft}`,
      { parse_mode: 'HTML' }
    );
    // The flow will now correctly wait for the SESSION_ID input in the next message.
    return;
  }

  if (st && st.step === 'SESSION_ID') {
    const sessionID = text.trim(); // Get the session ID from user input
    // Validate session ID starts with 'levanter_'
    if (!sessionID.startsWith('levanter_')) {
      return bot.sendMessage(cid, 'Incorrect session ID. Your session ID must start with <code>levanter_</code>. Please try again.', { parse_mode: 'HTML' });
    }
    if (sessionID.length < 10) {
      return bot.sendMessage(cid, 'Session ID must be at least 10 characters long.');
    }
    st.data.SESSION_ID = sessionID;
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, 'Great. Now enter a name for your bot (e.g., utarbot123):');
  }

  if (st && st.step === 'APP_NAME') {
    const nm = text.toLowerCase().replace(/\s+/g, '-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid, 'Invalid name. Use at least 5 lowercase letters, numbers, or hyphens.');
    }
    await bot.sendChatAction(cid, 'typing');
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `The name "<b>${nm}</b>" is already taken. Please choose another.`, { parse_mode: 'HTML' });
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = nm;

        st.step = 'AWAITING_WIZARD_CHOICE';

        const wizardText = `App name "<b>${nm}</b>" is available.\n\n<b>Next Step:</b>\nEnable automatic status view? This marks statuses as seen automatically.`;
        const wizardKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Yes (Recommended)', callback_data: `setup:autostatus:true` },
                        { text: 'No', callback_data: `setup:autostatus:false` }
                    ]
                ]
            }
        };
        const wizardMsg = await bot.sendMessage(cid, wizardText, { ...wizardKeyboard, parse_mode: 'HTML' });
        st.message_id = wizardMsg.message_id;

      } else {
        console.error(`Error checking app name "${nm}":`, e.response?.data?.message || e.message);
        return bot.sendMessage(cid, `Could not verify app name. The Heroku API might be down. Please try again later.`, { parse_mode: 'HTML' });
      }
    }
  }

  if (st && st.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = st.data;
    const newVal = text.trim();

    if (VAR_NAME === 'SESSION_ID') {
        // Validate session ID starts with 'levanter_' or is empty to clear
        if (!newVal.startsWith('levanter_') && newVal !== '') {
            return bot.sendMessage(cid, 'Incorrect session ID. Your session ID must start with <code>levanter_</code>, or be empty to clear it. Please try again.', { parse_mode: 'HTML' });
        }
        if (newVal.length < 10 && newVal !== '') {
            return bot.sendMessage(cid, 'Session ID must be at least 10 characters long, or empty to clear.');
        }
    }


    try {
      await bot.sendChatAction(cid, 'typing');
      const updateMsg = await bot.sendMessage(cid, `Updating <b>${escapeHtml(VAR_NAME)}</b> for "<b>${escapeHtml(APP_NAME)}</b>"...`, { parse_mode: 'HTML' });

      console.log(`[API_CALL] Patching Heroku config vars for ${APP_NAME}: { ${VAR_NAME}: '***' }`);
      const patchResponse = await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: newVal },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
          }
        }
      );
      console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${APP_NAME}. Status: ${patchResponse.status}`);

      if (VAR_NAME === 'SESSION_ID') {
          console.log(`[Flow] SETVAR_ENTER_VALUE: Config var updated for "${APP_NAME}". Updating bot in user_bots DB for user "${cid}".`);
          await addUserBot(cid, APP_NAME, newVal);
      }

      const baseWaitingText = `Updated <b>${escapeHtml(VAR_NAME)}</b> for "<b>${escapeHtml(APP_NAME)}</b>". Waiting for bot status confirmation...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, {
          chat_id: cid,
          message_id: updateMsg.message_id
      });
      const animateIntervalId = await animateMessage(cid, updateMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(APP_NAME, { resolve, reject, animateIntervalId });
      });

      const STATUS_CHECK_TIMEOUT = 180 * 1000;
      let timeoutId;

      try {
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(APP_NAME);
              if (appPromise) {
                  appPromise.reject(new Error('Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.'));
                  appDeploymentPromises.delete(APP_NAME);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise;
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);

          await bot.editMessageText(
            `Your bot is now live!`,
            { chat_id: cid, message_id: updateMsg.message_id }
          );
          console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${APP_NAME}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${APP_NAME}:`, err.message);
          await bot.editMessageText(
              `Bot "<b>${escapeHtml(APP_NAME)}</b>" failed to come online after variable "<b>${escapeHtml(VAR_NAME)}</b>" update: ${escapeHtml(err.message)}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
                  parse_mode: 'HTML',
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Change Session ID', callback_data: `change_session:${APP_NAME}:${cid}` }]
                      ]
                  }
              }
          );
      } finally {
          appDeploymentPromises.delete(APP_NAME);
      }

      delete userStates[cid];

    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`[API_CALL] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data);
      return bot.sendMessage(cid, `Error updating variable: ${escapeHtml(errorMsg)}`, { parse_mode: 'HTML' });
    }
  }
});

// 13) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const dataParts = q.data ? q.data.split(':') : [];
  const action = dataParts[0];
  const payload = dataParts[1];
  const extra = dataParts[2];
  const flag = dataParts[3];

  await bot.answerCallbackQuery(q.id).catch(() => {});
  await updateUserActivity(cid); // Update user activity on any callback query
  await notifyAdminUserOnline(q.message); // Call the notification function here

  console.log(`[CallbackQuery] Received: action=${action}, payload=${payload}, extra=${extra}, flag=${flag} from ${cid}`);
  console.log(`[CallbackQuery] Current state for ${cid}:`, userStates[cid]);

  if (action === 'faq_page') {
      const page = parseInt(payload);
      const messageId = q.message.message_id; // Use message ID from the callback query
      await sendFaqPage(cid, messageId, page);
      return;
  }

  if (action === 'back_to_main_menu') {
      delete userStates[cid].faqPage; // Clear FAQ specific state
      delete userStates[cid].faqMessageId; // Clear FAQ message ID
      delete userStates[cid].step; // Clear main step if desired, or reset to default
      const isAdmin = cid === ADMIN_ID;
      await bot.editMessageText('Returning to main menu.', {
          chat_id: cid,
          message_id: q.message.message_id,
          reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true },
          parse_mode: 'HTML'
      }).catch(err => {
          console.error(`Error editing message back to main menu: ${err.message}. Sending new menu.`, err);
          bot.sendMessage(cid, 'Returning to main menu.', {
              reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true },
              parse_mode: 'HTML'
          });
      });
      return;
  }


  if (action === 'deploy_first_bot') {
    if (cid === ADMIN_ID) {
        userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
        return bot.sendMessage(cid, 'Enter your session ID or get it from the website: <a href="https://levanter-delta.vercel.app/">https://levanter-delta.vercel.app/</a>', { parse_mode: 'HTML' });
    } else {
        userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
        return bot.sendMessage(cid, 'Enter your Deploy key');
    }
  }

  if (action === 'ask_admin_question') { // This is Suggestions/Feedback now
      delete userStates[cid]; // Clear user state
      userStates[cid] = { step: 'AWAITING_ADMIN_QUESTION_TEXT', data: {} };
      await bot.sendMessage(cid, 'Please type your suggestion or feedback for the admin:'); // Updated prompt
      return;
  }

  if (action === 'pairing_action') {
      if (cid !== ADMIN_ID) {
          await bot.sendMessage(cid, "You are not authorized to perform this action.");
          return;
      }

      const decision = payload;
      const targetUserChatId = extra;

      const adminMessageId = q.message.message_id;
      const context = forwardingContext[adminMessageId];

      if (!context || context.request_type !== 'pairing_request' || context.original_user_chat_id !== targetUserChatId) {
          await bot.sendMessage(cid, 'This pairing request has expired or is invalid.');
          return;
      }

      if (context.timeout_id_for_pairing_request) {
          clearTimeout(context.timeout_id_for_pairing_request);
      }

      delete forwardingContext[adminMessageId];

      const userStateForTargetUser = userStates[targetUserChatId];
      const userMessageId = userStateForTargetUser?.data?.messageId;
      const userAnimateIntervalId = userStateForTargetUser?.data?.animateIntervalId;
      const { isFreeTrial, isAdminDeploy } = userStateForTargetUser?.data || {};

      if (userAnimateIntervalId) {
          clearInterval(userAnimateIntervalId);
          if (userMessageId) {
              await bot.editMessageText(`Admin action received!`, {
                  chat_id: targetUserChatId,
                  message_id: userMessageId
              }).catch(err => console.error(`Failed to edit user's message after admin action: ${err.message}`));
          }
      }

      if (decision === 'accept') {
          userStates[cid] = {
              step: 'AWAITING_ADMIN_PAIRING_CODE_INPUT',
              data: {
                  targetUserId: targetUserChatId,
                  userWaitingMessageId: userMessageId,
                  userAnimateIntervalId: userAnimateIntervalId,
                  isFreeTrial: isFreeTrial,
                  isAdminDeploy: isAdminDeploy
              }
          };

          await bot.sendMessage(ADMIN_ID,
              `<b>Pairing Request from User:</b>\n` +
              `User ID: <code>${targetUserChatId}</code> (Phone: <code>${escapeHtml(context.user_phone_number)}</code>).\n\n` +
              `<b>Please send the pairing code for this user now</b> (e.g., <code>ABCD-1234</code>).\n` +
              `<a href="https://levanter-delta.vercel.app/">Session ID Generator</a>`,
              { parse_mode: 'HTML' }
          );

          if (userMessageId) {
            const waitingForCodeMsg = await bot.editMessageText(`${getAnimatedEmoji()} Admin accepted! Please wait while the admin gets your pairing code...`, {
                chat_id: targetUserChatId,
                message_id: userMessageId
            });
            const newAnimateIntervalId = await animateMessage(targetUserChatId, waitingForCodeMsg.message_id, 'Admin getting your pairing code...');
            userStates[targetUserChatId].data.animateIntervalId = newAnimateIntervalId;
          }


          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: cid,
              message_id: adminMessageId
          }).catch(() => {});
          await bot.editMessageText(q.message.text + `\n\n<i>Status: Accepted. Admin needs to send code directly.</i>`, {
              chat_id: cid,
              message_id: adminMessageId,
              parse_mode: 'HTML'
          }).catch(() => {});


      } else {
          await bot.sendMessage(targetUserChatId, 'Your pairing code request was declined by the admin. Please contact support if you have questions.', { parse_mode: 'HTML' });
          await bot.sendMessage(ADMIN_ID, `Pairing request from user <code>${targetUserChatId}</code> declined.`, { parse_mode: 'HTML' });

          delete userStates[targetUserChatId]; // Clear user state
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: cid,
              message_id: adminMessageId
          }).catch(() => {});
          await bot.editMessageText(q.message.text + `\n\n<i>Status: Declined by Admin.</i>`, {
              chat_id: cid,
              message_id: adminMessageId,
              parse_mode: 'HTML'
          }).catch(() => {});
      }
      return;
  }

  if (action === 'setup') {
      const st = userStates[cid];
      // Check if state is valid and message ID matches the one being edited
      if (!st || st.step !== 'AWAITING_WIZARD_CHOICE' || q.message.message_id !== st.message_id) {
          return bot.editMessageText('This menu has expired. Please start over by tapping /menu.', {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'HTML'
          }).catch(() => {}); // Catch if edit fails
      }

      const [step, value] = [payload, extra];

      if (step === 'autostatus') {
          st.data.AUTO_STATUS_VIEW = value === 'true' ? 'no-dl' : 'false';

          const confirmationText = ` <b>Deployment Configuration</b>\n\n` +
                                   `<b>App Name:</b> <code>${escapeHtml(st.data.APP_NAME)}</code>\n` +
                                   `<b>Session ID:</b> <code>${escapeHtml(st.data.SESSION_ID.slice(0, 15))}...</code>\n` +
                                   `<b>Auto Status:</b> <code>${escapeHtml(st.data.AUTO_STATUS_VIEW)}</code>\n\n` +
                                   `Ready to proceed?`;

          const confirmationKeyboard = {
              reply_markup: {
                  inline_keyboard: [
                      [
                          { text: 'Yes (Recommended)', callback_data: `setup:startbuild` },
                          { text: 'No', callback_data: `setup:cancel` }
                      ]
                  ]
              }
          };

          await bot.editMessageText(confirmationText, {
              chat_id: cid,
              message_id: st.message_id,
              parse_mode: 'HTML',
              ...confirmationKeyboard
          });
      }

      if (step === 'startbuild') {
          await bot.editMessageText('Configuration confirmed. Initiating deployment...', {
              chat_id: cid,
              message_id: st.message_id,
              parse_mode: 'HTML'
          });
          delete userStates[cid]; // Clear user state
          await buildWithProgress(cid, st.data, st.data.isFreeTrial);
      }

      if (step === 'cancel') {
          await bot.editMessageText('Deployment cancelled.', {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'HTML'
          });
          delete userStates[cid]; // Clear user state
      }
      return;
  }


  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    // Clear the message with uses selection after generating key
    await bot.editMessageText(`Generated key: <code>${escapeHtml(key)}</code>\nUses: ${uses}`, {
      chat_id: cid,
      message_id: q.message.message_id,
      parse_mode: 'HTML'
    }).catch(() => {});
    return;
  }

  if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    const messageId = q.message.message_id;
    const appName = payload;

    userStates[cid] = { step: 'APP_MANAGEMENT', data: { appName: appName, messageId: messageId, isUserBot: isUserBot } };

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Fetching app status for "<b>${escapeHtml(appName)}</b>"...`, { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });

    return bot.editMessageText(`Manage app "<b>${escapeHtml(appName)}</b>":`, {
      chat_id: cid,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Info', callback_data: `info:${appName}` },
            { text: 'Restart', callback_data: `restart:${appName}` },
            { text: 'Logs', callback_data: `logs:${appName}` }
          ],
          [
            { text: 'Redeploy', callback_data: `redeploy_app:${appName}` },
            { text: 'Delete', callback_data: `${isUserBot ? 'userdelete' : 'delete'}:${appName}` },
            { text: 'Set Variable', callback_data: `setvar:${appName}` }
          ],
          [{ text: 'Back', callback_data: 'back_to_app_list' }]
        ]
      }
    });
  }

  if (action === 'add_assign_app') {
    const appName = payload;
    const targetUserId = extra;

    console.log(`[CallbackQuery - add_assign_app] Received selection for app: ${appName} to assign to user: ${targetUserId}`);
    console.log(`[CallbackQuery - add_assign_app] Current state for ${cid} is:`, userStates[cid]);

    if (cid !== ADMIN_ID) {
        await bot.editMessageText("You are not authorized to perform this action.", {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });
        return;
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_ADD' || st.data.targetUserId !== targetUserId) {
        console.error(`[CallbackQuery - add_assign_app] State mismatch for ${cid}. Expected AWAITING_APP_FOR_ADD for ${targetUserId}, got:`, st);
        await bot.editMessageText("This add session has expired or is invalid. Please start over with <code>/add &lt;user_id&gt;</code>.", {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });
        delete userStates[cid]; // Clear user state
        return;
    }

    await bot.editMessageText(`Assigning app "<b>${escapeHtml(appName)}</b>" to user <code>${targetUserId}</code>...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'HTML'
    });

    try {
        const existingEntry = await pool.query('SELECT user_id FROM user_bots WHERE bot_name=$1', [appName]);
        if (existingEntry.rows.length > 0) {
            const oldUserId = existingEntry.rows[0].user_id;
            if (oldUserId !== targetUserId) {
                console.log(`[Admin] Transferring ownership for bot "${appName}" from ${oldUserId} to ${targetUserId}. Deleting old entry.`);
                await pool.query('DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2', [oldUserId, appName]);
            } else {
                console.log(`[Admin] Bot "${appName}" is already owned by ${targetUserId}. Proceeding with update.`);
            }
        }

        const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
            headers: {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            }
        });
        const currentSessionId = configRes.data.SESSION_ID;

        if (!currentSessionId) {
            await bot.editMessageText(`Cannot assign "<b>${escapeHtml(appName)}</b>". It does not have a SESSION_ID config variable set on Heroku. Please set it manually first or deploy it via the bot.`, {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'HTML'
            });
            delete userStates[cid]; // Clear user state
            return;
        }
         // Validate session ID starts with 'levanter_' when assigning
        if (!currentSessionId.startsWith('levanter_')) {
            await bot.editMessageText(`Cannot assign "<b>${escapeHtml(appName)}</b>". Its current SESSION_ID on Heroku does not start with <code>levanter_</code>. Please correct the session ID on Heroku first.`, {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'HTML'
            });
            delete userStates[cid]; // Clear user state
            return;
        }

        await addUserBot(targetUserId, appName, currentSessionId);
        console.log(`[Admin] Successfully called addUserBot for ${appName} to user ${targetUserId} with fetched session ID.`);

        await bot.editMessageText(`App "<b>${escapeHtml(appName)}</b>" successfully assigned to user <code>${targetUserId}</code>! It will now appear in their "My Bots" list.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });

        await bot.sendMessage(targetUserId, `Your bot "<b>${escapeHtml(appName)}</b>" has been successfully assigned to your "My Bots" list by the admin! You can now manage it.`, { parse_mode: 'HTML' });
        console.log(`[Admin] Sent success notification to target user ${targetUserId}.`);

    } catch (e) {
        if (e.response && e.response.status === 404) {
            await handleAppNotFoundAndCleanDb(cid, appName, q.message.message_id, false);
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error assigning app "${appName}" to user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to assign app "<b>${escapeHtml(appName)}</b>" to user <code>${targetUserId}</code>: ${escapeHtml(errorMsg)}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });
    } finally {
        delete userStates[cid]; // Clear user state
        console.log(`[Admin] State cleared for ${cid} after add_assign_app flow.`);
    }
    return;
  }

  if (action === 'remove_app_from_user') {
    const appName = payload;
    const targetUserId = extra;

    console.log(`[CallbackQuery - remove_app_from_user] Received selection for app: ${appName} to remove from user: ${targetUserId}`);
    console.log(`[CallbackQuery - remove_app_from_user] Current state for ${cid} is:`, userStates[cid]);

    if (cid !== ADMIN_ID) {
        await bot.editMessageText("You are not authorized to perform this action.", {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });
        return;
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_REMOVAL' || st.data.targetUserId !== targetUserId) {
        console.error(`[CallbackQuery - remove_app_from_user] State mismatch for ${cid}. Expected AWAITING_APP_FOR_REMOVAL for ${targetUserId}, got:`, st);
        await bot.editMessageText("This removal session has expired or is invalid. Please start over with <code>/remove &lt;user_id&gt;</code>.", {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });
        delete userStates[cid]; // Clear user state
        return;
    }

    await bot.editMessageText(`Removing app "<b>${escapeHtml(appName)}</b>" from user <code>${targetUserId}</code>'s dashboard...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'HTML'
    });

    try {
        await deleteUserBot(targetUserId, appName);
        console.log(`[Admin] Successfully called deleteUserBot for ${appName} from user ${targetUserId}.`);

        await bot.editMessageText(`App "<b>${escapeHtml(appName)}</b>" successfully removed from user <code>${targetUserId}</code>'s dashboard.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });

        await bot.sendMessage(targetUserId, `The admin has removed bot "<b>${escapeHtml(appName)}</b>" from your "My Bots" menu.`, { parse_mode: 'HTML' });
        console.log(`[Admin] Sent removal notification to target user ${targetUserId}.`);

    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error removing app "${appName}" from user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to remove app "<b>${escapeHtml(appName)}</b>" from user <code>${targetUserId}</code>'s dashboard: ${escapeHtml(errorMsg)}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'HTML'
        });
    } finally {
        delete userStates[cid]; // Clear user state
        console.log(`[Admin] State cleared for ${cid} after remove_app_from_user flow.`);
    }
    return;
  }

  if (action === 'info') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText('Fetching app info...', { chat_id: cid, message_id: messageId });
    try {
      const apiHeaders = {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      };

      const [appRes, configRes, dynoRes] = await Promise.all([
        axios.get(`https://api.heroku.com/apps/${payload}`, { headers: apiHeaders }),
        axios.get(`https://api.heroku.com/apps/${payload}/config-vars`, { headers: apiHeaders }),
        axios.get(`https://api.heroku.com/apps/${payload}/dynos`, { headers: apiHeaders })
      ]);

      const appData = appRes.data;
      const configData = configRes.data;
      const dynoData = dynoRes.data;

      let dynoStatus = 'Scaled to 0 / Off';
      if (dynoData.length > 0) {
          const workerDyno = dynoData.find(d => d.type === 'worker');
          if (workerDyno) {
              const state = workerDyno.state;
              if (state === 'up') {
                  dynoStatus = `Up`;
              } else if (state === 'crashed') {
                  dynoStatus = `Crashed`;
              } else if (state === 'idle') {
                  dynoStatus = `Idle`;
              } else if (state === 'starting' || state === 'restarting') {
                  dynoStatus = `${state.charAt(0).toUpperCase() + state.slice(1)}`;
              } else {
                  dynoStatus = `Unknown State: ${state}`;
              }
          } else {
              dynoStatus = 'Worker dyno not active/scaled to 0';
          }
      }

      const info = `<b>App Info: ${escapeHtml(appData.name)}</b>\n\n` +
                   `<b>Dyno Status:</b> ${dynoStatus}\n` +
                   `<b>Created:</b> ${new Date(appData.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' })} (${Math.ceil(Math.abs(new Date() - new Date(appData.created_at)) / (1000 * 60 * 60 * 24))} days ago)\n` +
                   `<b>Last Release:</b> ${new Date(appData.released_at).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' })}\n` +
                   `<b>Stack:</b> ${escapeHtml(appData.stack.name)}\n\n` +
                   `<b>Key Config Vars:</b>\n` +
                   `  <code>SESSION_ID</code>: ${configData.SESSION_ID ? 'Set' : 'Not Set'}\n` +
                   `  <code>AUTO_STATUS_VIEW</code>: <code>${escapeHtml(configData.AUTO_STATUS_VIEW || 'false')}</code>\n`;

      return bot.editMessageText(info, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true);
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`Error fetching info for ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`Error fetching info: ${escapeHtml(errorMsg)}`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'restart') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Restarting bot "<b>${escapeHtml(payload)}</b>"...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'HTML'
    });

    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });

      await bot.editMessageText(`Bot "<b>${escapeHtml(payload)}</b>" restarted successfully!`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
          }
      });
      console.log(`Sent "restarted successfully" notification to user ${cid} for bot ${payload}`);

    } catch (e) {
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true);
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`Error restarting ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`Error restarting bot: ${escapeHtml(errorMsg)}`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } finally {
        delete userStates[cid]; // Clear user state
    }
  }

  if (action === 'logs') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText('Fetching logs...', { chat_id: cid, message_id: messageId });
    try {
      const sess = await axios.post(`https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: false, lines: 100 }, // Fetch last 100 lines
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      const logRes = await axios.get(sess.data.logplex_url);
      const logs = logRes.data.trim();

      const MAX_MESSAGE_LENGTH = 4000; // Telegram's limit is 4096, leave some buffer
      const escapedLogs = escapeHtml(logs || 'No recent logs.'); // Escape once

      if (escapedLogs.length > MAX_MESSAGE_LENGTH) {
        // Send initial message indicating logs are chunked
        await bot.editMessageText(`Logs for "<b>${escapeHtml(payload)}</b>" (too long, sending in parts):`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'HTML'
        });

        const logChunks = [];
        for (let i = 0; i < escapedLogs.length; i += MAX_MESSAGE_LENGTH) {
          logChunks.push(escapedLogs.substring(i, i + MAX_MESSAGE_LENGTH));
        }

        for (const chunk of logChunks) {
          await bot.sendMessage(cid, `<pre>${chunk}</pre>`, { parse_mode: 'HTML' });
          await new Promise(r => setTimeout(r, 500)); // Small delay between messages to avoid flooding
        }

        // Send a final message with the "Back" button
        await bot.sendMessage(cid, 'All logs sent.', {
          reply_markup: {
              inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
          }
        });

      } else {
        // If logs are not too long, send in a single message
        return bot.editMessageText(`Logs for "<b>${escapeHtml(payload)}</b>":\n<pre>${escapedLogs}</pre>`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: {
              inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
          }
        });
      }
    } catch (e) {
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true);
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching logs: ${escapeHtml(errorMsg)}`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'delete' || action === 'userdelete') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

      return bot.editMessageText(`Are you sure you want to delete the app "<b>${escapeHtml(payload)}</b>"? This action cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: "Yes, I am sure", callback_data: `confirmdelete:${payload}:${action}` },
            { text: "No, cancel", callback_data: `selectapp:${payload}` }
          ]]
        }
      });
  }

  if (action === 'confirmdelete') {
      const appToDelete = payload;
      const originalAction = extra;
      const st = userStates[cid];
      // Check if state is valid and appName matches
      if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appToDelete) { // Check step and appName in state
          return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
      }
      const messageId = q.message.message_id;

      await bot.sendChatAction(cid, 'typing');
      await bot.editMessageText(`Deleting "<b>${escapeHtml(appToDelete)}</b>"...`, { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          if (originalAction === 'userdelete') {
              await deleteUserBot(cid, appToDelete);
          } else {
              const ownerId = await getUserIdByBotName(appToDelete);
              if (ownerId) await deleteUserBot(ownerId, appToDelete);
          }
          await bot.editMessageText(`App "<b>${escapeHtml(appToDelete)}</b>" has been permanently deleted.`, { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });
          if (originalAction === 'userdelete') {
              const bots = await getUserBots(cid);
              if (bots.length > 0) {
                  const rows = chunkArray(bots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
                  return bot.sendMessage(cid, 'Your remaining deployed bots:', { reply_markup: { inline_keyboard: rows } });
              } else {
                  return bot.sendMessage(cid, "You no longer have any deployed bots.");
              }
          } else {
            return sendAppList(cid);
          }
      } catch (e) {
          if (e.response && e.response.status === 404) {
              await handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, originalAction === 'userdelete');
              return;
          }
          const errorMsg = e.response?.data?.message || e.message;
          await bot.editMessageText(`Failed to delete app: ${escapeHtml(errorMsg)}`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'HTML',
              reply_markup: {
                  inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appToDelete}` }]]
              }
          });
      }
      return;
  }

  if (action === 'canceldelete') {
      return bot.editMessageText('Deletion cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id,
          parse_mode: 'HTML'
      });
  }

  if (action === 'setvar') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;
    const appName = payload;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Fetching current variables for "<b>${escapeHtml(appName)}</b>"...`, { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });

    let configVars = {};
    try {
        const configRes = await axios.get(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        );
        configVars = configRes.data;
    } catch (e) {
        if (e.response && e.response.status === 404) {
            await handleAppNotFoundAndCleanDb(cid, appName, messageId, true);
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        return bot.editMessageText(`Error fetching config vars: ${escapeHtml(errorMsg)}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    }

    const formatVarValue = (value) => {
        if (typeof value === 'boolean') {
            return value ? '<code>true</code>' : '<code>false</code>';
        }
        if (value === null || value === undefined || value === '') {
            return '<code>Not Set</code>';
        }
        let escapedValue = escapeHtml(String(value));
        if (escapedValue.length > 20) {
            escapedValue = escapedValue.substring(0, 20) + '...';
        }
        return `<code>${escapedValue}</code>`;
    };

    const sessionIDValue = configVars.SESSION_ID ? `<code>${escapeHtml(String(configVars.SESSION_ID))}</code>` : '<code>Not Set</code>';


    const varInfo = `<b>Current Config Variables for ${escapeHtml(appName)}:</b>\n` +
                     `<code>SESSION_ID</code>: ${sessionIDValue}\n` +
                     `<code>AUTO_STATUS_VIEW</code>: ${formatVarValue(configVars.AUTO_STATUS_VIEW)}\n` +
                     `<code>ALWAYS_ONLINE</code>: ${formatVarValue(configVars.ALWAYS_ONLINE)}\n` +
                     `<code>PREFIX</code>: ${formatVarValue(configVars.PREFIX)}\n` +
                     `<code>ANTI_DELETE</code>: ${formatVarValue(configVars.ANTI_DELETE)}\n` +
                     `<code>SUDO</code>: ${formatVarValue(configVars.SUDO)}\n\n` +
                     `Select a variable to set:`;

    return bot.editMessageText(varInfo, {
      chat_id: cid,
      message_id: messageId,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${payload}` }],
          [{ text: 'AUTO_STATUS_VIEW', callback_data: `varselect:AUTO_STATUS_VIEW:${payload}` },
           { text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${payload}` }],
          [{ text: 'PREFIX', callback_data: `varselect:PREFIX:${payload}` },
           { text: 'ANTI_DELETE', callback_data: `varselect:ANTI_DELETE:${payload}` }],
          [{ text: 'SUDO', callback_data: `varselect:SUDO_VAR:${payload}` }],
          [{ text: 'Add/Set Other Variable', callback_data: `varselect:OTHER_VAR:${payload}` }],
          [{ text: 'Back', callback_data: `selectapp:${payload}` }]
        ]
      }
    });
  }

  if (action === 'varselect') {
    const [varKey, appName] = [payload, extra];
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) { // Assuming it should still be in APP_MANAGEMENT
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    if (varKey === 'SESSION_ID') {
        userStates[cid].step = 'SETVAR_ENTER_VALUE';
        userStates[cid].data.VAR_NAME = varKey;
        userStates[cid].data.APP_NAME = appName;
        return bot.sendMessage(cid, `Please enter the <b>new</b> session ID for your bot "<b>${escapeHtml(appName)}</b>". It must start with <code>levanter_</code>.`, { parse_mode: 'HTML' });
    }
    else if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE', 'PREFIX'].includes(varKey)) {
        userStates[cid].step = 'SETVAR_ENTER_VALUE';
        userStates[cid].data.VAR_NAME = varKey;
        userStates[cid].data.APP_NAME = appName;

        let promptMessage = `Please enter the new value for <b>${escapeHtml(varKey)}</b>:`;
        if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE'].includes(varKey)) {
          return bot.editMessageText(`Set <b>${escapeHtml(varKey)}</b> to:`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
                { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
              ],
              [{ text: 'Back', callback_data: `setvar:${appName}` }]]
            }
          });
        }
        return bot.sendMessage(cid, promptMessage, { parse_mode: 'HTML' });

    } else if (varKey === 'OTHER_VAR') {
        userStates[cid].step = 'AWAITING_OTHER_VAR_NAME';
        userStates[cid].data.APP_NAME = appName;
        userStates[cid].data.targetUserId = cid;
        userStates[cid].message_id = q.message.message_id; // Store current message ID for context

        await bot.sendMessage(cid, 'Please enter the name of the variable (e.g., <code>MY_CUSTOM_VAR</code>). It will be capitalized automatically if not already:', { parse_mode: 'HTML' });
    } else if (varKey === 'SUDO_VAR') {
        return bot.editMessageText(`How do you want to manage the <b>SUDO</b> variable for "<b>${escapeHtml(appName)}</b>"?`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Add Number', callback_data: `sudo_action:add:${appName}` }],
                    [{ text: 'Remove Number', callback_data: `sudo_action:remove:${appName}` }],
                    [{ text: 'Back', callback_data: `setvar:${appName}` }]
                ]
            }
        });
    }
  }

  if (action === 'sudo_action') {
      const sudoAction = payload;
      const appName = extra;

      // Ensure that the user is managing the correct app or is admin
      const st = userStates[cid];
      if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) { // Added state check
          return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
      }


      userStates[cid].data.APP_NAME = appName;
      userStates[cid].data.targetUserId = cid;
      userStates[cid].data.attempts = 0;

      if (sudoAction === 'add') {
          userStates[cid].step = 'AWAITING_SUDO_ADD_NUMBER';
          return bot.sendMessage(cid, 'Please enter the number to <b>add</b> to SUDO (without + or spaces, e.g., <code>2349163916314</code>):', { parse_mode: 'HTML' });
      } else if (sudoAction === 'remove') {
          userStates[cid].step = 'AWAITING_SUDO_REMOVE_NUMBER';
          return bot.sendMessage(cid, 'Please enter the number to <b>remove</b> from SUDO (without + or spaces, e.g., <code>2349163916314</code>):', { parse_mode: 'HTML' });
      }
  }

  if (action === 'overwrite_var') {
      const confirmation = payload;
      const varName = extra;
      const appName = flag;

      const st = userStates[cid];
      // More robust check for overwrite state
      if (!st || st.step !== 'AWAITING_OVERWRITE_CONFIRMATION' || st.data.VAR_NAME !== varName || st.data.APP_NAME !== appName) {
          await bot.editMessageText('This overwrite session has expired or is invalid. Please try setting the variable again.', {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'HTML'
          });
          delete userStates[cid]; // Clear user state
          return;
      }

      if (confirmation === 'yes') {
          await bot.editMessageText(`You chose to overwrite <b>${escapeHtml(varName)}</b>.`, {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'HTML'
          });
          // Transition to the step where user provides the new value
          userStates[cid].step = 'AWAITING_OTHER_VAR_VALUE';
          return bot.sendMessage(cid, `Please enter the <b>new</b> value for <b>${escapeHtml(varName)}</b>:`, { parse_mode: 'HTML' });
      } else {
          await bot.editMessageText(`Variable <b>${escapeHtml(varName)}</b> was not overwritten.`, {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'HTML'
          });
          delete userStates[cid]; // Clear user state
          return;
      }
  }

  if (action === 'setvarbool') {
    const [varKey, appName, valStr] = [payload, extra, flag];
    const flagVal = valStr === 'true';
    let newVal;
    if (varKey === 'AUTO_STATUS_VIEW') newVal = flagVal ? 'no-dl' : 'false';
    else if (varKey === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
    else newVal = flagVal ? 'true' : 'false';

    try {
      await bot.sendChatAction(cid, 'typing');
      const updateMsg = await bot.sendMessage(cid, `Updating <b>${escapeHtml(varKey)}</b> for "<b>${escapeHtml(appName)}</b>"...`, { parse_mode: 'HTML' });
      console.log(`[API_CALL] Patching Heroku config vars (boolean) for ${appName}: { ${varKey}: '${newVal}' }`);
      const patchResponse = await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${appName}. Status: ${patchResponse.status}`);


      console.log(`[Flow] setvarbool: Config var updated for "${appName}". Updating bot in user_bots DB.`);
      // No need to fetch session_id here, it's not being updated based on the variable change
      // const { session_id: currentSessionId } = await pool.query('SELECT session_id FROM user_bots WHERE user_id=$1 AND bot_name=$2', [cid, appName]).then(res => res.rows[0] || {});

      const baseWaitingText = `Updated <b>${escapeHtml(varKey)}</b> for "<b>${escapeHtml(appName)}</b>". Waiting for bot status confirmation...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, {
          chat_id: cid,
          message_id: updateMsg.message_id
      });
      const animateIntervalId = await animateMessage(cid, updateMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(appName, { resolve, reject, animateIntervalId });
      });

      const STATUS_CHECK_TIMEOUT = 180 * 1000;
      let timeoutId;

      try {
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(appName);
              if (appPromise) {
                  appPromise.reject(new Error('Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.'));
                  appDeploymentPromises.delete(appName);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise;
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);

          await bot.editMessageText(`Variable "<b>${escapeHtml(varKey)}</b>" for "<b>${escapeHtml(appName)}</b>" updated successfully and bot is back online!`, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'HTML',
              reply_markup: {
                  inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]
                  ]
              }
          });
          console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${appName}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${appName}:`, err.message);
          await bot.editMessageText(
              `Bot "<b>${escapeHtml(appName)}</b>" failed to come online after variable "<b>${escapeHtml(varKey)}</b>" update: ${escapeHtml(err.message)}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
                  parse_mode: 'HTML',
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Change Session ID', callback_data: `change_session:${appName}:${cid}` }],
                          [{ text: 'Back', callback_data: `selectapp:${appName}` }]
                      ]
                  }
              }
          );
      } finally {
          appDeploymentPromises.delete(appName);
      }
      delete userStates[cid]; // Clear user state
    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`[API_CALL] Error updating boolean variable ${varKey} for ${appName}:`, errorMsg, e.response?.data);
      return bot.sendMessage(cid, `Error updating variable: ${escapeHtml(errorMsg)}`, { parse_mode: 'HTML' });
    }
  }

  if (action === 'change_session') {
      const appName = payload;
      const targetUserId = extra;

      if (cid !== targetUserId) {
          await bot.sendMessage(cid, `You can only change the session ID for your own bots.`);
          return;
      }
      // Clear current state and set up for session ID input
      delete userStates[cid];
      userStates[cid] = {
          step: 'SETVAR_ENTER_VALUE',
          data: {
              APP_NAME: appName,
              VAR_NAME: 'SESSION_ID',
              targetUserId: targetUserId
          }
      };
      await bot.sendMessage(cid, `Please enter the <b>new</b> session ID for your bot "<b>${escapeHtml(appName)}</b>". It must start with <code>levanter_</code>.`, { parse_mode: 'HTML' });
      return;
  }

  if (action === 'admin_delete_trial_app') {
      const appToDelete = payload;
      const messageId = q.message.message_id;

      if (cid !== ADMIN_ID) {
          await bot.editMessageText("You are not authorized to perform this action.", { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });
          return;
      }

      await bot.sendChatAction(cid, 'typing');
      await bot.editMessageText(`Admin deleting Free Trial app "<b>${escapeHtml(appToDelete)}</b>"...`, { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          const ownerId = await getUserIdByBotName(appToDelete);
          if (ownerId) await deleteUserBot(ownerId, appToDelete);

          await bot.editMessageText(`Free Trial app "<b>${escapeHtml(appToDelete)}</b>" permanently deleted by Admin.`, { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });
          if (ownerId && ownerId !== cid) {
              await bot.sendMessage(ownerId, `Your Free Trial bot "<b>${escapeHtml(appToDelete)}</b>" has been manually deleted by the admin.`, { parse_mode: 'HTML' });
          }
      } catch (e) {
          if (e.response && e.response.status === 404) {
              await handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, false);
              return;
          }
          const errorMsg = e.response?.data?.message || e.message;
          await bot.editMessageText(`Failed to delete Free Trial app "<b>${escapeHtml(appToDelete)}</b>": ${escapeHtml(errorMsg)}`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'HTML'
          });
      }
      return;
  }

  if (action === 'redeploy_app') {
    const appName = payload;
    const messageId = q.message.message_id;

    const isOwner = (await getUserIdByBotName(appName)) === cid;
    if (cid !== ADMIN_ID && !isOwner) {
        await bot.editMessageText("You are not authorized to redeploy this app.", { chat_id: cid, message_id: messageId, parse_mode: 'HTML' });
        return;
    }

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Redeploying "<b>${escapeHtml(appName)}</b>" from GitHub...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'HTML'
    });

    let animateIntervalId = null;
    try {
        const bres = await axios.post(
            `https://api.heroku.com/apps/${appName}/builds`,
            { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
            {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3',
                    'Content-Type': 'application/json'
                }
            }
        );

        const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;

        await bot.editMessageText(`Build initiated for "<b>${escapeHtml(appName)}</b>". Waiting for completion...`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'HTML'
        });
        animateIntervalId = await animateMessage(cid, messageId, `Building "<b>${escapeHtml(appName)}</b>" from GitHub...`);

        const BUILD_POLL_TIMEOUT = 300 * 1000;

        const buildPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                clearInterval(checkBuildStatusInterval);
                reject(new Error('Redeploy build process timed out.'));
            }, BUILD_POLL_TIMEOUT);

            const checkBuildStatusInterval = setInterval(async () => {
                try {
                    const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    if (poll.data.status === 'succeeded') {
                        clearInterval(checkBuildStatusInterval);
                        clearTimeout(timeoutId);
                        resolve('succeeded');
                    } else if (poll.data.status === 'failed') {
                        clearInterval(checkBuildStatusInterval);
                        clearTimeout(timeoutId);
                        reject(new Error(`Redeploy build failed: ${poll.data.slug?.id ? `https://dashboard.heroku.com/apps/${appName}/activity/build/${poll.data.id}` : 'Check Heroku logs.'}`));
                    }
                } catch (error) {
                    clearInterval(checkBuildStatusInterval);
                    clearTimeout(timeoutId);
                    reject(new Error(`Error polling build status: ${error.message}`));
                }
            }, 10000);
        });

        await buildPromise;

        await bot.editMessageText(`App "<b>${escapeHtml(appName)}</b>" redeployed successfully!`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
        console.log(`App "${appName}" redeployed successfully for user ${cid}.`);

    } catch (e) {
        if (e.response && e.response.status === 404) {
            await handleAppNotFoundAndCleanDb(cid, appName, messageId, true);
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`Error redeploying ${appName}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to redeploy "<b>${escapeHtml(appName)}</b>": ${escapeHtml(errorMsg)}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    } finally {
        if (animateIntervalId) clearInterval(animateIntervalId);
        delete userStates[cid]; // Clear user state
    }
    return;
  }

  if (action === 'back_to_app_list') {
    const isAdmin = cid === ADMIN_ID;
    const currentMessageId = q.message.message_id;

    // Clear APP_MANAGEMENT state, return to general menu or My Bots list
    delete userStates[cid];

    if (isAdmin) {
      return sendAppList(cid, currentMessageId);
    } else {
      const bots = await getUserBots(cid);
      if (bots.length > 0) {
          const rows = chunkArray(bots, 3).map(r => r.map(n => ({
            text: n,
            callback_data: `selectbot:${n}`
          })));
          return bot.editMessageText('Your remaining deployed bots:', {
            chat_id: cid,
            message_id: currentMessageId,
            reply_markup: { inline_keyboard: rows }
          });
      } else {
          return bot.editMessageText("You have not deployed any bots yet.", { chat_id: cid, message_id: currentMessageId });
      }
    }
  }
});

// 14) Channel Post Handler
bot.on('channel_post', async msg => {
    if (!msg || !msg.chat || msg.chat.id === undefined || msg.chat.id === null) {
        console.error('[Channel Post Error] Invalid message structure: msg, msg.chat, or msg.chat.id is undefined/null. Message:', JSON.stringify(msg, null, 2));
        return;
    }
    let channelId;
    try {
        channelId = msg.chat.id.toString();
    } catch (e) {
        console.error(`[Channel Post Error] Failed to get channelId from msg.chat.id: ${e.message}. Message:`, JSON.stringify(msg, null, 2));
        return;
    }

    const text = msg.text?.trim();

    console.log(`[Channel Post - Raw] Received message from channel ${channelId}:\n---BEGIN MESSAGE---\n${text}\n---END MESSAGE---`);

    if (channelId !== TELEGRAM_LISTEN_CHANNEL_ID) {
        console.log(`[Channel Post] Ignoring message from non-listening channel: ${channelId}`);
        return;
    }

    if (!text) {
        console.log(`[Channel Post] Ignoring empty message.`);
        return;
    }

    const logoutMatch = text.match(/User \[([^\]]+)\] has logged out\./si);
    if (logoutMatch) {
        const botName = logoutMatch[1];
        console.log(`[Channel Post] Detected LOGOUT for bot: ${botName}`);

        const pendingPromise = appDeploymentPromises.get(botName);
        if (pendingPromise) {
            clearInterval(pendingPromise.animateIntervalId);
            pendingPromise.reject(new Error('Bot session became invalid.'));
            appDeploymentPromises.delete(botName);
            console.log(`[Channel Post] Resolved pending promise for ${botName} with REJECTION (logout detected).`);
        } else {
            console.log(`[Channel Post] No active deployment promise for ${botName}, not sending duplicate "live" message.`);
        }

        const userId = await getUserIdByBotName(botName);
        if (userId) {
            const warningMessage =
                `Your bot "<b>${escapeHtml(botName)}</b>" has been logged out due to an invalid session.\n` +
                `Please update your session ID to get it back online.`;

            await bot.sendMessage(userId, warningMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Change Session ID', callback_data: `change_session:${botName}:${userId}` }]
                    ]
                }
            });
            console.log(`[Channel Post] Sent logout notification to user ${userId} for bot ${botName}`);
        } else {
            console.error(`[Channel Post] CRITICAL: Could not find user for bot "${botName}" during logout alert. Is this bot tracked in the database?`);
            bot.sendMessage(ADMIN_ID, `Untracked bot "<b>${escapeHtml(botName)}</b>" logged out. User ID not found in DB.`, { parse_mode: 'HTML' });
        }
        return;
    }

    const connectedMatch = text.match(/\[([^\]]+)\] connected\..*/si);
    if (connectedMatch) {
        const botName = connectedMatch[1];
        console.log(`[Channel Post] Detected CONNECTED status for bot: ${botName}`);

        const pendingPromise = appDeploymentPromises.get(botName);
        if (pendingPromise) {
            clearInterval(pendingPromise.animateIntervalId);
            pendingPromise.resolve('connected');
            appDeploymentPromises.delete(botName);
            console.log(`[Channel Post] Resolved pending promise for ${botName} with SUCCESS.`);
        } else {
            console.log(`[Channel Post] No active deployment promise for ${botName}, not sending duplicate "live" message.`);
        }
        return;
    }
});

// 15) Scheduled Task for Logout Reminders
async function checkAndRemindLoggedOutBots() {
    console.log('Running scheduled check for logged out bots...');
    if (!HEROKU_API_KEY) {
        console.warn('Skipping scheduled logout check: HEROKU_API_KEY not set.');
        return;
    }

    const allBots = await getAllUserBots();

    for (const botEntry of allBots) {
        const { user_id, bot_name } = botEntry;
        const herokuApp = bot_name;

        try {
            const apiHeaders = {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            };

            const configRes = await axios.get(`https://api.heroku.com/apps/${herokuApp}/config-vars`, { headers: apiHeaders });
            const lastLogoutAlertStr = configRes.data.LAST_LOGOUT_ALERT;

            const dynoRes = await axios.get(`https://api.heroku.com/apps/${herokuApp}/dynos`, { headers: apiHeaders });
            const workerDyno = dynoRes.data.find(d => d.type === 'worker');

            const isBotRunning = workerDyno && workerDyno.state === 'up';

            if (lastLogoutAlertStr && !isBotRunning) {
                const lastLogoutAlertTime = new Date(lastLogoutAlertStr);
                const now = new Date();
                const timeSinceLogout = now.getTime() - lastLogoutAlertTime.getTime();
                const twentyFourHours = 24 * 60 * 60 * 1000;

                if (timeSinceLogout > twentyFourHours) {
                    const reminderMessage =
                        `Reminder: Your bot "<b>${escapeHtml(bot_name)}</b>" has been logged out for more than 24 hours!\n` +
                        `It appears to still be offline. Please update your session ID to bring it back online.`;

                    await bot.sendMessage(user_id, reminderMessage, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Change Session ID', callback_data: `change_session:${bot_name}:${user_id}` }]
                            ]
                        }
                    });
                    console.log(`[Scheduled Task] Sent 24-hour logout reminder to user ${user_id} for bot ${bot_name}`);
                }
            }

        } catch (error) {
            if (error.response && error.response.status === 404) {
                console.log(`[Scheduled Task] App ${herokuApp} not found during reminder check. Auto-removing from DB.`);
                const currentOwnerId = await getUserIdByBotName(herokuApp);
                if (currentOwnerId) {
                    await deleteUserBot(currentOwnerId, herokuApp);
                    await bot.sendMessage(currentOwnerId, `Your bot "<b>${escapeHtml(herokuApp)}</b>" was not found on Heroku and has been automatically removed from your "My Bots" list.`, { parse_mode: 'HTML' });
                }
                return;
            }
            console.error(`[Scheduled Task] Error checking status for bot ${herokuApp} (user ${user_id}):`, error.response?.data?.message || error.message);
        }
    }
}

setInterval(checkAndRemindLoggedOutBots, 60 * 60 * 1000);


console.log('Bot is running...');
