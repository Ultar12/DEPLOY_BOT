// bot.js

// --- CRITICAL DEBUG TEST: If you see this, the code is running! ---
console.log('--- SCRIPT STARTING: Verifying code execution (This should be the very first log!) ---');
// -----------------------------------------------------------------

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));


require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const path = require('path');
const mailListener = require('./mail_listener');
const fs = require('fs');
const express = require('express');
const { sendPaymentConfirmation } = require('./email_service');

const crypto = require('crypto');

const { URLSearchParams } = require('url');

// --- NEW GLOBAL CONSTANT FOR MINI APP ---
const MINI_APP_URL = 'https://deploy-bot-2h5u.onrender.com/miniapp';
// --- END NEW GLOBAL CONSTANT --
// --- NEW GLOBAL CONSTANT ---
const KEYBOARD_VERSION = 4; // Increment this number for every new keyboard update
// --- END OF NEW GLOBAL CONSTANT ---


// Ensure monitorInit exports sendTelegramAlert as monitorSendTelegramAlert
const { init: monitorInit, sendTelegramAlert: monitorSendTelegramAlert } = require('./bot_monitor');
const { init: servicesInit, ...dbServices } = require('./bot_services');
const { init: faqInit, sendFaqPage } = require('./bot_faq');

const MUST_JOIN_CHANNEL_LINK = 'https://t.me/+KgOPzr1wB7E5OGU0';
// ⚠️ IMPORTANT: Replace the placeholder ID below with the correct numeric ID of your channel.
// The bot MUST be an administrator in this channel for verification to work.
const MUST_JOIN_CHANNEL_ID = '-1002491934453'; 

let botUsername = 'ultarbotdeploybot'; // Add this new global variable

// 2) Load fallback env vars from app.json / custom config files
let levanterDefaultEnvVars = {};
let raganorkDefaultEnvVars = {};

try {
  const appJsonPath = path.join(__dirname, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    levanterDefaultEnvVars = Object.fromEntries(
      Object.entries(appJson.env || {})
        .filter(([key, val]) => val && val.value !== undefined)
        .map(([key, val]) => [key, val.value])
    );
    console.log('[Config] Loaded default env vars from app.json for Levanter.');
  } else {
    console.warn('[Config] No app.json found for Levanter. Default env vars will be empty.');
  }
} catch (e) {
  console.warn('[Config] Could not load fallback env vars from app.json for Levanter:', e.message);
}

try {
  const appJson1Path = path.join(__dirname, 'app.json1');
  if (fs.existsSync(appJson1Path)) {
    const appJson1 = JSON.parse(fs.readFileSync(appJson1Path, 'utf8'));
    raganorkDefaultEnvVars = Object.fromEntries(
      Object.entries(appJson1.env || {})
        .filter(([key, val]) => val && val.value !== undefined)
        .map(([key, val]) => [key, val.value])
    );
    console.log('[Config] Loaded default env vars from app.json1 for Raganork.');
  } else {
    console.warn('[Config] No app.json1 found for Raganork. Default env vars will be empty.');
  }
} catch (e) {
  console.warn('[Config] Could not load fallback env vars from app.json1 for Raganork:', e.message);
}

// 3) Environment config
const {
  TELEGRAM_BOT_TOKEN: TOKEN_ENV,
  HEROKU_API_KEY,
  ADMIN_ID,
  DATABASE_URL,
  DATABASE_URL2,
  PAYSTACK_SECRET_KEY, // <-- ADD THIS LINE
} = process.env;


const TELEGRAM_BOT_TOKEN = TOKEN_ENV || '7730944193:AAG1RKwymeGG1HlYZRvHcOZZy_St9c77Rg';
const TELEGRAM_USER_ID = '7302005705';
const TELEGRAM_CHANNEL_ID = '-1002892034574';

const GITHUB_LEVANTER_REPO_URL = process.env.GITHUB_LEVANTER_REPO_URL || 'https://github.com/lyfe00011/levanter.git';
const GITHUB_RAGANORK_REPO_URL = process.env.GITHUB_RAGANORK_REPO_URL || 'https://github.com/ultar1/raganork-md1';

const SUPPORT_USERNAME = '@star_ies1';
const ADMIN_SUDO_NUMBERS = ['234', '2349163916314'];
const LEVANTER_SESSION_PREFIX = 'levanter_';
const RAGANORK_SESSION_PREFIX = 'RGNK';
const RAGANORK_SESSION_SITE_URL = 'https://session.raganork.site/';

// 4) Postgres setup & ensure tables exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const backupPool = new Pool({
  connectionString: DATABASE_URL2,
  ssl: { rejectUnauthorized: false }
});

// --- REPLACED DATABASE STARTUP BLOCK ---

// Helper function to create all tables in a given database pool
async function createAllTablesInPool(dbPool, dbName) {
    console.log(`[DB-${dbName}] Checking/creating all tables...`);
    
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
        session_id TEXT,
        bot_type   TEXT DEFAULT 'levanter',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        status     TEXT DEFAULT 'online',
        PRIMARY KEY (user_id, bot_name)
      );
    `);
    await dbPool.query(`ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS deploy_keys (
        key        TEXT PRIMARY KEY,
        uses_left  INTEGER NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  await dbPool.query(`ALTER TABLE deploy_keys ADD COLUMN IF NOT EXISTS user_id TEXT;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS temp_deploys (
        user_id       TEXT PRIMARY KEY,
        last_deploy_at TIMESTAMP NOT NULL
      );
    `);

  await dbPool.query(`
  CREATE TABLE IF NOT EXISTS user_referrals (
    referred_user_id TEXT PRIMARY KEY,
    inviter_user_id TEXT NOT NULL,
    bot_name TEXT,
    referral_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);
  await dbPool.query(`ALTER TABLE user_referrals ADD COLUMN IF NOT EXISTS inviter_reward_pending BOOLEAN DEFAULT FALSE;`);


    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_id TEXT PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  await dbPool.query(`ALTER TABLE user_activity ADD COLUMN IF NOT EXISTS keyboard_version INTEGER DEFAULT 0;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        user_id TEXT PRIMARY KEY,
        banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        banned_by TEXT
      );
    `);

  await dbPool.query(`
      CREATE TABLE IF NOT EXISTS key_rewards (
          user_id TEXT PRIMARY KEY,
          reward_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS all_users_backup (
        user_id TEXT PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
await dbPool.query(`
  CREATE TABLE IF NOT EXISTS pre_verified_users (
    user_id TEXT PRIMARY KEY,
    ip_address TEXT NOT NULL,
    verified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
`);

  await dbPool.query(`ALTER TABLE free_trial_numbers ADD COLUMN IF NOT EXISTS ip_address TEXT;`);



    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS user_deployments (
        user_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        session_id TEXT,
        config_vars JSONB,
        bot_type TEXT,
        deploy_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expiration_date TIMESTAMP,
        deleted_from_heroku_at TIMESTAMP,
        warning_sent_at TIMESTAMP,
        PRIMARY KEY (user_id, app_name)
      );
    `);

  await dbPool.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS email TEXT;`);

  //Inside the createAllTablesInPool function
await dbPool.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS referred_by TEXT;`);


  await dbPool.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS is_free_trial BOOLEAN DEFAULT FALSE;`);
    
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS free_trial_monitoring (
        user_id TEXT PRIMARY KEY,
        app_name TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        trial_start_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        warning_sent_at TIMESTAMP
      );
    `);

  await dbPool.query(`
  CREATE TABLE IF NOT EXISTS temp_numbers (
    number TEXT PRIMARY KEY,
    masked_number TEXT NOT NULL,
    status TEXT DEFAULT 'available',
    user_id TEXT,
    assigned_at TIMESTAMP WITH TIME ZONE
  );
`);


    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pending_payments (
        reference  TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        email      TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    // --- THIS IS THE FIX ---
    // This line ensures the 'bot_type' column is added to the existing table
    await dbPool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS bot_type TEXT;`);
  await dbPool.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS app_name TEXT, ADD COLUMN IF NOT EXISTS session_id TEXT;`);

    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS completed_payments (
        reference  TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        email      TEXT NOT NULL,
        amount     INTEGER NOT NULL, -- Stored in kobo
        currency   TEXT NOT NULL,
        paid_at    TIMESTAMP WITH TIME ZONE NOT NULL
      );
    `);

  await dbPool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            data JSONB
        );
    `);
await dbPool.query(`
  CREATE TABLE IF NOT EXISTS free_trial_numbers (
    user_id TEXT PRIMARY KEY,
    number_used TEXT NOT NULL,
    claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
`);

      await dbPool.query(`
      CREATE TABLE IF NOT EXISTS pinned_messages (
        message_id BIGINT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        unpin_at TIMESTAMP WITH TIME ZONE NOT NULL
      );
    `);

    console.log(`[DB-${dbName}] All tables checked/created successfully.`);
}


// Main startup logic
// Main startup logic
(async () => {
  try {
    console.log("Starting database table creation...");
    await createAllTablesInPool(pool, "Main");
    console.log("Main database tables created successfully.");

    // --- ADD THIS LINE ---
    console.log("Attempting to create tables in backup database...");
    // ----------------------

    await createAllTablesInPool(backupPool, "Backup");
    console.log("Backup database tables created successfully.");

  } catch (dbError) {
    console.error("[DB] CRITICAL ERROR during initial database table creation:", dbError.message);
    process.exit(1);
  }
})();



// --- END OF REPLACEMENT ---



// 5) Initialize bot & in-memory state
// <<< IMPORTANT: Set polling to false here. It will be started manually later.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let botId; // <-- ADD THIS LINE

// Get the bot's own ID at startup
bot.getMe().then(me => {
    if (me && me.id) {
        botId = me.id.toString();
        // FIX: The bot's username is already in the 'me' object.
        // You should use me.username, not a hardcoded, undefined variable.
        botUsername = me.username; 
        console.log(`Bot initialized. ID: ${botId}, Username: ${me.username}`);
    }
}).catch(err => {
    console.error("CRITICAL: Could not get bot's own ID. Exiting.", err);
    process.exit(1);
});


const userStates = {}; // chatId -> { step, data, message_id, faqPage, faqMessageId }
const authorizedUsers = new Set(); // chatIds who've passed a key

// Map to store Promises for app deployment status based on channel notifications
const appDeploymentPromises = new Map(); // appName -> { resolve, reject, animateIntervalId }

const forwardingContext = {}; // Stores context for admin replies

// These are correctly declared once here:
const userLastSeenNotification = new Map(); // userId -> last timestamp notified
const adminOnlineMessageIds = new Map(); // userId -> adminMessageId (for editing)
const ONLINE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// NEW: Store maintenance mode status
const MAINTENANCE_FILE = path.join(__dirname, 'maintenance_status.json');
let isMaintenanceMode = false;

// AROUND LINE 470
// ===================================================================
// ADD THIS ENTIRE NEW FUNCTION:
// ===================================================================

const USERS_PER_PAGE = 8; // Define how many users to show per page

async function sendUserListPage(chatId, page = 1, messageId = null) {
    if (chatId.toString() !== ADMIN_ID) {
        return; // Just in case
    }

    try {
        // First, get the total count of all users to calculate pages
        const totalResult = await pool.query('SELECT COUNT(DISTINCT user_id) AS total FROM user_activity');
        const totalUsers = parseInt(totalResult.rows[0].total, 10);

        if (totalUsers === 0) {
            const text = "No users have interacted with the bot yet.";
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, text);
        }

        const totalPages = Math.ceil(totalUsers / USERS_PER_PAGE);
        page = Math.max(1, Math.min(page, totalPages)); // Ensure page is within valid range

        // Get the specific users for the current page
        const offset = (page - 1) * USERS_PER_PAGE;
        const pageResult = await pool.query(
            `SELECT DISTINCT user_id FROM user_activity ORDER BY user_id ASC LIMIT $1 OFFSET $2`, 
            [USERS_PER_PAGE, offset]
        );
        const userIds = pageResult.rows.map(row => row.user_id);

        // Build the message content
        let responseMessage = `*Registered Users - Page ${page}/${totalPages}*\n\n`;
        for (const userId of userIds) {
            const bannedStatus = await dbServices.isUserBanned(userId);
            responseMessage += `ID: \`${userId}\` ${bannedStatus ? '(Banned)' : ''}\n`;
        }
        responseMessage += `\n_Use /info <ID> for full details._`;

        // Create the navigation buttons
        const navRow = [];
        if (page > 1) {
            navRow.push({ text: 'Previous', callback_data: `users_page:${page - 1}` });
        }
        navRow.push({ text: `Page ${page}`, callback_data: 'no_action' });
        if (page < totalPages) {
            navRow.push({ text: 'Next', callback_data: `users_page:${page + 1}` });
        }

        // Send or edit the message
        const options = {
            chat_id: chatId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [navRow]
            }
        };

        if (messageId) {
            await bot.editMessageText(responseMessage, { ...options, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, responseMessage, options);
        }
    } catch (error) {
        console.error(`Error sending user list page:`, error);
        await bot.sendMessage(chatId, "An error occurred while fetching the user list.");
    }
}
// 6) Utilities (some are passed to other modules)

// Function to escape Markdown V2 special characters
function escapeMarkdown(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    // Escape all special Markdown v2 characters: _, *, [, ], (, ), ~, `, >, #, +, -, =, |, {, }, ., !
    // Only escape if not part of a known URL or if it's explicitly used as a markdown character
    return text
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
}

// AROUND LINE 490 (inside bot.js)

let emojiIndex = 0;
const animatedEmojis = ['🕛', '🕒', '🕡', '🕘', '🕛', '🕒']; // Full-color circle emojis for animation
// --- END REPLACE ---

function getAnimatedEmoji() {
    const emoji = animatedEmojis[emojiIndex];
    emojiIndex = (emojiIndex + 1) % animatedEmojis.length;
    return emoji;
}


// REDUCED ANIMATION FREQUENCY
async function animateMessage(chatId, messageId, baseText) {
    const intervalId = setInterval(async () => {
        try {
            // --- REPLACE THIS LINE ---
            // await bot.editMessageText(`${getAnimatedEmoji()} ${baseText}`, {
            // --- WITH THIS ---
            await bot.editMessageText(`${baseText} ${getAnimatedEmoji()}`, {
            // --- END REPLACE ---
                chat_id: chatId,
                message_id: messageId
            }).catch(() => {});
        } catch (e) {
            console.error(`Error animating message ${messageId}:`, e.message);
            clearInterval(intervalId);
        }
    }, 2000);
    return intervalId;
}

// --- FIX: Corrected sendLatestKeyboard function for reliable database updates ---
async function sendLatestKeyboard(chatId) {
    const isAdmin = String(chatId) === ADMIN_ID;
    const currentKeyboard = buildKeyboard(isAdmin);

    try {
        await bot.sendMessage(chatId, 'Keyboard updated to the latest version!', {
            reply_markup: { keyboard: currentKeyboard, resize_keyboard: true }
        });
        
        // This is the critical fix: we ensure the database update is properly handled.
        await pool.query('UPDATE user_activity SET keyboard_version = $1 WHERE user_id = $2', [KEYBOARD_VERSION, chatId]);
        console.log(`[Keyboard Update] User ${chatId} keyboard version updated to ${KEYBOARD_VERSION}.`);
    } catch (error) {
        console.error(`[Keyboard Update] CRITICAL ERROR: Failed to send latest keyboard or update database for user ${chatId}:`, error.message);
        // You may also want to notify the admin about this critical error
        bot.sendMessage(ADMIN_ID, `CRITICAL ERROR: Keyboard update failed for user ${chatId}. Check logs.`, { parse_mode: 'Markdown' });
    }
}

// Function to check for and release timed-out pending numbers
async function releaseTimedOutNumbers() {
    console.log('[Scheduler] Checking for timed-out pending payments...');
    const timeoutThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    try {
        const result = await pool.query(
            "UPDATE temp_numbers SET status = 'available', user_id = NULL, assigned_at = NULL WHERE status = 'pending_payment' AND assigned_at < $1 RETURNING number",
            [timeoutThreshold]
        );
        if (result.rowCount > 0) {
            console.log(`[Scheduler] Released ${result.rowCount} number(s) from pending status.`);
            result.rows.forEach(num => {
                bot.sendMessage(ADMIN_ID, `⚠️ Number <code>${num.number}</code> was automatically released due to a payment timeout.`, { parse_mode: 'HTML' });
            });
        }
    } catch (e) {
        console.error('[Scheduler] Error releasing timed-out numbers:', e);
    }
}

// Schedule this function to run every minute
setInterval(releaseTimedOutNumbers, 60 * 1000);



async function sendBannedUsersList(chatId, messageId = null) {
    if (String(chatId) !== ADMIN_ID) return;

    try {
        const result = await pool.query('SELECT user_id FROM banned_users ORDER BY banned_at DESC');
        const bannedUsers = result.rows;

        if (bannedUsers.length === 0) {
            const text = "No users are currently banned.";
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, text);
        }

        const userButtons = [];
        for (const user of bannedUsers) {
            let userName = `ID: ${user.user_id}`;
            try {
                const chat = await bot.getChat(user.user_id);
                userName = `${chat.first_name || ''} ${chat.last_name || ''} (${user.user_id})`.trim();
            } catch (e) {
                // User might have deleted their account, just use the ID
                console.warn(`Could not fetch info for banned user ${user.user_id}`);
            }
            userButtons.push([{ text: `${userName}`, callback_data: `unban_user:${user.user_id}` }]);
        }

        const options = {
            chat_id: chatId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: userButtons }
        };

        const text = "*Banned Users:*\n_Click a user to unban them._";
        if (messageId) {
            await bot.editMessageText(text, { ...options, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, text, options);
        }
    } catch (error) {
        console.error("Error sending banned users list:", error);
        await bot.sendMessage(chatId, "An error occurred while fetching the banned user list.");
    }
}



async function sendBappList(chatId, messageId = null, botTypeFilter) {
    const checkingMsg = await bot.editMessageText(
        `Checking and syncing all *${botTypeFilter.toUpperCase()}* apps with Heroku...`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
    }).catch(() => bot.sendMessage(chatId, `Checking apps...`, { parse_mode: 'Markdown' }));

    messageId = checkingMsg.message_id;

    try {
        // Step 1: Run the reconciliation process first
        await dbServices.reconcileDatabaseWithHeroku(botTypeFilter);

        // Step 2: Then, get the now-corrected list of bots from the database
        const dbResult = await pool.query(
            `SELECT user_id, app_name, deleted_from_heroku_at FROM user_deployments WHERE bot_type = $1 ORDER BY app_name ASC`,
            [botTypeFilter]
        );
        const allDbBots = dbResult.rows;

        if (allDbBots.length === 0) {
            return bot.editMessageText(`No bots (active or inactive) were found in the database for the type: *${botTypeFilter.toUpperCase()}*`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
            });
        }

        // Step 3: Verify each bot against Heroku and update its status in our list
        const verificationPromises = allDbBots.map(async (bot) => {
            try {
                await axios.get(`https://api.heroku.com/apps/${bot.app_name}`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                if (bot.deleted_from_heroku_at) {
                    await pool.query('UPDATE user_deployments SET deleted_from_heroku_at = NULL WHERE app_name = $1', [bot.app_name]);
                }
                return { ...bot, is_active: true };
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    if (!bot.deleted_from_heroku_at) {
                        await dbServices.markDeploymentDeletedFromHeroku(bot.user_id, bot.app_name);
                    }
                }
                return { ...bot, is_active: false };
            }
        });
        
        const verifiedBots = await Promise.all(verificationPromises);

        const appButtons = verifiedBots.map(entry => {
            const statusIndicator = entry.is_active ? '🟢' : '🔴';
            return {
                text: `${statusIndicator} ${entry.app_name}`,
                callback_data: `select_bapp:${entry.app_name}:${entry.user_id}`
            };
        });

        const rows = chunkArray(appButtons, 3);
        const text = `Select a *${botTypeFilter.toUpperCase()}* app to view details (🟢 Active, 🔴 Inactive):`;
        const options = {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows }
        };

        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });

    } catch (error) {
        console.error(`Error fetching and syncing app list for /bapp:`, error.message);
        await bot.editMessageText(`An error occurred while syncing the app list. Please check the logs.`, {
             chat_id: chatId, message_id: messageId
        });
    }
}


// AROUND LINE 520 (inside bot.js)

async function sendAnimatedMessage(chatId, baseText) {
    // --- REPLACE THIS LINE ---
    // const msg = await bot.sendMessage(chatId, `${getAnimatedEmoji()} ${baseText}...`);
    // --- WITH THIS ---
    const msg = await bot.sendMessage(chatId, `${baseText}... ${getAnimatedEmoji()}`);
    // --- END REPLACE ---
    await new Promise(r => setTimeout(r, 1200));
    return msg;
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}


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

function formatExpirationInfo(deployDateStr, expirationDateStr) {
    if (!deployDateStr) return 'N/A';

    const deployDate = new Date(deployDateStr);
    const fixedExpirationDate = new Date(deployDate.getTime() + 45 * 24 * 60 * 60 * 1000); // 45 days from original deploy
    const now = new Date();

    const expirationDisplay = fixedExpirationDate.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });

    const timeLeftMs = fixedExpirationDate.getTime() - now.getTime();
    const daysLeft = Math.ceil(timeLeftMs / (1000 * 60 * 60 * 24));

    if (daysLeft > 0) {
        return `${expirationDisplay} (Expires in ${daysLeft} days)`;
    } else {
        return `Expired on ${expirationDisplay}`;
    }
}


function buildKeyboard(isAdmin) {
  const baseMenu = [
      ['Get Session ID', 'Deploy'],
      ['My Bots', 'Free Trial'],
      ['FAQ', 'Referrals'],
      ['Support' 'More Features'] 
  ];
  if (isAdmin) {
      return [
          ['Deploy', 'Apps'],
          ['Generate Key', 'Get Session ID'],
          ['/stats', '/users', `/bapp`], // Existing FAQ button
          ['/copydb', '/backupall', `/restoreall`] // <-- ADD /bapp here
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

// --- REPLACE your old handleRestoreAll function with these TWO new functions ---

// This function runs when you first click "Levanter" or "Raganork"
async function handleRestoreAllSelection(query) {
    const chatId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    
    await bot.editMessageText(`Fetching list of restorable ${botType} bots...`, {
        chat_id: chatId,
        message_id: query.message.message_id
    });

    const deployments = await dbServices.getAllDeploymentsFromBackup(botType);
    if (!deployments.length) {
        await bot.editMessageText(`No bots of type "${botType}" found in the backup to restore.`, {
            chat_id: chatId,
            message_id: query.message.message_id
        });
        return;
    }

    let listMessage = `Found *${deployments.length}* ${botType} bot(s) ready for restoration:\n\n`;
    deployments.forEach(dep => {
        listMessage += `• \`${dep.app_name}\` (Owner: \`${dep.user_id}\`)\n`;
    });
    listMessage += `\nThis process will deploy them one-by-one with a 3-minute delay between each success.\n\n*Do you want to proceed?*`;

    await bot.editMessageText(listMessage, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Proceed", callback_data: `restore_all_confirm:${botType}` },
                    { text: "Cancel", callback_data: 'restore_all_cancel' }
                ]
            ]
        }
    });
}

async function handleRestoreAllConfirm(query) {
    const chatId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    
    await bot.editMessageText(`Confirmation received. Starting sequential restoration for all *${botType}* bots. This will take a long time...`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
    });

    const deployments = await dbServices.getAllDeploymentsFromBackup(botType);
    let successCount = 0;
    let failureCount = 0;

    for (const [index, deployment] of deployments.entries()) {
        const appName = deployment.app_name;
        // --- FIX STARTS HERE: Pre-check if app is already active ---
        await bot.sendMessage(chatId, `Checking app ${index + 1}/${deployments.length}: \`${appName}\`...`, { parse_mode: 'Markdown' });
        try {
            await axios.get(`https://api.heroku.com/apps/${appName}`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            });
            // If the app exists, this code will run.
            await bot.sendMessage(chatId, `App \`${appName}\` is already active on Heroku. Skipping restore.`, { parse_mode: 'Markdown' });
            continue; // This skips the rest of the loop for this app.
        } catch (e) {
            // If the app does not exist, a 404 error is returned, and we proceed below.
            // Other errors are logged and we also skip.
            if (e.response && e.response.status !== 404) {
                console.error(`[RestoreAll] Error checking status for ${appName}: ${e.message}`);
                await bot.sendMessage(chatId, `Error checking status for \`${appName}\`. Skipping.`, { parse_mode: 'Markdown' });
                continue;
            }
        }
        // --- FIX ENDS HERE ---

        try {
            await bot.sendMessage(chatId, `▶Restoring bot ${index + 1}/${deployments.length}: \`${deployment.app_name}\` for user \`${deployment.user_id}\`...`, { parse_mode: 'Markdown' });
            
            const vars = { ...deployment.config_vars, APP_NAME: deployment.app_name, SESSION_ID: deployment.session_id };
            const success = await dbServices.buildWithProgress(deployment.user_id, vars, false, true, botType);

            if (success) {
                successCount++;
                await bot.sendMessage(chatId, `Successfully restored: \`${deployment.app_name}\``, { parse_mode: 'Markdown' });
                await bot.sendMessage(deployment.user_id, `Your bot \`${deployment.app_name}\` has been successfully restored by the admin.`, { parse_mode: 'Markdown' });

                if (index < deployments.length - 1) {
                    await bot.sendMessage(chatId, `Waiting for 3 minutes before deploying the next app...`);
                    await new Promise(resolve => setTimeout(resolve, 3 * 60 * 1000));
                }
            } else {
                failureCount++;
                await bot.sendMessage(chatId, `Failed to restore: \`${deployment.app_name}\`. Check logs. Continuing to the next app.`, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            failureCount++;
            console.error(error);
            await bot.sendMessage(chatId, `CRITICAL ERROR while restoring \`${deployment.app_name}\`: ${error.message}.`, { parse_mode: 'Markdown' });
        }
    }
    await bot.sendMessage(chatId, `Restoration process complete!\n\n*Success:* ${successCount}\n*Failed:* ${failureCount}`, { parse_mode: 'Markdown' });
}



// A new reusable function to display the key deletion menu
async function sendKeyDeletionList(chatId, messageId = null) {
    if (chatId.toString() !== ADMIN_ID) return;

    try {
        const activeKeys = await dbServices.getAllDeployKeys();

        if (activeKeys.length === 0) {
            const text = "There are no active keys to delete.";
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, text);
        }

        const keyButtons = activeKeys.map(k => ([{
            text: `${k.key} (${k.uses_left} uses left)`,
            callback_data: `dkey_select:${k.key}`
        }]));
        
        const options = {
            chat_id: chatId,
            text: "Select a deployment key to delete:",
            reply_markup: { inline_keyboard: keyButtons }
        };

        if (messageId) {
            await bot.editMessageReplyMarkup(options.reply_markup, { chat_id: chatId, message_id: messageId });
            await bot.editMessageText(options.text, { chat_id: chatId, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, options.text, { reply_markup: options.reply_markup });
        }
    } catch (error) {
        console.error("Error sending key deletion list:", error);
        await bot.sendMessage(chatId, "An error occurred while fetching the key list.");
    }
}

async function restartBot(appName) {
    console.log(`[Auto-Restart] Memory error detected. Attempting to restart bot: ${appName}`);
    try {
        await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
            headers: { 
                Authorization: `Bearer ${HEROKU_API_KEY}`, 
                Accept: 'application/vnd.heroku+json; version=3' 
            }
        });
        console.log(`[Auto-Restart] Successfully initiated restart for ${appName}.`);
        return true;
    } catch (e) {
        console.error(`[Auto-Restart] Failed to restart bot ${appName}: ${e.message}`);
        return false;
    }
}



