// bot_monitor.js

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- Global variables for log interception and state ---
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

let stdoutBuffer = '';
let lastLogoutAlertTime = null;
let moduleParams = {};

function init(params) {
    moduleParams = params;
    
    originalStdoutWrite.apply(process.stdout, ['--- bot_monitor.js initialized and active! ---\n']);

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
    
    // Check for logged out and expiring bots every 5 minutes
    setInterval(checkAndRemindLoggedOutBots, 5 * 60 * 1000); 
    setInterval(checkAndExpireBots, 5 * 60 * 1000);
}


const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

let lastDetectedLogout = { appName: null, sessionId: null, timestamp: null };

function handleLogLine(line, streamType) {
    originalStdoutWrite.apply(process.stdout, [`[DEBUG - ${streamType.toUpperCase()} INTERCEPTED] Line: "${line.trim()}"\n`]);

    const sessionLoggedOutMatch = line.match(/\[([^\]]+)\] SESSION LOGGED OUT/i);
    if (sessionLoggedOutMatch) {
        lastDetectedLogout.sessionId = sessionLoggedOutMatch[1];
        lastDetectedLogout.timestamp = new Date();
        originalStdoutWrite.apply(process.stdout, [`[DEBUG] Detected session logout: ${lastDetectedLogout.sessionId}\n`]);
    }

    const appLoggedOutMatch = line.match(/User\s+\[?([^\]\s]+)\]?\s+has logged out/i);
    if (appLoggedOutMatch) {
        lastDetectedLogout.appName = appLoggedOutMatch[1];
        lastDetectedLogout.timestamp = new Date();
        originalStdoutWrite.apply(process.stdout, [`[DEBUG] Detected app logout: ${lastDetectedLogout.appName}\n`]);
    }

    if (lastDetectedLogout.appName && lastDetectedLogout.sessionId && (new Date() - lastDetectedLogout.timestamp < 10000)) {
        originalStderrWrite.apply(process.stderr, ['[DEBUG] Full logout event detected!\n']);
        
        const now = new Date();
        if (lastLogoutAlertTime && (now - lastLogoutAlertTime) < ALERT_COOLDOWN_MS) {
            originalStdoutWrite.apply(process.stdout, ['Skipping logout alert -- cooldown not expired.\n']);
            return;
        }
        lastLogoutAlertTime = now;

        const appName = lastDetectedLogout.appName;
        const sessionId = lastDetectedLogout.sessionId;
        
        sendStandardizedAlert(appName, sessionId).catch(err => originalStderrWrite.apply(process.stderr, [`Error sending standardized alert from bot_monitor: ${err.message}\n`]));

        if (moduleParams.HEROKU_API_KEY) {
            originalStderrWrite.apply(process.stderr, [`Detected logout for app ${appName} and session ${sessionId}. Scheduling process exit in ${moduleParams.RESTART_DELAY_MINUTES} minute(s).\n`]);
            setTimeout(() => process.exit(1), moduleParams.RESTART_DELAY_MINUTES * 60 * 1000);
        } else {
            originalStdoutWrite.apply(process.stdout, ['HEROKU_API_KEY not set. Not forcing process exit after logout detection.\n']);
        }

        lastDetectedLogout = { appName: null, sessionId: null, timestamp: null };
    }
}


async function sendTelegramAlert(text, chatId) {
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


async function sendStandardizedAlert(appName, sessionId) {
    const now = new Date();
    const timeZone = 'Africa/Lagos';
    const nowStr = now.toLocaleString('en-GB', { timeZone: timeZone });

    const hour = now.getHours();
    const greeting = hour < 12 ? 'good morning'
        : hour < 17 ? 'good afternoon'
            : 'good evening';

    const restartTimeDisplay = moduleParams.RESTART_DELAY_MINUTES >= 60 && (moduleParams.RESTART_DELAY_MINUTES % 60 === 0)
        ? `${moduleParams.RESTART_DELAY_MINUTES / 60} hour(s)`
        : `${moduleParams.RESTART_DELAY_MINUTES} minute(s)`;

    const appDisplayName = appName ? appName : 'Unknown Bot';
    const sessionDisplayName = sessionId ? sessionId : 'UNKNOWN_SESSION';

    const message = `[LOG] App: ${appDisplayName} | Status: LOGGED OUT | Session: ${sessionDisplayName} | Time: ${nowStr}`;

    try {
        await sendTelegramAlert(message, moduleParams.TELEGRAM_CHANNEL_ID);
        originalStdoutWrite.apply(process.stdout, [`Sent new standardized alert to channel ${moduleParams.TELEGRAM_CHANNEL_ID}\n`]);
    } catch (err) {
        originalStderrWrite.apply(process.stderr, [`Failed during sendStandardizedAlert(): ${err.message}\n`]);
    }
}


// --- FIX: checkAndRemindLoggedOutBots now handles the 5-day warning ---
async function checkAndRemindLoggedOutBots() {
    originalStdoutWrite.apply(process.stdout, ['Running scheduled check for logged out bots...\n']);
    if (!moduleParams.HEROKU_API_KEY) {
        originalStdoutWrite.apply(process.stdout, ['Skipping scheduled logout check: HEROKU_API_KEY not set.\n']);
        return;
    }

    const allBots = await moduleParams.getAllUserBots();
    const now = new Date();

    for (const botEntry of allBots) {
        const { user_id, bot_name } = botEntry;
        const herokuApp = bot_name;

        try {
            // FIX: Corrected the duplicated code here.
            const botStatusResult = await moduleParams.mainPool.query('SELECT status, status_changed_at, bot_type FROM user_bots WHERE bot_name = $1 LIMIT 1', [bot_name]);
            if (botStatusResult.rows.length === 0) continue;
            
            const { status, status_changed_at, bot_type } = botStatusResult.rows[0];

            if (status === 'logged_out' && status_changed_at) {
                const timeSinceLogout = now.getTime() - status_changed_at.getTime();
                const twentyFourHours = 24 * 60 * 60 * 1000;
                const fiveDays = 5 * twentyFourHours;

                if (timeSinceLogout > fiveDays) {
                    originalStdoutWrite.apply(process.stdout, [`[Scheduled Task] Bot ${bot_name} for user ${user_id} logged out for >5 days. Auto-deleting now.\n`]);

                    await axios.delete(`https://api.heroku.com/apps/${bot_name}`, {
                        headers: { Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                    });
                    
                    await moduleParams.deleteUserBot(user_id, bot_name);
                    await moduleParams.deleteUserDeploymentFromBackup(user_id, bot_name);
                    
                    await moduleParams.bot.sendMessage(user_id, `Your bot "*${moduleParams.escapeMarkdown(bot_name)}*" has been automatically deleted because it was logged out for more than 5 days.`, { parse_mode: 'Markdown' });
                    await moduleParams.bot.sendMessage(moduleParams.ADMIN_ID, `Auto-deleted bot "*${moduleParams.escapeMarkdown(bot_name)}*" (owner: \`${user_id}\`) for being logged out over 5 days.`, { parse_mode: 'Markdown' });
                } else if (timeSinceLogout > twentyFourHours) {
                    const reminderMessage =
                        `Reminder: Your *${bot_type.toUpperCase()}* bot "*${moduleParams.escapeMarkdown(bot_name)}*" has been logged out for more than 24 hours!\n` +
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

module.exports = { init };
