// bot_monitor.js

const axios = require('axios');
const fs = require('fs'); // Still needed for maintenance status if moved here, or ensure loaded in bot.js
const path = require('path');

// --- Global variables for log interception and state ---
let originalStdoutWrite;
let originalStderrWrite;
let stdoutBuffer = '';
let stderrBuffer = '';

let lastLogoutMessageId = null;
let lastLogoutAlertTime = null; // Used for 24-hr cooldown on logout alerts

// --- Parameters that will be passed from bot.js ---
let moduleParams = {}; // Will hold bot, config, keys, IDs, DB functions, etc.

/**
 * Initializes the bot monitoring system.
 * This function should be called once from bot.js after the bot and DB connections are established.
 * @param {object} params - An object containing all necessary dependencies.
 * @param {object} params.bot - The TelegramBot instance.
 * @param {object} params.config - The config object from bot.js (e.g., { SESSION, logger }).
 * @param {string} params.APP_NAME - The Heroku app name.
 * @param {string} params.HEROKU_API_KEY - The Heroku API key.
 * @param {string} params.TELEGRAM_BOT_TOKEN - The Telegram bot token.
 * @param {string} params.TELEGRAM_USER_ID - The Telegram user ID for admin alerts.
 * @param {string} params.TELEGRAM_CHANNEL_ID - The Telegram channel ID for broadcast alerts.
 * @param {number} params.RESTART_DELAY_MINUTES - Delay before restarting after logout.
 * @param {Map} params.appDeploymentPromises - Map to resolve/reject build promises.
 * @param {function} params.getUserIdByBotName - DB function to get user ID by bot name.
 * @param {function} params.deleteUserBot - DB function to delete bot from main DB.
 * @param {function} params.deleteUserDeploymentFromBackup - DB function to delete deployment from backup DB.
 * @param {object} params.backupPool - The PostgreSQL pool for the backup database (DATABASE_URL2).
 */
function init(params) {
    moduleParams = params; // Store parameters for use by other functions via closure

    // --- CRITICAL DEBUG TEST: If you see this, the bot_monitor.js is loading! ---
    originalStdoutWrite.apply(process.stdout, ['--- bot_monitor.js initialized and active! ---\n']);
    // -----------------------------------------------------------------

    // === LOW-LEVEL LOG INTERCEPTION START ===
    // Store original write functions (already stored globally at file start)
    originalStdoutWrite = process.stdout.write;
    originalStderrWrite = process.stderr.write;

    // Override process.stdout.write
    process.stdout.write = (chunk, encoding, callback) => {
        stdoutBuffer += chunk.toString();
        // Process line by line
        let newlineIndex;
        while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
            const line = stdoutBuffer.substring(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
            handleLogLine(line, 'stdout');
        }
        return originalStdoutWrite.apply(process.stdout, [chunk, encoding, callback]);
    };

    // Override process.stderr.write
    process.stderr.write = (chunk, encoding, callback) => {
        stderrBuffer += chunk.toString();
        // Process line by line
        let newlineIndex;
        while ((newlineIndex = stderrBuffer.indexOf('\n')) !== -1) {
            const line = stderrBuffer.substring(0, newlineIndex);
            stderrBuffer = stderrBuffer.substring(newlineIndex + 1);
            handleLogLine(line, 'stderr');
        }
        return originalStderrWrite.apply(process.stderr, [chunk, encoding, callback]);
    };
    // === LOW-LEVEL LOG INTERCEPTION END ===

    // === Initialize lastLogoutAlertTime from Heroku config vars ===
    loadLastLogoutAlertTime();

    // === Start Scheduled Tasks ===
    // Every hour for logout reminders
    setInterval(checkAndRemindLoggedOutBots, 60 * 60 * 1000);
    // Every 24 hours for expiration check (based on original deploy date)
    setInterval(checkAndExpireBots, 24 * 60 * 60 * 1000);
}