// NEW: User online notification logic (uses global maps declared above)
async function notifyAdminUserOnline(msg) {
    // Ensure msg.from exists and has an ID to prevent errors for non-user messages (e.g., channel posts)
    if (!msg || !msg.from || !msg.from.id) {
        console.warn("[Admin Notification] Skipping: msg.from or msg.from.id is undefined.", msg);
        return;
    }

    // Prevent bot from notifying itself (or other bots)
    if (msg.from.is_bot) {
        console.log("[Admin Notification] Skipping: Message originated from a bot.");
        return;
    }

    const userId = msg.from.id.toString();
    const now = Date.now();

    if (userId === ADMIN_ID) { // Don't notify admin about themselves
        return;
    }

    const lastNotified = userLastSeenNotification.get(userId) || 0;
    const lastAdminMessageId = adminOnlineMessageIds.get(userId);

    // Capture the text of the message (button/command pressed)
    const userAction = msg.text || (msg.callback_query ? `Callback: ${msg.callback_query.data}` : 'Interacted');

    // Safely get user details, providing fallbacks for undefined properties
    const first_name = msg.from.first_name ? escapeMarkdown(msg.from.first_name) : 'N/A';
    const last_name = msg.from.last_name ? escapeMarkdown(msg.from.last_name) : '';
    const username = msg.from.username ? `@${escapeMarkdown(msg.from.username)}` : 'N/A';

    const userDetails = `
*User Online:*
*ID:* \`${userId}\`
*Name:* ${first_name} ${last_name}
*Username:* ${username}
*Last Action:* \`${escapeMarkdown(userAction)}\`
*Time:* ${new Date().toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Lagos' })}
    `;

    // If within cooldown, attempt to edit the existing message
    if (now - lastNotified < ONLINE_NOTIFICATION_COOLDOWN_MS && lastAdminMessageId) {
        try {
            await bot.editMessageText(userDetails, {
                chat_id: ADMIN_ID,
                message_id: lastAdminMessageId,
                parse_mode: 'Markdown'
            });
            userLastSeenNotification.set(userId, now); // Still update timestamp to reset cooldown
            console.log(`[Admin Notification] Edited admin notification for user ${userId} (action: ${userAction}).`);
        } catch (error) {
            console.error(`Error editing admin notification for user ${userId}:`, error.message);
            // If editing fails (e.g., message too old), send a new one
            try {
                const sentMsg = await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'Markdown' });
                adminOnlineMessageIds.set(userId, sentMsg.message_id);
                userLastSeenNotification.set(userId, now);
                console.log(`[Admin Notification] Sent new admin notification for user ${userId} after edit failure.`);
            } catch (sendError) {
                console.error(`Error sending new admin notification for user ${userId} after edit failure:`, sendError.message);
            }
        }
    } else { // Outside cooldown or no previous message to edit, send new message
        try {
            const sentMsg = await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'Markdown' });
            adminOnlineMessageIds.set(userId, sentMsg.message_id);
            userLastSeenNotification.set(userId, now);
            console.log(`[Admin Notification] Notified admin about user ${userId} being online (action: ${userAction}).`);
        } catch (error) {
            console.error(`Error notifying admin about user ${userId} online:`, error.message);
        }
    }
}

// 7) Initialize modular components
(async () => {
    // Initialize bot_monitor.js
    monitorInit({
        bot: bot,
        config: { SESSION: [] }, // SESSION is from config.js, will be loaded by bot.js. Placeholder for now.
        APP_NAME: process.env.APP_NAME || 'Raganork Bot',
        HEROKU_API_KEY: HEROKU_API_KEY,
        TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN,
        TELEGRAM_USER_ID: TELEGRAM_USER_ID,
        TELEGRAM_CHANNEL_ID: TELEGRAM_CHANNEL_ID,
        RESTART_DELAY_MINUTES: parseInt(process.env.RESTART_DELAY_MINUTES || '1', 10), // Keep 1 min for testing
        appDeploymentPromises: appDeploymentPromises,
        getUserIdByBotName: dbServices.getUserIdByBotName, // Pass DB service function
        deleteUserBot: dbServices.deleteUserBot,           // Pass DB service function
        deleteUserDeploymentFromBackup: dbServices.deleteUserDeploymentFromBackup, // Pass DB service function
        backupPool: backupPool,  // Pass the backup DB pool
        mainPool: pool,
        getAllUserBots: dbServices.getAllUserBots,
        getAllUserDeployments: dbServices.getAllUserDeployments,
        ADMIN_ID: ADMIN_ID, // Pass ADMIN_ID for critical errors
       escapeMarkdown: escapeMarkdown,
    });

    //// Initialize bot_services.js
   servicesInit({
    mainPool: pool,
    backupPool: backupPool,
    bot: bot,
    HEROKU_API_KEY: HEROKU_API_KEY,
    GITHUB_LEVANTER_REPO_URL: GITHUB_LEVANTER_REPO_URL,
    GITHUB_RAGANORK_REPO_URL: GITHUB_RAGANORK_REPO_URL,
    ADMIN_ID: ADMIN_ID,
    // --- CRITICAL CHANGE START ---
    defaultEnvVars: { // <-- Pass an object containing both
        levanter: levanterDefaultEnvVars,
        raganork: raganorkDefaultEnvVars
    },
    // --- CRITICAL CHANGE END ---
    appDeploymentPromises: appDeploymentPromises,
    RESTART_DELAY_MINUTES: parseInt(process.env.RESTART_DELAY_MINUTES || '1', 10),
    getAnimatedEmoji: getAnimatedEmoji,
    animateMessage: animateMessage,
    sendAnimatedMessage: sendAnimatedMessage,
    monitorSendTelegramAlert: monitorSendTelegramAlert,
     getAllUserBots: dbServices.getAllUserBots, 
    escapeMarkdown: escapeMarkdown, // <-- Ensure this is passed
   });
    // Initialize bot_faq.js
    faqInit({
        bot: bot,
        userStates: userStates, // Pass the central userStates object
        escapeMarkdown: escapeMarkdown,
    });
  mailListener.init(bot, pool); // Start the mail listener with the bot and database pool

    await loadMaintenanceStatus(); // Load initial maintenance status

// Check the environment to decide whether to use webhooks or polling
// At the top of your file, make sure you have crypto required
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production') {
    // --- Webhook Mode (for Heroku) ---
    const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // <-- ADD THIS LINE

const APP_URL = process.env.APP_URL;

    if (!APP_URL) {
        console.error('CRITICAL ERROR: APP_URL environment variable is not set. The bot cannot start in webhook mode.');
        process.exit(1);
    }
    const PORT = process.env.PORT || 3000;
    
    const cleanedAppUrl = APP_URL.endsWith('/') ? APP_URL.slice(0, -1) : APP_URL;

    const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
    const fullWebhookUrl = `${cleanedAppUrl}${webhookPath}`;

    await bot.setWebHook(fullWebhookUrl);
    console.log(`[Webhook] Set successfully for URL: ${fullWebhookUrl}`);

  // --- REPLACE the previous pinging block with this one ---

    app.listen(PORT, () => {
        console.log(`[Web Server] Server running on port ${PORT}`);
    });

    // --- START: Auto-Ping Logic (Render ONLY) ---

    // This check now ensures it only runs if the APP_URL is set AND it's on Render
    if (process.env.APP_URL && process.env.RENDER === 'true') {
      const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
      
      setInterval(async () => {
        try {
          // Send a GET request to the app's own URL
          await axios.get(APP_URL);
          console.log(`[Pinger] Render self-ping successful to ${APP_URL}`);
        } catch (error) {
          // Log any errors without crashing the bot
          console.error(`[Pinger] Render self-ping failed: ${error.message}`);
        }
      }, PING_INTERVAL_MS);
      
      console.log(`[𝖀𝖑𝖙-𝕬𝕽] Render self-pinging service initialized for ${APP_URL} every 10 minutes.`);
    } else {
      console.log('[𝖀𝖑𝖙-𝕬𝕽] Self-pinging service is disabled (not running on Render).');
    }
    // --- END: Auto-Ping Logic ---

    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

    app.get('/', (req, res) => {
        res.send('Bot is running (webhook mode)!');
    });

  app.get('/verify', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'verify.html'));
    });
  
  app.get('/miniapp', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// NEW: Health check endpoint for the Mini App
app.get('/miniapp/health', (req, res) => {
    console.log('[Health Check] Mini App server is responsive.');
    res.status(200).json({ status: 'ok', message: 'Server is running.' });
});


 const validateWebAppInitData = (req, res, next) => {
    const initData = req.header('X-Telegram-Init-Data');
    if (!initData) {
        console.warn('[MiniApp Server] Unauthorized: No init data provided.');
        return res.status(401).json({ success: false, message: 'Unauthorized: No init data provided' });
    }

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        urlParams.sort();

        // The correct way to build the data string for validation
        const dataCheckString = Array.from(urlParams.entries())
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
        const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (checkHash !== hash) {
            console.warn('[MiniApp Server] Invalid WebApp data hash received.');
            return res.status(401).json({ success: false, message: 'Unauthorized: Invalid data signature' });
        }
        
        req.telegramData = JSON.parse(urlParams.get('user'));
        next();
    } catch (e) {
        console.error('[MiniApp Server] Error validating WebApp data:', e);
        res.status(401).json({ success: false, message: 'Unauthorized: Data validation failed' });
    }
};


// GET /api/app-name-check/:appName - Check if an app name is available
app.get('/api/app-name-check/:appName', validateWebAppInitData, async (req, res) => {
    const { appName } = req.params;

    // Check if the key is available before making the request
    if (!HEROKU_API_KEY) {
        console.error('[MiniApp] Heroku API key is not set in the environment.');
        return res.status(500).json({ success: false, message: 'Server configuration error: Heroku API key is missing.' });
    }

    try {
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        // If Heroku API call succeeds, the name is taken.
        res.json({ available: false });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            // A 404 error means the app name is available.
            res.json({ available: true });
        } else if (e.response && e.response.status === 403) {
            // Handle 403 Forbidden specifically
            console.error(`[MiniApp] Heroku API error checking app name: Permission denied (403). Check HEROKU_API_KEY.`);
            res.status(403).json({ success: false, message: 'API permission denied. Please contact support.' });
        } else {
            // Other errors (e.g., network issues)
            console.error(`[MiniApp] Heroku API error checking app name: ${e.message}`);
            res.status(500).json({ success: false, message: 'Could not check app name due to a server error.' });
        }
    }
});


app.get('/api/bots', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    try {
        // New Logic: Get the bot list directly from the database
        const botsResult = await pool.query(
            `SELECT 
                ub.bot_name, 
                ub.bot_type,
                ub.status,
                ud.expiration_date
            FROM user_bots ub
            LEFT JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
            WHERE ub.user_id = $1 AND (ud.deleted_from_heroku_at IS NULL OR ub.status = 'online')`,
            [userId]
        );

        const bots = botsResult.rows;

        // Log the number of bots found for debugging
        console.log(`[MiniApp V2] Found ${bots.length} bots in the database for user ${userId}.`);

        // The bot status is now fetched from the database, making this much more reliable
        const formattedBots = bots.map(bot => {
            let statusText = bot.status;
            if (bot.status === 'online') statusText = 'Online';
            if (bot.status === 'logged_out') statusText = 'Offline';

            return {
                appName: bot.bot_name,
                botType: bot.bot_type,
                expirationDate: bot.expiration_date,
                status: statusText,
            };
        });

        // Filter out any bots that were found but have a deleted status
        const filteredBots = formattedBots.filter(b => b.status !== 'Deleted');
        
        res.json({ success: true, bots: filteredBots });
    } catch (e) {
        console.error('[MiniApp V2] Error fetching user bots:', e.message);
        res.status(500).json({ success: false, message: 'Failed to fetch bot list.' });
    }
});




app.post('/api/bots/restart', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.body;
    try {
        const ownerCheck = await pool.query('SELECT user_id FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        res.json({ success: true, message: 'Bot restart initiated.' });
    } catch (e) {
        console.error(`[MiniApp V2] Error restarting bot ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to restart bot.' });
    }
});


  // GET /api/check-deploy-key/:key - Check if a key is valid without consuming its use.
app.get('/api/check-deploy-key/:key', validateWebAppInitData, async (req, res) => {
    const { key } = req.params;
    if (!key) {
        return res.status(400).json({ valid: false, message: 'No key provided.' });
    }

    try {
        const result = await pool.query(
            'SELECT uses_left FROM deploy_keys WHERE key = $1 AND uses_left > 0',
            [key.toUpperCase()]
        );

        if (result.rows.length > 0) {
            res.json({ valid: true, message: 'Key is valid.' });
        } else {
            res.json({ valid: false, message: 'Invalid or expired key.' });
        }
    } catch (error) {
        console.error('Error checking deploy key:', error.message);
        res.status(500).json({ valid: false, message: 'Internal server error.' });
    }
});


// GET /api/bots/logs - Get a bot's logs
app.get('/api/bots/logs/:appName', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.params;
    try {
        const ownerCheck = await pool.query('SELECT user_id FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        
        const logSessionRes = await axios.post(`https://api.heroku.com/apps/${appName}/log-sessions`, { tail: false, lines: 100 }, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const logsRes = await axios.get(logSessionRes.data.logplex_url);
        res.json({ success: true, logs: logsRes.data });
    } catch (e) {
        console.error(`[MiniApp V2] Error fetching logs for ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to get logs.' });
    }
});

// POST /api/bots/redeploy - Redeploy a bot
app.post('/api/bots/redeploy', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.body;
    try {
        const ownerCheck = await pool.query('SELECT user_id, bot_type FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }

        const botType = ownerCheck.rows[0].bot_type;
        const repoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
        
        await axios.post(
            `https://api.heroku.com/apps/${appName}/builds`,
            { source_blob: { url: `${repoUrl}/tarball/main` } },
            {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3',
                    'Content-Type': 'application/json'
                }
            }
        );
        res.json({ success: true, message: 'Redeployment initiated.' });
    } catch (e) {
        console.error(`[MiniApp V2] Error redeploying bot ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to redeploy.' });
    }
});

// POST /api/bots/set-session - Set a new session ID
app.post('/api/bots/set-session', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName, sessionId } = req.body;
    try {
        const ownerCheck = await pool.query('SELECT user_id, bot_type FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        
        const botType = ownerCheck.rows[0].bot_type;
        const isValid = (botType === 'raganork' && sessionId.startsWith(RAGANORK_SESSION_PREFIX)) ||
                        (botType === 'levanter' && sessionId.startsWith(LEVANTER_SESSION_PREFIX));
        if (!isValid) {
            return res.status(400).json({ success: false, message: `Invalid session ID format for ${botType}.` });
        }

        await axios.patch(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { SESSION_ID: sessionId },
            {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' }
            }
        );
        res.json({ success: true, message: 'Session ID updated successfully.' });
    } catch (e) {
        console.error(`[MiniApp V2] Error setting session ID for ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to update session ID.' });
    }
});
// GET /api/app-name-check/:appName - Check if an app name is available
app.get('/api/check-app-name/:appName', validateWebAppInitData, async (req, res) => {
    const { appName } = req.params;

    // Check if the key is available before making the request
    if (!HEROKU_API_KEY) {
        console.error('[MiniApp] Heroku API key is not set in the environment.');
        return res.status(500).json({ success: false, message: 'Server configuration error: Heroku API key is missing.' });
    }

    try {
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        // If Heroku API call succeeds, the name is taken.
        res.json({ available: false });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            // A 404 error means the app name is available.
            res.json({ available: true });
        } else if (e.response && e.response.status === 403) {
            // Handle 403 Forbidden specifically
            console.error(`[MiniApp] Heroku API error checking app name: Permission denied (403). Check HEROKU_API_KEY.`);
            res.status(403).json({ success: false, message: 'API permission denied. Please contact support.' });
        } else {
            // Other errors (e.g., network issues)
            console.error(`[MiniApp] Heroku API error checking app name: ${e.message}`);
            res.status(500).json({ success: false, message: 'Could not check app name due to a server error.' });
        }
    }
});


    app.post('/api/deploy', validateWebAppInitData, async (req, res) => {
    const { botType, appName, sessionId, autoStatusView, deployKey, isFreeTrial } = req.body;
    const userId = req.telegramData.id.toString();

    // 1. Initial validation
    if (!userId || !botType || !appName || !sessionId) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const pendingPaymentResult = await pool.query(
        'SELECT reference FROM pending_payments WHERE user_id = $1 AND app_name = $2',
        [userId, appName]
    );
    if (pendingPaymentResult.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'A payment is already pending for this app. Please complete it.' });
    }

    const isSessionIdValid = (botType === 'raganork' && sessionId.startsWith(RAGANORK_SESSION_PREFIX) && sessionId.length >= 10) ||
        (botType === 'levanter' && sessionId.startsWith(LEVANTER_SESSION_PREFIX) && sessionId.length >= 10);
    
    if (!isSessionIdValid) {
        return res.status(400).json({ success: false, message: `Invalid session ID format for bot type "${botType}".` });
    }

    // 2. Map autoStatusView to correct Heroku variable
    let herokuAutoStatusView = '';
    if (botType === 'levanter' && autoStatusView === 'yes') {
        herokuAutoStatusView = 'no-dl';
    } else if (botType === 'raganork' && autoStatusView === 'yes') {
        herokuAutoStatusView = 'true';
    } else {
        herokuAutoStatusView = 'false';
    }

    const deployVars = {
        SESSION_ID: sessionId,
        APP_NAME: appName,
        AUTO_STATUS_VIEW: herokuAutoStatusView
    };

    let deploymentMessage = '';

    try {
        if (isFreeTrial) {
            const check = await dbServices.canDeployFreeTrial(userId);
            if (!check.can) {
                return res.status(400).json({ success: false, message: `You have already used your Free Trial. You can use it again after: ${check.cooldown.toLocaleString()}.` });
            }
            deploymentMessage = 'Free Trial deployment initiated. Check the bot chat for updates!';
        } else if (deployKey) {
            const usesLeft = await dbServices.useDeployKey(deployKey, userId);
            if (usesLeft === null) {
                return res.status(400).json({ success: false, message: 'Invalid or expired deploy key.' });
            }
            deploymentMessage = 'Deployment initiated with key. Check the bot chat for updates!';
            
            // Admin notification logic here
            const userChat = await bot.getChat(userId);
            const userName = userChat.username ? `@${userChat.username}` : `${userChat.first_name || 'N/A'}`;
            await bot.sendMessage(ADMIN_ID,
                `*New App Deployed (Mini App)*\n` +
                `*User:* ${escapeMarkdown(userName)} (\`${userId}\`)\n` +
                `*App Name:* \`${appName}\`\n` +
                `*Key Used:* \`${deployKey}\`\n` +
                `*Uses Left:* ${usesLeft}`,
                { parse_mode: 'Markdown' }
            );
        }
        
        // This is a CRITICAL fix. The build process should be awaited.
        // It's also important to add the bot to the database before the build, so the monitor can find it.
        await dbServices.addUserBot(userId, appName, sessionId, botType);
        
        // This promise will resolve when the build is complete.
        // The `buildWithProgress` function must be refactored to return a promise that resolves on success.
        const buildPromise = dbServices.buildWithProgress(userId, deployVars, isFreeTrial, false, botType);
        
        // We do NOT await here to avoid a long timeout for the HTTP request.
        // Instead, the frontend gets an immediate success response, and the bot will send a message to the user later when the build is done.
        
        // Notify the user that the process has started
        await bot.sendMessage(userId, 
            `Deployment of your *${escapeMarkdown(appName)}* bot has started via the Mini App.\n\n` +
            `You will receive a notification here when the bot is ready.`, 
            { parse_mode: 'Markdown' });

        // Finally, send the success response to the Mini App
        res.json({ success: true, message: deploymentMessage });

    } catch (e) {
        console.error('[MiniApp Server] Deployment error:', e);
        res.status(500).json({ success: false, message: e.message || 'An unknown error occurred during deployment.' });
    }
});
  
  /// Replace the existing app.post('/pre-verify-user', ...) route in bot.js

app.post('/pre-verify-user', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    // Get the user's real IP address from the request headers
    const userIpAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    try {
        // --- CAPTCHA CHECK REMOVED ---

        // Check 1: Has this user ID already claimed a final trial?
        const trialUserCheck = await pool.query("SELECT user_id FROM free_trial_numbers WHERE user_id = $1", [userId]);
        if (trialUserCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'You have already claimed a free trial.' });
        }
        
        // Check 2: Has this IP address already been used for a final trial?
        const trialIpCheck = await pool.query("SELECT user_id FROM free_trial_numbers WHERE ip_address = $1", [userIpAddress]);
        if (trialIpCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'This network has already been used for a free trial.' });
        }

        // Add user to the pre-verified list
        await pool.query(
            "INSERT INTO pre_verified_users (user_id, ip_address) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET ip_address = EXCLUDED.ip_address, verified_at = NOW()",
            [userId, userIpAddress]
        );

        return res.json({ success: true });

    } catch (error) {
        console.error("Error in /pre-verify-user:", error.message);
        return res.status(500).json({ success: false, message: 'Server error.' });
    }
});


// POST /api/bots/set-var - Updates a single config variable for a bot
app.post('/api/bots/set-var', validateWebAppInitData, async (req, res) => {
    const { appName, varName, varValue } = req.body;
    const userId = req.telegramData.id.toString();
    try {
        const ownerCheck = await pool.query('SELECT user_id FROM user_bots WHERE bot_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, { [varName]: varValue }, {
            headers: {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3',
                'Content-Type': 'application/json'
            }
        });
        res.json({ success: true, message: `Variable ${varName} updated successfully. Restarting bot...` });
    } catch (e) {
        console.error(`[MiniApp V2] Error setting variable ${varName} for ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to set variable.' });
    }
});


app.post('/api/pay', validateWebAppInitData, async (req, res) => {
    const { botType, appName, sessionId, autoStatusView, email } = req.body;
    const userId = req.telegramData.id;
    const KEY_PRICE_NGN = parseInt(process.env.KEY_PRICE_NGN, 10) || 1500;
    const priceInKobo = KEY_PRICE_NGN * 100;
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

    if (!userId || !botType || !appName || !sessionId || !email) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const reference = crypto.randomBytes(16).toString('hex');
        
        // Use metadata to store key information for the webhook
        const metaData = {
            user_id: userId,
            bot_type: botType,
            app_name: appName,
            session_id: sessionId,
            auto_status_view: autoStatusView
        };

        // Insert into pending_payments with a 'pending' status
        await client.query(
            `INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [reference, userId, email, botType, appName, sessionId, 'pending']
        );

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email,
                amount: priceInKobo,
                reference,
                metadata: metaData,
                // A generic callback URL is fine as the webhook is the source of truth
                callback_url: `https://t.me/${process.env.BOT_USERNAME}`
            },
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            paymentUrl: paystackResponse.data.data.authorization_url,
            reference: reference
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Paystack transaction initialization error:', e.response?.data || e.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to create payment link. Please try again.',
            error: e.response?.data || e.message
        });
    } finally {
        client.release();
    }
});



    // --- END MINI APP ROUTES ---

    // At the top of your file, ensure 'crypto' is required
const crypto = require('crypto');

app.post('/paystack/webhook', express.json(), async (req, res) => {
    // 1. Verify the Paystack signature to ensure the request is legitimate
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
        console.warn('Invalid Paystack signature received.');
        return res.sendStatus(401); // Unauthorized
    }

    const event = req.body;

    // 2. Only process successful payments
    if (event.event === 'charge.success') {
        const { reference, metadata, amount, currency, customer } = event.data;
        const userId = metadata.user_id; // Get the user ID from the metadata

        try {
            // Check if this payment has already been processed to prevent duplicates
            const checkProcessed = await pool.query('SELECT reference FROM completed_payments WHERE reference = $1', [reference]);
            if (checkProcessed.rows.length > 0) {
                console.log(`Webhook for reference ${reference} already processed. Ignoring.`);
                return res.sendStatus(200); // Acknowledge the webhook without processing again
            }

            // 3. Use metadata to determine the payment type and route the logic
            if (metadata.product === 'temporary_number') {
                // --- THIS IS THE CORRECT LOGIC FOR TEMPORARY NUMBER PURCHASES ---
                const number = metadata.phone_number;

                // Mark the number as 'assigned' in the database
                await pool.query("UPDATE temp_numbers SET status = 'assigned', user_id = $1, assigned_at = NOW() WHERE number = $2", [userId, number]);

                // Also add a record to your main payments table for revenue tracking
                await pool.query(
                    `INSERT INTO completed_payments (reference, user_id, email, amount, currency, paid_at) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [reference, userId, customer?.email || 'temp-num@email.com', amount, currency, event.data.paid_at]
                );

                // Notify the user of their purchase
                await bot.sendMessage(userId, `Payment successful! You have been assigned the number: <code>${number}</code>`, { parse_mode: 'HTML' });
                await bot.sendMessage(userId, 'Register your numberon WhatsApp, I will send OTP if needed.');

                // Notify the admin of the new purchase
                const userChat = await bot.getChat(userId);
                const userName = userChat.username ? `@${userChat.username}` : `${userChat.first_name || 'N/A'}`;
                await bot.sendMessage(ADMIN_ID, `New temporary number purchased!\n\nUser: ${userName} (<code>${userId}</code>)\nNumber: <code>${number}</code>`, { parse_mode: 'HTML' });
                
                console.log(`Successfully processed temporary number payment for reference: ${reference}`);

            } else {
                // --- THIS IS THE EXISTING LOGIC FOR BOT DEPLOYMENTS/RENEWALS ---
                const pendingPayment = await pool.query('SELECT user_id, bot_type, app_name, session_id FROM pending_payments WHERE reference = $1', [reference]);
                if (pendingPayment.rows.length === 0) {
                    console.warn(`Pending payment for bot deploy not found for reference: ${reference}.`);
                    return res.sendStatus(200);
                }
                const { user_id, bot_type, app_name, session_id } = pendingPayment.rows[0];

                await pool.query(
                    `INSERT INTO completed_payments (reference, user_id, email, amount, currency, paid_at) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [reference, user_id, customer.email, amount, currency, event.data.paid_at]
                );

                const userChat = await bot.getChat(user_id);
                const userName = userChat.username ? `@${userChat.username}` : `${userChat.first_name || ''}`;

                if (bot_type && bot_type.startsWith('renewal_')) {
                    // Bot renewal logic...
                    const appNameToRenew = bot_type.split('_')[1];
                    await pool.query( `UPDATE user_deployments SET expiration_date = expiration_date + INTERVAL '45 days' WHERE user_id = $1 AND app_name = $2`, [user_id, appNameToRenew]);
                    await bot.sendMessage(user_id, `Payment confirmed!\n\nYour bot *${escapeMarkdown(appNameToRenew)}* has been successfully renewed.`, { parse_mode: 'Markdown' });
                    await bot.sendMessage(ADMIN_ID, `*Bot Renewed!*\n\n*User:* ${escapeMarkdown(userName)} (\`${user_id}\`)\n*Bot:* \`${appNameToRenew}\``, { parse_mode: 'Markdown' });
                } else {
                    // New bot deployment logic...
                    await bot.sendMessage(user_id, `Payment confirmed! Your bot deployment has started.`, { parse_mode: 'Markdown' });
                    const deployVars = { SESSION_ID: session_id, APP_NAME: app_name };
                    dbServices.buildWithProgress(user_id, deployVars, false, false, bot_type);
                    await bot.sendMessage(ADMIN_ID, `*New App Deployed (Paid)*\n\n*User:* ${escapeMarkdown(userName)} (\`${user_id}\`)\n*App Name:* \`${app_name}\``, { parse_mode: 'Markdown' });
                }

                await pool.query('DELETE FROM pending_payments WHERE reference = $1', [reference]);
                console.log(`Successfully processed bot deployment payment for reference: ${reference}`);
            }

        } catch (dbError) {
            console.error(`Webhook DB Error for reference ${reference}:`, dbError);
            await bot.sendMessage(ADMIN_ID, `⚠️ CRITICAL: Webhook processing failed for reference ${reference}. Manual intervention required.`);
            return res.sendStatus(500); // Internal Server Error
        }
    }

    // Acknowledge the webhook to Paystack
    res.sendStatus(200);
});



    // This GET handler is for users who visit the webhook URL in a browser
    app.get('/paystack/webhook', (req, res) => {
        res.status(200).send('<h1>Webhook URL</h1><p>Please return to the Telegram bot.</p>');
    });

    // This is your separate API endpoint for getting a key
    app.get('/api/get-key', async (req, res) => {
        const providedApiKey = req.headers['x-api-key'];
        const secretApiKey = process.env.INTER_BOT_API_KEY;

        if (!secretApiKey || providedApiKey !== secretApiKey) {
            console.warn('[API] Unauthorized attempt to get a key.');
            return res.status(401).json({ success: false, message: 'Unauthorized' });
        }

        try {
            const result = await pool.query(
    'SELECT key FROM deploy_keys WHERE uses_left > 0 AND user_id IS NULL ORDER BY created_at DESC LIMIT 1'
);

if (result.rows.length > 0) {
    const key = result.rows[0].key;
                console.log(`[API] Provided existing key ${key} to authorized request.`);
                return res.json({ success: true, key: key });
            } else {
                console.log('[API] No active key found. Creating a new one...');
                const newKey = generateKey(); // Using your existing key generator
                const newKeyResult = await pool.query(
                    'INSERT INTO deploy_keys (key, uses_left) VALUES ($1, 1) RETURNING key',
                    [newKey]
                );
                const createdKey = newKeyResult.rows[0].key;
                console.log(`[API] Provided newly created key ${createdKey} to authorized request.`);
                return res.json({ success: true, key: createdKey });
            }
        } catch (error) {
            console.error('[API] Database error while fetching/creating key:', error);
            return res.status(500).json({ success: false, message: 'Internal server error.' });
        }
    });

    // The command to start the server listening for requests
    app.listen(PORT, () => {
        console.log(`[Web Server] Server running on port ${PORT}`);
    });

} else {
    // --- Polling Mode (for local development) ---
    console.log('Bot is running in development mode (polling)...');
    bot.startPolling();
}
}) ();

