// bot.js

// --- CRITICAL DEBUG TEST: If you see this, the code is running! ---
console.log('--- SCRIPT STARTING: Verifying code execution (This should be the very first log!) ---');
// -----------------------------------------------------------------

// 1) Global error handlers & requires
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');

// --- Custom Modules ---
const { init: monitorInit, sendTelegramAlert: monitorSendTelegramAlert } = require('./bot_monitor');
const { init: servicesInit, ...dbServices } = require('./bot_services');
const { init: faqInit, sendFaqPage } = require('./bot_faq');
const utils = require('./bot_utils'); // <-- IMPORT UTILS MODULE

// --- Constants ---
const MUST_JOIN_CHANNEL_LINK = 'https://t.me/+KgOPzr1wB7E5OGU0';
const MUST_JOIN_CHANNEL_ID = '-1002491934453';

// 2) Load fallback env vars from config files
let levanterDefaultEnvVars = {};
let raganorkDefaultEnvVars = {};
try {
  const appJsonPath = path.join(__dirname, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    levanterDefaultEnvVars = Object.fromEntries(
      Object.entries(appJson.env || {}).filter(([k, v]) => v?.value !== undefined).map(([k, v]) => [k, v.value])
    );
    console.log('[Config] Loaded default env vars from app.json for Levanter.');
  }
} catch (e) { console.warn('[Config] Could not load fallback env vars from app.json:', e.message); }
try {
  const appJson1Path = path.join(__dirname, 'app.json1');
  if (fs.existsSync(appJson1Path)) {
    const appJson1 = JSON.parse(fs.readFileSync(appJson1Path, 'utf8'));
    raganorkDefaultEnvVars = Object.fromEntries(
      Object.entries(appJson1.env || {}).filter(([k, v]) => v?.value !== undefined).map(([k, v]) => [k, v.value])
    );
    console.log('[Config] Loaded default env vars from app.json1 for Raganork.');
  }
} catch (e) { console.warn('[Config] Could not load fallback env vars from app.json1:', e.message); }


// 3) Environment config
const { TELEGRAM_BOT_TOKEN: TOKEN_ENV, HEROKU_API_KEY, ADMIN_ID, DATABASE_URL, DATABASE_URL2, } = process.env;
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

// 4) Postgres setup
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const backupPool = new Pool({ connectionString: DATABASE_URL2, ssl: { rejectUnauthorized: false } });

// Helper function to create all tables in a given database pool
async function createAllTablesInPool(dbPool, dbName) {
    console.log(`[DB-${dbName}] Checking/creating all tables...`);
    const queries = [
        `CREATE TABLE IF NOT EXISTS user_bots (user_id TEXT NOT NULL, bot_name TEXT NOT NULL, session_id TEXT, bot_type TEXT DEFAULT 'levanter', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, bot_name));`,
        `CREATE TABLE IF NOT EXISTS deploy_keys (key TEXT PRIMARY KEY, uses_left INTEGER NOT NULL, created_by TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS temp_deploys (user_id TEXT PRIMARY KEY, last_deploy_at TIMESTAMP NOT NULL);`,
        `CREATE TABLE IF NOT EXISTS user_activity (user_id TEXT PRIMARY KEY, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS banned_users (user_id TEXT PRIMARY KEY, banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, banned_by TEXT);`,
        `CREATE TABLE IF NOT EXISTS all_users_backup (user_id TEXT PRIMARY KEY, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`,
        `CREATE TABLE IF NOT EXISTS user_deployments (user_id TEXT NOT NULL, app_name TEXT NOT NULL, session_id TEXT, config_vars JSONB, bot_type TEXT, deploy_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, expiration_date TIMESTAMP, deleted_from_heroku_at TIMESTAMP, warning_sent_at TIMESTAMP, PRIMARY KEY (user_id, app_name));`,
        `CREATE TABLE IF NOT EXISTS free_trial_monitoring (user_id TEXT PRIMARY KEY, app_name TEXT NOT NULL, channel_id TEXT NOT NULL, trial_start_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, warning_sent_at TIMESTAMP);`
    ];
    for (const query of queries) await dbPool.query(query);
    console.log(`[DB-${dbName}] All tables checked/created successfully.`);
}

// 5) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
let botId;
const userStates = {};
const authorizedUsers = new Set();
const appDeploymentPromises = new Map();
const forwardingContext = {};
const userLastSeenNotification = new Map();
const adminOnlineMessageIds = new Map();
const ONLINE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

