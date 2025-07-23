// web_server.js

const express = require('express');

/**
 * Starts a simple Express.js web server.
 * This is primarily for platforms like Render that require a web service to bind to a port
 * for health checks, even if the main application (like a Telegram bot) uses polling.
 */
function startWebServer() {
    const app = express();
    const port = process.env.PORT || 3000; // Render provides the PORT env var

    // A basic GET endpoint for Render's health checks or general access.
    app.get('/', (req, res) => {
        res.status(200).send('🤖 Bot service is live! (This is a heartbeat endpoint for Render)');
    });

    // You can add other routes here if your bot ever needs to receive webhooks
    // (e.g., app.post('/webhook', (req, res) => { /* Telegram webhook logic */ }));
    // If you add webhook routes, remember to remove bot.startPolling() from bot.js
    // and configure Telegram with your webhook URL.

    app.listen(port, () => {
        console.log(`🌐 Web server started on port ${port} for Render health checks.`);
    });
}

module.exports = { startWebServer };
