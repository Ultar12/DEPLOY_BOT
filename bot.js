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
  // FIX: Corrected file path from 'app' back to 'app.json'
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

    console.log("[DB] All necessary tables checked/created successfully.");

  } catch (dbError) {
    // This catch block handles errors during the *initial* CREATE TABLE IF NOT EXISTS.
    // The most common is if a table already exists but the constraint part (like PK) failed to add.
    
    // Check for specific error code for "duplicate_table" which implies the table itself exists
    if (dbError.code === '42P07' || (dbError.message && dbError.message.includes('already exists'))) {
        console.warn(`[DB] 'user_bots' table already exists. Attempting to ensure PRIMARY KEY constraint.`);
        try {
            // Attempt to add the primary key if it's missing.
            // Using IF NOT EXISTS on the constraint name prevents error if constraint is already there.
            await pool.query(`
                ALTER TABLE user_bots
                ADD CONSTRAINT user_bots_pkey PRIMARY KEY (user_id, bot_name);
            `);
            console.log("[DB] PRIMARY KEY constraint successfully added to 'user_bots'.");
        } catch (alterError) {
            // If ALTER TABLE fails because the constraint already exists, that's fine.
            // PostgreSQL's error messages for "constraint already exists" can vary.
            if ((alterError.message && alterError.message.includes('already exists in relation "user_bots"')) || (alterError.message && alterError.message.includes('already exists'))) {
                 console.warn("[DB] PRIMARY KEY constraint 'user_bots_pkey' already exists on 'user_bots'. Skipping ALTER TABLE.");
            } else {
                 // Any other error during ALTER TABLE is critical.
                 console.error("[DB] CRITICAL ERROR adding PRIMARY KEY constraint to 'user_bots':", alterError.message, alterError.stack);
                 process.exit(1); 
            }
        }
    } else {
        // Any other error during initial table creation is considered critical.
        console.error("[DB] CRITICAL ERROR during initial database table creation/check:", dbError.message, dbError.stack);
        process.exit(1); 
    }
  }
})();

// 5) DB helper functions
async function addUserBot(u, b, s) {
  try {
    // Use ON CONFLICT to update if it already exists, or insert if new
    const result = await pool.query(
      `INSERT INTO user_bots(user_id, bot_name, session_id)
       VALUES($1, $2, $3)
       ON CONFLICT (user_id, bot_name) DO UPDATE SET session_id = EXCLUDED.session_id, created_at = CURRENT_TIMESTAMP
       RETURNING *;`, // Return the row to confirm insertion/update
      [u, b, s]
    );
    if (result.rows.length > 0) {
      console.log(`[DB] addUserBot: Successfully added/updated bot "${b}" for user "${u}". Row:`, result.rows[0]);
    } else {
      console.warn(`[DB] addUserBot: Insert/update operation for bot "${b}" for user "${u}" did not return a row. This might indicate an issue.`);
    }
  } catch (error) {
    console.error(`[DB] addUserBot: CRITICAL ERROR Failed to add/update bot "${b}" for user "${u}":`, error.message, error.stack);
    // You might want to notify admin here if this is a persistent issue
    bot.sendMessage(ADMIN_ID, `⚠️ CRITICAL DB ERROR: Failed to add/update bot "${b}" for user "${u}". Check logs.`);
  }
}
async function getUserBots(u) {
  try {
    const r = await pool.query(
      'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
      [u]
    );
    console.log(`[DB] getUserBots: Fetching for user_id "${u}" - Found:`, r.rows.map(x => x.bot_name)); // Debugging log
    return r.rows.map(x => x.bot_name);
  } catch (error) {
    console.error(`[DB] getUserBots: Failed to get bots for user "${u}":`, error.message);
    return [];
  }
}
// Function to get user_id by bot_name
async function getUserIdByBotName(botName) {
    try {
        const r = await pool.query(
            'SELECT user_id FROM user_bots WHERE bot_name=$1',
            [botName]
        );
        const userId = r.rows.length > 0 ? r.rows[0].user_id : null;
        console.log(`[DB] getUserIdByBotName: For bot "${botName}", found user_id: "${userId}".`);
        return userId;
    } catch (error) {
        console.error(`[DB] getUserIdByBotName: Failed to get user ID by bot name "${botName}":`, error.message);
        return null;
    }
}
// Function to get all bots from the database
async function getAllUserBots() {
    try {
        const r = await pool.query('SELECT user_id, bot_name FROM user_bots');
        console.log(`[DB] getAllUserBots: Fetched all bots:`, r.rows.map(x => `"${x.user_id}" - "${x.bot_name}"`));
        return r.rows;
    } catch (error) {
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
  // This function is effectively replaced by the ON CONFLICT in addUserBot,
  // but keeping it for explicit update calls if desired elsewhere.
  // For now, it will simply perform an UPDATE.
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


// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {}; // chatId -> { step, data, message_id }
const authorizedUsers = new Set(); // chatIds who've passed a key

// Map to store Promises for app deployment status based on channel notifications
const appDeploymentPromises = new Map(); // appName -> { resolve, reject, animateIntervalId }

// 7) Utilities

// Animated emoji for loading states (five square boxes)
let emojiIndex = 0;
const animatedEmojis = ['⬜⬜⬜⬜⬜', '⬛⬜⬜⬜⬜', '⬜⬛⬜⬜⬜', '⬜⬜⬛⬜⬜', '⬜⬜⬜⬛⬜', '⬜⬜⬜⬜⬛', '⬜⬜⬜⬜⬜']; // Cycles through black square moving across white squares

function getAnimatedEmoji() {
    const emoji = animatedEmojis[emojiIndex];
    emojiIndex = (emojiIndex + 1) % animatedEmojis.length;
    return emoji;
}

// Function to animate a message
async function animateMessage(chatId, messageId, baseText) {
    const intervalId = setInterval(async () => {
        try {
            await bot.editMessageText(`${getAnimatedEmoji()} ${baseText}`, {
                chat_id: chatId,
                message_id: messageId
            }).catch(() => {}); // Catch potential errors if message is deleted
        } catch (e) {
            console.error(`Error animating message ${messageId}:`, e.message);
            clearInterval(intervalId); // Stop animation on error
        }
    }, 800); // Update every 800ms for smooth animation
    return intervalId;
}


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
    const totalSeconds = 60; // 45 seconds for demonstration. Change to 45 * 60 for 45 minutes.
    const intervalTime = 5; // Update every 5 seconds
    const totalSteps = totalSeconds / intervalTime;

    // Initial message
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
        }).catch(() => {}); // Ignore errors if message is deleted

        if (secondsLeft <= 0) break; // Exit loop when countdown is done
        await new Promise(r => setTimeout(r, intervalTime * 1000));
    }
    await bot.editMessageText(`Bot "${appName}" has restarted successfully and is back online!`, {
        chat_id: chatId,
        message_id: messageId
    });
}


