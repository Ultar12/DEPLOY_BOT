// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const path = require('path');

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

// Add the channel ID the bot will listen to for specific messages
const TELEGRAM_LISTEN_CHANNEL_ID = '-1002892034574';

// Validate essential environment variables
if (!TELEGRAM_BOT_TOKEN || !HEROKU_API_KEY || !GITHUB_REPO_URL || !ADMIN_ID || !DATABASE_URL) {
    console.error('CRITICAL ERROR: One or more essential environment variables are missing.');
    console.error('Please ensure TELEGRAM_BOT_TOKEN, HEROKU_API_KEY, GITHUB_REPO_URL, ADMIN_ID, and DATABASE_URL are set.');
    process.exit(1);
}

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

    console.log("[DB] All necessary tables checked/created successfully.");

  } catch (dbError) {
    if (dbError.code === '42P07' || (dbError.message && dbError.message.includes('already exists'))) {
        console.warn(`[DB] 'user_bots' table already exists, or there was an issue creating it initially. Attempting to ensure PRIMARY KEY constraint.`);
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
      console.log(`[DB] addUserBot: Successfully added/updated bot "${b}" for user "${u}".`);
    } else {
      console.warn(`[DB] addUserBot: Insert/update operation for bot "${b}" for user "${u}" did not return a row. This might indicate an issue.`);
    }
  } catch (error) {
    console.error(`[DB] addUserBot: CRITICAL ERROR Failed to add/update bot "${b}" for user "${u}":`, error.message, error.stack);
    bot.sendMessage(ADMIN_ID, `⚠️ CRITICAL DB ERROR: Failed to add/update bot "${b}" for user "${u}". Check logs.`);
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
}

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

    const message = `🗑️ App "*${appName}*" was not found on Heroku. It has been automatically removed from your "My Bots" list.`;

    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId;

    if (originalMessageId) {
        await bot.editMessageText(message, {
            chat_id: messageTargetChatId,
            message_id: originalMessageId,
            parse_mode: 'Markdown'
        }).catch(err => console.error(`Failed to edit message in handleAppNotFoundAndCleanDb: ${err.message}`));
    } else {
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' })
            .catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb (new msg): ${err.message}`));
    }

    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `ℹ️ Your bot "*${appName}*" was not found on Heroku and has been removed from your "My Bots" list by the admin.`, { parse_mode: 'Markdown' })
             .catch(err => console.error(`Failed to send notification to original owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
}


// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {};
const authorizedUsers = new Set();

const appDeploymentPromises = new Map();

const forwardingContext = {};

const userLastSeenNotification = new Map();
const ONLINE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

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
*User Online:*
*ID:* \`${userId}\`
*Name:* ${first_name ? escapeMarkdown(first_name) : 'N/A'} ${last_name ? escapeMarkdown(last_name) : ''}
*Username:* ${username ? `@${escapeMarkdown(username)}` : 'N/A'}
*Time:* ${new Date().toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
            `;
            await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'Markdown' });
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
    }, 800);
    return intervalId;
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0101010101';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

function escapeMarkdown(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    return text
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/`/g, '\\`')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
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

loadMaintenanceStatus();

function buildKeyboard(isAdmin) {
  const baseMenu = [
      ['Get Session', 'Deploy'],
      ['Free Trial', 'My Bots'],
      ['Support']
  ];
  if (isAdmin) {
      return [
          ['Deploy', 'Apps'],
          ['Generate Key', 'Get Session'],
          ['Support', 'My Bots'],
          ['/users', '/stats', '/maintenance off'],
          ['/add <user_id>', '/remove <user_id>'],
          ['/info <user_id>', '/send <user_id> <code here>']
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

// 8) Send Heroku apps list
async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserId = null, isRemoval = false) {
  try {
    await bot.sendChatAction(chatId, 'typing');
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
  await bot.sendChatAction(chatId, 'typing');
  const createMsg = await bot.sendMessage(chatId, '🚀 Creating application...');

  try {
    await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    await bot.sendChatAction(chatId, 'typing');
    await bot.editMessageText('⚙️ Configuring resources...', { chat_id: chatId, message_id: createMsg.message_id });
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

    await bot.sendChatAction(chatId, 'typing');
    await bot.editMessageText('🔧 Setting environment variables...', { chat_id: chatId, message_id: createMsg.message_id });
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

    await bot.sendChatAction(chatId, 'typing');
    await bot.editMessageText('🛠️ Starting build process...', { chat_id: chatId, message_id: createMsg.message_id });
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
    const progMsg = await bot.editMessageText('Building... 0%', { chat_id: chatId, message_id: createMsg.message_id });

    for (let i = 1; i <= 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const poll = await axios.get(statusUrl, {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
          }
        });
        buildStatus = poll.data.status;
      } catch {
        buildStatus = 'error';
        break;
      }
      const pct = Math.min(100, i * 5);
      await bot.editMessageText(`Building... ${pct}%`, {
        chat_id: chatId,
        message_id: progMsg.message_id
      }).catch(() => {});

      if (buildStatus !== 'pending') break;
    }

    if (buildStatus === 'succeeded') {
      console.log(`[Flow] buildWithProgress: Heroku build for "${name}" SUCCEEDED. Attempting to add bot to user_bots DB.`);
      await addUserBot(chatId, name, vars.SESSION_ID);

      if (isFreeTrial) {
        await recordFreeTrialDeploy(chatId);
        console.log(`[FreeTrial] Recorded free trial deploy for user ${chatId}.`);
      }

      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [
        `*Name:* ${first_name || ''} ${last_name || ''}`,
        `*Username:* ${username ? `@${username}` : (first_name || last_name ? `${[first_name, last_name].filter(Boolean).join(' ')} (No @username)` : 'N/A')}`,
        `*Chat ID:* \`${chatId}\``
      ].join('\n');
      const appDetails = `*App Name:* \`${name}\`\n*Session ID:* \`${vars.SESSION_ID}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;

      await bot.sendMessage(ADMIN_ID,
          `*New App Deployed (Heroku Build Succeeded)*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      const baseWaitingText = `Build complete! Waiting for bot to connect...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, {
        chat_id: chatId,
        message_id: progMsg.message_id
      });

      const animateIntervalId = await animateMessage(chatId, progMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId });
      });

      const STATUS_CHECK_TIMEOUT = 120 * 1000;
      let timeoutId;

      try {
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(name);
              if (appPromise) {
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after deployment.`));
                  appDeploymentPromises.delete(name);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise;
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);

          await bot.editMessageText(
            `🎉 Your bot is now live!`,
            { chat_id: chatId, message_id: progMsg.message_id }
          );
          buildResult = true;

          if (isFreeTrial) {
            setTimeout(async () => {
                const adminWarningMessage = `🔔 Free Trial App "${name}" has 5 minutes left until deletion!`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: `Delete "${name}" Now`, callback_data: `admin_delete_trial_app:${name}` }]
                    ]
                };
                await bot.sendMessage(ADMIN_ID, adminWarningMessage, { reply_markup: keyboard, parse_mode: 'Markdown' });
                console.log(`[FreeTrial] Sent 5-min warning to admin for ${name}.`);
            }, 55 * 60 * 1000);

            setTimeout(async () => {
                try {
                    await bot.sendMessage(chatId, `⏳ Your Free Trial app "${name}" is being deleted now as its 1-hour runtime has ended.`);
                    await axios.delete(`https://api.heroku.com/apps/${name}`, {
                        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                    });
                    await deleteUserBot(chatId, name);
                    await bot.sendMessage(chatId, `Free Trial app "${name}" successfully deleted.`);
                    console.log(`[FreeTrial] Auto-deleted app ${name} after 1 hour.`);
                } catch (e) {
                    console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                    await bot.sendMessage(chatId, `⚠️ Could not auto-delete the app "${name}". Please delete it manually from your Heroku dashboard.`);
                    bot.sendMessage(ADMIN_ID, `⚠️ Failed to auto-delete free trial app "${name}" for user ${chatId}: ${e.message}`);
                }
            }, 60 * 60 * 1000);
          }

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${name}:`, err.message);
          await bot.editMessageText(
            `⚠️ Bot "${name}" failed to start or session is invalid after deployment: ${err.message}\n\n` +
            `It has been added to your "My Bots" list, but you may need to update the session ID.`,
            {
                chat_id: chatId,
                message_id: progMsg.message_id,
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

    } else {
      await bot.editMessageText(
        `Build status: ${buildStatus}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );
      buildResult = false;
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    buildResult = false;
  }
  return buildResult;
}

