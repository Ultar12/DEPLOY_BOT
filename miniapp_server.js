// miniapp_server.js

const express = require('express');
const axios = require('axios');
const path = require('path');
const { init: servicesInit } = require('./bot_services');

// Global variables for this module, will be populated by init function
let bot;
let HEROKU_API_KEY;
let pool;
let ADMIN_ID;
let dbServices; // The services will now be passed in
let buildWithProgress;

// Initialization function to set up dependencies from bot.js
function init(params) {
    bot = params.bot;
    HEROKU_API_KEY = params.HEROKU_API_KEY;
    pool = params.pool;
    ADMIN_ID = params.ADMIN_ID;
    dbServices = params.dbServices;
    buildWithProgress = params.buildWithProgress;
    
    console.log('[MiniApp Server] Module initialized with bot dependencies.');
}

// Create the Express app
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

// We export both the app and the init function
module.exports = { app, init };