// 8) Polling error handler
bot.on('polling_error', console.error);

// 9) Command handlers
bot.onText(/^\/start(?: (.+))?$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const inviterId = match?.[1]; // Capture the inviter's ID if available

    await dbServices.updateUserActivity(cid);
    const isAdmin = cid === ADMIN_ID;
    delete userStates[cid];
    const { first_name, last_name, username } = msg.from;
    console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}]`);

    // --- NEW: Referral Tracking Logic ---
    if (inviterId && inviterId !== cid) {
        try {
            await bot.getChat(inviterId); // Verify the inviter exists
            await pool.query(
                `INSERT INTO sessions (id, user_id, data, expires_at) 
                 VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
                 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
                [`referral_session:${cid}`, cid, { inviterId: inviterId }]
            );
            console.log(`[Referral] Stored inviter ID ${inviterId} for new user ${cid}.`);
        } catch (e) {
            console.error(`[Referral] Invalid inviter ID ${inviterId} from user ${cid}:`, e.message);
        }
    }
    // --- END NEW: Referral Tracking Logic ---

    if (isAdmin) {
        await bot.sendMessage(cid, 'Welcome, Admin! Here is your menu:', {
            reply_markup: { 
                keyboard: buildKeyboard(isAdmin), 
                resize_keyboard: true 
            }
        });
    } else {
        const { first_name: userFirstName } = msg.from;
        let personalizedGreeting = `Welcome back, ${escapeMarkdown(userFirstName || 'User')} to our Bot Deployment Service!`;

        const welcomeImageUrl = 'https://i.ibb.co/23tpQKrP/temp.jpg';
        const welcomeCaption = `
${personalizedGreeting}

To get started, please follow these simple steps:

1.  *Get Your Session:*
    Tap 'Get Session ID' to get your Bot Session ID.

2.  *Deploy Your Bot:*
    Once you have your session code, use the 'Deploy' button to launch your personalized bot.

We are here to assist you every step of the way!
`;

        await bot.sendPhoto(cid, welcomeImageUrl, {
            caption: welcomeCaption,
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: buildKeyboard(false),
                resize_keyboard: true
            }
        });
    }
});



// Add this with your other admin commands
bot.onText(/^\/dkey$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) {
        return;
    }
    await sendKeyDeletionList(cid);
});

bot.onText(/^\/menu$/i, async msg => {
  const cid = msg.chat.id.toString();
  await dbServices.updateUserActivity(cid);
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid]; // Clear user state
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, async msg => {
  const cid = msg.chat.id.toString();
  await dbServices.updateUserActivity(cid);
  if (cid === ADMIN_ID) {
    dbServices.sendAppList(cid); // Use dbServices
  }
});

// ADMIN COMMAND: /maintenance
bot.onText(/^\/maintenance (on|off)$/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    await dbServices.updateUserActivity(chatId);
    const status = match[1].toLowerCase();

    if (chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "You are not authorized to use this command.");
    }

    if (status === 'on') {
        isMaintenanceMode = true;
        await saveMaintenanceStatus(true);
        await bot.sendMessage(chatId, "Maintenance mode is now *ON*.", { parse_mode: 'Markdown' });
    } else if (status === 'off') {
        isMaintenanceMode = false;
        await saveMaintenanceStatus(false);
        await bot.sendMessage(chatId, "Maintenance mode is now *OFF*.", { parse_mode: 'Markdown' });
    }
});


// New /id command
bot.onText(/^\/id$/, async msg => {
    const cid = msg.chat.id.toString();
    await dbServices.updateUserActivity(cid);
    await bot.sendMessage(cid, `Your Telegram Chat ID is: \`${cid}\``, { parse_mode: 'Markdown' });
});

// New /add <user_id> command for admin
bot.onText(/^\/add (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    await dbServices.updateUserActivity(cid);
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
                return bot.sendMessage(cid, `Cannot assign app: User with ID \`${targetUserId}\` not found or has not interacted with the bot.`, { parse_mode: 'Markdown' });
            } else if (apiError.includes("bot was blocked by the user")) {
                return bot.sendMessage(cid, `Cannot assign app: The bot is blocked by user \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
            }
        }
        return bot.sendMessage(cid, `An error occurred while starting the add process for user \`${targetUserId}\`: ${error.message}. Please check logs.`, { parse_mode: 'Markdown' });
    }

    console.log(`[Admin] Admin ${cid} initiated /add for user ${targetUserId}. Prompting for app selection.`);

    try {
        const sentMsg = await bot.sendMessage(cid, `Select the app to assign to user \`${targetUserId}\`:`, { parse_mode: 'Markdown' });
        userStates[cid] = {
            step: 'AWAITING_APP_FOR_ADD',
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid}:`, userStates[cid]);
        dbServices.sendAppList(cid, sentMsg.message_id, 'add_assign_app', targetUserId); // Use dbServices
    }
    catch (error) {
        console.error("Error sending initial /add message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the add process. Please try again.");
    }
});

bot.onText(/^\/mynum$/, async (msg) => {
    const userId = msg.chat.id.toString();
    try {
        const result = await pool.query("SELECT number, status, assigned_at FROM temp_numbers WHERE user_id = $1 ORDER BY assigned_at DESC", [userId]);
        const numbers = result.rows;
        
        if (numbers.length === 0) {
            return bot.sendMessage(userId, "You dont have any number,  use /buytemp");
        }
        
        let message = "<b>Your WhatsApp Numbers:</b>\n\n";
        numbers.forEach(num => {
            const statusEmoji = num.status === 'assigned' ? '🔵' : '🔴';
            message += `${statusEmoji} <code>${num.number}</code> | <b>Status:</b> ${num.status}\n`;
        });
        
        await bot.sendMessage(userId, message, { parse_mode: 'HTML' });
    } catch (e) {
        console.error(`Error fetching numbers for user ${userId}:`, e);
        await bot.sendMessage(userId, "An error occurred while fetching your numbers.");
    }
});

// This will track the current page for the admin
const adminDashboardState = {
    currentPage: 1
};

// Updated /num command handler
bot.onText(/^\/num$/, async (msg) => {
    adminDashboardState.currentPage = 1; // Reset to page 1 every time the command is run
    await sendNumbersDashboard(msg.chat.id, 1);
});

// Callback handler for page navigation
bot.on('callback_query', async (query) => {
    if (query.data.startsWith('num_page:')) {
        const page = parseInt(query.data.split(':')[1]);
        adminDashboardState.currentPage = page;
        await sendNumbersDashboard(query.message.chat.id, page, query.message.message_id);
    }
});

// A new reusable function to send the dashboard
async function sendNumbersDashboard(chatId, page = 1, messageId = null) {
    if (chatId.toString() !== ADMIN_ID) return;
    const NUMBERS_PER_PAGE = 10;
    const offset = (page - 1) * NUMBERS_PER_PAGE;

    try {
        // Get counts for each status
        const countsResult = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'available') AS available_count,
                COUNT(*) FILTER (WHERE status = 'pending_payment') AS pending_count,
                COUNT(*) FILTER (WHERE status = 'assigned') AS assigned_count,
                COUNT(*) AS total_count
            FROM temp_numbers;
        `);
        const { available_count, pending_count, assigned_count, total_count } = countsResult.rows[0];

        // Get the numbers for the current page
        const pageResult = await pool.query(
            "SELECT number, status, user_id FROM temp_numbers ORDER BY status DESC, number ASC LIMIT $1 OFFSET $2",
            [NUMBERS_PER_PAGE, offset]
        );
        const numbersOnPage = pageResult.rows;

        if (total_count == 0) {
            return bot.sendMessage(chatId, "No temporary numbers found in the database.");
        }

        const totalPages = Math.ceil(total_count / NUMBERS_PER_PAGE);

        let message = `<b>Numbers Dashboard (Page ${page}/${totalPages})</b>\n\n`;
        message += `🟢 Available: <b>${available_count}</b>\n`;
        message += `🟡 Pending: <b>${pending_count}</b>\n`;
        message += `🔵 Assigned: <b>${assigned_count}</b>\n`;
        message += `------------------------------\n`;

        numbersOnPage.forEach(num => {
            const statusEmoji = num.status === 'available' ? '🟢' : num.status === 'pending_payment' ? '🟡' : '🔵';
            message += `${statusEmoji} <code>${num.number}</code> | <b>User:</b> ${num.user_id || 'N/A'}\n`;
        });

        // Create navigation buttons
        const navButtons = [];
        if (page > 1) {
            navButtons.push({ text: 'Previous', callback_data: `num_page:${page - 1}` });
        }
        if (page < totalPages) {
            navButtons.push({ text: 'Next', callback_data: `num_page:${page + 1}` });
        }

        const options = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [navButtons]
            }
        };

        if (messageId) {
            await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...options });
        } else {
            await bot.sendMessage(chatId, message, options);
        }

    } catch (e) {
        console.error("Error fetching number dashboard:", e);
        await bot.sendMessage(chatId, "An error occurred while fetching the number dashboard.");
    }
}


bot.onText(/^\/expire (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const days = parseInt(match[1], 10);
    if (isNaN(days) || days <= 0) {
        return bot.sendMessage(cid, "Please provide a valid number of days (e.g., /expire 45).");
    }

    try {
        let allBots = await dbServices.getAllUserBots();
        if (allBots.length === 0) {
            return bot.sendMessage(cid, "There are no bots deployed to set an expiration for.");
        }

        // --- START OF CHANGES ---
        // Sort the bots alphabetically by name
        allBots.sort((a, b) => a.bot_name.localeCompare(b.bot_name));

        userStates[cid] = {
            step: 'AWAITING_APP_FOR_EXPIRATION',
            data: { days: days }
        };

        const appButtons = allBots.map(bot => ({
            text: bot.bot_name,
            callback_data: `set_expiration:${bot.bot_name}`
        }));

        // Arrange the buttons in rows of 3
        const keyboard = chunkArray(appButtons, 3);
        // --- END OF CHANGES ---

        await bot.sendMessage(cid, `Select an app to set its expiration to *${days} days* from now:`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } catch (error) {
        console.error("Error fetching bots for /expire command:", error);
        await bot.sendMessage(cid, "An error occurred while fetching the bot list.");
    }
});



bot.onText(/^\/info (\d+)$/, async (msg, match) => {
    const callerId = msg.chat.id.toString();
    await dbServices.updateUserActivity(callerId);
    const targetUserId = match[1];

    if (callerId !== ADMIN_ID) {
        return bot.sendMessage(callerId, "You are not authorized to use this command.");
    }

    try {
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

        // Fetch bots deployed by this user
        const userBots = await dbServices.getUserBots(targetUserId); // Use dbServices
        if (userBots.length > 0) {
            userDetails += `\n*Deployed Bots:*\n`;
            for (const botName of userBots) {
                userDetails += `  - \`${escapeMarkdown(botName)}\`\n`;
            }
        } else {
            userDetails += `\n*Deployed Bots:* None\n`;
        }

        // Fetch user's last seen activity
        const lastSeen = await dbServices.getUserLastSeen(targetUserId); // Use dbServices
        userDetails += `*Last Activity:* ${lastSeen ? new Date(lastSeen).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' }) : 'Never seen (or no recent activity)'}\n`;

        // Check ban status
        const bannedStatus = await dbServices.isUserBanned(targetUserId); // Use dbServices
        userDetails += `*Banned:* ${bannedStatus ? 'Yes' : 'No'}\n`;


        await bot.sendMessage(callerId, userDetails, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error fetching user info for ID ${targetUserId}:`, error.message);

        if (error.response && error.response.body && error.response.body.description) {
            const apiError = error.response.body.description;
            if (apiError.includes("chat not found") || apiError.includes("user not found")) {
                await bot.sendMessage(callerId, `User with ID \`${targetUserId}\` not found or has not interacted with the bot.`);
            } else if (apiError.includes("bot was blocked by the user")) {
                await bot.sendMessage(callerId, `The bot is blocked by user \`${targetUserId}\`. Cannot retrieve info.`);
            } else {
                await bot.sendMessage(callerId, `An unexpected error occurred while fetching info for user \`${targetUserId}\`: ${apiError}`);
            }
        } else {
            console.error(`Full unexpected error object for ID ${targetUserId}:`, JSON.stringify(error, null, 2));
            await bot.sendMessage(callerId, `An unexpected error occurred while fetching info for user \`${targetUserId}\`. Please check server logs for details.`);
        }
    }
});

// New /remove <user_id> command for admin
bot.onText(/^\/remove (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    await dbServices.updateUserActivity(cid);
    const targetUserId = match[1];

    console.log(`[Admin] /remove command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /remove attempt by ${cid}.`);
        return bot.sendMessage(cid, "You are not authorized to use this command.");
    }

    delete userStates[cid]; // Clear user state
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    const userBots = await dbServices.getUserBots(targetUserId); // Use dbServices
    if (!userBots.length) {
        return bot.sendMessage(cid, `User \`${targetUserId}\` has no bots deployed via this system.`, { parse_mode: 'Markdown' });
    }

    console.log(`[Admin] Admin ${cid} initiated /remove for user ${targetUserId}. Prompting for app removal selection.`);

    try {
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

bot.onText(/^\/buytemp$/, async msg => {
    const cid = msg.chat.id.toString();
    const availableNumbers = await pool.query(
        "SELECT masked_number, number FROM temp_numbers WHERE status = 'available' ORDER BY RANDOM() LIMIT 5"
    );

    if (availableNumbers.rows.length === 0) {
        return bot.sendMessage(cid, "Sorry, no temporary numbers are available at the moment.");
    }

    const buttons = availableNumbers.rows.map(row => [{
        text: `Buy ${row.masked_number} for N200`,
        callback_data: `buy_temp_num:${row.number}`
    }]);

    // --- The message text has been updated here ---
    const messageText = "Choose a number to purchase.\n\n" +
                        "**Note:** These are **+48 Poland** numbers and are for **one-time use** to receive a single OTP code.";

    await bot.sendMessage(cid, messageText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
});


// ... other code ...

// --- NEW COMMAND: /sync ---
bot.onText(/^\/sync$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const sentMsg = await bot.sendMessage(cid, 'Starting full database synchronization with Heroku. This may take a moment...');

    try {
        const result = await dbServices.syncDatabaseWithHeroku();
        
        if (result.success) {
            const finalMessage = `
*Synchronization Complete!*
- *Added to Database:* ${result.stats.addedToUserBots} missing apps.
- *Total Heroku Apps now recognized:* The number on Heroku should now match your bot commands.

You can now use /stats or /bapp to see the updated count of all your bots.
            `;
            await bot.editMessageText(finalMessage, {
                chat_id: cid,
                message_id: sentMsg.message_id,
                parse_mode: 'Markdown'
            });
        } else {
            await bot.editMessageText(`Sync failed! Reason: ${result.message}`, {
                chat_id: cid,
                message_id: sentMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    } catch (error) {
        await bot.editMessageText(`An unexpected error occurred during sync: ${error.message}`, {
            chat_id: cid,
            message_id: sentMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
});


// NEW: /askadmin command for users to initiate support
bot.onText(/^\/askadmin (.+)$/, async (msg, match) => {
    const userQuestion = match[1];
    const userChatId = msg.chat.id.toString();
    await dbServices.updateUserActivity(userChatId);
    const userMessageId = msg.message_id;

    if (userChatId === ADMIN_ID) {
        return bot.sendMessage(userChatId, "You are the admin, you cannot ask yourself questions!");
    }

    try {
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

        await bot.sendMessage(userChatId, 'Your question has been sent to the admin. You will be notified when they reply.');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, 'Failed to send your question to the admin. Please try again later.');
    }
});

// Admin command to add a temporary number
// Updated /addnum command handler
bot.onText(/^\/addnum (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    // --- THIS IS THE FIX ---
    // Remove all whitespace (spaces, tabs, etc.) from the input number
    const number = match[1].replace(/\s/g, '');

    // The rest of the validation and logic remains the same
    if (!/^\+\d{10,15}$/.test(number)) {
        return bot.sendMessage(adminId, "Invalid number format. Please use the full international format, e.g., `+48 699 524 995`", { parse_mode: 'Markdown' });
    }

    const maskedNumber = number.slice(0, 6) + '***' + number.slice(-3);

    try {
        await pool.query("INSERT INTO temp_numbers (number, masked_number) VALUES ($1, $2)", [number, maskedNumber]);
        await bot.sendMessage(adminId, `Successfully added number \`${number}\` to the database.`, { parse_mode: 'Markdown' });
    } catch (e) {
        if (e.code === '23505') { 
            return bot.sendMessage(adminId, `⚠️ Number \`${number}\` already exists in the database.`, { parse_mode: 'Markdown' });
        }
        console.error(`Error adding number ${number}:`, e);
        await bot.sendMessage(adminId, `Failed to add number. An error occurred.`);
    }
});


// Admin command to remove a temporary number
bot.onText(/^\/removenum (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }
    
    const number = match[1].trim();
    try {
        const result = await pool.query("DELETE FROM temp_numbers WHERE number = $1", [number]);
        if (result.rowCount > 0) {
            await bot.sendMessage(adminId, `Successfully removed number \`${number}\` from the database.`, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(adminId, `⚠Number \`${number}\` not found in the database.`, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error(`Error removing number ${number}:`, e);
        await bot.sendMessage(adminId, `Failed to remove number. An error occurred.`);
    }
});


// --- REPLACE this entire function in bot.js ---

bot.onText(/^\/stats$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    await dbServices.updateUserActivity(cid);

    try {
        // Active Bot Stats
        const botCountsResult = await pool.query('SELECT bot_type, COUNT(bot_name) as count FROM user_bots GROUP BY bot_type');
        let levanterCount = 0, raganorkCount = 0;
        botCountsResult.rows.forEach(row => {
            if (row.bot_type === 'levanter') levanterCount = parseInt(row.count, 10);
            else if (row.bot_type === 'raganork') raganorkCount = parseInt(row.count, 10);
        });
        const totalUsers = (await pool.query('SELECT COUNT(DISTINCT user_id) AS count FROM user_bots')).rows[0].count;
        const totalBots = levanterCount + raganorkCount;

        // Backup Bot Stats
        const backupCountsResult = await backupPool.query('SELECT bot_type, COUNT(app_name) as count FROM user_deployments GROUP BY bot_type');
        let backupLevanterCount = 0, backupRaganorkCount = 0;
        backupCountsResult.rows.forEach(row => {
            if (row.bot_type === 'levanter') backupLevanterCount = parseInt(row.count, 10);
            else if (row.bot_type === 'raganork') backupRaganorkCount = parseInt(row.count, 10);
        });
        const totalBackupBots = backupLevanterCount + backupRaganorkCount;

        // --- START OF NEW LOGIC: Logged Out Bot Stats ---
        const loggedOutResult = await pool.query(`SELECT bot_name, bot_type FROM user_bots WHERE status = 'logged_out'`);
        const loggedOutBots = loggedOutResult.rows;
        const totalLoggedOut = loggedOutBots.length;

        const loggedOutLevanter = loggedOutBots.filter(b => b.bot_type === 'levanter').map(b => `  - \`${b.bot_name}\``).join('\n');
        const loggedOutRaganork = loggedOutBots.filter(b => b.bot_type === 'raganork').map(b => `  - \`${b.bot_name}\``).join('\n');
        // --- END OF NEW LOGIC ---

        // --- NEW LOGIC: Query for Top Deployers ---
        const topDeployersResult = await pool.query(`
            SELECT user_id, COUNT(bot_name) AS bot_count
            FROM user_bots
            GROUP BY user_id
            ORDER BY bot_count DESC
            LIMIT 5
        `);
        const topDeployers = [];
        for (const row of topDeployersResult.rows) {
            try {
                const chat = await bot.getChat(row.user_id);
                const userName = chat.username ? `@${escapeMarkdown(chat.username)}` : escapeMarkdown(chat.first_name || 'N/A');
                topDeployers.push(`- ${userName} (Bots: ${row.bot_count})`);
            } catch (e) {
                // If bot can't get chat info, fall back to user ID
                topDeployers.push(`- \`${row.user_id}\` (Bots: ${row.bot_count})`);
            }
        }
        const topDeployersList = topDeployers.length > 0 ? topDeployers.join('\n') : 'No users found.';
        // --- END NEW LOGIC ---

        const activeKeys = await dbServices.getAllDeployKeys();
        const keyDetails = activeKeys.length > 0 ? activeKeys.map(k => `\`${k.key}\` (Uses: ${k.uses_left})`).join('\n') : 'No active deploy keys.';
        const totalFreeTrialUsers = (await pool.query('SELECT COUNT(user_id) AS count FROM temp_deploys')).rows[0].count;
        const totalBannedUsers = (await pool.query('SELECT COUNT(user_id) AS count FROM banned_users')).rows[0].count;

        let statsMessage = `
*Bot Statistics:*

*Total Unique Users:* ${totalUsers}
*Total Deployed Bots:* ${totalBots}
  - *Levanter Bots:* ${levanterCount}
  - *Raganork Bots:* ${raganorkCount}

*Total Backup Bots:* ${totalBackupBots}
  - *Levanter Backups:* ${backupLevanterCount}
  - *Raganork Backups:* ${backupRaganorkCount}

*Users Who Used Free Trial:* ${totalFreeTrialUsers}
*Total Banned Users:* ${totalBannedUsers}

*Top Deployers:*
${topDeployersList}

*Active Deploy Keys:*
${keyDetails}
        `;

        // --- Add the new section to the message ---
        if (totalLoggedOut > 0) {
            statsMessage += `\n*Logged Out Bots (${totalLoggedOut}):*\n`;
            if (loggedOutLevanter) {
                statsMessage += `*Levanter:*\n${loggedOutLevanter}\n`;
            }
            if (loggedOutRaganork) {
                statsMessage += `*Raganork:*\n${loggedOutRaganork}\n`;
            }
        }
        
        await bot.sendMessage(cid, statsMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error fetching stats:`, error.message);
        await bot.sendMessage(cid, `An error occurred while fetching stats: ${error.message}`);
    }
});


// Command: /users (Admin only)
bot.onText(/^\/users$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    await dbServices.updateUserActivity(cid);
    
    // Call the helper function to show the first page
    await sendUserListPage(cid, 1);
});

// Helper for the /users command's pagination callback
async function handleUsersPage(query) {
    const pageToGo = parseInt(query.data.split(':')[1], 10);
    await sendUserListPage(query.message.chat.id, pageToGo, query.message.message_id);
}

// Helper function to display the paginated list of users with names
async function sendUserListPage(chatId, page = 1, messageId = null) {
    try {
        const allUsersResult = await pool.query('SELECT DISTINCT user_id FROM user_activity ORDER BY user_id;');
        const allUserIds = allUsersResult.rows.map(row => row.user_id);

        if (allUserIds.length === 0) {
            return bot.sendMessage(chatId, "No users have interacted with the bot yet.");
        }

        const USERS_PER_PAGE = 8;
        const totalPages = Math.ceil(allUserIds.length / USERS_PER_PAGE);
        page = Math.max(1, Math.min(page, totalPages));

        const offset = (page - 1) * USERS_PER_PAGE;
        const userIdsOnPage = allUserIds.slice(offset, offset + USERS_PER_PAGE);

        let responseMessage = `*Registered Users - Page ${page}/${totalPages}*\n\n`;
        for (const userId of userIdsOnPage) {
            try {
                const user = await bot.getChat(userId);
                const isBanned = await dbServices.isUserBanned(userId);
                const fullName = escapeMarkdown(`${user.first_name || ''} ${user.last_name || ''}`.trim());
                responseMessage += `*ID:* \`${userId}\` ${isBanned ? '(Banned)' : ''}\n*Name:* ${fullName || 'N/A'}\n\n`;
            } catch (e) {
                responseMessage += `*ID:* \`${userId}\`\n*Name:* _User not accessible_\n\n`;
            }
        }
        responseMessage += `_Use /info <ID> for full details._`;

        const navRow = [];
        if (page > 1) navRow.push({ text: 'Previous', callback_data: `users_page:${page - 1}` });
        if (page < totalPages) navRow.push({ text: 'Next', callback_data: `users_page:${page + 1}` });

        const options = {
            chat_id: chatId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [navRow] }
        };

        if (messageId) {
            await bot.editMessageText(responseMessage, { ...options, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, responseMessage, options);
        }
    } catch (error) {
        console.error(`Error sending user list page:`, error);
        await bot.sendMessage(chatId, "An error occurred while fetching the user list.");
    }
}



// --- REPLACE your old /bapp command with this one ---
bot.onText(/^\/bapp$/, (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== ADMIN_ID) return;

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Levanter', callback_data: 'bapp_select_type:levanter' },
                    { text: 'Raganork', callback_data: 'bapp_select_type:raganork' }
                ]
            ]
        }
    };
    bot.sendMessage(chatId, 'Which bot type do you want to manage from the backup list?', opts);
});



bot.onText(/^\/send (\d+) ?(.+)?$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    const targetUserId = match[1];
    const caption = match[2] ? match[2].trim() : '';
    const repliedMsg = msg.reply_to_message;

    // --- FIX START: Handle both media and text-only messages ---
    if (repliedMsg) {
        // This is the media fallback system from the previous fix
        const isPhoto = repliedMsg.photo && repliedMsg.photo.length > 0;
        const isVideo = repliedMsg.video;
        const isDocument = repliedMsg.document;
        const baseOptions = { caption: `*Message from Admin:*\n${caption}`, parse_mode: 'Markdown' };

        if (isPhoto || isVideo) {
            try {
                const fileId = isPhoto ? repliedMsg.photo[repliedMsg.photo.length - 1].file_id : repliedMsg.video.file_id;
                const sendMethod = isPhoto ? bot.sendPhoto : bot.sendVideo;
                await sendMethod(targetUserId, fileId, baseOptions);
                return bot.sendMessage(adminId, `Media sent to user \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error(`Failed on Fallback 1 (Photo/Video):`, error.message);
            }
        }

        if (isDocument) {
            try {
                const fileId = repliedMsg.document.file_id;
                await bot.sendDocument(targetUserId, fileId, baseOptions);
                return bot.sendMessage(adminId, `Media sent to user \`${targetUserId}\`. (Sent as a document)`, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error(`Failed on Fallback 2 (Document):`, error.message);
            }
        }

        // Final fallback for media is a text-only message
        const textFallbackMessage = `*Admin Message:*\n${caption}\n\n_Note: The attached media could not be sent due to an unsupported format or error._`;
        await bot.sendMessage(targetUserId, textFallbackMessage, { parse_mode: 'Markdown' });
        await bot.sendMessage(adminId, `⚠Could not send media to user \`${targetUserId}\`. The file format may be unsupported. A text-only message was sent instead.`, { parse_mode: 'Markdown' });

    } else {
        // --- This block handles text-only messages directly from the command ---
        if (!caption) {
            return bot.sendMessage(adminId, "Please provide a message or reply to an image/video to send.");
        }
        try {
            await bot.sendMessage(targetUserId, `*Message from Admin:*\n${caption}`, { parse_mode: 'Markdown' });
            await bot.sendMessage(adminId, `✅ Message sent to user \`${targetUserId}\`.`);
        } catch (error) {
            const escapedError = escapeMarkdown(error.message);
            console.error(`Error sending message to user ${targetUserId}:`, escapedError);
            await bot.sendMessage(adminId, `❌ Failed to send message to user \`${targetUserId}\`: ${escapedError}`, { parse_mode: 'Markdown' });
        }
    }
});



// --- FIX: Updated /sendall command to support text, photos, and videos ---
bot.onText(/^\/sendall ?(.+)?$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }
    
    const caption = match[1] ? match[1].trim() : '';

    const repliedMsg = msg.reply_to_message;
    const isPhoto = repliedMsg && repliedMsg.photo && repliedMsg.photo.length > 0;
    const isVideo = repliedMsg && repliedMsg.video;
    
    if (!isPhoto && !isVideo && !caption) {
         return bot.sendMessage(adminId, "Please provide a message or reply to an image/video to broadcast.");
    }

    await bot.sendMessage(adminId, "Broadcasting message to all users. This may take a while...");

    let successCount = 0;
    let failCount = 0;
    let blockedCount = 0;
    
    // --- THIS IS THE CRITICAL FIX ---
    // Change the table from 'all_users_backup' to 'user_activity'
    const allUserIdsResult = await pool.query('SELECT user_id FROM user_activity');
    // --- END OF FIX ---
    
    const userIds = allUserIdsResult.rows.map(row => row.user_id);
    
    if (userIds.length === 0) {
        return bot.sendMessage(adminId, "No users found in the user_activity table to send messages to.");
    }
    
    const sendMethod = isPhoto ? bot.sendPhoto : isVideo ? bot.sendVideo : bot.sendMessage;
    const fileId = isPhoto ? repliedMsg.photo[repliedMsg.photo.length - 1].file_id : isVideo ? repliedMsg.video.file_id : null;

    for (const userId of userIds) {
        if (userId === adminId) continue;
        
        try {
            if (await dbServices.isUserBanned(userId)) continue;
            
            if (isPhoto || isVideo) {
                await sendMethod(userId, fileId, { caption: `*Message from Admin:*\n${caption}`, parse_mode: 'Markdown' });
            } else {
                await sendMethod(userId, `*Message from Admin:*\n${caption}`, { parse_mode: 'Markdown' });
            }
            
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
            if (error.response?.body?.description.includes("bot was blocked")) {
                blockedCount++;
            } else {
                console.error(`Error sending broadcast to user ${userId}:`, escapeMarkdown(error.message));
                failCount++;
            }
        }
    }
    
    await bot.sendMessage(adminId,
        `Broadcast complete!\n\n` +
        `*Successfully sent:* ${successCount}\n` +
        `*Blocked by user:* ${blockedCount}\n` +
        `*Other failures:* ${failCount}`,
        { parse_mode: 'Markdown' }
    );
});

// ... other code ...


bot.onText(/^\/copydb$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) {
        return; // Admin only
    }

    // Ask for a simple confirmation before proceeding
    await bot.sendMessage(cid, "Are you sure you want to overwrite the backup database (`DATABASE_URL2`) with the current main database (`DATABASE_URL`)? This cannot be undone.", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Yes, proceed with copy", callback_data: 'copydb_confirm_simple' },
                    { text: "Cancel", callback_data: 'copydb_cancel' }
                ]
            ]
        }
    });
});