// Function to process each log line captured by the overrides
function handleLogLine(line, streamType) {
    // This console.log will go to original stdout/stderr, avoiding recursion
    originalStdoutWrite.apply(process.stdout, [`[DEBUG - ${streamType.toUpperCase()} INTERCEPTED] Line: "${line.trim()}"\n`]);

    // Check for 'Bot started' message
    if (line.includes('Bot initialization complete') || line.includes('Bot started')) {
        originalStdoutWrite.apply(process.stdout, ['[DEBUG] "Bot started" or "initialization complete" message detected!\n']);
        sendBotConnectedAlert().catch(err => originalStderrWrite.apply(process.stderr, [`Error sending connected alert: ${err.message}\n`]));
    }

    // Check for logout patterns
    // Using a broader set of patterns to catch various logout scenarios
    const logoutPatterns = [
        'ERROR: Failed to initialize bot. Details: No valid session found',
        'SESSION LOGGED OUT. Please rescan QR and update SESSION.',
        'Reason: logout', // Common in some bot frameworks for logout
        'Authentication Error', // Generic auth error that might lead to logout
        // New Raganork-specific logout pattern
        'User [', ' has logged out.', '] invalid', // Checking for parts of "User [botname] has logged out. [sessionid] invalid"
    ];

    if (logoutPatterns.some(pattern => line.includes(pattern))) {
        originalStderrWrite.apply(process.stderr, ['[DEBUG] Logout pattern detected in log!\n']);

        // Attempt to extract session ID more generally (captures any word after "for " or within brackets)
        let specificSessionId = null;
        const matchForSession = line.match(/for (\S+)\./); // Catches "for XYZ."
        if (matchForSession) specificSessionId = matchForSession[1];
        else {
            const raganorkLogoutMatch = line.match(/\[([^\]]+)\] invalid/i); // Catches "[session_id] invalid"
            if (raganorkLogoutMatch) specificSessionId = raganorkLogoutMatch[1];
        }

        sendInvalidSessionAlert(specificSessionId).catch(err => originalStderrWrite.apply(process.stderr, [`Error sending logout alert: ${err.message}\n`]));

        // Trigger restart, but only if HEROKU_API_KEY is set for production
        if (moduleParams.HEROKU_API_KEY) {
            originalStderrWrite.apply(process.stderr, [`Detected logout for session ${specificSessionId || 'unknown'}. Scheduling process exit in ${moduleParams.RESTART_DELAY_MINUTES} minute(s).\n`]);
            setTimeout(() => process.exit(1), moduleParams.RESTART_DELAY_MINUTES * 60 * 1000);
        } else {
            originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY not set. Not forcing process exit after logout detection.\n']);
        }
    }
}


// === Telegram helper ===
async function sendTelegramAlert(text, chatId) { // chatId is now required
    if (!moduleParams.TELEGRAM_BOT_TOKEN) {
        originalStderrWrite.apply(process.stderr, ['TELEGRAM_BOT_TOKEN is not set. Cannot send Telegram alerts.\n']);
        return null;
    }
    if (!chatId) {
        originalStderrWrite.apply(process.stderr, ['Telegram chatId is not provided for alert. Cannot send.\n']);
        return null;
    }

    const url = `https://api.telegram.org/bot${moduleParams.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text };

    try {
        const res = await axios.post(url, payload);
        originalStdoutWrite.apply(process.stdout, [`Telegram message sent to chat ID ${chatId}: ${text.substring(0, 50)}...\n`]);
        return res.data.result.message_id;
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Telegram alert failed for chat ID ${chatId}: ${err.message}\n`]);
        if (err.response) {
            originalStderrWrite.apply(process.stderr, [`   Telegram API Response: Status ${err.response.status}, Data: ${JSON.stringify(err.response.data)}\n`]);
        }
        return null;
    }
}