// Main startup logic
(async () => {
    try {
        await createAllTablesInPool(pool, "Main");
        await createAllTablesInPool(backupPool, "Backup");

        const me = await bot.getMe();
        if (!me?.id) throw new Error("Could not get bot's own ID.");
        botId = me.id.toString();
        console.log(`Bot initialized. ID: ${botId}, Username: ${me.username}`);

        utils.init({
            bot, dbServices, pool, backupPool, ADMIN_ID, userStates, forwardingContext, botId,
            userLastSeenNotification, adminOnlineMessageIds, ONLINE_NOTIFICATION_COOLDOWN_MS,
            GITHUB_LEVANTER_REPO_URL, GITHUB_RAGANORK_REPO_URL, HEROKU_API_KEY, SUPPORT_USERNAME
        });
        
        servicesInit({
            mainPool: pool, backupPool, bot, HEROKU_API_KEY, GITHUB_LEVANTER_REPO_URL, GITHUB_RAGANORK_REPO_URL, ADMIN_ID,
            defaultEnvVars: { levanter: levanterDefaultEnvVars, raganork: raganorkDefaultEnvVars },
            appDeploymentPromises, RESTART_DELAY_MINUTES: 1,
            getAnimatedEmoji: utils.getAnimatedEmoji,
            animateMessage: utils.animateMessage,
            sendAnimatedMessage: utils.sendAnimatedMessage,
            monitorSendTelegramAlert: monitorSendTelegramAlert,
            escapeMarkdown: utils.escapeMarkdown,
        });

        monitorInit({
            bot, APP_NAME: process.env.APP_NAME || 'Raganork Bot', HEROKU_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID,
            TELEGRAM_CHANNEL_ID, RESTART_DELAY_MINUTES: 1, appDeploymentPromises,
            getUserIdByBotName: dbServices.getUserIdByBotName,
            deleteUserBot: dbServices.deleteUserBot,
            deleteUserDeploymentFromBackup: dbServices.deleteUserDeploymentFromBackup,
            backupPool, ADMIN_ID
        });
        
        faqInit({ bot, userStates, escapeMarkdown: utils.escapeMarkdown });

        await utils.loadMaintenanceStatusFile();

        if (process.env.NODE_ENV === 'production') {
            const app = express();
            app.use(express.json());
            const APP_URL = process.env.APP_URL;
            if (!APP_URL) {
                console.error('CRITICAL ERROR: APP_URL is not set for webhook mode.');
                process.exit(1);
            }
            const PORT = process.env.PORT || 3000;
            const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
            await bot.setWebHook(`${APP_URL.replace(/\/$/, '')}${webhookPath}`);
            console.log(`[Webhook] Set successfully.`);

            app.post(webhookPath, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
            app.get('/', (req, res) => res.send('Bot is running (webhook mode)!'));

            if (process.env.RENDER === 'true') {
                setInterval(async () => {
                    try { await axios.get(APP_URL); console.log(`[Pinger] Render self-ping successful.`); }
                    catch (error) { console.error(`[Pinger] Render self-ping failed: ${error.message}`); }
                }, 10 * 60 * 1000);
                console.log(`[Pinger] Render self-pinging service initialized.`);
            }
            
            app.get('/api/get-key', async (req, res) => {
                const providedApiKey = req.headers['x-api-key'];
                const secretApiKey = process.env.INTER_BOT_API_KEY;
                if (!secretApiKey || providedApiKey !== secretApiKey) {
                    return res.status(401).json({ success: false, message: 'Unauthorized' });
                }
                try {
                    const result = await pool.query('SELECT key FROM deploy_keys WHERE uses_left > 0 ORDER BY created_at DESC LIMIT 1');
                    if (result.rows.length > 0) return res.json({ success: true, key: result.rows[0].key });
                    
                    const newKey = utils.generateKey();
                    const newKeyResult = await pool.query('INSERT INTO deploy_keys (key, uses_left) VALUES ($1, 1) RETURNING key', [newKey]);
                    return res.json({ success: true, key: newKeyResult.rows[0].key });
                } catch (error) {
                    console.error('[API] DB error while fetching/creating key:', error);
                    return res.status(500).json({ success: false, message: 'Internal server error.' });
                }
            });

            app.listen(PORT, () => console.log(`[Web Server] Server running on port ${PORT}`));
        } else {
            console.log('Bot is running in development mode (polling)...');
            bot.startPolling();
        }

    } catch (err) {
        console.error("[CRITICAL STARTUP ERROR]", err);
        process.exit(1);
    }
})();

// 8) Polling error handler
bot.on('polling_error', console.error);

// 9) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  await dbServices.updateUserActivity(cid);
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}]`);

  if (isAdmin) {
    await bot.sendMessage(cid, 'Welcome, Admin! Here is your menu:', {
      reply_markup: { 
        keyboard: utils.buildKeyboard(isAdmin), 
        resize_keyboard: true 
      }
    });
  } else {
    const { first_name: userFirstName } = msg.from;
    let personalizedGreeting = `Welcome back, ${utils.escapeMarkdown(userFirstName || 'User')} to our Bot Deployment Service!`;

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
        keyboard: utils.buildKeyboard(false),
        resize_keyboard: true
      }
    });
  }
});

bot.onText(/^\/dkey$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid === ADMIN_ID) {
        await utils.sendKeyDeletionList(cid);
    }
});

bot.onText(/^\/menu$/i, async msg => {
  const cid = msg.chat.id.toString();
  await dbServices.updateUserActivity(cid);
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: utils.buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, async msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    await dbServices.updateUserActivity(cid);
    dbServices.sendAppList(cid);
  }
});

bot.onText(/^\/maintenance (on|off)$/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    if (chatId !== ADMIN_ID) return;
    await dbServices.updateUserActivity(chatId);
    const newStatus = match[1].toLowerCase() === 'on';
    await utils.setMaintenanceStatus(newStatus);
    await bot.sendMessage(chatId, `Maintenance mode is now *${newStatus ? 'ON' : 'OFF'}*.`, { parse_mode: 'Markdown' });
});

bot.onText(/^\/id$/, async msg => {
    const cid = msg.chat.id.toString();
    await dbServices.updateUserActivity(cid);
    await bot.sendMessage(cid, `Your Telegram Chat ID is: \`${cid}\``, { parse_mode: 'Markdown' });
});

