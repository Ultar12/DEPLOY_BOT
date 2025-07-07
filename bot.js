// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

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
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// 4) Postgres setup & ensure tables exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  try {
    // --- START: Database Schema Initialization/Correction ---
    // IMPORTANT: Dropping tables will DELETE ALL DATA in them.
    // We drop temp_deploys and bot_notifications to ensure the correct schema is always applied
    // without manual intervention, especially after schema changes.
    // user_bots and deploy_keys are NOT dropped as they contain persistent user data.

    console.log('Ensuring database schema is up to date...');

    // Drop and recreate temp_deploys to ensure 'app_name' column exists and is PK
    await pool.query(`DROP TABLE IF EXISTS temp_deploys;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS temp_deploys (
        user_id       TEXT NOT NULL,
        app_name      TEXT PRIMARY KEY,
        last_deploy_at TIMESTAMP NOT NULL,
        delete_at     TIMESTAMP NOT NULL
      );
    `);
    console.log('Table temp_deploys ensured.');

    // Drop and recreate bot_notifications to ensure correct schema
    await pool.query(`DROP TABLE IF EXISTS bot_notifications;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_notifications (
          app_name TEXT NOT NULL,
          user_id TEXT NOT NULL,
          error_type TEXT NOT NULL,
          last_notified TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (app_name, error_type)
      );
    `);
    console.log('Table bot_notifications ensured.');

    // Ensure user_bots table exists (without dropping, to preserve data)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
        session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Table user_bots ensured.');

    // Ensure deploy_keys table exists (without dropping, to preserve data)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deploy_keys (
        key        TEXT PRIMARY KEY,
        uses_left  INTEGER NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Table deploy_keys ensured.');

    // --- END: Database Schema Initialization/Correction ---

  } catch (e) {
    console.error('Error during database schema setup:', e);
    process.exit(1); // Exit if DB setup fails, as bot won't function correctly
  }
})().catch(console.error); // Catch any unhandled promise rejections from the async IIFE

// 5) DB helper functions
async function addUserBot(u, b, s) {
  await pool.query(
    'INSERT INTO user_bots(user_id,bot_name,session_id) VALUES($1,$2,$3)',
    [u, b, s]
  );
}
async function getUserBots(u) {
  const r = await pool.query(
    'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
    [u]
  );
  return r.rows.map(x => x.bot_name);
}
// New function to get user_id by bot_name
async function getUserIdByBotName(botName) {
    const res = await pool.query('SELECT user_id FROM user_bots WHERE bot_name = $1', [botName]);
    return res.rows.length > 0 ? res.rows[0].user_id : null;
}

async function deleteUserBot(u, b) {
  await pool.query(
    'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
    [u, b]
  );
}
async function updateUserSession(u, b, s) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [s, u, b]
  );
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
async function recordFreeTrialDeploy(userId, appName) {
    const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day from now
    await pool.query(
        `INSERT INTO temp_deploys (user_id, app_name, last_deploy_at, delete_at) VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (app_name) DO UPDATE SET last_deploy_at = NOW(), delete_at = $3, user_id = $1`, // Update user_id too on conflict if app existed
        [userId, appName, deleteAt]
    );
}
async function getDueTrialDeploys() {
    const res = await pool.query(
        `SELECT user_id, app_name FROM temp_deploys WHERE delete_at <= NOW()`
    );
    return res.rows;
}

async function deleteTrialDeployEntry(appName) {
    await pool.query(
        `DELETE FROM temp_deploys WHERE app_name = $1`,
        [appName]
    );
}

// New DB helpers for bot_notifications table
async function recordBotNotification(appName, userId, errorType) {
    await pool.query(
        `INSERT INTO bot_notifications (app_name, user_id, error_type, last_notified) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (app_name, error_type) DO UPDATE SET last_notified = NOW()`,
        [appName, userId, errorType]
    );
}

async function getLastNotificationTime(appName, errorType) {
    const res = await pool.query(
        'SELECT last_notified FROM bot_notifications WHERE app_name = $1 AND error_type = $2',
        [appName, errorType]
    );
    return res.rows.length > 0 ? res.rows[0].last_notified : null;
}

// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {}; // chatId -> { step, data: { appName, messageId, ... } }
const authorizedUsers = new Set(); // chatIds who've passed a key

// 7) Utilities
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

function buildKeyboard(isAdmin) {
  const baseMenu = [
      ['Get Session', 'Deploy'],
      ['Free Trial', 'My Bots'], // "Free Trial" button
      ['Support']
  ];
  if (isAdmin) {
      return [
          ['Deploy', 'Apps'],
          ['Generate Key', 'Get Session'],
          ['Support']
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
    await new Promise(r => setTimeout(r, 1200)); // Wait for animation
    return msg;
}

async function startRestartCountdown(chatId, appName, messageId) {
    const totalSeconds = 45; // 45 seconds for demonstration. Change to 45 * 60 for 45 minutes.
    const intervalTime = 5; // Update every 5 seconds
    const totalSteps = totalSeconds / intervalTime;

    // Initial message
    await bot.editMessageText(`🔄 Bot "${appName}" restarting...`, {
        chat_id: chatId,
        message_id: messageId
    }).catch(() => {});

    for (let i = 0; i <= totalSteps; i++) {
        const secondsLeft = totalSeconds - (i * intervalTime);
        const minutesLeft = Math.floor(secondsLeft / 60);
        const remainingSeconds = secondsLeft % 60;

        const filledBlocks = '█'.repeat(i);
        const emptyBlocks = '░'.repeat(totalSteps - i);

        let countdownMessage = `🔄 Bot "${appName}" restarting...\n\n`;
        if (secondsLeft > 0) {
            countdownMessage += `[${filledBlocks}${emptyBlocks}] ${minutesLeft}m ${remainingSeconds}s left`;
        } else {
            countdownMessage += `[${filledBlocks}] Restart complete!`;
        }
        
        await bot.editMessageText(countdownMessage, {
            chat_id: chatId,
            message_id: messageId
        }).catch(() => {}); // Ignore errors if message is deleted

        if (secondsLeft <= 0) break; // Exit loop when countdown is done
        await new Promise(r => setTimeout(r, intervalTime * 1000));
    }
    await bot.editMessageText(`✅ Bot "${appName}" has restarted successfully and is back online!`, {
        chat_id: chatId,
        message_id: messageId
    });
}


// 8) Send Heroku apps list
async function sendAppList(chatId, messageId = null) {
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
      r.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    const message = `Total apps: ${apps.length}\nSelect an app:`;
    if (messageId) {
        await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } });
    } else {
        await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: rows } });
    }
  } catch (e) {
    const errorMsg = `Error fetching apps: ${e.message}`;
    if (messageId) {
        bot.editMessageText(errorMsg, { chat_id: chatId, message_id: messageId });
    } else {
        bot.sendMessage(chatId, errorMsg);
    }
  }
}

