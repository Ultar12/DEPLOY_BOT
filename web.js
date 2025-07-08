// web.js
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios'); // Needed for Heroku API calls
require('dotenv').config(); // Load .env for environment variables

const app = express();
const PORT = process.env.PORT || 3000; // Use Heroku's PORT or default for local development

// Database connection (re-using the same connection string)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Middleware to parse JSON bodies from incoming requests
app.use(express.json());
// Serve static files (HTML, CSS, JS) from the 'public' directory
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

// API endpoint: Restart a specific bot on Heroku
// IMPORTANT: In a real-world application, this endpoint MUST be secured with authentication/authorization.
app.post('/api/restart-bot', async (req, res) => {
    const { botName } = req.body;
    if (!botName) {
        return res.status(400).json({ error: 'Bot name is required.' });
    }

    try {
        // Validate HEROKU_API_KEY
        if (!process.env.HEROKU_API_KEY) {
            console.error('HEROKU_API_KEY is not set in environment variables.');
            return res.status(500).json({ error: 'Server configuration error: Heroku API key missing.' });
        }

        await axios.delete(`https://api.heroku.com/apps/${botName}/dynos`, {
            headers: {
                Authorization: `Bearer ${process.env.HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3'
            }
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

// Start the Express server
app.listen(PORT, () => {
    console.log(`Web server running on port ${PORT}`);
    console.log(`Access dashboard at: http://localhost:${PORT}`);
});