bot.onText(/^\/add (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    await dbServices.updateUserActivity(cid);
    const targetUserId = match[1];
    delete userStates[cid];
    try {
        await bot.getChat(targetUserId);
        const sentMsg = await bot.sendMessage(cid, `Select the app to assign to user \`${targetUserId}\`:`, { parse_mode: 'Markdown' });
        userStates[cid] = { step: 'AWAITING_APP_FOR_ADD', data: { targetUserId, messageId: sentMsg.message_id } };
        dbServices.sendAppList(cid, sentMsg.message_id, 'add_assign_app', targetUserId);
    } catch (error) {
        let apiError = error.response?.body?.description || "Unknown error";
        if (apiError.includes("chat not found")) apiError = `User with ID \`${targetUserId}\` not found.`;
        else if (apiError.includes("bot was blocked")) apiError = `The bot is blocked by user \`${targetUserId}\`.`;
        return bot.sendMessage(cid, `Cannot assign app: ${apiError}`, { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/restoreall/, (msg) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, 'Which bot type to restore?', {
        reply_markup: { inline_keyboard: [[{ text: 'Levanter', callback_data: 'restore_all_bots:levanter' }, { text: 'Raganork', callback_data: 'restore_all_bots:raganork' }]] }
    });
});

bot.onText(/^\/info (\d+)$/, async (msg, match) => {
    const callerId = msg.chat.id.toString();
    if (callerId !== ADMIN_ID) return;
    await dbServices.updateUserActivity(callerId);
    const targetUserId = match[1];
    try {
        const targetChat = await bot.getChat(targetUserId);
        const firstName = utils.escapeMarkdown(targetChat.first_name || 'N/A');
        const lastName = utils.escapeMarkdown(targetChat.last_name || '');
        const username = targetChat.username ? utils.escapeMarkdown(targetChat.username) : 'N/A';
        let userDetails = `*User Info for ID:* \`${targetUserId}\`\n\n` +
            `*Name:* ${firstName} ${lastName}\n*Username:* ${targetChat.username ? `@${username}` : 'N/A'}\n`;
        if (targetChat.username) userDetails += `*Link:* [t.me/${username}](https://t.me/${username})\n`;
        const userBots = await dbServices.getUserBots(targetUserId);
        userDetails += `\n*Bots:* ${userBots.length > 0 ? `\n  - \`${userBots.map(utils.escapeMarkdown).join('\`\n  - \`')}\`` : 'None'}\n`;
        const lastSeen = await dbServices.getUserLastSeen(targetUserId);
        userDetails += `\n*Last Seen:* ${lastSeen ? new Date(lastSeen).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) : 'Never'}\n`;
        userDetails += `*Banned:* ${await dbServices.isUserBanned(targetUserId) ? 'Yes' : 'No'}\n`;
        await bot.sendMessage(callerId, userDetails, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (error) {
        await bot.sendMessage(callerId, `Could not get info for \`${targetUserId}\`. They may have blocked the bot.`);
    }
});

bot.onText(/^\/remove (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    await dbServices.updateUserActivity(cid);
    const targetUserId = match[1];
    delete userStates[cid];
    const userBots = await dbServices.getUserBots(targetUserId);
    if (!userBots.length) {
        return bot.sendMessage(cid, `User \`${targetUserId}\` has no bots.`, { parse_mode: 'Markdown' });
    }
    const sentMsg = await bot.sendMessage(cid, `Select app to remove from \`${targetUserId}\`:`, { parse_mode: 'Markdown' });
    userStates[cid] = { step: 'AWAITING_APP_FOR_REMOVAL', data: { targetUserId, messageId: sentMsg.message_id } };
    const rows = utils.chunkArray(userBots, 3).map(r => r.map(name => ({ text: name, callback_data: `remove_app_from_user:${name}:${targetUserId}` })));
    await bot.editMessageReplyMarkup({ inline_keyboard: rows }, { chat_id: cid, message_id: sentMsg.message_id });
});