// 9) Build & deploy helper with animated countdown
async function buildWithProgress(chatId, vars, isFreeTrial = false) {
  const name = vars.APP_NAME; // This is the user-provided app name
  let fullAppUrl = `https://${name}.herokuapp.com`; // Default if Heroku doesn't return full URL immediately
  let actualAppName = name; // Will be updated if Heroku assigns a hashed name

  try {
    // Stage 1: Create App
    const createMsg = await bot.sendMessage(chatId, '🚀 Creating application...');
    const createRes = await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    actualAppName = createRes.data.name;
    fullAppUrl = createRes.data.web_url;
    vars.APP_NAME = actualAppName; // Update in vars for consistency downstream

    // Stage 2: Add-ons and Buildpacks
    await bot.editMessageText('⚙️ Configuring resources...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.post(
      `https://api.heroku.com/apps/${actualAppName}/addons`,
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
      `https://api.heroku.com/apps/${actualAppName}/buildpack-installations`,
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

    // Stage 3: Config Vars
    await bot.editMessageText('🔧 Setting environment variables...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.patch(
      `https://api.heroku.com/apps/${actualAppName}/config-vars`,
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

    // Stage 4: Build
    await bot.editMessageText('🛠️ Starting build process...', { chat_id: chatId, message_id: createMsg.message_id });
    const bres = await axios.post(
      `https://api.heroku.com/apps/${actualAppName}/builds`,
      { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    const statusUrl = `https://api.heroku.com/apps/${actualAppName}/builds/${bres.data.id}`;
    let status = 'pending';
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
        status = poll.data.status;
      } catch {
        status = 'error';
        break;
      }
      const pct = Math.min(100, i * 5);
      await bot.editMessageText(`Building... ${pct}%`, {
        chat_id: chatId,
        message_id: progMsg.message_id
      }).catch(() => {});

      if (status !== 'pending') break;
    }

    if (status === 'succeeded') {
      await bot.editMessageText('Build complete!', {
        chat_id: chatId,
        message_id: progMsg.message_id
      });

      const totalSteps = 12; // 12 steps for a 60-second countdown (5 seconds per step)
      for (let i = 1; i <= totalSteps; i++) {
          await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds
          const secondsLeft = 60 - (i * 5);
          const filled = '■'.repeat(i);
          const empty = '□'.repeat(totalSteps - i);
          const countdownMessage = `[${filled}${empty}] Wait for your bot to start ... (${secondsLeft}s left)`;
          await bot.editMessageText(countdownMessage, {
              chat_id: chatId,
              message_id: progMsg.message_id
          }).catch(() => {}); // Ignore errors if user deletes message
      }
      
      // --- NEW FEATURE: Check logs after deployment for session errors ---
      let sessionErrorFound = false;
      try {
          const logSessionRes = await axios.post(`https://api.heroku.com/apps/${actualAppName}/log-sessions`,
              { tail: false, lines: 200 }, // Fetch recent logs
              { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
          );
          const logsUrl = logSessionRes.data.logplex_url;
          const logRes = await axios.get(logsUrl);
          const logs = logRes.data;

          if (logs.match(/INVALID SESSION ID/i) || logs.match(/Invalid AuthState/i)) {
              sessionErrorFound = true;
          }
      } catch (logError) {
          console.error(`Error fetching post-deploy logs for ${actualAppName}:`, logError.message);
          // Don't fail the deployment if logs can't be fetched, just proceed as if no immediate error.
      }

      if (sessionErrorFound) {
          await bot.editMessageText(
              `⚠️ Your bot "${actualAppName}" started but its *session is invalid*.\n\n` +
              `Please update your SESSION_ID by rescanning or getting a new one.`,
              {
                  chat_id: chatId,
                  message_id: progMsg.message_id,
                  parse_mode: 'Markdown',
                  reply_markup: {
                      inline_keyboard: [[
                          { text: '🔑 Change Session ID', callback_data: `setvar:SESSION_ID:${actualAppName}` },
                          { text: '📄 View Logs on Heroku', url: `https://dashboard.heroku.com/apps/${actualAppName}/logs` }
                      ]]
                  }
              }
          );
      } else {
          await bot.editMessageText(
              `✅ Your bot is now working!\nlive at:${fullAppUrl}`,
              { chat_id: chatId, message_id: progMsg.message_id }
          );
      }
      // --- END NEW FEATURE ---


      if (isFreeTrial) {
          await recordFreeTrialDeploy(chatId, actualAppName); // Use actualAppName
          // Fetch user details for admin notification
          let userDetails = `*User ID:* \`${chatId}\``;
          try {
              const userChat = await bot.getChat(chatId);
              const { first_name, last_name, username } = userChat;
              userDetails = [
                `*Name:* ${first_name || ''} ${last_name || ''}`,
                `*Username:* @${username || 'N/A'}`,
                `*Chat ID:* \`${chatId}\``
              ].join('\n');
          } catch (e) {
              console.error(`Could not fetch user details for ${chatId}:`, e.message);
          }
          
          const appDetails = `*App Name:* \`${actualAppName}\`\n*URL:* ${fullAppUrl}\n*Session ID:* \`${vars.SESSION_ID}\`\n*Type:* Free Trial (1 day)`;
  
          await bot.sendMessage(ADMIN_ID,
              `*🚨 New Free Trial App Deployed 🚨*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}\n\nThis app will be auto-deleted in 1 day.`,
              { parse_mode: 'Markdown', disable_web_page_preview: true }
          );

          // This timeout is now a fallback, the main deletion logic will be in `checkAndDeleteDueTrialApps`
          setTimeout(async () => {
              try {
                  const res = await pool.query('SELECT * FROM temp_deploys WHERE app_name = $1 AND delete_at <= NOW()', [actualAppName]);
                  if (res.rows.length > 0) {
                      await bot.sendMessage(chatId, `⏳ Your Free Trial app "${actualAppName}" is being deleted now as its 1-day runtime has ended.`);
                      await axios.delete(`https://api.heroku.com/apps/${actualAppName}`, {
                          headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                      });
                      await deleteUserBot(chatId, actualAppName);
                      await deleteTrialDeployEntry(actualAppName); // Remove from temp_deploys table
                      await bot.sendMessage(chatId, `Free Trial app "${actualAppName}" successfully deleted.`);
                  }
              } catch (e) {
                  console.error(`Failed to auto-delete free trial app ${actualAppName} via setTimeout:`, e.message);
                  await bot.sendMessage(chatId, `⚠️ Could not auto-delete the app "${actualAppName}". Please delete it manually from your Heroku dashboard.`);
              }
          }, 24 * 60 * 60 * 1000 + 5000); // 1 day + a small buffer
      }
      return true; // Indicate success
    } else {
      await bot.editMessageText(
        `Build status: ${status}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );
      return false; // Indicate failure
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    return false; // Indicate failure
  }
}

// 10) Polling error handler
bot.on('polling_error', console.error);

// --- Free Trial Auto-Deletion Scheduler ---
async function checkAndDeleteDueTrialApps() {
    console.log('Checking for due trial apps...');
    const dueApps = await pool.query(`SELECT user_id, app_name FROM temp_deploys WHERE delete_at <= NOW()`);

    for (const app of dueApps.rows) {
        const { user_id, app_name } = app;
        try {
            console.log(`Attempting to delete trial app: ${app_name} for user: ${user_id}`);
            // Attempt to delete from Heroku
            await axios.delete(`https://api.heroku.com/apps/${app_name}`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            });
            // Remove from user_bots and temp_deploys tables
            await deleteUserBot(user_id, app_name);
            await deleteTrialDeployEntry(app_name);

            // Notify user
            await bot.sendMessage(user_id, `✅ Your Free Trial app "${app_name}" has been successfully deleted as its 1-day runtime expired.`);
            // Notify admin (optional, as they get initial deployment notification)
            if (user_id !== ADMIN_ID) { // Avoid double notification if admin is the user
                await bot.sendMessage(ADMIN_ID, `🗑️ Free Trial app "${app_name}" (user: \`${user_id}\`) was auto-deleted successfully.`);
            }
            console.log(`Successfully auto-deleted ${app_name}`);
        } catch (e) {
            console.error(`Failed to auto-delete trial app ${app_name}:`, e.message);
            // Notify user if deletion failed
            await bot.sendMessage(user_id, `⚠️ Failed to auto-delete your Free Trial app "${app_name}". Please delete it manually from your Heroku dashboard if it's still active.`);
            // Notify admin about failed deletion
            await bot.sendMessage(ADMIN_ID, `❗ *Auto-deletion failed* for Free Trial app "${app_name}" (user: \`${user_id}\`). Error: ${e.message}\n\nPlease check manually.`, { parse_mode: 'Markdown' });
        }
    }
}

// Check every 5 minutes for due trial apps
setInterval(checkAndDeleteDueTrialApps, 5 * 60 * 1000); // 5 minutes

// Check for upcoming trial app deletions to notify admin
async function notifyAdminOfUpcomingTrialDeletions() {
    console.log('Checking for upcoming trial app deletions...');
    // Notify admin 1 hour before deletion
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    const oneHourAndFiveMinutesFromNow = new Date(Date.now() + (60 + 5) * 60 * 1000); // Check within a 5-minute window
    const upcomingApps = await pool.query(
        `SELECT user_id, app_name FROM temp_deploys WHERE delete_at > NOW() AND delete_at <= $1`,
        [oneHourAndFiveMinutesFromNow] // Get apps due in the next 1 hour and 5 minutes
    );

    for (const app of upcomingApps.rows) {
        const { user_id, app_name } = app;
        try {
            // Check if we've already notified for this app within a recent period
            const notificationKey = `notified_admin_upcoming_${app_name}`;
            if (userStates[notificationKey] && (Date.now() - userStates[notificationKey] < 30 * 60 * 1000)) { // Notified within last 30 mins
                continue; // Skip if recently notified
            }

            let userName = `User \`${user_id}\``;
            try {
                const userChat = await bot.getChat(user_id);
                userName = userChat.first_name || userChat.username || userName;
            } catch (e) {
                console.error(`Could not fetch user details for upcoming notification for ${user_id}:`, e.message);
            }

            await bot.sendMessage(ADMIN_ID,
                `🔔 *Free Trial App Due Soon: "${app_name}"*\n` +
                `This app, deployed by ${userName}, is due for deletion in approximately 1 hour.\n\n` +
                `*Action:*\n`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🗑️ Delete Now', callback_data: `admin_delete_trial:${app_name}:${user_id}` }]
                        ]
                    }
                }
            );
            userStates[notificationKey] = Date.now(); // Mark as notified with timestamp
            // This flag will naturally clear from memory on bot restart, but DB check is primary.
            // For long-running bots, we might want a more persistent flag or a more sophisticated notification logic.

        } catch (e) {
            console.error(`Failed to notify admin for upcoming deletion of ${app_name}:`, e.message);
        }
    }
}

// Check for upcoming deletions every 15 minutes (more appropriate for hourly notifications)
setInterval(notifyAdminOfUpcomingTrialDeletions, 15 * 60 * 1000);


// --- NEW FEATURE: Bot Status Checking and User Notification ---

// Error patterns to look for in logs and their corresponding error types
const BOT_ERROR_PATTERNS = [
    { regex: /INVALID SESSION ID/i, type: 'INVALID_SESSION' },
    { regex: /Invalid AuthState/i, type: 'INVALID_AUTHSTATE' },
    { regex: /Error: (.*)ECONNREFUSED/i, type: 'CONNECTION_REFUSED' }, // Example for connection errors
    { regex: /Error: Command failed with exit code/i, type: 'COMMAND_FAILED' }, // General command failures
    { regex: /code=H\d\d/i, type: 'HEROKU_ERROR_CODE' } // General Heroku runtime errors
];

const NOTIFICATION_COOLDOWN_HOURS = 24; // How often to notify for the same error on the same app (24 hours)

async function checkBotStatusAndNotify() {
    console.log('Checking bot statuses for errors...');
    try {
        const allUserBots = await pool.query('SELECT user_id, bot_name FROM user_bots');

        for (const botEntry of allUserBots.rows) {
            const { user_id, bot_name } = botEntry;
            try {
                // 1. Check Dyno State First (quick check for obvious issues)
                const dynoRes = await axios.get(`https://api.heroku.com/apps/${bot_name}/dynos`, {
                    headers: {
                        Authorization: `Bearer ${HEROKU_API_KEY}`,
                        Accept: 'application/vnd.heroku+json; version=3'
                    }
                });
                const webDyno = dynoRes.data.find(d => d.type === 'web');

                if (webDyno && (webDyno.state === 'crashed' || webDyno.state === 'errored')) {
                    const errorType = 'DYNO_CRASHED';
                    const lastNotified = await getLastNotificationTime(bot_name, errorType);
                    const now = new Date();

                    if (!lastNotified || (now.getTime() - lastNotified.getTime() > NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000)) {
                        await bot.sendMessage(user_id, 
                            `🚨 Your bot "${bot_name}" appears to be *crashed* or in an *errored* state on Heroku.\n\n` +
                            `Please check your bot's logs on Heroku Dashboard for more details. If it's a session issue, you might need to update your SESSION_ID.`,
                            {
                                reply_markup: {
                                    inline_keyboard: [
                                        [{ text: '🔄 Restart Bot', callback_data: `restart:${bot_name}` }],
                                        [{ text: '🔑 Set Session ID', callback_data: `setvar:SESSION_ID:${bot_name}` }], // New callback for direct session change
                                        [{ text: '📄 View Logs on Heroku', url: `https://dashboard.heroku.com/apps/${bot_name}/logs` }]
                                    ]
                                }
                            }
                        );
                        await recordBotNotification(bot_name, user_id, errorType);
                    }
                    continue; // Skip log parsing if dyno is clearly crashed
                }

                // 2. Fetch Logs for more specific errors (only if not already crashed)
                const logSessionRes = await axios.post(`https://api.heroku.com/apps/${bot_name}/log-sessions`,
                    { tail: false, lines: 200 }, // Fetch more lines for better log analysis
                    { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
                );
                const logsUrl = logSessionRes.data.logplex_url;
                const logRes = await axios.get(logsUrl);
                const logs = logRes.data;

                let notifiedForThisBot = false; // Flag to prevent multiple notifications for one bot in a single check cycle

                for (const pattern of BOT_ERROR_PATTERNS) {
                    if (logs.match(pattern.regex)) {
                        const errorType = pattern.type;
                        const lastNotified = await getLastNotificationTime(bot_name, errorType);
                        const now = new Date();

                        if (!lastNotified || (now.getTime() - lastNotified.getTime() > NOTIFICATION_COOLDOWN_HOURS * 60 * 60 * 1000)) {
                            let message = `🚨 Your bot "${bot_name}" is experiencing an issue!`;
                            let actionButtons = [ // Use an array for buttons, then chunk it
                                { text: '📄 View Logs on Heroku', url: `https://dashboard.heroku.com/apps/${bot_name}/logs` },
                                { text: '🔄 Restart Bot', callback_data: `restart:${bot_name}` } // Always give restart option
                            ];

                            if (errorType === 'INVALID_SESSION' || errorType === 'INVALID_AUTHSTATE') {
                                message = `⚠️ Your bot "${bot_name}" has an *INVALID SESSION ID* or *INVALID AUTHSTATE*.\n\n` +
                                          `This means your session has expired or is incorrect. Please update your session ID immediately!`;
                                actionButtons.unshift({ text: '🔑 Change Session ID', callback_data: `setvar:SESSION_ID:${bot_name}` }); // Prepend button for session change
                            } else if (errorType === 'CONNECTION_REFUSED') {
                                message = `🔌 Your bot "${bot_name}" is having trouble connecting to a service (Connection Refused).\n\n` +
                                          `This might be a temporary network issue or a problem with the service your bot connects to.`;
                            } else if (errorType === 'COMMAND_FAILED') {
                                message = `❌ Your bot "${bot_name}" encountered a command execution failure.\n\n` +
                                          `This indicates a problem during startup or operation. Please check logs.`;
                            } else if (errorType === 'HEROKU_ERROR_CODE') {
                                const herokuErrorCodeMatch = logs.match(/code=(H\d\d)/i);
                                const herokuErrorCode = herokuErrorCodeMatch ? herokuErrorCodeMatch[1] : 'Unknown';
                                message = `☁️ Your bot "${bot_name}" encountered a Heroku runtime error (Code: ${herokuErrorCode}).\n\n` +
                                          `This often means your bot crashed. Check logs for details.`;
                            }

                            await bot.sendMessage(user_id, message, {
                                parse_mode: 'Markdown',
                                reply_markup: {
                                    inline_keyboard: chunkArray(actionButtons, 2) // Chunk all action buttons
                                }
                            });
                            await recordBotNotification(bot_name, user_id, errorType);
                            notifiedForThisBot = true; 
                            break; // Stop checking patterns for this bot if one is found and notified
                        }
                    }
                }

            } catch (err) {
                console.error(`Error checking status for app ${bot_name}:`, err.message);
                // Log and continue, don't stop the whole check
            }
        }
    } catch (err) {
        console.error('Error fetching all user bots for status check:', err.message);
    }
}

// Schedule the bot status check to run every 30 minutes
setInterval(checkBotStatusAndNotify, 30 * 60 * 1000); // 30 minutes


// 11) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid]; // Clear previous state on /start
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}]`);
  await bot.sendMessage(cid,
    isAdmin ? 'Welcome, Admin! Here is your menu:' : 'Welcome! Please select an option:', {
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    }
  );
});

bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid]; // Clear previous state on /menu
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    delete userStates[cid]; // Clear state
    sendAppList(cid);
  }
});

// 12) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // --- Button Handlers ---
  if (text === 'Deploy') {
    // Clear existing state before starting a new flow
    delete userStates[cid]; 
    if (isAdmin) {
      userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Please enter your session ID');
    } else {
      userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Enter your Deploy key');
    }
  }

  if (text === 'Free Trial') {
    delete userStates[cid]; // Clear existing state
    const check = await canDeployFreeTrial(cid);
    if (!check.can) {
        return bot.sendMessage(cid, `⏳ You have already used your Free Trial. You can use it again after:\n\n${check.cooldown.toLocaleString()}`);
    }
    userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: true } };
    return bot.sendMessage(cid, 'Free Trial (1 day runtime, 14-day cooldown) initiated.\n\nPlease enter your session ID:');
  }

  if (text === 'Apps' && isAdmin) {
    delete userStates[cid]; // Clear existing state
    return sendAppList(cid);
  }

  if (text === 'Generate Key' && isAdmin) {
    delete userStates[cid]; // Clear existing state
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
    delete userStates[cid]; // Clear existing state
    const guideCaption =
        "To get your session ID, please follow these steps carefully:\n\n" +
        "1️⃣ *Open the Link*\n" +
        "Visit: https://levanter-delta.vercel.app/\n\n" +
        "2️⃣ *Important for iPhone Users*\n" +
        "If you are on an iPhone, please open the link using the **Google Chrome** browser for best results.\n\n" +
        "3️⃣ *Skip Advertisements*\n" +
        "The website may show ads. Please close or skip any popups or advertisements to proceed.\n\n" +
        "4️⃣ *Use a CUSTOM ID*\n" +
        "You **must** enter your own unique ID in the 'Custom Session' field. Do not use the default one. A good ID could be your name or username (e.g., `johnsmith`).\n\n" +
        "Once you have copied your session ID, tap the 'Deploy' button here to continue.";

    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: guideCaption,
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, guideCaption, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (text === 'My Bots') {
    delete userStates[cid]; // Clear existing state
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, "You haven't deployed any bots yet.");
    const rows = chunkArray(bots, 3).map(r => r.map(n => ({
      text: n,
      callback_data: `selectbot:${n}`
    })));
    return bot.sendMessage(cid, 'Your deployed bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  if (text === 'Support') {
    delete userStates[cid]; // Clear existing state
    return bot.sendMessage(cid, `For help, contact the admin: ${SUPPORT_USERNAME}`);
  }

  // --- Stateful flows ---
  const st = userStates[cid];
  if (!st) {
      return bot.sendMessage(cid, "Please use the provided buttons or type /start to begin.");
  }


  if (st.step === 'AWAITING_KEY') {
    const keyAttempt = text.toUpperCase();
    const usesLeft = await useDeployKey(keyAttempt);
    if (usesLeft === null) {
      return bot.sendMessage(cid, `❌ Invalid or expired key.\n\nPlease contact the admin for a valid key: ${SUPPORT_USERNAME}`);
    }
    authorizedUsers.add(cid);
    st.step = 'SESSION_ID'; // Keep data, just change step

    const { first_name, last_name, username } = msg.from;
    const userDetails = [
      `*Name:* ${first_name || ''} ${last_name || ''}`,
      `*Username:* @${username || 'N/A'}`,
      `*Chat ID:* \`${cid}\``
    ].join('\n');

    await bot.sendMessage(ADMIN_ID,
      `🔑 *Key Used By:*\n${userDetails}\n\n*Uses Left:* ${usesLeft}`,
      { parse_mode: 'Markdown' }
    );
    return bot.sendMessage(cid, 'Verified, please enter your session ID:');
  }

  if (st.step === 'SESSION_ID') {
    if (text.length < 10) {
      return bot.sendMessage(cid, 'Session ID must be at least 10 characters long.');
    }
    st.data.SESSION_ID = text.trim();
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, 'Great. Now enter a name for your bot (e.g., my-awesome-bot or utarbot12):');
  }

  if (st.step === 'APP_NAME') {
    const nm = text.toLowerCase().replace(/\s+/g, '-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid, 'Invalid name. Use at least 5 lowercase letters, numbers, or hyphens.');
    }
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
        const wizardMsg = await bot.sendMessage(cid, wizardText, { ...wizardKeyboard, parse_mode: 'Markdown' });
        st.data.messageId = wizardMsg.message_id; // Store message_id for this specific interaction
      } else {
        console.error(`Error checking app name "${nm}":`, e.message);
        return bot.sendMessage(cid, `Could not verify app name. The Heroku API might be down. Please try again later.`);
      }
    }
  }

  if (st.step === 'SETVAR_PROMPT') {
    const appName = st.data.appName;
    const messageIdFromState = st.data.messageId; 
    const varKey = text.trim().toUpperCase(); 
    
    const commonVars = ['SESSION_ID', 'AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'PREFIX', 'ANTI_DELETE'];
    if (!commonVars.includes(varKey) && !/^[A-Z_]+$/.test(varKey)) {
        return bot.sendMessage(cid, `Invalid variable name. Please select from the buttons or type a valid Heroku config var name (uppercase letters and underscores only).`);
    }

    if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE'].includes(varKey)) {
        st.step = 'SETVAR_ENTER_VALUE'; 
        st.data.VAR_NAME = varKey; 

        return bot.editMessageText(`Set *${varKey}* to:`, {
            chat_id: cid,
            message_id: messageIdFromState, 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
                    { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
                ],
                [{ text: '◀️ Back', callback_data: `setvar:${appName}` }]]
            }
        });
    } else {
        st.step = 'SETVAR_ENTER_VALUE';
        st.data.VAR_NAME = varKey;
        const newMessage = await bot.sendMessage(cid, `Please enter the new value for *${varKey}*:`, { parse_mode: 'Markdown' });
        st.data.messageId = newMessage.message_id; 
        
        if (messageIdFromState) {
            await bot.editMessageReplyMarkup(undefined, {
                chat_id: cid,
                message_id: messageIdFromState
            }).catch(() => {}); 
        }
    }
    return;
  }

  if (st.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME, messageId } = st.data; 
    const newVal = text.trim();
    if (!APP_NAME || !VAR_NAME || !messageId) {
        delete userStates[cid];
        return bot.sendMessage(cid, "It looks like the previous operation was interrupted. Please select an app again from 'My Bots' or 'Apps'.");
    }

    try {
      const updateMsg = await bot.editMessageText(`Updating ${VAR_NAME} for "${APP_NAME}"...`, { chat_id: cid, message_id: messageId })
          .catch(async () => {
              return await bot.sendMessage(cid, `Updating ${VAR_NAME} for "${APP_NAME}"...`);
          });

      await axios.patch(
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
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(cid, APP_NAME, newVal);
      }
      delete userStates[cid];
      await startRestartCountdown(cid, APP_NAME, updateMsg.message_id);
    } catch (e) {
      console.error("Error updating variable:", e.response?.data?.message || e.message);
      const errorMessage = `Error updating variable: ${e.response?.data?.message || e.message}\n\nPlease try again or contact support.`;
      if (messageId) {
          await bot.editMessageText(errorMessage, { chat_id: cid, message_id: messageId }).catch(() => bot.sendMessage(cid, errorMessage));
      } else {
          await bot.sendMessage(cid, errorMessage);
      }
      delete userStates[cid]; 
    }
  }
});

