// bot_utils.js

const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Required for some utilities

// --- Module-level variables to hold dependencies ---
let bot;
let dbServices;
let pool;
let backupPool;
let ADMIN_ID;
let userStates;
let forwardingContext;
let botId;
let userLastSeenNotification;
let adminOnlineMessageIds;
let ONLINE_NOTIFICATION_COOLDOWN_MS;
let GITHUB_LEVANTER_REPO_URL;
let GITHUB_RAGANORK_REPO_URL;
let HEROKU_API_KEY;
let SUPPORT_USERNAME;

// --- State managed within this module ---
const MAINTENANCE_FILE = path.join(__dirname, 'maintenance_status.json');
let isMaintenanceMode = false;
let emojiIndex = 0;
const animatedEmojis = ['🕛', '🕒', '🕡', '🕘', '🕛', '🕒'];
const USERS_PER_PAGE = 8;

/**
 * Initializes the utility module with dependencies from the main bot file.
 * @param {object} dependencies - The dependencies to inject.
 */
function init(dependencies) {
    bot = dependencies.bot;
    dbServices = dependencies.dbServices;
    pool = dependencies.pool;
    backupPool = dependencies.backupPool;
    ADMIN_ID = dependencies.ADMIN_ID;
    userStates = dependencies.userStates;
    forwardingContext = dependencies.forwardingContext;
    botId = dependencies.botId;
    userLastSeenNotification = dependencies.userLastSeenNotification;
    adminOnlineMessageIds = dependencies.adminOnlineMessageIds;
    ONLINE_NOTIFICATION_COOLDOWN_MS = dependencies.ONLINE_NOTIFICATION_COOLDOWN_MS;
    GITHUB_LEVANTER_REPO_URL = dependencies.GITHUB_LEVANTER_REPO_URL;
    GITHUB_RAGANORK_REPO_URL = dependencies.GITHUB_RAGANORK_REPO_URL;
    HEROKU_API_KEY = dependencies.HEROKU_API_KEY;
    SUPPORT_USERNAME = dependencies.SUPPORT_USERNAME;
    console.log('[Utils] bot_utils initialized successfully.');
}

// --- Maintenance Mode ---
function getMaintenanceStatus() {
    return isMaintenanceMode;
}

async function setMaintenanceStatus(status) {
    isMaintenanceMode = status;
    await saveMaintenanceStatusFile(status);
}

async function loadMaintenanceStatusFile() {
    try {
        if (fs.existsSync(MAINTENANCE_FILE)) {
            const data = await fs.promises.readFile(MAINTENANCE_FILE, 'utf8');
            isMaintenanceMode = JSON.parse(data).isMaintenanceMode || false;
            console.log(`[Maintenance] Loaded status: ${isMaintenanceMode ? 'ON' : 'OFF'}`);
        } else {
            await saveMaintenanceStatusFile(false);
            console.log('[Maintenance] Status file not found. Created with default OFF.');
        }
    } catch (error) {
        console.error('[Maintenance] Error loading status:', error.message);
        isMaintenanceMode = false; // Default to off on error
    }
}

async function saveMaintenanceStatusFile(status) {
    try {
        await fs.promises.writeFile(MAINTENANCE_FILE, JSON.stringify({ isMaintenanceMode: status }), 'utf8');
        console.log(`[Maintenance] Saved status: ${status ? 'ON' : 'OFF'}`);
    } catch (error) {
        console.error('[Maintenance] Error saving status:', error.message);
    }
}


// --- Text & Formatting Utilities ---