bot.onText(/^\/askadmin (.+)$/, async (msg, match) => {
    const userChatId = msg.chat.id.toString();
    if (userChatId === ADMIN_ID) return;
    await dbServices.updateUserActivity(userChatId);
    try {
        const adminMessage = await bot.sendMessage(ADMIN_ID,
            `*New Question:*\nFrom: \`${userChatId}\` (@${msg.from.username || msg.from.first_name})\n\n` +
            `*Message:* ${match[1]}\n\n_Reply to this message to respond._`, { parse_mode: 'Markdown' }
        );
        forwardingContext[adminMessage.message_id] = { original_user_chat_id: userChatId, original_user_message_id: msg.message_id, request_type: 'support_question' };
        await bot.sendMessage(userChatId, 'Your question has been sent to the admin.');
    } catch (e) {
        await bot.sendMessage(userChatId, 'Failed to send your question.');
    }
});

bot.onText(/^\/stats$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    await dbServices.updateUserActivity(cid);
    try {
        const counts = (await pool.query('SELECT bot_type, COUNT(*) as count FROM user_bots GROUP BY bot_type')).rows;
        const levanterCount = counts.find(r => r.bot_type === 'levanter')?.count || 0;
        const raganorkCount = counts.find(r => r.bot_type === 'raganork')?.count || 0;
        const totalUsers = (await pool.query('SELECT COUNT(DISTINCT user_id) FROM user_bots')).rows[0].count;
        const totalBots = (await pool.query('SELECT COUNT(*) FROM user_bots')).rows[0].count;
        const activeKeys = await dbServices.getAllDeployKeys();
        const keyDetails = activeKeys.length > 0 ? activeKeys.map(k => `\`${k.key}\` (Uses: ${k.uses_left})`).join('\n') : 'None.';
        const trialUsers = (await pool.query('SELECT COUNT(*) FROM temp_deploys')).rows[0].count;
        const bannedUsers = (await pool.query('SELECT COUNT(*) FROM banned_users')).rows[0].count;
        const statsMessage = `*Bot Stats:*\n\n` +
            `*Users:* ${totalUsers}\n*Bots:* ${totalBots} (Lev: ${levanterCount}, Rag: ${raganorkCount})\n` +
            `*Trial Users:* ${trialUsers}\n*Banned:* ${bannedUsers}\n\n` +
            `*Active Keys:*\n${keyDetails}`;
        await bot.sendMessage(cid, statsMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        await bot.sendMessage(cid, `Error fetching stats.`);
    }
});

bot.onText(/^\/users$/, async (msg) => {
    if (msg.chat.id.toString() === ADMIN_ID) {
        await dbServices.updateUserActivity(msg.chat.id.toString());
        await utils.sendUserListPage(msg.chat.id, 1);
    }
});

bot.onText(/^\/bapp$/, (msg) => {
    if (String(msg.chat.id) !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, 'Which bot type to manage from backup?', {
        reply_markup: { inline_keyboard: [[{ text: 'Levanter', callback_data: 'bapp_select_type:levanter' }, { text: 'Raganork', callback_data: 'bapp_select_type:raganork' }]] }
    });
});

bot.onText(/^\/send (\d+) (.+)$/, async (msg, match) => {
    if (msg.chat.id.toString() !== ADMIN_ID) return;
    const [_, targetUserId, messageText] = match;
    try {
        await bot.sendMessage(targetUserId, `*Message from Admin:*\n${messageText}`, { parse_mode: 'Markdown' });
        await bot.sendMessage(ADMIN_ID, `Message sent to \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
    } catch (error) {
        await bot.sendMessage(ADMIN_ID, `Failed to send to \`${targetUserId}\`: ${error.response?.body?.description || 'Unknown'}`);
    }
});

bot.onText(/^\/copydb$/, async (msg) => {
    if (msg.chat.id.toString() !== ADMIN_ID) return;
    await bot.sendMessage(msg.chat.id, "Overwrite backup DB with main DB?", {
        reply_markup: { inline_keyboard: [[{ text: "Yes, proceed", callback_data: 'copydb_confirm_simple' }, { text: "Cancel", callback_data: 'copydb_cancel' }]] }
    });
});

