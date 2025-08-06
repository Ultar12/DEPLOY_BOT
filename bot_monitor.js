const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Global variables for log interception and state ---
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

let stdoutBuffer = '';
let stderrBuffer = '';

let lastLogoutAlertTime = null;

// --- Parameters that will be passed from bot.js ---
let moduleParams = {};

/**
 * Initializes the bot monitoring system.
 */
function init(params) {
    moduleParams = params;
    
    // FIX: A much shorter cooldown to prevent alert spamming but allow new alerts after a few minutes
    const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

    // --- CRITICAL DEBUG TEST: If you see this, the bot_monitor.js is loading! ---
    originalStdoutWrite.apply(process.stdout, ['--- bot_monitor.js initialized and active! ---\n']);
    // -----------------------------------------------------------------

    // FIX: Only override stdout to prevent infinite recursion from stderr log errors
    process.stdout.write = (chunk, encoding, callback) => {
        stdoutBuffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
            const line = stdoutBuffer.substring(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.substring(newlineIndex + 1);
            handleLogLine(line, 'stdout');
        }
        return originalStdoutWrite.apply(process.stdout, [chunk, encoding, callback]);
    };
    
    // The originalStderrWrite is not replaced, so errors will log normally without triggering a new alert loop.

    // === Load initial state from Heroku config vars ===
    loadLastLogoutAlertTime();

    // === Start Scheduled Tasks ===
    // Every 5 minutes for logout reminders
    setInterval(checkAndRemindLoggedOutBots, 5 * 60 * 1000); 
    // Every 24 hours for expiration check (based on original deploy date)
    setInterval(checkAndExpireBots, 24 * 60 * 60 * 1000);
}


