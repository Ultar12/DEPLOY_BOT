// web.js (The dedicated Express Web Server)

const express = require('express');
const path = require('path');
const axios = require('axios');
require('dotenv').config(); // Ensure env vars are loaded for web.js too

// --- REQUIRE CORE BOT LOGIC AND HELPERS FROM bot.js ---
// This is the crucial part: importing functionality from bot.js
const {
    botInstance, // The initialized Telegram bot
    pool,        // The DB pool
    defaultEnvVars,
    HEROKU_API_KEY,
    GITHUB_REPO_URL,
    ADMIN_ID,
    TELEGRAM_LISTEN_CHANNEL_ID,
    appDeploymentPromises, // The shared map
    // DB helper functions (if you want to call them directly from web.js)
    addUserBot,
    getUserBots,
    getUserIdByBotName,
    canDeployFreeTrial,
    recordFreeTrialDeploy,
    handleAppNotFoundAndCleanDb, // Helper that sends Telegram messages
    useDeployKey,
    animateMessage, // The animation function (now called via botInstance)
    getAnimatedEmoji // Emoji for animations
} = require('./bot'); // Relative path to bot.js
// --- END REQUIRE ---


const app = express();
const PORT = process.env.PORT || 3000; // Use Heroku's PORT or default for local development

// Middleware to parse JSON bodies
app.use(express.json());
// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Web Routes ---

// Root route: Serves the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint: Get all deployed bots from your database
app.get('/api/bots', async (req, res) => {
    try {
        const result = await pool.query('SELECT user_id, bot_name, created_at FROM user_bots ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching bots for web API:', error.message);
        res.status(500).json({ error: 'Failed to retrieve bot list.' });
    }
});

// API endpoint: Initiate a Get Session process (via Telegram bot)
app.post('/api/getSession', async (req, res) => {
    const { userId } = req.body; // Expecting userId from the frontend
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required.' });
    }

    const guideCaption =
    "To get your session ID, please follow these steps carefully:\n\n" +
        "1️⃣ *Open the Link:*\n" +
        "Visit: <https://levanter-delta.vercel.app/>\n" +
        "Use the 'Custom Session ID' button if you prefer.\n\n" +
        "2️⃣ *Important for iPhone Users:*\n" +
        "If you are on an iPhone, please open the link using the **Google Chrome** browser.\n\n" +
        "3️⃣ *Skip Advertisements:*\n" +
        "The website may show ads. Please close or skip any popups or advertisements to proceed.\n\n" +
        "4️⃣ *Copy Your Session ID:*\n" +
        "Once you are done logging in, check your personal chat and copy the first message starting with `levanter_`.\n\n" +
        "5️⃣ *Final Step: Launch Your Bot:*\n" +
        "When you're done, come back here and tap the 'Deploy' button to launch your bot. Remember to get your Deploy key from the Admin.";

    const welcomeImageUrl = 'https://files.catbox.moe/an2cc1.jpeg';

    try {
        // Use the exported botInstance to send the message
        await botInstance.sendPhoto(userId, welcomeImageUrl, {
            caption: guideCaption,
            parse_mode: 'Markdown',
        });
        res.json({ message: 'Session ID guide sent to your Telegram bot.' });
    } catch (error) {
        console.error(`Error sending Get Session info to user ${userId}:`, error.message);
        res.status(500).json({ error: `Failed to send message to user's Telegram. Ensure your bot can message the user.` });
    }
});