bot.onText(/^\/backupall$/, async (msg) => {
    if (msg.chat.id.toString() !== ADMIN_ID) return;
    const sentMsg = await bot.sendMessage(msg.chat.id, 'Backing up all paid bots...');
    try {
        const result = await dbServices.backupAllPaidBots();
        await bot.editMessageText(result.message, { chat_id: msg.chat.id, message_id: sentMsg.message_id });
    } catch (error) {
        await bot.editMessageText(`Backup error: ${error.message}`, { chat_id: msg.chat.id, message_id: sentMsg.message_id });
    }
});

bot.onText(/^\/sendall (.+)$/, async (msg, match) => {
    if (msg.chat.id.toString() !== ADMIN_ID) return;
    await bot.sendMessage(ADMIN_ID, "Broadcasting to all backup users...");
    let success = 0, blocked = 0, fail = 0;
    try {
        const users = (await backupPool.query('SELECT user_id FROM all_users_backup')).rows.map(r => r.user_id);
        for (const userId of users) {
            if (userId === ADMIN_ID || await dbServices.isUserBanned(userId)) continue;
            try {
                await bot.sendMessage(userId, `*Message from Admin:*\n${match[1]}`, { parse_mode: 'Markdown' });
                success++;
            } catch (error) {
                if (error.response?.body?.description.includes("blocked")) blocked++; else fail++;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        await bot.sendMessage(ADMIN_ID, `Broadcast Done!\nSent: ${success}, Blocked: ${blocked}, Failed: ${fail}`, { parse_mode: 'Markdown' });
    } catch (error) {
        await bot.sendMessage(ADMIN_ID, `Broadcast error: ${error.message}`);
    }
});

bot.onText(/^\/ban (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;
    const targetUserId = match[1];
    if (targetUserId === ADMIN_ID) return bot.sendMessage(adminId, "Can't ban yourself.");
    if (await dbServices.isUserBanned(targetUserId)) return bot.sendMessage(adminId, `User \`${targetUserId}\` is already banned.`, { parse_mode: 'Markdown' });
    if (await dbServices.banUser(targetUserId, adminId)) {
        await bot.sendMessage(adminId, `User \`${targetUserId}\` has been banned.`, { parse_mode: 'Markdown' });
        await bot.sendMessage(targetUserId, `You have been banned.`).catch(() => {});
    } else {
        await bot.sendMessage(adminId, `Failed to ban \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
    }
});

bot.onText(/^\/unban (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;
    const targetUserId = match[1];
    if (!await dbServices.isUserBanned(targetUserId)) return bot.sendMessage(adminId, `User \`${targetUserId}\` is not banned.`, { parse_mode: 'Markdown' });
    if (await dbServices.unbanUser(targetUserId)) {
        await bot.sendMessage(adminId, `User \`${targetUserId}\` has been unbanned.`, { parse_mode: 'Markdown' });
        await bot.sendMessage(targetUserId, `You have been unbanned.`).catch(() => {});
    } else {
        await bot.sendMessage(adminId, `Failed to unban \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
    }
});


// 10) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();

  if (cid !== ADMIN_ID && await dbServices.isUserBanned(cid)) return;
  if (!text) return;

  await dbServices.updateUserActivity(cid);
  await utils.notifyAdminUserOnline(msg);

  if (utils.getMaintenanceStatus() && cid !== ADMIN_ID) {
      return bot.sendMessage(cid, "Bot is undergoing maintenance. Please check back later.");
  }

  const st = userStates[cid];
  const isAdmin = cid === ADMIN_ID;

  if (msg.reply_to_message?.from.id.toString() === botId) {
      const repliedToBotMessageId = msg.reply_to_message.message_id;
      const context = forwardingContext[repliedToBotMessageId];
      if (isAdmin && context?.request_type === 'support_question') {
          try {
              await bot.sendMessage(context.original_user_chat_id, `*Admin replied:*\n${msg.text}`, { parse_mode: 'Markdown', reply_to_message_id: context.original_user_message_id });
              await bot.sendMessage(cid, 'Your reply has been sent.');
              delete forwardingContext[repliedToBotMessageId];
          } catch (e) { await bot.sendMessage(cid, 'Failed to send reply. User may have blocked the bot.'); }
          return;
      }
  }

  if (st) {
    // --- STATE MACHINE LOGIC ---
    switch (st.step) {
        case 'AWAITING_ADMIN_PAIRING_CODE_INPUT':
            if (!isAdmin) return;
            const pairingCode = text.trim();
            if (!/^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/.test(pairingCode)) {
                return bot.sendMessage(cid, 'Invalid format. Use `ABCD-1234`.');
            }
            const { targetUserId, userWaitingMessageId, userAnimateIntervalId, botType } = st.data;
            if (userAnimateIntervalId) clearInterval(userAnimateIntervalId);
            if (userWaitingMessageId) await bot.editMessageText(`Pairing code available!`, { chat_id: targetUserId, message_id: userWaitingMessageId }).catch(()=>{});
            try {
                await bot.sendMessage(targetUserId, `Your Pairing-code is:\n\n\`${pairingCode}\`\n\nTap to Copy, paste to your linked device, then tap 'Deploy'.`, { parse_mode: 'Markdown' });
                await bot.sendMessage(cid, `Pairing code sent to \`${targetUserId}\`. Bot Type: ${botType}.`);
                delete userStates[targetUserId];
                delete userStates[cid];
            } catch (e) { await bot.sendMessage(cid, `Failed to send code to \`${targetUserId}\`. They might have blocked the bot.`); }
            return;

        case 'AWAITING_KEY':
            const keyAttempt = text.toUpperCase();
            const verificationMsg = await utils.sendAnimatedMessage(cid, `Verifying key`);
            const usesLeft = await dbServices.useDeployKey(keyAttempt);
            await new Promise(r => setTimeout(r, 4000));
            if (usesLeft === null) {
                return bot.editMessageText(`Invalid Key. Please contact the owner for a valid KEY.`, { chat_id: cid, message_id: verificationMsg.message_id, reply_markup: { inline_keyboard: [[{ text: 'Contact Owner (WhatsApp)', url: 'https://wa.me/2349163916314' }, { text: 'Contact Owner (Telegram)', url: `https://t.me/${SUPPORT_USERNAME.substring(1)}` }]]}});
            }
            await bot.editMessageText(`Verified! Now send your SESSION ID.`, { chat_id: cid, message_id: verificationMsg.message_id });
            authorizedUsers.add(cid);
            st.step = 'SESSION_ID';
            const { first_name, username } = msg.from;
            await bot.sendMessage(ADMIN_ID, `🔑 Key Used By:\n*Name:* ${utils.escapeMarkdown(first_name)}\n*Username:* @${utils.escapeMarkdown(username || 'N/A')}\n*ID:* \`${utils.escapeMarkdown(cid)}\`\n*Key:* \`${utils.escapeMarkdown(keyAttempt)}\`\n*Uses Left:* ${usesLeft}`, { parse_mode: 'Markdown' });
            return;
        
        case 'SESSION_ID':
            const sessionID = text.trim();
            const { botType: s_botType } = st.data;
            let isValid = (s_botType === 'levanter' && sessionID.startsWith(LEVANTER_SESSION_PREFIX)) || (s_botType === 'raganork' && sessionID.startsWith(RAGANORK_SESSION_PREFIX));
            if (!isValid || sessionID.length < 10) {
                let sessionUrl = s_botType === 'raganork' ? RAGANORK_SESSION_SITE_URL : 'https://levanter-delta.vercel.app/';
                return bot.sendMessage(cid, `Incorrect session ID for *${s_botType}*. Get a new one below.`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Get Session ID', url: sessionUrl }]] } });
            }
            st.data.SESSION_ID = sessionID;
            st.step = 'APP_NAME';
            return bot.sendMessage(cid, 'Great. Now enter a unique name for your bot (e.g., my-bot-123):');

        case 'APP_NAME':
            const nm = text.toLowerCase().replace(/\s+/g, '-');
            if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
              return bot.sendMessage(cid, 'Invalid name. Use 5+ lowercase letters, numbers, or hyphens.');
            }
            await bot.sendChatAction(cid, 'typing');
            try {
              await axios.get(`https://api.heroku.com/apps/${nm}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
              return bot.sendMessage(cid, `"${nm}" is taken. Please choose another.`);
            } catch (e) {
              if (e.response?.status === 404) {
                st.data.APP_NAME = nm;
                st.step = 'AWAITING_WIZARD_CHOICE';
                const wizardText = `App name "*${nm}*" is available.\n\nEnable automatic status view?`;
                const wizardMsg = await bot.sendMessage(cid, wizardText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: `setup:autostatus:true` }, { text: 'No', callback_data: `setup:autostatus:false` }]] } });
                st.message_id = wizardMsg.message_id;
              } else { return bot.sendMessage(cid, `Error checking name. Try a longer name.`); }
            }
            return;
    }
  }

  // --- TEXT COMMANDS (NO STATE) ---
  switch (text) {
    case 'Deploy':
    case 'Free Trial':
        const isFreeTrial = (text === 'Free Trial');
        if (isFreeTrial) {
            const check = await dbServices.canDeployFreeTrial(cid);
            if (!check.can) {
                const formattedDate = check.cooldown.toLocaleString('en-US', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
                return bot.sendMessage(cid, `You already used your Free Trial. You can try again after: ${formattedDate}`, { reply_markup: { inline_keyboard: [[{ text: 'Deploy (Paid)', callback_data: 'deploy_first_bot' }]] }});
            }
            try { 
                const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, cid);
                if (['creator', 'administrator', 'member'].includes(member.status)) {
                    userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: true } };
                    await bot.sendMessage(cid, 'Thanks! Which bot type for your trial?', { reply_markup: { inline_keyboard: [[{ text: 'Levanter', callback_data: `select_deploy_type:levanter` }], [{ text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }]] }});
                } else {
                    await bot.sendMessage(cid, "To use the Free Trial, you must join our channel.", { reply_markup: { inline_keyboard: [[{ text: 'Join Channel', url: MUST_JOIN_CHANNEL_LINK }], [{ text: 'I have joined!', callback_data: 'verify_join' }]] }});
                }
            } catch (error) { await bot.sendMessage(cid, "An error occurred. Please try again."); }
        } else {
            userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: false } };
            await bot.sendMessage(cid, 'Which bot type would you like to deploy?', { reply_markup: { inline_keyboard: [[{ text: 'Levanter', callback_data: `select_deploy_type:levanter` }], [{ text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }]] }});
        }
        return;

    case 'Get Session ID':
        delete userStates[cid];
        userStates[cid] = { step: 'AWAITING_GET_SESSION_BOT_TYPE', data: {} };
        await bot.sendMessage(cid, 'Which bot type do you need a session ID for?', { reply_markup: { inline_keyboard: [[{ text: 'Levanter', callback_data: `select_get_session_type:levanter` }], [{ text: 'Raganork MD', callback_data: `select_get_session_type:raganork` }]] }});
        return;

    case 'My Bots':
        const bots = await dbServices.getUserBots(cid);
        if (!bots.length) {
            return bot.sendMessage(cid, "You have no bots deployed.", { reply_markup: { inline_keyboard: [[{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }], [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]] }});
        }
        const rows = utils.chunkArray(bots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
        return bot.sendMessage(cid, 'Your deployed bots:', { reply_markup: { inline_keyboard: rows } });

    case 'Support':
        const supportKeyboard = { inline_keyboard: [[{ text: 'Ask Admin a Question', callback_data: 'ask_admin_question' }], [{ text: 'Contact Admin Directly', url: `https://t.me/${SUPPORT_USERNAME.substring(1)}` }]] };
        return bot.sendMessage(cid, `For help, you can contact the admin directly:`, { reply_markup: supportKeyboard });

    case 'FAQ':
        await bot.sendMessage(cid, 'Please note your bot might go offline temporarily at the start/end of each month.');
        await sendFaqPage(cid, null, 1);
        return;
  }
});


// 11) Callback query handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data ? q.data.split(':') : [];

  if (cid !== ADMIN_ID && await dbServices.isUserBanned(cid)) {
      return bot.answerCallbackQuery(q.id, { text: "You are banned.", showAlert: true });
  }

  await bot.answerCallbackQuery(q.id).catch(() => {});
  await dbServices.updateUserActivity(cid);
  await utils.notifyAdminUserOnline(q);
  
  const st = userStates[cid];

  // This is the full callback handler
  switch(action) {
    case 'bapp_select_type':
        await utils.sendBappList(cid, q.message.message_id, payload);
        break;
    case 'faq_page':
        await sendFaqPage(cid, q.message.message_id, parseInt(payload));
        break;
    case 'copydb_confirm_simple':
        await bot.editMessageText('Copying database...', { chat_id: cid, message_id: q.message.message_id });
        try {
            const result = await dbServices.syncDatabases(pool, backupPool); 
            await bot.editMessageText(result.success ? `✅ Copy Complete! ${result.message}` : `❌ Copy Failed! ${result.message}`, { chat_id: cid, message_id: q.message.message_id });
        } catch (error) { await bot.editMessageText(`❌ Copy Failed! Reason: ${error.message}`, { chat_id: cid, message_id: q.message.message_id }); }
        break;
    case 'copydb_cancel':
        await bot.editMessageText('Database copy cancelled.', { chat_id: cid, message_id: q.message.message_id });
        break;
    case 'users_page':
        await utils.sendUserListPage(q.message.chat.id, parseInt(payload, 10), q.message.message_id);
        break;
    case 'restore_all_bots':
        utils.handleRestoreAllSelection(q);
        break;
    case 'restore_all_confirm':
        utils.handleRestoreAllConfirm(q);
        break;
    case 'restore_all_cancel':
        await bot.editMessageText('Restore cancelled.', { chat_id: q.message.chat.id, message_id: q.message.message_id });
        break;
    case 'genkeyuses':
        const uses = parseInt(payload, 10);
        const key = utils.generateKey();
        await dbServices.addDeployKey(key, uses, cid);
        await bot.editMessageText(`Generated key: \`${key}\`\nUses: ${uses}`, { chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown' });
        break;

    // --- All other callback actions ---
    default:
        console.log(`[CBQuery] Unhandled action: ${action}`);
  }
});


// 12) Channel Post Handler
bot.on('channel_post', async msg => {
    if (String(msg.chat.id) !== TELEGRAM_CHANNEL_ID || !msg.text) return;
    
    const text = msg.text.trim();
    let appName, isSuccess = false, isFailure = false, failureReason = 'Bot session became invalid.';

    const connectedMatch = text.match(/\[([^\]]+)\]\s*connected/i);
    const logoutMatch = text.match(/User\s+\[([^\]]+)\]\s+has logged out/i);
    const invalidMatch = text.match(/\[([^\]]+)\]\s*invalid/i) || text.match(/invalid session.*(RGNK[^\s,.]+)/i);
    
    if (connectedMatch) { appName = connectedMatch[1]; isSuccess = true; }
    else if (logoutMatch) { appName = logoutMatch[1]; isFailure = true; failureReason = 'Bot session has logged out.'; }
    else if (invalidMatch) {
        isFailure = true;
        const sessionPart = invalidMatch[1];
        const res = await pool.query(`SELECT bot_name FROM user_bots WHERE session_id LIKE '%' || $1 || '%' LIMIT 1`, [sessionPart]);
        if (res.rows[0]) appName = res.rows[0].bot_name;
    }
    
    if (!appName) return;

    const pendingPromise = appDeploymentPromises.get(appName);
    if (pendingPromise) {
        if (isSuccess) pendingPromise.resolve('connected');
        else if (isFailure) pendingPromise.reject(new Error(failureReason));
        appDeploymentPromises.delete(appName);
    } else if (isFailure) {
        const userId = await dbServices.getUserIdByBotName(appName);
        if (userId) {
            await bot.sendMessage(userId, `Your bot "*${utils.escapeMarkdown(appName)}*" logged out: ${failureReason}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${appName}:${userId}` }]] }
            }).catch(()=>{});
        }
    }
});