// 10) Polling error handler
bot.on('polling_error', console.error);

// 11) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}]`);

  if (isAdmin) {
    await bot.sendMessage(cid, 'Welcome, Admin! Here is your menu:', {
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    });
  } else {
    const { first_name: userFirstName } = msg.from;
    let personalizedGreeting = `👋 Welcome`;
    if (userFirstName) {
        personalizedGreeting += ` back, ${escapeMarkdown(userFirstName)}`;
    }
    personalizedGreeting += ` to our Bot Deployment Service!`;

    const welcomeImageUrl = 'https://files.catbox.moe/syx8uk.jpeg';
    const welcomeCaption = `
${personalizedGreeting}

To get started, please follow these simple steps:

1️⃣  *Connect Your WhatsApp:*
    Tap the 'Get Session' button to retrieve the necessary session details to link your WhatsApp account.

2️⃣  *Deploy Your Bot:*
    Once you have your session, use the 'Deploy' button to effortlessly launch your personalized bot.

We're here to assist you every step of the way!
`;
    await bot.sendPhoto(cid, welcomeImageUrl, {
      caption: welcomeCaption,
      parse_mode: 'Markdown',
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    });
  }
});

bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    sendAppList(cid);
  } else {
    bot.sendMessage(cid, "❌ You are not authorized to use this command.");
  }
});

bot.onText(/^\/maintenance (on|off)$/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const status = match[1].toLowerCase();

    if (chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "❌ You are not authorized to use this command.");
    }

    if (status === 'on') {
        isMaintenanceMode = true;
        await saveMaintenanceStatus(true);
        await bot.sendMessage(chatId, "✅ Maintenance mode is now *ON*.", { parse_mode: 'Markdown' });
    } else if (status === 'off') {
        isMaintenanceMode = false;
        await saveMaintenanceStatus(false);
        await bot.sendMessage(chatId, "✅ Maintenance mode is now *OFF*.", { parse_mode: 'Markdown' });
    }
});


bot.onText(/^\/id$/, async msg => {
    const cid = msg.chat.id.toString();
    await bot.sendMessage(cid, `Your Telegram Chat ID is: \`${cid}\``, { parse_mode: 'Markdown' });
});

bot.onText(/^\/add (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const targetUserId = match[1];

    console.log(`[Admin] /add command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /add attempt by ${cid}.`);
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    delete userStates[cid];
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);


    console.log(`[Admin] Admin ${cid} initiated /add for user ${targetUserId}. Prompting for app selection.`);

    try {
        await bot.sendChatAction(cid, 'typing');
        const sentMsg = await bot.sendMessage(cid, `Please select the app to assign to user \`${targetUserId}\`:`, { parse_mode: 'Markdown' });
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
    const targetUserId = match[1];

    if (callerId !== ADMIN_ID) {
        return bot.sendMessage(callerId, "❌ You are not authorized to use this command.");
    }

    try {
        await bot.sendChatAction(callerId, 'typing');
        const targetChat = await bot.getChat(targetUserId);

        const firstName = targetChat.first_name ? escapeMarkdown(targetChat.first_name) : 'N/A';
        const lastName = targetChat.last_name ? escapeMarkdown(targetChat.last_name) : 'N/A';
        const username = targetChat.username ? escapeMarkdown(targetChat.username) : 'N/A';
        const userIdEscaped = escapeMarkdown(targetUserId);

        let userDetails = `*Telegram User Info for ID:* \`${userIdEscaped}\`\n\n`;
        userDetails += `*First Name:* ${firstName}\n`;
        userDetails += `*Last Name:* ${lastName}\n`;
        userDetails += `*Username:* ${targetChat.username ? `@${username}` : 'N/A'}\n`;
        userDetails += `*Type:* ${escapeMarkdown(targetChat.type)}\n`;

        if (targetChat.username) {
            userDetails += `*Profile Link:* [t.me/${username}](https://t.me/${targetChat.username})\n`;
        }

        await bot.sendMessage(callerId, userDetails, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error fetching user info for ID ${targetUserId}:`, error.message);

        if (error.response && error.response.body && error.response.body.description) {
            const apiError = error.response.body.description;
            if (apiError.includes("chat not found") || apiError.includes("user not found")) {
                await bot.sendMessage(callerId, `❌ User with ID \`${targetUserId}\` not found or has not interacted with the bot.`);
            } else if (apiError.includes("bot was blocked by the user")) {
                await bot.sendMessage(callerId, `❌ The bot is blocked by user \`${targetUserId}\`. Cannot retrieve info.`);
            } else {
                await bot.sendMessage(callerId, `❌ Failed to get info for user \`${targetUserId}\`: ${apiError}`);
            }
        } else {
            console.error(`Full unexpected error object for ID ${targetUserId}:`, JSON.stringify(error, null, 2));
            await bot.sendMessage(callerId, `❌ An unexpected error occurred while fetching info for user \`${targetUserId}\`. Please check server logs for details.`);
        }
    }
});

