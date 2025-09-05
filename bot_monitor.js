const axios = require('axios');

// Module-level variables to hold dependencies from bot.js
let moduleParams = {};

/**
 * Initializes the monitor with dependencies from the main bot file.
 */
function init(params) {
    moduleParams = params;
    console.log('--- bot_monitor.js initialized and active! ---');

    // Start all scheduled tasks
    setInterval(monitorAllAppsForR14, 3 * 60 * 1000);      // Every 3 minutes
    setInterval(checkLoggedOutBots, 5 * 60 * 1000);        // Every 5 minutes
    setInterval(checkExpiredBots, 10 * 60 * 1000);         // Every 10 minutes
}

/**
 * Sends an alert message to a specified Telegram chat.
 */
async function sendTelegramAlert(text, chatId) {
    if (!chatId || !moduleParams.TELEGRAM_BOT_TOKEN) {
        console.error('[Monitor] Cannot send Telegram alert: Missing chatId or bot token.');
        return;
    }
    const url = `https://api.telegram.org/bot${moduleParams.TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text, parse_mode: 'Markdown' });
        console.log(`[Monitor] Alert sent to ${chatId}: "${text.substring(0, 50)}..."`);
    } catch (error) {
        console.error(`[Monitor] Failed to send Telegram alert to ${chatId}:`, error.message);
    }
}

/**
 * A helper function to restart a Heroku app's dynos.
 */
async function restartBot(appName) {
    console.log(`[Auto-Restart] Attempting to restart bot: ${appName}`);
    if (!moduleParams.HEROKU_API_KEY) {
        console.error(`[Auto-Restart] Cannot restart ${appName}: HEROKU_API_KEY is not set.`);
        return false;
    }
    try {
        await axios.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
            headers: { 
                Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`, 
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

/**
 * Fetches recent logs for all bots and restarts any with an R14 error.
 */
async function monitorAllAppsForR14() {
    console.log('[R14 Monitor] Running scheduled check for memory errors...');
    if (!moduleParams.HEROKU_API_KEY) return;

    const botsWithErrors = [];
    try {
        const allBots = await moduleParams.getAllUserBots();
        if (!allBots || allBots.length === 0) return;

        for (const bot of allBots) {
            try {
                const logSessionUrl = `https://api.heroku.com/apps/${bot.bot_name}/log-sessions`;
                const headers = {
                    Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3'
                };
                const res = await axios.post(logSessionUrl, { lines: 10, source: 'heroku' }, { headers });
                const logsRes = await axios.get(res.data.logplex_url);

                if (logsRes.data && logsRes.data.includes('Error R14 (Memory quota exceeded)')) {
                    console.log(`[R14 Monitor] R14 detected for ${bot.bot_name}. Triggering restart.`);
                    await restartBot(bot.bot_name); 
                    botsWithErrors.push(bot.bot_name);
                }
            } catch (err) {
                if (!err.response || err.response.status !== 404) {
                    console.error(`[R14 Monitor] Failed to fetch logs for ${bot.bot_name}:`, err.message);
                }
            }
        }

        if (botsWithErrors.length > 0) {
            const timeStr = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
            let message = `🚨 **R14 Memory Errors & Restarts** 🚨\n\nThe following bots were automatically restarted:\n\n`;
            botsWithErrors.forEach(appName => { message += `- \`${appName}\`\n`; });
            message += `\nTime: ${timeStr}`;
            await sendTelegramAlert(message, moduleParams.ADMIN_ID);
            await sendTelegramAlert(message, moduleParams.TELEGRAM_CHANNEL_ID);
        }
    } catch (err) {
        console.error('[R14 Monitor] Critical error fetching bot list:', err.message);
    }
}

/**
 * Checks for bots that have been logged out for more than 5 days and deletes them.
 */
async function checkLoggedOutBots() {
    console.log('[Logout Monitor] Running scheduled check for old logged-out bots...');
    try {
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        const result = await moduleParams.mainPool.query(
            "SELECT user_id, bot_name FROM user_bots WHERE status = 'logged_out' AND status_changed_at <= $1",
            [fiveDaysAgo]
        );

        for (const botInfo of result.rows) {
            const { user_id, bot_name } = botInfo;
            console.log(`[Logout Monitor] Deleting ${bot_name} for being logged out over 5 days.`);
            try {
                await axios.delete(`https://api.heroku.com/apps/${bot_name}`, { headers: { Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                await moduleParams.deleteUserBot(user_id, bot_name);
                await moduleParams.deleteUserDeploymentFromBackup(user_id, bot_name);
                await moduleParams.bot.sendMessage(user_id, `Your bot "*${moduleParams.escapeMarkdown(bot_name)}*" has been automatically deleted because it was logged out for more than 5 days.`, { parse_mode: 'Markdown' });
                await sendTelegramAlert(`Auto-deleted bot \`${bot_name}\` (owner: \`${user_id}\`) for being logged out over 5 days.`, moduleParams.ADMIN_ID);
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    console.log(`[Logout Monitor] App ${bot_name} was already deleted from Heroku. Cleaning up DB records.`);
                    await moduleParams.deleteUserBot(user_id, bot_name);
                    await moduleParams.deleteUserDeploymentFromBackup(user_id, bot_name);
                } else {
                    console.error(`[Logout Monitor] Failed to delete bot ${bot_name}:`, error.message);
                }
            }
        }
    } catch (dbError) {
        console.error('[Logout Monitor] DB Error:', dbError);
    }
}

/**
 * Checks for bots that have passed their expiration date and deletes them.
 */
async function checkExpiredBots() {
    console.log('[Expiration Monitor] Running scheduled check for expired bots...');
    try {
        const expiredBotsResult = await moduleParams.mainPool.query(
            `SELECT user_id, app_name FROM user_deployments WHERE expiration_date <= NOW()`
        );

        for (const botInfo of expiredBotsResult.rows) {
            const { user_id, app_name } = botInfo;
            console.log(`[Expiration Monitor] Deleting expired bot ${app_name}.`);
            try {
                await axios.delete(`https://api.heroku.com/apps/${app_name}`, { headers: { Authorization: `Bearer ${moduleParams.HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                await moduleParams.deleteUserBot(user_id, app_name);
                await moduleParams.deleteUserDeploymentFromBackup(user_id, app_name);
                await moduleParams.bot.sendMessage(user_id, `Your bot "*${moduleParams.escapeMarkdown(app_name)}*" has expired and has been permanently deleted.`, { parse_mode: 'Markdown' });
                await sendTelegramAlert(`Auto-deleted expired bot \`${app_name}\` (owner: \`${user_id}\`).`, moduleParams.ADMIN_ID);
            } catch (error) {
                 if (error.response && error.response.status === 404) {
                    console.log(`[Expiration Monitor] App ${app_name} was already deleted from Heroku. Cleaning up DB records.`);
                    await moduleParams.deleteUserBot(user_id, app_name);
                    await moduleParams.deleteUserDeploymentFromBackup(user_id, app_name);
                } else {
                    console.error(`[Expiration Monitor] Failed to delete bot ${app_name}:`, error.message);
                }
            }
        }
    } catch (dbError) {
        console.error('[Expiration Monitor] DB Error:', dbError);
    }
}

module.exports = { init };