bot.onText(/^\/backupall$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const sentMsg = await bot.sendMessage(cid, 'Starting backup process for all Heroku apps... This might take some time.');

    try {
        const result = await dbServices.backupAllPaidBots();
        
        let finalMessage;
        if (result.success && result.stats) {
            const { levanter, raganork, unknown } = result.stats;
            const { appsBackedUp, appsFailed } = result.miscStats;

            // Format the lists of app names
            const formatList = (list) => list.length > 0 ? list.map(name => `\`${escapeMarkdown(name)}\``).join('\n  - ') : 'None';
            
            finalMessage = `
*Backup Summary:*

*Total Heroku Apps Scanned:* ${appsBackedUp + appsFailed}
*Total Success:* ${appsBackedUp}
*Total Failed:* ${appsFailed}

*Levanter Bots:*
  - Success: ${levanter.backedUp.length}
  - Failed: ${levanter.failed.length}

*Raganork Bots:*
  - Success: ${raganork.backedUp.length}
  - Failed: ${raganork.failed.length}

*Misc. Bots:*
_The following apps were not found in the local database._
  - **Success:** ${formatList(unknown.backedUp)}
  - **Failed:** ${formatList(unknown.failed)}
            `;
        } else {
            finalMessage = `An unexpected error occurred during the backup process: ${result.message}`;
        }
        
        await bot.editMessageText(finalMessage, {
            chat_id: cid,
            message_id: sentMsg.message_id,
            parse_mode: 'Markdown'
        });
    } catch (error) {
        await bot.editMessageText(`An unexpected error occurred during the backup process: ${error.message}`, {
            chat_id: cid,
            message_id: sentMsg.message_id
        });
    }
});


bot.onText(/^\/revenue$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()).toISOString(); // Added for 3-month total

        const todayResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [todayStart]);
        const weekResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [weekStart]);
        const monthResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [monthStart]);
        const threeMonthsResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [threeMonthsAgo]);
        const allTimeResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments");

        const formatRevenue = (result) => {
            const total = result.rows[0].total || 0;
            const count = result.rows[0].count || 0;
            return `₦${(total / 100).toLocaleString()} (${count} keys)`;
        };

        const revenueMessage = `
*Sales Revenue:*

*Today:* ${formatRevenue(todayResult)}
*This Week:* ${formatRevenue(weekResult)}
*This Month:* ${formatRevenue(monthResult)}
*Last 3 Months:* ${formatRevenue(threeMonthsResult)}
*All Time:* ${formatRevenue(allTimeResult)}
        `;
        
        await bot.sendMessage(cid, revenueMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Error fetching revenue:", error);
        await bot.sendMessage(cid, "An error occurred while calculating revenue.");
    }
});




// NEW ADMIN COMMAND: /ban <user_id>
bot.onText(/^\/ban (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    const targetUserId = match[1];

    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    if (targetUserId === ADMIN_ID) {
        return bot.sendMessage(adminId, "You cannot ban yourself, admin.");
    }

    const isBanned = await dbServices.isUserBanned(targetUserId); // Use dbServices
    if (isBanned) {
        return bot.sendMessage(adminId, `User \`${targetUserId}\` is already banned.`, { parse_mode: 'Markdown' });
    }

    const banned = await dbServices.banUser(targetUserId, adminId); // Use dbServices
    if (banned) {
        await bot.sendMessage(adminId, `User \`${targetUserId}\` has been banned.`, { parse_mode: 'Markdown' });
        try {
            await bot.sendMessage(targetUserId, `You have been banned from using this bot by the admin. All bot functions are now unavailable.`);
        } catch (error) {
            console.warn(`Could not notify banned user ${targetUserId}: ${error.message}`);
        }
    } else {
        await bot.sendMessage(adminId, `Failed to ban user \`${targetUserId}\`. Check logs.`, { parse_mode: 'Markdown' });
    }
});

bot.onText(/^\/findbot (.+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const appName = match[1].trim();

    try {
        const botInfoResult = await pool.query(
    `SELECT ub.user_id, ub.bot_type, ub.status, ud.expiration_date, ud.is_free_trial, ud.deploy_date
     FROM user_bots ub
     LEFT JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
     WHERE ub.bot_name = $1`,
    [appName]
);


        if (botInfoResult.rows.length === 0) {
            return bot.sendMessage(cid, `Sorry, no bot named \`${appName}\` was found in the database.`, { parse_mode: 'Markdown' });
        }

        const botInfo = botInfoResult.rows[0];
        const ownerId = botInfo.user_id;

        // FIX: The ownerDetails string is now fully escaped.
        let ownerDetails = `*Owner ID:* \`${escapeMarkdown(ownerId)}\``;
        try {
            const ownerChat = await bot.getChat(ownerId);
            const ownerName = `${ownerChat.first_name || ''} ${ownerChat.last_name || ''}`.trim();
            ownerDetails += `\n*Owner Name:* ${escapeMarkdown(ownerName)}`;
            if (ownerChat.username) {
                ownerDetails += `\n*Owner Username:* @${escapeMarkdown(ownerChat.username)}`;
            }
        } catch (e) {
            ownerDetails += "\n_Could not fetch owner's Telegram profile._";
        }

        // FIX: The expirationInfo string is now fully escaped.
        let expirationInfo = escapeMarkdown("Not Set");
        if (botInfo.is_free_trial) {
            const deployDate = new Date(botInfo.deploy_date);
            const expirationDate = new Date(deployDate.getTime() + 3 * 24 * 60 * 60 * 1000); // 3 days for free trial
            const now = new Date();
            const timeLeftMs = expirationDate.getTime() - now.getTime();
            const daysLeft = Math.ceil(timeLeftMs / (1000 * 60 * 60 * 24));

            if (daysLeft > 0) {
                expirationInfo = escapeMarkdown(`${daysLeft} days remaining (Free Trial)`);
            } else {
                expirationInfo = escapeMarkdown('Expired (Free Trial)');
            }
        } else if (botInfo.expiration_date) {
            const expiration = new Date(botInfo.expiration_date);
            const now = new Date();
            const daysLeft = Math.ceil((expiration - now) / (1000 * 60 * 60 * 24));
            expirationInfo = escapeMarkdown(daysLeft > 0 ? `${daysLeft} days remaining` : "Expired");
        }


        const botStatus = botInfo.status === 'online' ? 'Online' : 'Logged Out';

        // FIX: The final response string is now fully escaped to prevent errors.
        const response = `
*Bot Details for: \`${escapeMarkdown(appName)}\`*

*Owner Info:*
${ownerDetails}

*Bot Info:*
*Type:* ${escapeMarkdown(botInfo.bot_type ? botInfo.bot_type.toUpperCase() : 'Unknown')}
*Status:* ${escapeMarkdown(botStatus)}
*Expiration:* ${expirationInfo}
        `;

        await bot.sendMessage(cid, response, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error during /findbot for "${appName}":`, error);
        await bot.sendMessage(cid, `An error occurred while searching for the bot.`);
    }
});

// NEW CODE
bot.onText(/^\/unban$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;
    await sendBannedUsersList(adminId);
});

// --- NEW COMMAND: /updateall <botType> ---
bot.onText(/^\/updateall (levanter|raganork)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    const botType = match[1];

    try {
        const allBots = await pool.query('SELECT bot_name FROM user_bots WHERE bot_type = $1', [botType]);
        const botCount = allBots.rows.length;

        if (botCount === 0) {
            return bot.sendMessage(adminId, `No *${botType.toUpperCase()}* bots found in the database to update.`, { parse_mode: 'Markdown' });
        }

        const confirmMessage = `You are about to trigger a mass redeployment for all *${botCount}* *${botType.toUpperCase()}* bots. This will cause a brief downtime for each bot. Do you want to proceed?`;
        
        await bot.sendMessage(adminId, confirmMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Yes, Proceed', callback_data: `confirm_updateall:${botType}` }],
                    [{ text: 'Cancel', callback_data: `cancel_updateall` }]
                ]
            }
        });
    } catch (error) {
        console.error(`Error with /updateall command:`, error.message);
        await bot.sendMessage(adminId, `An error occurred: ${error.message}`, { parse_mode: 'Markdown' });
    }
});



// 10) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();

  // IMPORTANT: Ban check before any other logic for non-admin users
  if (cid !== ADMIN_ID) {
      const banned = await dbServices.isUserBanned(cid); // Use dbServices
      if (banned) {
          console.log(`[Security] Banned user ${cid} attempted to interact with message: "${text}"`);
          return; // Stop processing for banned users
      }
  }

  // --- THIS IS THE CORRECT ORDER ---

    // 1. First, check for data from the Mini App.
  if (msg.web_app_data) {
    // --- THIS IS THE FIX ---
    // You must define 'cid' here so the bot knows who to send the message to.
    const cid = msg.chat.id.toString(); 
    
    const data = JSON.parse(msg.web_app_data.data);
    if (data.status === 'verified') {
        await bot.sendMessage(cid, "Security check passed!\n\n**Final step:** Join our channel and click verify below to receive your free number.", {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Join Our Channel', url: MUST_JOIN_CHANNEL_LINK }],
                    [{ text: 'I have joined, Get My Number!', callback_data: 'verify_join_after_miniapp' }]
                ]
            }
        });
    }
    return; // Stop here after handling the web app data
  }


  // 2. Second, check if it's a regular text message. If not, stop.
  if (!text) return; 

  // --- END OF FIX ---


  // Now the rest of your code for handling text messages will run correctly
  await dbServices.updateUserActivity(cid); 
  await notifyAdminUserOnline(msg); 

  if (isMaintenanceMode && cid !== ADMIN_ID) {
      await bot.sendMessage(cid, "Bot is currently undergoing maintenance. Please check back later.");
      return;
  }

  // ... the rest of your message handler code (if (text === 'More Features'), etc.)


 // Automatic Keyboard Update Check
const userActivity = await pool.query('SELECT keyboard_version FROM user_activity WHERE user_id = $1', [cid]);
if (userActivity.rows.length > 0) {
    const userVersion = userActivity.rows[0].keyboard_version || 0;
    if (userVersion < KEYBOARD_VERSION) {
        await sendLatestKeyboard(cid);
    }
}
  const st = userStates[cid];
  const isAdmin = cid === ADMIN_ID;

  if (isAdmin && st && st.step === 'AWAITING_ADMIN_PAIRING_CODE_INPUT') {
      const pairingCode = text.trim();
      const pairingCodeRegex = /^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/;

      if (!pairingCodeRegex.test(pairingCode)) {
          return bot.sendMessage(cid, 'Invalid pairing code format. Please send a 9-character alphanumeric code with a hyphen (e.g., `ABCD-1234`).');
      }

      const { targetUserId, userWaitingMessageId, userAnimateIntervalId, botType } = st.data; // Get botType from state

      // MODIFICATION 1: Change user's waiting message to "Pairing code available!"
      // Ensure this message is NOT edited back by animateMessage if it's still running
      if (userAnimateIntervalId) {
          clearInterval(userAnimateIntervalId); // Stop the animation for the previous "Admin getting your pairing code..." message
      }
      if (userWaitingMessageId) {
          await bot.editMessageText(`Pairing code available!`, { // Updated message, no emoji, final message
              chat_id: targetUserId,
              message_id: userWaitingMessageId
          }).catch(err => console.error(`Failed to edit user's waiting message to "Pairing code available!": ${err.message}`));
      }
      // END MODIFICATION 1

      try {
          await bot.sendMessage(targetUserId,
              `Your Pairing-code is:\n\n` +
              `\`${pairingCode}\`\n\n` +
              `Tap to Copy the CODE and paste it to your WhatsApp linked device as soon as possible!\n\n` +
              `When you are ready, tap the 'Deploy' button to continue.`,
              { parse_mode: 'Markdown' }
          );
          await bot.sendMessage(cid, `Pairing code sent to user \`${targetUserId}\`. Bot Type: ${botType}.`);

          delete userStates[targetUserId];
          delete userStates[cid];
          console.log(`[Pairing] Pairing code sent by admin to user ${targetUserId}. Admin and user states cleared/updated.`);

      } catch (e) {
          console.error(`Error sending pairing code to user ${targetUserId}:`, e);
          await bot.sendMessage(cid, `Failed to send pairing code to user \`${targetUserId}\`. They might have blocked the bot or the chat no longer exists.`);
      }
      return;
  }

  if (st && st.step === 'AWAITING_OTHER_VAR_VALUE') {
      const { APP_NAME, VAR_NAME, targetUserId: targetUserIdFromState, botType } = st.data; // Get botType from state
      const varValue = text.trim();

      try {
          await bot.sendChatAction(cid, 'typing');
          const updateMsg = await bot.sendMessage(cid, `Updating *${VAR_NAME}* for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

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

          await bot.editMessageText(`Variable *${VAR_NAME}* for "*${APP_NAME}*" updated successfully!`, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'Markdown'
          });
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL_ERROR] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
      } finally {
          delete userStates[cid];
      }
      return;
  }

            // --- FIX: AWAITING_EMAIL_FOR_PAYMENT handler now saves app_name and session_id ---
if (st && st.step === 'AWAITING_EMAIL_FOR_PAYMENT') {
    const email = text.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return bot.sendMessage(cid, "That's not a valid email. Please try again.");
    }

    const sentMsg = await bot.sendMessage(cid, 'Generating payment link...');

    try {
        const reference = crypto.randomBytes(16).toString('hex');
        const priceInKobo = (parseInt(process.env.KEY_PRICE_NGN, 10) || 1500) * 100;

        const isRenewal = st.data.renewal;
        const botTypeToSave = isRenewal ? `renewal_${st.data.appName}` : st.data.botType;

        // FIX: The INSERT query now includes app_name and session_id
        await pool.query(
            'INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [reference, cid, email, botTypeToSave, st.data.APP_NAME, st.data.SESSION_ID]
        );

        // Store the reference ID in the state so the cancel button can use it
        st.data.reference = reference;
        
        const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize', 
            {
                email: email,
                amount: priceInKobo,
                reference: reference,
                metadata: {
                    user_id: cid,
                    product: isRenewal ? `Renewal for ${st.data.appName}` : "New Deploy Key"
                }
            },
            { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
        );

        const paymentUrl = paystackResponse.data.data.authorization_url;
        await bot.editMessageText(
            'Click the button below to complete your payment. Your purchase will be confirmed automatically.',
            {
                chat_id: cid, message_id: sentMsg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Pay Now', url: paymentUrl }],
                        [{ text: 'Cancel', callback_data: 'cancel_payment_and_deploy' }]
                    ]
                }
            }
        );

    } catch (error) {
        console.error("Paystack error:", error.response?.data || error.message);
        await bot.editMessageText('Sorry, an error occurred while creating the payment link.', {
            chat_id: cid, message_id: sentMsg.message_id
        });
    } finally {
      // FIX: The state is no longer deleted here
    }
    return;
}

  

  // --- REPLACE this entire block in bot.js ---

if (st && st.step === 'AWAITING_OTHER_VAR_NAME') {
    // --- FIX: Changed 'APP_NAME' to 'appName' to match the state data ---
    const { appName, targetUserId: targetUserIdFromState } = st.data;
    const varName = text.trim().toUpperCase();

    if (!/^[A-Z0-9_]+$/.test(varName)) {
        return bot.sendMessage(cid, 'Invalid variable name. Please use only uppercase letters, numbers, and underscores.');
    }

    if (varName === 'SUDO') {
        delete userStates[cid];
        await bot.sendMessage(cid, `The *SUDO* variable must be managed using "Add Number" or "Remove Number" options. How do you want to manage it for "*${appName}*"?`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Add Number', callback_data: `sudo_action:add:${appName}` }],
                    [{ text: 'Remove Number', callback_data: `sudo_action:remove:${appName}` }],
                    [{ text: 'Back to Set Variable Menu', callback_data: `setvar:${appName}` }]
                ]
            }
        });
        return;
    }

    try {
        const configRes = await axios.get(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        );
        const existingConfigVars = configRes.data;

        if (existingConfigVars.hasOwnProperty(varName)) {
            userStates[cid].step = 'AWAITING_OVERWRITE_CONFIRMATION';
            userStates[cid].data.VAR_NAME = varName;
            userStates[cid].data.APP_NAME = appName; // Note: This should be appName
            userStates[cid].data.targetUserId = targetUserIdFromState;
            const message = `Variable *${varName}* already exists for "*${appName}*" with value: \`${escapeMarkdown(String(existingConfigVars[varName]))}\`\n\nDo you want to overwrite it?`;
            await bot.sendMessage(cid, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Yes, Overwrite', callback_data: `overwrite_var:yes:${varName}:${appName}` }],
                        [{ text: 'No, Cancel', callback_data: `overwrite_var:no:${varName}:${appName}` }]
                    ]
                }
            });
        } else {
            userStates[cid].step = 'AWAITING_OTHER_VAR_VALUE';
            userStates[cid].data.VAR_NAME = varName;
            userStates[cid].data.APP_NAME = appName; // Note: This should be appName
            userStates[cid].data.targetUserId = targetUserIdFromState;
            const botTypeForOtherVar = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';
            userStates[cid].data.botType = botTypeForOtherVar;
            return bot.sendMessage(cid, `Please enter the value for *${varName}*:`, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[API Call Error] Error checking variable existence for ${appName}:`, errorMsg);
        await bot.sendMessage(cid, `Error checking variable existence: ${escapeMarkdown(errorMsg)}`);
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
          return bot.sendMessage(cid, 'Invalid input. Please enter numbers only, without plus signs or spaces. Example: `2349163916314`');
      }

      try {
          await bot.sendChatAction(cid, 'typing');
          const updateMsg = await bot.sendMessage(cid, `Adding number to SUDO variable for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

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

          await bot.editMessageText(`Number added to SUDO variable for "*${APP_NAME}*" successfully! New value: \`${newSudoValue}\``, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'Markdown'
          });
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL_ERROR] Error updating SUDO variable for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error updating SUDO variable: ${errorMsg}`);
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
        return bot.sendMessage(cid, `Invalid input. Please enter numbers only, without plus signs or spaces. Example: \`2349163916314\` (Attempt ${st.data.attempts} of 3)`);
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
        const updateMsg = await bot.sendMessage(cid, `Attempting to remove number from SUDO for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

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
                return bot.editMessageText(`Number \`${numberToRemove}\` not found in SUDO variable. Too many attempts. Please try again later.`, {
                    chat_id: cid,
                    message_id: updateMsg.message_id,
                    parse_mode: 'Markdown'
                });
            }
            await bot.editMessageText(`Number \`${numberToRemove}\` not found in SUDO variable for "*${APP_NAME}*". No changes made. You have ${3 - st.data.attempts} attempts left.`, {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'Markdown'
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
            await bot.editMessageText(`Number \`${numberToRemove}\` removed from SUDO variable for "*${APP_NAME}*" successfully! New value: \`${newSudoValue}\``, {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'Markdown'
            });
            delete userStates[cid];
        }
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[API_CALL_ERROR] Error removing SUDO number for ${APP_NAME}:`, errorMsg, e.response?.data);
        await bot.sendMessage(cid, `Error removing number from SUDO variable: ${errorMsg}`);
    }
    return;
  }


if (msg.reply_to_message && msg.reply_to_message.from.id.toString() === botId) {
      const repliedToBotMessageId = msg.reply_to_message.message_id;
      const context = forwardingContext[repliedToBotMessageId];

      // Ensure it's the admin replying AND the context matches a support question
      if (isAdmin && context && context.request_type === 'support_question') {
          const { original_user_chat_id, original_user_message_id } = context;
          try {
              await bot.sendMessage(original_user_chat_id, `*Admin replied:*\n${msg.text}`, {
                  parse_mode: 'Markdown',
                  reply_to_message_id: original_user_message_id
              });
              await bot.sendMessage(cid, 'Your reply has been sent to the user.');
              delete forwardingContext[repliedToBotMessageId];
              console.log(`[Forwarding] Stored context for support question reply ${repliedToBotMessageId} cleared.`);
          } catch (e) {
              console.error('Error forwarding admin reply (support question):', e);
              await bot.sendMessage(cid, 'Failed to send your reply to the user. They might have blocked the bot or the chat no longer exists.');
          }
          return;
      }
      console.log(`Received reply to bot message ${repliedToBotMessageId} from ${cid} but not a support question reply or not from admin. Ignoring.`);
      return;
  }

  if (st && st.step === 'AWAITING_ADMIN_QUESTION_TEXT') {
    const userQuestion = msg.text;
    const userChatId = cid;
    const userMessageId = msg.message_id;

    try {
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

        await bot.sendMessage(userChatId, 'Your question has been sent to the admin. You will be notified when they reply.');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, 'Failed to send your question to the admin. Please try again later.');
    } finally {
        delete userStates[cid];
    }
    return;
  }


if (text === 'Deploy' || text === 'Free Trial') {
    const isFreeTrial = (text === 'Free Trial');

    if (isFreeTrial) {
        const check = await dbServices.canDeployFreeTrial(cid);
        if (!check.can) {
            // This part is now updated
            const formattedDate = check.cooldown.toLocaleString('en-US', {
                timeZone: 'Africa/Lagos', // Set for Nigeria
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true
            });
            return bot.sendMessage(cid, `You have already used your Free Trial. You can use it again after: ${formattedDate}\n\nWould you like to start a standard deployment instead?`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Deploy Now', callback_data: 'deploy_first_bot' }]
                    ]
                }
            });
        }

        try { 
            const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, cid);
            const isMember = ['creator', 'administrator', 'member'].includes(member.status);

            if (isMember) {
                userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: true } };
                await bot.sendMessage(cid, 'Thanks for being a channel member! Which bot type would you like to deploy for your free trial?', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Levanter', callback_data: `select_deploy_type:levanter` }],
                            [{ text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }]
                        ]
                    }
                });
            } else {
                await bot.sendMessage(cid, "To access the Free Trial, you must join our channel. This helps us keep you updated!", {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Join Our Channel', url: MUST_JOIN_CHANNEL_LINK }],
                            [{ text: 'I have joined, Verify me!', callback_data: 'verify_join' }]
                        ]
                    }
                });
            }
        } catch (error) { 
            console.error("Error in free trial initial check:", error.message);
            await bot.sendMessage(cid, "An error occurred. Please try again later.");
        }
        return;

    } else { // This is the "Deploy" (paid) flow
        delete userStates[cid];
        userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: false } };
        await bot.sendMessage(cid, 'Which bot type would you like to deploy?', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Levanter', callback_data: `select_deploy_type:levanter` }],
                    [{ text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }]
                ]
            }
        });
        return;
    }
}



  if (text === 'Apps' && isAdmin) {
    return dbServices.sendAppList(cid); // Use dbServices
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

  if (text === 'Get Session ID') {
      delete userStates[cid]; // Clear user state
      userStates[cid] = { step: 'AWAITING_GET_SESSION_BOT_TYPE', data: {} };

      await bot.sendMessage(cid, 'Which bot type do you need a session ID for?', {
          reply_markup: {
              inline_keyboard: [
                  [{ text: 'Levanter', callback_data: `select_get_session_type:levanter` }],
                  [{ text: 'Raganork MD', callback_data: `select_get_session_type:raganork` }]
              ]
          }
      });
      return;
  }

        if (text === 'My Bots') {
    const cid = msg.chat.id.toString();
    const checkingMsg = await bot.sendMessage(cid, 'Checking your bots on the server, please wait...');

    try {
        // 1. Get the list of all bots the user has from the database, not just the active ones
        const dbBotsResult = await pool.query(
            `SELECT 
                ub.bot_name, 
                ub.status, 
                ud.expiration_date,
                ud.deleted_from_heroku_at
             FROM user_bots ub
             LEFT JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
             WHERE ub.user_id = $1`,
            [cid]
        );
        const userBotsFromDb = dbBotsResult.rows;

        if (userBotsFromDb.length === 0) {
            await bot.editMessageText("You have no bots deployed.", {
                chat_id: cid,
                message_id: checkingMsg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }],
                        [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]
                    ]
                }
            });
            return;
        }

        // 2. Verify each bot's status against the Heroku API
        const verificationPromises = userBotsFromDb.map(bot =>
            axios.get(`https://api.heroku.com/apps/${bot.bot_name}`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            }).then(() => ({ ...bot, is_active: true }))
              .catch(error => ({ ...bot, is_active: false, error: error }))
        );

        const results = await Promise.all(verificationPromises);

        const activeBots = [];
        const inactiveBots = [];
        const botsToCleanup = [];

        results.forEach(result => {
            if (result.is_active) {
                activeBots.push(result);
            } else if (result.error && result.error.response && result.error.response.status === 404) {
                // Heroku app not found, mark it for cleanup
                if (!result.deleted_from_heroku_at) {
                    botsToCleanup.push(result.bot_name);
                }
            } else {
                // For any other API error, we assume the bot is currently offline but exists
                inactiveBots.push(result);
            }
        });

        // 3. Mark "ghost" bots as inactive in the database
        if (botsToCleanup.length > 0) {
            console.log(`[Cleanup] Found ${botsToCleanup.length} ghost bots for user ${cid}. Marking as inactive.`);
            await Promise.all(botsToCleanup.map(appName => dbServices.markDeploymentDeletedFromHeroku(cid, appName)));
        }

        const botsToDisplay = activeBots.concat(inactiveBots);

        if (botsToDisplay.length === 0) {
            await bot.editMessageText("It seems your active bots were deleted from Heroku. They have been moved to your restore list.", {
                chat_id: cid,
                message_id: checkingMsg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]
                    ]
                }
            });
            return;
        }

        // 4. Display the list of bots with their status
        const appButtons = botsToDisplay.map(bot => {
            let buttonText = bot.bot_name;
            let statusIndicator = bot.is_active ? '🟢' : '🔴';
            
            if (bot.expiration_date) {
                const expiration = new Date(bot.expiration_date);
                const now = new Date();
                const daysLeft = Math.ceil((expiration - now) / (1000 * 60 * 60 * 24));
                buttonText += daysLeft > 0 ? ` (${daysLeft} days)` : ` (Expired)`;
            }
            
            return { text: `${statusIndicator} ${buttonText}`, callback_data: `selectbot:${bot.bot_name}` };
        });

        const rows = chunkArray(appButtons, 3);
        rows.push([{ text: 'Bot not found? Restore', callback_data: 'restore_from_backup' }]);

        await bot.editMessageText('Your deployed bots:', {
            chat_id: cid,
            message_id: checkingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows }
        });

    } catch (error) {
        console.error("Error in 'My Bots' handler:", error);
        await bot.editMessageText("An error occurred while fetching your bots. Please try again.", {
            chat_id: cid,
            message_id: checkingMsg.message_id
        });
    }
    return;
}