// === "Logged out" alert with 24-hr cooldown & auto-delete ===
async function sendInvalidSessionAlert(specificSessionId = null) {
    const now = new Date();
    if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < 24 * 3600e3) {
        originalStdoutWrite.apply(process.stdout, ['Skipping logout alert -- cooldown not expired.\n']);
        return;
    }

    const nowStr = now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const hour = now.getHours();
    const greeting = hour < 12 ? 'good morning'
        : hour < 17 ? 'good afternoon'
            : 'good evening';

    const restartTimeDisplay = moduleParams.RESTART_DELAY_MINUTES >= 60 && (moduleParams.RESTART_DELAY_MINUTES % 60 === 0)
        ? `${moduleParams.RESTART_DELAY_MINUTES / 60} hour(s)`
        : `${moduleParams.RESTART_DELAY_MINUTES} minute(s)`;

    let message =
        `Hey Ult-AR, ${greeting}!\n\n` +
        `User [${moduleParams.APP_NAME}] has logged out.`;

    if (specificSessionId) {
        message += `\n[${specificSessionId}] invalid`;
    } else {
        message += `\n[UNKNOWN_SESSION] invalid`; // Fallback if no specific ID or APP_NAME.
    }

    message += `\nTime: ${nowStr}\n` +
        `Restarting in ${restartTimeDisplay}.`;

    try {
        if (lastLogoutMessageId) {
            try {
                originalStdoutWrite.apply(process.stdout, [`Attempting to delete previous logout alert id ${lastLogoutMessageId}\n`]);
                await axios.post(
                    `https://api.telegram.org/bot${moduleParams.TELEGRAM_BOT_TOKEN}/deleteMessage`,
                    { chat_id: moduleParams.TELEGRAM_USER_ID, message_id: lastLogoutMessageId }
                );
                originalStdoutWrite.apply(process.stdout, [`Deleted logout alert id ${lastLogoutMessageId}\n`]);
            } catch (delErr) {
                originalStderrWrite.apply(process.stderr, [`Failed to delete previous message ${lastLogoutMessageId}: ${delErr.message}\n`]);
            }
        }

        const msgId = await sendTelegramAlert(message, moduleParams.TELEGRAM_USER_ID);
        if (!msgId) return;

        lastLogoutMessageId = msgId;
        lastLogoutAlertTime = now;

        await sendTelegramAlert(message, moduleParams.TELEGRAM_CHANNEL_ID);
        originalStdoutWrite.apply(process.stdout, [`Sent new logout alert to channel ${moduleParams.TELEGRAM_CHANNEL_ID}\n`]);

        if (!moduleParams.HEROKU_API_KEY || !moduleParams.APP_NAME) {
            originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY or APP_NAME is not set. Cannot persist LAST_LOGOUT_ALERT timestamp.\n']);
            return;
        }
        const cfgUrl = `https://api.heroku.com/apps/${moduleParams.APP_NAME}/config-vars`;
        const headers = {
            Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
        };
        await axios.patch(cfgUrl, { LAST_LOGOUT_ALERT: now.toISOString() }, { headers });
        originalStdoutWrite.apply(process.stdout, [`Persisted LAST_LOGOUT_ALERT timestamp.\n`]);
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Failed during sendInvalidSessionAlert(): ${err.message}\n`]);
    }
}

// Function to handle bot connected messages
async function sendBotConnectedAlert() {
    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
    const message = `[${moduleParams.APP_NAME}] connected.\nSession IDs: ${moduleParams.config.SESSION.join(', ')}\nTime: ${now}`;
    await sendTelegramAlert(message, moduleParams.TELEGRAM_USER_ID);
    await sendTelegramAlert(message, moduleParams.TELEGRAM_CHANNEL_ID);
    originalStdoutWrite.apply(process.stdout, [`Sent "connected" message to channel ${moduleParams.TELEGRAM_CHANNEL_ID}\n`]);
}

// === Load LAST_LOGOUT_ALERT from Heroku config vars ===
async function loadLastLogoutAlertTime() {
    if (!moduleParams.HEROKU_API_KEY || !moduleParams.APP_NAME) {
        originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY or APP_NAME is not set. Cannot load LAST_LOGOUT_ALERT from Heroku config vars.\n']);
        return;
    }
    const url = `https://api.heroku.com/apps/${moduleParams.APP_NAME}/config-vars`;
    const headers = {
        Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
    };

    try {
        const res = await axios.get(url, { headers });
        const saved = res.data.LAST_LOGOUT_ALERT;
        if (saved) {
            const parsed = new Date(saved);
            if (!isNaN(parsed)) {
                lastLogoutAlertTime = parsed;
                originalStdoutWrite.apply(process.stdout, [`Loaded LAST_LOGOUT_ALERT: ${parsed.toISOString()}\n`]);
            }
        }
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Failed to load LAST_LOGOUT_ALERT from Heroku: ${err.message}\n`]);
    }
}


// === Scheduled Task for Logout Reminders & Expiration Cleanup ===
async function checkAndRemindLoggedOutBots() {
    originalStdoutWrite.apply(process.stdout, ['Running scheduled check for logged out bots...\n']);
    if (!moduleParams.HEROKU_API_KEY) {
        originalStdoutWrite.apply(process.stdout, ['Skipping scheduled logout check: HEROKU_API_KEY not set.\n']);
        return;
    }

    const allBots = await moduleParams.getUserIdByBotName('all_bots'); // Assuming a function to get all bots

    for (const botEntry of allBots) {
        const { user_id, bot_name } = botEntry;
        const herokuApp = bot_name;

        try {
            const apiHeaders = {
                Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`,
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
                        `Reminder: Your bot "${bot_name}" has been logged out for more than 24 hours!\n` +
                        `It appears to still be offline. Please update your session ID to bring it back online.`;

                    await moduleParams.bot.sendMessage(user_id, reminderMessage, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: 'Change Session ID', callback_data: `change_session:${bot_name}:${user_id}` }]
                            ]
                        }
                    });
                    originalStdoutWrite.apply(process.stdout, [`[Scheduled Task] Sent 24-hour logout reminder to user ${user_id} for bot ${bot_name}\n`]);
                }
            }

        } catch (error) {
            if (error.response && error.response.status === 404) {
                originalStdoutWrite.apply(process.stdout, [`[Scheduled Task] App ${herokuApp} not found during reminder check. Auto-removing from DB.\n`]);
                const currentOwnerId = await moduleParams.getUserIdByBotName(herokuApp);
                if (currentOwnerId) {
                    await moduleParams.deleteUserBot(currentOwnerId, herokuApp); // Delete from main DB
                    // No need to delete from backupPool here, as it's handled by specific deletion or expiration
                }
                return;
            }
            originalStderrWrite.apply(process.stderr, [`[Scheduled Task] Error checking status for bot ${herokuApp} (user ${user_id}): ${error.response?.data?.message || error.message}\n`]);
        }
    }
}