function escapeMarkdown(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    return text
        .replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
        .replace(/~/g, '\\~').replace(/`/g, '\\`').replace(/>/g, '\\>')
        .replace(/#/g, '\\#').replace(/\+/g, '\\+').replace(/-/g, '\\-')
        .replace(/=/g, '\\=').replace(/\|/g, '\\|').replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}').replace(/\./g, '\\.').replace(/!/g, '\\!');
}

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

function formatExpirationInfo(deployDateStr) {
    if (!deployDateStr) return 'N/A';
    const deployDate = new Date(deployDateStr);
    const fixedExpirationDate = new Date(deployDate.getTime() + 45 * 24 * 60 * 60 * 1000); // 45 days from original deploy
    const now = new Date();
    const expirationDisplay = fixedExpirationDate.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });
    const timeLeftMs = fixedExpirationDate.getTime() - now.getTime();
    const daysLeft = Math.ceil(timeLeftMs / (1000 * 60 * 60 * 24));
    return daysLeft > 0 ? `${expirationDisplay} (Expires in ${daysLeft} days)` : `Expired on ${expirationDisplay}`;
}


// --- Animation & Message Utilities ---

function getAnimatedEmoji() {
    const emoji = animatedEmojis[emojiIndex];
    emojiIndex = (emojiIndex + 1) % animatedEmojis.length;
    return emoji;
}