// API endpoint: Deploy a bot
app.post('/api/deployBot', async (req, res) => {
    const { userId, sessionId, appName, deployKey, isFreeTrial, autoStatusView } = req.body;

    if (!userId || !sessionId || !appName) {
        return res.status(400).json({ error: 'User ID, Session ID, and App Name are required.' });
    }
    if (!isFreeTrial && !deployKey) {
        return res.status(400).json({ error: 'Deploy Key is required for non-Free Trial deployments.' });
    }
    if (!HEROKU_API_KEY) {
        return res.status(500).json({ error: 'Server configuration error: Heroku API key missing.' });
    }
    if (!GITHUB_REPO_URL) {
        return res.status(500).json({ error: 'Server configuration error: GitHub Repo URL missing.' });
    }

    const vars = {
        APP_NAME: appName,
        SESSION_ID: sessionId,
        AUTO_STATUS_VIEW: autoStatusView ? 'no-dl' : 'false'
    };

    try {
        if (isFreeTrial) {
            const check = await canDeployFreeTrial(userId);
            if (!check.can) {
                const cooldownMsg = `⏳ You have already used your Free Trial. You can use it again after: ${new Date(check.cooldown).toLocaleString('en-US', { timeZone: 'Africa/Lagos' })}`;
                await botInstance.sendMessage(userId, cooldownMsg); // Use botInstance
                return res.status(403).json({ error: 'Free Trial cooldown active.', cooldown: check.cooldown });
            }
        } else {
            const usesLeft = await useDeployKey(deployKey);
            if (usesLeft === null) {
                await botInstance.sendMessage(userId, "❌ Invalid Deploy Key. Please contact support."); // Use botInstance
                return res.status(403).json({ error: 'Invalid or expired Deploy Key.' });
            }
            botInstance.sendMessage(ADMIN_ID, `🔑 Deploy key used by user \`${userId}\` for app "${appName}". Uses left: ${usesLeft}`); // Use botInstance
        }

        // --- Heroku Deployment Logic ---
        await axios.post('https://api.heroku.com/apps', { name: appName }, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });

        await axios.post(
            `https://api.heroku.com/apps/${appName}/addons`,
            { plan: 'heroku-postgresql' },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
        );

        await axios.put(
            `https://api.heroku.com/apps/${appName}/buildpack-installations`,
            {
                updates: [
                    { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
                    { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
                    { buildpack: 'heroku/nodejs' }
                ]
            },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
        );

        await axios.patch(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { ...defaultEnvVars, ...vars },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
        );

        const bres = await axios.post(
            `https://api.heroku.com/apps/${appName}/builds`,
            { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
        );

        const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
        let buildStatus = 'pending';

        const progressMsg = await botInstance.sendMessage(userId, `🛠️ Starting build for "${appName}"...`); // Use botInstance
        const animateBuildIntervalId = await animateMessage(userId, progressMsg.message_id, 'Building...'); // Use botInstance's animation function

        const BUILD_POLL_TIMEOUT = 300 * 1000;
        let buildCheckInterval;
        let buildTimeout;

        const buildPromise = new Promise((resolve, reject) => {
            buildTimeout = setTimeout(() => {
                clearInterval(buildCheckInterval);
                reject(new Error('Heroku build process timed out.'));
            }, BUILD_POLL_TIMEOUT);

            buildCheckInterval = setInterval(async () => {
                try {
                    const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    buildStatus = poll.data.status;

                    if (buildStatus === 'succeeded') {
                        clearInterval(buildCheckInterval);
                        clearTimeout(buildTimeout);
                        resolve('succeeded');
                    } else if (buildStatus === 'failed') {
                        clearInterval(buildCheckInterval);
                        clearTimeout(buildTimeout);
                        reject(new Error(`Heroku build failed. Check Heroku dashboard logs for "${appName}".`));
                    }
                } catch (pollError) {
                    clearInterval(buildCheckInterval);
                    clearTimeout(buildTimeout);
                    reject(new Error(`Error polling build status: ${pollError.message}`));
                }
            }, 10000); // Poll every 10 seconds
        });

        await buildPromise;

        clearInterval(animateBuildIntervalId);
        await botInstance.editMessageText(`✅ Heroku build for "${appName}" succeeded! Waiting for bot connection...`, {
            chat_id: userId,
            message_id: progressMsg.message_id
        });

        await addUserBot(userId, appName, sessionId);
        if (isFreeTrial) {
            await recordFreeTrialDeploy(userId);
            console.log(`[FreeTrial] Recorded free trial deploy for user ${userId}.`);
        }

        const userInfo = (await botInstance.getChat(userId)).from || {}; // Use botInstance
        const userDetails = [
          `*Name:* ${userInfo.first_name || ''} ${userInfo.last_name || ''}`,
          `*Username:* ${userInfo.username ? `@${userInfo.username}` : (userInfo.first_name || userInfo.last_name ? `${[userInfo.first_name, userInfo.last_name].filter(Boolean).join(' ')} (No @username)` : 'N/A')}`,
          `*Chat ID:* \`${userId}\``
        ].join('\n');
        const appDetails = `*App Name:* \`${appName}\`\n*Session ID:* \`${sessionId.substring(0,10)}...\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;

        await botInstance.sendMessage(ADMIN_ID, // Use botInstance
            `*New App Deployed (Heroku Build Succeeded)*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        const baseWaitingText = `Build complete! Waiting for bot "${appName}" to connect...`;
        await botInstance.editMessageText(`${getAnimatedEmoji()} ${baseWaitingText}`, { // Use botInstance
            chat_id: userId,
            message_id: progressMsg.message_id
        });
        const animateConnectIntervalId = await animateMessage(userId, progressMsg.message_id, baseWaitingText); // Use botInstance's animation function

        appDeploymentPromises.set(appName, {
            resolve: () => {},
            reject: () => {},
            animateIntervalId: animateConnectIntervalId,
            userId: userId,
            messageId: progressMsg.message_id
        });

        const appConnectPromise = new Promise((resolve, reject) => {
            const promiseData = appDeploymentPromises.get(appName);
            if (promiseData) {
                promiseData.resolve = resolve;
                promiseData.reject = reject;
            }
        });

        const STATUS_CHECK_TIMEOUT = 120 * 1000;
        let connectTimeoutId;

        try {
            connectTimeoutId = setTimeout(() => {
                const appPromise = appDeploymentPromises.get(appName);
                if (appPromise) {
                    appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after deployment.`));
                    appDeploymentPromises.delete(appName);
                }
            }, STATUS_CHECK_TIMEOUT);

            await appConnectPromise;
            clearTimeout(connectTimeoutId);
            clearInterval(animateConnectIntervalId);

            await botInstance.editMessageText(`🎉 Your bot "${appName}" is now live!`, { chat_id: userId, message_id: progressMsg.message_id }); // Use botInstance

            if (isFreeTrial) {
                setTimeout(async () => {
                    const adminWarningMessage = `🔔 Free Trial App "${appName}" has 5 minutes left until deletion!`;
                    const keyboard = { inline_keyboard: [[{ text: `Delete "${appName}" Now`, callback_data: `admin_delete_trial_app:${appName}` }]] };
                    await botInstance.sendMessage(ADMIN_ID, adminWarningMessage, { reply_markup: keyboard, parse_mode: 'Markdown' }); // Use botInstance
                }, 55 * 60 * 1000);

                setTimeout(async () => {
                    try {
                        await botInstance.sendMessage(userId, `⏳ Your Free Trial app "${appName}" is being deleted now as its 1-hour runtime has ended.`); // Use botInstance
                        await axios.delete(`https://api.heroku.com/apps/${appName}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                        await deleteUserBot(userId, appName);
                        await botInstance.sendMessage(userId, `Free Trial app "${appName}" successfully deleted.`); // Use botInstance
                    } catch (e) {
                        console.error(`Failed to auto-delete free trial app ${appName}:`, e.message);
                        await botInstance.sendMessage(userId, `⚠️ Could not auto-delete the app "${appName}". Please delete it manually from your Heroku dashboard.`); // Use botInstance
                        botInstance.sendMessage(ADMIN_ID, `⚠️ Failed to auto-delete free trial app "${appName}" for user ${userId}: ${e.message}`); // Use botInstance
                    }
                }, 60 * 60 * 1000);
            }
            res.json({ success: true, message: `Deployment for "${appName}" successful!` });

        } catch (err) {
            clearTimeout(connectTimeoutId);
            clearInterval(animateConnectIntervalId);
            console.error(`App connection check failed for ${appName} after deployment:`, err.message);
            await botInstance.editMessageText( // Use botInstance
                `⚠️ Bot "${appName}" failed to start or session is invalid after deployment: ${err.message}\n\n` +
                `It has been added to your "My Bots" list, but you may need to learn how to update the session ID.`,
                {
                    chat_id: userId,
                    message_id: progressMsg.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Change Session ID', callback_data: `change_session:${appName}:${userId}` }]
                        ]
                    }
                }
            );
            res.status(500).json({ success: false, error: `Deployment succeeded on Heroku, but bot failed to connect: ${err.message}` });
        } finally {
            appDeploymentPromises.delete(appName);
        }

    } catch (error) {
        const errorMessage = error.response?.data?.message || error.message;
        console.error(`Error during deployBot API call for ${appName}:`, errorMessage, error.stack);

        if (error.response?.status === 409 && errorMessage.includes('name is already taken')) {
            return res.status(409).json({ error: `App name "${appName}" is already taken. Please choose another.` });
        }

        await botInstance.sendMessage(userId, `❌ Deployment failed for "${appName}": ${errorMessage}\n\nPlease try again or contact support.`) // Use botInstance
            .catch(tgErr => console.error(`Failed to send Telegram error message: ${tgErr.message}`));

        res.status(500).json({ error: `Deployment failed: ${errorMessage}` });
    }
});

