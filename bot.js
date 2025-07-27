// bot.js

// --- CRITICAL DEBUG TEST: If you see this, the code is running! ---
console.log('--- SCRIPT STARTING: Verifying code execution (This should be the very first log!) ---');
// -----------------------------------------------------------------

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));


require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const path = require('path');
const express = require('express'); // <-- ADD THIS LINE

// Ensure monitorInit exports sendTelegramAlert as monitorSendTelegramAlert
const { init: monitorInit, sendTelegramAlert: monitorSendTelegramAlert } = require('./bot_monitor');
const { init: servicesInit, ...dbServices } = require('./bot_services');
const { init: faqInit, sendFaqPage } = require('./bot_faq');

// 2) Load fallback env vars from app.json / custom config files
let levanterDefaultEnvVars = {};
let raganorkDefaultEnvVars = {};

try {
  const appJsonPath = path.join(__dirname, 'app.json'); // Standard app.json for Levanter
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    
    // --- FIX: Added a .filter() to only read variables with a defined "value" ---
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

// Load Raganork-specific default env vars from app.json1
try {
  const appJson1Path = path.join(__dirname, 'app.json1'); // Your custom file for Raganork
  if (fs.existsSync(appJson1Path)) {
    const appJson1 = JSON.parse(fs.readFileSync(appJson1Path, 'utf8'));
    
    // --- FIX: Added a .filter() to only read variables with a defined "value" ---
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
  TELEGRAM_BOT_TOKEN: TOKEN_ENV, // Use a different name to avoid conflict with hardcoded one
  HEROKU_API_KEY,
  ADMIN_ID,
  DATABASE_URL,
  DATABASE_URL2, // NEW: Second database URL
} = process.env;

// Hardcoded Telegram Bot Token, User ID, Channel ID (as requested)
const TELEGRAM_BOT_TOKEN = TOKEN_ENV || '7730944193:AAG1RKwymeGG1HlYZRvHcOZZy_St9c77Rg'; // Use ENV if set, else hardcoded
const TELEGRAM_USER_ID = '7302005705';
const TELEGRAM_CHANNEL_ID = '-1002892034574';

// GitHub Repository URLs for different bots
const GITHUB_LEVANTER_REPO_URL = process.env.GITHUB_LEVANTER_REPO_URL || 'https://github.com/lyfe00011/levanter.git';
const GITHUB_RAGANORK_REPO_URL = process.env.GITHUB_RAGANORK_REPO_URL || 'https://github.com/ultar1/raganork-md1'; // Added Raganork MD URL

const SUPPORT_USERNAME = '@star_ies1';

// Admin SUDO numbers that cannot be removed
const ADMIN_SUDO_NUMBERS = ['234', '2349163916314'];

// Session ID Prefixes
const LEVANTER_SESSION_PREFIX = 'levanter_';
const RAGANORK_SESSION_PREFIX = 'RGNK';
const RAGANORK_SESSION_SITE_URL = 'https://session.raganork.site/';


// 4) Postgres setup & ensure tables exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// NEW: Second pool for DATABASE_URL2
const backupPool = new Pool({
  connectionString: DATABASE_URL2,
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

    // Main Database (pool - DATABASE_URL) tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
        session_id TEXT,
        bot_type   TEXT DEFAULT 'levanter', -- NEW: Store bot type
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, bot_name)
      );
    `);
    console.log("[DB-Main] 'user_bots' table checked/created with PRIMARY KEY.");
    // Add bot_type column if it doesn't exist (for existing databases)
    try {
        await pool.query(`ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS bot_type TEXT DEFAULT 'levanter';`);
        console.log("[DB-Main] 'user_bots' table 'bot_type' column checked/added.");
    } catch (e) {
        console.warn("[DB-Main] Could not add bot_type column to user_bots (might already exist or other error):", e.message);
    }


    await pool.query(`
      CREATE TABLE IF NOT EXISTS deploy_keys (
        key        TEXT PRIMARY KEY,
        uses_left  INTEGER NOT NULL,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[DB-Main] 'deploy_keys' table checked/created.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS temp_deploys (
        user_id       TEXT PRIMARY KEY,
        last_deploy_at TIMESTAMP NOT NULL
      );
    `);
    console.log("[DB-Main] 'temp_deploys' table checked/created.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_activity (
        user_id TEXT PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[DB-Main] 'user_activity' table checked/created.");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        user_id TEXT PRIMARY KEY,
        banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        banned_by TEXT
      );
    `);
    console.log("[DB-Main] 'banned_users' table checked/created.");

    // --- ADD this inside the startup block in bot.js ---

    // ... after the user_deployments table is created ...
    
    await backupPool.query(`
      CREATE TABLE IF NOT EXISTS all_users_backup (
        user_id TEXT PRIMARY KEY,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("[DB-Backup] 'all_users_backup' table checked/created.");


    // NEW: Backup Database (backupPool - DATABASE_URL2) tables
    await backupPool.query(`
      CREATE TABLE IF NOT EXISTS user_deployments (
        user_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        session_id TEXT,
        config_vars JSONB,      -- Store all variables as JSON
        bot_type TEXT,          -- NEW: Store bot type for restore context
        deploy_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- Original deploy date (never changes for a record)
        expiration_date TIMESTAMP, -- Fixed 45 days from deploy_date (never changes for a record)
        deleted_from_heroku_at TIMESTAMP, -- NEW: Timestamp when it was deleted from Heroku
        PRIMARY KEY (user_id, app_name)
      );
    `);
    console.log("[DB-Backup] 'user_deployments' table checked/created.");
    // Add bot_type and deleted_from_heroku_at columns if they don't exist
    try {
        await backupPool.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS bot_type TEXT;`);
        await backupPool.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS deleted_from_heroku_at TIMESTAMP;`);
        console.log("[DB-Backup] 'user_deployments' table 'bot_type' and 'deleted_from_heroku_at' columns checked/added.");
    } catch (e) {
        console.warn("[DB-Backup] Could not add bot_type/deleted_from_heroku_at columns to user_deployments (might already exist or other error):", e.message);
    }

    console.log("[DB] All necessary tables checked/created successfully in both pools.");

  } catch (dbError) {
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


// 5) Initialize bot & in-memory state
// <<< IMPORTANT: Set polling to false here. It will be started manually later.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let botId; // <-- ADD THIS LINE

// Get the bot's own ID at startup
bot.getMe().then(me => {
    if (me && me.id) {
        botId = me.id.toString();
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

let emojiIndex = 0;
const animatedEmojis = ['Loading', 'Loading.', 'Loading..', 'Loading...']; // Using text instead of emojis

function getAnimatedEmoji() { // This function still exists but will return text
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

// --- REPLACE your old sendBappList function with this one ---
async function sendBappList(chatId, messageId = null, botTypeFilter) {
    try {
        const queryText = `
            SELECT user_id, app_name, deleted_from_heroku_at 
            FROM user_deployments 
            WHERE bot_type = $1 
            ORDER BY deploy_date DESC;
        `;
        const queryParams = [botTypeFilter];

        const backupResult = await backupPool.query(queryText, queryParams);
        const deployments = backupResult.rows;

        if (deployments.length === 0) {
            const text = `No backed-up bots found for the type: *${botTypeFilter.toUpperCase()}*`;
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }

        const appButtons = deployments.map(entry => {
            const statusIndicator = entry.deleted_from_heroku_at === null ? '🟢' : '🔴';
            return {
                text: `${statusIndicator} ${entry.app_name}`,
                callback_data: `select_bapp:${entry.app_name}:${entry.user_id}`
            };
        });

        const rows = chunkArray(appButtons, 3);
        const text = `Select a backed-up *${botTypeFilter.toUpperCase()}* app to view details:`;
        const options = {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows }
        };

        if (messageId) {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        } else {
            await bot.sendMessage(chatId, text, options);
        }
    } catch (error) {
        console.error(`Error fetching backup app list for /bapp:`, error.message);
        await bot.sendMessage(chatId, `An error occurred while fetching the backup app list.`);
    }
}



async function sendAnimatedMessage(chatId, baseText) {
    const msg = await bot.sendMessage(chatId, `${getAnimatedEmoji()} ${baseText}...`);
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
      ['My Bots', 'FAQ'],
      ['Support'],
      ['More Features'] 
  ];
  if (isAdmin) {
      return [
          ['Deploy', 'Apps'],
          ['Generate Key', 'Get Session'],
          ['/stats', 'FAQ'], // Existing FAQ button
          ['/users', '/bapp', `/restoreall`] // <-- ADD /bapp here
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

// This function runs AFTER you click the "Proceed" button
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
        try {
            await bot.sendMessage(chatId, `▶Restoring bot ${index + 1}/${deployments.length}: \`${deployment.app_name}\` for user \`${deployment.user_id}\`...`, { parse_mode: 'Markdown' });
            
            const vars = { ...deployment.config_vars, APP_NAME: deployment.app_name, SESSION_ID: deployment.session_id };
            const success = await dbServices.buildWithProgress(deployment.user_id, vars, false, true, botType);

            if (success) {
                successCount++;
                await bot.sendMessage(chatId, `Successfully restored: \`${deployment.app_name}\``, { parse_mode: 'Markdown' });
                await bot.sendMessage(deployment.user_id, `Your bot \`${deployment.app_name}\` has been successfully restored by the admin.`, { parse_mode: 'Markdown' });

                // Check if it's NOT the last deployment before waiting
                if (index < deployments.length - 1) {
                    await bot.sendMessage(chatId, `Waiting for 3 minutes before deploying the next app...`);
                    await new Promise(resolve => setTimeout(resolve, 3 * 60 * 1000)); // 3 minutes wait
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
        backupPool: backupPool,                            // Pass the backup DB pool
        ADMIN_ID: ADMIN_ID, // Pass ADMIN_ID for critical errors
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
    escapeMarkdown: escapeMarkdown, // <-- Ensure this is passed
   });
    // Initialize bot_faq.js
    faqInit({
        bot: bot,
        userStates: userStates, // Pass the central userStates object
        escapeMarkdown: escapeMarkdown,
    });

    await loadMaintenanceStatus(); // Load initial maintenance status

// Check the environment to decide whether to use webhooks or polling
// At the top of your file, make sure you have crypto required
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production') {
    // --- Webhook Mode (for Heroku) ---
    const app = express();
    app.use(express.json());

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

    // At the top of your file, ensure 'crypto' is required
const crypto = require('crypto');

// --- UPDATED: Secure API Endpoint to GET or CREATE a deploy key ---
app.get('/api/get-key', async (req, res) => {
    const providedApiKey = req.headers['x-api-key'];
    const secretApiKey = process.env.INTER_BOT_API_KEY;

    // 1. Check for the secret API key
    if (!secretApiKey || providedApiKey !== secretApiKey) {
        console.warn('[API] Unauthorized attempt to get a key.');
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    try {
        // 2. Query the database for one active key
        const result = await pool.query(
            'SELECT key FROM deploy_keys WHERE uses_left > 0 ORDER BY created_at DESC LIMIT 1'
        );

        if (result.rows.length > 0) {
            // 3. Key found, send it back
            const key = result.rows[0].key;
            console.log(`[API] Provided existing key ${key} to authorized request.`);
            return res.json({ success: true, key: key });
        } else {
            // 4. No key found, so create a new one automatically
            console.log('[API] No active key found. Creating a new one...');
            
            // --- CHANGE IS HERE: Generate an 8-character alphanumeric key ---
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
            let newKey = '';
            const randomBytes = crypto.randomBytes(8);
            for (let i = 0; i < randomBytes.length; i++) {
                newKey += chars[randomBytes[i] % chars.length];
            }
            // --- END OF CHANGE ---
            
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
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  await dbServices.updateUserActivity(cid);
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
        personalizedGreeting += ` back, ${escapeMarkdown(userFirstName)}`;
    }
    personalizedGreeting += ` to our Bot Deployment Service!`;

    const welcomeImageUrl = 'https://files.catbox.moe/syx8uk.jpeg'; // Ensure this URL is valid
    const welcomeCaption = `
${personalizedGreeting}

To get started, please follow these simple steps:

1.  *Get Your Session:*
    Tap 'Get Session' and provide your WhatsApp number for a pairing code.

2.  *Deploy Your Bot:*
    Once you have your session code, use the 'Deploy' button to launch your personalized bot.

We are here to assist you every step of the way!
`;
    await bot.sendPhoto(cid, welcomeImageUrl, {
      caption: welcomeCaption,
      parse_mode: 'Markdown',
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
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

// --- ADD THIS COMMAND ---

// Command: /restoreall (Admin only)
bot.onText(/\/restoreall/, (msg) => {
    const chatId = msg.chat.id;
    // Only the admin can use this command
    if (String(chatId) !== ADMIN_ID) return;

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Levanter', callback_data: 'restore_all_bots:levanter' },
                    { text: 'Raganork', callback_data: 'restore_all_bots:raganork' }
                ]
            ]
        }
    };
    bot.sendMessage(chatId, 'Which bot type would you like to restore all backed-up deployments for?', opts);
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

// --- REPLACE this entire function in bot.js ---

// NEW ADMIN COMMAND: /stats
bot.onText(/^\/stats$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    await dbServices.updateUserActivity(cid);

    try {
        // --- START of new code ---
        // Get counts for each bot type
        const botCountsResult = await pool.query('SELECT bot_type, COUNT(bot_name) as count FROM user_bots GROUP BY bot_type');
        
        let levanterCount = 0;
        let raganorkCount = 0;
        botCountsResult.rows.forEach(row => {
            if (row.bot_type === 'levanter') {
                levanterCount = parseInt(row.count, 10);
            } else if (row.bot_type === 'raganork') {
                raganorkCount = parseInt(row.count, 10);
            }
        });
        // --- END of new code ---

        const totalUsersResult = await pool.query('SELECT COUNT(DISTINCT user_id) AS total_users FROM user_bots');
        const totalUsers = totalUsersResult.rows[0].total_users;

        const totalBotsResult = await pool.query('SELECT COUNT(bot_name) AS total_bots FROM user_bots');
        const totalBots = totalBotsResult.rows[0].total_bots;

        const activeKeys = await dbServices.getAllDeployKeys();
        const keyDetails = activeKeys.length > 0
            ? activeKeys.map(k => `\`${k.key}\` (Uses Left: ${k.uses_left}, By: ${k.created_by || 'N/A'})`).join('\n')
            : 'No active deploy keys.';

        const totalFreeTrialUsersResult = await pool.query('SELECT COUNT(DISTINCT user_id) AS total_trial_users FROM temp_deploys');
        const totalFreeTrialUsers = totalFreeTrialUsersResult.rows[0].total_trial_users;

        const totalBannedUsersResult = await pool.query('SELECT COUNT(user_id) AS total_banned_users FROM banned_users');
        const totalBannedUsers = totalBannedUsersResult.rows[0].total_banned_users;

        // --- UPDATE the message string ---
        const statsMessage = `
*Bot Statistics:*

*Total Unique Users:* ${totalUsers}
*Total Deployed Bots:* ${totalBots}
  - *Levanter Bots:* ${levanterCount}
  - *Raganork Bots:* ${raganorkCount}

*Users Who Used Free Trial:* ${totalFreeTrialUsers}
*Total Banned Users:* ${totalBannedUsers}

*Active Deploy Keys:*
${keyDetails}
        `;

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



// NEW ADMIN COMMAND: /send <user_id> <message>
bot.onText(/^\/send (\d+) (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    const targetUserId = match[1];
    const messageText = match[2];

    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    try {
        await bot.sendMessage(targetUserId, `*Message from Admin:*\n${messageText}`, { parse_mode: 'Markdown' });
        await bot.sendMessage(adminId, `Message sent to user \`${targetUserId}\`.`);
    } catch (error) {
        console.error(`Error sending message to user ${targetUserId}:`, error.message);
        let errorReason = "Unknown error";
        if (error.response && error.response.body && error.response.body.description) {
            errorReason = error.response.body.description;
            if (errorReason.includes("chat not found") || errorReason.includes("user not found")) {
                errorReason = `User with ID \`${targetUserId}\` not found or has not started a chat with the bot.`;
            } else if (errorReason.includes("bot was blocked by the user")) {
                errorReason = `Bot is blocked by user \`${targetUserId}\`.`;
            }
        }
        await bot.sendMessage(adminId, `Failed to send message to user \`${targetUserId}\`: ${errorReason}`);
    }
});

// --- REPLACE this entire function in bot.js ---

// NEW ADMIN COMMAND: /sendall <message>
bot.onText(/^\/sendall (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    const messageText = match[1];

    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    await bot.sendMessage(adminId, "Broadcasting message to all users from the backup list. This may take a while...");

    let successCount = 0;
    let failCount = 0;
    let blockedCount = 0;

    try {
        // --- CHANGE: Query the backup database (backupPool) now ---
        const allUserIdsResult = await backupPool.query('SELECT user_id FROM all_users_backup');
        const userIds = allUserIdsResult.rows.map(row => row.user_id);

        if (userIds.length === 0) {
            return bot.sendMessage(adminId, "No users found in the backup database to send messages to.");
        }

        for (const userId of userIds) {
            if (userId === adminId) continue; // Skip admin

            try {
                const isBanned = await dbServices.isUserBanned(userId);
                if (isBanned) {
                    console.log(`[SendAll] Skipping banned user: ${userId}`);
                    continue;
                }

                await bot.sendMessage(userId, `*Message from Admin:*\n${messageText}`, { parse_mode: 'Markdown' });
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
            } catch (error) {
                if (error.response?.body?.description.includes("bot was blocked")) {
                    blockedCount++;
                } else {
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

    } catch (error) {
        console.error(`[SendAll] Error fetching user list for broadcast:`, error.message);
        await bot.sendMessage(adminId, `An error occurred during broadcast: ${error.message}`);
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

// NEW ADMIN COMMAND: /unban <user_id>
bot.onText(/^\/unban (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    const targetUserId = match[1];

    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    const isBanned = await dbServices.isUserBanned(targetUserId); // Use dbServices
    if (!isBanned) {
        return bot.sendMessage(adminId, `User \`${targetUserId}\` is not currently banned.`, { parse_mode: 'Markdown' });
    }

    const unbanned = await dbServices.unbanUser(targetUserId); // Use dbServices
    if (unbanned) {
        await bot.sendMessage(adminId, `User \`${targetUserId}\` has been unbanned.`, { parse_mode: 'Markdown' });
        try {
            await bot.sendMessage(targetUserId, `You have been unbanned from using this bot. Welcome back!`);
        } catch (error) {
            console.warn(`Could not notify unbanned user ${targetUserId}: ${error.message}`);
        }
    } else {
        await bot.sendMessage(adminId, `Failed to unban user \`${targetUserId}\`. Check logs.`, { parse_mode: 'Markdown' });
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

  if (!text) return; // Only process text messages

  await dbServices.updateUserActivity(cid); // Update user activity on any message
  await notifyAdminUserOnline(msg); // Call notifyAdminUserOnline here for all messages

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
            await bot.sendMessage(cid,`The *SUDO* variable must be managed using "Add Number" or "Remove Number" options. How do you want to manage it for "*${APP_NAME}*"?`, {
                chat_id: cid,
                message_id: currentMessageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Add Number', callback_data: `sudo_action:add:${APP_NAME}` }],
                        [{ text: 'Remove Number', callback_data: `sudo_action:remove:${APP_NAME}` }],
                        [{ text: 'Back to Set Variable Menu', callback_data: `setvar:${APP_NAME}` }]
                    ]
                }
            }).catch(err => console.error(`Failed to edit message in AWAITING_OTHER_VAR_NAME for SUDO: ${err.message}`));
          } else {
             await bot.sendMessage(cid, `The *SUDO* variable must be managed using "Add Number" or "Remove Number" options. How do you want to manage it for "*${APP_NAME}*"?`, {
                parse_mode: 'Markdown',
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
              const message = `Variable *${varName}* already exists for "*${APP_NAME}*" with value: \`${escapeMarkdown(String(existingConfigVars[varName]))}\`\n\nDo you want to overwrite it?`;
              await bot.sendMessage(cid, message, {
                  parse_mode: 'Markdown',
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
              // Get bot type from main DB for this app, pass to state for validation
              const botTypeForOtherVar = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, APP_NAME])).rows[0]?.bot_type || 'levanter';
              userStates[cid].data.botType = botTypeForOtherVar;
              return bot.sendMessage(cid, `Please enter the value for *${varName}*:`, { parse_mode: 'Markdown' });
          }
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL_ERROR] Error checking existence of variable ${varName} for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error checking variable existence: ${errorMsg}`);
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


  if (text === 'Deploy' || text === 'Free Trial') { // Combined deploy and free trial entry
    const isFreeTrial = (text === 'Free Trial');
    const check = await dbServices.canDeployFreeTrial(cid); // Use dbServices
    if (isFreeTrial && !check.can) {
        return bot.sendMessage(cid, `You have already used your Free Trial. You can use it again after: ${check.cooldown.toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' })}`);
    }

    delete userStates[cid]; // Clear previous state
    userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: isFreeTrial } };

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
    console.log(`[Flow] My Bots button clicked by user: ${cid}`);
    const bots = await dbServices.getUserBots(cid); // Use dbServices
    if (!bots.length) {
        return bot.sendMessage(cid, "You have not deployed any bots yet. Would you like to deploy your first bot or restore a backup?", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }],
                    [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }] // New button
                ]
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
          [{ text: 'Ask Admin a Question', callback_data: 'ask_admin_question' }],
          [{ text: 'Contact Admin Directly', url: `https://t.me/${SUPPORT_USERNAME.substring(1)}` }] // <<< FIX: Corrected URL format
      ]
  };
  return bot.sendMessage(cid, `For help, you can contact the admin directly:`, {
      reply_markup: supportKeyboard,
      parse_mode: 'Markdown'
  });
}

  // Add this block inside bot.on('message', ...)

  if (text === 'More Features') {
      await dbServices.updateUserActivity(cid);
      const moreFeaturesText = "You can explore my other bot!";
      const moreFeaturesKeyboard = {
          inline_keyboard: [
              [{ text: "Test out my downloader Bot", url: 'https://t.me/tagtgbot' }]
          ]
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
        let errorMsg = 'Invalid format. Please send your WhatsApp number in the full international format including the `+` (e.g., `+23491630000000`).';
        if (st.data.botType === 'raganork') {
            errorMsg += ` Or get your session ID from the website: ${RAGANORK_SESSION_SITE_URL}`;
        } else { // Levanter or default
            errorMsg += ` Or get your session ID from the website: https://levanter-delta.vercel.app/`;
        }
        return bot.sendMessage(cid, errorMsg, { parse_mode: 'Markdown' });
    }

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
                    [{ text: 'Accept Request', callback_data: `pairing_action:accept:${cid}:${st.data.botType}` }], // Pass botType to admin action
                    [{ text: 'Decline Request', callback_data: `pairing_action:decline:${cid}:${st.data.botType}` }] // Pass botType to admin action
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
        isAdminDeploy: st?.data?.isAdminDeploy || false,
        botType: st.data.botType // Store bot type in state for later use
    };

    const timeoutDuration = 60 * 1000; // 60 seconds
    const timeoutIdForPairing = setTimeout(async () => {
        if (userStates[cid] && userStates[cid].step === 'WAITING_FOR_PAIRING_CODE_FROM_ADMIN') {
            console.log(`[Pairing Timeout] Request from user ${cid} timed out.`);
            if (userStates[cid].data.animateIntervalId) {
                clearInterval(userStates[cid].data.animateIntervalId);
            }
            if (userStates[cid].data.messageId) {
                let timeoutMessage = 'Pairing request timed out. The admin did not respond in time.';
                if (st.data.botType === 'raganork') {
                    timeoutMessage += ` Or generate your Raganork session ID directly from: ${RAGANORK_SESSION_SITE_URL}`;
                } else { // Levanter or default
                    timeoutMessage += ` Or get your session ID from the website: https://levanter-delta.vercel.app/`;
                }
                await bot.editMessageText(timeoutMessage, {
                    chat_id: cid,
                    message_id: userStates[cid].data.messageId,
                    parse_mode: 'Markdown'
                }).catch(err => console.error(`Failed to edit user's timeout message: ${err.message}`));
            }
            await bot.sendMessage(ADMIN_ID, `Pairing request from user \`${cid}\` (Phone: \`${phoneNumber}\`, Type: \`${st.data.botType}\`) timed out after ${timeoutDuration / 1000} seconds.`);
            delete userStates[cid];
            for (const key in forwardingContext) {
                if (forwardingContext[key].original_user_chat_id === cid && forwardingContext[key].request_type === 'pairing_request') {
                    delete forwardingContext[key];
                    console.log(`[Pairing Timeout] Cleaned up stale forwardingContext for admin message ${key}.`);
                    break;
                }
            }
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
        bot_type: st.data.botType // Store bot type in forwarding context
    };
    console.log(`[Pairing] Stored context for admin message ${adminMessage.message_id}:`, forwardingContext[adminMessage.message_id]);

    return;
  }


    if (st && st.step === 'AWAITING_KEY') { // This state is reached after selecting deploy type
    const keyAttempt = text.toUpperCase();

    const verificationMsg = await sendAnimatedMessage(cid, `Verifying key`);
    const startTime = Date.now();
    const usesLeft = await dbServices.useDeployKey(keyAttempt); // Use dbServices
    const elapsedTime = Date.now() - startTime;
    const remainingDelay = 5000 - elapsedTime; // Ensure at least 5 seconds total for verification
    if (remainingDelay > 0) {
        await new Promise(r => setTimeout(r, remainingDelay));
    }
    
    // WITH THIS CORRECTED BLOCK:
// ===================================================================
if (usesLeft === null) {
    const contactOwnerMessage = `Invalid Key. Please contact the owner for a valid KEY.`;
    const contactOwnerKeyboard = {
        inline_keyboard: [
            [
                { text: 'Contact Owner (WhatsApp)', url: 'https://wa.me/2349163916314' }, // Make sure this number is correct
                { text: 'Contact Owner (Telegram)', url: 'https://t.me/${SUPPORT_USERNAME.substring(1)}' }
            ]
        ]
    };
    await bot.editMessageText(contactOwnerMessage, {
      chat_id: cid,
      message_id: verificationMsg.message_id,
      reply_markup: contactOwnerKeyboard
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

    // --- START MODIFICATION FOR ADMIN KEY USED NOTIFICATION ---
    const { first_name, last_name, username } = msg.from;
    const userFullName = [first_name, last_name].filter(Boolean).join(' '); // Combines first and last name if both exist
    const userNameDisplay = username ? `@${escapeMarkdown(username)}` : 'N/A'; // Use N/A if no username

    await bot.sendMessage(ADMIN_ID,
      `*Key Used By:*\n` + // 🔑 Emojis are at the beginning of some words in my bot.
      `*Name:* ${escapeMarkdown(userFullName || 'N/A')}\n` + // Use userFullName
      `*Username:* ${userNameDisplay}\n` +
      `*Chat ID:* \`${escapeMarkdown(cid)}\`\n\n` + // Use escaped chat ID
      `*Key Used:* \`${escapeMarkdown(keyAttempt)}\`\n` + // <-- ADDED: The key that was used
      `*Uses Left:* ${usesLeft}`,
      { parse_mode: 'Markdown' }
    );
    // --- END MODIFICATION ---

    // The flow will now correctly wait for the SESSION_ID input in the next message.
    return;
  }


  if (st && st.step === 'SESSION_ID') { // This state is reached after AWAITING_KEY or select_deploy_type for admin
  const sessionID = text.trim(); // Get the session ID from user input
  const botType = st.data.botType; // Get bot type from state (set by select_deploy_type)

  // Validate session ID based on bot type
  let isValidSession = false;
  let requiredPrefix = '';
  let errorMessageBase = 'Incorrect session ID.'; // Base error message

  if (botType === 'levanter') {
      requiredPrefix = LEVANTER_SESSION_PREFIX;
      if (sessionID.startsWith(requiredPrefix) && sessionID.length >= 10) {
          isValidSession = true;
      }
      errorMessageBase += ` Your session ID must start with \`${requiredPrefix}\` and be at least 10 characters long.\n\nGet it from the website: https://levanter-delta.vercel.app/`; // <<< CHANGED URL
  } else if (botType === 'raganork') {
      requiredPrefix = RAGANORK_SESSION_PREFIX;
      if (sessionID.startsWith(requiredPrefix) && sessionID.length >= 10) {
          isValidSession = true;
      }
      errorMessageBase += ` Your Raganork session ID must start with \`${requiredPrefix}\` and be at least 10 characters long.\n\nGet it from the website: ${RAGANORK_SESSION_SITE_URL}`; // <<< CHANGED URL
  } else {
      errorMessageBase = 'Unknown bot type in state. Please start the deployment process again.';
  }

  if (!isValidSession) {
      return bot.sendMessage(cid, errorMessageBase, { parse_mode: 'Markdown' }); // Use errorMessageBase
  }

  st.data.SESSION_ID = sessionID;
  st.step = 'APP_NAME';
  return bot.sendMessage(cid, 'Great. Now enter a unique name for your bot (e.g., mybot123):');
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
        const wizardMsg = await bot.sendMessage(cid, wizardText, { ...wizardKeyboard, parse_mode: 'Markdown' });
        st.message_id = wizardMsg.message_id;

      } else {
        console.error(`Error checking app name "${nm}":`, e.response?.data?.message || e.message);
        return bot.sendMessage(cid, `Kindly Use A Long Name!`);
      }
    }
  }

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

// ===================================================================
if (action === 'users_page') {
    const newPage = parseInt(payload, 10);
    await sendUserListPage(q.message.chat.id, newPage, q.message.message_id);
    return;
}

  // ... inside bot.on('callback_query', ...)
if (action === 'users_page') {
    handleUsersPage(q);
    return;
}


  if (action === 'select_deploy_type') { // NEW: Handle bot type selection for deployment
      const botType = payload; // 'levanter' or 'raganork'
      const st = userStates[cid];

      if (!st || (st.step !== 'AWAITING_BOT_TYPE_SELECTION' && st.step !== 'AWAITING_KEY')) { // Allow key holders to select bot type as well
          await bot.editMessageText('This deployment session has expired or is invalid. Please start over by tapping "Deploy".', {
              chat_id: cid,
              message_id: q.message.message_id
          });
          delete userStates[cid]; // Clear the invalid state
          return;
      }
      
      st.data.botType = botType; // Store chosen bot type in state

      // If user came via /deploy and is not admin, they still need to enter key
      if (st.step === 'AWAITING_BOT_TYPE_SELECTION' && cid !== ADMIN_ID) {
          st.step = 'AWAITING_KEY'; // Next step: enter key
          await bot.editMessageText(`You chose *${botType.toUpperCase()}*. Please enter your Deploy key:`, {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'Markdown'
          });
      } else { // Admin or user with key already passed, directly ask for Session ID
          st.step = 'SESSION_ID'; // Next step: enter session ID
          let sessionPrompt = `You chose *${botType.toUpperCase()}*. Now send your session ID.`;
          if (botType === 'raganork') {
              sessionPrompt += ` (Raganork session IDs must start with \`${RAGANORK_SESSION_PREFIX}\`).\n\nGet it from the website: ${RAGANORK_SESSION_SITE_URL}`; // <-- CRITICAL CHANGE HERE
          } else { // Levanter
              sessionPrompt += ` (Levanter session IDs must start with \`${LEVANTER_SESSION_PREFIX}\`).\n\nGet it from the website: https://levanter-delta.vercel.app/`;
          }
          await bot.editMessageText(sessionPrompt, { // Use the constructed sessionPrompt
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'Markdown'
          });
      }
      return;
  }

// ... (rest of bot.js) ...


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
    const appUserId = extra; // This is the user_id of the app owner
    const messageId = q.message.message_id;

    await bot.editMessageText(`Fetching details for backed-up app "*${escapeMarkdown(appName)}*"...`, { // <-- Added preliminary message
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    }).catch(err => console.warn(`Failed to edit message with preliminary text: ${err.message}`));


    // Fetch the specific deployment from the backup database
    let selectedDeployment;
    try {
        const result = await backupPool.query(
            `SELECT user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at
             FROM user_deployments WHERE app_name = $1 AND user_id = $2;`, // Use both app_name and user_id for uniqueness
            [appName, appUserId]
        );
        selectedDeployment = result.rows[0];
    } catch (e) {
        console.error(`DB Error fetching backup deployment for ${appName} (${appUserId}):`, e.message); // EMOJI ADDED
        return bot.editMessageText(`An error occurred fetching details for "*${escapeMarkdown(appName)}*": ${escapeMarkdown(e.message)}.`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
    }

    if (!selectedDeployment) {
        console.warn(`⚠Backed-up app ${appName} for user ${appUserId} not found in DB during select_bapp. It might have been deleted.`); // EMOJI ADDED
        return bot.editMessageText(`Backup for "*${escapeMarkdown(appName)}*" (User ID: \`${escapeMarkdown(appUserId)}\`) not found in database. It might have been deleted.`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
    }

    // Helper to format values (ensure this `formatVarValue` exists in an accessible scope)
    function formatVarValue(val) {
        if (val === 'true') return 'true';
        if (val === 'false') return 'false';
        if (val === 'p') return 'enabled (anti-delete)';
        if (val === 'no-dl') return 'enabled (no download)';
        return val === null || val === undefined || String(val).trim() === '' ? 'Not Set' : String(val); // Handle null, undefined, empty strings gracefully
    }

    // Helper to format expiration info (as added previously)
    function formatExpirationInfo(deployDateStr) { // Only need deployDateStr, as expiration is derived
        if (!deployDateStr) return 'N/A';

        const deployDate = new Date(deployDateStr);
        const fixedExpirationDate = new Date(deployDate.getTime() + 45 * 24 * 60 * 60 * 1000); // 45 days from original deploy
        const now = new Date();

        const expirationDisplay = fixedExpirationDate.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });

        const timeLeftMs = fixedExpirationDate.getTime() - now.getTime();
        const daysLeft = Math.ceil(timeLeftMs / (1000 * 60 * 60 * 24));

        if (daysLeft > 0) {
            return `${expirationDisplay} (${daysLeft} days left)`;
        } else {
            return `Expired on ${expirationDisplay}`;
        }
    }


    const { user_id, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at } = selectedDeployment;

    // Try to get user's Telegram info
    let userDisplay = `\`${escapeMarkdown(user_id)}\``;
    try {
        const targetChat = await bot.getChat(user_id);
        const firstName = targetChat.first_name ? escapeMarkdown(targetChat.first_name) : '';
        const lastName = targetChat.last_name ? escapeMarkdown(targetChat.last_name) : '';
        const username = targetChat.username ? `@${escapeMarkdown(targetChat.username)}` : 'N/A';
        userDisplay = `${firstName} ${lastName} (${username})`;
    } catch (userError) {
        console.warn(`Could not fetch Telegram info for user ${user_id}: ${userError.message}`); // EMOJI ADDED
    }

    const deployDateDisplay = new Date(deploy_date).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' });
    const expirationInfo = formatExpirationInfo(deploy_date); // Pass only deploy_date

    let herokuStatus = '';
    if (deleted_from_heroku_at === null) {
        herokuStatus = '🟢 Currently on Heroku';
    } else {
        herokuStatus = `🔴 Deleted from Heroku on ${new Date(deleted_from_heroku_at).toLocaleDateString()}`;
    }

    // Format Config Vars for display
    let configVarsDisplay = '';
    const relevantConfigKeys = ['SESSION_ID', 'AUTO_READ_STATUS', 'AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'HANDLERS', 'PREFIX', 'ANTI_DELETE', 'SUDO', 'DISABLE_START_MESSAGE'];
    for (const key of relevantConfigKeys) {
        // Check if key exists and is not null/undefined/empty string
        if (config_vars && config_vars[key] !== undefined) {
            const displayValue = key === 'SESSION_ID' && config_vars[key] ? `${String(config_vars[key]).substring(0, 15)}...` : formatVarValue(config_vars[key]);
            configVarsDisplay += `  \`${escapeMarkdown(key)}\`: ${escapeMarkdown(displayValue)}\n`;
        }
    }
    if (!configVarsDisplay) configVarsDisplay = '  (No specific config vars saved)';


    const detailMessage = `
*Backed-up App Details:*

*App Name:* \`${escapeMarkdown(appName)}\`
*Bot Type:* ${bot_type ? bot_type.toUpperCase() : 'Unknown'}
*Owner User ID:* \`${escapeMarkdown(user_id)}\`
*Owner Telegram:* ${userDisplay}
*Deployed On:* ${deployDateDisplay}
*Expiration:* ${expirationInfo}
*Heroku Status:* ${herokuStatus}

*Saved Config Vars:*
${configVarsDisplay}
`;

    // Determine if restore button should be active (only if deleted from Heroku and not expired)
    const now = new Date();
    const isExpired = new Date(deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000 <= now.getTime(); // Check against fixed 45 days
    const canRestore = deleted_from_heroku_at !== null && !isExpired;


    const actionButtons = [];
    if (canRestore) {
        actionButtons.push([{ text: 'Restore App', callback_data: `restore_from_bapp:${appName}:${user_id}` }]);
    } else {
        // Change text to be more informative if not restorable
        actionButtons.push([{ text: `Cannot Restore (${isExpired ? 'Expired' : 'Active on Heroku'})`, callback_data: `no_action` }]);
    }
    actionButtons.push([{ text: 'Delete From Backup DB', callback_data: `delete_bapp:${appName}:${user_id}` }]);
    actionButtons.push([{ text: 'Back to Backup List', callback_data: `back_to_bapp_list` }]);


    await bot.editMessageText(detailMessage, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: actionButtons
        }
    });
    return;
  }


  if (action === 'select_restore_app') { // Handle selection of app to restore
    const appName = payload;
    const deployments = await dbServices.getUserDeploymentsForRestore(cid); // Use dbServices
    const selectedDeployment = deployments.find(dep => dep.app_name === appName);

    if (!selectedDeployment) {
        return bot.editMessageText('Selected backup not found. Please try again.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }

    // Check if the original 45-day expiration has passed for this specific record
    const now = new Date();
    const originalExpirationDate = new Date(new Date(selectedDeployment.deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000);
    if (originalExpirationDate <= now) { // Compare against current time
        // If expired, delete it from the backup table and tell user
        await dbServices.deleteUserDeploymentFromBackup(cid, appName); // This is a permanent delete
        return bot.editMessageText(`Cannot restore "*${escapeMarkdown(appName)}*". Its original 45-day deployment period has expired.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    }

    // Determine the default env vars for the bot type being restored
    const botTypeToRestore = selectedDeployment.bot_type || 'levanter';
    // Access the correct defaultEnvVars object from the one passed to servicesInit
    // This assumes defaultEnvVars (levanter/raganork) are globally accessible here,
    // which they should be because they're declared at the top of bot.js.
    const defaultVarsForRestore = (botTypeToRestore === 'raganork' ? raganorkDefaultEnvVars : levanterDefaultEnvVars) || {};

    // Prepare variables for deployment:
    // 1. Start with the appropriate default vars (e.g., HANDLERS for Raganork from app.json1)
    // 2. Overlay with saved config_vars (e.g., specific SESSION_ID)
    // 3. User-provided SESSION_ID for new deployments will override if needed, but not for restore.
    const combinedVarsForRestore = {
        ...defaultVarsForRestore,    // Apply type-specific defaults first
        ...selectedDeployment.config_vars, // Overlay with the saved config vars (these take precedence)
        APP_NAME: selectedDeployment.app_name, // Ensure APP_NAME is always correct
        SESSION_ID: selectedDeployment.session_id // Explicitly ensure saved SESSION_ID is used
    };

    await bot.editMessageText(`Attempting to restore and deploy "*${escapeMarkdown(appName)}*"...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    // Call buildWithProgress with isRestore flag, the combined variables, and the original botType
    await dbServices.buildWithProgress(cid, combinedVarsForRestore, false, true, botTypeToRestore);

    // After successful build, save it to backup DB to clear 'deleted_from_heroku_at' flag (handled by saveUserDeployment on conflict)
    // dbServices.saveUserDeployment handles setting deleted_from_heroku_at to NULL on update.
    return;
  }
// bot.js

// ... (existing code in bot.on('callback_query', async q => { ... })) ...

  if (action === 'restore_from_bapp') {
      const appName = payload;
      const appUserId = extra; // Owner of the app
      const messageId = q.message.message_id;

      await bot.editMessageText(`🚀 Preparing to restore "*${escapeMarkdown(appName)}*" for user \`${escapeMarkdown(appUserId)}\`...`, { // Added preliminary message
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown'
      }).catch(err => console.warn(`Failed to edit message with preliminary restore text: ${err.message}`));

      let selectedDeployment;
      try {
          const result = await backupPool.query(
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
// --- REPLACE this entire block in bot.js ---

if (action === 'confirm_delete_bapp') {
    const appName = payload;
    const appUserId = extra;
    const messageId = q.message.message_id;

    await bot.editMessageText(`Permanently deleting backup for "*${escapeMarkdown(appName)}*"...`, {
        chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
    }).catch(()=>{});

    try {
        const deleted = await dbServices.deleteUserDeploymentFromBackup(appUserId, appName);
        if (deleted) {
            await bot.editMessageText(`Backup for "*${escapeMarkdown(appName)}*" has been permanently deleted. Returning to menu...`, {
                chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
            });
        } else {
            await bot.editMessageText(`Could not find backup for "*${escapeMarkdown(appName)}*" to delete. Returning to menu...`, {
                 chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
            });
        }
        
        // FIX: Instead of trying to refresh a list, go back to the main selection menu.
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

    } catch (e) {
        await bot.editMessageText(`Failed to permanently delete backup for "*${escapeMarkdown(appName)}*": ${escapeMarkdown(e.message)}`, {
            chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
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


  if (action === 'select_get_session_type') { // NEW: Handle bot type selection for Get Session
    const botType = payload; // 'levanter' or 'raganork'
    const st = userStates[cid];

    if (!st || st.step !== 'AWAITING_GET_SESSION_BOT_TYPE') {
        await bot.editMessageText('This session request has expired or is invalid. Please start over by tapping "Get Session".', {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid]; // Clear the invalid state
        return;
    }

    st.data.botType = botType; // Store chosen bot type in state

    if (botType === 'raganork') { // <<< FIX: New logic for Raganork direct URL
        // Directly provide Raganork session URL and end the flow here
        await bot.editMessageText(`You chose *Raganork MD*. Please visit the following link to generate your session ID:\n\n${RAGANORK_SESSION_SITE_URL}\n\nOnce you have your session ID, tap 'Deploy' to continue.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            disable_web_page_preview: false, // Allow link preview
            reply_markup: {
                inline_keyboard: [[{ text: 'Deploy Now', callback_data: `deploy_first_bot` }]]
            }
        });
        delete userStates[cid]; // Clear state as this flow is complete for Raganork
        return;
    } else { // Levanter or any other type will proceed to phone number request
        st.step = 'AWAITING_PHONE_NUMBER'; // <<< CHANGED: Only Levanter goes here
        let promptMessage = `You chose *Levanter*. Please send your WhatsApp number in the full international format including the \`+\` (e.g., \`+23491630000000\`).\n\nAlternatively, you can generate your Levanter session ID directly from: https://levanter-delta.vercel.app/`;

        await bot.editMessageText(promptMessage, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
        return;
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

  if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    const messageId = q.message.message_id;
    const appName = payload;

    userStates[cid] = { step: 'APP_MANAGEMENT', data: { appName: appName, messageId: messageId, isUserBot: isUserBot } };

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Fetching app status for "*${appName}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });

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
          [{ text: 'Backup', callback_data: `backup_app:${appName}` }], // NEW: Backup button
          [{ text: 'Back', callback_data: 'back_to_app_list' }]
        ]
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
        const existingBackup = await backupPool.query(
            `SELECT deleted_from_heroku_at FROM user_deployments WHERE user_id = $1 AND app_name = $2;`,
            [cid, appName] // Query by user_id and app_name
        );

        // If a record exists AND deleted_from_heroku_at is NULL, it means it's currently backed up and active.
        if (existingBackup.rows.length > 0 && existingBackup.rows[0].deleted_from_heroku_at === null) {
            return bot.editMessageText(`ℹ️ App "*${escapeMarkdown(appName)}*" is already backed up and currently active on Heroku. No action needed.`, {
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

        await bot.editMessageText(`✅ App "*${escapeMarkdown(appName)}*" successfully backed up! You can restore it later if needed.`, {
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

    console.log(`[CallbackQuery - add_assign_app] Received selection for app: ${appName} to assign to user: ${targetUserId}`);
    console.log(`[CallbackQuery - add_assign_app] Current state for ${cid} is:`, userStates[cid]);

    if (cid !== ADMIN_ID) {
        await bot.editMessageText("You are not authorized to perform this action.", {
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
        delete userStates[cid]; // Clear user state
        return;
    }

    await bot.editMessageText(`Assigning app "*${appName}*" to user \`${targetUserId}\`...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        const existingEntry = await pool.query('SELECT user_id, bot_type FROM user_bots WHERE bot_name=$1', [appName]);
        let botTypeForAssignment = 'levanter'; // Default type
        if (existingEntry.rows.length > 0) {
            const oldUserId = existingEntry.rows[0].user_id;
            botTypeForAssignment = existingEntry.rows[0].bot_type || 'levanter'; // Get type from existing entry
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
            await bot.editMessageText(`Cannot assign "*${appName}*". It does not have a SESSION_ID config variable set on Heroku. Please set it manually first or deploy it via the bot.`, {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'Markdown'
            });
            delete userStates[cid]; // Clear user state
            return;
        }
        // Validate session ID starts with 'levanter_' or 'RGNK' when assigning
        if (!currentSessionId.startsWith(LEVANTER_SESSION_PREFIX) && !currentSessionId.startsWith(RAGANORK_SESSION_PREFIX)) {
            await bot.editMessageText(`Cannot assign "*${appName}*". Its current SESSION_ID on Heroku does not start with \`${LEVANTER_SESSION_PREFIX}\` or \`${RAGANORK_SESSION_PREFIX}\`. Please correct the session ID on Heroku first.`, {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'Markdown'
            });
            delete userStates[cid]; // Clear user state
            return;
        }
        if (currentSessionId.startsWith(RAGANORK_SESSION_PREFIX)) { // Determine botType if not already known
            botTypeForAssignment = 'raganork';
        } else if (currentSessionId.startsWith(LEVANTER_SESSION_PREFIX)) {
            botTypeForAssignment = 'levanter';
        }


        await dbServices.addUserBot(targetUserId, appName, currentSessionId, botTypeForAssignment); // Use dbServices, pass botType
        await dbServices.saveUserDeployment(targetUserId, appName, currentSessionId, configRes.data, botTypeForAssignment); // Use dbServices

        console.log(`[Admin] Successfully called addUserBot for ${appName} to user ${targetUserId} with fetched session ID.`);

        await bot.editMessageText(`App "*${appName}*" (Type: ${botTypeForAssignment.toUpperCase()}) successfully assigned to user \`${targetUserId}\`! It will now appear in their "My Bots" menu.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        await bot.sendMessage(targetUserId, `Your bot "*${appName}*" (Type: ${botTypeForAssignment.toUpperCase()}) has been successfully assigned to your "My Bots" menu by the admin! You can now manage it.`, { parse_mode: 'Markdown' });
        console.log(`[Admin] Sent success notification to target user ${targetUserId}.`);

    } catch (e) {
        if (e.response && e.response.status === 404) {
            await dbServices.handleAppNotFoundAndCleanDb(cid, appName, q.message.message_id, false); // Use dbServices
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error assigning app "${appName}" to user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to assign app "*${appName}*" to user \`${targetUserId}\`: ${errorMsg}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
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

  if (action === 'info') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
        delete userStates[cid]; // Clear invalid state
        return;
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
      
      let expirationInfo = "N/A";
      // Get expiration info from user_deployments (backup DB)
      const deploymentBackup = (await backupPool.query('SELECT deploy_date, expiration_date FROM user_deployments WHERE user_id=$1 AND app_name=$2', [cid, payload])).rows[0];
      if (deploymentBackup && deploymentBackup.deploy_date) {
        const originalDeployDate = new Date(deploymentBackup.deploy_date);
        const fixedExpirationDate = new Date(originalDeployDate.getTime() + 45 * 24 * 60 * 60 * 1000); // 45 days from original deploy
        const now = new Date();
        const timeLeftMs = fixedExpirationDate.getTime() - now.getTime();
        const daysLeft = Math.ceil(timeLeftMs / (1000 * 60 * 60 * 24));

        expirationInfo = `${fixedExpirationDate.toLocaleDateString()} (${daysLeft} days left from original deploy)`;
        if (daysLeft <= 0) {
            expirationInfo = `Expired on ${fixedExpirationDate.toLocaleDateString()}`;
        }
      }

      const info = `*App Info: ${appData.name}*\n\n` +
                   `*Dyno Status:* ${dynoStatus}\n` +
                   `*Created:* ${new Date(appData.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' })} (${Math.ceil(Math.abs(new Date() - new Date(appData.created_at)) / (1000 * 60 * 60 * 24))} days ago)\n` +
                   `*Last Release:* ${new Date(appData.released_at).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, year: 'numeric', month: 'numeric', day: 'numeric' })}\n` +
                   `*Stack:* ${appData.stack.name}\n` +
                   `*Expiration:* ${expirationInfo}\n\n` + // NEW: Add expiration info
                   `*Key Config Vars:*\n` +
                   `  \`SESSION_ID\`: ${configData.SESSION_ID ? 'Set' : 'Not Set'}\n` +
                   `  \`AUTO_STATUS_VIEW\`: \`${configData.AUTO_STATUS_VIEW || 'false'}\`\n`;

      return bot.editMessageText(info, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
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
      console.error(`Error fetching info for ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`Error fetching info: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
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
        await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
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

// ... (existing code within bot.on('callback_query', async q => { ... })) ...

  if (action === 'confirmdelete') {
      const appToDelete = payload;
      const originalAction = extra; // 'delete' or 'userdelete'
      const messageId = q.message.message_id; // Get messageId from q.message

      // Re-validate state for robustness, though not strictly required if other checks are fine
      const st = userStates[cid];
      if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appToDelete) {
          // Send a new message as the original might be gone or context is lost
          await bot.sendMessage(cid, "This deletion session has expired or is invalid. Please select an app again from 'My Bots' or 'Apps'.");
          delete userStates[cid]; // Clear invalid state
          return;
      }


      await bot.sendChatAction(cid, 'typing');
      await bot.editMessageText(`Deleting "*${escapeMarkdown(appToDelete)}*" from Heroku...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' }); // EMOJI ADDED
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          const ownerId = await dbServices.getUserIdByBotName(appToDelete); // Use dbServices
          if (ownerId) {
              await dbServices.deleteUserBot(ownerId, appToDelete); // Delete from main DB
              await dbServices.markDeploymentDeletedFromHeroku(ownerId, appToDelete); // NEW: Mark from backup DB as deleted
          }
          await bot.editMessageText(`App "*${escapeMarkdown(appToDelete)}*" has been permanently deleted.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' }); // EMOJI ADDED

          // --- CRITICAL FIX START: User deletion redirection ---
          if (originalAction === 'userdelete') {
              const remainingUserBots = await dbServices.getUserBots(cid); // Get only *this user's* bots
              if (remainingUserBots.length > 0) {
                  const rows = chunkArray(remainingUserBots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
                  // Edit the message to show remaining bots
                  await bot.sendMessage(cid, 'Your remaining deployed bots:', { reply_markup: { inline_keyboard: rows } });
              } else {
                  await bot.sendMessage(cid, "You no longer have any deployed bots. Would you like to deploy your first bot or restore a backup?", {
                      reply_markup: {
                          inline_keyboard: [
                              [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }],
                              [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]
                          ]
                      }
                  });
              }
          } else { // Admin deletion ('delete' action)
            // Admin still gets the full list (as per previous logic)
            return dbServices.sendAppList(cid, messageId); // Edit original message, pass messageId
          }
          // --- CRITICAL FIX END ---

      } catch (e) {
          if (e.response && e.response.status === 404) {
              // Handle 404 for deletion: app was likely already gone
              await dbServices.handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, originalAction === 'userdelete');
              return;
          }
          const errorMsg = e.response?.data?.message || e.message;
          await bot.editMessageText(`Failed to delete app "*${escapeMarkdown(appToDelete)}*": ${escapeMarkdown(errorMsg)}`, { // EMOJI ADDED
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown',
              reply_markup: {
                  inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appToDelete}` }]]
              }
          });
      } finally {
          delete userStates[cid]; // Clear user state
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
    const appName = payload; // The app name is the payload for 'setvar'
    const messageId = q.message.message_id; // The message ID to edit

    // Ensure the current state is correct for 'setvar'
    const st = userStates[cid];
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) {
        await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
        delete userStates[cid]; // Clear invalid state
        return;
    }

    // --- CRITICAL ADDITION: FETCH CONFIG VARS ---
    let configVars = {}; // Declare and initialize configVars
    try {
        const apiHeaders = {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
        };
        const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, { headers: apiHeaders });
        configVars = configRes.data; // Assign the fetched data
    } catch (e) {
        if (e.response && e.response.status === 404) {
            await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, true);
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`Error fetching config vars for ${appName}:`, errorMsg, e.stack);
        await bot.editMessageText(`Error fetching config variables: ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]] }
        });
        return; // Exit if fetching config vars fails
    }
    // --- END CRITICAL ADDITION ---

    // Define a helper function to format boolean-like variables (ensure this is defined in your bot.js scope)
    function formatVarValue(val) {
        if (val === 'true') return 'true';
        if (val === 'false') return 'false';
        if (val === 'p') return 'enabled (anti-delete)'; // For ANTI_DELETE
        if (val === 'no-dl') return 'enabled (no download)'; // For AUTO_STATUS_VIEW specific
        return val || 'Not Set'; // Default for any other undefined/null value
    }

    const sessionIDValue = configVars.SESSION_ID ? `\`${escapeMarkdown(String(configVars.SESSION_ID))}\`` : '`Not Set`';
    // Ensure 'pool' is accessible here. It should be from your global setup.
    const botTypeForSetVar = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';

    const statusViewVar = botTypeForSetVar === 'raganork' ? 'AUTO_READ_STATUS' : 'AUTO_STATUS_VIEW';
    const prefixVar = botTypeForSetVar === 'raganork' ? 'HANDLERS' : 'PREFIX';

    const varInfo = `*Current Config Variables for ${appName}:*\n` +
                     `*Bot Type:* \`${botTypeForSetVar.toUpperCase()}\`\n` +
                     `\`SESSION_ID\`: ${sessionIDValue}\n` +
                     `\`${statusViewVar}\`: ${formatVarValue(configVars[statusViewVar])}\n` +
                     `\`ALWAYS_ONLINE\`: ${formatVarValue(configVars.ALWAYS_ONLINE)}\n` +
                     `\`${prefixVar}\`: ${formatVarValue(configVars[prefixVar])}\n` +
                     `\`ANTI_DELETE\`: ${formatVarValue(configVars.ANTI_DELETE)}\n` +
                     `\`SUDO\`: ${formatVarValue(configVars.SUDO)}\n\n` +
                     `Select a variable to set:`;

    return bot.editMessageText(varInfo, {
      chat_id: cid,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          // IMPORTANT: Ensure you pass appName as 'extra' and botTypeForSetVar as 'flag' in callback_data
          // This allows subsequent varselect/setvarbool actions to use them.
          [{ text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${appName}:${botTypeForSetVar}` }],
          [{ text: statusViewVar, callback_data: `varselect:${statusViewVar}:${appName}:${botTypeForSetVar}` },
           { text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${appName}:${botTypeForSetVar}` }],
          [{ text: prefixVar, callback_data: `varselect:${prefixVar}:${appName}:${botTypeForSetVar}` },
           { text: 'ANTI_DELETE', callback_data: `varselect:ANTI_DELETE:${appName}:${botTypeForSetVar}` }],
          [{ text: 'SUDO', callback_data: `varselect:SUDO_VAR:${appName}:${botTypeForSetVar}` }],
          [{ text: 'Add/Set Other Variable', callback_data: `varselect:OTHER_VAR:${appName}:${botTypeForSetVar}` }],
          [{ text: 'Back', callback_data: `selectapp:${appName}` }]
        ]
      }
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
    
    // State validation
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) {
        await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
        delete userStates[cid];
        return;
    }
    const messageId = q.message.message_id;

    // Fix for unresponsive Session ID button
    if (varKey === 'SESSION_ID') {
        userStates[cid].step = 'SETVAR_ENTER_VALUE';
        userStates[cid].data.VAR_NAME = 'SESSION_ID';
        userStates[cid].data.APP_NAME = appName;
        userStates[cid].data.isFreeTrial = false;
        userStates[cid].data.botType = botTypeFromVarSelect || 'levanter';
        return bot.sendMessage(cid, `Please enter the new value for *SESSION_ID*:`, { parse_mode: 'Markdown' });
    } 
    
    // Logic for other boolean-like variables
    else if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE', 'PREFIX', 'AUTO_READ_STATUS', 'HANDLERS'].includes(varKey)) {
        userStates[cid].step = 'SETVAR_ENTER_VALUE';
        const actualVarName = (botTypeFromVarSelect === 'raganork' && varKey === 'AUTO_STATUS_VIEW') ? 'AUTO_READ_STATUS' :
                             (botTypeFromVarSelect === 'raganork' && varKey === 'PREFIX') ? 'HANDLERS' : varKey;
        userStates[cid].data.VAR_NAME = actualVarName;
        userStates[cid].data.APP_NAME = appName;
        userStates[cid].data.isFreeTrial = false;
        userStates[cid].data.botType = botTypeFromVarSelect || 'levanter';

        if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE', 'AUTO_READ_STATUS'].includes(actualVarName)) {
            return bot.editMessageText(`Set *${actualVarName}* to:`, {
                chat_id: cid,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'true', callback_data: `setvarbool:${actualVarName}:${appName}:true` }],
                        [{ text: 'false', callback_data: `setvarbool:${actualVarName}:${appName}:false` }],
                        [{ text: 'Back', callback_data: `setvar:${appName}` }] // This correctly handles the back state
                    ]
                }
            });
        }
        return bot.sendMessage(cid, `Please enter the new value for *${actualVarName}*:`, { parse_mode: 'Markdown' });
    } 
    
    // Logic for other variable types
    else if (varKey === 'OTHER_VAR') {
        userStates[cid].step = 'AWAITING_OTHER_VAR_NAME';
        return bot.sendMessage(cid, 'Please enter the name of the variable you want to set (e.g., `WORK_TYPE`):', { parse_mode: 'Markdown' });
    } 
    else if (varKey === 'SUDO_VAR') {
        return bot.editMessageText(`How do you want to manage *SUDO* for "*${appName}*"?`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Add Number', callback_data: `sudo_action:add:${appName}` }],
                    [{ text: 'Remove Number', callback_data: `sudo_action:remove:${appName}` }],
                    [{ text: 'Back to Set Variable Menu', callback_data: `setvar:${appName}` }] // This correctly handles the back state
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
          await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
          delete userStates[cid]; // Clear invalid state
          return;
      }


      userStates[cid].data.APP_NAME = appName;
      userStates[cid].data.targetUserId = cid;
      userStates[cid].data.attempts = 0;
      userStates[cid].data.isFreeTrial = false; // Ensure it's treated as permanent for backup on update

      if (sudoAction === 'add') {
          userStates[cid].step = 'AWAITING_SUDO_ADD_NUMBER';
          return bot.sendMessage(cid, 'Please enter the number to *add* to SUDO (without + or spaces, e.g., `2349163916314`):', { parse_mode: 'Markdown' });
      } else if (sudoAction === 'remove') {
          userStates[cid].step = 'AWAITING_SUDO_REMOVE_NUMBER';
          return bot.sendMessage(cid, 'Please enter the number to *remove* from SUDO (without + or spaces, e.g., `2349163916314`):', { parse_mode: 'Markdown' });
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

if (action === 'setvarbool') {
  const [varKeyFromCallback, appName, valStr] = [payload, extra, flag]; // <<< CHANGED: Renamed varKey to varKeyFromCallback
  const flagVal = valStr === 'true';
  let newVal;

  // Get the actual bot type to determine the var name for Heroku/DB
  const currentBotType = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter'; // <<< ADDED

  // Determine the actual variable name used on Heroku
  const actualVarNameForHeroku = (currentBotType === 'raganork' && varKeyFromCallback === 'AUTO_STATUS_VIEW') ? 'AUTO_READ_STATUS' : // <<< CHANGED
                                 (currentBotType === 'raganork' && varKeyFromCallback === 'PREFIX') ? 'HANDLERS' : varKeyFromCallback; // <<< CHANGED

  if (actualVarNameForHeroku === 'AUTO_STATUS_VIEW' || actualVarNameForHeroku === 'AUTO_READ_STATUS') newVal = flagVal ? 'true' : 'false'; // <<< CHANGED: Set to true/false
  else if (actualVarNameForHeroku === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
  else newVal = flagVal ? 'true' : 'false';

  try {
    await bot.sendChatAction(cid, 'typing');
    const updateMsg = await bot.sendMessage(cid, `Updating *${actualVarNameForHeroku}* for "*${appName}*"...`, { parse_mode: 'Markdown' }); // <<< CHANGED

    console.log(`[API_CALL] Patching Heroku config vars (boolean) for ${appName}: { ${actualVarNameForHeroku}: '${newVal}' }`); // <<< CHANGED
    const patchResponse = await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { [actualVarNameForHeroku]: newVal }, // <<< CHANGED: Use actualVarNameForHeroku
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
    );
    console.log(`[API_CALL_SUCCESS] Heroku config vars (boolean) patched successfully for ${appName}. Status: ${patchResponse.status}`);


    console.log(`[Flow] setvarbool: Config var updated for "${appName}". Updating bot in user_bots DB.`);
    const herokuConfigVars = (await axios.get(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
    )).data;
    // Pass currentBotType, fetched directly, not from pool query here
    await dbServices.saveUserDeployment(cid, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, currentBotType); // Use dbServices, pass currentBotType


    const baseWaitingText = `Updated *${actualVarNameForHeroku}* for "*${appName}*". Waiting for bot status confirmation...`; // <<< CHANGED
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

        await bot.editMessageText(`Variable "*${actualVarNameForHeroku}*" for "*${appName}*" updated successfully and bot is back online!`, { // <<< CHANGED
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
            `Bot "${appName}" failed to come online after variable "*${actualVarNameForHeroku}*" update: ${err.message}\n\n` + // <<< CHANGED
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
    console.error(`[API_CALL_ERROR] Error updating boolean variable ${actualVarNameForHeroku} for ${appName}:`, errorMsg, e.response?.data); // <<< CHANGED
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

  if (action === 'redeploy_app') {
    const appName = payload;
    const messageId = q.message.message_id;

    const isOwner = (await dbServices.getUserIdByBotName(appName)) === cid; // Use dbServices
    if (cid !== ADMIN_ID && !isOwner) {
        await bot.editMessageText("You are not authorized to redeploy this app.", { chat_id: cid, message_id: messageId });
        return;
    }

    const botTypeForRedeploy = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';

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
            { source_blob: { url: `${botTypeForRedeploy === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL}/tarball/main` } }, // Dynamic URL
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
        await dbServices.saveUserDeployment(cid, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, botTypeForRedeploy); // Use dbServices


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
            await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, true); // Use dbServices
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

// ===================================================================
// REPLACE THE ENTIRE bot.on('channel_post', ...) FUNCTION WITH THIS:
// ===================================================================
bot.on('channel_post', async msg => {
    const TELEGRAM_LISTEN_CHANNEL_ID = '-1002892034574'; // Your channel ID

    if (!msg || !msg.chat || String(msg.chat.id) !== TELEGRAM_LISTEN_CHANNEL_ID) {
        return;
    }

    const text = msg.text?.trim();
    if (!text) {
        return;
    }

    console.log(`[Channel Post] Received: "${text}"`);

    let appName = null;
    let isSuccess = false;
    let isFailure = false;
    let failureReason = 'Bot session became invalid.'; // Default failure reason

    // --- NEW: More flexible RegEx to match Raganork's specific formats ---
    const connectedMatch = text.match(/\[([^\]]+)\]\s*connected/i);
    const logoutMatch = text.match(/User\s+\[([^\]]+)\]\s+has logged out/i);
    const invalidMatch = text.match(/\[([^\]]+)\]\s*invalid/i);

    if (connectedMatch) {
        appName = connectedMatch[1];
        isSuccess = true;
        console.log(`[Channel Post] Matched CONNECTED for app: ${appName}`);

    } else if (logoutMatch) {
        appName = logoutMatch[1];
        isFailure = true;
        failureReason = 'Bot session has logged out.';
        console.log(`[Channel Post] Matched LOGOUT for app: ${appName}`);

    } else if (invalidMatch) {
        isFailure = true;
        failureReason = 'The session ID was detected as invalid.';
        const sessionPart = invalidMatch[1];
        console.log(`[Channel Post] Matched INVALID for session part: ${sessionPart}. Looking up in DB...`);
        try {
            // Find the bot_name where the session_id contains this unique part.
            // This is necessary because the app name isn't in the message itself.
            const res = await pool.query(
                `SELECT bot_name FROM user_bots WHERE session_id LIKE '%' || $1 || '%' ORDER BY created_at DESC LIMIT 1`,
                [sessionPart]
            );
            
            if (res.rows.length > 0) {
                appName = res.rows[0].bot_name;
                console.log(`[Channel Post] DB lookup successful. Matched session part to app: ${appName}`);
            } else {
                 console.warn(`[Channel Post] DB lookup failed. No bot found with a session ID containing '${sessionPart}'.`);
            }
        } catch (dbError) {
            console.error(`[Channel Post] DB Error looking up invalid session part '${sessionPart}':`, dbError);
        }
    }

    if (!appName) {
        console.log(`[Channel Post] Could not determine app name from message. Ignoring.`);
        return;
    }

    // --- Logic to handle the promise or send a notification ---
    const pendingPromise = appDeploymentPromises.get(appName);

    if (pendingPromise) {
        if (isSuccess) {
            pendingPromise.resolve('connected');
        } else if (isFailure) {
            pendingPromise.reject(new Error(failureReason));
        }
        appDeploymentPromises.delete(appName); // Clean up the promise
    } else if (isFailure) {
        // If it wasn't a pending deployment, it's an alert for an existing bot
        const userId = await dbServices.getUserIdByBotName(appName);
        if (userId) {
            const warningMessage = `Your bot "*${escapeMarkdown(appName)}*" has been logged out.\n*Reason:* ${failureReason}\nPlease update your session ID to get it back online.`;
            await bot.sendMessage(userId, warningMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${appName}:${userId}` }]]
                }
            }).catch(e => console.error(`Failed to send failure alert to user ${userId} for bot ${appName}: ${e.message}`));
        }
    }
});
