const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

// Global variables for this module, will be populated by init function
let bot;
let HEROKU_API_KEY;
let pool;
let ADMIN_ID;
let dbServices; 
let buildWithProgress;
let TELEGRAM_BOT_TOKEN; // We'll need the bot token for web_app_data validation
let PAYSTACK_SECRET_KEY; // We need this for payment
let RAGANORK_SESSION_PREFIX;
let LEVANTER_SESSION_PREFIX;

// Initialization function to set up dependencies from bot.js
function init(params) {
    bot = params.bot;
    HEROKU_API_KEY = params.HEROKU_API_KEY;
    pool = params.pool;
    ADMIN_ID = params.ADMIN_ID;
    dbServices = params.dbServices;
    buildWithProgress = params.buildWithProgress;
    TELEGRAM_BOT_TOKEN = params.TELEGRAM_BOT_TOKEN;
    PAYSTACK_SECRET_KEY = params.PAYSTACK_SECRET_KEY;
    RAGANORK_SESSION_PREFIX = params.RAGANORK_SESSION_PREFIX;
    LEVANTER_SESSION_PREFIX = params.LEVANTER_SESSION_PREFIX;
    
    console.log('[MiniApp Server] Module initialized with bot dependencies.');
}

// Create the Express app
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// === NEW: WebApp Data Validation Middleware ===
function validateWebAppInitData(req, res, next) {
    const initData = req.header('X-Telegram-Init-Data');
    if (!initData) {
        return res.status(401).json({ success: false, message: 'Unauthorized: No init data provided' });
    }

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        urlParams.sort();

        const dataCheckString = urlParams.toString().replace(/%25/g, '%');
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
}
// === END Validation Middleware ===


// Endpoint to serve the Mini App's HTML
app.get('/deploy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to check if an app name is available
app.get('/api/check-app-name/:appName', validateWebAppInitData, async (req, res) => {
    const appName = req.params.appName;
    try {
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        res.json({ available: false });
    } catch (e) {
        if (e.response?.status === 404) {
            res.json({ available: true });
        } else {
            res.status(500).json({ available: false, error: 'API Error' });
        }
    }
});

// Endpoint to handle the final deployment submission
app.post('/api/deploy', validateWebAppInitData, async (req, res) => {
    const { botType, appName, sessionId, autoStatusView, deployKey, isFreeTrial } = req.body;
    const userId = req.telegramData.id;
    const userName = req.telegramData.username;
    
    if (!userId || !botType || !appName || !sessionId) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    // Check for a pending payment for this user/bot
    const pendingPaymentResult = await pool.query(
        'SELECT reference FROM pending_payments WHERE user_id = $1 AND app_name = $2',
        [userId, appName]
    );
    if (pendingPaymentResult.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'A payment is already pending for this app. Please complete it or cancel via the main bot.' });
    }

    const isSessionIdValid = (botType === 'raganork' && sessionId.startsWith(RAGANORK_SESSION_PREFIX) && sessionId.length >= 10) ||
                             (botType === 'levanter' && sessionId.startsWith(LEVANTER_SESSION_PREFIX) && sessionId.length >= 10);
    
    if (!isSessionIdValid) {
        return res.status(400).json({ success: false, message: `Invalid session ID format for bot type "${botType}".` });
    }
    
    const deployVars = {
        SESSION_ID: sessionId,
        APP_NAME: appName,
        AUTO_STATUS_VIEW: autoStatusView === 'Yes' ? 'no-dl' : 'false'
    };

    let deploymentSuccess = false;
    let deploymentMessage = 'Deployment failed.';

    try {
        if (isFreeTrial) {
             const check = await dbServices.canDeployFreeTrial(userId);
             if (!check.can) {
                return res.status(400).json({ success: false, message: `You have already used your Free Trial. You can use it again after: ${check.cooldown.toLocaleString()}.` });
             }
             // Trigger the deployment directly for a free trial
             await buildWithProgress(userId, deployVars, true, false, botType);
             deploymentSuccess = true;
             deploymentMessage = 'Free Trial deployment initiated. Check the bot chat for updates!';
        } else if (deployKey) {
            const usesLeft = await dbServices.useDeployKey(deployKey, userId);
            if (usesLeft === null) {
                return res.status(400).json({ success: false, message: 'Invalid or expired deploy key.' });
            }
            // Trigger the deployment for a valid key
            await buildWithProgress(userId, deployVars, false, false, botType);
            deploymentSuccess = true;
            deploymentMessage = 'Deployment initiated with key. Check the bot chat for updates!';
            
            // Notify admin about key usage
            await bot.sendMessage(ADMIN_ID,
                `*New App Deployed (Mini App)*\n` +
                `*User:* @${escapeMarkdown(userName || 'N/A')} (\`${userId}\`)\n` +
                `*App Name:* \`${appName}\`\n` +
                `*Key Used:* \`${deployKey}\`\n` +
                `*Uses Left:* ${usesLeft}`,
                { parse_mode: 'Markdown' }
            );

        } else {
            return res.status(400).json({ success: false, message: 'A deploy key is required for paid deployments. Please provide one or use the "Pay" option.' });
        }

        // Send a message to the user in their bot chat confirming the start
        await bot.sendMessage(userId, 
            `Deployment of your *${escapeMarkdown(appName)}* bot has started via the Mini App.\n\n` +
            `You will receive a notification here when the bot is ready.`, 
            { parse_mode: 'Markdown' });

        res.json({ success: deploymentSuccess, message: deploymentMessage });

    } catch (e) {
        console.error('[MiniApp Server] Deployment error:', e);
        res.status(500).json({ success: false, message: e.message || 'An unknown error occurred during deployment.' });
    }
});


// Endpoint to handle the payment flow
app.post('/api/pay', validateWebAppInitData, async (req, res) => {
    const { botType, appName, sessionId, autoStatusView, email } = req.body;
    const userId = req.telegramData.id;
    const priceInKobo = (parseInt(process.env.KEY_PRICE_NGN, 10) || 1500) * 100;
    
    if (!userId || !botType || !appName || !sessionId || !email) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }
    
    try {
        const reference = crypto.randomBytes(16).toString('hex');
        
        // Save pending payment record
        await pool.query(
            'INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [reference, userId, email, botType, appName, sessionId]
        );
        
        const paystackResponse = await axios.post('https://api.paystack.co/transaction/initialize', 
            {
                email: email,
                amount: priceInKobo,
                reference: reference,
                callback_url: `https://t.me/${bot.username}` // Direct user back to the bot
            },
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        res.json({ success: true, paymentUrl: paystackResponse.data.data.authorization_url });
    } catch (e) {
        console.error('Paystack error:', e.response?.data || e.message);
        res.status(500).json({ success: false, message: 'Failed to create payment link.' });
    }
});


// We export both the app and the init function
module.exports = { app, init };