// Function to process each log line captured by the overrides
function handleLogLine(line, streamType) {
    // This console.log will go to original stdout/stderr, avoiding recursion
    originalStdoutWrite.apply(process.stdout, [`[DEBUG - ${streamType.toUpperCase()} INTERCEPTED] Line: "${line.trim()}"\n`]);

    // FIX: Check for logout patterns
    // Using a broader set of patterns to catch various logout scenarios
    const logoutPatterns = [
        'ERROR: Failed to initialize bot. Details: No valid session found',
        'SESSION LOGGED OUT. Please rescan QR and update SESSION.',
        'Reason: logout',
        'Authentication Error',
        'User [', ' has logged out.',
        '] invalid',
        'invalid'
    ];

    if (logoutPatterns.some(pattern => line.includes(pattern))) {
        originalStderrWrite.apply(process.stderr, ['[DEBUG] Logout pattern detected in log!\n']);

        // Attempt to extract session ID more generally (captures any word after "for " or within brackets)
        let specificSessionId = null;
        const matchForSession = line.match(/for (\S+)\./);
        if (matchForSession) specificSessionId = matchForSession[1];
        else {
            const raganorkLogoutMatch = line.match(/\[([^\]]+)\] invalid/i);
            if (raganorkLogoutMatch) specificSessionId = raganorkLogoutMatch[1];
        }

        // FIX: The log stream from Heroku doesn't know the app name of the user bot.
        // It's the monitoring bot that has the app name here.
        // This line is now for general alerting from the monitor itself.
        sendInvalidSessionAlert(specificSessionId, moduleParams.APP_NAME).catch(err => originalStderrWrite.apply(process.stderr, [`Error sending logout alert from bot_monitor: ${err.message}\n`]));

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
    const payload = { chat_id: chatId, text, parse_mode: 'Markdown' };

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

// === "Logged out" alert with 5-minute cooldown ===
async function sendInvalidSessionAlert(specificSessionId = null, botNameForAlert = null) {
    const now = new Date();
    const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
    const timeZone = 'Africa/Lagos';
    const nowStr = now.toLocaleString('en-GB', { timeZone: timeZone });

    // FIX: Use a much shorter cooldown to prevent message spamming
    if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < ALERT_COOLDOWN_MS) {
        originalStdoutWrite.apply(process.stdout, ['Skipping logout alert -- cooldown not expired.\n']);
        return;
    }

    const hour = now.getHours();
    const greeting = hour < 12 ? 'good morning'
        : hour < 17 ? 'good afternoon'
            : 'good evening';

    const restartTimeDisplay = moduleParams.RESTART_DELAY_MINUTES >= 60 && (moduleParams.RESTART_DELAY_MINUTES % 60 === 0)
        ? `${moduleParams.RESTART_DELAY_MINUTES / 60} hour(s)`
        : `${moduleParams.RESTART_DELAY_MINUTES} minute(s)`;

    let message =
        `🚨 Hey Ult-AR, ${greeting}!\n\n` +
        `Bot "*${moduleParams.escapeMarkdown(botNameForAlert || moduleParams.APP_NAME)}*" has logged out.`;

    if (specificSessionId) {
        message += `\n\`${moduleParams.escapeMarkdown(specificSessionId)}\` invalid`;
    } else {
        message += `\n\`UNKNOWN_SESSION\` invalid`;
    }

    message += `\nTime: ${nowStr}\n` +
        `Restarting in ${restartTimeDisplay}.`;

    try {
        // FIX: Only send to the monitoring channel, as per user's request
        const msgId = await sendTelegramAlert(message, moduleParams.TELEGRAM_CHANNEL_ID);
        if (!msgId) return;
        
        lastLogoutAlertTime = now;
        
        // FIX: Do not persist LAST_LOGOUT_ALERT to config vars as it causes 404 recursion errors
        originalStdoutWrite.apply(process.stdout, ['LAST_LOGOUT_ALERT persistence is disabled to prevent recursion errors.\n']);
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Failed during sendInvalidSessionAlert(): ${err.message}\n`]);
    }
}

// FIX: This function is now removed entirely. Its logic is consolidated into bot.js.
// async function sendBotConnectedAlert() { ... }

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

    const allBots = await moduleParams.getAllUserBots();

    for (const botEntry of allBots) {
        const { user_id, bot_name } = botEntry;
        const herokuApp = bot_name;

        try {
            const apiHeaders = {
                Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            };

            // FIX: Gracefully handle 404 for app not found.
            const dynoRes = await axios.get(`https://api.heroku.com/apps/${herokuApp}/dynos`, { headers: apiHeaders });
            const workerDyno = dynoRes.data.find(d => d.type === 'worker');

            const isBotRunning = workerDyno && workerDyno.state === 'up';

            // Check bot status from the database, not Heroku config.
            const botStatusResult = await moduleParams.mainPool.query('SELECT status, status_changed_at, bot_type FROM user_bots WHERE bot_name = $1 LIMIT 1', [bot_name]);
            if (botStatusResult.rows.length === 0) continue;
            
            const { status, status_changed_at, bot_type } = botStatusResult.rows[0];

            if (status === 'logged_out' && status_changed_at) {
                const timeSinceLogout = now.getTime() - status_changed_at.getTime();
                const twentyFourHours = 24 * 60 * 60 * 1000;

                if (timeSinceLogout > twentyFourHours) {
                    const reminderMessage =
                        `📢 Reminder: Your *${bot_type.toUpperCase()}* bot "*${moduleParams.escapeMarkdown(bot_name)}*" has been logged out for more than 24 hours!\n` +
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
                    await moduleParams.deleteUserBot(currentOwnerId, herokuApp);
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
             AND deleted_from_heroku_at IS NULL;`,
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
                await axios.delete(`https://api.heroku.com/apps/${app_name}`, {
                    headers: { Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Successfully deleted Heroku app: ${app_name}\n`]);

                await moduleParams.deleteUserBot(user_id, app_name);
                originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Successfully deleted from user_bots: ${app_name}\n`]);

                await moduleParams.deleteUserDeploymentFromBackup(user_id, app_name);
                originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] Successfully deleted from user_deployments: ${app_name} (expired)\n`]);

                await moduleParams.bot.sendMessage(user_id, `Your bot "*${moduleParams.escapeMarkdown(app_name)}*" has reached its 45-day expiration and has been automatically deleted. To deploy a new bot, use the 'Deploy' or 'Restore From Backup' options.`, { parse_mode: 'Markdown' });
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    originalStdoutWrite.apply(process.stdout, [`[Scheduled Expiration] App ${app_name} not found on Heroku, but was in DB (likely already deleted). Cleaning up DBs.\n`]);
                    await moduleParams.deleteUserBot(user_id, app_name);
                    await moduleParams.deleteUserDeploymentFromBackup(user_id, app_name);
                    await moduleParams.bot.sendMessage(user_id, `Your bot "*${moduleParams.escapeMarkdown(app_name)}*" was not found on Heroku and has been automatically removed from your lists (likely already expired/deleted).`, { parse_mode: 'Markdown' });
                } else {
                    originalStderrWrite.apply(process.stderr, [`[Scheduled Expiration] Error expiring bot ${app_name} for user ${user_id}: ${error.message}\n`]);
                    moduleParams.bot.sendMessage(moduleParams.ADMIN_ID, `CRITICAL ERROR during scheduled bot expiration of "*${moduleParams.escapeMarkdown(app_name)}*" for user ${moduleParams.escapeMarkdown(user_id)}: ${moduleParams.escapeMarkdown(error.message)}`, { parse_mode: 'Markdown' });
                }
            }
        }
        originalStdoutWrite.apply(process.stdout, ['[Scheduled Expiration] All expired bots processed.\n']);

    } catch (dbError) {
        originalStderrWrite.apply(process.stderr, [`[Scheduled Expiration] DB Error fetching expired bots: ${dbError.message}\n`]);
        moduleParams.bot.sendMessage(moduleParams.ADMIN_ID, `CRITICAL DB ERROR during scheduled bot expiration check: ${moduleParams.escapeMarkdown(dbError.message)}`, { parse_mode: 'Markdown' });
    }
}

// Export the init function AND the sendTelegramAlert function
module.exports = { init, sendTelegramAlert };