// Add this handler in section 10 (Message handler for buttons & state machine)
if (text === 'Referrals') {
    const userId = msg.chat.id.toString();
    const referralLink = `https://t.me/${botUsername}?start=${userId}`;

    await dbServices.updateUserActivity(userId);

    const referralMessage = `
*Your Referral Dashboard*

Your unique referral link is:
\`${referralLink}\`

Share this link with your friends. When they deploy a bot using your link, you get rewarded!

*Your Rewards:*
- You get *20 days* added to your bot's expiration for each new user you invite.
- You get an extra *7 days* if one of your invited users invites someone new.

_Your referred users will be displayed here once they deploy their first bot._
    `;
    
    // The "Copy to Clipboard" button has been removed for simplicity.
    await bot.sendMessage(userId, referralMessage, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Share', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Deploy your own bot with my referral link!')}` }
                ]
            ]
        }
    });
}




// --- FIX: Add this new handler for the 'Support' button ---
  if (text === 'Support') {
      await dbServices.updateUserActivity(cid);
      if (cid === ADMIN_ID) {
        return bot.sendMessage(cid, "You are the admin, you cannot ask yourself questions!");
      }
      delete userStates[cid]; // Clear user state
      userStates[cid] = { step: 'AWAITING_ADMIN_QUESTION_TEXT', data: {} };
      await bot.sendMessage(cid, 'Please type your question for the admin:');
      return;
  }
  // --- END OF FIX ---
  // Add this block inside bot.on('message', ...)

  if (text === 'More Features') {
    await dbServices.updateUserActivity(cid);
    const moreFeaturesText = "Here are some additional features and services:";

    // Check if the user has already claimed a free trial number
    const trialCheck = await pool.query("SELECT user_id FROM free_trial_numbers WHERE user_id = $1", [cid]);
    const hasUsedTrial = trialCheck.rows.length > 0;

    // --- New Logic Starts Here ---

    // 1. Create a list of all buttons that should be displayed
    const allButtons = [];

    // Conditionally add the free trial button
    if (!hasUsedTrial) {
        allButtons.push({ text: "Get a Free Trial Number", callback_data: 'free_trial_temp_num' });
    }

    // Add all other standard buttons, including the new Referrals button
    allButtons.push(
        { text: "Buy a WhatsApp Acc N200", callback_data: 'buy_whatsapp_account' },
        { text: "Test out my downloader Bot", url: 'https://t.me/tagtgbot' }
    );

    // 2. Arrange the buttons into rows of two
    const keyboardLayout = [];
    for (let i = 0; i < allButtons.length; i += 2) {
        const row = [allButtons[i]]; // Start a new row with the first button
        if (allButtons[i + 1]) {     // Check if a second button exists for this row
            row.push(allButtons[i + 1]);
        }
        keyboardLayout.push(row); // Add the completed row to the final layout
    }
    
    // --- New Logic Ends Here ---

    const moreFeaturesKeyboard = {
        inline_keyboard: keyboardLayout
    };
    
    await bot.sendMessage(cid, moreFeaturesText, { reply_markup: moreFeaturesKeyboard });
    return;
}





  if (text === 'FAQ') {
      // Clear previous state for consistency, but retain message_id if existing for edit
      if (userStates[cid] && userStates[cid].step === 'VIEWING_FAQ') {
          // If already in FAQ, just refresh the current page, no notice
          await sendFaqPage(cid, userStates[cid].faqMessageId, userStates[cid].faqPage || 1); // Use sendFaqPage
      } else {
          // First time opening FAQ
          delete userStates[cid]; // Clear previous general states
          await bot.sendMessage(cid, 'Please note that your bot might go offline temporarily at the end or beginning of every month. We appreciate your patience during these periods.');
          await sendFaqPage(cid, null, 1); // Use sendFaqPage
      }
      return;
  }

  if (st && st.step === 'AWAITING_PHONE_NUMBER') {
    const phoneNumber = text;
    const phoneRegex = /^\+\d{13}$/; // Validates + followed by exactly 13 digits

    if (!phoneRegex.test(phoneNumber)) {
        const errorMessage = 'Invalid format. Please send your WhatsApp number in the full international format (e.g., `+23491630000000`), or use an option below.';
        
        const sessionUrl = (st.data.botType === 'raganork') 
            ? RAGANORK_SESSION_SITE_URL 
            : 'https://levanter-delta.vercel.app/';

        return bot.sendMessage(cid, errorMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Get Session ID', url: sessionUrl },
                        { text: 'Deploy Now', callback_data: 'deploy_first_bot' }
                    ]
                ]
            }
        });
    }

    // This part runs if the phone number format is correct
    const { first_name, last_name, username } = msg.from;
    const userDetails = `User: \`${cid}\` (TG: @${username || first_name || 'N/A'})`;

    const adminMessage = await bot.sendMessage(ADMIN_ID,
        `*Pairing Request from User:*\n` +
        `${userDetails}\n` +
        `*WhatsApp Number:* \`${phoneNumber}\`\n` +
        `*Bot Type Requested:* \`${st.data.botType || 'Unknown'}\`\n\n` +
        `Do you want to accept this pairing request and provide a code?`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Accept Request', callback_data: `pairing_action:accept:${cid}:${st.data.botType}` }],
                    [{ text: 'Decline Request', callback_data: `pairing_action:decline:${cid}:${st.data.botType}` }]
                ]
            }
        }
    );

    const waitingMsg = await bot.sendMessage(cid, `Your request has been sent to the admin. Please wait for the Pairing-code...`);
    const animateIntervalId = await animateMessage(cid, waitingMsg.message_id, 'Waiting for Pairing-code');
    userStates[cid].step = 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN';
    userStates[cid].data.messageId = waitingMsg.message_id;
    userStates[cid].data.animateIntervalId = animateIntervalId;

    const timeoutDuration = 60 * 1000; // 60 seconds
    const timeoutIdForPairing = setTimeout(async () => {
        if (userStates[cid] && userStates[cid].step === 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN') {
            if (userStates[cid].data.animateIntervalId) {
                clearInterval(userStates[cid].data.animateIntervalId);
            }
            if (userStates[cid].data.messageId) {
                let timeoutMessage = 'Pairing request timed out. The admin did not respond in time.';
                if (st.data.botType === 'raganork') {
                    timeoutMessage += ` You can also generate your session ID directly from: ${RAGANORK_SESSION_SITE_URL}`;
                } else {
                    timeoutMessage += ` You can also get your session ID from the website: https://levanter-delta.vercel.app/`;
                }
                await bot.editMessageText(timeoutMessage, {
                    chat_id: cid,
                    message_id: userStates[cid].data.messageId,
                    parse_mode: 'Markdown'
                }).catch(err => console.error(`Failed to edit user's timeout message: ${err.message}`));
            }
            await bot.sendMessage(ADMIN_ID, `Pairing request from user \`${cid}\` timed out.`);
            delete userStates[cid];
        }
    }, timeoutDuration);

    forwardingContext[adminMessage.message_id] = {
        original_user_chat_id: cid,
        original_user_message_id: msg.message_id,
        user_phone_number: phoneNumber,
        request_type: 'pairing_request',
        user_waiting_message_id: waitingMsg.message_id,
        user_animate_interval_id: animateIntervalId,
        timeout_id_for_pairing_request: timeoutIdForPairing,
        bot_type: st.data.botType
    };
    
    return;
}



    // --- FIX: AWAITING_KEY handler now triggers deployment upon success ---
if (st && st.step === 'AWAITING_KEY') {
    const keyAttempt = text.toUpperCase();
    const st = userStates[cid];

    const verificationMsg = await sendAnimatedMessage(cid, 'Verifying key');
    const usesLeft = await dbServices.useDeployKey(keyAttempt, cid);
    
    // --- FIX: AWAITING_KEY invalid key message updated ---
if (usesLeft === null) {
    const price = process.env.KEY_PRICE_NGN || '1500';
    const invalidKeyMessage = `Invalid key. Please try another key or make payment.`;
    
    // Create a new keyboard with the "Make payment" button
    const invalidKeyKeyboard = {
        inline_keyboard: [
            [{ text: `Make payment (₦${price})`, callback_data: 'buy_key_for_deploy' }]
        ]
    };

    await bot.editMessageText(invalidKeyMessage, {
      chat_id: cid,
      message_id: verificationMsg.message_id,
      reply_markup: invalidKeyKeyboard
    });
    return;
}

    
    // Key is valid. Now trigger the deployment with the previously saved data.
    await bot.editMessageText('Key verified! Initiating deployment...', { chat_id: cid, message_id: verificationMsg.message_id });

    // --- START ADMIN NOTIFICATION ---
    const { first_name, last_name, username } = msg.from;
    const userFullName = [first_name, last_name].filter(Boolean).join(' ');
    const userNameDisplay = username ? `@${escapeMarkdown(username)}` : 'N/A';
    await bot.sendMessage(ADMIN_ID,
        `*Key Used By:*\n` +
        `*Name:* ${escapeMarkdown(userFullName || 'N/A')}\n` +
        `*Username:* ${userNameDisplay}\n` +
        `*Chat ID:* \`${escapeMarkdown(cid)}\`\n\n` +
        `*Key Used:* \`${escapeMarkdown(keyAttempt)}\`\n` +
        `*Uses Left:* ${usesLeft}`,
        { parse_mode: 'Markdown' }
    );
    // --- END ADMIN NOTIFICATION ---

    const deploymentData = st.data;
    delete userStates[cid]; // Clear state before deployment
    await dbServices.buildWithProgress(cid, deploymentData, false, false, deploymentData.botType);
    return;
}



 if (st && st.step === 'SESSION_ID') {
    const sessionID = text.trim();
    const botType = st.data.botType;

    let isValidSession = false;
  
    if (botType === 'levanter') {
        if (sessionID.startsWith(LEVANTER_SESSION_PREFIX) && sessionID.length >= 10) {
            isValidSession = true;
        }
    } else if (botType === 'raganork') {
        if (sessionID.startsWith(RAGANORK_SESSION_PREFIX) && sessionID.length >= 10) {
            isValidSession = true;
        }
    }

    if (!isValidSession) {
        // This is the updated logic to send an error with a button
        let botName = botType.charAt(0).toUpperCase() + botType.slice(1);
        let errorMessage = `Incorrect session ID. Your *${botName}* session ID is not valid. Please input the correct one`;
        let sessionUrl = (botType === 'raganork') ? RAGANORK_SESSION_SITE_URL : 'https://levanter-delta.vercel.app/';
        
        return bot.sendMessage(cid, errorMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Get Session ID', url: sessionUrl }]]
            }
        });
    }

    // This part runs if the session was valid
    st.data.SESSION_ID = sessionID;
    st.step = 'AWAITING_APP_NAME';
    return bot.sendMessage(cid, 'Great. Now enter a unique name for your bot (e.g., mybot123):');
}


// Now, replace it with this single, comprehensive handler.
if (st && st.step === 'AWAITING_APP_NAME') {
    const appName = text.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');

    // Validate app name format. Heroku app names can only contain lowercase letters, numbers, and dashes.
    if (!/^[a-z0-9-]{3,30}$/.test(appName)) {
        // Send a new message asking for the name again, possibly with a hint.
        await bot.sendMessage(cid, 'Invalid app name. It must be between 3 and 30 characters and only contain lowercase letters, numbers, and dashes.');
        // Don't change the state, just wait for a new valid input.
        return;
    }

    try {
        // Check if the app name is already taken on Heroku.
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        // If the request succeeds, the app exists.
        await bot.sendMessage(cid, 'That app name is already taken. Please try another one:');
        return;
    } catch (e) {
        // A 404 error is expected and means the app name is available.
        if (e.response?.status !== 404) {
            console.error(`[Heroku Check] Error checking app name existence for ${appName}:`, e.message);
            await bot.sendMessage(cid, 'An error occurred while checking the app name. Please try again later.');
            return;
        }
    }

    // App name is valid and available. Proceed to the next step.
    st.data.APP_NAME = appName;
    st.step = 'AWAITING_AUTO_STATUS_CHOICE';

    const confirmationMessage = `*Next Step:*\n` +
                                `Enable automatic status view?`;
    
    await bot.sendMessage(cid, confirmationMessage, {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Yes', callback_data: `set_auto_status_choice:true` }],
                [{ text: 'No', callback_data: `set_auto_status_choice:false` }]
            ]
        },
        parse_mode: 'Markdown'
    });
    return;
}

// ... existing code ...





  if (st && st.step === 'SETVAR_ENTER_VALUE') { // This state is reached after variable selection or overwrite confirmation
    const { APP_NAME, VAR_NAME, botType } = st.data; // Get botType from state
    const newVal = text.trim();

    if (VAR_NAME === 'SESSION_ID') {
        let isValidSession = false;
        let requiredPrefix = '';
        let errorMessage = 'Incorrect session ID.';

        // Allow empty string to clear session ID
        if (newVal === '') {
            isValidSession = true;
        } else if (botType === 'levanter') {
            requiredPrefix = LEVANTER_SESSION_PREFIX;
            if (newVal.startsWith(requiredPrefix) && newVal.length >= 10) {
                isValidSession = true;
            }
            errorMessage += ` Your session ID must start with \`${requiredPrefix}\` and be at least 10 characters long, or be empty to clear.`;
        } else if (botType === 'raganork') {
            requiredPrefix = RAGANORK_SESSION_PREFIX;
            if (newVal.startsWith(requiredPrefix) && newVal.length >= 10) {
                isValidSession = true;
            }
            errorMessage += ` Your Raganork session ID must start with \`${requiredPrefix}\` and be at least 10 characters long, or be empty to clear.`;
        } else {
            errorMessage = 'Unknown bot type in state. Please start the variable update process again.';
        }

        if (!isValidSession) {
            return bot.sendMessage(cid, errorMessage, { parse_mode: 'Markdown' });
        }
    }


    try {
      await bot.sendChatAction(cid, 'typing');
      const updateMsg = await bot.sendMessage(cid, `Updating *${VAR_NAME}* for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

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
          await dbServices.addUserBot(cid, APP_NAME, newVal, botType); // Use dbServices, pass botType
      }
      
      // NEW: Update config_vars in user_deployments backup
      // This logic needs to retrieve the full config and then save.
      const herokuConfigVars = (await axios.get( // Fetch latest config vars
          `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
      )).data;
      // Save/Update to user_deployments with original deploy date logic (deploy_date and expiration_date are NOT touched on update)
      await dbServices.saveUserDeployment(cid, APP_NAME, herokuConfigVars.SESSION_ID, herokuConfigVars, botType); // Use dbServices, pass botType


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

          await bot.editMessageText(
            `Your bot is now live!`,
            { chat_id: cid, message_id: updateMsg.message_id }
          );
          console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${APP_NAME}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${APP_NAME} after variable update:`, err.message);
          await bot.editMessageText(
              `Bot "${APP_NAME}" failed to come online after variable "${VAR_NAME}" update: ${err.message}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
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
      console.error(`[API_CALL_ERROR] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data);
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
  }
});

// 11) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const dataParts = q.data ? q.data.split(':') : [];
  const action = dataParts[0];
  const payload = dataParts[1];
  const extra = dataParts[2];
  const flag = dataParts[3];
  const st = userStates[cid];
  // IMPORTANT: Ban check before any other logic for non-admin users
  if (cid !== ADMIN_ID) {
      const banned = await dbServices.isUserBanned(cid); // Use dbServices
      if (banned) {
          console.log(`[Security] Banned user ${cid} attempted callback query: "${q.data}"`);
          await bot.answerCallbackQuery(q.id, { text: "You are currently banned from using this bot.", showAlert: true });
          return; // Stop processing for banned users
      }
  }

  await bot.answerCallbackQuery(q.id).catch(() => {});
  await dbServices.updateUserActivity(cid); // Update user activity on any callback query
  await notifyAdminUserOnline(q); // Call notifyAdminUserOnline for callback queries

  console.log(`[CallbackQuery] Received: action=${action}, payload=${payload}, extra=${extra}, flag=${flag} from ${cid}`);
  console.log(`[CallbackQuery] Current state for ${cid}:`, userStates[cid]);

  // --- ADD this block inside your bot.on('callback_query', ...) handler ---

if (action === 'bapp_select_type') {
    const botTypeToManage = payload;
    // Call the sendBappList function with the selected filter
    await sendBappList(cid, q.message.message_id, botTypeToManage);
}


  if (action === 'faq_page') {
      const page = parseInt(payload);
      const messageId = q.message.message_id; // Use message ID from the callback query
      await sendFaqPage(cid, messageId, page); // Use sendFaqPage
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
          reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
      }).catch(err => {
          console.error(`Error editing message back to main menu: ${err.message}. Sending new menu.`, err);
          bot.sendMessage(cid, 'Returning to main menu.', {
              reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
          });
      });
      return;
  }

// --- ADD these handlers and REMOVE the old copydb ones ---

if (action === 'copydb_confirm_simple') {
    await bot.editMessageText('Copying main database to backup... This may take a moment.', {
        chat_id: cid,
        message_id: q.message.message_id
    });

    try {
        // Directly call syncDatabases with main pool as source and backup pool as target
        const result = await dbServices.syncDatabases(pool, backupPool); 
        if (result.success) {
            await bot.editMessageText(`Copy Complete! ${result.message}`, {
                chat_id: cid,
                message_id: q.message.message_id
            });
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        await bot.editMessageText(`Copy Failed! Reason: ${error.message}`, {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }
    return;
}
        
if (action === 'copydb_cancel') {
    await bot.editMessageText('Database copy cancelled.', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}


// ===================================================================
if (action === 'users_page') {
    const newPage = parseInt(payload, 10);
    await sendUserListPage(q.message.chat.id, newPage, q.message.message_id);
    return;
}

  // ... inside bot.on('callback_query', ...)
// --- FIX: Refactored select_deploy_type to ask for Session ID first ---
if (action === 'select_deploy_type') {
    const botType = payload;
    const st = userStates[cid];

    if (!st || st.step !== 'AWAITING_BOT_TYPE_SELECTION') {
        return bot.editMessageText('This session has expired. Please start the deployment process again.', { chat_id: cid, message_id: q.message.message_id });
    }
      
    st.data.botType = botType;

    // The flow now always goes to SESSION_ID first, regardless of free trial status.
    st.step = 'SESSION_ID';
    
    let botName = botType.charAt(0).toUpperCase() + botType.slice(1);
    let sessionUrl = (botType === 'raganork') ? RAGANORK_SESSION_SITE_URL : 'https://levanter-delta.vercel.app/';

    // Send a message asking for the session ID. The key step comes later.
    await bot.editMessageText(
        `You've selected *${botName}*. Please send your session id.`,
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Get Session ID for ${botName}`, url: sessionUrl }]
                ]
            }
        }
    );
    return;
}



          if (action === 'buy_key') {
        if (!st || !st.data.botType) {
            return bot.answerCallbackQuery(q.id, { text: "Session expired. Please start the deployment process again.", show_alert: true });
        }
        userStates[cid] = { step: 'AWAITING_EMAIL_FOR_PAYMENT', data: { botType: st.data.botType } };
        await bot.editMessageText('To proceed with the payment, please enter your email address:', {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }



// --- FIX 2: REPLACE this block to remove the extra nested code ---

if (action === 'verify_join') {
    const userId = q.from.id;
    const messageId = q.message.message_id;

    try {
        const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, userId);
        const isMember = ['creator', 'administrator', 'member'].includes(member.status);

        if (isMember) {
            const { first_name, username } = q.from;
            const userIdentifier = username ? `@${username}` : first_name;
            bot.sendMessage(ADMIN_ID, `User ${escapeMarkdown(userIdentifier)} (\`${userId}\`) has joined the channel for a free trial.`, { parse_mode: 'Markdown' });

            await bot.answerCallbackQuery(q.id);

            await bot.editMessageText('Verification successful!', {
                chat_id: cid,
                message_id: messageId
            });

            await new Promise(resolve => setTimeout(resolve, 1500)); 
            
            delete userStates[cid];
            userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: true } };

            await bot.editMessageText('Great! Which bot type would you like to deploy for your free trial?', {
                chat_id: cid,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Levanter', callback_data: `select_deploy_type:levanter` }],
                        [{ text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }]
                    ]
                }
            });

        } else {
            await bot.answerCallbackQuery(q.id); 

            await bot.editMessageText("You must join our channel to proceed. Please join and then tap 'Verify' again.", {
                chat_id: cid,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Join Our Channel', url: MUST_JOIN_CHANNEL_LINK }],
                        [{ text: 'I have joined, Verify me!', callback_data: 'verify_join' }]
                    ]
                }
            });
        }
    } catch (error) {
        console.error("Error verifying channel membership:", error.message);
        await bot.answerCallbackQuery(q.id, {
            text: "Could not verify membership. Please contact an admin.",
            show_alert: true
        });
        await bot.sendMessage(ADMIN_ID, `Error checking channel membership for channel ID ${MUST_JOIN_CHANNEL_ID}. Ensure the bot is an admin in this channel. Error: ${error.message}`);
    }
    return;
}

      if (action === 'start_deploy_after_payment') {
        const botType = payload; // Get the botType we saved in the callback_data
        
        // Set the state correctly to continue the deployment flow
        userStates[cid] = { 
            step: 'AWAITING_KEY', 
            data: { 
                botType: botType,
                isFreeTrial: false 
            } 
        };
        
        // Send a NEW message asking for the key
        await bot.sendMessage(cid, `You chose *${botType.toUpperCase()}*.\n\nPlease enter the Deploy Key you just received:`, {
            parse_mode: 'Markdown'
        });
        return;
    }


  if (action === 'deploy_first_bot') { // Handled by select_deploy_type now
      const isAdmin = cid === ADMIN_ID;
      delete userStates[cid]; // Clear previous state
      userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: false } }; // Go to bot type selection

      await bot.editMessageText('Which bot type would you like to deploy?', {
          chat_id: cid,
          message_id: q.message.message_id,
          reply_markup: {
              inline_keyboard: [
                  [{ text: 'Levanter', callback_data: `select_deploy_type:levanter` }],
                  [{ text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }]
              ]
          }
      });
      return;
  }

  // --- NEW: Callback handler for the 'Edit' button ---
if (action === 'edit_deployment_start_over') {
    delete userStates[cid]; // Clear the state entirely
    const botType = st.data.botType;
    const sessionUrl = (botType === 'raganork') ? RAGANORK_SESSION_SITE_URL : 'https://levanter-delta.vercel.app/';

    userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: st.data.isFreeTrial, botType: botType } };

    await bot.editMessageText(
        'Okay, let\'s start over. Please get your session ID from the link below and send it here.',
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Get Session ID for ${botType.toUpperCase()}`, url: sessionUrl }]
                ]
            }
        }
    );
    return;
}

// AROUND LINE 2400 in bot.js

// --- FIX: This block now handles auto status choice and then moves to final confirmation ---
if (action === 'set_auto_status_choice') {
    const st = userStates[cid];
    const autoStatusChoice = payload;
    if (!st || st.step !== 'AWAITING_AUTO_STATUS_CHOICE') return;

    // --- THIS IS THE FIX ---
    if (st.data.botType === 'levanter') {
      st.data.AUTO_STATUS_VIEW = autoStatusChoice === 'true' ? 'no-dl' : 'false';
    } else if (st.data.botType === 'raganork') {
      st.data.AUTO_STATUS_VIEW = autoStatusChoice; // Sets to 'true' or 'false'
    }
    // --- END OF FIX ---

    st.step = 'AWAITING_FINAL_CONFIRMATION'; // <-- NEW STATE ORDER

    const confirmationMessage = `*Review Deployment Details:*\n\n` +
                                `*Bot Type:* \`${st.data.botType.toUpperCase()}\`\n` +
                                `*Session ID:* \`${escapeMarkdown(st.data.SESSION_ID.slice(0, 15))}...\`\n` +
                                `*App Name:* \`${escapeMarkdown(st.data.APP_NAME)}\`\n` +
                                `*Auto Status View:* \`${st.data.AUTO_STATUS_VIEW}\`\n\n` +
                                `Tap 'Confirm' to continue.`;
    
    await bot.editMessageText(confirmationMessage, {
        chat_id: cid,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Confirm', callback_data: `confirm_and_pay_step` }],
                [{ text: 'Edit (Start Over)', callback_data: `edit_deployment_start_over` }]
            ]
        },
        parse_mode: 'Markdown'
    });
    return;
}




  if (action === 'restore_from_backup') { // Handle Restore button click
    const userDeployments = await dbServices.getUserDeploymentsForRestore(cid); // Use dbServices
    
    // Filter out bots that are already active on Heroku (deleted_from_heroku_at IS NULL)
    // and those whose original 45-day expiration has passed
    const now = new Date();
    const restorableDeployments = userDeployments.filter(dep => {
        const isCurrentlyActive = dep.deleted_from_heroku_at === null; // Must not be active
        const hasExpired = dep.expiration_date && new Date(dep.expiration_date) <= now; // Must not have expired

        // Also check if deploy_date is null or missing, it implies it's a very old record not correctly saved
        const hasDeployDate = dep.deploy_date !== null && dep.deploy_date !== undefined;

        return !isCurrentlyActive && hasDeployDate && !hasExpired; // Only show if not currently deployed, has a deploy date, and not expired
    });


    if (restorableDeployments.length === 0) {
        return bot.editMessageText('No restorable backups found for your account. Please deploy a new bot.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }

    const restoreOptions = restorableDeployments.map(dep => {
        const deployDate = new Date(dep.deploy_date).toLocaleDateString();
        // Calculate remaining time from original deploy date
        const originalExpirationDate = new Date(new Date(dep.deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.ceil((originalExpirationDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        let expirationText = '';
        if (daysLeft > 0) {
            expirationText = ` (Expires in ${daysLeft} days)`;
        } else {
            expirationText = ` (Expired on ${originalExpirationDate.toLocaleDateString()})`;
        }


        return [{
            text: `${dep.app_name} (${dep.bot_type ? dep.bot_type.toUpperCase() : 'Unknown'}) - Deployed: ${deployDate}${expirationText}`,
            callback_data: `select_restore_app:${dep.app_name}`
        }];
    });

    await bot.editMessageText('Select a bot to restore:', {
        chat_id: cid,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: restoreOptions
        }
    });
    return;
  }
// Add these new `if` blocks inside your bot.on('callback_query', ...) handler

if (action === 'dkey_select') {
    const keyToDelete = payload;
    await bot.editMessageText(
        `Are you sure you want to permanently delete the key \`${keyToDelete}\`?`,
        {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "Yes, Delete Now", callback_data: `dkey_confirm:${keyToDelete}` },
                        { text: "No, Cancel", callback_data: `dkey_cancel` }
                    ]
                ]
            }
        }
    );
    return;
}

if (action === 'dkey_confirm') {
    const keyToDelete = payload;
    const success = await dbServices.deleteDeployKey(keyToDelete);
    if (success) {
        await bot.answerCallbackQuery(q.id, { text: `Key ${keyToDelete} deleted.` });
    } else {
        await bot.answerCallbackQuery(q.id, { text: `Failed to delete key ${keyToDelete}.`, show_alert: true });
    }
    // Refresh the list
    await sendKeyDeletionList(q.message.chat.id, q.message.message_id);
    return;
}

if (action === 'dkey_cancel') {
    // Just go back to the list
    await sendKeyDeletionList(q.message.chat.id, q.message.message_id);
    return;
}


  if (action === 'select_bapp') {
    const appName = payload;
    const appUserId = extra;
    const messageId = q.message.message_id;

    await bot.editMessageText(`Verifying *${escapeMarkdown(appName)}* on Heroku and fetching details...`, {
        chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
    }).catch(()=>{});

    let herokuStatus = '';
    let isAppActive = false;
    try {
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        herokuStatus = '🟢 Currently on Heroku';
        isAppActive = true;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            herokuStatus = '🔴 Deleted from Heroku';
            isAppActive = false;
        } else {
            herokuStatus = '⚪ Unknown (API Error)';
            isAppActive = false;
        }
    }

    const dbResult = await pool.query(
        `SELECT * FROM user_deployments WHERE app_name = $1 AND user_id = $2;`,
        [appName, appUserId]
    );

    if (dbResult.rows.length === 0) {
        return bot.editMessageText(`Record for "*${escapeMarkdown(appName)}*" not found in the database.`, {
            chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
        });
    }
    const deployment = dbResult.rows[0];

    // Build the action buttons based on status
    const actionButtons = [];
    if (isAppActive) {
        actionButtons.push([{ text: 'App is Active', callback_data: 'no_action' }]);
    } else {
        actionButtons.push([{ text: 'Restore App', callback_data: `restore_from_bapp:${appName}:${appUserId}` }]);
    }
    actionButtons.push(
        [{ text: 'Delete From Database', callback_data: `delete_bapp:${appName}:${appUserId}` }],
        [{ text: 'Back to List', callback_data: `back_to_bapp_list:${deployment.bot_type}` }]
    );

    let userDisplay = `\`${escapeMarkdown(deployment.user_id)}\``;
    try {
        const targetChat = await bot.getChat(deployment.user_id);
        userDisplay = `${escapeMarkdown(targetChat.first_name || '')} (@${escapeMarkdown(targetChat.username || 'N/A')})`;
    } catch (e) { /* ignore */ }

    const deployDateDisplay = new Date(deployment.deploy_date).toLocaleString('en-US', { timeZone: 'Africa/Lagos' });

    const detailMessage = `
*App Details:*

*App Name:* \`${escapeMarkdown(appName)}\`
*Bot Type:* ${deployment.bot_type ? deployment.bot_type.toUpperCase() : 'Unknown'}
*Owner:* ${userDisplay}
*Deployed On:* ${deployDateDisplay}
*Heroku Status:* ${herokuStatus}
    `;

    await bot.editMessageText(detailMessage, {
        chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: actionButtons }
    });
    return;
}



      if (action === 'set_expiration') {
        const appName = payload;
        const st = userStates[cid];

        if (!st || st.step !== 'AWAITING_APP_FOR_EXPIRATION') {
            return bot.editMessageText("This session has expired. Please use the /expire command again.", {
                chat_id: cid,
                message_id: q.message.message_id
            });
        }

        const days = st.data.days;
        try {
            const ownerIdResult = await pool.query('SELECT user_id FROM user_bots WHERE bot_name = $1', [appName]);
            if (ownerIdResult.rows.length === 0) {
                throw new Error(`Could not find owner for ${appName}`);
            }
            const ownerId = ownerIdResult.rows[0].user_id;

            // Use a parameterized query to safely add the interval
            const result = await pool.query(
                `UPDATE user_deployments SET expiration_date = NOW() + ($1 * INTERVAL '1 day') WHERE app_name = $2 AND user_id = $3`,
                [days, appName, ownerId]
            );

            if (result.rowCount > 0) {
                await bot.editMessageText(`Success! Expiration for *${escapeMarkdown(appName)}* has been set to *${days} days* from now.`, {
                    chat_id: cid,
                    message_id: q.message.message_id,
                    parse_mode: 'Markdown'
                });
            } else {
                 await bot.editMessageText(`Could not find *${escapeMarkdown(appName)}* in the deployments table to update.`, {
                    chat_id: cid,
                    message_id: q.message.message_id,
                    parse_mode: 'Markdown'
                });
            }

        } catch (error) {
            console.error(`Error setting expiration for ${appName}:`, error);
            await bot.editMessageText(`An error occurred while updating the expiration date. Please check the logs.`, {
                chat_id: cid,
                message_id: q.message.message_id
            });
        } finally {
            delete userStates[cid];
        }
        return;
    }

  // --- FIX: Refactored confirm_updateall to use an editable progress message ---
