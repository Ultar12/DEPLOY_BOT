// miniapp_server.js

const express = require('express');
const axios = require('axios');
const path = require('path');
const { init: servicesInit, buildWithProgress } = require('./bot_services');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

// IMPORTANT: This file needs access to your global variables and dependencies
// We will mock them for demonstration purposes. In bot.js, you will pass the real ones.
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const backupPool = new Pool({ connectionString: process.env.DATABASE_URL2, ssl: { rejectUnauthorized: false } });

// You would need to add these global variables to your bot.js file for them to be passed
const appDeploymentPromises = new Map();
function getAnimatedEmoji() { return '🚀'; }
async function animateMessage(chatId, messageId, baseText) { return null; }
async function sendAnimatedMessage(chatId, baseText) { return { message_id: 123 }; }
function monitorSendTelegramAlert(message, chatId) { console.log(`[ALERT to ${chatId}]: ${message}`); }
function escapeMarkdown(text) { return text.replace(/([_*`>])/g, '\\$1'); }
const defaultEnvVars = { levanter: {}, raganork: {} };

servicesInit({
    mainPool: pool,
    backupPool: backupPool,
    bot: bot,
    HEROKU_API_KEY: process.env.HEROKU_API_KEY,
    GITHUB_LEVANTER_REPO_URL: process.env.GITHUB_LEVANTER_REPO_URL,
    GITHUB_RAGANORK_REPO_URL: process.env.GITHUB_RAGANORK_REPO_URL,
    ADMIN_ID: process.env.ADMIN_ID,
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Endpoint to serve the Mini App's HTML
app.get('/deploy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to check if an app name is available
app.get('/api/check-app-name/:appName', async (req, res) => {
    const appName = req.params.appName;
    try {
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${process.env.HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
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
        await bot.sendMessage(userId, `Deployment of app *${escapeMarkdown(appName)}* has been initiated via the Mini App. You will be notified when it's live!`, { parse_mode: 'Markdown' });
        
        await buildWithProgress(userId, deployVars, false, false, botType);
        res.json({ success: true, message: 'Deployment initiated. Check bot for updates.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = app;