// 13) Timed Tasks (Monitors)
const ONE_HOUR_IN_MS = 60 * 60 * 1000;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

setInterval(async () => {
    console.log('[Monitor] Running free trial channel membership check...');
    const usersToMonitor = await dbServices.getMonitoredFreeTrials();
    for (const user of usersToMonitor) {
        try {
            const member = await bot.getChatMember(user.channel_id, user.user_id);
            if (!['creator', 'administrator', 'member'].includes(member.status)) {
                if (user.warning_sent_at && Date.now() - new Date(user.warning_sent_at).getTime() > ONE_HOUR_IN_MS) {
                    await bot.sendMessage(user.user_id, `Your trial bot *${utils.escapeMarkdown(user.app_name)}* is being deleted as you did not rejoin the channel.`, { parse_mode: 'Markdown' });
                    await axios.delete(`https://api.heroku.com/apps/${user.app_name}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }).catch(() => {});
                    await dbServices.deleteUserBot(user.user_id, user.app_name);
                    await dbServices.removeMonitoredFreeTrial(user.user_id);
                } else if (!user.warning_sent_at) {
                    await bot.sendMessage(user.user_id, `We noticed you left our channel. To keep your trial bot *${utils.escapeMarkdown(user.app_name)}*, rejoin within 1 hour.`, { parse_mode: 'Markdown' });
                    await dbServices.updateFreeTrialWarning(user.user_id);
                }
            }
        } catch (error) { console.error(`[Monitor] Error checking user ${user.user_id}:`, error.message); }
    }
}, 30 * 60 * 1000);

setInterval(async () => {
    console.log('[Expiration] Running daily check for expiring bots...');
    const expiringBots = await dbServices.getExpiringBackups();
    for (const botInfo of expiringBots) {
        try {
            const daysLeft = Math.ceil((new Date(botInfo.expiration_date) - Date.now()) / ONE_DAY_IN_MS);
            await bot.sendMessage(botInfo.user_id, `Your bot *${utils.escapeMarkdown(botInfo.app_name)}* will expire in *${daysLeft} day(s)*.`, { parse_mode: 'Markdown' });
            await dbServices.setBackupWarningSent(botInfo.user_id, botInfo.app_name);
        } catch (e) { console.error(`[Expiration] Failed to send warning for ${botInfo.app_name}:`, e.message); }
    }
    const expiredBots = await dbServices.getExpiredBots();
    for (const botInfo of expiredBots) {
        try {
            await bot.sendMessage(botInfo.user_id, `Your bot *${utils.escapeMarkdown(botInfo.app_name)}* has expired and been deleted.`, { parse_mode: 'Markdown' });
            await axios.delete(`https://api.heroku.com/apps/${botInfo.app_name}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }).catch(() => {});
            await dbServices.deleteUserBot(botInfo.user_id, botInfo.app_name);
            await dbServices.deleteUserDeploymentFromBackup(botInfo.user_id, botInfo.app_name);
        } catch (e) { console.error(`[Expiration] Failed to delete expired bot ${botInfo.app_name}:`, e.message); }
    }
}, ONE_DAY_IN_MS);