if (action === 'confirm_updateall') {
    const adminId = q.message.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const botType = payload;
    const messageId = q.message.message_id;
    let progressMessage = `Starting mass redeployment for all *${botType.toUpperCase()}* bots...`;
    
    // Send an initial message to be edited later
    const progressMsg = await bot.editMessageText(progressMessage, {
        chat_id: adminId,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    try {
        const allBots = await pool.query('SELECT bot_name FROM user_bots WHERE bot_type = $1', [botType]);
        const botsToUpdate = allBots.rows.map(row => row.bot_name);
        const botCount = botsToUpdate.length;
        
        let progressLog = [];

        for (const [index, appName] of botsToUpdate.entries()) {
            let status = '...';
            let statusEmoji = '⏳';
            let messageToLog = '';

            // Update progress message with current bot
            progressMessage = `*Progress:* ${index + 1}/${botCount}\n`;
            progressMessage += `*Current Bot:* \`${escapeMarkdown(appName)}\`\n\n`;
            progressMessage += `*Log:*\n${progressLog.slice(-5).join('\n')}\n`; // Show last 5 logs

            await bot.editMessageText(progressMessage, {
                chat_id: adminId,
                message_id: progressMsg.message_id,
                parse_mode: 'Markdown'
            }).catch(() => {});

            try {
                const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
                await axios.post(
                    `https://api.heroku.com/apps/${appName}/builds`,
                    { source_blob: { url: `${githubRepoUrl}/tarball/main` } },
                    { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
                );
                statusEmoji = '✅';
                messageToLog = `${statusEmoji} Redeploy triggered for \`${escapeMarkdown(appName)}\`.`;
            } catch (error) {
                if (error.response?.status === 404) {
                    statusEmoji = '❌';
                    messageToLog = `${statusEmoji} App \`${escapeMarkdown(appName)}\` not found on Heroku. Skipping...`;
                    await dbServices.handleAppNotFoundAndCleanDb(adminId, appName, null, false);
                } else {
                    statusEmoji = '❌';
                    const errorMsg = escapeMarkdown(error.response?.data?.message || error.message);
                    messageToLog = `${statusEmoji} Failed for \`${escapeMarkdown(appName)}\`: ${errorMsg}. Skipping...`;
                }
            }
            
            progressLog.push(messageToLog);

            // Add a final log entry for the current bot to the message
            progressMessage = `*Progress:* ${index + 1}/${botCount}\n`;
            progressMessage += `*Current Bot:* \`${escapeMarkdown(appName)}\`\n\n`;
            progressMessage += `*Log:*\n${progressLog.slice(-5).join('\n')}\n`;
            if (index < botCount - 1) {
                progressMessage += `\nWaiting 30 seconds before next bot...`;
            }

            await bot.editMessageText(progressMessage, {
                chat_id: adminId,
                message_id: progressMsg.message_id,
                parse_mode: 'Markdown'
            }).catch(() => {});

            if (index < botCount - 1) {
                await new Promise(r => setTimeout(r, 30000)); // 30-second delay
            }
        }

        // Final message with a summary
        const finalMessage = `Mass redeployment complete! Processed ${botCount} bots.`;
        await bot.editMessageText(finalMessage, {
            chat_id: adminId,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error(`Error confirming /updateall:`, error.message);
        await bot.editMessageText(`An error occurred during mass redeployment: ${escapeMarkdown(error.message)}`, {
            chat_id: adminId,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
}



  if (action === 'restore_from_backup') {
    const checkingMsg = await bot.editMessageText('Checking for restorable apps...', { chat_id: cid, message_id: q.message.message_id });
    
    const userDeployments = await dbServices.getUserDeploymentsForRestore(cid);
    
    // Filter out bots that are active on Heroku or have expired.
    const restorableDeployments = [];
    const now = new Date();
    
    for (const dep of userDeployments) {
        // First check if the original 45-day period has expired.
        const originalExpirationDate = new Date(new Date(dep.deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000);
        if (originalExpirationDate <= now) {
             // Expired, permanently delete it from the backup table and skip.
             await dbServices.deleteUserDeploymentFromBackup(cid, dep.app_name);
             continue;
        }

        try {
            // Now check if it is active on Heroku.
            await axios.get(`https://api.heroku.com/apps/${dep.app_name}`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            });
            // If the request succeeds, it's active, so we skip it.
        } catch (e) {
            // A 404 means the app is not on Heroku, so it's restorable.
            if (e.response && e.response.status === 404) {
                restorableDeployments.push(dep);
            } else {
                console.error(`[Restore] Error checking Heroku status for ${dep.app_name}: ${e.message}`);
            }
        }
    }

    if (restorableDeployments.length === 0) {
        return bot.editMessageText('No restorable backups found for your account. Please deploy a new bot.', {
            chat_id: cid,
            message_id: checkingMsg.message_id
        });
    }

    const restoreOptions = restorableDeployments.map(dep => {
        const deployDate = new Date(dep.deploy_date).toLocaleDateString();
        const originalExpirationDate = new Date(new Date(dep.deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.ceil((originalExpirationDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const expirationText = daysLeft > 0 ? ` (Expires in ${daysLeft} days)` : ` (Expired)`;
        
        return [{
            text: `${dep.app_name} (${dep.bot_type ? dep.bot_type.toUpperCase() : 'Unknown'}) - Deployed: ${deployDate}${expirationText}`,
            callback_data: `select_restore_app:${dep.app_name}`
        }];
    });

    await bot.editMessageText('Select a bot to restore:', {
        chat_id: cid,
        message_id: checkingMsg.message_id,
        reply_markup: {
            inline_keyboard: restoreOptions
        }
    });
    return;
}


// ... (existing code in bot.on('callback_query', async q => { ... })) ...

  if (action === 'restore_from_bapp') {
      const appName = payload;
      const appUserId = extra; // Owner of the app
      const messageId = q.message.message_id;

      await bot.editMessageText(`Preparing to restore "*${escapeMarkdown(appName)}*" for user \`${escapeMarkdown(appUserId)}\`...`, { // Added preliminary message
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown'
      }).catch(err => console.warn(`Failed to edit message with preliminary restore text: ${err.message}`));

      let selectedDeployment;
      try {
          const result = await pool.query(
              `SELECT user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at
               FROM user_deployments WHERE app_name = $1 AND user_id = $2;`,
              [appName, appUserId]
          );
          selectedDeployment = result.rows[0];
      } catch (e) {
          console.error(`DB Error fetching backup deployment for restore ${appName} (${appUserId}):`, e.message);
          return bot.editMessageText(`Error preparing restore for "*${escapeMarkdown(appName)}*": ${escapeMarkdown(e.message)}.`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }

      if (!selectedDeployment) {
          console.warn(`Backup for ${appName} for user ${appUserId} not found during restore attempt.`);
          return bot.editMessageText(`Backup for "*${escapeMarkdown(appName)}*" not found for restore. It might have been deleted or expired.`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }

      const now = new Date();
      // Recalculate fixed expiration from deploy_date for consistency
      const originalExpirationDate = new Date(new Date(selectedDeployment.deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000);
      if (originalExpirationDate <= now) {
          // If expired, try to delete from backup table and notify
          await dbServices.deleteUserDeploymentFromBackup(appUserId, appName).catch(err => console.error(`Error deleting expired backup ${appName}: ${err.message}`));
          return bot.editMessageText(`Cannot restore "*${escapeMarkdown(appName)}*". Its original 45-day deployment period has expired. It has been removed from backup list.`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }

      // Determine the default env vars for the bot type being restored
      const botTypeToRestore = selectedDeployment.bot_type || 'levanter';
      const defaultVarsForRestore = (botTypeToRestore === 'raganork' ? raganorkDefaultEnvVars : levanterDefaultEnvVars) || {};

      const combinedVarsForRestore = {
          ...defaultVarsForRestore,    // Apply type-specific defaults first
          ...selectedDeployment.config_vars, // Overlay with the saved config vars (these take precedence)
          APP_NAME: selectedDeployment.app_name, // Ensure APP_NAME is always correct
          SESSION_ID: selectedDeployment.session_id // Explicitly ensure saved SESSION_ID is used
      };

      await bot.editMessageText(`Attempting to restore and deploy "*${escapeMarkdown(appName)}*" for user \`${escapeMarkdown(appUserId)}\`... This may take a few minutes.`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown'
      });
      // Call buildWithProgress with isRestore flag and the original botType
      await dbServices.buildWithProgress(appUserId, combinedVarsForRestore, false, true, botTypeToRestore); // IMPORTANT: Use appUserId as target chatId for build

      // The buildWithProgress function itself will update the message upon success/failure.
      // No explicit return here, as buildWithProgress takes over the message flow.
      // Ensure buildWithProgress always updates the message.
      // If you need immediate feedback before buildWithProgress, it's done by the first editMessageText.
      return; // Ensure this function exits
  }

  if (action === 'delete_bapp') {
    const appName = payload;
    const appUserId = extra; // Owner of the app
    const messageId = q.message.message_id;

    // Confirmation step for deleting from backup database
    await bot.editMessageText(`Are you sure you want to PERMANENTLY delete backup for "*${escapeMarkdown(appName)}*" (User ID: \`${escapeMarkdown(appUserId)}\`) from the backup database? This cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Yes, Delete Backup', callback_data: `confirm_delete_bapp:${appName}:${appUserId}` }],
                [{ text: 'No, Cancel', callback_data: `select_bapp:${appName}:${appUserId}` }] // Go back to app details
            ]
        }
    });
    return; // Ensure this function exits
  }

  // --- FIX: This block replaces the invalid bot.onCallbackQuery call ---
if (action === 'confirm_delete_bapp') {
    const appName = payload;
    const appUserId = extra;

    await bot.editMessageText(`Permanently deleting all database records for "*${escapeMarkdown(appName)}*"...`, {
        chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
    }).catch(()=>{});

    try {
        // Call the new, more thorough delete function
        const deleted = await dbServices.permanentlyDeleteBotRecord(appUserId, appName);
        
        if (deleted) {
            await bot.answerCallbackQuery(q.id, { text: `All records for ${appName} deleted.`, show_alert: true });
            await bot.editMessageText(`All database records for "*${escapeMarkdown(appName)}*" have been permanently deleted.`, {
                chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });
        } else {
            await bot.editMessageText(`Could not find records for "*${escapeMarkdown(appName)}*" to delete. It may have already been removed.`, {
                 chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });
        }
    } catch (e) {
        await bot.editMessageText(`Failed to delete records for "*${escapeMarkdown(appName)}*": ${escapeMarkdown(e.message)}`, {
            chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
        });
    }
    return;
}



// --- REPLACE your old 'back_to_bapp_list' logic with this ---

if (action === 'back_to_bapp_list') {
    const opts = {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Levanter', callback_data: 'bapp_select_type:levanter' },
                    { text: 'Raganork', callback_data: 'bapp_select_type:raganork' }
                ]
            ]
        }
    };
    await bot.editMessageText('Which bot type do you want to manage from the backup list?', opts);
    return; 
}

  
  
  if (action === 'Referrals') {
    // FIX 1: Get user and message details from the 'query' object, not 'msg'.
    // The 'query' object is what you get from a button press.
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    // This creates the referral link using the user's ID.
    // I've added "ref_" to make your referral links distinct.
    const referralLink = `https://t.me/${botUsername}?start=ref_${userId}`;

    await dbServices.updateUserActivity(userId);

    const referralMessage = `
*Your Referral Dashboard*

Your unique referral link is:
\`${referralLink}\`

Share this link with your friends. When they use your link, you get rewarded!

*Your Rewards:*
- You get *20 days* added to your bot's expiration for each new user you invite.
- You get an extra *7 days* if one of your invited users invites someone new.

_Your referred users will be displayed here once they join._
    `;

    try {
        // FIX 2: Acknowledge the button press to stop the loading animation.
        await bot.answerCallbackQuery(query.id);

        // FIX 3: Edit the original message instead of sending a new one.
        await bot.editMessageText(referralMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        // This share button is well-written, no changes needed here.
                        { text: 'Share Your Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Check out this bot!')}` }
                    ],
                    [
                        // Add a "Back" button for better navigation
                        { text: '« Back to More Features', callback_data: 'more_features_menu' }
                    ]
                ]
            }
        });

    } catch (error) {
        // This catch block prevents the bot from crashing if it can't edit the message
        // (e.g., if the message is too old).
        console.error("Error editing message for referrals:", error);
    }
}

// --- REPLACE this entire block ---

if (action === 'select_get_session_type') {
    const botType = payload;
    const st = userStates[cid];

    if (!st || st.step !== 'AWAITING_GET_SESSION_BOT_TYPE') {
        await bot.editMessageText('This session request has expired. Please start over by tapping "Get Session ID".', {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid];
        return;
    }

    st.data.botType = botType;

    if (botType === 'raganork') {
        await bot.editMessageText(`You chose *Raganork MD*. Please use the button below to generate your session ID.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Get Session', url: RAGANORK_SESSION_SITE_URL }],
                    [{ text: 'Deploy Now', callback_data: 'deploy_first_bot' }]
                ]
            }
        });
        delete userStates[cid];
        return;
    } else { // This is the new Levanter flow
        const levanterUrl = 'https://levanter-delta.vercel.app/';
        await bot.editMessageText('You chose Levanter, please use the button below to get your session id.', {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Get Session ID', url: levanterUrl },
                        { text: "Can't get session?", callback_data: 'levanter_wa_fallback' }
                    ],
                    [
                        { text: 'Deploy Now', callback_data: 'deploy_first_bot' }
                    ]
                ]
            }
        });
        return;
    }
}

  // Add this new handler inside bot.on('callback_query', ...)
if (action === 'apply_referral_reward') {
    const inviterId = q.from.id.toString();
    const botToUpdate = payload;
    const referredUserId = extra;
    const isSecondLevel = flag === 'second_level';
    const rewardDays = isSecondLevel ? 7 : 20;

    await bot.editMessageText(`Applying your *${rewardDays}-day* reward to bot "*${escapeMarkdown(botToUpdate)}*"...`, {
        chat_id: inviterId,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        await pool.query(
            `UPDATE user_deployments SET expiration_date = expiration_date + INTERVAL '${rewardDays} days'
             WHERE user_id = $1 AND app_name = $2 AND expiration_date IS NOT NULL`,
            [inviterId, botToUpdate]
        );

        // Mark the reward as applied in the user_referrals table
        await pool.query(
            `UPDATE user_referrals SET inviter_reward_pending = FALSE WHERE referred_user_id = $1`,
            [referredUserId]
        );

        await bot.editMessageText(`Success! A *${rewardDays}-day extension* has been added to your bot "*${escapeMarkdown(botToUpdate)}*".`, {
            chat_id: inviterId,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

    } catch (e) {
        console.error(`Error applying referral reward to bot ${botToUpdate} for user ${inviterId}:`, e);
        await bot.editMessageText(`Failed to apply the reward to your bot "*${escapeMarkdown(botToUpdate)}*". Please contact support.`, {
            chat_id: inviterId,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    }
}

// Add this inside bot.on('callback_query', async q => { ... })

  if (action === 'buy_whatsapp_account') {
    try {
      // Check if the user already has an assigned number
      const result = await pool.query(
        "SELECT number FROM temp_numbers WHERE user_id = $1 AND status = 'assigned'", 
        [cid]
      );

      if (result.rows.length > 0) {
        // If they have a number, inform them
        const userNumber = result.rows[0].number;
        await bot.sendMessage(cid, `You already have an active number: <code>${userNumber}</code>\n\nYou can check it anytime with the /mynum command.`, { parse_mode: 'HTML' });
      } else {
        // If they don't have a number, tell them how to buy one
        await bot.sendMessage(cid, "You don't have an active number yet. Please use the /buytemp command to purchase one.");
      }
    } catch (error) {
      console.error("Error checking for user's temp number:", error);
      await bot.sendMessage(cid, "Sorry, an error occurred. Please try again later.");
    }
    return;
  }
  

  // --- NEW: Handler for using a suggested app name ---
if (action === 'use_suggested_name') {
    const appName = payload;
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_NAME') return;
    
    st.data.APP_NAME = appName;
    st.step = 'AWAITING_AUTO_STATUS_CHOICE';

    const confirmationMessage = `*Next Step:*\n` +
                                `Enable automatic status view?`;
    
    await bot.editMessageText(confirmationMessage, {
        chat_id: cid,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Yes', callback_data: `set_auto_status_choice:true` }],
                [{ text: 'No', callback_data: `set_auto_status_choice:false` }]
            ]
        },
        parse_mode: 'Markdown'
    });
    return;
}


  // --- ADD this new block ---

if (action === 'levanter_wa_fallback') {
    // 1. Set the state to wait for the user's phone number.
    // This will trigger your existing logic when the user sends their number.
    userStates[cid] = {
        step: 'AWAITING_PHONE_NUMBER',
        data: {
            botType: 'levanter'
        }
    };

    // 2. Acknowledge the button press
    await bot.answerCallbackQuery(q.id);
    
    // 3. Edit the message to ask for the number and remove the old buttons.
    await bot.editMessageText(
        'Okay, please send your WhatsApp number now in the full international format (e.g., `+23491630000000`).', 
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        }
    );
    
    return;
}

  // Add this inside bot.on('callback_query', ...)
if (action === 'verify_join_after_miniapp') {
    const userId = q.from.id.toString();
    const cid = q.message.chat.id.toString();

    try {
        // 1. Check if user is pre-verified
        const preVerifiedCheck = await pool.query("SELECT ip_address FROM pre_verified_users WHERE user_id = $1", [userId]);
        if (preVerifiedCheck.rows.length === 0) {
            await bot.answerCallbackQuery(q.id, { text: "You must complete the security check first.", show_alert: true });
            return;
        }
        const userIpAddress = preVerifiedCheck.rows[0].ip_address;

        // 2. Check if user is in the channel
        const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, userId);
        if (!['creator', 'administrator', 'member'].includes(member.status)) {
            await bot.answerCallbackQuery(q.id, { text: "You haven't joined the channel yet.", show_alert: true });
            return;
        }

        // All checks passed, assign the number
        const numberResult = await pool.query("SELECT number FROM temp_numbers WHERE status = 'available' ORDER BY RANDOM() LIMIT 1");
        if (numberResult.rows.length === 0) {
            await bot.editMessageText("Sorry, no free trial numbers are available right now.", { chat_id: cid, message_id: q.message.message_id });
            return;
        }
        const freeNumber = numberResult.rows[0].number;

        // Use a transaction to finalize
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("UPDATE temp_numbers SET status = 'assigned', user_id = $1, assigned_at = NOW() WHERE number = $2", [userId, freeNumber]);
            await client.query("INSERT INTO free_trial_numbers (user_id, number_used, ip_address) VALUES ($1, $2, $3)", [userId, freeNumber, userIpAddress]);
            await client.query("DELETE FROM pre_verified_users WHERE user_id = $1", [userId]); // Clean up
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        await bot.editMessageText(`All steps complete! Your free trial number is: <code>${freeNumber}</code>`, { chat_id: cid, message_id: q.message.message_id, parse_mode: 'HTML' });
        await bot.sendMessage(userId, 'OTP will be send automaticallyif detected.');
        await bot.sendMessage(ADMIN_ID, `User \`${userId}\` (IP: ${userIpAddress}) has claimed a free trial number: \`${freeNumber}\``, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error("Error during final verification:", error);
        await bot.answerCallbackQuery(q.id, { text: "An error occurred.", show_alert: true });
    }
    return;
}

  // Add this inside bot.on('callback_query', async q => { ... })

  if (action === 'verify_join_temp_num') {
    const userId = q.from.id;
    // The cid variable was missing, which would cause an error later.
    const cid = q.message.chat.id.toString();

    try {
        const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, userId);
        const isMember = ['creator', 'administrator', 'member'].includes(member.status);

        if (isMember) {
            // This code runs if the user IS a member
            const numberResult = await pool.query(
                "SELECT number FROM temp_numbers WHERE status = 'available' ORDER BY RANDOM() LIMIT 1"
            );

            if (numberResult.rows.length === 0) {
                await bot.editMessageText("Sorry, no free trial numbers are available right now. Please check back later.", {
                    chat_id: cid,
                    message_id: q.message.message_id
                });
                return;
            }

            const freeNumber = numberResult.rows[0].number;
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query("UPDATE temp_numbers SET status = 'assigned', user_id = $1, assigned_at = NOW() WHERE number = $2", [userId, freeNumber]);
                await client.query("INSERT INTO free_trial_numbers (user_id, number_used) VALUES ($1, $2)", [userId, freeNumber]);
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }

            await bot.editMessageText(`Verification successful! Your free trial number is: <code>${freeNumber}</code>`, {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'HTML'
            });
            await bot.sendMessage(userId, 'OTP will send automatically if detected.');
            await bot.sendMessage(ADMIN_ID, `User \`${userId}\` has claimed a free trial number: \`${freeNumber}\``, { parse_mode: 'Markdown' });

        } else {
            // --- THIS IS THE FIX ---
            // User is not in the channel. Send the alert and immediately stop the function.
            await bot.answerCallbackQuery(q.id, { text: "You haven't joined the channel yet. Please join and try again.", show_alert: true });
            return; // <-- This crucial line stops the code from continuing.
        }
    } catch (error) {
        console.error("Error during free trial number verification:", error);
        await bot.answerCallbackQuery(q.id, { text: "An error occurred during verification. Please try again.", show_alert: true });
    }
    return;
}


// Add this code block with your other "if (action === ...)" handlers

if (action === 'free_trial_temp_num') {
    const userId = q.from.id.toString();
    const cid = q.message.chat.id.toString();

    // Check if the APP_URL is configured, which is essential for the Mini App
    if (!process.env.APP_URL) {
        console.error("CRITICAL: APP_URL environment variable is not set. Cannot launch Mini App.");
        await bot.answerCallbackQuery(q.id, { text: "Error: The verification service is currently unavailable.", show_alert: true });
        return;
    }
    
    try {
        // Check if the user has already claimed a trial
        const trialUserCheck = await pool.query("SELECT user_id FROM free_trial_numbers WHERE user_id = $1", [userId]);
        if (trialUserCheck.rows.length > 0) {
            await bot.answerCallbackQuery(q.id, { text: "You have already claimed your one-time free trial number.", show_alert: true });
            return;
        }

        // If the user is eligible, prepare to launch the Mini App
        const verificationUrl = `${process.env.APP_URL}/verify`;

        // This line sets the state before the Mini App is launched.
        userStates[cid] = { step: 'AWAITING_MINI_APP_VERIFICATION' };

        await bot.editMessageText("Please complete the security check in the window below to begin the verification process.", {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Start Security Check', web_app: { url: verificationUrl } }]
                ]
            }
        });

    } catch (error) {
        console.error("Error during free trial eligibility check:", error);
        await bot.answerCallbackQuery(q.id, { text: "An error occurred. Please try again.", show_alert: true });
    }
    return;
}



  
// Replace this block inside bot.on('callback_query', ...)

if (action === 'buy_temp_num') {
    const cid = q.message.chat.id.toString();
    const number = payload; // This is the full number

    // Check if the number is still available
    const numberCheck = await pool.query("SELECT status FROM temp_numbers WHERE number = $1", [number]);
    if (numberCheck.rows.length === 0 || numberCheck.rows[0].status !== 'available') {
        await bot.editMessageText('Sorry, this number is no longer available.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }
    
    // --- THIS IS THE UPDATED MESSAGE ---
    const message = `
*Important Instructions:*

1.  This is a Poland (**+48**) number. Ensure you select Poland as the country in WhatsApp.
2.  Request the verification code **only via Gmail**. Do not request an SMS code.
3.  Do not use this number to start new chats to avoid bans. It's best for joining groups or replying to messages.
`;
    // --- END OF UPDATED MESSAGE ---

    // Send the instructions message first
    await bot.sendMessage(cid, message, { parse_mode: 'Markdown' });

    // Generate a unique payment reference
    const reference = crypto.randomBytes(16).toString('hex');
    const priceInKobo = 200 * 100; // N200 in kobo

    try {
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: 'customer@email.com', // Replace with the user's actual email
                amount: priceInKobo,
                reference: reference,
                metadata: {
                    user_id: cid,
                    product: 'temporary_number',
                    phone_number: number
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const paymentUrl = paystackResponse.data.data.authorization_url;

        // Edit the original message to show the payment button after the instructions
        await bot.editMessageText('Please click the button below to complete your payment.', {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Pay Now', url: paymentUrl }]
                ]
            }
        });
        
        // Update the number's status to pending payment
        await pool.query("UPDATE temp_numbers SET status = 'pending_payment', user_id = $1, assigned_at = NOW() WHERE number = $2", [cid, number]);

    } catch (error) {
        console.error('Paystack transaction failed:', error.response?.data || error.message);
        await bot.editMessageText('Sorry, an error occurred while creating the payment link. Please try again later.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }
}



  if (action === 'ask_admin_question') {
      delete userStates[cid]; // Clear user state
      userStates[cid] = { step: 'AWAITING_ADMIN_QUESTION_TEXT', data: {} };
      await bot.sendMessage(cid, 'Please type your question for the admin:');
      return;
  }

  if (action === 'pairing_action') {
      if (cid !== ADMIN_ID) {
          await bot.sendMessage(cid, "You are not authorized to perform this action.");
          return;
      }

      const decision = payload;
      const targetUserChatId = extra;
      const botTypeFromContext = flag; // Get botType from flag

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
      // const { isFreeTrial, isAdminDeploy, botType } = userStateForTargetUser?.data || {}; // Bot type now from context flag

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
                  isFreeTrial: context.isFreeTrial, // Use isFreeTrial from forwarding context
                  isAdminDeploy: context.isAdminDeploy, // Use isAdminDeploy from forwarding context
                  botType: botTypeFromContext // Store bot type in state for admin to use
              }
          };

          let sessionGeneratorLink = '';
          if (botTypeFromContext === 'raganork') {
              sessionGeneratorLink = `\n[Session ID Generator for Raganork](${RAGANORK_SESSION_SITE_URL})`;
          } else { // Levanter
              sessionGeneratorLink = `\n[Session ID Generator for Levanter](https://levanter-delta.vercel.app/)`;
          }

          await bot.sendMessage(ADMIN_ID,
              `*Pairing Request from User:*\n` +
              `User ID: \`${targetUserChatId}\` (Phone: \`${context.user_phone_number}\`).\n` +
              `Bot Type Requested: \`${botTypeFromContext.toUpperCase()}\`\n\n` +
              `*Please send the pairing code for this user now* (e.g., \`ABCD-1234\`).${sessionGeneratorLink}`,
              { parse_mode: 'Markdown' }
          );

          if (userMessageId) {
            await bot.editMessageText(`Admin accepted! Please wait while the admin gets your pairing code...`, {
                chat_id: targetUserChatId,
                message_id: userMessageId
            });
          }


          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
              chat_id: cid,
              message_id: adminMessageId
          }).catch(() => {});
          await bot.editMessageText(q.message.text + `\n\n_Status: Accepted. Admin needs to send code directly._`, {
              chat_id: cid,
              message_id: adminMessageId,
              parse_mode: 'Markdown'
          }).catch(() => {});


      } else {
          await bot.sendMessage(targetUserChatId, 'Your pairing code request was declined by the admin. Please contact support if you have questions.');
          await bot.sendMessage(ADMIN_ID, `Pairing request from user \`${targetUserChatId}\` declined.`);

          delete userStates[targetUserChatId]; // Clear user state
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

  if (action === 'renew_bot') {
        const appName = payload;
        const renewalPrice = process.env.KEY_PRICE_NGN || '1500';

        userStates[cid] = { 
            step: 'AWAITING_EMAIL_FOR_PAYMENT', 
            data: { 
                renewal: true, 
                appName: appName 
            } 
        };

        await bot.editMessageText(
            `You are about to renew *${appName}* for another 45 days for *₦${renewalPrice}*.\n\nPlease enter your email address to proceed.`,
            {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'Markdown',
                // --- ADDED THIS KEYBOARD ---
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Back to Manage Menu', callback_data: `selectapp:${appName}` }]
                    ]
                }
            }
        );
        return;
    }



  if (action === 'setup') {
      const st = userStates[cid];
      // Check if state is valid and message ID matches the one being edited
      if (!st || st.step !== 'AWAITING_WIZARD_CHOICE' || q.message.message_id !== st.message_id) {
          await bot.editMessageText('This menu has expired. Please start over by tapping /menu.', {
              chat_id: cid,
              message_id: q.message.message_id
          });
          delete userStates[cid]; // Clear invalid state
          return;
      }

      const [step, value] = [payload, extra];

      if (step === 'autostatus') {
          st.data.AUTO_STATUS_VIEW = value === 'true' ? 'no-dl' : 'false';

          const confirmationText = ` *Deployment Configuration*\n\n` +
                                   `*App Name:* \`${st.data.APP_NAME}\`\n` +
                                   `*Session ID:* \`${st.data.SESSION_ID.slice(0, 15)}...\`\n` +
                                   `*Bot Type:* \`${st.data.botType.toUpperCase()}\`\n` + // Display bot type
                                   `*Auto Status:* \`${st.data.AUTO_STATUS_VIEW}\`\n\n` +
                                   `Ready to proceed?`;

          const confirmationKeyboard = {
              reply_markup: {
                  inline_keyboard: [
                      [
                          { text: 'Confirm & Deploy', callback_data: `setup:startbuild` }, // Changed button text
                          { text: 'Cancel', callback_data: `setup:cancel` }
                      ]
                  ]
              }
          };

          await bot.editMessageText(confirmationText, {
              chat_id: cid,
              message_id: st.message_id,
              parse_mode: 'Markdown',
              ...confirmationKeyboard
          });
      }

      if (step === 'startbuild') {
          await bot.editMessageText('Configuration confirmed. Initiating deployment...', {
              chat_id: cid,
              message_id: st.message_id
          });
          delete userStates[cid]; // Clear user state before starting build
          // Pass botType to buildWithProgress
          await dbServices.buildWithProgress(cid, st.data, st.data.isFreeTrial, false, st.data.botType); // Use dbServices
      }

      if (step === 'cancel') {
          await bot.editMessageText('Deployment cancelled.', {
              chat_id: cid,
              message_id: q.message.message_id
          });
          delete userStates[cid]; // Clear user state
      }
      return;
  }


  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await dbServices.addDeployKey(key, uses, cid); // Use dbServices
    // Clear the message with uses selection after generating key
    await bot.editMessageText(`Generated key: \`${key}\`\nUses: ${uses}`, {
      chat_id: cid,
      message_id: q.message.message_id,
      parse_mode: 'Markdown'
    }).catch(() => {});
    return;
  }

/// --- FIX: This block now bypasses key/payment for admin ---
if (action === 'confirm_and_pay_step') {
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_FINAL_CONFIRMATION') return;

    const price = process.env.KEY_PRICE_NGN || '1500';
    const isFreeTrial = st.data.isFreeTrial;
    const isAdmin = cid === ADMIN_ID; // <-- CHECK IF USER IS ADMIN

    // --- New, consolidated logic ---
    if (isFreeTrial || isAdmin) { // <-- ADDED isAdmin CHECK
        await bot.editMessageText('Initiating deployment...', { chat_id: cid, message_id: q.message.message_id });
        delete userStates[cid];
        // The isAdmin deployment is not a free trial
        await dbServices.buildWithProgress(cid, st.data, isFreeTrial, false, st.data.botType);
    } else {
        st.step = 'AWAITING_KEY';
        await bot.editMessageText('Enter your Deploy key:', {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Make payment (₦${price})`, callback_data: 'buy_key_for_deploy' }, { text: 'Cancel', callback_data: 'cancel_payment_and_deploy' }]
                ]
            }
        });
    }
    return;
}

// --- FIX: New callbacks to handle key entry or payment ---

// --- FIX: Awaiting key handler now includes a payment button ---
if (action === 'deploy_with_key') {
    const isFreeTrialFromCallback = payload === 'free_trial';
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_KEY_OR_PAYMENT') return;

    // For paid deployments, ask for the key with a payment option.
    if (!isFreeTrialFromCallback) {
        st.step = 'AWAITING_KEY';
        const price = process.env.KEY_PRICE_NGN || '1500';
        await bot.editMessageText('Enter your Deploy key:', {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Make payment (₦${price})`, callback_data: 'buy_key_for_deploy' }]
                ]
            }
        });
    } else {
        // For free trials, trigger the deployment directly.
        await bot.editMessageText('Initiating Free Trial deployment...', { chat_id: cid, message_id: q.message.message_id });
        delete userStates[cid];
        await dbServices.buildWithProgress(cid, st.data, true, false, st.data.botType);
    }
    return;
}


