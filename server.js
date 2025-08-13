// server.js

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const { Pool } = require('pg');
const { init: servicesInit, buildWithProgress } = require('./bot_services');
const TelegramBot = require('node-telegram-bot-api');

// --- Environment Variables & Dependencies ---
const {
    TELEGRAM_BOT_TOKEN,
    HEROKU_API_KEY,
    ADMIN_ID,
    DATABASE_URL,
    DATABASE_URL2,
    GITHUB_LEVANTER_REPO_URL,
    GITHUB_RAGANORK_REPO_URL,
    PAYSTACK_SECRET_KEY,
    INTER_BOT_API_KEY
} = process.env;

const PORT = process.env.PORT || 3000;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const backupPool = new Pool({ connectionString: DATABASE_URL2, ssl: { rejectUnauthorized: false } });

// --- Mocking functions needed by bot_services.js ---
const appDeploymentPromises = new Map();
function getAnimatedEmoji() { return '🚀'; }
async function animateMessage(chatId, messageId, baseText) { return null; }
async function sendAnimatedMessage(chatId, baseText) { return { message_id: 123 }; }
function monitorSendTelegramAlert(message, chatId) { console.log(`[ALERT to ${chatId}]: ${message}`); }
function escapeMarkdown(text) { return text.replace(/([_*`>])/g, '\\$1'); }
const defaultEnvVars = { levanter: {}, raganork: {} };

// Initialize bot_services with dependencies
servicesInit({
    mainPool: pool,
    backupPool: backupPool,
    bot: bot,
    HEROKU_API_KEY: HEROKU_API_KEY,
    GITHUB_LEVANTER_REPO_URL: GITHUB_LEVANTER_REPO_URL,
    GITHUB_RAGANORK_REPO_URL: GITHUB_RAGANORK_REPO_URL,
    ADMIN_ID: ADMIN_ID,
    defaultEnvVars: defaultEnvVars,
    appDeploymentPromises: appDeploymentPromises,
    RESTART_DELAY_MINUTES: 1,
    getAnimatedEmoji: getAnimatedEmoji,
    animateMessage: animateMessage,
    sendAnimatedMessage: sendAnimatedMessage,
    monitorSendTelegramAlert: monitorSendTelegramAlert,
    escapeMarkdown: escapeMarkdown,
});

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API Endpoints for the Mini App ---

// Endpoint to serve the Mini App's HTML
app.get('/deploy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to check if an app name is available
app.get('/api/check-app-name/:appName', async (req, res) => {
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
app.post('/api/deploy', async (req, res) => {
    const { userId, botType, appName, sessionId, autoStatusView, deployKey } = req.body;
    
    // You must add real validation and security checks here
    if (!userId || !botType || !appName || !sessionId) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    
    // TODO: Add payment and key validation logic here
    
    const deployVars = {
        SESSION_ID: sessionId,
        APP_NAME: appName,
        AUTO_STATUS_VIEW: autoStatusView
    };

    try {
        // Use your existing `buildWithProgress` function
        await buildWithProgress(userId, deployVars, false, false, botType);
        res.json({ success: true, message: 'Deployment initiated. Check bot for updates.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Mini App backend running on port ${PORT}`);
});