// === Scheduled Task for 45-day bot expiration ===
async function checkAndExpireBots() {
    originalStdoutWrite.apply(process.stdout, ['Running scheduled check for expiring bots...\n']);
    if (!moduleParams.HEROKU_API_KEY) {
        originalStdoutWrite.apply(process.stdout, ['Skipping scheduled expiration check: HEROKU_API_KEY not set.\n']);
        return;
    }

    try {
        const now = new Date();
        const expiredBotsQuery = await moduleParams.backupPool.query(
            `SELECT user_id, app_name FROM user_deployments
             WHERE expiration_date IS NOT NULL
             AND expiration_date <= $1
             AND deleted_from_heroku_at IS NULL;`, // Only expire bots that are currently 'active' on Heroku
            [now]
        );
        const expiredBots = expiredBotsQuery.rows;

        if (expiredBots.length === 0) {
            originalStdoutWrite.apply(process.stdout, ['[Scheduled Expiration] No active bots found to expire.\n']);
            return;
        }

        originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Found ${expiredBots.length} active bots to expire.\n`]);

        for (const botEntry of expiredBots) {
            const { user_id, app_name } = botEntry;
            originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Expiring active bot ${app_name} for user ${user_id}.\n`]);

            try {
                // 1. Delete from Heroku
                await axios.delete(`https://api.heroku.com/apps/${app_name}`, {
                    headers: { Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Successfully deleted Heroku app: ${app_name}\n`]);

                // 2. Delete from main DB (user_bots)
                await moduleParams.deleteUserBot(user_id, app_name);
                originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Successfully deleted from user_bots: ${app_name}\n`]);

                // 3. Delete from backup DB (user_deployments) - It has completed its lifecycle
                await moduleParams.deleteUserDeploymentFromBackup(user_id, app_name);
                originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Successfully deleted from user_deployments: ${app_name} (expired)\n`]);

                // 4. Notify user
                await moduleParams.bot.sendMessage(user_id, `Your bot "${app_name}" has reached its 45-day expiration and has been automatically deleted. To deploy a new bot, use the 'Deploy' or 'Restore From Backup' options.`, { parse_mode: 'Markdown' });
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] App ${app_name} not found on Heroku, but was in DB (likely already deleted). Cleaning up DBs.\n`]);
                    await moduleParams.deleteUserBot(user_id, app_name);
                    await moduleParams.deleteUserDeploymentFromBackup(user_id, app_name);
                    await moduleParams.bot.sendMessage(user_id, `Your bot "${app_name}" was not found on Heroku and has been automatically removed from your lists (likely already expired/deleted).`, { parse_mode: 'Markdown' });
                } else {
                    originalStderrWrite.apply(process.stderr, [`[Scheduled Expiration] Error expiring bot ${app_name} for user ${user_id}: ${error.message}\n${error.stack}\n`]);
                    moduleParams.bot.sendMessage(moduleParams.ADMIN_ID, `CRITICAL ERROR during scheduled bot expiration of "${app_name}" for user ${user_id}: ${error.message}`);
                }
            }
        }
        originalStdoutWrite.apply(process.stdout, ['[Scheduled Expiration] All expired bots processed.\n']);

    } catch (dbError) {
        originalStderrWrite.apply(process.stderr, [`[Scheduled Expiration] DB Error fetching expired bots: ${dbError.message}\n${dbError.stack}\n`]);
        moduleParams.bot.sendMessage(moduleParams.ADMIN_ID, `CRITICAL DB ERROR during scheduled bot expiration check: ${dbError.message}`);
    }
}

// Export the init function
module.exports = { init };