// --- FIX: Corrected state check for the buy_key_for_deploy callback ---
if (action === 'buy_key_for_deploy') {
    const st = userStates[cid];
    // This state check is now corrected to match the AWAITING_KEY state
    if (!st || st.step !== 'AWAITING_KEY') return;

    // Save all collected data into the state
    st.step = 'AWAITING_EMAIL_FOR_PAYMENT';
    st.data.emailBotType = st.data.botType;
    st.data.deploySessionId = st.data.SESSION_ID; // Stored session ID
    st.data.deployAppName = st.data.APP_NAME; // Stored app name
    
    await bot.editMessageText('To proceed with the payment, please enter your email address:', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}

// --- NEW: Handler for the 'Cancel' button on the payment screen ---
if (action === 'cancel_payment_and_deploy') {
    const st = userStates[cid];
    if (!st) return;

    // Delete the pending payment record if it exists
    if (st.data && st.data.reference) {
        try {
            await pool.query('DELETE FROM pending_payments WHERE reference = $1', [st.data.reference]);
            console.log(`[Payment] Canceled pending payment with reference: ${st.data.reference}`);
        } catch (error) {
            console.error(`Error deleting pending payment:`, error.message);
        }
    }

    delete userStates[cid]; // Clear the state to cancel the deployment flow
    await bot.editMessageText('Deployment process canceled.', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}



     if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    const messageId = q.message.message_id;
    const appName = payload;

    userStates[cid] = { step: 'APP_MANAGEMENT', data: { appName: appName, messageId: messageId, isUserBot: isUserBot } };

    await bot.sendChatAction(cid, 'typing');
    
    // Fetch bot details to check expiration date
    const botDetails = (await pool.query(
        `SELECT expiration_date FROM user_deployments WHERE user_id = $1 AND app_name = $2`,
        [cid, appName]
    )).rows[0];

    const keyboard = [
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
      // --- THIS ROW WAS ADDED BACK ---
      [{ text: 'Backup', callback_data: `backup_app:${appName}` }],
    ];

    // Conditionally add the "Renew" button to the first row
    if (botDetails && botDetails.expiration_date) {
        const expirationDate = new Date(botDetails.expiration_date);
        const now = new Date();
        const daysLeft = Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24));

        if (daysLeft <= 7) {
            keyboard[0].splice(2, 0, { text: 'Renew (45 Days)', callback_data: `renew_bot:${appName}` });
        }
    }
    
    keyboard.push([{ text: 'Back', callback_data: 'back_to_app_list' }]);

    return bot.editMessageText(`Manage app "*${appName}*":`, {
      chat_id: cid,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  }

// ... (existing code within bot.on('callback_query', async q => { ... })) ...

  if (action === 'backup_app') { // Handle Backup button click
    const appName = payload;
    const messageId = q.message.message_id;
    const cid = q.message.chat.id.toString(); // Ensure cid is defined here

    await bot.editMessageText(`Checking backup status for "*${escapeMarkdown(appName)}*"...`, { // Preliminary message
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    }).catch(err => console.warn(`Failed to edit message with preliminary backup text: ${err.message}`));

    try {
        // --- NEW: Check if already backed up and active on Heroku ---
        const existingBackup = await pool.query(
            `SELECT deleted_from_heroku_at FROM user_deployments WHERE user_id = $1 AND app_name = $2;`,
            [cid, appName] // Query by user_id and app_name
        );

        // If a record exists AND deleted_from_heroku_at is NULL, it means it's currently backed up and active.
        if (existingBackup.rows.length > 0 && existingBackup.rows[0].deleted_from_heroku_at === null) {
            return bot.editMessageText(`App "*${escapeMarkdown(appName)}*" is already backed up and currently active.`, {
                chat_id: cid,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
                }
            });
        }
        // --- END NEW CHECK ---

        // Proceed with actual backup. If it was previously marked as deleted, saveUserDeployment will update it.
        const appVars = (await axios.get(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        )).data;
        const currentSessionId = appVars.SESSION_ID; // Assuming SESSION_ID is important for restore
        const botTypeResult = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter'; // Get bot type from main DB


        if (!currentSessionId) {
            return bot.editMessageText(`Cannot backup "*${escapeMarkdown(appName)}*": No SESSION_ID found. Please set it first.`, {
                chat_id: cid,
                message_id: messageId,
                parse_mode: 'Markdown'
            });
        }
        // Save/Update to user_deployments. deploy_date & expiration_date are preserved on conflict.
        // saveUserDeployment will also set deleted_from_heroku_at to NULL, marking it as active/backed-up.
        await dbServices.saveUserDeployment(cid, appName, currentSessionId, appVars, botTypeResult); // Use dbServices

        await bot.editMessageText(`App "*${escapeMarkdown(appName)}*" successfully backed up! You can restore it later if needed.`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        await bot.editMessageText(`❌ Failed to backup app "*${escapeMarkdown(appName)}*": ${escapeMarkdown(errorMsg)}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    }
    return; // Ensure this function exits cleanly
  }


      if (action === 'add_assign_app') {
    const appName = payload;
    const targetUserId = extra;

    if (cid !== ADMIN_ID) {
        return bot.editMessageText("You are not authorized for this action.", { chat_id: cid, message_id: q.message.message_id });
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_ADD' || st.data.targetUserId !== targetUserId) {
        await bot.editMessageText("This session has expired. Please use `/add <user_id>` again.", { chat_id: cid, message_id: q.message.message_id });
        delete userStates[cid];
        return;
    }

    await bot.editMessageText(`Verifying and assigning app "*${appName}*" to user \`${targetUserId}\`...`, {
        chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
    });

    try {
        // 1. Get the app's current config from Heroku. This also verifies it exists there.
        const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const configVars = configRes.data;
        const sessionId = configVars.SESSION_ID;

        // 2. Determine bot type from session ID
        let botType = 'levanter';
        if (sessionId && sessionId.startsWith(RAGANORK_SESSION_PREFIX)) {
            botType = 'raganork';
        }

        // 3. Check if the bot is already in our DB to see if this is an INSERT or an UPDATE
        const existingOwnerResult = await pool.query('SELECT user_id FROM user_bots WHERE bot_name = $1', [appName]);

        if (existingOwnerResult.rows.length > 0) {
            // --- SCENARIO 1: OWNERSHIP TRANSFER ---
            const oldOwnerId = existingOwnerResult.rows[0].user_id;
            console.log(`[Admin] Transferring ownership of "${appName}" from ${oldOwnerId} to ${targetUserId}.`);

            await pool.query('UPDATE user_bots SET user_id = $1, session_id = $2, bot_type = $3 WHERE bot_name = $4 AND user_id = $5', [targetUserId, sessionId, botType, appName, oldOwnerId]);
            await pool.query('UPDATE user_deployments SET user_id = $1, session_id = $2, config_vars = $3, bot_type = $4 WHERE app_name = $5 AND user_id = $6', [targetUserId, sessionId, configVars, botType, appName, oldOwnerId]);
            
            await bot.editMessageText(`App "*${appName}*" successfully *transferred* to user \`${targetUserId}\`. Its expiration date is preserved.`, {
                chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });

        } else {
            // --- SCENARIO 2: ADDING A NEW BOT ---
            console.log(`[Admin] Adding new bot "${appName}" to database for user ${targetUserId}.`);

            await dbServices.addUserBot(targetUserId, appName, sessionId, botType);
            await dbServices.saveUserDeployment(targetUserId, appName, sessionId, configVars, botType);

            await bot.editMessageText(`App "*${appName}*" successfully *added* to the database and assigned to user \`${targetUserId}\`.`, {
                chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });
        }

        await bot.sendMessage(targetUserId, `The admin has assigned the bot "*${appName}*" to your account. You can now manage it from "My Bots".`, { parse_mode: 'Markdown' });

    } catch (e) {
        let errorMsg = e.message;
        if (e.response?.status === 404) {
            errorMsg = `The app "${appName}" was not found on your Heroku account.`;
        } else if (e.response?.data?.message) {
            errorMsg = e.response.data.message;
        }
        console.error(`[Admin] Error assigning app "${appName}":`, errorMsg);
        await bot.editMessageText(`Failed to assign app "*${appName}*": ${errorMsg}`, {
            chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
        });
    } finally {
        delete userStates[cid];
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
        delete userStates[cid]; // Clear user state
        return;
    }

    await bot.editMessageText(`Removing app "*${appName}*" from user \`${targetUserId}\`'s dashboard...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        await dbServices.deleteUserBot(targetUserId, appName); // Use dbServices
        await dbServices.markDeploymentDeletedFromHeroku(targetUserId, appName); // NEW: Mark from backup DB as deleted, not delete

        console.log(`[Admin] Successfully called deleteUserBot for ${appName} from user ${targetUserId}.`);

        await bot.editMessageText(`App "*${appName}*" successfully removed from user \`${targetUserId}\`'s dashboard.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        await bot.sendMessage(targetUserId, `The admin has removed bot "*${appName}*" from your "My Bots" menu.`, { parse_mode: 'Markdown' });
        console.log(`[Admin] Sent removal notification to target user ${targetUserId}.`);

    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error removing app "${appName}" from user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to remove app "*${appName}*" from user \`${targetUserId}\`'s dashboard: ${errorMsg}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    } finally {
        delete userStates[cid]; // Clear user state
        console.log(`[Admin] State cleared for ${cid} after remove_app_from_user flow.`);
    }
    return;
  }

  // --- REPLACE your old 'info' block with this new one ---
// --- REPLACE your old 'info' block with this new one ---


if (action === 'info') {
    const appName = payload;
    const messageId = q.message.message_id;

    await bot.editMessageText(`Fetching app info for "*${escapeMarkdown(appName)}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
    
    try {
        const [appRes, configRes, dynoRes] = await Promise.all([
            axios.get(`https://api.heroku.com/apps/${appName}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }),
            axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }),
            axios.get(`https://api.heroku.com/apps/${appName}/dynos`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })
        ]);

        const appData = appRes.data;
        const configData = configRes.data;
        const dynoData = dynoRes.data;

        let dynoStatus = 'Inactive';
        if (dynoData.length > 0 && ['up', 'starting', 'restarting'].includes(dynoData[0].state)) {
            dynoStatus = 'Active';
        }
      
        // --- START OF FIX ---
        const ownerId = await dbServices.getUserIdByBotName(appName);
        let expirationInfo = "N/A";

        if (ownerId) {
            // Correctly read the expiration_date from the main database
            const deploymentDetails = (await pool.query('SELECT expiration_date FROM user_deployments WHERE user_id=$1 AND app_name=$2', [ownerId, appName])).rows[0];
            
            if (deploymentDetails && deploymentDetails.expiration_date) {
                const expirationDate = new Date(deploymentDetails.expiration_date);
                const now = new Date();
                const daysLeft = Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24));
                
                if (daysLeft > 0) {
                    expirationInfo = `${daysLeft} days remaining`;
                } else {
                    expirationInfo = 'Expired';
                }
            }
        }
        // --- END OF FIX ---

        const infoText = `*App Info: ${appData.name}*\n\n` +
                       `*Dyno Status:* ${dynoStatus}\n` +
                       `*Created:* ${new Date(appData.created_at).toLocaleDateString()}\n` +
                       `*Expiration:* ${expirationInfo}\n\n` +
                       `*Key Config Vars:*\n` +
                       `  \`SESSION_ID\`: ${configData.SESSION_ID ? 'Set' : 'Not Set'}\n` +
                       `  \`AUTO_STATUS_VIEW\`: \`${configData.AUTO_STATUS_VIEW || 'false'}\`\n`;

      return bot.editMessageText(infoText, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
        }
      });
    } catch (e) {
      if (e.response && e.response.status === 404) {
          await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, true);
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching info: ${errorMsg}`, {
        chat_id: cid, message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]] }
      });
    }
}

  if (action === 'restart') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        await bot.sendMessage(cid, "Please select an app again from 'My Bots'.");
        delete userStates[cid]; // Clear invalid state
        return;
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Restarting bot "*${payload}*"...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });

      await bot.editMessageText(`Bot "*${payload}*" restarted successfully!`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
          }
      });
      console.log(`Sent "restarted successfully" notification to user ${cid} for bot ${payload}`);

    } catch (e) {
      if (e.response && e.response.status === 404) {
          await dbServices.handleAppNotFoundAndCleanDb(cid, payload, messageId, true); // Use dbServices
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`Error restarting ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`Error restarting bot: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
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
        await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
        delete userStates[cid]; // Clear invalid state
        return;
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText('Fetching logs...', { chat_id: cid, message_id: messageId });
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
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
        }
      });
    } catch (e) {
      if (e.response && e.response.status === 404) {
          await dbServices.handleAppNotFoundAndCleanDb(cid, payload, messageId, true); // Use dbServices
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching logs: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
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
        await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
        delete userStates[cid]; // Clear invalid state
        return;
    }
    const messageId = q.message.message_id;

      return bot.editMessageText(`Are you sure you want to delete the app "*${payload}*"? This action cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: "Yes, I am sure", callback_data: `confirmdelete:${payload}:${action}` },
            { text: "No, cancel", callback_data: `selectapp:${payload}` }
          ]]
        }
      });
  }

      if (action === 'has_session') {
    const botType = payload;
    const st = userStates[cid];
    if (!st) return; // State check

    // If admin, skip deploy key and go straight to SESSION_ID step
    if (cid === ADMIN_ID) {
        st.step = 'SESSION_ID';
        await bot.editMessageText(
            `My boss. Please enter your SESSION ID for *${botType.toUpperCase()}* deployment:`,
            {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'Markdown'
            }
        );
        return;
    }

    // Non-admin: normal deploy key flow
    st.step = 'AWAITING_KEY';
    const price = process.env.KEY_PRICE_NGN || '1000';
    await bot.editMessageText(
        `Please enter your Deploy Key to continue deploying your *${botType.toUpperCase()}* bot.`, 
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Buy a Key (₦${price})`, callback_data: 'buy_key' }]
                ]
            }
        }
    );
    return;
}

    if (action === 'needs_session') {
        const botType = payload;
        const st = userStates[cid];
        if (!st) return; // State check

        let sessionPrompt = `Please use the button below to get your session ID for *${botType.toUpperCase()}*.`;
        const sessionUrl = (botType === 'raganork') ? RAGANORK_SESSION_SITE_URL : 'https://levanter-delta.vercel.app/';

        await bot.editMessageText(sessionPrompt, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Get Session ID', url: sessionUrl }],
                    [{ text: "I have my Session ID now", callback_data: `has_session:${botType}` }]
                ]
            }
        });
        return;
    }

// ... (existing code within bot.on('callback_query', async q => { ... })) ...

  if (action === 'confirmdelete') {
    const appToDelete = payload;
    const originalAction = extra;
    const messageId = q.message.message_id;

    const st = userStates[cid];
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appToDelete) {
        await bot.sendMessage(cid, "This deletion session has expired. Please select the app again.");
        delete userStates[cid];
        return;
    }

    await bot.editMessageText(`Deleting "*${escapeMarkdown(appToDelete)}*" from Heroku...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
    try {
        await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const ownerId = await dbServices.getUserIdByBotName(appToDelete);
        if (ownerId) {
            await dbServices.deleteUserBot(ownerId, appToDelete);
            await dbServices.markDeploymentDeletedFromHeroku(ownerId, appToDelete);
        }
        await bot.editMessageText(`App "*${escapeMarkdown(appToDelete)}*" has been permanently deleted.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });

        if (originalAction === 'userdelete') {
            // This is the flow for a regular user
            const remainingUserBots = await dbServices.getUserBots(cid);
            if (remainingUserBots.length > 0) {
                const rows = chunkArray(remainingUserBots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
                await bot.sendMessage(cid, 'Your remaining deployed bots:', { reply_markup: { inline_keyboard: rows } });
            } else {
                await bot.sendMessage(cid, "You no longer have any deployed bots. Would you like to deploy a new one?", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }],
                            [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]
                        ]
                    }
                });
            }
        } else {
            // This is the flow for an admin deleting from the main list.
            // We add an extra check to be safe.
            if (cid === ADMIN_ID) {
                await dbServices.sendAppList(cid, messageId);
            }
        }
    } catch (e) {
        if (e.response && e.response.status === 404) {
            await dbServices.handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, originalAction === 'userdelete');
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        await bot.editMessageText(`Failed to delete app "*${escapeMarkdown(appToDelete)}*": ${escapeMarkdown(errorMsg)}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appToDelete}` }]]
            }
        });
    } finally {
        delete userStates[cid];
    }
    return;
}


  if (action === 'canceldelete') {
      return bot.editMessageText('Deletion cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
  }

         if (action === 'setvar') {
        const appName = payload;
        const messageId = q.message.message_id;

        const st = userStates[cid];
        if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) {
            await bot.sendMessage(cid, "This menu has expired. Please select an app again.");
            delete userStates[cid];
            return;
        }

        let configVars = {};
        try {
            const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
            configVars = configRes.data;
        } catch (e) {
            if (e.response && e.response.status === 404) {
                await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, true);
                return;
            }
            return bot.editMessageText(`Error fetching config variables: ${e.response?.data?.message || e.message}`, { chat_id: cid, message_id: messageId });
        }
        
        // --- START OF THE FIX: Updated helper function and message string ---
        function formatVarValue(val, maxLength = 25) {
            if (!val) return '`Not Set`';
            if (val === 'p') return '`enabled (anti-delete)`';
            if (val === 'no-dl') return '`enabled (no download)`';
            
            let displayVal = String(val);
            if (displayVal.length > maxLength) {
                displayVal = displayVal.substring(0, maxLength) + '...';
            }
            return `\`${escapeMarkdown(displayVal)}\``;
        }

        const ownerId = await dbServices.getUserIdByBotName(appName);
        if (!ownerId) {
            return bot.editMessageText(`Error: Could not find the owner for "${appName}".`, { chat_id: cid, message_id: messageId });
        }

        const botTypeForSetVar = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [ownerId, appName])).rows[0]?.bot_type || 'levanter';
        const statusViewVar = botTypeForSetVar === 'raganork' ? 'AUTO_READ_STATUS' : 'AUTO_STATUS_VIEW';
        const prefixVar = botTypeForSetVar === 'raganork' ? 'HANDLERS' : 'PREFIX';

        let varInfo = `*Current Vars for ${appName} (${botTypeForSetVar.toUpperCase()}):*\n` +
                     `\`SESSION_ID\`: ${formatVarValue(configVars.SESSION_ID, 15)}\n` +
                     `\`${statusViewVar}\`: ${formatVarValue(configVars[statusViewVar])}\n` +
                     `\`ALWAYS_ONLINE\`: ${formatVarValue(configVars.ALWAYS_ONLINE)}\n` +
                     `\`${prefixVar}\`: ${formatVarValue(configVars[prefixVar])}\n` +
                     `\`ANTI_DELETE\`: ${formatVarValue(configVars.ANTI_DELETE)}\n` +
                     `\`SUDO\`: ${formatVarValue(configVars.SUDO, 20)}\n`;

        const keyboard = [
            [{ text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${appName}:${botTypeForSetVar}` }],
            [{ text: statusViewVar, callback_data: `varselect:${statusViewVar}:${appName}:${botTypeForSetVar}` }, { text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${appName}:${botTypeForSetVar}` }],
            [{ text: prefixVar, callback_data: `varselect:${prefixVar}:${appName}:${botTypeForSetVar}` }, { text: 'ANTI_DELETE', callback_data: `varselect:ANTI_DELETE:${appName}:${botTypeForSetVar}` }]
        ];
        
        if (botTypeForSetVar === 'levanter') {
            varInfo += `\`STATUS_VIEW_EMOJI\`: ${formatVarValue(configVars.STATUS_VIEW_EMOJI)}\n`;
            keyboard.push([
                { text: 'SUDO', callback_data: `varselect:SUDO_VAR:${appName}:${botTypeForSetVar}` },
                { text: 'STATUS_VIEW_EMOJI', callback_data: `varselect:STATUS_VIEW_EMOJI:${appName}:${botTypeForSetVar}` }
            ]);
        } else {
            keyboard.push([{ text: 'SUDO', callback_data: `varselect:SUDO_VAR:${appName}:${botTypeForSetVar}` }]);
        }

        keyboard.push([{ text: 'Add/Set Other Variable', callback_data: `varselect:OTHER_VAR:${appName}:${botTypeForSetVar}` }]);
        keyboard.push([{ text: 'Back', callback_data: `selectapp:${appName}` }]);
        // --- END OF THE FIX ---

        varInfo += `\nSelect a variable to set:`;

        return bot.editMessageText(varInfo, {
          chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
    }




  if (action === 'restore_all_bots') {
      handleRestoreAllSelection(q); // This shows the list
      return;
  }
  if (action === 'restore_all_confirm') {
      handleRestoreAllConfirm(q); // This starts the deployment
      return;
  }
  if (action === 'restore_all_cancel') {
      await bot.editMessageText('Restore cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
      return;
  }

        if (action === 'varselect') {
        const [varKey, appName, botTypeFromVarSelect] = [payload, extra, flag];
        const st = userStates[cid];
        
        if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) {
            await bot.sendMessage(cid, "This menu has expired. Please select an app again.");
            delete userStates[cid];
            return;
        }
        const messageId = q.message.message_id;

        // Set state for the next step
        userStates[cid].step = 'SETVAR_ENTER_VALUE';
        userStates[cid].data.APP_NAME = appName;
        userStates[cid].data.botType = botTypeFromVarSelect;

        if (varKey === 'STATUS_VIEW_EMOJI') {
             // This needs a different handler, so we change the step
             userStates[cid].step = 'AWAITING_EMOJI_CHOICE'; // A placeholder step
             return bot.editMessageText(`Set *STATUS_VIEW_EMOJI* to:`, {
                chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'On', callback_data: `set_emoji_status:${appName}:on` }],
                        [{ text: 'Off', callback_data: `set_emoji_status:${appName}:off` }],
                        [{ text: 'Back', callback_data: `setvar:${appName}` }]
                    ]
                }
            });
        } else if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE', 'AUTO_READ_STATUS'].includes(varKey)) {
            // This also needs a different handler
            userStates[cid].step = 'AWAITING_BOOL_CHOICE'; // A placeholder step
            return bot.editMessageText(`Set *${varKey}* to:`, {
                chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Enable', callback_data: `setvarbool:${varKey}:${appName}:true` }],
                        [{ text: 'Disable', callback_data: `setvarbool:${varKey}:${appName}:false` }],
                        [{ text: 'Back', callback_data: `setvar:${appName}` }]
                    ]
                }
            });
        } else if (varKey === 'SUDO_VAR') {
             userStates[cid].step = 'AWAITING_SUDO_CHOICE'; // Placeholder
             return bot.editMessageText(`Manage *SUDO* for "*${appName}*":`, {
                chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Add Number', callback_data: `sudo_action:add:${appName}` }],
                        [{ text: 'Remove Number', callback_data: `sudo_action:remove:${appName}` }],
                        [{ text: 'Back', callback_data: `setvar:${appName}` }]
                    ]
                }
            });
        } else if (varKey === 'OTHER_VAR') {
            userStates[cid].step = 'AWAITING_OTHER_VAR_NAME';
            userStates[cid].data.appName = appName;
            return bot.sendMessage(cid, 'Enter the variable name (e.g., `WORK_TYPE`):', { parse_mode: 'Markdown' });
        } else {
            // This is for SESSION_ID, HANDLERS, PREFIX, etc.
            // It correctly asks the user to type the value.
            userStates[cid].data.VAR_NAME = varKey;
            await bot.editMessageText(`Please enter the new value for *${varKey}*:`, {
                chat_id: cid,
                message_id: messageId,
                parse_mode: 'Markdown'
            });
        }
    }




  // --- FIX: Corrected sudo_action handler with proper state management ---