bot.onText(/^\/remove (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const targetUserId = match[1];

    console.log(`[Admin] /remove command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /remove attempt by ${cid}.`);
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    delete userStates[cid];
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    const userBots = await getUserBots(targetUserId);
    if (!userBots.length) {
        return bot.sendMessage(cid, `User \`${targetUserId}\` has no bots deployed via this system.`, { parse_mode: 'Markdown' });
    }

    console.log(`[Admin] Admin ${cid} initiated /remove for user ${targetUserId}. Prompting for app removal selection.`);

    try {
        await bot.sendChatAction(cid, 'typing');
        const sentMsg = await bot.sendMessage(cid, `Select app to remove from user \`${targetUserId}\`'s dashboard:`, { parse_mode: 'Markdown' });

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

bot.onText(/^\/askadmin (.+)$/, async (msg, match) => {
    const userQuestion = match[1];
    const userChatId = msg.chat.id.toString();
    const userMessageId = msg.message_id;

    if (userChatId === ADMIN_ID) {
        return bot.sendMessage(userChatId, "You are the admin, you can't ask yourself questions!");
    }

    try {
        await bot.sendChatAction(userChatId, 'typing');
        const adminMessage = await bot.sendMessage(ADMIN_ID,
            `*New Question from User:* \`${userChatId}\` (U: @${msg.from.username || msg.from.first_name || 'N/A'})\n\n` +
            `*Message:* ${userQuestion}\n\n` +
            `_Reply to this message to send your response back to the user._`,
            { parse_mode: 'Markdown' }
        );

        forwardingContext[adminMessage.message_id] = {
            original_user_chat_id: userChatId,
            original_user_message_id: userMessageId,
            request_type: 'support_question'
        };
        console.log(`[Forwarding] Stored context for admin message ${adminMessage.message_id}:`, forwardingContext[adminMessage.message_id]);

        await bot.sendMessage(userChatId, '✅ Your question has been sent to the admin. You will be notified when they reply.');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, '❌ Failed to send your question to the admin. Please try again later.');
    }
});

bot.onText(/^\/send (\d+) ([a-zA-Z0-9]{4}-[a-zA-Z0-9]{4})$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const targetUserId = match[1];
    const pairingCode = match[2];

    if (cid !== ADMIN_ID) {
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    const userState = userStates[targetUserId];
    const userWaitingMessageId = userState?.data?.messageId;
    const userAnimateIntervalId = userState?.data?.animateIntervalId;

    if (userAnimateIntervalId) {
        clearInterval(userAnimateIntervalId);
        if (userWaitingMessageId) {
            await bot.editMessageText(`✅ Pairing code received! Sending to you now...`, {
                chat_id: targetUserId,
                message_id: userWaitingMessageId
            }).catch(err => console.error(`Failed to edit user's waiting message to "received": ${err.message}`));
        }
    }

    try {
        await bot.sendChatAction(targetUserId, 'typing'); // Typing for the user receiving the code
        await bot.sendMessage(targetUserId,
            `Your Pairing-code is:\n\n` +
            `\`${pairingCode}\`\n\n` +
            `Tap to Copy the CODE and paste it to your WhatsApp linked device ASAP!`,
            { parse_mode: 'Markdown' }
        );

        await bot.sendMessage(cid, `✅ Pairing code sent to user \`${targetUserId}\`.`);

        if (userStates[targetUserId] && userStates[targetUserId].step === 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN') {
            delete userStates[targetUserId];
            console.log(`[Pairing] Pairing code sent to user ${targetUserId} and user state cleared.`);
        } else {
            console.log(`[Pairing] User ${targetUserId} was not in AWAITING_PAIRING_CODE_FROM_ADMIN state. State not cleared.`);
        }

    } catch (e) {
        console.error(`Error sending pairing code to user ${targetUserId}:`, e);
        await bot.sendMessage(cid, `❌ Failed to send pairing code to user \`${targetUserId}\`. They might have blocked the bot or the chat no longer exists.`);
    }
});

bot.onText(/^\/stats$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) {
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    try {
        await bot.sendChatAction(cid, 'typing');
        const totalUsersResult = await pool.query('SELECT COUNT(DISTINCT user_id) AS total_users FROM user_bots');
        const totalUsers = totalUsersResult.rows[0].total_users;

        const totalBotsResult = await pool.query('SELECT COUNT(bot_name) AS total_bots FROM user_bots');
        const totalBots = totalBotsResult.rows[0].total_bots;

        const activeKeys = await getAllDeployKeys();
        let keyDetails = '';
        if (activeKeys.length > 0) {
            keyDetails = activeKeys.map(k => `\`${k.key}\` (Uses Left: ${k.uses_left}, By: ${k.created_by || 'N/A'})`).join('\n');
        } else {
            keyDetails = 'No active deploy keys.';
        }

        const totalFreeTrialUsersResult = await pool.query('SELECT COUNT(DISTINCT user_id) AS total_trial_users FROM temp_deploys');
        const totalFreeTrialUsers = totalFreeTrialUsersResult.rows[0].total_trial_users;

        const statsMessage = `
📊 *Bot Statistics:*

*Total Unique Users:* ${totalUsers}
*Total Deployed Bots:* ${totalBots}
*Users Who Used Free Trial:* ${totalFreeTrialUsers}

*Active Deploy Keys:*
${keyDetails}
        `;

        await bot.sendMessage(cid, statsMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error fetching stats:`, error.message);
        await bot.sendMessage(cid, `❌ An error occurred while fetching stats: ${error.message}`);
    }
});

bot.onText(/^\/users$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) {
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    try {
        await bot.sendChatAction(cid, 'typing');
        const userEntries = await pool.query('SELECT DISTINCT user_id FROM user_bots ORDER BY user_id');
        const userIds = userEntries.rows.map(row => row.user_id);

        if (userIds.length === 0) {
            return bot.sendMessage(cid, "No users have deployed bots yet.");
        }

        let responseMessage = '*Registered Users:*\n\n';
        const maxUsersPerMessage = 10;
        let messagesToSend = [];

        for (const userId of userIds) {
            let userDetail = '';
            try {
                const targetChat = await bot.getChat(userId);
                const firstName = targetChat.first_name ? escapeMarkdown(targetChat.first_name) : 'N/A';
                const lastName = targetChat.last_name ? escapeMarkdown(targetChat.last_name) : 'N/A';
                const username = targetChat.username ? `@${escapeMarkdown(targetChat.username)}` : 'N/A';
                const userIdEscaped = escapeMarkdown(userId);

                const userBots = await getUserBots(userId);
                const botsList = userBots.length > 0 ? userBots.map(b => `\`${escapeMarkdown(b)}\``).join(', ') : 'No bots deployed';

                userDetail += `*ID:* \`${userIdEscaped}\`\n`;
                userDetail += `*Name:* ${firstName} ${lastName}\n`;
                userDetail += `*Username:* ${username}\n`;
                userDetail += `*Bots:* ${botsList}\n\n`;

            } catch (error) {
                console.error(`Error fetching Telegram info or bots for user ${userId}:`, error.message);
                if (error.response && error.response.body && error.response.body.description && (error.response.body.description.includes("chat not found") || error.response.body.description.includes("user not found"))) {
                     userDetail += `*ID:* \`${escapeMarkdown(userId)}\`\n*Status:* ❌ User chat not found or bot blocked.\n\n`;
                } else {
                     userDetail += `*ID:* \`${escapeMarkdown(userId)}\`\n*Status:* ❌ Error fetching info: ${escapeMarkdown(error.message)}\n\n`;
                }
            }

            if ((responseMessage + userDetail).length > 4000 || messagesToSend.length % maxUsersPerMessage === 0 && messagesToSend.length > 0) {
                messagesToSend.push(responseMessage);
                responseMessage = '*Registered Users (continued):*\n\n';
            }
            responseMessage += userDetail;
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (responseMessage.trim() !== '*Registered Users (continued):*' && responseMessage.trim() !== '*Registered Users:*') {
            messagesToSend.push(responseMessage);
        }

        for (const message of messagesToSend) {
            await bot.sendMessage(cid, message, { parse_mode: 'Markdown' });
            await new Promise(resolve => setTimeout(resolve, 500));
        }

    } catch (error) {
        console.error(`Error fetching user list:`, error.message);
        await bot.sendMessage(cid, `❌ An error occurred while fetching the user list: ${error.message}`);
    }
});