// API endpoint: Get user's deployed bots
app.get('/api/myBots/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const bots = await getUserBots(userId);
        res.json(bots);
    } catch (error) {
        console.error(`Error fetching bots for user ${userId}:`, error.message);
        res.status(500).json({ error: 'Failed to retrieve your bots.' });
    }
});

// API endpoint: Get Free Trial status
app.get('/api/freeTrialStatus/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const status = await canDeployFreeTrial(userId);
        res.json(status);
    } catch (error) {
        console.error(`Error checking free trial status for user ${userId}:`, error.message);
        res.status(500).json({ error: 'Failed to check free trial status.' });
    }
});

// API endpoint: Restart a specific bot on Heroku (accessible from web dashboard)
app.post('/api/restart-bot', async (req, res) => {
    const { botName } = req.body;
    if (!botName) {
        return res.status(400).json({ error: 'Bot name is required.' });
    }

    try {
        if (!HEROKU_API_KEY) {
            return res.status(500).json({ error: 'Server configuration error: Heroku API key missing.' });
        }

        await axios.delete(`https://api.heroku.com/apps/${botName}/dynos`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        res.json({ message: `Successfully requested restart for ${botName}.` });
    } catch (error) {
        const errorMessage = error.response?.data?.message || error.message;
        console.error(`Error restarting bot ${botName} via web:`, errorMessage);
        if (error.response && error.response.status === 404) {
             res.status(404).json({ error: `Bot app "${botName}" not found on Heroku. It might have been deleted.` });
        } else {
             res.status(500).json({ error: `Failed to restart bot: ${errorMessage}` });
        }
    }
});

// API endpoint: Get general app info (for a specific app - can be used by web)
app.get('/api/appInfo/:appName', async (req, res) => {
    const appName = req.params.appName;
    try {
        const apiHeaders = { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' };
        const [appRes, configRes, dynoRes] = await Promise.all([
            axios.get(`https://api.heroku.com/apps/${appName}`, { headers: apiHeaders }),
            axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, { headers: apiHeaders }),
            axios.get(`https://api.heroku.com/apps/${appName}/dynos`, { headers: apiHeaders })
        ]);

        const appData = appRes.data;
        const configData = configRes.data;
        const dynoData = dynoRes.data;

        let dynoStatus = 'scaled to 0 / off';
        if (dynoData.length > 0) {
            const workerDyno = dynoData.find(d => d.type === 'worker');
            if (workerDyno) {
                dynoStatus = workerDyno.state;
            }
        }

        res.json({
            name: appData.name,
            dynoStatus: dynoStatus,
            createdAt: appData.created_at,
            releasedAt: appData.released_at,
            stack: appData.stack.name,
            sessionIdSet: !!configData.SESSION_ID,
            autoStatusView: configData.AUTO_STATUS_VIEW || 'false'
        });
    } catch (error) {
        console.error(`Error fetching app info for ${appName}:`, error.message);
        if (error.response && error.response.status === 404) {
            res.status(404).json({ error: 'App not found on Heroku.' });
        } else {
            res.status(500).json({ error: `Failed to get app info: ${error.message}` });
        }
    }
});


// Start the Express web server
app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
    console.log(`Access web dashboard at: http://localhost:${PORT}`);
});