if (action === 'sudo_action') {
    const sudoAction = payload;
    const appName = extra;
    const st = userStates[cid];

    // FIX: This check is now more robust and looks for the correct state
    if (!st || (st.step !== 'APP_MANAGEMENT' && st.step !== 'AWAITING_SUDO_CHOICE')) {
        await bot.sendMessage(cid, "This session has expired or is invalid. Please select an app again.");
        delete userStates[cid];
        return;
    }
    
    // Store the appName in the state if it's not already there
    st.data.APP_NAME = appName;
    st.data.targetUserId = cid;
    st.data.attempts = 0;
    st.data.isFreeTrial = false;

    if (sudoAction === 'add') {
        st.step = 'AWAITING_SUDO_ADD_NUMBER';
        await bot.editMessageText('Please enter the number to *add* to SUDO (without + or spaces, e.g., `2349163916314`):', {
             chat_id: cid,
             message_id: q.message.message_id,
             parse_mode: 'Markdown'
        });
        return;
    } else if (sudoAction === 'remove') {
        st.step = 'AWAITING_SUDO_REMOVE_NUMBER';
        await bot.editMessageText('Please enter the number to *remove* from SUDO (without + or spaces, e.g., `2349163916314`):', {
             chat_id: cid,
             message_id: q.message.message_id,
             parse_mode: 'Markdown'
        });
        return;
    }
}


      if (action === 'unban_user') {
        const targetUserId = payload;
        const unbanned = await dbServices.unbanUser(targetUserId);

        if (unbanned) {
            await bot.answerCallbackQuery(q.id, { text: `User ${targetUserId} has been unbanned.` });
            try {
                await bot.sendMessage(targetUserId, `You have been unbanned by the admin. Welcome back!`);
            } catch (error) {
                console.warn(`Could not notify unbanned user ${targetUserId}: ${error.message}`);
            }
        } else {
            await bot.answerCallbackQuery(q.id, { text: `Failed to unban user ${targetUserId}.`, show_alert: true });
        }

        // Refresh the list of banned users
        await sendBannedUsersList(cid, q.message.message_id);
        return;
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
              message_id: q.message.message_id
          });
          delete userStates[cid]; // Clear user state
          return;
      }

      if (confirmation === 'yes') {
          await bot.editMessageText(`You chose to overwrite *${varName}*.`, {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'Markdown'
          });
          // Get bot type from main DB to pass to next state
          const botTypeForOverwrite = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';
          // Transition to the step where user provides the new value
          userStates[cid].step = 'AWAITING_OTHER_VAR_VALUE';
          userStates[cid].data.isFreeTrial = false; // Ensure it's treated as permanent for backup on update
          userStates[cid].data.botType = botTypeForOverwrite; // Pass bot type to next state for validation
          return bot.sendMessage(cid, `Please enter the *new* value for *${varName}*:`, { parse_mode: 'Markdown' });
      } else {
          await bot.editMessageText(`Variable *${varName}* was not overwritten.`, {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'Markdown'
          });
          delete userStates[cid]; // Clear user state
          return;
      }
  }

      if (action === 'set_emoji_status') {
        const [appName, value] = [payload, extra];
        const varKey = 'STATUS_VIEW_EMOJI';
        const herokuValue = value === 'on' ? '❤️,💕,💜' : '';

        try {
            const updateMsg = await bot.editMessageText(`Updating *${varKey}* for "*${appName}*"...`, { chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown' });
            
            await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, { [varKey]: herokuValue }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
            
            const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`,{ headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }})).data;
            const botType = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';
            await dbServices.saveUserDeployment(cid, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, botType);
            
            await bot.editMessageText(`Variable *${varKey}* for "*${appName}*" updated successfully! The bot will restart to apply changes.`, {
                chat_id: cid, message_id: updateMsg.message_id, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]] }
            });
        } catch (e) {
            await bot.editMessageText(`Error updating variable: ${e.response?.data?.message || e.message}`, { chat_id: cid, message_id: q.message.message_id });
        }
        return;
    }


// AROUND LINE 3000 in bot.js

if (action === 'setvarbool') {
  const [varKeyFromCallback, appName, valStr] = [payload, extra, flag]; 
  const flagVal = valStr === 'true';
  let newVal;

  const currentBotType = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter'; 

  const actualVarNameForHeroku = (currentBotType === 'raganork' && varKeyFromCallback === 'AUTO_STATUS_VIEW') ? 'AUTO_READ_STATUS' :
                                 (currentBotType === 'raganork' && varKeyFromCallback === 'PREFIX') ? 'HANDLERS' : varKeyFromCallback;

  // --- THIS IS THE FIX ---
  if (actualVarNameForHeroku === 'AUTO_STATUS_VIEW' || actualVarNameForHeroku === 'AUTO_READ_STATUS') {
      if (currentBotType === 'levanter') {
          newVal = flagVal ? 'no-dl' : 'false';
      } else if (currentBotType === 'raganork') {
          newVal = flagVal ? 'true' : 'false';
      }
  }
  // --- END OF FIX ---
  else if (actualVarNameForHeroku === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
  else newVal = flagVal ? 'true' : 'false';

  try {
    await bot.sendChatAction(cid, 'typing');
    const updateMsg = await bot.sendMessage(cid, `Updating *${actualVarNameForHeroku}* for "*${appName}*"...`, { parse_mode: 'Markdown' }); 

    console.log(`[API_CALL] Patching Heroku config vars (boolean) for ${appName}: { ${actualVarNameForHeroku}: '${newVal}' }`); 
    const patchResponse = await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { [actualVarNameForHeroku]: newVal }, 
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
    );
    console.log(`[API_CALL_SUCCESS] Heroku config vars (boolean) patched successfully for ${appName}. Status: ${patchResponse.status}`);

    console.log(`[Flow] setvarbool: Config var updated for "${appName}". Updating bot in user_bots DB.`);
    const herokuConfigVars = (await axios.get(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
    )).data;
    await dbServices.saveUserDeployment(cid, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, currentBotType); 

    const baseWaitingText = `Updated *${actualVarNameForHeroku}* for "*${appName}*". Waiting for bot status confirmation...`; 
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

        await bot.editMessageText(`Variable "*${actualVarNameForHeroku}*" for "*${appName}*" updated successfully and bot is back online!`, { 
            chat_id: cid,
            message_id: updateMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
        console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${appName}`);

    } catch (err) {
        clearTimeout(timeoutId);
        clearInterval(animateIntervalId);
        console.error(`App status check failed for ${appName} after variable update:`, err.message);
        await bot.editMessageText(
            `Bot "${appName}" failed to come online after variable "*${actualVarNameForHeroku}*" update: ${err.message}\n\n` +
            `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
            {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'Markdown',
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
    delete userStates[cid];
  } catch (e) {
    const errorMsg = e.response?.data?.message || e.message;
    console.error(`[API_CALL_ERROR] Error updating boolean variable ${actualVarNameForHeroku} for ${appName}:`, errorMsg, e.response?.data);
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
    // Clear current state and set up for session ID input
    delete userStates[cid];
    const botTypeForChangeSession = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';

    userStates[cid] = {
        step: 'SETVAR_ENTER_VALUE',
        data: {
            APP_NAME: appName,
            VAR_NAME: 'SESSION_ID',
            targetUserId: targetUserId,
            isFreeTrial: false, 
            botType: botTypeForChangeSession
        }
    };
    
    const sessionPrompt = `Please enter the *new* session ID for your bot "*${appName}*". It must start with \`${botTypeForChangeSession === 'raganork' ? RAGANORK_SESSION_PREFIX : LEVANTER_SESSION_PREFIX}\`.`;
    
    const sessionSiteUrl = botTypeForChangeSession === 'raganork' 
        ? RAGANORK_SESSION_SITE_URL 
        : 'https://levanter-delta.vercel.app/';

    await bot.sendMessage(cid, sessionPrompt, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Don't have the new session?", url: sessionSiteUrl }
                ]
            ]
        }
    });

    return;
  }
  
  if (action === 'admin_delete_trial_app') {
      const appToDelete = payload;
      const messageId = q.message.message_id;

      if (cid !== ADMIN_ID) {
          await bot.editMessageText("You are not authorized to perform this action.", { chat_id: cid, message_id: messageId });
          return;
      }

      await bot.sendChatAction(cid, 'typing');
      await bot.editMessageText(`Admin deleting Free Trial app "*${appToDelete}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          const ownerId = await dbServices.getUserIdByBotName(appToDelete); // Use dbServices
          if (ownerId) {
              await dbServices.deleteUserBot(ownerId, appToDelete); // Delete from main DB
              await dbServices.markDeploymentDeletedFromHeroku(ownerId, appToDelete); // NEW: Mark from backup DB as deleted
          }

          await bot.editMessageText(`Free Trial app "*${appToDelete}*" permanently deleted by Admin.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
          if (ownerId && ownerId !== cid) {
              await bot.sendMessage(ownerId, `Your Free Trial bot "*${appToDelete}*" has been manually deleted by the admin.`, { parse_mode: 'Markdown' });
          }
      } catch (e) {
          if (e.response && e.response.status === 404) {
              await dbServices.handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, false); // Use dbServices
              return;
          }
          const errorMsg = e.response?.data?.message || e.message;
          await bot.editMessageText(`Failed to delete Free Trial app "*${appToDelete}*": ${errorMsg}`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }
      return;
  }

  // AROUND LINE 1400 (inside bot.on('callback_query', async q => { ... }))

  if (action === 'redeploy_app') {
    const appName = payload;
    const messageId = q.message.message_id;

    // --- CRITICAL FIX START ---
    // 1. Get the actual owner's user_id from the database based on the appName
    const actualOwnerId = await dbServices.getUserIdByBotName(appName);
    if (!actualOwnerId) {
        await bot.editMessageText(`Cannot redeploy "*${appName}*": Bot owner not found in database.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
        return;
    }

    // 2. Check authorization: current user (cid) must be ADMIN OR the actual owner
    const isAdmin = cid === ADMIN_ID; // Your ADMIN_ID is already defined
    const isOwner = actualOwnerId === cid;

    if (!isAdmin && !isOwner) { // Only admin or owner can redeploy
        await bot.editMessageText("You are not authorized to redeploy this app.", { chat_id: cid, message_id: messageId });
        return;
    }

    // 3. Now, get the bot type using the actual owner's ID and appName
    const botTypeForRedeploy = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [actualOwnerId, appName])).rows[0]?.bot_type || 'levanter';
    // --- CRITICAL FIX END ---

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Redeploying "*${appName}*" from GitHub...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    let animateIntervalId = null;
    try {
        const bres = await axios.post(
            `https://api.heroku.com/apps/${appName}/builds`,
            // This line already correctly uses botTypeForRedeploy, so no change needed here.
            { source_blob: { url: `${botTypeForRedeploy === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL}/tarball/main` } },
            {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3',
                    'Content-Type': 'application/json'
                }
            }
        );

        const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;

        await bot.editMessageText(`Build initiated for "*${appName}*". Waiting for completion...`, {
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

        // On successful redeploy, update deleted_from_heroku_at to NULL in user_deployments
        const herokuConfigVars = (await axios.get( // Fetch latest config vars
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        )).data;

        // --- IMPORTANT FIX: Pass the actualOwnerId to saveUserDeployment ---
        await dbServices.saveUserDeployment(actualOwnerId, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, botTypeForRedeploy);
        // --- END IMPORTANT FIX ---

        await bot.editMessageText(`App "*${appName}*" redeployed successfully!`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
        console.log(`App "${appName}" redeployed successfully for user ${cid}.`);

    } catch (e) {
        if (e.response && e.response.status === 404) {
            // Pass true for isUserFacing if the current user (cid) is the owner, false if admin is doing it.
            await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, isOwner);
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`Error redeploying ${appName}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to redeploy "*${appName}*": ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
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
      return dbServices.sendAppList(cid, currentMessageId); // Use dbServices
    } else {
      const bots = await dbServices.getUserBots(cid); // Use dbServices
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
          // Add Restore button here again for clarity if they have no bots active
          return bot.editMessageText("You have not deployed any bots yet. Would you like to deploy your first bot or restore a backup?", {
            chat_id: cid,
            message_id: currentMessageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }],
                    [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]
                ]
            }
        });
      }
    }
  }
});

// --- FIX: Final, corrected bot.on('channel_post') handler ---
bot.on('channel_post', async msg => {
    const TELEGRAM_CHANNEL_ID = '-1002892034574';
    if (String(msg.chat.id) !== TELEGRAM_CHANNEL_ID || !msg.text) {
        return;
    }
    const text = msg.text.trim();
    console.log(`[Channel Post] Received: "${text}"`);

    let appName = null;
    let status = null;
    let sessionId = null;
    let failureReason = 'Bot session has logged out.';
    let match;

    // Check for a standardized status message first
    match = text.match(/\[LOG\] App: (.*?) \| Status: (.*?) \| Session: (.*?) \| Time: (.*)/);
    if (match) {
        appName = match[1];
        status = match[2];
        sessionId = match[3];
        console.log(`[Channel Post] Parsed (Standardized): App=${appName}, Status=${status}, Session=${sessionId}`);
    } else {
        match = text.match(/\[([^\]]+)\] connected/i);
        if (match) {
            appName = match[1];
            status = 'ONLINE';
            console.log(`[Channel Post] Parsed (Direct Connect): App=${appName}, Status=${status}`);
        } else {
            match = text.match(/User\s+\[?([^\]\s]+)\]?\s+has logged out/i);
            if (match) {
                appName = match[1];
                status = 'LOGGED OUT';
                console.log(`[Channel Post] Parsed (Direct Logout): App=${appName}, Status=${status}`);
            }
        }
    }
    
    // Check for the specific memory error message
    const memoryErrorMatch = text.match(/R14 memory error detected for \[(.*?)\]/);
    if (memoryErrorMatch) {
        appName = memoryErrorMatch[1];
        console.log(`[Log Monitor] R14 memory error detected for app: ${appName}`);
        
        // Trigger the restart immediately
        await restartBot(appName);
        // Notify yourself as the admin
        await bot.sendMessage(ADMIN_ID, `⚠️ R14 Memory error detected for bot \`${appName}\`. Triggering immediate restart.`, { parse_mode: 'Markdown' });

        return; // Exit to prevent further processing
    }

    if (!appName) {
        console.log(`[Channel Post] Message did not match any known format. Ignoring.`);
        return;
    }
    
    if (status === 'ONLINE') {
        const pendingPromise = appDeploymentPromises.get(appName);
        if (pendingPromise) {
            if (pendingPromise.animateIntervalId) clearInterval(pendingPromise.animateIntervalId);
            if (pendingPromise.timeoutId) clearTimeout(pendingPromise.timeoutId);
            pendingPromise.resolve('connected');
            appDeploymentPromises.delete(appName);
        }
        await pool.query(`UPDATE user_bots SET status = 'online', status_changed_at = NULL WHERE bot_name = $1`, [appName]);
        console.log(`[Status Update] Set "${appName}" to 'online'.`);
        
    } else if (status === 'LOGGED OUT') {
        const pendingPromise = appDeploymentPromises.get(appName);
        if (pendingPromise) {
            if (pendingPromise.animateIntervalId) clearInterval(pendingPromise.animateIntervalId);
            if (pendingPromise.timeoutId) clearTimeout(pendingPromise.timeoutId);
            pendingPromise.reject(new Error(failureReason));
            appDeploymentPromises.delete(appName);
        }
        await pool.query(`UPDATE user_bots SET status = 'logged_out', status_changed_at = NOW() WHERE bot_name = $1`, [appName]);
        console.log(`[Status Update] Set "${appName}" to 'logged_out'.`);
        
        const userId = await dbServices.getUserIdByBotName(appName);
        if (userId) {
            const warningMessage = `Your bot "*${escapeMarkdown(appName)}*" has been logged out.\n` +
                                   `*Reason:* ${escapeMarkdown(failureReason)}\n` +
                                   `Please update your session ID.\n\n` +
                                   `*Warning: This app will be automatically deleted in 5 days if the issue is not resolved.*`;
            
            const sentMessage = await bot.sendMessage(userId, warningMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${appName}:${userId}` }]]
                }
            }).catch(e => console.error(`Failed to send failure alert to user ${userId}: ${e.message}`));
            
            if (sentMessage) {
                try {
                    await bot.pinChatMessage(userId, sentMessage.message_id);
                    console.log(`[PinChat] Pinned logout warning for app "${appName}" to user ${userId}.`);
                    
                    const unpinAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
                    await pool.query(
                        'INSERT INTO pinned_messages (message_id, chat_id, unpin_at) VALUES ($1, $2, $3)',
                        [sentMessage.message_id, userId, unpinAt]
                    );
                    console.log(`[PinChat] Scheduled unpin for message ${sentMessage.message_id} at ${unpinAt.toISOString()}`);
                } catch (pinError) {
                    console.error(`[PinChat] Failed to pin message for user ${userId}:`, pinError.message);
                }
            }
        }
    }
});




// === Free Trial Channel Membership Monitoring ===
const ONE_HOUR_IN_MS = 60 * 60 * 1000;

async function checkMonitoredUsers() {
    console.log('[Monitor] Running free trial channel membership check...');
    const usersToMonitor = await dbServices.getMonitoredFreeTrials();

    for (const user of usersToMonitor) {
        try {
            const member = await bot.getChatMember(user.channel_id, user.user_id);
            const isMember = ['creator', 'administrator', 'member'].includes(member.status);

            if (!isMember) {
                // User has left the channel
                if (user.warning_sent_at) {
                    // Warning was already sent, check if 1 hour has passed
                    const warningTime = new Date(user.warning_sent_at).getTime();
                    if (Date.now() - warningTime > ONE_HOUR_IN_MS) {
                        // Time's up. Delete the bot.
                        console.log(`[Monitor] User ${user.user_id} did not rejoin. Deleting app ${user.app_name}.`);
                        await bot.sendMessage(user.user_id, `You did not rejoin the channel in time. Your free trial bot *${escapeMarkdown(user.app_name)}* is being deleted.`, { parse_mode: 'Markdown' });
                        
                        await axios.delete(`https://api.heroku.com/apps/${user.app_name}`, {
                            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                        }).catch(e => console.error(`[Monitor] Failed to delete Heroku app ${user.app_name}: ${e.message}`));
                        
                        await dbServices.deleteUserBot(user.user_id, user.app_name);
                        await dbServices.removeMonitoredFreeTrial(user.user_id);
                        await bot.sendMessage(ADMIN_ID, `Free trial bot *${escapeMarkdown(user.app_name)}* for user \`${user.user_id}\` was auto-deleted because they left the channel and did not rejoin.`, { parse_mode: 'Markdown' });
                    }
                } else {
                    // No warning sent yet, send one now
                    console.log(`[Monitor] User ${user.user_id} left the channel. Sending warning.`);
                    await bot.sendMessage(user.user_id, `We noticed you left our support channel. To continue using your free trial bot *${escapeMarkdown(user.app_name)}*, you must rejoin within 1 hour, or it will be automatically deleted.`, { parse_mode: 'Markdown' });
                    await dbServices.updateFreeTrialWarning(user.user_id);
                }
            }
        } catch (error) {
            console.error(`[Monitor] Error checking user ${user.user_id}:`, error.message);
        }
    }
}

// Run the check every 30 minutes
setInterval(checkMonitoredUsers, 30 * 60 * 1000);

// --- ADD this entire block to bot.js ---

// === Paid Bot Backup Expiration Management ===
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

async function checkAndManageExpirations() {
    console.log('[Expiration] Running daily check for expiring and expired bots...');

    // 1. Handle Warnings for Soon-to-Expire Bots
    const expiringBots = await dbServices.getExpiringBackups();
    for (const botInfo of expiringBots) {
        try {
            const daysLeft = Math.ceil((new Date(botInfo.expiration_date) - Date.now()) / ONE_DAY_IN_MS);
            const warningMessage = `Your paid bot *${escapeMarkdown(botInfo.app_name)}* and its backup will expire in *${daysLeft} day(s)*. After it expires, the app will be permanently deleted from our servers. To continue service, please deploy a new bot using a new key.`;
            await bot.sendMessage(botInfo.user_id, warningMessage, { parse_mode: 'Markdown' });
            await dbServices.setBackupWarningSent(botInfo.user_id, botInfo.app_name);
            console.log(`[Expiration] Sent expiration warning for ${botInfo.app_name} to user ${botInfo.user_id}.`);
        } catch (error) {
            console.error(`[Expiration] Failed to send warning to user ${botInfo.user_id} for app ${botInfo.app_name}:`, error.message);
        }
    }

    // 2. Handle Deletion of Expired Bots
    const expiredBots = await dbServices.getExpiredBackups();
    for (const botInfo of expiredBots) {
        try {
            console.log(`[Expiration] Bot ${botInfo.app_name} for user ${botInfo.user_id} has expired. Deleting now.`);
            await bot.sendMessage(botInfo.user_id, `Your bot *${escapeMarkdown(botInfo.app_name)}* has expired and has been permanently deleted. To deploy a new bot, please get a new key from the admin.`, { parse_mode: 'Markdown' });
            
            // Delete from Heroku/Render
            await axios.delete(`https://api.heroku.com/apps/${botInfo.app_name}`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            }).catch(e => console.error(`[Expiration] Failed to delete Heroku app ${botInfo.app_name} (it may have already been deleted): ${e.message}`));
            
            // Delete from all database tables
            await dbServices.deleteUserBot(botInfo.user_id, botInfo.app_name);
            await dbServices.deleteUserDeploymentFromBackup(botInfo.user_id, botInfo.app_name);

            await bot.sendMessage(ADMIN_ID, `Bot *${escapeMarkdown(botInfo.app_name)}* for user \`${botInfo.user_id}\` expired and was auto-deleted.`, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error(`[Expiration] Failed to delete expired bot ${botInfo.app_name} for user ${botInfo.user_id}:`, error.message);
            await monitorSendTelegramAlert(`Failed to auto-delete expired bot *${escapeMarkdown(botInfo.app_name)}* for user \`${botInfo.user_id}\`. Please check logs.`, ADMIN_ID);
        }
    }
}

// Run the check once every day
setInterval(checkAndManageExpirations, ONE_DAY_IN_MS);
console.log('[Expiration] Scheduled daily check for expired bots.');

// === Automatic Daily Database Backup ===
async function runDailyBackup() {
    console.log('[Backup] Starting daily automatic database sync...');
    try {
        // This uses the sync function from your services, which powers /copydb
        const result = await dbServices.syncDatabases(pool, backupPool); 
        if (result.success) {
            console.log(`[Backup] Daily database sync successful. ${result.message}`);
            // Optional: Notify admin on success
            // await bot.sendMessage(ADMIN_ID, "Daily database backup completed successfully.");
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        console.error(`[Backup] CRITICAL ERROR during daily automatic backup:`, error.message);
        // Notify admin on failure
        await bot.sendMessage(ADMIN_ID, `CRITICAL ERROR: The automatic daily database backup failed. Please check the logs.\n\nReason: ${error.message}`);
    }
}

// --- NEW SCHEDULED TASK ---
async function checkAndUnpinMessages() {
    console.log('[Unpin] Running scheduled check for messages to unpin...');
    try {
        const now = new Date();
        const messagesToUnpin = await pool.query(
            'SELECT message_id, chat_id FROM pinned_messages WHERE unpin_at <= $1',
            [now]
        );

        for (const row of messagesToUnpin.rows) {
            console.log(`[Unpin] Unpinning message ${row.message_id} in chat ${row.chat_id}`);
            try {
                await bot.unpinChatMessage(row.chat_id, { message_id: row.message_id });
                // Delete the record from the database after unpinning
                await pool.query('DELETE FROM pinned_messages WHERE message_id = $1', [row.message_id]);
            } catch (error) {
                console.error(`[Unpin] Failed to unpin message ${row.message_id} in chat ${row.chat_id}:`, error.message);
            }
        }
    } catch (dbError) {
        console.error('[Unpin] DB Error fetching messages to unpin:', dbError.message);
    }
}

// Run the check every 5 minutes
setInterval(checkAndUnpinMessages, 5 * 60 * 1000);
console.log('[Unpin] Scheduled task to check for messages to unpin.');

// Run the backup every 24 hours (24 * 60 * 60 * 1000 milliseconds)
setInterval(runDailyBackup, 60 * 60 * 1000);
console.log('[Backup] Scheduled hourly automatic database backup.');


async function checkAndPruneLoggedOutBots() {
    console.log('[Prune] Running hourly check for long-term logged-out bots...');
    try {
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        const result = await pool.query(
            "SELECT user_id, bot_name FROM user_bots WHERE status = 'logged_out' AND status_changed_at <= $1",
            [fiveDaysAgo]
        );

        const botsToDelete = result.rows;
        if (botsToDelete.length === 0) {
            console.log('[Prune] No logged-out bots found for deletion.');
            return;
        }

        for (const botInfo of botsToDelete) {
            const { user_id, bot_name } = botInfo;
            console.log(`[Prune] Deleting bot "${bot_name}" for user ${user_id} due to being logged out for over 5 days.`);
            
            try {
                // 1. Delete from Heroku
                await axios.delete(`https://api.heroku.com/apps/${bot_name}`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });

                // 2. Delete from all database tables
                await dbServices.deleteUserBot(user_id, bot_name);
                await dbServices.deleteUserDeploymentFromBackup(user_id, bot_name); // This function now targets the main DB

                // 3. Notify user and admin
                await bot.sendMessage(user_id, `Your bot "*${escapeMarkdown(bot_name)}*" has been automatically deleted because it was logged out for more than 5 days.`, { parse_mode: 'Markdown' });
                await bot.sendMessage(ADMIN_ID, `Auto-deleted bot "*${escapeMarkdown(bot_name)}*" (owner: \`${user_id}\`) for being logged out over 5 days.`, { parse_mode: 'Markdown' });

            } catch (error) {
                console.error(`[Prune] Failed to delete bot ${bot_name}:`, error.response?.data?.message || error.message);
                await bot.sendMessage(ADMIN_ID, `Failed to auto-delete bot "*${escapeMarkdown(bot_name)}*". Please check logs.`, { parse_mode: 'Markdown' });
            }
        }
    } catch (dbError) {
        console.error('[Prune] DB Error while checking for logged-out bots:', dbError);
    }
}

// Run the check every hour
setInterval(checkAndPruneLoggedOutBots, 60 * 60 * 1000);

// --- NEW FUNCTION TO CHECK AND SEND REMINDERS ---

async function checkAndSendExpirationReminders() {
    console.log('[Expiration] Running daily check for expiring bots...');

    const expiringBots = await dbServices.getExpiringBots();
    
    for (const botInfo of expiringBots) {
        try {
            const warningMessage = `Your paid bot *${escapeMarkdown(botInfo.app_name)}* is about to expire. To continue service, please redeploy with a new key.`;
            await bot.sendMessage(botInfo.user_id, warningMessage, { parse_mode: 'Markdown' });
            
            // Notify the admin as well
            await bot.sendMessage(ADMIN_ID, `Expiration Warning sent for bot *${escapeMarkdown(botInfo.app_name)}* to user \`${botInfo.user_id}\`.`, { parse_mode: 'Markdown' });

            await dbServices.setExpirationWarningSent(botInfo.user_id, botInfo.app_name);
            
            console.log(`[Expiration] Sent expiration warning for ${botInfo.app_name} to user ${botInfo.user_id}.`);
        } catch (error) {
            console.error(`[Expiration] Failed to send warning to user ${botInfo.user_id} for app ${botInfo.app_name}:`, error.message);
        }
    }
}

// --- SCHEDULE THE REMINDERS ---

setInterval(checkAndSendExpirationReminders, ONE_DAY_IN_MS);
console.log('[Expiration] Scheduled daily check for expiring bots.');

// --- NEW SCHEDULED TASK TO EMAIL LOGGED-OUT USERS ---
async function checkAndSendLoggedOutReminders() {
    console.log('[Email] Running daily logged-out bot email check...');
    const botsToEmail = await dbServices.getLoggedOutBotsForEmail();

    for (const botInfo of botsToEmail) {
        const { bot_name, email } = botInfo;
        // The bot's username is stored in bot.username
        await sendLoggedOutReminder(email, bot_name, bot.username);
    }
}

// Run the check every 24 hours
setInterval(checkAndSendLoggedOutReminders, ONE_DAY_IN_MS);
console.log('[Email] Scheduled daily logged-out bot email reminders.');