// 12) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  await notifyAdminUserOnline(msg);

  if (isMaintenanceMode && cid !== ADMIN_ID) {
      await bot.sendMessage(cid, "Bot On Maintenance, Come Back Later.");
      return;
  }

  const st = userStates[cid];
  const isAdmin = cid === ADMIN_ID;

  if (msg.reply_to_message && msg.reply_to_message.from.id.toString() === bot.options.id.toString()) {
      const repliedToBotMessageId = msg.reply_to_message.message_id;
      const context = forwardingContext[repliedToBotMessageId];

      if (context && context.request_type === 'support_question' && cid === ADMIN_ID) {
          const { original_user_chat_id, original_user_message_id } = context;
          try {
              await bot.sendChatAction(cid, 'typing'); // Admin replying
              await bot.sendMessage(original_user_chat_id, `*Admin replied:*\n${msg.text}`, {
                  parse_mode: 'Markdown',
                  reply_to_message_id: original_user_message_id
              });
              await bot.sendMessage(cid, '✅ Your reply has been sent to the user.');
              delete forwardingContext[repliedToBotMessageId];
              console.log(`[Forwarding] Context for support question reply ${repliedToBotMessageId} cleared.`);
          } catch (e) {
              console.error('Error forwarding admin reply (support question):', e);
              await bot.sendMessage(cid, '❌ Failed to send your reply to the user. They might have blocked the bot or the chat no longer exists.');
          }
          return;
      }
      console.log(`Received reply to bot message ${repliedToBotMessageId} from ${cid} but not a support question reply. Ignoring.`);
      return;
  }

  if (st && st.step === 'AWAITING_ADMIN_QUESTION_TEXT') {
    const userQuestion = msg.text;
    const userChatId = cid;
    const userMessageId = msg.message_id;

    try {
        await bot.sendChatAction(userChatId, 'typing'); // User sends question, bot acknowledges
        const adminMessage = await bot.sendMessage(ADMIN_ID,
            `*New Question from User:* \`${userChatId}\` (U: @${msg.from.username || msg.from.first_name || 'N/A'})\n\n` +
            `*Message:* ${userQuestion}\n\n` +
            `_Reply to this message to send your response back to the user._`,
            { parse_mode: 'Markdown' }
        );

        forwardingContext[adminMessage.message_id] = {
            original_user_chat_id: userChatId,
            original_user_message_id: userMessageId,
            request_type: 'support_question'
        };
        console.log(`[Forwarding] Stored context for admin message ${adminMessage.message_id}:`, forwardingContext[adminMessage.message_id]);

        await bot.sendMessage(userChatId, '✅ Your question has been sent to the admin. You will be notified when they reply.');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, '❌ Failed to send your question to the admin. Please try again later.');
    } finally {
        delete userStates[cid];
    }
    return;
  }


  if (text === 'Deploy') {
    if (isAdmin) {
      userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Please enter your session ID');
    } else {
      userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Enter your Deploy key');
    }
  }

  if (text === 'Free Trial') {
    const check = await canDeployFreeTrial(cid);
    if (!check.can) {
        return bot.sendMessage(cid, `⏳ You have already used your Free Trial. You can use it again after:\n\n${check.cooldown.toLocaleString()}`);
    }
    userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: true } };
    return bot.sendMessage(cid, 'Free Trial (1 hour runtime, 14-day cooldown) initiated.\n\nPlease enter your session ID:');
  }

  if (text === 'Apps' && isAdmin) {
    return sendAppList(cid);
  } else if (text === 'Apps' && !isAdmin) {
    return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
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
  } else if (text === 'Generate Key' && !isAdmin) {
    return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
  }


  if (text === 'Get Session') {
    const guideCaption =
       "To get your session ID, please follow these steps carefully:\n\n" +
        "1️⃣ *Open the Link:*\n" +
        "Visit: <https://levanter-delta.vercel.app/>\n" +
        "Use the 'Custom Session ID' button if you prefer.\n\n" +
        "2️⃣ *Important for iPhone Users:*\n" +
        "If you are on an iPhone, please open the link using the **Google Chrome** browser.\n\n" +
        "3️⃣ *Skip Advertisements:*\n" +
        "The website may show ads. Please close or skip any popups or advertisements to proceed.\n\n" +
        "4️⃣ *Copy Your Session ID:*\n" +
        "Once you are done logging in, check your personal chat and copy the first message starting with `levanter_`.\n\n" +
        "5️⃣ *Final Step: Launch Your Bot:*\n" +
        "When you're done, come back here and tap the 'Deploy' button to launch your bot. Remember to get your Deploy key from the Admin.";

    const keyboard = {
        inline_keyboard: [
            [{ text: "Can't get code?", callback_data: "cant_get_code" }]
        ]
    };

    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/syx8uk.jpeg', {
        caption: guideCaption,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (e) {
        console.error(`Error sending photo in Get Session: ${e.message}`);
        await bot.sendMessage(cid, guideCaption, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
    return;
  }

  if (text === 'My Bots') {
    console.log(`[Flow] My Bots button clicked by user: ${cid}`);
    const bots = await getUserBots(cid);
    if (!bots.length) {
        return bot.sendMessage(cid, "You haven't deployed any bots yet. Would you like to deploy your first bot?", {
            reply_markup: {
                inline_keyboard: [[{ text: '🚀 Deploy Now!', callback_data: 'deploy_first_bot' }]]
            }
        });
    }
    await bot.sendChatAction(cid, 'typing');
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
            [{ text: 'Ask Admin a Question', callback_data: 'ask_admin_question' }]
        ]
    };
    return bot.sendMessage(cid, `For help, you can contact the admin directly:`, {
        reply_markup: supportKeyboard,
        parse_mode: 'Markdown'
    });
  }

  if (st && st.step === 'AWAITING_PHONE_NUMBER') {
    const phoneNumber = text;
    const phoneRegex = /^\+\d{13}$/;

    if (!phoneRegex.test(phoneNumber)) {
        return bot.sendMessage(cid, '❌ Invalid format. Please send your WhatsApp number in the full international format `+2349163XXXXXXX` (14 characters, including the `+`), e.g., `+23491630000000`.', { parse_mode: 'Markdown' });
    }

    const { first_name, last_name, username } = msg.from;
    const userDetails = `User: \`${cid}\` (TG: @${username || first_name || 'N/A'})`;

    await bot.sendChatAction(ADMIN_ID, 'typing'); // Admin will receive this
    const adminMessage = await bot.sendMessage(ADMIN_ID,
        `📞 *Pairing Request from User:*\n` +
        `${userDetails}\n` +
        `*WhatsApp Number:* \`${phoneNumber}\`\n\n` +
        `_Do you want to accept this pairing request and provide a code?_`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Accept Request', callback_data: `pairing_action:accept:${cid}` }],
                    [{ text: '❌ Decline Request', callback_data: `pairing_action:decline:${cid}` }]
                ]
            }
        }
    );

    await bot.sendChatAction(cid, 'typing'); // User is waiting
    const waitingMsg = await bot.sendMessage(cid, `⚙️ Your request has been sent to the admin. Please wait for the Pairing-code...`);
    const animateIntervalId = await animateMessage(cid, waitingMsg.message_id, 'Waiting for Pairing-code');
    userStates[cid].step = 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN';
    userStates[cid].data = { messageId: waitingMsg.message_id, animateIntervalId: animateIntervalId };

    const timeoutIdForPairing = setTimeout(async () => {
        if (userStates[cid] && userStates[cid].step === 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN') {
            console.log(`[Pairing Timeout] Request from user ${cid} timed out.`);
            if (userStates[cid].data.animateIntervalId) {
                clearInterval(userStates[cid].data.animateIntervalId);
            }
            if (userStates[cid].data.messageId) {
                await bot.editMessageText('⌛ Pairing request timed out. The admin did not respond in time. Please try again later.', {
                    chat_id: cid,
                    message_id: userStates[cid].data.messageId
                }).catch(err => console.error(`Failed to edit user's timeout message: ${err.message}`));
            }
            await bot.sendMessage(ADMIN_ID, `🔔 Pairing request from user \`${cid}\` (Phone: \`${phoneNumber}\`) timed out after 60 seconds.`);
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

    await bot.sendChatAction(cid, 'typing');
    const verificationMsg = await bot.sendMessage(cid, `${getAnimatedEmoji()} Verifying key...`);
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
      const contactOwnerMessage = `Invalid, Please contact the owner for a KEY.`;
      const contactOwnerKeyboard = {
          inline_keyboard: [
              [{ text: 'Contact Owner', url: 'https://wa.me/message/JIIC2JFMHUPEM1' }]
          ]
      };
      await bot.editMessageText(contactOwnerMessage, {
        chat_id: cid,
        message_id: verificationMsg.message_id,
        reply_markup: contactOwnerKeyboard,
        parse_mode: 'Markdown'
      });
      return;
    }

    await bot.editMessageText(`✅ Verified!`, {
        chat_id: cid,
        message_id: verificationMsg.message_id
    });
    await new Promise(r => setTimeout(r, 1000));

    authorizedUsers.add(cid);
    st.step = 'SESSION_ID';

    const { first_name, last_name, username } = msg.from;
    const userDetails = [
      `*Name:* ${first_name || ''} ${last_name || ''}`,
      `*Username:* @${username || 'N/A'}`,
      `*Chat ID:* \`${cid}\``
    ].join('\n');

    await bot.sendChatAction(ADMIN_ID, 'typing');
    await bot.sendMessage(ADMIN_ID,
      `🔑 *Key Used By:*\n${userDetails}\n\n*Uses Left:* ${usesLeft}`,
      { parse_mode: 'Markdown' }
    );
    return bot.sendMessage(cid, 'Please enter your session ID:');
  }

  if (st && st.step === 'SESSION_ID') {
    if (text.length < 10) {
      return bot.sendMessage(cid, 'Session ID must be at least 10 characters long.');
    }
    st.data.SESSION_ID = text.trim();
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, 'Great. Now enter a name for your bot (e.g., my-awesome-bot or utarbot12):');
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
      return bot.sendMessage(cid, `The name "${nm}" is already taken. Please choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = nm;

        st.step = 'AWAITING_WIZARD_CHOICE';

        const wizardText = `App name "*${nm}*" is available.\n\n*Next Step:*\nEnable automatic status view? This marks statuses as seen automatically.`;
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
        await bot.sendChatAction(cid, 'typing');
        const wizardMsg = await bot.sendMessage(cid, wizardText, { ...wizardKeyboard, parse_mode: 'Markdown' });
        st.message_id = wizardMsg.message_id;

      } else {
        console.error(`Error checking app name "${nm}":`, e.response?.data?.message || e.message);
        return bot.sendMessage(cid, `Could not verify app name. The Heroku API might be down. Please try again later.`);
      }
    }
  }

  if (st && st.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME, targetUserId: targetUserIdFromState } = st.data;
    const newVal = text.trim();

    const finalUserId = targetUserIdFromState || cid;

    if (VAR_NAME === 'SESSION_ID' && newVal.length < 10) {
        return bot.sendMessage(cid, 'Session ID must be at least 10 characters long.');
    }

    try {
      await bot.sendChatAction(cid, 'typing');
      const updateMsg = await bot.sendMessage(cid, `Updating ${VAR_NAME} for "${APP_NAME}"...`);

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

      console.log(`[Flow] SETVAR_ENTER_VALUE: Config var updated for "${APP_NAME}". Updating bot in user_bots DB for user "${finalUserId}".`);
      await addUserBot(finalUserId, APP_NAME, newVal);

      const baseWaitingText = `Updated ${VAR_NAME} for "${APP_NAME}". Waiting for bot status confirmation...`;
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
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.`));
                  appDeploymentPromises.delete(APP_NAME);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise;
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);

          await bot.editMessageText(`✅ ${VAR_NAME} for "${APP_NAME}" updated successfully and bot is back online!`, {
              chat_id: cid,
              message_id: updateMsg.message_id
          });
          console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${APP_NAME}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${APP_NAME} after variable update:`, err.message);
          await bot.editMessageText(
              `⚠️ Bot "${APP_NAME}" failed to come online after variable "${VAR_NAME}" update: ${err.message}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Change Session ID', callback_data: `change_session:${APP_NAME}:${finalUserId}` }]
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
      console.error(`[API_CALL_ERROR] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data);
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
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

  console.log(`[CallbackQuery] Received: action=${action}, payload=${payload}, extra=${extra}, flag=${flag} from ${cid}`);
  console.log(`[CallbackQuery] Current state for ${cid}:`, userStates[cid]);

  if (action === 'deploy_first_bot') {
    if (cid === ADMIN_ID) {
        userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
        return bot.sendMessage(cid, 'Please enter your session ID');
    } else {
        userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
        return bot.sendMessage(cid, 'Enter your Deploy key');
    }
  }

  if (action === 'ask_admin_question') {
      delete userStates[cid];
      userStates[cid] = { step: 'AWAITING_ADMIN_QUESTION_TEXT', data: {} };
      await bot.sendChatAction(cid, 'typing');
      await bot.sendMessage(cid, 'Please type your question for the admin:');
      return;
  }

  if (action === 'cant_get_code') {
      delete userStates[cid];
      userStates[cid] = { step: 'AWAITING_PHONE_NUMBER', data: {} };

      await bot.sendChatAction(cid, 'typing');
      await bot.sendMessage(cid,
          'Please send your WhatsApp number in the full international format including the `+` e.g., `+23491630000000`.',
          {
              parse_mode: 'Markdown'
          }
      );
      return;
  }

  if (action === 'pairing_action') {
      if (cid !== ADMIN_ID) {
          await bot.sendMessage(cid, "❌ You are not authorized to perform this action.");
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

      const userMessageId = userStates[targetUserChatId]?.data?.messageId;
      const userAnimateIntervalId = userStates[targetUserChatId]?.data?.animateIntervalId;

      if (userAnimateIntervalId) {
          clearInterval(userAnimateIntervalId);
          if (userMessageId) {
              await bot.editMessageText(`✅ Admin action received!`, {
                  chat_id: targetUserChatId,
                  message_id: userMessageId
              }).catch(err => console.error(`Failed to edit user's message after admin action: ${err.message}`));
          }
      }

      if (decision === 'accept') {
          if (userMessageId) {
              await new Promise(r => setTimeout(r, 3000));
              await bot.sendChatAction(targetUserChatId, 'typing');
              const newAnimateIntervalId = await animateMessage(targetUserChatId, userMessageId, 'Wait for your pairing code...');
              userStates[targetUserChatId].data.animateIntervalId = newAnimateIntervalId;
          }

          await bot.sendChatAction(ADMIN_ID, 'typing');
          await bot.sendMessage(ADMIN_ID,
              `✅ Accepted pairing request from user \`${targetUserChatId}\` (Phone: \`${context.user_phone_number}\`).\n\n` +
              `*Now, please use the command below to send the Code:*\n` +
              `\`/send ${targetUserChatId} \`\n\n` +
              `[Session ID Generator](https://levanter-delta.vercel.app/)`,
              { parse_mode: 'Markdown' }
          );

          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: cid,
              message_id: adminMessageId
          }).catch(() => {});
          await bot.editMessageText(q.message.text + `\n\n_Status: Accepted. Admin needs to use /send command._`, {
              chat_id: cid,
              message_id: adminMessageId,
              parse_mode: 'Markdown'
          }).catch(() => {});


      } else {
          await bot.sendChatAction(targetUserChatId, 'typing');
          await bot.sendMessage(targetUserChatId, 'An error occurred! Pairing code request declined by admin.');
          await bot.sendChatAction(ADMIN_ID, 'typing');
          await bot.sendMessage(ADMIN_ID, `❌ Pairing request from user \`${targetUserChatId}\` declined.`);

          delete userStates[targetUserChatId];

          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: cid,
              message_id: adminMessageId
          }).catch(() => {});
          await bot.editMessageText(q.message.text + `\n\n_Status: Declined by Admin._`, {
              chat_id: cid,
              message_id: adminMessageId,
              parse_mode: 'Markdown'
          }).catch(() => {});
      }
      return;
  }

  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    await bot.sendChatAction(cid, 'typing');
    return bot.sendMessage(cid, `Generated key: \`${key}\`\nUses: ${uses}`, { parse_mode: 'Markdown' });
  }

  if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    const messageId = q.message.message_id;
    const appName = payload;

    userStates[cid] = { step: 'APP_MANAGEMENT', data: { appName: appName, messageId: messageId, isUserBot: isUserBot } };

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`⚙️ Fetching app status for "*${appName}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });

    return bot.editMessageText(`Manage app "*${appName}*":`, {
      chat_id: cid,
      message_id: messageId,
      parse_mode: 'Markdown',
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
          [{ text: '◀️️ Back', callback_data: 'back_to_app_list' }]
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
        await bot.editMessageText("❌ You are not authorized to perform this action.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_ADD' || st.data.targetUserId !== targetUserId) {
        console.error(`[CallbackQuery - add_assign_app] State mismatch for ${cid}. Expected AWAITING_APP_FOR_ADD for ${targetUserId}, got:`, st);
        await bot.editMessageText("This add session has expired or is invalid. Please start over with `/add <user_id>`.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid];
        return;
    }

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Assigning app "*${appName}*" to user \`${targetUserId}\`...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
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
            await bot.editMessageText(`⚠️ Cannot assign "*${appName}*". It does not have a SESSION_ID config variable set on Heroku. Please set it manually first or deploy it via the bot.`, {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'Markdown'
            });
            delete userStates[cid];
            return;
        }

        await addUserBot(targetUserId, appName, currentSessionId);
        console.log(`[Admin] Successfully called addUserBot for ${appName} to user ${targetUserId} with fetched session ID.`);

        await bot.editMessageText(`✅ App "*${appName}*" successfully assigned to user \`${targetUserId}\`! It will now appear in their "My Bots" menu.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        await bot.sendChatAction(targetUserId, 'typing');
        await bot.sendMessage(targetUserId, `🎉 Your bot "*${appName}*" has been successfully assigned to your "My Bots" menu by the admin! You can now manage it.`, { parse_mode: 'Markdown' });
        console.log(`[Admin] Sent success notification to target user ${targetUserId}.`);

    } catch (e) {
        if (e.response && e.response.status === 404) {
            await handleAppNotFoundAndCleanDb(cid, appName, q.message.message_id, false);
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error assigning app "${appName}" to user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`❌ Failed to assign app "*${appName}*" to user \`${targetUserId}\`: ${errorMsg}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    } finally {
        delete userStates[cid];
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
        await bot.editMessageText("❌ You are not authorized to perform this action.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_REMOVAL' || st.data.targetUserId !== targetUserId) {
        console.error(`[CallbackQuery - remove_app_from_user] State mismatch for ${cid}. Expected AWAITING_APP_FOR_REMOVAL for ${targetUserId}, got:`, st);
        await bot.editMessageText("This removal session has expired or is invalid. Please start over with `/remove <user_id>`.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid];
        return;
    }

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Removing app "*${appName}*" from user \`${targetUserId}\`'s dashboard...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        await deleteUserBot(targetUserId, appName);
        console.log(`[Admin] Successfully called deleteUserBot for ${appName} from user ${targetUserId}.`);

        await bot.editMessageText(`✅ App "*${appName}*" successfully removed from user \`${targetUserId}\`'s dashboard.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        await bot.sendChatAction(targetUserId, 'typing');
        await bot.sendMessage(targetUserId, `ℹ️ The admin has removed bot "*${appName}*" from your "My Bots" menu.`, { parse_mode: 'Markdown' });
        console.log(`[Admin] Sent removal notification to target user ${targetUserId}.`);

    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error removing app "${appName}" from user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`❌ Failed to remove app "*${appName}*" from user \`${targetUserId}\`'s dashboard: ${errorMsg}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    } finally {
        delete userStates[cid];
        console.log(`[Admin] State cleared for ${cid} after remove_app_from_user flow.`);
    }
    return;
  }


  if (action === 'info') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText('⚙️ Fetching app info...', { chat_id: cid, message_id: messageId });
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

      let dynoStatus = '⚪️ Scaled to 0 / Off';
      let statusEmoji = '⚪️';

      if (dynoData.length > 0) {
          const workerDyno = dynoData.find(d => d.type === 'worker');
          if (workerDyno) {
              const state = workerDyno.state;
              if (state === 'up') {
                  statusEmoji = '🟢';
                  dynoStatus = `${statusEmoji} Up`;
              } else if (state === 'crashed') {
                  statusEmoji = '🔴';
                  dynoStatus = `${statusEmoji} Crashed`;
              } else if (state === 'idle') {
                  statusEmoji = '🟡';
                  dynoStatus = `${statusEmoji} Idle`;
              } else if (state === 'starting' || state === 'restarting') {
                  statusEmoji = '⏳';
                  dynoStatus = `${statusEmoji} ${state.charAt(0).toUpperCase() + state.slice(1)}`;
              } else {
                  statusEmoji = '❓';
                  dynoStatus = `${statusEmoji} Unknown State: ${state}`;
              }
          } else {
              dynoStatus = '⚪️ Worker dyno not active/scaled to 0';
          }
      }


      const info = `*App Info: ${appData.name}*\n\n` +
                   `*Dyno Status:* ${dynoStatus}\n` +
                   `*Created:* ${new Date(appData.created_at).toLocaleDateString()} (${Math.ceil(Math.abs(new Date() - new Date(appData.created_at)) / (1000 * 60 * 60 * 24))} days ago)\n` +
                   `*Last Release:* ${new Date(appData.released_at).toLocaleString()}\n` +
                   `*Stack:* ${appData.stack.name}\n\n` +
                   `*🔧 Key Config Vars:*\n` +
                   `  \`SESSION_ID\`: ${configData.SESSION_ID ? '✅ Set' : '❌ Not Set'}\n` +
                   `  \`AUTO_STATUS_VIEW\`: \`${configData.AUTO_STATUS_VIEW || 'false'}\`\n`;

      return bot.editMessageText(info, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true);
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`Error fetching info for ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`Error fetching info: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'restart') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`🔄 Restarting bot "*${payload}*"...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });

      await bot.editMessageText(`✅ Bot "*${payload}*" restarted successfully!`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
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
      return bot.editMessageText(`❌ Error restarting bot: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } finally {
        delete userStates[cid];
    }
  }

  if (action === 'logs') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText('📄 Fetching logs...', { chat_id: cid, message_id: messageId });
    try {
      const sess = await axios.post(`https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: false, lines: 100 },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      const logRes = await axios.get(sess.data.logplex_url);
      const logs = logRes.data.trim().slice(-4000);

      return bot.editMessageText(`Logs for "*${payload}*":\n\`\`\`\n${logs || 'No recent logs.'}\n\`\`\``, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      if (e.response && e.response.status === 404) {
          await handleAppNotFoundAndCleanDb(cid, payload, messageId, true);
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching logs: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'delete' || action === 'userdelete') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

      return bot.editMessageText(`Are you sure you want to delete the app "*${payload}*"? This action cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: "Yes, I'm sure", callback_data: `confirmdelete:${payload}:${action}` },
            { text: "No, cancel", callback_data: `selectapp:${payload}` }
          ]]
        }
      });
  }

  if (action === 'confirmdelete') {
      const appToDelete = payload;
      const originalAction = extra;
      const st = userStates[cid];
      if (!st || st.data.appName !== appToDelete) {
          return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
      }
      const messageId = q.message.message_id;

      await bot.sendChatAction(cid, 'typing');
      await bot.editMessageText(`🗑️ Deleting "*${appToDelete}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
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
          await bot.editMessageText(`✅ App "*${appToDelete}*" has been permanently deleted.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
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
          return bot.editMessageText(`❌ Failed to delete app: ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appToDelete}` }]]
            }
          });
      }
  }

  if (action === 'canceldelete') {
      return bot.editMessageText('Deletion cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
  }

  if (action === 'setvar') {
    const st = userStates[cid];
    if (!st || st.data.appName !== payload) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    return bot.editMessageText(`Select a variable to set for "*${payload}*":`, {
      chat_id: cid,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${payload}` }],
          [{ text: 'AUTO_STATUS_VIEW', callback_data: `varselect:AUTO_STATUS_VIEW:${payload}` }],
          [{ text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${payload}` }],
          [{ text: 'PREFIX', callback_data: `varselect:PREFIX:${payload}` }],
          [{ text: 'ANTI_DELETE', callback_data: `varselect:ANTI_DELETE:${payload}` }],
          [{ text: '◀️️ Back', callback_data: `selectapp:${payload}` }]
        ]
      }
    });
  }

  if (action === 'varselect') {
    const [varKey, appName] = [payload, extra];
    const st = userStates[cid];
    if (!st || st.data.appName !== appName) {
        return bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
    }
    const messageId = q.message.message_id;

    if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE'].includes(varKey)) {
      await bot.sendChatAction(cid, 'typing');
      return bot.editMessageText(`Set *${varKey}* to:`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ],
          [{ text: '◀️️ Back', callback_data: `setvar:${appName}` }]]
        }
      });
    } else {
      userStates[cid].step = 'SETVAR_ENTER_VALUE';
      userStates[cid].data.VAR_NAME = varKey;
      userStates[cid].data.APP_NAME = appName;
      userStates[cid].data.targetUserId = st.data.targetUserId || cid;
      await bot.sendChatAction(cid, 'typing');
      return bot.sendMessage(cid, `Please enter the new value for *${varKey}*:`, { parse_mode: 'Markdown' });
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
      const updateMsg = await bot.sendMessage(cid, `Updating *${varKey}* for "*${appName}*"...`, { parse_mode: 'Markdown' });
      console.log(`[API_CALL] Patching Heroku config vars (boolean) for ${appName}: { ${varKey}: '${newVal}' }`);
      const patchResponse = await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      console.log(`[API_CALL_SUCCESS] Heroku config vars (boolean) patched successfully for ${appName}. Status: ${patchResponse.status}`);

      const currentOwnerId = await getUserIdByBotName(appName);
      if (currentOwnerId) {
          console.log(`[Flow] setvarbool: Config var updated for "${appName}". Updating bot in user_bots DB for owner "${currentOwnerId}".`);
          const { session_id: currentSessionId } = await pool.query('SELECT session_id FROM user_bots WHERE user_id=$1 AND bot_name=$2', [currentOwnerId, appName]).then(res => res.rows[0] || {});
          await addUserBot(currentOwnerId, appName, currentSessionId);
      } else {
          console.warn(`[Flow] setvarbool: No owner found for bot "${appName}". Cannot update session in DB.`);
      }

      const baseWaitingText = `Updated *${varKey}* for "*${appName}*". Waiting for bot status confirmation...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, {
          chat_id: cid,
          message_id: updateMsg.message_id,
          parse_mode: 'Markdown'
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
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.`));
                  appDeploymentPromises.delete(appName);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise;
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);

          await bot.editMessageText(`✅ Variable "*${varKey}*" for "*${appName}*" updated successfully and bot is back online!`, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]
                  ]
              }
          });
          console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${appName}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${appName} after variable update:`, err.message);
          await bot.editMessageText(
              `⚠️ Bot "*${appName}*" failed to come online after variable "*${varKey}*" update: ${err.message}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
                  parse_mode: 'Markdown',
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Change Session ID', callback_data: `change_session:${appName}:${cid}` }],
                          [{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]
                      ]
                  }
              }
          );
      } finally {
          appDeploymentPromises.delete(appName);
      }

    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`[API_CALL_ERROR] Error updating boolean variable ${varKey} for ${appName}:`, errorMsg, e.response?.data);
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
  }

  if (action === 'change_session') {
      const appName = payload;
      const targetUserId = extra;

      if (cid !== targetUserId) {
          await bot.sendMessage(cid, `You can only change the session ID for your own bots.`);
          return;
      }

      userStates[cid] = {
          step: 'SETVAR_ENTER_VALUE',
          data: {
              APP_NAME: appName,
              VAR_NAME: 'SESSION_ID',
              targetUserId: targetUserId
          }
      };
      await bot.sendChatAction(cid, 'typing');
      await bot.sendMessage(cid, `Please enter the *new* session ID for your bot "*${appName}*":`, { parse_mode: 'Markdown' });
      return;
  }

  if (action === 'admin_delete_trial_app') {
      const appToDelete = payload;
      const messageId = q.message.message_id;

      if (cid !== ADMIN_ID) {
          await bot.editMessageText("❌ You are not authorized to perform this action.", { chat_id: cid, message_id: messageId });
          return;
      }

      await bot.sendChatAction(cid, 'typing');
      await bot.editMessageText(`🗑️ Admin deleting Free Trial app "*${appToDelete}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          const ownerId = await getUserIdByBotName(appToDelete);
          if (ownerId) await deleteUserBot(ownerId, appToDelete);

          await bot.editMessageText(`✅ Free Trial app "*${appToDelete}*" permanently deleted by Admin.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
          if (ownerId && ownerId !== cid) {
              await bot.sendChatAction(ownerId, 'typing');
              await bot.sendMessage(ownerId, `ℹ️ Your Free Trial bot "*${appToDelete}*" has been manually deleted by the admin.`, { parse_mode: 'Markdown' });
          }
      } catch (e) {
          if (e.response && e.response.status === 404) {
              await handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, false);
              return;
          }
          const errorMsg = e.response?.data?.message || e.message;
          await bot.editMessageText(`❌ Failed to delete Free Trial app "*${appToDelete}*": ${errorMsg}`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }
      return;
  }

  if (action === 'redeploy_app') {
    const appName = payload;
    const messageId = q.message.message_id;

    const isOwner = (await getUserIdByBotName(appName)) === cid;
    if (cid !== ADMIN_ID && !isOwner) {
        await bot.editMessageText("❌ You are not authorized to redeploy this app.", { chat_id: cid, message_id: messageId });
        return;
    }

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`🔄 Redeploying "*${appName}*" from GitHub...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
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

        await bot.editMessageText(`🛠️ Build initiated for "*${appName}*". Waiting for completion...`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
        animateIntervalId = await animateMessage(cid, messageId, `Building "*${appName}*" from GitHub...`);

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

        await bot.editMessageText(`✅ App "*${appName}*" redeployed successfully!`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]]
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
        await bot.editMessageText(`❌ Failed to redeploy "*${appName}*": ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '◀️️ Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    } finally {
        if (animateIntervalId) clearInterval(animateIntervalId);
        delete userStates[cid];
    }
    return;
  }

  if (action === 'back_to_app_list') {
    const isAdmin = cid === ADMIN_ID;
    const currentMessageId = q.message.message_id;

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
          return bot.editMessageText("You haven't deployed any bots yet.", { chat_id: cid, message_id: currentMessageId });
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
            console.log(`[Channel Post] No active deployment promise for ${botName}, processing logout as an alert.`);
        }

        const userId = await getUserIdByBotName(botName);
        if (userId) {
            const warningMessage =
                `⚠️ Your bot "*${botName}*" has been logged out due to an invalid session.\n` +
                `Please update your session ID to get it back online.`;

            await bot.sendChatAction(userId, 'typing');
            await bot.sendMessage(userId, warningMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Change Session ID', callback_data: `change_session:${botName}:${userId}` }]
                    ]
                }
            });
            console.log(`[Channel Post] Sent logout notification to user ${userId} for bot ${botName}`);
        } else {
            console.error(`[Channel Post] CRITICAL: Could not find user for bot "${botName}" during logout alert. Is this bot tracked in the database?`);
            bot.sendMessage(ADMIN_ID, `⚠️ Untracked bot "${botName}" logged out. User ID not found in DB.`);
        }
        return;
    }

    const connectedMatch = text.match(/✅ \[([^\]]+)\] connected\..*/si);
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
                        `🔔 *Reminder:* Your bot "*${bot_name}*" has been logged out for more than 24 hours!\n` +
                        `It appears to still be offline. Please update your session ID to bring it back online.`;

                    await bot.sendChatAction(user_id, 'typing');
                    await bot.sendMessage(user_id, reminderMessage, {
                        parse_mode: 'Markdown',
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
                    await bot.sendChatAction(currentOwnerId, 'typing');
                    await bot.sendMessage(currentOwnerId, `ℹ️ Your bot "*${herokuApp}*" was not found on Heroku and has been automatically removed from your "My Bots" list.`, { parse_mode: 'Markdown' });
                }
                return;
            }
            console.error(`[Scheduled Task] Error checking status for bot ${herokuApp} (user ${user_id}):`, error.response?.data?.message || error.message);
        }
    }
}

setInterval(checkAndRemindLoggedOutBots, 60 * 60 * 1000);

console.log('Bot is running...');