async function animateMessage(chatId, messageId, baseText) {
    const intervalId = setInterval(async () => {
        try {
            await bot.editMessageText(`${baseText} ${getAnimatedEmoji()}`, {
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

async function sendAnimatedMessage(chatId, baseText) {
    const msg = await bot.sendMessage(chatId, `${baseText}... ${getAnimatedEmoji()}`);
    await new Promise(r => setTimeout(r, 1200));
    return msg;
}

async function startRestartCountdown(chatId, appName, messageId) {
    // ... (implementation from bot.js)
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


// --- UI & View Generators ---

function buildKeyboard(isAdmin) {
    if (isAdmin) {
        return [
            ['Deploy', 'Apps'],
            ['Generate Key', 'Get Session ID'],
            ['/stats', '/copydb'],
            ['/users', '/bapp', `/restoreall`]
        ];
    }
    return [
        ['Get Session ID', 'Deploy'],
        ['My Bots', 'Free Trial'],
        ['FAQ', 'Support'],
        ['More Features']
    ];
}

async function sendUserListPage(chatId, page = 1, messageId = null) {
    if (String(chatId) !== ADMIN_ID) return;
    try {
        const allUsersResult = await pool.query('SELECT DISTINCT user_id FROM user_activity ORDER BY user_id;');
        const allUserIds = allUsersResult.rows.map(row => row.user_id);
        if (allUserIds.length === 0) {
            const text = "No users have interacted with the bot yet.";
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, text);
        }
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
        const options = { chat_id: chatId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [navRow] } };
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

async function sendBappList(chatId, messageId = null, botTypeFilter) {
    try {
        const queryText = `SELECT user_id, app_name, deleted_from_heroku_at FROM user_deployments WHERE bot_type = $1 ORDER BY deploy_date DESC;`;
        const backupResult = await backupPool.query(queryText, [botTypeFilter]);
        const deployments = backupResult.rows;
        if (deployments.length === 0) {
            const text = `No backed-up bots found for the type: *${botTypeFilter.toUpperCase()}*`;
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
            return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        }
        const appButtons = deployments.map(entry => ({
            text: `${entry.deleted_from_heroku_at === null ? '🟢' : '🔴'} ${entry.app_name}`,
            callback_data: `select_bapp:${entry.app_name}:${entry.user_id}`
        }));
        const rows = chunkArray(appButtons, 3);
        const text = `Select a backed-up *${botTypeFilter.toUpperCase()}* app to view details:`;
        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
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

async function sendKeyDeletionList(chatId, messageId = null) {
    if (String(chatId) !== ADMIN_ID) return;
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
        const options = { text: "Select a deployment key to delete:", reply_markup: { inline_keyboard: keyButtons } };
        if (messageId) {
            await bot.editMessageText(options.text, { chat_id: chatId, message_id: messageId, reply_markup: options.reply_markup });
        } else {
            await bot.sendMessage(chatId, options.text, { reply_markup: options.reply_markup });
        }
    } catch (error) {
        console.error("Error sending key deletion list:", error);
        await bot.sendMessage(chatId, "An error occurred while fetching the key list.");
    }
}


// --- Complex Handlers & Business Logic ---

function generateKey() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length: 8 }).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function handleRestoreAllSelection(query) {
    const chatId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    await bot.editMessageText(`Fetching list of restorable ${botType} bots...`, { chat_id: chatId, message_id: query.message.message_id });
    const deployments = await dbServices.getAllDeploymentsFromBackup(botType);
    if (!deployments.length) {
        await bot.editMessageText(`No bots of type "${botType}" found in the backup to restore.`, { chat_id: chatId, message_id: query.message.message_id });
        return;
    }
    let listMessage = `Found *${deployments.length}* ${botType} bot(s) ready for restoration:\n\n`;
    deployments.forEach(dep => {
        listMessage += `• \`${dep.app_name}\` (Owner: \`${dep.user_id}\`)\n`;
    });
    listMessage += `\nThis process will deploy them one-by-one with a 3-minute delay between each success.\n\n*Do you want to proceed?*`;
    await bot.editMessageText(listMessage, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: "Proceed", callback_data: `restore_all_confirm:${botType}` }, { text: "Cancel", callback_data: 'restore_all_cancel' }]] }
    });
}

async function handleRestoreAllConfirm(query) {
    const chatId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    await bot.editMessageText(`Confirmation received. Starting sequential restoration for all *${botType}* bots. This will take a long time...`, {
        chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
    });
    const deployments = await dbServices.getAllDeploymentsFromBackup(botType);
    let successCount = 0, failureCount = 0;
    for (const [index, deployment] of deployments.entries()) {
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

async function notifyAdminUserOnline(msg) {
    if (!msg?.from?.id || msg.from.is_bot) return;
    const userId = msg.from.id.toString();
    if (userId === ADMIN_ID) return;

    const now = Date.now();
    const lastNotified = userLastSeenNotification.get(userId) || 0;
    const lastAdminMessageId = adminOnlineMessageIds.get(userId);
    const userAction = msg.text || (msg.callback_query ? `Callback: ${msg.callback_query.data}` : 'Interacted');
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

    if (now - lastNotified < ONLINE_NOTIFICATION_COOLDOWN_MS && lastAdminMessageId) {
        try {
            await bot.editMessageText(userDetails, { chat_id: ADMIN_ID, message_id: lastAdminMessageId, parse_mode: 'Markdown' });
            userLastSeenNotification.set(userId, now);
        } catch (error) {
            console.error(`Error editing admin notification for user ${userId}:`, error.message);
            // Fallback to sending a new message if editing fails
            const sentMsg = await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'Markdown' }).catch(e => console.error("Send fallback error:", e));
            if (sentMsg) adminOnlineMessageIds.set(userId, sentMsg.message_id);
            userLastSeenNotification.set(userId, now);
        }
    } else {
        try {
            const sentMsg = await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'Markdown' });
            adminOnlineMessageIds.set(userId, sentMsg.message_id);
            userLastSeenNotification.set(userId, now);
        } catch (error) {
            console.error(`Error notifying admin about user ${userId} online:`, error.message);
        }
    }
}


module.exports = {
    init,
    getMaintenanceStatus,
    setMaintenanceStatus,
    loadMaintenanceStatusFile,
    saveMaintenanceStatusFile,
    escapeMarkdown,
    chunkArray,
    formatExpirationInfo,
    getAnimatedEmoji,
    animateMessage,
    sendAnimatedMessage,
    startRestartCountdown,
    buildKeyboard,
    sendUserListPage,
    sendBappList,
    sendKeyDeletionList,
    generateKey,
    handleRestoreAllSelection,
    handleRestoreAllConfirm,
    notifyAdminUserOnline,
};