// 8) Send Heroku apps list
async function sendAppList(chatId, messageId = null, callbackPrefix = 'selectapp', targetUserIdForUpdate = null) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) {
      if (messageId) return bot.editMessageText(chatId, 'No apps found.', { chat_id: chatId, message_id: messageId });
      return bot.sendMessage(chatId, 'No apps found.');
    }

    // Adapt callback data based on whether it's for general selection or for /update command
    const rows = chunkArray(apps, 3).map(r =>
      r.map(name => ({ 
        text: name, 
        callback_data: targetUserIdForUpdate 
            ? `${callbackPrefix}:${name}:${targetUserIdForUpdate}` 
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

  let buildResult = false; // Flag to track overall success
  const createMsg = await bot.sendMessage(chatId, '🚀 Creating application...');

  try {
    // Stage 1: Create App
    await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    // Stage 2: Add-ons and Buildpacks
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

    // Stage 3: Config Vars
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

    // Stage 4: Build
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
      // --- CRITICAL MODIFICATION: Add bot to DB immediately after successful build ---
      console.log(`[Flow] buildWithProgress: Heroku build for "${name}" SUCCEEDED. Attempting to add bot to user_bots DB.`);
      await addUserBot(chatId, name, vars.SESSION_ID); // Add bot to DB immediately here!

      // Admin notification for successful build (even if bot isn't 'connected' yet)
      const { first_name, last_name, username } = (await bot.getChat(chatId)).from || {};
      const userDetails = [
        `*Name:* ${first_name || ''} ${last_name || ''}`,
        `*Username:* @${username || 'N/A'}`,
        `*Chat ID:* \`${chatId}\``
      ].join('\n');
      const appDetails = `*App Name:* \`${name}\`\n*Session ID:* \`${vars.SESSION_ID}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;

      await bot.sendMessage(ADMIN_ID,
          `*New App Deployed (Heroku Build Succeeded)*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
      // --- END OF CRITICAL MODIFICATION ---

      const baseWaitingText = `Build complete! Waiting for bot to connect...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { // Initial message with emoji
        chat_id: chatId,
        message_id: progMsg.message_id
      });

      // Start animation for waiting state
      const animateIntervalId = await animateMessage(chatId, progMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(name, { resolve, reject, animateIntervalId }); // Store intervalId
      });

      const STATUS_CHECK_TIMEOUT = 120 * 1000; // 120 seconds (2 minutes) to wait for connection
      let timeoutId;

      try {
          // Set a timeout to reject the promise if no status update is received
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(name);
              if (appPromise) { // Only reject if still pending
                  appPromise.reject(new Error('Bot did not report connected or logged out status within 2 minutes.'));
                  appDeploymentPromises.delete(name); // Clean up
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise; // Wait for the channel_post handler to resolve/reject this