// 13) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id).catch(() => {});

  // --- INTERACTIVE WIZARD HANDLER ---
  if (action === 'setup') {
      const st = userStates[cid];
      if (!st || st.data.messageId !== q.message.message_id || st.step !== 'AWAITING_WIZARD_CHOICE') { 
          await bot.sendMessage(cid, 'This menu has expired or is invalid. Please start over by tapping /menu.');
          delete userStates[cid];
          return;
      }

      const [step, value] = [payload, extra];

      if (step === 'autostatus') {
          st.data.AUTO_STATUS_VIEW = value === 'true' ? 'no-dl' : 'false';
          const confirmationText = ` *Deployment Configuration*\n\n` +
                                   `*App Name:* \`${st.data.APP_NAME}\`\n` +
                                   `*Session ID:* \`${st.data.SESSION_ID.slice(0, 15)}...\`\n` +
                                   `*Auto Status:* \`${st.data.AUTO_STATUS_VIEW}\`\n\n` +
                                   `Ready to proceed?`;
          
          const confirmationKeyboard = {
              reply_markup: {
                  inline_keyboard: [
                      [{ text: 'Yes, Deploy Now', callback_data: 'setup:startbuild' }],
                      [{ text: 'Cancel', callback_data: 'setup:cancel' }]
                  ]
              }
          };

          await bot.editMessageText(confirmationText, {
              chat_id: cid,
              message_id: st.data.messageId, 
              parse_mode: 'Markdown',
              ...confirmationKeyboard
          });
      }

      if (step === 'startbuild') {
          await bot.editMessageText('Configuration confirmed. Initiating deployment...', {
              chat_id: cid,
              message_id: st.data.messageId
          });

          const buildSuccessful = await buildWithProgress(cid, st.data, st.data.isFreeTrial);

          if (buildSuccessful) {
              await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID); 

              if (st.data.isFreeTrial) {
                  // This part of free trial logic will be fixed in a separate, more comprehensive review.
                  // For now, it will use the appName from st.data which is updated in buildWithProgress.
              }

              const { first_name, last_name, username } = q.from;
              let actualAppUrl = `https://${st.data.APP_NAME}.herokuapp.com`; // Fallback
              try {
                  const appRes = await axios.get(`https://api.heroku.com/apps/${st.data.APP_NAME}`, {
                      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                  });
                  actualAppUrl = appRes.data.web_url;
              } catch (urlError) {
                  console.error(`Could not fetch actual app URL for ${st.data.APP_NAME}:`, urlError.message);
              }

              const userDetails = [
                `*Name:* ${first_name || ''} ${last_name || ''}`,
                `*Username:* @${username || 'N/A'}`,
                `*Chat ID:* \`${cid}\``
              ].join('\n');
      
              const appDetails = `*App Name:* \`${st.data.APP_NAME}\`\n*URL:* ${actualAppUrl}\n*Session ID:* \`${st.data.SESSION_ID}\`\n*Type:* ${st.data.isFreeTrial ? 'Free Trial' : 'Permanent'}`;
      
              await bot.sendMessage(ADMIN_ID,
                  `*New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
                  { parse_mode: 'Markdown', disable_web_page_preview: true }
              );
          }
          delete userStates[cid];
      }

      if (step === 'cancel') {
          await bot.editMessageText('❌ Deployment cancelled.', {
              chat_id: cid,
              message_id: st.data.messageId
          });
          delete userStates[cid];
      }
      return;
  }


  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    await bot.editMessageText(`Generated key: \`${key}\`\nUses: ${uses}`, { 
        chat_id: cid, 
        message_id: q.message.message_id, 
        parse_mode: 'Markdown' 
    });
    return;
  }

  // --- Select App / Bot Logic ---
  if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    const messageId = q.message.message_id; 
    userStates[cid] = { 
        step: 'APP_MANAGEMENT', 
        data: { 
            appName: payload, 
            messageId: messageId, 
            isUserBot: isUserBot 
        } 
    };
    
    return bot.editMessageText(`Manage app "${payload}":`, {
      chat_id: cid,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Info', callback_data: `info:${payload}` },
            { text: 'Restart', callback_data: `restart:${payload}` },
            { text: 'Logs', callback_data: `logs:${payload}` }
          ],
          [
            { text: 'Delete', callback_data: `${isUserBot ? 'userdelete' : 'delete'}:${payload}` },
            { text: 'Set Variable', callback_data: `setvar:${payload}` }
          ],
          [{ text: '◀️ Back', callback_data: 'back_to_app_list' }]
        ]
      }
    });
  }

  // --- Common state validation for app-specific actions triggered by a button ---
  const st = userStates[cid];
  if (!st || st.data.appName !== payload || st.data.messageId !== q.message.message_id) {
      delete userStates[cid]; 
      await bot.editMessageText("This operation has expired or is invalid. Please select an app again from 'My Bots' or 'Apps'.", {
          chat_id: cid,
          message_id: q.message.message_id 
      });
      return; 
  }
  const messageId = st.data.messageId; 


  if (action === 'info') {
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

      const createdAt = new Date(appData.created_at);
      const now = new Date();
      const diffTime = Math.abs(now - createdAt);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      let dynoStatus = 'No dynos found.';
      let statusEmoji = '❓';
      if (dynoData.length > 0) {
          const webDyno = dynoData.find(d => d.type === 'web');
          if (webDyno) {
              const state = webDyno.state;
              if (state === 'up') statusEmoji = '🟢';
              else if (state === 'crashed') statusEmoji = '🔴';
              else if (state === 'idle') statusEmoji = '🟡';
              else if (state === 'starting' || state === 'restarting') statusEmoji = '⏳';
              else statusEmoji = '❓';
              dynoStatus = `${statusEmoji} ${state.charAt(0).toUpperCase() + state.slice(1)}`;
          }
      }

      const info = `*App Info: ${appData.name}*\n\n` +
                   `*Dyno Status:* ${dynoStatus}\n` +
                   `*URL:* [${appData.web_url}](${appData.web_url})\n` + // Use appData.web_url here
                   `*Created:* ${createdAt.toLocaleDateString()} (${diffDays} days ago)\n` +
                   `*Last Release:* ${new Date(appData.released_at).toLocaleString()}\n` +
                   `*Stack:* ${appData.stack.name}\n\n` +
                   `*Key Config Vars:*\n` +
                   `  \`SESSION_ID\`: ${configData.SESSION_ID ? '✅ Set' : '❌ Not Set'}\n` +
                   `  \`AUTO_STATUS_VIEW\`: \`${configData.AUTO_STATUS_VIEW || 'false'}\`\n` +
                   `  \`ALWAYS_ONLINE\`: \`${configData.ALWAYS_ONLINE || 'Not Set'}\`\n` +
                   `  \`PREFIX\`: \`${configData.PREFIX || 'Not Set'}\`\n` +
                   `  \`ANTI_DELETE\`: \`${configData.ANTI_DELETE || 'Not Set'}\`\n`;

      return bot.editMessageText(info, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching info: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'restart') {
    await bot.editMessageText('Restarting app...', { chat_id: cid, message_id: messageId });
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });
      return bot.editMessageText(`"${payload}" restarted successfully.`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      return bot.editMessageText(`Error restarting: ${e.message}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'logs') {
    await bot.editMessageText('📄 Fetching logs...', { chat_id: cid, message_id: messageId });
    try {
      const sess = await axios.post(`https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: false, lines: 100 },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      const logRes = await axios.get(sess.data.logplex_url);
      const logs = logRes.data.trim().slice(-4000);
      
      return bot.editMessageText(`Logs for "${payload}":\n\`\`\`\n${logs || 'No recent logs.'}\n\`\`\``, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      return bot.editMessageText(`Error fetching logs: ${e.message}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    }
  }

  if (action === 'delete' || action === 'userdelete') {
      return bot.editMessageText(`Are you sure you want to delete the app "${payload}"? This action cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
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
      
      await bot.editMessageText(`🗑️ Deleting ${appToDelete}...`, { chat_id: cid, message_id: messageId });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          await deleteUserBot(cid, appToDelete); // Delete from user_bots
          // This line is the one causing 'column app_name does not exist' if schema is not fixed
          await deleteTrialDeployEntry(appToDelete); // Delete from temp_deploys

          await bot.editMessageText(`✅ App "${appToDelete}" has been permanently deleted.`, { chat_id: cid, message_id: messageId });
          
          if (originalAction === 'userdelete' && cid !== ADMIN_ID) {
              const bots = await getUserBots(cid);
              if (bots.length > 0) {
                  const rows = chunkArray(bots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
                  return bot.editMessageText('Your remaining deployed bots:', {
                      chat_id: cid,
                      message_id: messageId,
                      reply_markup: { inline_keyboard: rows }
                  });
              } else {
                  return bot.editMessageText("You no longer have any deployed bots.", {
                      chat_id: cid,
                      message_id: messageId
                  });
              }
          } else {
            return sendAppList(cid, messageId);
          }

      } catch (e) {
          console.error(`Error deleting app ${appToDelete}:`, e.message); // Log the actual error
          return bot.editMessageText(`Error deleting app: ${e.message}\n\nIf the app no longer exists on Heroku, you might need to manually remove it from your bot's list using the /mybots feature (if it appears there).`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${appToDelete}` }]]
            }
          });
      } finally {
          delete userStates[cid]; 
      }
  }

  if (action === 'setvar') {
    const appName = payload;
    
    userStates[cid].step = 'SETVAR_PROMPT'; 
    userStates[cid].data = { 
        appName: appName, 
        messageId: messageId 
    };
    
    try {
        const res = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const configVars = res.data;

        let varList = `*Current Config Vars for ${appName}:*\n\n`;
        const varButtons = [];

        const commonVars = ['SESSION_ID', 'AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'PREFIX', 'ANTI_DELETE'];

        for (const key of commonVars) {
            const value = configVars[key] !== undefined ? configVars[key] : 'Not Set';
            varList += `\`${key}\`: \`${value}\`\n`;
            varButtons.push({ text: key, callback_data: `varselect:${key}:${appName}` });
        }
        varList += `\nSelect a variable to change or type its name:`;

        const inlineKeyboardRows = chunkArray(varButtons, 2);
        inlineKeyboardRows.push([{ text: '◀️ Back to App Management', callback_data: `selectapp:${appName}` }]);

        await bot.editMessageText(varList, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: inlineKeyboardRows
            }
        });

    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        return bot.editMessageText(`Error fetching config vars: ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: '◀️ Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    }
    return;
  }
  
  if (action === 'varselect') {
    const [varKey, appName] = [payload, extra];
    
    if (!st || st.data.appName !== appName || st.step !== 'SETVAR_PROMPT' || st.data.messageId !== q.message.message_id) {
        delete userStates[cid];
        await bot.editMessageText("This variable selection has expired. Please select an app again from 'My Bots' or 'Apps'.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }

    st.step = 'SETVAR_ENTER_VALUE';
    st.data.VAR_NAME = varKey; 

    if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE'].includes(varKey)) {
      return bot.editMessageText(`Set *${varKey}* to:`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ],
          [{ text: '◀️ Back', callback_data: `setvar:${appName}` }]]
        }
      });
    } else {
      const newMessage = await bot.sendMessage(cid, `Please enter the new value for *${varKey}*:`, { parse_mode: 'Markdown' });
      st.data.messageId = newMessage.message_id; 
      
      await bot.editMessageReplyMarkup(undefined, {
          chat_id: cid,
          message_id: messageId 
      }).catch(() => {}); 
    }
    return;
  }

  if (action === 'setvarbool') {
    const [varKey, appName, valStr] = [payload, extra, flag];
    
    if (!st || st.data.appName !== appName || st.data.VAR_NAME !== varKey || st.step !== 'SETVAR_ENTER_VALUE' || st.data.messageId !== q.message.message_id) {
        delete userStates[cid];
        await bot.sendMessage(cid, "This operation has expired or is invalid. Please select an app again from 'My Bots' or 'Apps'.");
        return;
    }

    const flagVal = valStr === 'true';
    let newVal;
    if (varKey === 'AUTO_STATUS_VIEW') newVal = flagVal ? 'no-dl' : 'false';
    else if (varKey === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
    else newVal = flagVal ? 'true' : 'false';

    try {
      const updateMsg = await bot.editMessageText(`Updating ${varKey} for "${appName}" to \`${newVal}\`...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      await startRestartCountdown(cid, appName, updateMsg.message_id);
      delete userStates[cid]; 
    } catch (e) {
      console.error("Error setting boolean variable:", e.response?.data?.message || e.message);
      const errorMessage = `Error updating variable: ${e.response?.data?.message || e.message}`;
      await bot.editMessageText(errorMessage, {
          chat_id: cid,
          message_id: messageId,
          reply_markup: {
              inline_keyboard: [[{ text: '◀️ Back', callback_data: `setvar:${appName}` }]]
          }
      }).catch(() => bot.sendMessage(cid, errorMessage)); 
      delete userStates[cid]; 
    }
    return;
  }

  if (action === 'back_to_app_list') {
    const isAdmin = cid === ADMIN_ID;
    const currentMessageId = q.message.message_id; 
    delete userStates[cid]; 

    if (isAdmin) {
      return sendAppList(cid, currentMessageId);
    } else {
      const bots = await getUserBots(cid);
      if (!bots.length) {
        return bot.editMessageText("You haven't deployed any bots yet.", { chat_id: cid, message_id: currentMessageId });
      }
      const rows = chunkArray(bots, 3).map(r => r.map(n => ({
        text: n,
        callback_data: `selectbot:${n}`
      })));
      return bot.editMessageText('Your deployed bots:', {
        chat_id: cid,
        message_id: currentMessageId,
        reply_markup: { inline_keyboard: rows }
      });
    }
  }
});

console.log('Bot is running...');
