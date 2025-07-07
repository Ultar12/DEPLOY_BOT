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
        console.warn(`[DB] 'user_bots' table already exists, or there was an issue creating it initially. Attempting to ensure PRIMARY KEY constraint.`);
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
    // With PRIMARY KEY (user_id, bot_name), this will update if the specific user-bot pair exists.
    // For transferring ownership, we will handle deletion of old entry in the calling function.
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
  }
  catch (error) {
    console.error(`[DB] getUserBots: Failed to get bots for user "${u}":`, error.message);
    return [];
  }
}
// Function to get user_id by bot_name
async function getUserIdByBotName(botName) {
    try {
        // FIX: Added ORDER BY created_at DESC LIMIT 1 to ensure the LATEST owner is retrieved
        // if multiple entries for the same bot_name (but different user_ids) exist due to past issues.
        // Once the /add fix is in place, only one entry per bot_name should exist.
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
// Function to get all bots from the database
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

// NEW HELPER FUNCTION: Handles 404 Not Found from Heroku API
async function handleAppNotFoundAndCleanDb(callingChatId, appName, originalMessageId = null, isUserFacing = false) {
    console.log(`[AppNotFoundHandler] Handling 404 for app "${appName}". Initiated by ${callingChatId}.`);
    
    // Find the user_id currently associated with this app in our DB.
    // This is crucial because an admin might be managing another user's bot.
    let ownerUserId = await getUserIdByBotName(appName);
    
    if (!ownerUserId) {
        // If owner not found in DB, it might be an admin trying to manage an untracked app, or a very stale entry.
        ownerUserId = callingChatId; // Fallback to the current chat ID for notification.
        console.warn(`[AppNotFoundHandler] Owner not found in DB for "${appName}". Falling back to callingChatId: ${callingChatId} for notification.`);
    } else {
        console.log(`[AppNotFoundHandler] Found owner ${ownerUserId} in DB for app "${appName}".`);
    }

    // Delete the app from our internal user_bots database
    // Note: We are deleting a specific (user_id, bot_name) pair.
    // If a bot was moved with /add, it should have been deleted from old user's list.
    // If it's a 404, it's missing on Heroku, so we remove from DB.
    await deleteUserBot(ownerUserId, appName); // This deletes the (ownerUserId, appName) pair
    console.log(`[AppNotFoundHandler] Removed "${appName}" from user_bots DB for user "${ownerUserId}".`);

    const message = `🗑️ App "*${appName}*" was not found on Heroku. It has been automatically removed from your "My Bots" list.`;
    
    // Determine where to send the primary notification
    // Check if q (callback_query object) exists and if q.message.chat.id is available
    // FIX: This section assumes `q` is in scope, which it isn't here in a global helper.
    // We should rely purely on passed arguments.
    // The previous original `q.message.chat.id` check was incorrect here.
    const messageTargetChatId = originalMessageId ? callingChatId : ownerUserId; // Send to calling user if message ID provided, else to the owner.
    const messageToEditId = originalMessageId;

    if (messageToEditId) { 
        await bot.editMessageText(message, {
            chat_id: messageTargetChatId,
            message_id: messageToEditId,
            parse_mode: 'Markdown'
        }).catch(err => console.error(`Failed to edit message in handleAppNotFoundAndCleanDb: ${err.message}`));
    } else {
        // If original message is not editable or not provided, send a new message
        await bot.sendMessage(messageTargetChatId, message, { parse_mode: 'Markdown' })
            .catch(err => console.error(`Failed to send message in handleAppNotFoundAndCleanDb (new msg): ${err.message}`));
    }

    // If the original action was user-facing (e.g., a regular user tried to restart THEIR bot)
    // AND the detected owner is different from the person currently interacting (meaning an admin
    // managed another user's bot), notify the original owner.
    if (isUserFacing && ownerUserId !== callingChatId) {
         await bot.sendMessage(ownerUserId, `ℹ️ Your bot "*${appName}*" was not found on Heroku and has been removed from your "My Bots" list by the admin.`, { parse_mode: 'Markdown' })
             .catch(err => console.error(`Failed to send notification to original owner in handleAppNotFoundAndCleanDb: ${err.message}`));
    }
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
      if (messageId) return bot.editMessageText(chatId, 'No apps found.', { chat_id: chatId, message_id: messageId });
      return bot.sendMessage(chatId, 'No apps found.');
    }

    // Adapt callback data based on whether it's for general selection, /add, or /remove
    const rows = chunkArray(apps, 3).map(r =>
      r.map(name => ({ 
        text: name, 
        callback_data: isRemoval
            ? `${callbackPrefix}:${name}:${targetUserId}` // remove_app_from_user:appName:targetUserId
            : targetUserId 
                ? `${callbackPrefix}:${name}:${targetUserId}` // add_assign_app:appName:targetUserId
                : `${callbackPrefix}:${name}` // selectapp:appName (general info/management)
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
        `*Username:* ${username ? `@${username}` : (first_name || last_name ? `${[first_name, last_name].filter(Boolean).join(' ')} (No @username)` : 'N/A')}`, // FIX: Improved username display
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
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after deployment.`));
                  appDeploymentPromises.delete(name); // Clean up
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise; // Wait for the channel_post handler to resolve/reject this
          clearTimeout(timeoutId); // Clear the timeout if resolved/rejected
          clearInterval(animateIntervalId); // Stop animation on success/failure

          // If resolved, it means "connected" was received
          await bot.editMessageText(
            `🎉 Your bot is now live!`, // Removed URL here
            { chat_id: chatId, message_id: progMsg.message_id }
          );
          buildResult = true; // Overall success (including session connection)

          if (isFreeTrial) {
            // FIX: Schedule 5-minute warning notification for admin
            setTimeout(async () => {
                const adminWarningMessage = `🔔 Free Trial App "${name}" has 5 minutes left until deletion!`;
                const keyboard = {
                    inline_keyboard: [
                        [{ text: `Delete "${name}" Now`, callback_data: `admin_delete_trial_app:${name}` }]
                    ]
                };
                await bot.sendMessage(ADMIN_ID, adminWarningMessage, { reply_markup: keyboard, parse_mode: 'Markdown' });
                console.log(`[FreeTrial] Sent 5-min warning to admin for ${name}.`);
            }, 55 * 60 * 1000); // 55 minutes

            // FIX: Schedule deletion after 1 hour (formerly 30 minutes)
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
                    // Also notify admin if auto-delete fails
                    bot.sendMessage(ADMIN_ID, `⚠️ Failed to auto-delete free trial app "${name}" for user ${chatId}: ${e.message}`);
                }
            }, 60 * 60 * 1000); // 1 hour
          }

      } catch (err) {
          clearTimeout(timeoutId); // Ensure timeout is cleared on early exit
          clearInterval(animateIntervalId); // Stop animation
          console.error(`App status check failed for ${name}:`, err.message);
          // This catch block handles both direct rejections from channel_post and the timeout
          await bot.editMessageText(
            `⚠️ Bot "${name}" failed to start or session is invalid after deployment: ${err.message}\n\n` +
            `It has been added to your "My Bots" list, but you may need to learn how to update the session ID.`, // Updated message for clarity
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
          buildResult = false; // Overall failure to connect
      } finally {
          appDeploymentPromises.delete(name); // Always clean up the promise from the map
      }

    } else { // Heroku build failed
      await bot.editMessageText(
        `Build status: ${buildStatus}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );
      buildResult = false; // Overall failure
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    buildResult = false; // Overall failure
  }
  return buildResult; // Indicate overall deployment success (including app startup)
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
    // FIX: Send image with professional caption and keyboard for regular users
    const welcomeImageUrl = 'https://files.catbox.moe/syx8uk.jpeg';
    // FIX: Updated welcomeCaption with exact words provided by user
    const welcomeCaption = `
👋 Welcome to our Bot Deployment Service!

To get started, please follow these simple steps:

1️⃣  Connect Your WhatsApp:
    Tap the 'Get Session' button to retrieve the necessary session details to link your WhatsApp account.

2️⃣  Deploy Your Bot:
    Once you have your session, use the 'Deploy' button to effortlessly launch your personalized bot.

We're here to assist you every step of the way!
`;
    await bot.sendPhoto(cid, welcomeImageUrl, {
      caption: welcomeCaption,
      parse_mode: 'Markdown',
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true } // buildKeyboard(isAdmin) correctly returns user keyboard
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
  }
});

// New /id command
bot.onText(/^\/id$/, async msg => {
    const cid = msg.chat.id.toString();
    await bot.sendMessage(cid, `Your Telegram Chat ID is: \`${cid}\``, { parse_mode: 'Markdown' });
});

// New /add <user_id> command for admin (formerly /update)
bot.onText(/^\/add (\d+)$/, async (msg, match) => { // Renamed from /update to /add
    const cid = msg.chat.id.toString();
    const targetUserId = match[1]; // The user ID provided after /add

    console.log(`[Admin] /add command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /add attempt by ${cid}.`);
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    // Clear any existing state for this admin before starting new flow
    delete userStates[cid];
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);


    console.log(`[Admin] Admin ${cid} initiated /add for user ${targetUserId}. Prompting for app selection.`);
    
    try {
        const sentMsg = await bot.sendMessage(cid, `Please select the app to assign to user \`${targetUserId}\`:`, { parse_mode: 'Markdown' }); // Added parse_mode
        userStates[cid] = {
            step: 'AWAITING_APP_FOR_ADD', // New state for 'add' flow (formerly AWAITING_APP_FOR_UPDATE)
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid}:`, userStates[cid]);
        // Now send the app list, editing the message created above
        // Use the sendAppList which takes chatId, messageId to edit, callbackPrefix, and targetUserId
        sendAppList(cid, sentMsg.message_id, 'add_assign_app', targetUserId); // Renamed callback prefix
    } catch (error) {
        console.error("Error sending initial /add message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the add process. Please try again.");
    }
});

// New /remove <user_id> command for admin
bot.onText(/^\/remove (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const targetUserId = match[1]; // The user ID provided after /remove

    console.log(`[Admin] /remove command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /remove attempt by ${cid}.`);
        return bot.sendMessage(cid, "❌ You are not authorized to use this command.");
    }

    // Clear any existing state for this admin before starting new flow
    delete userStates[cid];
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    // Fetch bots specifically for the targetUserId
    const userBots = await getUserBots(targetUserId);
    if (!userBots.length) {
        return bot.sendMessage(cid, `User \`${targetUserId}\` has no bots deployed via this system.`, { parse_mode: 'Markdown' });
    }

    console.log(`[Admin] Admin ${cid} initiated /remove for user ${targetUserId}. Prompting for app removal selection.`);
    
    try {
        const sentMsg = await bot.sendMessage(cid, `Select app to remove from user \`${targetUserId}\`'s dashboard:`, { parse_mode: 'Markdown' });
        
        userStates[cid] = {
            step: 'AWAITING_APP_FOR_REMOVAL', // New state for removal flow
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid} for removal:`, userStates[cid]);

        const rows = chunkArray(userBots, 3).map(r => r.map(name => ({
            text: name,
            callback_data: `remove_app_from_user:${name}:${targetUserId}` // Callback for removal
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


// 12) Message handler for buttons & state machine
// This handler is for plain text messages, not callback queries (button clicks).
// The logic for handling the /add command's app selection (button click) is in bot.on('callback_query').
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // --- Button Handlers (for keyboard buttons, not inline) ---
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
    return bot.sendMessage(cid, 'Free Trial (30 mins runtime, 14-day cooldown) initiated.\n\nPlease enter your session ID:');
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
    // FIX: Updated guideCaption with exact words provided by user
    const guideCaption = 
       "To get your session ID, please follow these steps carefully:\n\n" +
        "1️⃣ *Open the Link:*\n" + // Changed title of point 1 for consistency
        "Visit: <https://levanter-delta.vercel.app/>\n" + // FIX: Made link clickable using angle brackets
        "Use the 'Custom Session ID' button if you prefer.\n\n" + // FIX: Added Custom Session ID detail to point 1
        "2️⃣ *Important for iPhone Users:*\n" +
        "If you are on an iPhone, please open the link using the **Google Chrome** browser.\n\n" + // FIX: Removed "for best results."
        "3️⃣ *Skip Advertisements:*\n" +
        "The website may show ads. Please close or skip any popups or advertisements to proceed.\n\n" +
        "4️⃣ *Copy Your Session ID:*\n" + // FIX: Updated title for point 4
        "Once you are done logging in, check your personal chat and copy the first message starting with `levanter_`.\n\n" + // FIX: Updated details for point 4
        "5️⃣ *Final Step: Launch Your Bot:*\n" + // FIX: Added new point 5 title
        "When you're done, come back here and tap the 'Deploy' button to launch your bot. Remember to get your Deploy key from the Admin."; // FIX: Added new point 5 details'
;
    const keyboard = {
        inline_keyboard: [
            [{ text: "Can't get code?", callback_data: "cant_get_code" }]
        ]
    };

    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: guideCaption,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } catch (e) { // Add catch block for sendPhoto
        console.error(`Error sending photo in Get Session: ${e.message}`);
        await bot.sendMessage(cid, guideCaption, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
    return;
  }

  if (text === 'My Bots') {
    // NEW: Log the user_id before fetching bots
    console.log(`[Flow] My Bots button clicked by user: ${cid}`);
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
    return bot.sendMessage(cid, `For help, contact the admin: ${SUPPORT_USERNAME}`);
  }

  // --- Stateful flows (for text input) ---
  const st = userStates[cid];
  if (!st) {
    // Admin handling for pairing code
    if (cid === ADMIN_ID && userStates[ADMIN_ID]?.step === 'AWAITING_PAIRING_CODE_FROM_ADMIN') {
        const pairingCode = text.trim();
        const words = pairingCode.split(/\s+/);

        if (words.length !== 8) {
            return bot.sendMessage(ADMIN_ID, '❌ Invalid pairing code format. Please send exactly 8 words.');
        }

        const targetUserId = userStates[ADMIN_ID].data.target_user_id_for_pairing;
        if (targetUserId) {
            await bot.sendMessage(targetUserId, `Your pairing code is:\n\`\`\`\n${pairingCode}\n\`\`\`\nGo to your linked device and paste it ASAP!`, { parse_mode: 'Markdown' });
            await bot.sendMessage(ADMIN_ID, `✅ Pairing code sent to user \`${targetUserId}\`.`);
            delete userStates[ADMIN_ID]; // Clear admin's state
            delete userStates[targetUserId]; // Clear the target user's state too
            console.log(`[Admin] Pairing code sent to user ${targetUserId} and states cleared.`);
        } else {
            // This should not happen if state is managed correctly
            console.error(`[Admin] Admin tried to send pairing code but target user ID was missing from state.`);
            await bot.sendMessage(ADMIN_ID, `Error: Target user for pairing code not found in state. Please try again.`);
            delete userStates[ADMIN_ID];
        }
        return; // Important: Exit after handling admin pairing code
    }
    return; // No active state, ignore message
  }

  // Handle user's phone number input
  if (st.step === 'AWAITING_PHONE_NUMBER') {
    const phoneNumber = text;
    // Regex for + followed by exactly 12 digits (total 13 characters: +XXXXXXXXXXXX)
    const phoneRegex = /^\+\d{12}$/; 

    if (!phoneRegex.test(phoneNumber)) {
        return bot.sendMessage(cid, '❌ Invalid format. Please send your WhatsApp number in the format `+2349163XXXXXX` (13 digits), e.g., `+2349163000000`.', { parse_mode: 'Markdown' });
    }

    // Set admin's state to know which user to send the pairing code to
    userStates[ADMIN_ID] = {
        step: 'AWAITING_PAIRING_CODE_FROM_ADMIN',
        data: { target_user_id_for_pairing: cid }
    };

    await bot.sendMessage(ADMIN_ID, 
        `📞 User \`${cid}\` (\`${msg.from.username || msg.from.first_name}\`) needs a pairing code.\n` +
        `*Phone:* \`${phoneNumber}\`\n\n` +
        `*Please reply to this message with the 8-word pairing code for this user.*`, 
        { parse_mode: 'Markdown' }
    );
    await bot.sendMessage(cid, '✅ Your request has been sent to the admin. Please wait while they generate a pairing code for you.');
    
    // User's state should now be cleared or set to a "waiting for admin" state.
    // For now, let's clear it assuming admin will provide the next action.
    delete userStates[cid]; // User is now waiting for admin to reply directly.

    return; // Exit after handling phone number
  }


  if (st.step === 'AWAITING_KEY') {
    const keyAttempt = text.toUpperCase();

    // Add animation for key verification
    const verificationMsg = await bot.sendMessage(cid, `${getAnimatedEmoji()} Verifying key...`);
    const animateIntervalId = await animateMessage(cid, verificationMsg.message_id, 'Verifying key...');

    // Wait for at least 5 seconds for the animation to play
    const startTime = Date.now();
    const usesLeft = await useDeployKey(keyAttempt); // This is where the actual work happens
    const elapsedTime = Date.now() - startTime;
    const remainingDelay = 5000 - elapsedTime; // Minimum 5 seconds delay
    if (remainingDelay > 0) {
        await new Promise(r => setTimeout(r, remainingDelay));
    }
    
    clearInterval(animateIntervalId); // Stop animation immediately after the delay

    if (usesLeft === null) {
      // FIX: Updated message and added button for key contact
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
      return; // Exit if key is invalid
    }
    
    await bot.editMessageText(`✅ Verified!`, {
        chat_id: cid,
        message_id: verificationMsg.message_id
    });
    await new Promise(r => setTimeout(r, 1000)); // Short pause to show "Verified!" before next prompt

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
    // Finally, prompt for session ID in a new message
    return bot.sendMessage(cid, 'Please enter your session ID:');
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
        
        // --- INTERACTIVE WIZARD START ---
        // Instead of asking for the next step via text, we now send an an interactive message.
        st.step = 'AWAITING_WIZARD_CHOICE'; // A neutral state to wait for button click
        
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
        st.message_id = wizardMsg.message_id; // Store message_id to edit it later
        // --- INTERACTIVE WIZARD END ---

      } else {
        console.error(`Error checking app name "${nm}":`, e.response?.data?.message || e.message);
        return bot.sendMessage(cid, `Could not verify app name. The Heroku API might be down. Please try again later.`);
      }
    }
  }

  if (st.step === 'SETVAR_ENTER_VALUE') {
    // This part of the message handler is for when a *text* input is expected.
    const { APP_NAME, VAR_NAME, targetUserId: targetUserIdFromState } = st.data; // targetUserIdFromState might be undefined here.
    const newVal = text.trim();
    
    // Determine the actual user ID to associate the bot with.
    const finalUserId = targetUserIdFromState || cid;
    
    // This check is primarily for the normal deployment flow where SESSION_ID is provided by user.
    if (VAR_NAME === 'SESSION_ID' && newVal.length < 10) { 
        return bot.sendMessage(cid, 'Session ID must be at least 10 characters long.');
    }

    try {
      const updateMsg = await bot.sendMessage(cid, `Updating ${VAR_NAME} for "${APP_NAME}"...`); 
      
      // Perform the actual Heroku config var update
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
      
      // Update session in DB. This will correctly use the new session ID if VAR_NAME is SESSION_ID,
      // otherwise it just updates the row with current session_id from DB for other config var changes.
      console.log(`[Flow] SETVAR_ENTER_VALUE: Config var updated for "${APP_NAME}". Updating bot in user_bots DB for user "${finalUserId}".`);
      await addUserBot(finalUserId, APP_NAME, newVal); 

      const baseWaitingText = `Updated ${VAR_NAME} for "${APP_NAME}". Waiting for bot status confirmation...`;
      await bot.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { 
          chat_id: cid,
          message_id: updateMsg.message_id
      });
      // Start animation for waiting state after variable update
      const animateIntervalId = await animateMessage(cid, updateMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(APP_NAME, { resolve, reject, animateIntervalId }); 
      });

      const STATUS_CHECK_TIMEOUT = 180 * 1000; // 3 minutes for connection status check
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
          console.log(`Sent "updated and online" notification to user ${cid} for bot ${APP_NAME}`);

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
      const errorMsg = e.response?.data?.message || e.response?.data?.message || e.message; // More robust error message extraction
      console.error(`[API_CALL_ERROR] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data); 
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
  }
});

// 13) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  // Ensure q.data is not null or undefined before splitting
  const dataParts = q.data ? q.data.split(':') : [];
  const action = dataParts[0];
  const payload = dataParts[1];
  const extra = dataParts[2];
  const flag = dataParts[3];

  await bot.answerCallbackQuery(q.id).catch(() => {});

  console.log(`[CallbackQuery] Received: action=${action}, payload=${payload}, extra=${extra}, flag=${flag} from ${cid}`);
  console.log(`[CallbackQuery] Current state for ${cid}:`, userStates[cid]);

  // --- NEW: Handle "Can't get code?" button click ---
  if (action === 'cant_get_code') {
      delete userStates[cid]; // Clear any previous state
      userStates[cid] = { step: 'AWAITING_PHONE_NUMBER', data: { messageId: q.message.message_id } };
      await bot.editMessageText('Please send your WhatsApp number in the format `+2349163XXXXXX` (13 digits), e.g., `+2349163000000`:', { 
          chat_id: cid, 
          message_id: q.message.message_id, 
          parse_mode: 'Markdown' 
      });
      return;
  }
  // --- END NEW: Handle "Can't get code?" button click ---

  // --- INTERACTIVE WIZARD HANDLER ---
  if (action === 'setup') {
      const st = userStates[cid];
      // Ensure the user session is still active
      if (!st || !st.message_id || q.message.message_id !== st.message_id) {
          return bot.editMessageText('This menu has expired. Please start over by tapping /menu.', {
              chat_id: cid,
              message_id: q.message.message_id
          });
      }

      const [step, value] = [payload, extra]; // payload is 'autostatus', extra is 'true'/'false'

      if (step === 'autostatus') {
          // Store the user's choice
          st.data.AUTO_STATUS_VIEW = value === 'true' ? 'no-dl' : 'false';

          // Edit the message to show a confirmation and the final "Deploy" button
          const confirmationText = ` *Deployment Configuration*\n\n` +
                                   `*App Name:* \`${st.data.APP_NAME}\`\n` +
                                   `*Session ID:* \`${st.data.SESSION_ID.slice(0, 15)}...\`\n` +
                                   `*Auto Status:* \`${st.data.AUTO_STATUS_VIEW}\`\n\n` +
                                   `Ready to proceed?`;
          
          const confirmationKeyboard = {
              reply_markup: {
                  inline_keyboard: [
                      [{ text
