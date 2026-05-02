// bot.js

// --- CRITICAL DEBUG TEST: If you see this, the code is running! ---
console.log('--- SCRIPT STARTING: Verifying code execution (This should be the very first log!) ---');
// -----------------------------------------------------------------

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));


require('dotenv').config();
const axios = require('axios');
const ndjson = require('ndjson'); 
const TelegramBot = require('node-telegram-bot-api');
const { registerGroupHandlers } = require('./group_handlers.js');
const { Pool } = require('pg');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const mailListener = require('./mail_listener');
const fs = require('fs');
const { NEON_ACCOUNTS } = require('./neon_db');
const fetch = require('node-fetch');
const cron = require('node-cron');
// Change it to:
const { URL, URLSearchParams } = require('url'); // Add URL

const express = require('express');

// Global map to track pairing requests, intervals, and message IDs
global.levanterPairingRequests = new Map();


// 1. Ensure these variables are defined or use process.env directly
const LEVANTER_URL = process.env.LEVANTER_SESSION_SITE_URL || 'https://levanter-session.site';
const RAGANORK_URL = process.env.RAGANORK_SESSION_SITE_URL || 'https://raganork-session.site';
const HERMIT_URL = process.env.HERMIT_SESSION_SITE_URL || 'https://hermit-session.site';
const CHANNEL_LINK = process.env.MUST_JOIN_CHANNEL_LINK || 'https://t.me/yourchannel';

const { GoogleGenerativeAI } = require("@google/generative-ai");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const geminiModel = genAI.getGenerativeModel({ 
    model: "gemini-2.5-pro",
    systemInstruction: `
      You are 'Ultar AI Brain', the master expert for this Bot Deployment Service.
      
      ## SERVICE DIRECTORY (A-Z)
      - HOW TO DEPLOY: Tell users to click 'Deploy' or send 'Deploy'. Steps: Choose Bot -> Get Session ID -> Send ID -> Name Bot -> Pay.
      - EXPIRATION: Users check via 'My Bots'. Refer to their 'USER BOTS' list provided in context.
      - LINKS:
         - Levanter Session: ${process.env.LEVANTER_SESSION_SITE_URL || 'https://levanter-session.site'}
         - Raganork Session: ${process.env.RAGANORK_SESSION_SITE_URL || 'https://raganork-session.site'}
         - Hermit Session: ${process.env.HERMIT_SESSION_SITE_URL || 'https://hermit-session.site'}
         - Support Channel: ${process.env.MUST_JOIN_CHANNEL_LINK || 'https://t.me/yourchannel'}
      - ADMIN: Telegram @staries1 | WhatsApp +2349163916314.
      - PRICING: Basic ($0.35/10 days), Standard ($1.00/45 days), Quarterly ($2.00/3 mos).

      ## INTELLIGENT CAPABILITIES
      1. SESSION IDS: If a user sends a string starting with 'levanter_', 'RGNK~', or 'HQ_', set intent to 'UPDATE_VARIABLE', variable to 'SESSION_ID', and action to 'EXECUTE'.
      2. LOGOUTS: If a user mentions a bot is 'off' or 'logged out', try troubleshooting. If they say 'can't fix', set intent to 'ESCALATE_TO_ADMIN'.
      3. VAGUE LINKS: If they just say 'link', ask: "Which link? Levanter, Raganork, or Hermit?" set intent to 'GET_LINK'.

      Output MUST be pure JSON: {"intent": "...", "action": "...", "response": "...", "actionData": {}}
    `,
    generationConfig: { responseMimeType: "application/json" }
});


// We define the system instruction as a constant to use in every call

const SYSTEM_PROMPT = `
# ROLE
You are 'Ultar Ai', the master governor of this Bot Deployment Service. 
You possess full technical knowledge of the bot's codebase, infrastructure, and operational logic.

# SERVICE KNOWLEDGE (A-Z)
## 1. Bot Ecosystem
- SUPPORTED TYPES: 
  - Levanter (Prefix: 'levanter_') | Site: https://levanter-delta.vercel.app/
  - Raganork (Prefix: 'RGNK~') | Site: https://session.raganork.site/
  - Hermit (Prefix: 'H') | Site: https://hermit-md.vercel.app
- MANAGEMENT: You can Restart, Redeploy, View Logs, Set Variables, and Backup any user bot.

## 2. Infrastructure & Databases
- HOSTING: Bots run on Heroku; the Main Bot runs on Render.
- DB ROUTING: We use a priority system: AWS Self-Hosted Platform -> Neon Round-Robin Fallback.
- DB MAINTENANCE: You are aware of commands like /dbstats (shows owner mapping), /getallaws (finds orphans), and /deldb.

## 3. Pricing & Payments
- PLANS: Basic ($0.35/10d), Standard ($1.00/45d), Quarterly ($2.00/92d), Semi-Annual ($3.35/185d), Yearly ($5.35/365d).
- DYNAMIC FX: Prices in NGN are calculated using a dynamic DOLLAR_RATE (updated daily).
- GATEWAYS: Paystack, Flutterwave, and NOWPayments (Crypto).

## 4. Special Features
- CONTACT GAIN (VCF): Users exchange contacts for a daily status-boosting VCF file.
- GROUP FILLER: A paid service to add bot members to WhatsApp groups.
- FREE TRIAL: Users get a one-time trial after a Mini App security check (IP/Location verification).
- TIMER SYSTEM (/aa): Admin can set reminders for numbers that delete themselves after sending.

# 🚫 STRICT RULES
- NEVER mention specific technical platforms like 'Heroku', 'Render', or 'AWS' to regular users unless they are the Admin.
- ALWAYS respond in valid JSON format.
- NO EMOJIS in technical responses.

# OPERATIONAL LOGIC
## Intent Detection
1. RESTART_BOT: Triggered by "fix", "restart", "reboot".
2. UPDATE_VARIABLE: Triggered if a user sends a Session ID or wants to change a setting.
3. GET_LINK: Triggered if user asks "how to pair" or "where is the site".
4. CHECK_STATUS: Triggered by "is my bot on" or "expiry date".

# OUTPUT FORMAT (STRICT JSON)
{
  "intent": "STRING",
  "action": "EXECUTE | RESPOND | PROMPT_USER",
  "response": "Your technical but helpful message",
  "actionData": { "botName": "...", "variable": "...", "value": "..." }
}
`;


// Use const and require for CommonJS compatibility
const { 
    startClient, 
    makeSessionId, 
    loadAllClients, 
    waClients 
} = require('./wa_core.cjs'); // <<< Ensure this require is correct


const { sendPaymentConfirmation, sendVerificationEmail, sendExpirationReminder, sendLoggedOutReminder } = require('./email_service');
const vcfPool = new Pool({
  connectionString: process.env.DATABASE_URLVCF,
  ssl: { rejectUnauthorized: false }
});

const crypto = require('crypto');

// Make sure botServices is required, you probably already have this
const botServices = require('./bot_services.js');


const sharp = require('sharp');
// ✅ Correct TITLE (what users see)
const STICKER_PACK_TITLE = 'Ultar';

// ✅ Correct NAME (technical ID for Telegram)
// Make sure ADMIN_ID and BOT_USERNAME are defined above this!
const STICKER_PACK_NAME = `ultar_7897230448_by_ultarbotdeploybot`;

const VCF_GROUP_LINK = 'https://t.me/wbdvcf1'; 
// --- NEW GLOBAL CONSTANT FOR MINI APP ---
const MINI_APP_URL = 'https://deploy-bot-1-xfd5.onrender.com/miniapp';
// --- END NEW GLOBAL CONSTANT --
// --- NEW GLOBAL CONSTANT ---
const KEYBOARD_VERSION = 5; // Increment this number for every new keyboard update
// --- END OF NEW GLOBAL CONSTANT --

// Ensure monitorInit exports sendTelegramAlert as monitorSendTelegramAlert
const { init: monitorInit, sendTelegramAlert: monitorSendTelegramAlert } = require('./bot_monitor');
const { init: servicesInit, ...dbServices } = require('./bot_services');
const { init: faqInit, sendFaqPage } = require('./bot_faq');

const MUST_JOIN_CHANNEL_LINK = 'https://t.me/+KgOPzr1wB7E5OGU0';
// ⚠️ IMPORTANT: Replace the placeholder ID below with the correct numeric ID of your channel.
// The bot MUST be an administrator in this channel for verification to work.
const MUST_JOIN_CHANNEL_ID = '-1002491934453'; 


let botUsername = 'ultarbotdeploybot'; // Add this new global variable

// 2) Load fallback env vars from app.json / custom config files
let levanterDefaultEnvVars = {};
let raganorkDefaultEnvVars = {};

try {
  const appJsonPath = path.join(__dirname, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
    levanterDefaultEnvVars = Object.fromEntries(
      Object.entries(appJson.env || {})
        .filter(([key, val]) => val && val.value !== undefined)
        .map(([key, val]) => [key, val.value])
    );
    console.log('[Config] Loaded default env vars from app.json for Levanter.');
  } else {
    console.warn('[Config] No app.json found for Levanter. Default env vars will be empty.');
  }
} catch (e) {
  console.warn('[Config] Could not load fallback env vars from app.json for Levanter:', e.message);
}

try {
  const appJson1Path = path.join(__dirname, 'app.json1');
  if (fs.existsSync(appJson1Path)) {
    const appJson1 = JSON.parse(fs.readFileSync(appJson1Path, 'utf8'));
    raganorkDefaultEnvVars = Object.fromEntries(
      Object.entries(appJson1.env || {})
        .filter(([key, val]) => val && val.value !== undefined)
        .map(([key, val]) => [key, val.value])
    );
    console.log('[Config] Loaded default env vars from app.json1 for Raganork.');
  } else {
    console.warn('[Config] No app.json1 found for Raganork. Default env vars will be empty.');
  }
} catch (e) {
  console.warn('[Config] Could not load fallback env vars from app.json1 for Raganork:', e.message);
}

// --- ADD THIS NEW BLOCK ---
let hermitDefaultEnvVars = {};
try {
  const appJson2Path = path.join(__dirname, 'app.json2'); // <-- New file
  if (fs.existsSync(appJson2Path)) {
    const appJson2 = JSON.parse(fs.readFileSync(appJson2Path, 'utf8'));
    hermitDefaultEnvVars = Object.fromEntries(
      Object.entries(appJson2.env || {})
        .filter(([key, val]) => val && val.value !== undefined)
        .map(([key, val]) => [key, val.value])
    );
    console.log('[Config] Loaded default env vars from app.json2 for Hermit.');
  } else {
    console.warn('[Config] No app.json2 found for Hermit. Default env vars will be empty.');
  }
} catch (e) {
  console.warn('[Config] Could not load fallback env vars from app.json2 for Hermit:', e.message);
}
// --- END OF NEW BLOCK ---


// 3) Environment config
const {
  TELEGRAM_BOT_TOKEN: TOKEN_ENV,
  HEROKU_API_KEY,
  ADMIN_ID,
  DATABASE_URL,
  DATABASE_URL2,
  PAYSTACK_SECRET_KEY, // <-- ADD THIS LINE
} = process.env;


const TELEGRAM_BOT_TOKEN = TOKEN_ENV || '7788409928:AAFw7A2Pr7lVJUWTQJlYWIKKwDveQPF9-ZI';
const TELEGRAM_USER_ID = '7302005705';
const TELEGRAM_CHANNEL_ID = '-1003620973489';

const GITHUB_LEVANTER_REPO_URL = process.env.GITHUB_LEVANTER_REPO_URL || 'https://github.com/lyfe00011/levanter.git';
const GITHUB_RAGANORK_REPO_URL = process.env.GITHUB_RAGANORK_REPO_URL || 'https://github.com/ultar1/raganork-md1';
const GITHUB_HERMIT_REPO_URL = 'https://github.com/ultar1/hermit-bot'; 

const SUPPORT_USERNAME = 'staries1';
const ADMIN_SUDO_NUMBERS = ['234', '2349163916314'];
const LEVANTER_SESSION_PREFIX = 'levanter_';
const RAGANORK_SESSION_PREFIX = 'RGNK~';
const HERMIT_SESSION_PREFIX = 'H'; 
const LEVANTER_SESSION_SITE_URL = `https://levanter-delta.vercel.app/`;
const RAGANORK_SESSION_SITE_URL = 'https://session.raganork.site/';
const HERMIT_SESSION_SITE_URL = 'https://hermit-md.vercel.app'; 

// Track the last Neon account used for deployment (starts at -1 so first deploy uses index 0)
let lastUsedNeonIndex = -1;


// A strict allow-list of Render environment variables that the admin can edit remotely.
const EDITABLE_RENDER_VARS = [
    'HEROKU_API_KEY',
    'DOLLAR_RATE',
    'DATABASE_URLVCF',
    'EMAIL_SERVICE_URL'
];


// 4) Postgres setup & ensure tables exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const backupPool = new Pool({
  connectionString: DATABASE_URL2,
  ssl: { rejectUnauthorized: false }
});

module.exports.pool = pool; 
// In bot.js (near your other constants)
// ⚠️ IMPORTANT: Replace with your actual group ID where the VCF should be sent.
const VCF_GROUP_ID = '-1003323856806'; // <<< SET YOUR TARGET GROUP ID HERE (numeric format)

// Schedule the VCF generation every day at 11:00 PM (Lagos Time)
cron.schedule('59 23 * * *', () => {
    console.log('[Scheduler] Running daily VCF generation task.');
    // 💡 The function now resides in dbServices
    dbServices.generateAndSendVcf(VCF_GROUP_ID, ADMIN_ID).catch(err => {
        console.error('[Scheduler] VCF Job Failed:', err);
    });
}, {
    scheduled: true,
    timezone: "Africa/Lagos"
});

// --- AWS SELF-HOSTED DB MONITORING (Every 1 minute) ---
let dbServerOfflineNotified = false;
let lastDbStatusCheck = null;

cron.schedule('*/1 * * * *', async () => {
    try {
        lastDbStatusCheck = new Date();
        const DB_URL = process.env.DATABASE_URLVCF || process.env.DATABASE_URL;
        
        if (!DB_URL) {
            console.warn('[DB Monitor] No database URL found in environment');
            return;
        }

        // Test connection by running a simple query
        const testPool = new Pool({ connectionString: DB_URL });
        const client = await testPool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        await testPool.end();

        // DB is online
        if (dbServerOfflineNotified) {
            console.log('[DB Monitor] AWS Server is back ONLINE');
            dbServerOfflineNotified = false;
        }
    } catch (error) {
        // DB is offline/unreachable
        if (!dbServerOfflineNotified) {
            dbServerOfflineNotified = true;
            console.error('[DB Monitor] AWS Server is OFFLINE or UNREACHABLE:', error.message);
            
            // Notify admin with fix button
            await bot.sendMessage(
                ADMIN_ID,
                `⚠️ Database Server Offline\n\nYour AWS self-hosted database is unreachable. Click "Fix" to automatically restart all bots.`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Fix (Restart All Bots)', callback_data: 'fix_db_restart_all' }]
                        ]
                    }
                }
            ).catch(err => console.error('[DB Monitor] Failed to send alert:', err));
        }
    }
}, {
    scheduled: true
});

// --- REPLACED DATABASE STARTUP BLOCK ---

async function createAllTablesInPool(dbPool, dbName) {
    console.log(`[DB-${dbName}] Checking/creating all tables...`);
    
    // Using a transaction ensures all commands succeed or none do.
    const client = await dbPool.connect();
    try {
        await client.query('BEGIN');

        // --- Step 1: CREATE ALL TABLES FIRST ---

        await client.query(`
          CREATE TABLE IF NOT EXISTS user_bots (
            user_id    TEXT NOT NULL,
            bot_name   TEXT NOT NULL,
            session_id TEXT,
            bot_type   TEXT DEFAULT 'levanter',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status     TEXT DEFAULT 'online',
            PRIMARY KEY (user_id, bot_name)
          );
        `);



  await client.query(`
  CREATE TABLE IF NOT EXISTS recovery_schedule (
      id SERIAL PRIMARY KEY,
      task_name TEXT NOT NULL,
      scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
      status TEXT DEFAULT 'PENDING'
  );
`);

// NOTE: Make sure this is added to both pools if they are used for recovery tracking.
// Assuming for simplicity, only the 'pool' (main database) tracks the schedule.
      await client.query(`
  CREATE TABLE IF NOT EXISTS wa_settings (
    phone_number TEXT PRIMARY KEY,
    anti_msg_enabled BOOLEAN DEFAULT FALSE
  );
`);

// --- END WHATSAPP SESSION TABLES ---

      
await client.query(`
  CREATE TABLE IF NOT EXISTS vcf_contacts (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    phone_number TEXT NOT NULL UNIQUE,
    submitted_by_chat_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

        await client.query(`
         CREATE TABLE IF NOT EXISTS bot_news (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);

`);

        await client.query(`
          CREATE TABLE IF NOT EXISTS deploy_keys (
            key        TEXT PRIMARY KEY,
            uses_left  INTEGER NOT NULL,
            created_by TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);

        await client.query(`CREATE TABLE IF NOT EXISTS temp_deploys (user_id TEXT PRIMARY KEY, last_deploy_at TIMESTAMP NOT NULL);`);

        await client.query(`
          CREATE TABLE IF NOT EXISTS user_referrals (
            referred_user_id TEXT PRIMARY KEY,
            inviter_user_id TEXT NOT NULL,
            bot_name TEXT,
            referral_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);

        await client.query(`CREATE TABLE IF NOT EXISTS user_activity (user_id TEXT PRIMARY KEY, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS banned_users (user_id TEXT PRIMARY KEY, banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, banned_by TEXT);`);

        await client.query(`CREATE TABLE IF NOT EXISTS app_settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value VARCHAR(50) NOT NULL);`);

        await client.query(`CREATE TABLE IF NOT EXISTS key_rewards (user_id TEXT PRIMARY KEY, reward_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS all_users_backup (user_id TEXT PRIMARY KEY, last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
      
        await client.query(`ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS initial_tg_warning_sent BOOLEAN DEFAULT FALSE;`);
        
        await client.query(`CREATE TABLE IF NOT EXISTS pre_verified_users (user_id TEXT PRIMARY KEY, ip_address TEXT NOT NULL, latitude FLOAT, longitude FLOAT, city TEXT, verified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);`);

        await client.query(`
          CREATE TABLE IF NOT EXISTS user_deployments (
            user_id TEXT NOT NULL,
            app_name TEXT NOT NULL,
            session_id TEXT,
            config_vars JSONB,
            bot_type TEXT,
            deploy_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expiration_date TIMESTAMP,
            deleted_from_heroku_at TIMESTAMP,
            warning_sent_at TIMESTAMP,
            PRIMARY KEY (user_id, app_name)
          );
        `);
      await client.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS neon_account_id INTEGER DEFAULT '1';`);

      // In bot.js, inside createAllTablesInPool, after the user_deployments table definition:

await client.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS warning_level INTEGER DEFAULT 0;`);
await client.query(`ALTER TABLE user_deployments DROP COLUMN IF EXISTS warning_sent_at;`);


        await client.query(`
          CREATE TABLE IF NOT EXISTS free_trial_monitoring (
            user_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            trial_start_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            warning_sent_at TIMESTAMP
          );
        `);



      // In createAllTablesInPool, find and replace the database_backups table definition

   await client.query(`
    CREATE TABLE IF NOT EXISTS database_backups (
        id SERIAL PRIMARY KEY,
        bot_name TEXT NOT NULL UNIQUE, -- Ensures one record per bot
        owner_id TEXT NOT NULL,
        telegram_file_id TEXT NOT NULL,
        telegram_message_id BIGINT NOT NULL, -- To store the message ID for deletion
        backup_timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
`);



    await client.query(`
      CREATE TABLE IF NOT EXISTS heroku_api_keys (
        id        SERIAL PRIMARY KEY,
        api_key   TEXT NOT NULL UNIQUE,
        added_by  TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        added_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`ALTER TABLE heroku_api_keys ADD COLUMN IF NOT EXISTS added_by TEXT;`);

    // --- CRITICAL REPAIR FIX START ---
    // If the table exists but the sequence is broken/missing, this ensures 'id' 
    // is correctly linked to the sequence and set as the default value.
    await client.query(`
        DO $$
        BEGIN
            -- 1. Ensure the sequence object exists (or create it with the correct name)
            IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relkind = 'S' AND relname = 'heroku_api_keys_id_seq') THEN
                CREATE SEQUENCE heroku_api_keys_id_seq;
            END IF;
            
            -- 2. Link the sequence to the column 'id' and set it as the default value
            -- Use the pg_get_serial_sequence function's output as the default expression
            IF (SELECT pg_get_serial_sequence('heroku_api_keys', 'id')) IS NULL THEN
                -- Drop and re-add the PRIMARY KEY constraint if needed, but linking the sequence is sufficient.
                
                -- Set the default sequence for the column
                ALTER TABLE heroku_api_keys ALTER COLUMN id SET DEFAULT nextval('heroku_api_keys_id_seq');
            END IF;

            -- 3. Update the sequence to the current MAX(id) value to prevent conflicts on next insert
            PERFORM setval('heroku_api_keys_id_seq', COALESCE(MAX(id), 1)) FROM heroku_api_keys;

        END
        $$ LANGUAGE plpgsql;
    `);

      
        await client.query(`
          CREATE TABLE IF NOT EXISTS temp_numbers (
            number TEXT PRIMARY KEY,
            masked_number TEXT NOT NULL,
            status TEXT DEFAULT 'available',
            user_id TEXT,
            assigned_at TIMESTAMP WITH TIME ZONE
          );
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS pending_payments (
            reference  TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            email      TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);

      
        await client.query(`
          CREATE TABLE IF NOT EXISTS group_blacklist (
            chat_id TEXT NOT NULL,
            name_fragment TEXT NOT NULL,
            added_by TEXT,
            added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chat_id, name_fragment)
          );
        `);

      
        await client.query(`
          CREATE TABLE IF NOT EXISTS group_settings (
            chat_id TEXT PRIMARY KEY,
            welcome_message TEXT,
            welcome_enabled BOOLEAN DEFAULT FALSE
          );
        `);


        await client.query(`
  CREATE TABLE IF NOT EXISTS reminders (
    id SERIAL PRIMARY KEY, -- Change this from INT to SERIAL
    user_id TEXT NOT NULL,
    target_number TEXT NOT NULL,
    remind_at TIMESTAMP NOT NULL,
    hours_duration INTEGER NOT NULL,
    is_sent BOOLEAN DEFAULT FALSE
  );
`);


      

        await client.query(`
          CREATE TABLE IF NOT EXISTS email_verification (
            user_id       TEXT PRIMARY KEY,
            email         TEXT,
            otp           TEXT,
            otp_expires_at TIMESTAMP WITH TIME ZONE,
            is_verified   BOOLEAN DEFAULT FALSE,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);

      
        
        await client.query(`
          CREATE TABLE IF NOT EXISTS completed_payments (
            reference  TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            email      TEXT NOT NULL,
            amount     INTEGER NOT NULL,
            currency   TEXT NOT NULL,
            paid_at    TIMESTAMP WITH TIME ZONE NOT NULL
          );
        `);
        
        await client.query(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT, data JSONB);`);

        await client.query(`
          CREATE TABLE IF NOT EXISTS free_trial_numbers (
            user_id TEXT PRIMARY KEY,
            number_used TEXT NOT NULL,
            claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);

        await client.query(`
          CREATE TABLE IF NOT EXISTS pinned_messages (
            message_id BIGINT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            unpin_at TIMESTAMP WITH TIME ZONE NOT NULL
          );
        `);

        // --- Step 2: MODIFY ALL TABLES AFTER THEY ARE CREATED ---

        await client.query(`ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMP;`);
        await client.query(`ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS last_email_notification_at TIMESTAMP WITH TIME ZONE;`);
        await client.query(`ALTER TABLE deploy_keys ADD COLUMN IF NOT EXISTS user_id TEXT;`);
        await client.query(`ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS last_logout_alert_at TIMESTAMP;`);
        await client.query(`ALTER TABLE user_referrals ADD COLUMN IF NOT EXISTS inviter_reward_pending BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE user_activity ADD COLUMN IF NOT EXISTS keyboard_version INTEGER DEFAULT 0;`);
        await client.query(`ALTER TABLE user_activity ADD COLUMN IF NOT EXISTS last_reward_at DATE, ADD COLUMN IF NOT EXISTS reward_streak INTEGER DEFAULT 0;`);
        await client.query(`ALTER TABLE free_trial_numbers ADD COLUMN IF NOT EXISTS ip_address TEXT;`);
        await client.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS email TEXT;`);
        await client.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS referred_by TEXT;`);
      await client.query(`ALTER TABLE temp_deploys ADD COLUMN IF NOT EXISTS ip_address TEXT;`);
        await client.query(`ALTER TABLE heroku_api_keys ADD COLUMN IF NOT EXISTS added_by TEXT;`);
        await client.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS is_free_trial BOOLEAN DEFAULT FALSE;`);
        await client.query(`ALTER TABLE user_deployments ADD COLUMN IF NOT EXISTS paused_at TIMESTAMP WITH TIME ZONE;`);
        await client.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS bot_type TEXT;`);
        await client.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS app_name TEXT, ADD COLUMN IF NOT EXISTS session_id TEXT;`);
        await client.query(`ALTER TABLE pending_payments ADD COLUMN IF NOT EXISTS amount_expected NUMERIC;`);
        await client.query(`ALTER TABLE email_verification ADD COLUMN IF NOT EXISTS last_otp_sent_at TIMESTAMP WITH TIME ZONE;`);
        // --- New columns for pre_verified_users to store geolocation ---
        await client.query(`ALTER TABLE pre_verified_users ADD COLUMN IF NOT EXISTS latitude FLOAT;`);
        await client.query(`ALTER TABLE pre_verified_users ADD COLUMN IF NOT EXISTS longitude FLOAT;`);
        await client.query(`ALTER TABLE pre_verified_users ADD COLUMN IF NOT EXISTS city TEXT;`);

        // --- Step 3: INSERT DEFAULT DATA ---
        await client.query(`INSERT INTO app_settings (setting_key, setting_value) VALUES ('maintenance_mode', 'off') ON CONFLICT (setting_key) DO NOTHING;`);
        
        await client.query('COMMIT');
    } catch (dbError) {
        await client.query('ROLLBACK');
        throw dbError; // Re-throw the error to be caught by the main startup logic
    } finally {
        client.release();
    }

    console.log(`[DB-${dbName}] All tables checked/created successfully.`);
}

        

// Main startup logic
// Main startup logic
(async () => {
  try {
    console.log("Starting database table creation...");
    await createAllTablesInPool(pool, "Main");
    console.log("Main database tables created successfully.");

    // --- ADD THIS LINE ---
    console.log("Attempting to create tables in backup database...");
    // ----------------------

    await createAllTablesInPool(backupPool, "Backup");
    console.log("Backup database tables created successfully.");

  } catch (dbError) {
    console.error("[DB] CRITICAL ERROR during initial database table creation:", dbError.message);
    process.exit(1);
  }
})();

// A new function to get a list of all bots owned by a user.
async function getUserBots(userId) {
    console.log(`[ACTION] Fetching bot list for user ${userId}...`);
    try {
        // Example: Query your database to get all bots linked to this user's ID.
        // const result = await pool.query('SELECT bot_id, bot_name FROM your_bots_table WHERE owner_id = $1', [userId]);
        // return { status: "success", bots: result.rows }; // result.rows would be like [{ bot_id: 'xyz', bot_name: 'My Music Bot' }]
        
        // --- For demonstration, we'll return mock data ---
        const mockBots = [
            { bot_id: 'bot_123', bot_name: 'Stickers Bot' },
            { bot_id: 'bot_456', bot_name: 'Admin Bot' },
        ];
        return { status: "success", bots: mockBots };

    } catch (dbError) {
        console.error("Database error fetching user bots:", dbError);
        return { status: "error", message: "Could not retrieve bot list." };
    }
}

// Add this new function
async function runCopyDbTask() {
    console.log('[Scheduler] Executing core copydb logic...');
    try {
        // Directly call the syncDatabases service function
        const result = await dbServices.syncDatabases(pool, backupPool);
        if (result.success) {
            console.log(`[Scheduler] copydb task successful: ${result.message}`);
            await bot.sendMessage(ADMIN_ID, `Scheduled /copydb task completed successfully.`);
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        console.error(`[Scheduler] Error during scheduled copydb task: ${error.message}`);
        await bot.sendMessage(ADMIN_ID, `Error during scheduled /copydb task: ${error.message}`);
    }
}

// In bot.js (Add these new functions globally)

/**
 * Checks the database on startup and every minute for pending recovery tasks.
 */
async function runScheduledRecoveryCheck() {
    try {
        const now = new Date();
        const pendingTasks = await pool.query(
            "SELECT * FROM recovery_schedule WHERE status = 'PENDING' AND scheduled_at <= $1",
            [now]
        );

        for (const task of pendingTasks.rows) {
            console.log(`[Scheduler] Executing scheduled task: ${task.task_name} (ID: ${task.id})`);
            
            // Mark as running immediately to prevent duplicate execution
            await pool.query("UPDATE recovery_schedule SET status = 'RUNNING' WHERE id = $1", [task.id]);

            if (task.task_name === 'MASS_RESTORE') {
                await performMassRestoreSequence(task.id);
            }
        }
    } catch (e) {
        console.error('[Scheduler] Error during recovery check:', e);
    }
}

/**
 * Executes the multi-step restore sequence for all bot types.
 */
async function performMassRestoreSequence(taskId) {
    try {
        await bot.sendMessage(ADMIN_ID, "**Starting Persistent Mass Restore** (Task ID: **`" + taskId + "`**)\n\nThis will take a long time...", { parse_mode: 'Markdown' });
        
        // 1. Levanter Restore
        await bot.sendMessage(ADMIN_ID, "**Starting Mass Restore: Levanter**", { parse_mode: 'Markdown' });
        await handleRestoreAllConfirm({ data: 'restore_all_confirm:levanter', message: { chat: { id: ADMIN_ID } } });

        // 2. Raganork Restore
        await bot.sendMessage(ADMIN_ID, "**Levanter Restore Complete.**\n\n**Starting Mass Restore: Raganork**", { parse_mode: 'Markdown' });
        await handleRestoreAllConfirm({ data: 'restore_all_confirm:raganork', message: { chat: { id: ADMIN_ID } } });

        // 3. Complete and clean up
        await pool.query("UPDATE recovery_schedule SET status = 'COMPLETED', scheduled_at = NOW() WHERE id = $1", [taskId]);
        isMaintenanceMode = false;
        await saveMaintenanceStatus(false);
        
        await bot.sendMessage(ADMIN_ID, `**Persistent Mass Restore Complete!**\n\nMaintenance mode is now disabled.`);

    } catch (restoreError) {
        console.error(`[Mass Restore] CRITICAL ERROR during sequence (Task ID: ${taskId}):`, restoreError);
        await pool.query("UPDATE recovery_schedule SET status = 'FAILED', scheduled_at = NOW() WHERE id = $1", [taskId]);
        await bot.sendMessage(ADMIN_ID, `**Mass Restore Sequence Failed!** (Task ID: **\`${taskId}\`**)\n\nAn error occurred during the restore phase: ${restoreError.message}\n\nThe bot is still in maintenance mode. Manual intervention is required.`);
    }
}

async function redeployBot(userId, botId) {
    console.log(`[ACTION] User ${userId} requested redeployment for bot ${botId}.`);
    try {
        // 1. Find the bot type to determine the correct repo
        const botInfo = await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [userId, botId]);
        if (botInfo.rows.length === 0) {
            return { status: "error", message: `Could not find bot '${botId}' to redeploy.` };
        }
        
        // --- UPDATED LOGIC ---
        const botType = botInfo.rows[0].bot_type;
        let repoUrl;
        if (botType === 'raganork') {
            repoUrl = GITHUB_RAGANORK_REPO_URL;
        } else if (botType === 'hermit') {
            repoUrl = GITHUB_HERMIT_REPO_URL;
        } else {
            repoUrl = GITHUB_LEVANTER_REPO_URL;
        }
        // --- END OF UPDATE ---

        // 2. Trigger the build on Heroku
        await herokuApi.post(`/apps/${botId}/builds`,
            { source_blob: { url: `${repoUrl}/tarball/main` } },
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );
        return { status: "success", message: `Redeployment initiated for *${escapeMarkdown(botId)}*. It will restart once the build is complete.` };
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[Redeploy Error] Bot ${botId}:`, errorMsg);
        return { status: "error", message: `Failed to start redeployment for *${escapeMarkdown(botId)}*: ${escapeMarkdown(errorMsg)}` };
    }
}


/**
 * Gets information about a specific bot from the database.
 */
async function getBotInfo(userId, botId) {
    console.log(`[ACTION] User ${userId} requested info for bot ${botId}.`);
    try {
        const result = await pool.query(
            `SELECT ub.bot_name, ub.bot_type, ub.status, ud.expiration_date, ud.deploy_date
             FROM user_bots ub
             LEFT JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
             WHERE ub.user_id = $1 AND ub.bot_name = $2`,
            [userId, botId]
        );
        if (result.rows.length === 0) {
            return { status: "error", message: `I couldn't find a bot named *${escapeMarkdown(botId)}* registered under your account.` };
        }
        // Format data for better display if needed
        const botData = result.rows[0];
        botData.status = botData.status === 'online' ? 'Online' : 'Logged Out';
        botData.expiration_date = botData.expiration_date ? new Date(botData.expiration_date).toLocaleDateString() : 'Not Set';
        botData.deploy_date = botData.deploy_date ? new Date(botData.deploy_date).toLocaleDateString() : 'Unknown';

        return { status: "success", data: botData };
    } catch (dbError) {
        console.error(`[GetInfo DB Error] Bot ${botId}:`, dbError);
        return { status: "error", message: "A database error occurred while fetching bot info." };
    }
}


 
async function deleteBot(userId, botId) {
    console.log(`[ACTION] User ${userId} requested deletion for bot ${botId}.`);
    try {
        // 1. Attempt to delete from Heroku
        await herokuApi.delete(`/apps/${botId}`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
        console.log(`[Delete] Successfully deleted ${botId} from Heroku.`);
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log(`[Delete] Bot ${botId} was already deleted from Heroku.`);
        } else {
            // If it's not a 404, report the error but still proceed with DB cleanup
            const errorMsg = error.response?.data?.message || error.message;
            console.error(`[Delete Error] Bot ${botId} (Heroku):`, errorMsg);
            // Optionally notify admin or user about the Heroku API failure
        }
    }
    // 2. Always clean up database records
    try {
        await dbServices.deleteUserBot(userId, botId); // Removes from user_bots
        await dbServices.markDeploymentDeletedFromHeroku(userId, botId); // Marks in user_deployments
        console.log(`[Delete] Cleaned up database records for ${botId}.`);
        return { status: "success", message: `Bot *${escapeMarkdown(botId)}* has been permanently deleted.` };
    } catch (dbError) {
        console.error(`[Delete DB Error] Bot ${botId}:`, dbError);
        return { status: "error", message: `Failed to clean up database records for *${escapeMarkdown(botId)}*. Please contact admin.` };
    }
}

/**
 * Restarts a specific bot by deleting its dynos on Heroku.
 */
async function restartBot(userId, botId) {
    console.log(`[ACTION] User ${userId} requested restart for bot ${botId}.`);
    try {
        await herokuApi.delete(`/apps/${botId}/dynos`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
        return { status: "success", message: `Bot *${escapeMarkdown(botId)}* is restarting now.` };
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[Restart Error] Bot ${botId}:`, errorMsg);
        return { status: "error", message: `Failed to restart *${escapeMarkdown(botId)}*: ${escapeMarkdown(errorMsg)}` };
    }
}

/**
 * Fetches the most recent logs for a specific bot from Heroku.
 */
async function getBotLogs(userId, botId) {
    console.log(`[ACTION] User ${userId} requested logs for bot ${botId}.`);
    try {
        // 1. Create a log session on Heroku
        const sessRes = await herokuApi.post(`/apps/${botId}/log-sessions`,
            { lines: 150, tail: false }, // Get last 150 lines
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );
        const logplexUrl = sessRes.data.logplex_url;

        // 2. Fetch logs from the temporary URL (using standard axios is fine here)
        const logRes = await axios.get(logplexUrl);
        const logs = logRes.data.trim().slice(-4000); // Limit to Telegram's message size

        return { status: "success", logs: logs || 'No recent logs found.' };
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[GetLogs Error] Bot ${botId}:`, errorMsg);
        return { status: "error", message: `Failed to get logs for *${escapeMarkdown(botId)}*: ${escapeMarkdown(errorMsg)}` };
    }
}


// Note: updateUserVariable also needs the botId to know which bot's variable to change.
// In bot.js, find and replace this entire function
async function updateUserVariable(userId, botId, variableName, newValue) {
    const finalVarName = variableName.toLowerCase().replace(/ /g, '_').toUpperCase();

    if (!allowedVariables.includes(finalVarName)) {
        return { status: "error", message: `The variable '${variableName}' cannot be changed.` };
    }
    
    try {
        await herokuApi.patch(
            `/apps/${botId}/config-vars`,
            { [finalVarName]: newValue },
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );
        console.log(`[Heroku API] Successfully updated "${finalVarName}" for bot '${botId}'.`);
        // ❗️ FIX: Return a simple status object, not a pre-formatted message.
        return { status: "success" };
    } catch (error) {
        const errorMessage = error.response?.data?.message || 'An unknown API error occurred.';
        console.error(`[Heroku API] Error updating var for bot '${botId}':`, errorMessage);
        // ❗️ FIX: Return the error message separately.
        return { status: "error", message: errorMessage };
    }
}



const tools = [
    {
        "functionDeclarations": [
            // NEW TOOL: To get the list of bots first.
            {
                "name": "getUserBots",
                "description": "Retrieves a list of all bots owned by a specific user. Call this first if the user has multiple bots and their command is ambiguous.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": { "userId": { "type": "STRING", "description": "The user's unique ID." }},
                    "required": ["userId"]
                }
            },
            // UPDATED TOOL: Now requires a botId.
            {
                "name": "updateUserVariable",
                "description": "Updates a specific variable for a specific user's bot.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        "userId": { "type": "STRING", "description": "The user's unique ID." },
                        "botId": { "type": "STRING", "description": "The unique ID of the bot to be updated." },
                        "variableName": { "type": "STRING", "description": "The name of the variable to change." },
                        "newValue": { "type": "STRING", "description": "The new value for the variable." }
                    },
                    "required": ["userId", "botId", "variableName", "newValue"]
                }
            },
            // All other tools are also updated to require a botId.
            {
                "name": "redeployBot",
                "description": "Initiates the redeployment process for a specific user's bot.",
                "parameters": { "type": "OBJECT", "properties": { "userId": { "type": "STRING" }, "botId": { "type": "STRING" } }, "required": ["userId", "botId"] }
            },
            {
                "name": "getBotInfo",
                "description": "Retrieves information and status about a specific user's bot.",
                "parameters": { "type": "OBJECT", "properties": { "userId": { "type": "STRING" }, "botId": { "type": "STRING" } }, "required": ["userId", "botId"] }
            },
            {
                "name": "deleteBot",
                "description": "Deletes a specific user's bot and all associated data.",
                "parameters": { "type": "OBJECT", "properties": { "userId": { "type": "STRING" }, "botId": { "type": "STRING" } }, "required": ["userId", "botId"] }
            },
            {
                "name": "restartBot",
                "description": "Restarts a specific user's bot process.",
                "parameters": { "type": "OBJECT", "properties": { "userId": { "type": "STRING" }, "botId": { "type": "STRING" } }, "required": ["userId", "botId"] }
            },
            {
                "name": "getBotLogs",
                "description": "Fetches the most recent logs for a specific user's bot.",
                "parameters": { "type": "OBJECT", "properties": { "userId": { "type": "STRING" }, "botId": { "type": "STRING" } }, "required": ["userId", "botId"] }
            }
        ]
    }
];



// Assume 'genAI' and 'geminiModel' are already initialized with the tools above.

// Map the function name to the actual JavaScript function.
const availableTools = {
    updateUserVariable,
    redeployBot,
    getBotInfo,
    deleteBot,
    getUserBots,
    restartBot,
    getBotLogs
};


async function logUserActivity(userId, chatId, userName, timestamp) {
  const userIdStr = String(userId);
  const chatIdStr = String(chatId);

  const query = `
    INSERT INTO user_activity (user_id, chat_id, user_name, last_seen_timestamp)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, chat_id)
    DO UPDATE SET last_seen_timestamp = $4, user_name = $3
  `;
  
  try {
    await pool.query(query, [userIdStr, chatIdStr, userName, timestamp]);
  } catch (error) {
    console.error(`Failed to log user activity:`, error);
  }
}

/**
 * Gets the count of active and inactive users for a chat.
 * @param {string|number} chatId - The Telegram chat ID.
 * @param {number} inactiveTimestamp - The UNIX timestamp (in seconds) cutoff.
 * @returns {Promise<{activeCount: number, inactiveCount: number}>}
 */
async function getChatStats(chatId, inactiveTimestamp) {
  const chatIdStr = String(chatId);
  try {
    const activeQuery = 'SELECT COUNT(user_id) FROM user_activity WHERE chat_id = $1 AND last_seen_timestamp >= $2';
    const inactiveQuery = 'SELECT COUNT(user_id) FROM user_activity WHERE chat_id = $1 AND last_seen_timestamp < $2';

    const activeRes = await pool.query(activeQuery, [chatIdStr, inactiveTimestamp]);
    const inactiveRes = await pool.query(inactiveQuery, [chatIdStr, inactiveTimestamp]);
    
    return {
      activeCount: parseInt(activeRes.rows[0].count) || 0,
      inactiveCount: parseInt(inactiveRes.rows[0].count) || 0
    };
  } catch (error) {
    console.error(`Failed to get chat stats:`, error);
    return { activeCount: 0, inactiveCount: 0 };
  }
}

/**
 * Gets a list of users who are inactive.
 * @param {string|number} chatId - The Telegram chat ID.
 *m @param {number} inactiveTimestamp - The UNIX timestamp (in seconds) cutoff.
 * @returns {Promise<Array<{user_id: string, user_name: string}>>}
 */
async function getInactiveUsers(chatId, inactiveTimestamp) {
  const chatIdStr = String(chatId);
  try {
    const query = 'SELECT user_id, user_name FROM user_activity WHERE chat_id = $1 AND last_seen_timestamp < $2';
    const res = await pool.query(query, [chatIdStr, inactiveTimestamp]);
    return res.rows;
  } catch (error) {
    console.error(`Failed to get inactive users:`, error);
    return [];
  }
}


// This function can now handle more complex requests.
async function handleUserPrompt(prompt, userId) {
    const chat = geminiModel.startChat();
    const result = await chat.sendMessage(prompt);
    const calls = result.response.functionCalls(); // Use functionCalls() to handle multiple actions

    if (!calls || calls.length === 0) {
        return result.response.text();
    }
    
    // The AI might ask to call multiple functions in one turn
    const functionResponses = [];
    for (const call of calls) {
        if (availableTools[call.name]) {
            console.log(`[AI] Recommending call to: ${call.name} with args:`, call.args);
            const functionToCall = availableTools[call.name];
            
            // Add the userId from your bot's context
            const args = { ...call.args, userId: userId };
            
            // Call your actual function
            const functionResult = await functionToCall(args.userId, args.variableName, args.newValue);
            
            functionResponses.push({
                functionResponse: {
                    name: call.name,
                    response: functionResult,
                },
            });
        }
    }
    
    // Send all function results back to the AI
    const result2 = await chat.sendMessage(functionResponses);
    return result2.response.text();
}


/**
 * A list of database columns that the AI is permitted to update.
 * This is a critical security measure.
 */
const allowedVariables = [
    'SESSION_ID',
    'AUTO_READ_STATUS',
    'ALWAYS_ONLINE',
    'HANDLERS',
    'ANTI_DELETE',
    'SUDO' 
];

/**
 * AUTONOMOUS GEMINI BRAIN - Enhanced to handle requests without user intervention
 * - Aware of all bot core logic (deployment, verification, payments, etc.)
 * - Can execute actions autonomously (restart bots, handle errors, etc.)
 * - Does NOT reveal sensitive info (platform names, secrets, API keys)
 */


async function handleFallbackWithGemini(chatId, userMessage) {
    bot.sendChatAction(chatId, 'typing');

    try {
        // 1. Gather Context (Knowledge Injection)
        const [botsRes, deploymentsRes] = await Promise.all([
            pool.query("SELECT bot_name, bot_type, status FROM user_bots WHERE user_id = $1", [chatId]),
            pool.query("SELECT app_name, expiration_date FROM user_deployments WHERE user_id = $1", [chatId])
        ]);

        const userBots = botsRes.rows;
        const botCtx = userBots.length > 0 
            ? userBots.map(b => `${b.bot_name} (${b.bot_type}: ${b.status})`).join(', ') 
            : 'None';
            
        const deployCtx = deploymentsRes.rows.length > 0
            ? deploymentsRes.rows.map(d => `${d.app_name} expires ${d.expiration_date}`).join(', ')
            : 'None';

        // 2. Call Groq with Context
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: `CONTEXT: Bots: [${botCtx}], Expiry: [${deployCtx}]. MESSAGE: "${userMessage}"` }
            ],
            model: "llama-3.3-70b-versatile",
            response_format: { type: "json_object" } 
        });

        let aiResponse;
        const rawContent = completion.choices[0].message.content;

        // 3. SAFETY: Parse JSON
        try {
            const cleanText = rawContent.replace(/```json|```/g, "").trim();
            aiResponse = JSON.parse(cleanText);
        } catch (e) {
            console.error('[JSON Parse Error] Groq sent non-JSON:', rawContent);
            return bot.sendMessage(chatId, rawContent); 
        }

        console.log(`[AI Brain] Intent: ${aiResponse.intent} | Action: ${aiResponse.action}`);

        // 4. ACTION ROUTER: Handle "EXECUTE" intent (Restart, etc.)
        if (aiResponse.action === 'EXECUTE') {
            const targetBot = aiResponse.actionData?.botName;
            
            if (aiResponse.intent === 'RESTART_BOT' && targetBot) {
                const ownsBot = userBots.some(b => b.bot_name === targetBot);
                if (!ownsBot) return bot.sendMessage(chatId, "You don't appear to own a bot with that name.");

                await herokuApi.delete(`/apps/${targetBot}/dynos`, { 
                    headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } 
                });
                return bot.sendMessage(chatId, `Restart command sent for **${targetBot}**.`, { parse_mode: 'Markdown' });
            }
            
            // If there's an EXECUTE action but no specific handler above, run your general executeGeminiAction
            return executeGeminiAction(chatId, aiResponse);
        }

        // 5. LINK ROUTER: Handle "GET_LINK" intent
        if (aiResponse.intent === 'GET_LINK' && (!aiResponse.actionData || !aiResponse.actionData.botType)) {
            return bot.sendMessage(chatId, "Which link do you need? I have links for Levanter, Raganork, and Hermit.", {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Levanter', callback_data: 'select_get_session_type:levanter' }, 
                            { text: 'Raganork', callback_data: 'select_get_session_type:raganork' }
                        ],
                        [
                            { text: 'Hermit', callback_data: 'select_get_session_type:hermit' }
                        ]
                    ]
                }
            });
        }

        // 6. FINAL RESPONSE: Only runs if NO other action was triggered
        const finalMessage = aiResponse.response || "I'm not sure how to help with that, contact support @staries1.";
        return bot.sendMessage(chatId, finalMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('[Brain Error]', error);
        return bot.sendMessage(chatId, "⚠️ I encountered an error. Please try again or use the menu.");
    }
}



async function recoverReminders() {
    const now = new Date();
    try {
        const pending = await pool.query("SELECT * FROM reminders");
        for (const row of pending.rows) {
            const timeDiff = new Date(row.remind_at) - now;
            if (timeDiff <= 0) {
                // Timer expired while bot was off - Send now and delete
                await sendReminder(row.target_number, row.user_id, row.hours_duration);
            } else {
                // Resume countdown for future timers
                setTimeout(() => sendReminder(row.target_number, row.user_id, row.hours_duration), timeDiff);
            }
        }
    } catch (e) {
        console.error("Error recovering reminders:", e);
    }
}



async function sendReminder(targetNumber, userId, hours) {
    try {
        await bot.sendMessage(userId, `*REMINDER:* The timer for \`${targetNumber}\` (${hours}h) is UP!`, { parse_mode: 'Markdown' });
        
        // Delete from DB immediately after sending so /aalist stays clean
        await pool.query("DELETE FROM reminders WHERE target_number = $1 AND user_id = $2", [targetNumber, userId]);
        console.log(`[Timer] Reminder sent and deleted for ${targetNumber}`);
    } catch (e) {
        console.error("Error sending/deleting reminder:", e);
    }
}



/**
 * DYNAMIC GEMINI BRAIN UPDATE
 * Refreshes Gemini's knowledge base with latest bot state, user data, and system status
 */
async function updateGeminiBrain(userId) {
    try {
        // 1. Fetch user data using correct column 'last_seen'
        const activityRes = await pool.query(
            'SELECT last_seen FROM user_activity WHERE user_id = $1',
            [userId]
        );
        
        // 2. Fetch user bots
        const botsRes = await pool.query(
            'SELECT bot_name, status, created_at FROM user_bots WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        
        // 3. Fetch deployment details
        const deployRes = await pool.query(
            'SELECT app_name, is_free_trial, expiration_date, deploy_date FROM user_deployments WHERE user_id = $1 ORDER BY deploy_date DESC LIMIT 5',
            [userId]
        );
        
        const now = new Date();
        
        // 4. Build real-time context
        const brainUpdate = {
            timestamp: now.toISOString(),
            user: {
                id: userId,
                lastSeen: activityRes.rows[0]?.last_seen || 'Never'
            },
            bots: botsRes.rows.map(b => {
                const createdDate = b.created_at ? new Date(b.created_at) : now;
                return {
                    name: b.bot_name,
                    status: b.status || 'unknown',
                    ageDays: Math.floor((now - createdDate) / (1000 * 60 * 60 * 24))
                };
            }),
            deployments: deployRes.rows.map(d => {
                const expDate = d.expiration_date ? new Date(d.expiration_date) : null;
                const daysLeft = expDate ? Math.ceil((expDate - now) / (1000 * 60 * 60 * 24)) : 'N/A';
                
                return {
                    name: d.app_name,
                    isTrial: d.is_free_trial || false,
                    status: (expDate && expDate < now) ? 'expired' : `${daysLeft} days left`
                };
            }),
            systemStatus: {
                maintenanceMode: typeof isMaintenanceMode !== 'undefined' ? isMaintenanceMode : false,
                currentTime: now.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }),
                activeTrials: deployRes.rows.filter(d => d.is_free_trial && new Date(d.expiration_date) > now).length
            }
        };
        
        console.log(`[Gemini Brain] Context synced for user ${userId}`);
        return brainUpdate;

    } catch (err) {
        console.error('[Gemini Brain Update Error]:', err.message);
        return null;
    }
}


/**
 * AUTONOMOUS ACTION EXECUTOR
 * Executes actions on behalf of users without requiring confirmation
 */
async function executeGeminiAction(chatId, aiResponse) {
    const action = aiResponse.intent;
    const data = aiResponse.actionData || {};
    
    try {
        switch (action) {
            case 'RESTART_BOT':
                const botNameRestart = data.botName || extractBotNameFromMessage(aiResponse.response);
                if (botNameRestart) {
                    const restartMsg = await bot.sendMessage(chatId, `Restarting bot: *${botNameRestart}*...`, { parse_mode: 'Markdown' });
                    await restartBotProcess(botNameRestart, chatId);
                    await bot.editMessageText(`Bot *${botNameRestart}* restarted successfully! ✓`, {
                        chat_id: chatId,
                        message_id: restartMsg.message_id,
                        parse_mode: 'Markdown'
                    });
                } else {
                    await bot.sendMessage(chatId, 'Please specify which bot to restart.');
                }
                break;

            case 'CHECK_STATUS':
                const botNameStatus = data.botName || extractBotNameFromMessage(aiResponse.response);
                if (botNameStatus) {
                    const status = await getBotStatusAuto(botNameStatus, chatId);
                    await bot.sendMessage(chatId, `**Bot:** ${botNameStatus}\n**Status:** ${status.status}\n**Last Active:** ${status.lastActive}`, { parse_mode: 'Markdown' });
                } else {
                    await dbServices.sendAppList(chatId);
                }
                break;

            case 'UPDATE_VARIABLE':
                const botNameVar = data.botName || extractBotNameFromMessage(aiResponse.response);
                const varName = (data.variable || extractVariableFromMessage(aiResponse.response))?.toUpperCase();
                const varValue = data.value || extractValueFromMessage(aiResponse.response);
                
                // 🛡️ SECURITY: Whitelist check for column names
                const allowedVars = ['SESSION_ID', 'AUTO_READ_STATUS', 'ALWAYS_ONLINE', 'HANDLERS', 'ANTI_DELETE', 'SUDO'];
                
                if (botNameVar && varName && varValue) {
                    if (!allowedVars.includes(varName)) {
                        return bot.sendMessage(chatId, `Error: Variable \`${varName}\` is not allowed to be updated.`);
                    }

                    const updateMsg = await bot.sendMessage(chatId, `Updating \`${varName}\` for **${botNameVar}**...`, { parse_mode: 'Markdown' });

                    // ✅ FIXED SQL: Injecting whitelisted column name directly
                    await pool.query(
                        `UPDATE user_bots SET "${varName}" = $1 WHERE user_id = $2 AND bot_name = $3`,
                        [varValue, chatId, botNameVar]
                    );

                    await bot.editMessageText(`Successfully updated \`${varName}\`!`, {
                        chat_id: chatId, message_id: updateMsg.message_id, parse_mode: 'Markdown'
                    });
                } else {
                    await bot.sendMessage(chatId, 'I need the bot name, variable name, and the new value to proceed.');
                }
                break;

            case 'FREE_TRIAL':
                const trialMsg = await bot.sendMessage(chatId, 'Checking free trial eligibility...');
                const eligibility = await checkFreeTrialEligibility(chatId);
                
                if (eligibility.eligible) {
                    await bot.editMessageText(`You are eligible!\n\n${aiResponse.response}`, {
                        chat_id: chatId,
                        message_id: trialMsg.message_id,
                        reply_markup: { inline_keyboard: [[{ text: 'Claim Free Trial', callback_data: 'free_trial_start' }]] }
                    });
                } else {
                    await bot.editMessageText(`Not eligible: ${eligibility.reason}`, {
                        chat_id: chatId, message_id: trialMsg.message_id, parse_mode: 'Markdown'
                    });
                }
                break;

            default:
                await bot.sendMessage(chatId, aiResponse.response);
        }
    } catch (err) {
        console.error('[Action Error]', err);
        await bot.sendMessage(chatId, `Sorry, I couldn't complete that action: ${err.message}`);
    }
}

function extractBotNameFromMessage(message) {
    // Matches text inside ** or `` (Markdown style)
    const match = message.match(/[*`]{1,2}([a-z0-9\-_]+)[*`]{1,2}/i);
    return match ? match[1] : null;
}



async function restartBotProcess(botName, userId) {
    // Execute restart via deployment system
    try {
        await pool.query(
            'UPDATE user_bots SET last_restarted = NOW() WHERE bot_name = $1 AND user_id = $2',
            [botName, userId]
        );
        console.log(`[Autonomous] Restarted bot: ${botName} for user: ${userId}`);
    } catch (err) {
        console.error('[Autonomous Restart Error]', err);
    }
}

async function getBotStatusAuto(botName, userId) {
    try {
        const res = await pool.query(
            'SELECT status, last_checked FROM user_bots WHERE bot_name = $1 AND user_id = $2',
            [botName, userId]
        );
        if (res.rows.length > 0) {
            return {
                status: res.rows[0].status || 'Unknown',
                lastActive: res.rows[0].last_checked ? new Date(res.rows[0].last_checked).toLocaleString() : 'Never'
            };
        }
    } catch (err) {
        console.error('[Bot Status Error]', err);
    }
    return { status: 'Unknown', lastActive: 'N/A' };
}

async function checkFreeTrialEligibility(userId) {
    try {
        // Check if already used free trial
        const result = await pool.query(
            'SELECT COUNT(*) as count FROM user_deployments WHERE user_id = $1 AND is_free_trial = TRUE',
            [userId]
        );
        if (result.rows[0].count > 0) {
            return { eligible: false, reason: 'You have already used the free trial' };
        }
        return { eligible: true, reason: 'You are eligible!' };
    } catch (err) {
        console.error('[Trial Check Error]', err);
        return { eligible: false, reason: 'Error checking eligibility' };
    }
}

/**
 * Old fallback handler - kept for backwards compatibility
 */
async function handleFallbackWithGeminiOld(chatId, userMessage) {
    // All logic migrated to new autonomous handler above
    await bot.sendMessage(chatId, "I'm not sure what you mean. Please use the main menu buttons.");
}


// --- CHILD PROCESS UTILITIES ---

/**
 * Executes yt-dlp to extract high-quality media information.
 * @param {string} url The URL of the video/image post (e.g., TikTok, Instagram).
 * @returns {Promise<{type: string, url: string, caption: string, message?: string}>} Media details or error.
 */
async function extractMediaInfo(url) {
    // Command to run:
    // 1. -j: Output raw JSON
    // 2. --flat-playlist: Needed for some platforms
    // 3. --no-warnings: Cleans up the console output
    const command = `yt-dlp -j --flat-playlist --no-warnings "${url}"`;
    
    try {
        const { stdout, stderr } = await execPromise(command, { timeout: 30000 }); // 30 second timeout

        if (stderr && !stderr.includes('Warning')) {
            console.error("yt-dlp error output:", stderr);
            return { type: 'error', message: `yt-dlp error: ${stderr.substring(0, 100)}` };
        }
        
        const info = JSON.parse(stdout);
        
        // --- Logic to find the best download URL ---
        let downloadUrl = info.url || info.webpage_url;
        let mediaType = 'video';
        
        // Find the best quality URL within the 'formats' array for video/audio
        if (info.formats && Array.isArray(info.formats)) {
            // Filter for video streams and pick one that is not just audio
            const bestFormat = info.formats
                .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
                .sort((a, b) => (b.height || 0) - (a.height || 0))[0]; // Sort by highest resolution
            
            if (bestFormat && bestFormat.url) {
                downloadUrl = bestFormat.url;
            }
        }
        
        // TikTok sometimes involves images or carousels; check for that
        if (info.is_gallery) {
             mediaType = 'image_gallery';
             // For simplicity, we just return the URL of the first media item in a gallery
             downloadUrl = info.entries?.[0]?.url || info.entries?.[0]?.formats?.[0]?.url;
        } else if (info.ext === 'jpg' || info.ext === 'png' || info.ext === 'webp') {
             mediaType = 'image';
        }
        
        // Final sanity check
        if (!downloadUrl) {
            return { type: 'error', message: "No playable media link could be extracted." };
        }

        return { 
            type: mediaType, 
            url: downloadUrl,
            caption: info.title || info.description || 'Downloaded Media'
        };

    } catch (error) {
        let errorMessage = "Timed out or execution failed.";
        if (error.code === 'ENOENT') {
            errorMessage = "yt-dlp is not installed on the server. Contact Admin.";
        } else if (error.message.includes('404')) {
            errorMessage = "Video not found or is private.";
        } else if (error.message.includes('ERROR:')) {
            errorMessage = error.message.split('ERROR:')[1].trim().substring(0, 100);
        }
        console.error("yt-dlp Execution failed:", error.message);
        return { type: 'error', message: errorMessage };
    }
}



// 5) Initialize bot & in-memory state
// <<< IMPORTANT: Set polling to false here. It will be started manually later.
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

let botId; // <-- ADD THIS LINE

// Get the bot's own ID at startup
bot.getMe().then(me => {
    if (me && me.id) {
        botId = me.id.toString();
        // FIX: The bot's username is already in the 'me' object.
        // You should use me.username, not a hardcoded, undefined variable.
        botUsername = me.username; 
        console.log(`Bot initialized. ID: ${botId}, Username: ${me.username}`);
    }
}).catch(err => {
    console.error("CRITICAL: Could not get bot's own ID. Exiting.", err);
    process.exit(1);
});


const userStates = {}; // chatId -> { step, data, message_id, faqPage, faqMessageId }
const authorizedUsers = new Set(); // chatIds who've passed a key

// Map to store Promises for app deployment status based on channel notifications
const appDeploymentPromises = new Map(); // appName -> { resolve, reject, animateIntervalId }

const forwardingContext = {}; // Stores context for admin replies

// These are correctly declared once here:
const userLastSeenNotification = new Map(); // userId -> last timestamp notified
const adminOnlineMessageIds = new Map(); // userId -> adminMessageId (for editing)
const ONLINE_NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes


const USERS_PER_PAGE = 8; // Define how many users to show per page
// Helper function to display the paginated list of users with names
async function sendUserListPage(chatId, page = 1, messageId = null) {
    try {
        const allUsersResult = await pool.query('SELECT DISTINCT user_id FROM user_activity ORDER BY user_id;');
        const allUserIds = allUsersResult.rows.map(row => row.user_id);

        if (allUserIds.length === 0) {
            return bot.sendMessage(chatId, "No users have interacted with the bot yet.");
        }

        const USERS_PER_PAGE = 8;
        const totalPages = Math.ceil(allUserIds.length / USERS_PER_PAGE);
        page = Math.max(1, Math.min(page, totalPages));

        const offset = (page - 1) * USERS_PER_PAGE;
        const userIdsOnPage = allUserIds.slice(offset, offset + USERS_PER_PAGE);

        let responseMessage = `*Registered Users - Page ${page}/${totalPages}*\n\n`;
        for (const userId of userIdsOnPage) {
            try {
                const user = await bot.getChat(userId);
                const isBanned = await dbServices.isUserBanned(userId);
                const fullName = escapeMarkdown(`${user.first_name || ''} ${user.last_name || ''}`.trim());
                responseMessage += `*ID:* \`${userId}\` ${isBanned ? '(Banned)' : ''}\n*Name:* ${fullName || 'N/A'}\n\n`;
            } catch (e) {
                responseMessage += `*ID:* \`${userId}\`\n*Name:* _User not accessible_\n\n`;
            }
        }
        responseMessage += `_Use /info <ID> for full details._`;

        const navRow = [];
        if (page > 1) navRow.push({ text: 'Previous', callback_data: `users_page:${page - 1}` });
        if (page < totalPages) navRow.push({ text: 'Next', callback_data: `users_page:${page + 1}` });

        const options = {
            chat_id: chatId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [navRow] }
        };

        if (messageId) {
            await bot.editMessageText(responseMessage, { ...options, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, responseMessage, options);
        }
    } catch (error) {
        console.error(`Error sending user list page:`, error);
        await bot.sendMessage(chatId, "An error occurred while fetching the user list.");
    }
}

// 6) Utilities (some are passed to other modules)


/**
 * Escapes text for Telegram's 'HTML' parse_mode.
 * This prevents Telegram from misinterpreting <, >, and & as HTML code.
 * @param {string | any} text The text to escape.
 */
function escapeHTML(text) {
  if (typeof text !== 'string') {
    text = String(text);
  }
  
  // Replace the 3 special HTML characters
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;');
}


// Function to escape Markdown V2 special characters
/**
 * CRITICAL FIX: Replaces the chained .replace() calls with a single, robust regex 
 * to prevent unwanted backslashes from appearing in non-special characters (like letters).
 * Telegram's official Markdown V2 requires escaping these 16 characters plus the backslash itself:
 * _, *, [, ], (, ), ~, `, >, #, +, -, =, |, {, }, ., !, \
 */
function escapeMarkdown(text) {
    if (typeof text !== 'string') {
        text = String(text);
    }
    // Escape all Markdown V2 special characters in one robust pass.
    // The single regex handles all necessary escaping correctly.
    // The `\\` at the end ensures the backslash character itself is escaped.
    return text.replace(/([_*[\]()~`>#+=\-|{}!.!\\\\])/g, '\\$1');
}


// A reusable function to format a concise countdown string for button lists.
function formatTimeLeft(expirationDateStr) {
    if (!expirationDateStr) {
        return '';
    }

    const expirationDate = new Date(expirationDateStr);
    const now = new Date();
    const timeLeftMs = expirationDate.getTime() - now.getTime();

    // --- GRACE PERIOD LOGIC ---
    if (timeLeftMs <= 0) {
        const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;
        const graceLeftMs = GRACE_PERIOD_MS + timeLeftMs; // timeLeftMs is negative
        
        if (graceLeftMs <= 0) {
            return ' (Deleting...)';
        }

        const hoursLeft = Math.floor(graceLeftMs / (1000 * 60 * 60));
        const minsLeft = Math.floor((graceLeftMs % (1000 * 60 * 60)) / (1000 * 60));

        if (hoursLeft > 0) {
            return ` (Suspended - ${hoursLeft}h left)`;
        } else {
            return ` (Suspended - ${minsLeft}m left)`;
        }
    }

    // --- NORMAL COUNTDOWN LOGIC ---
    const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));

    let timeLeftStr = '';
    if (days > 0) {
        timeLeftStr += `${days}d `;
    }
    if (hours > 0) {
        timeLeftStr += `${hours}h `;
    }
    // Only show minutes if it's less than a day away from expiring for brevity
    if (days === 0 && minutes > 0) {
        timeLeftStr += `${minutes}m`;
    }

    return ` (${timeLeftStr.trim()} left)`;
}


// --- Automated Daily Tasks Scheduler ---
function startScheduledTasks() {
    console.log('🕒 Initializing scheduled tasks...');

    // This is the fake message object we'll use to trigger the commands.
    // It pretends to be a message from you (the ADMIN).
    const adminMsg = {
        chat: { id: ADMIN_ID },
        from: { id: ADMIN_ID }
    };

  // --- START SCHEDULED JOBS ---

// Schedule prune job to run every 7 days (every Sunday at 12:00 AM)
// '0 0 * * 0' = (minute 0) (hour 0) (any day of month) (any month) (day of week 0 = Sunday)
cron.schedule('0 0 * * 0', () => {
    console.log('--- Running weekly logged-out bot prune job ---');
    botServices.pruneLoggedOutBots().catch(err => {
        console.error('[Scheduler] Weekly prune job failed:', err);
    });
}, {
    scheduled: true,
    timezone: "Africa/Lagos" // ❗️ IMPORTANT: Set this to your server's/local timezone
});

console.log('Weekly prune job for logged-out bots is scheduled.');


cron.schedule('0 0 * * *', async () => {
    console.log('[Scheduler] Cron job triggered: Running backupall task');
    const startMsg = await bot.sendMessage(ADMIN_ID, "Starting scheduled daily full system backup...");
    await runBackupAllTask(ADMIN_ID, startMsg.message_id); // Call the new direct function
}, {
    scheduled: true,
    timezone: "Africa/Lagos"
});


    
    
    // --- ADD THE NEW DAILY CRON JOB ---
    // Schedule check to run every day at 12:00 PM (noon, WAT)
    cron.schedule('0 0 * * *', async () => {
        console.log('[Scheduler] Cron job triggered: Running daily FX rate update.');
        await updateDollarRate();
    }, {
        scheduled: true,
        timezone: "Africa/Lagos"
    });

    console.log(`[Scheduler] Daily USD/NGN rate update scheduled for 12:00 AM.`);
    // ... rest of your scheduled tasks ...
}


    // Schedule 2: Run copydb logic every day at 3:00 AM (or your desired time)
    cron.schedule('0 3 * * *', async () => {
        console.log('[Scheduler] Cron job triggered: Running copydb task');
        await bot.sendMessage(ADMIN_ID, "Starting scheduled daily main database copy...");
        await runCopyDbTask(); // Call the new direct function
    }, {
        scheduled: true,
        timezone: "Africa/Lagos"
    });

// Add this in your global scope or startup block
setInterval(async () => {
    try {
        await pool.query("DELETE FROM bot_news WHERE expires_at <= NOW()");
    } catch (e) {
        console.error("[News Cleanup] Error:", e.message);
    }
}, 15 * 60 * 1000); // Check every 15 minutes



// A reusable function to format a more precise countdown for the single bot menu.
function formatPreciseCountdown(expirationDateStr) {
    if (!expirationDateStr) {
        return "Not Set";
    }

    const expirationDate = new Date(expirationDateStr);
    const now = new Date();
    const timeLeftMs = expirationDate.getTime() - now.getTime();

    if (timeLeftMs <= 0) {
        return "Expired";
    }

    const days = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((timeLeftMs % (1000 * 60)) / 1000);

    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}


// In bot_services.js

const COUNTRY_DATA = {
    // === AFRICA ===
    'nigeria': { code: '234', len: 10, starts: ['70', '80', '81', '90', '91'] },
    'south africa': { code: '27', len: 9, starts: ['6', '7', '8'] },
    'ghana': { code: '233', len: 9, starts: ['2', '5'] },
    'kenya': { code: '254', len: 9, starts: ['7', '1'] },
    'egypt': { code: '20', len: 10, starts: ['10', '11', '12'] },

    // === AMERICAS ===
    'usa': { code: '1', len: 10, starts: ['201', '310', '212', '415', '718', '305', '323', '213'] },
    'brazil': { code: '55', len: 11, starts: ['119', '219', '118'] },
    'mexico': { code: '52', len: 10, starts: ['55', '56', '81'] },
    'el salvador': { code: '503', len: 8, starts: ['6', '7'] }, // Bitcoin Legal Tender
    'panama': { code: '507', len: 8, starts: ['6', '8'] }, // Crypto Friendly
    'canada': { code: '1', len: 10, starts: ['416', '647', '437', '604', '778'] },
    'argentina': { code: '54', len: 10, starts: ['911', '926'] }, // High Crypto Adoption

    // === EUROPE ===
    'uk': { code: '44', len: 10, starts: ['71', '72', '73', '74', '75', '77', '78', '79'] },
    'germany': { code: '49', len: 10, starts: ['15', '16', '17'] },
    'russia': { code: '7', len: 10, starts: ['9'] },
    'poland': { code: '48', len: 9, starts: ['45', '50', '51', '53', '57', '60', '66', '69', '72', '73', '78', '79', '88'] }, // Requested
    'portugal': { code: '351', len: 9, starts: ['91', '92', '93', '96'] }, // Crypto Tax Haven
    'switzerland': { code: '41', len: 9, starts: ['75', '76', '77', '78', '79'] }, // Crypto Valley
    'malta': { code: '356', len: 8, starts: ['79', '99', '77'] }, // Blockchain Island
    'estonia': { code: '372', len: 8, starts: ['5', '8'] }, // Digital Nation
    'belarus': { code: '375', len: 9, starts: ['25', '29', '33', '44'] },
    'netherlands': { code: '31', len: 9, starts: ['6'] },
    'france': { code: '33', len: 9, starts: ['6', '7'] },
    'spain': { code: '34', len: 9, starts: ['6', '7'] },

    // === ASIA & MIDDLE EAST ===
    'india': { code: '91', len: 10, starts: ['6', '7', '8', '9'] },
    'pakistan': { code: '92', len: 10, starts: ['3'] },
    'indonesia': { code: '62', len: 11, starts: ['8'] },
    'kuwait': { code: '965', len: 8, starts: ['6', '5', '9'] },
    'saudi arabia': { code: '966', len: 9, starts: ['5'] },
    'uae': { code: '971', len: 9, starts: ['50', '52', '54', '55', '56', '58'] }, // Dubai Crypto Hub
    'singapore': { code: '65', len: 8, starts: ['8', '9'] }, // Crypto Hub
    'japan': { code: '81', len: 10, starts: ['70', '80', '90'] },
    'south korea': { code: '82', len: 10, starts: ['10'] },
    'vietnam': { code: '84', len: 9, starts: ['3', '5', '7', '8', '9'] }, // High Adoption
    'philippines': { code: '63', len: 10, starts: ['9'] }, // High Adoption
    'turkey': { code: '90', len: 10, starts: ['50', '53', '54', '55'] }, // High Volume
    'thailand': { code: '66', len: 9, starts: ['6', '8', '9'] }
};



// In bot_services.js (REPLACE the generateCountryVcf function)

/**
 * Generates a VCF buffer with 100 UNIQUE random numbers for a specific country.
 * Uses the separate VCF database to ensure numbers are never repeated across files.
 */
// In bot_services.js (REPLACE the generateCountryVcf function)

async function generateCountryVcf(countryInput) {
    // 1. Validate Country
    const countryKey = countryInput.toLowerCase().trim();
    const data = COUNTRY_DATA[countryKey];

    if (!data) {
        return { success: false, message: "Country not supported. Try: Nigeria, USA, UK, India, Russia, Pakistan, etc." };
    }

    // 2. Prepare Name Formatting (Date & Time)
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', timeZone: 'Africa/Lagos' });
    const timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Lagos' });
    const dateTimeSuffix = `${dateStr} ${timeStr}`;
    
    const countryName = countryKey.charAt(0).toUpperCase() + countryKey.slice(1); 

    // 3. Ensure the tracking table exists
    try {
        await vcfPool.query(`
            CREATE TABLE IF NOT EXISTS generated_vcf_numbers (
                phone_number TEXT PRIMARY KEY,
                country TEXT,
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } catch (e) {
        console.error("[VCF Gen] Failed to init tracking table:", e.message);
    }

    const uniqueNumbers = [];
    let attempts = 0;

    // 4. Generation Loop (Find 500 unique numbers)
    while (uniqueNumbers.length < 500 && attempts < 3000) {
        attempts++;
        
        const prefix = data.starts[Math.floor(Math.random() * data.starts.length)];
        const remainingLength = data.len - prefix.length;
        
        let randomDigits = '';
        for (let d = 0; d < remainingLength; d++) {
            randomDigits += Math.floor(Math.random() * 10);
        }
        const fullNumber = `+${data.code}${prefix}${randomDigits}`;

        // Check Database for Uniqueness
        try {
            const result = await vcfPool.query(
                `INSERT INTO generated_vcf_numbers (phone_number, country) 
                 VALUES ($1, $2) 
                 ON CONFLICT (phone_number) DO NOTHING 
                 RETURNING phone_number`,
                [fullNumber, countryName]
            );

            if (result.rows.length > 0) {
                uniqueNumbers.push(fullNumber);
            }
        } catch (e) {
            console.error("[VCF Gen] DB Check Error:", e.message);
        }
    }

    if (uniqueNumbers.length === 0) {
        return { success: false, message: "Failed to generate numbers. Database connection might be down." };
    }

    // 5. Build VCF File Content
    let vcfContent = '';

    // --- 💡 ADD ADMIN NUMBER FIRST 💡 ---
    const adminNumber = '+2349163916314';
    const adminName = 'Ultar Admin WBD'; // The name people will see

    vcfContent += 'BEGIN:VCARD\r\n';
    vcfContent += 'VERSION:3.0\r\n';
    vcfContent += `FN:${adminName}\r\n`;
    vcfContent += `TEL;TYPE=CELL:${adminNumber}\r\n`;
    vcfContent += 'END:VCARD\r\n';
    // --- 💡 END ADMIN NUMBER 💡 ---
    
    // Add the random numbers
    uniqueNumbers.forEach((num, index) => {
        const contactName = `${countryName}${index + 1} ${dateTimeSuffix}`;

        vcfContent += 'BEGIN:VCARD\r\n';
        vcfContent += 'VERSION:3.0\r\n';
        vcfContent += `FN:${contactName}\r\n`;
        vcfContent += `TEL;TYPE=CELL:${num}\r\n`;
        vcfContent += 'END:VCARD\r\n';
    });

    const buffer = Buffer.from(vcfContent, 'utf8');
    const safeFileName = `${countryName}_${dateStr.replace(/\//g, '-')}_${timeStr.replace(/:/g, '')}.vcf`;

    return { success: true, buffer: buffer, fileName: safeFileName };
}



// ... (storeNewVcfContact and generateAndSendVcf should also be updated to use vcfPool) ...



/**
 * Fetches a user's verified email from the database.
 * @param {string} userId The user's Telegram ID.
 * @returns {Promise<string|null>} The user's email or null if not found.
 */
async function getUserEmail(userId) {
    try {
        const result = await pool.query(
            'SELECT email FROM email_verification WHERE user_id = $1 AND is_verified = TRUE',
            [userId]
        );
        if (result.rows.length > 0) {
            return result.rows[0].email;
        }
        return null;
    } catch (error) {
        console.error(`[DB] Error fetching email for user ${userId}:`, error);
        return null;
    }
}


// AROUND LINE 490 (inside bot.js)

let emojiIndex = 0;
const animatedEmojis = ['🕛', '🕒', '🕡', '🕘', '🕛', '🕒']; // Full-color circle emojis for animation
// --- END REPLACE ---

function getAnimatedEmoji() {
    const emoji = animatedEmojis[emojiIndex];
    emojiIndex = (emojiIndex + 1) % animatedEmojis.length;
    return emoji;
}

// In bot.js (REPLACE the entire createNeonDatabase function)
// In bot_services.js

/**
 * Creates a database on your private AWS Self-Hosted Platform.
 */
async function createSelfHostedDatabase(dbName) {
    const apiUrl = process.env.SELF_HOSTED_DB_URL;
    const apiKey = process.env.SELF_HOSTED_DB_SECRET;

    if (!apiUrl || !apiKey) {
        console.error("[Self-Hosted] Missing URL or Secret in .env");
        return { success: false, error: "Configuration missing." };
    }

    try {
        console.log(`[Self-Hosted] Requesting new DB '${dbName}' from AWS server...`);
        
        const response = await axios.post(`${apiUrl}/create`, {
            dbName: dbName
        }, {
            headers: { 'x-api-key': apiKey }
        });

        const data = response.data;

        if (data.success) {
            console.log(`[Self-Hosted] Success! DB Created: ${data.db_name}`);
            return {
                success: true,
                db_name: data.db_name,
                connection_string: data.connection_string,
                provider_type: 'AWS_SELF_HOSTED',
                provider_account_id: 'AWS_MAIN' 
            };
        } else {
            return { success: false, error: "Unknown error from API" };
        }

    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.error(`[Self-Hosted] API Request Failed:`, errorMsg);
        return { success: false, error: errorMsg };
    }
}
// In bot_services.js

/**
 * Deletes a database on your private AWS Self-Hosted Platform.
 */
// In bot_services.js (REPLACE the existing function)

async function deleteSelfHostedDatabase(dbName) {
    const apiUrl = process.env.SELF_HOSTED_DB_URL;
    const apiKey = process.env.SELF_HOSTED_DB_SECRET;

    if (!apiUrl || !apiKey) {
        console.warn("[Self-Hosted] Config missing. Skipping deletion.");
        return { success: false, error: "Configuration missing." };
    }

    try {
        console.log(`[Self-Hosted] Requesting DELETION of DB '${dbName}' from AWS server...`);
        
        const response = await axios.post(`${apiUrl}/delete`, {
            dbName: dbName
        }, {
            headers: { 'x-api-key': apiKey },
            validateStatus: (status) => status >= 200 && status < 500 // Accept 4xx errors to read body
        });

        const data = response.data;
        
        // --- 💡 CRITICAL FIX: CHECK RESPONSE BODY 💡 ---
        if (response.status === 200 && data.success) {
            console.log(`[Self-Hosted] Success! DB Deleted: ${dbName}`);
            return { success: true };
        } 
        
        // Handle API returning 200 OK but with an error message in the body
        if (data.error) {
            console.error(`[Self-Hosted] API Delete Request Failed (Body Error):`, data.error);
            return { success: false, error: data.error };
        }
        // --- 💡 END CRITICAL FIX 💡 ---

        // Handle case where status is 4xx or 5xx (will be caught below if validateStatus is tight)
        return { success: false, error: "Unknown error from API response body." };

    } catch (error) {
        // Handle 404 (Not Found) gracefully during API call
        if (error.response && error.response.status === 404) {
             console.log(`[Self-Hosted] DB '${dbName}' not found (404). Assuming already deleted.`);
             return { success: true };
        }

        // Handle error responses from the API (e.g., 500 server error)
        const errorMsg = error.response?.data?.error || error.message;
        console.error(`[Self-Hosted] API Delete Request Failed:`, errorMsg);
        return { success: false, error: errorMsg };
    }
}



/**
 * Universal provisioning router.
 * Priority: AWS Self-Hosted -> Neon Round-Robin.
 */
async function createNeonDatabase(newDbName) {
    
    // --- 🚀 STRATEGY 1: AWS SELF-HOSTED (UNLIMITED) ---
    // Check if the self-hosted platform is configured
    if (process.env.SELF_HOSTED_DB_URL && process.env.SELF_HOSTED_DB_SECRET) {
        console.log(`[Router] Attempting deployment on Self-Hosted AWS Platform...`);
        
        // Call the AWS helper function
        // (Make sure createSelfHostedDatabase is defined in this file or imported!)
        const awsResult = await createSelfHostedDatabase(newDbName);
        
        if (awsResult.success) {
            console.log(`[Router] AWS Deployment Successful! DB: ${awsResult.db_name}`);
            return awsResult; // Return immediately, skipping Neon entirely
        } else {
            console.warn(`[Router] AWS Creation Failed: ${awsResult.error}. Falling back to Neon Round-Robin...`);
        }
    }
    // --------------------------------------------------


    // --- 🔄 STRATEGY 2: NEON ROUND-ROBIN (FALLBACK) ---
    
    if (typeof NEON_ACCOUNTS === 'undefined' || NEON_ACCOUNTS.length === 0) {
        const errorMsg = "CRITICAL: NEON_ACCOUNTS array is not defined or is empty.";
        console.error(`[Router] ${errorMsg}`);
        return { success: false, provider_type: 'FAILURE', provider_account_id: '0', error: errorMsg };
    }
    
    const totalAccounts = NEON_ACCOUNTS.length;
    let lastUsedIndex = -1;

    // 1. Fetch the last used index from the database (Persist memory)
    try {
        const result = await pool.query("SELECT setting_value FROM app_settings WHERE setting_key = 'last_neon_index'");
        if (result.rows.length > 0) {
            lastUsedIndex = parseInt(result.rows[0].setting_value, 10);
        }
    } catch (e) {
        console.warn("[Router] Could not fetch last_neon_index from DB, defaulting to -1. (First run?)");
    }

    // Calculate start index: (Last + 1) wrapped around total
    const startIndex = (lastUsedIndex + 1) % totalAccounts;

    console.log(`[Router] Last used Index was ${lastUsedIndex}. Starting round-robin search at Index ${startIndex} (Account ID ${NEON_ACCOUNTS[startIndex].id})...`);

    // Loop exactly 'totalAccounts' times to check every account once
    for (let i = 0; i < totalAccounts; i++) {
        // Calculate the actual index for this iteration
        const currentIndex = (startIndex + i) % totalAccounts;
        const accountConfig = NEON_ACCOUNTS[currentIndex];
        const accountId = String(accountConfig.id);
        // Use the limit from config, defaulting to 2 if missing
        const limit = accountConfig.active_db_limit || 2; 

        // --- Step 1: Check Database Count Limit ---
        const dbCountResult = await getNeonDbCount(accountId); 
        
        if (!dbCountResult.success) {
            console.warn(`[Router] Account ${accountId} (Index ${currentIndex}) check failed: ${dbCountResult.error}. Skipping.`);
            continue;
        } else if (dbCountResult.count >= limit) {
            // Account is full, skip to next
            // console.log(`[Router] Account ${accountId} is full. Skipping.`);
            continue;
        }

        // --- Step 2: Attempt Creation (Capacity Found!) ---
        console.log(`[Router] Account ${accountId} has capacity (${dbCountResult.count}/${limit}). Attempting creation...`);
        const createResult = await attemptCreateOnAccount(newDbName, accountId);
        
        if (createResult.success) {
            // SUCCESS! 
            console.log(`[Router] Deployment successful on Account ${accountId}.`);
            
            // 3. Save this index to the database so we start from the NEXT one next time
            try {
                await pool.query(
                    `INSERT INTO app_settings (setting_key, setting_value) 
                     VALUES ('last_neon_index', $1) 
                     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1`,
                    [currentIndex.toString()]
                );
                console.log(`[Router] Saved Index ${currentIndex} to database as last used.`);
            } catch (saveError) {
                console.error("[Router] Failed to save last_neon_index to DB:", saveError.message);
            }
            
            return {
                success: true,
                db_name: createResult.db_name,
                connection_string: createResult.connection_string,
                provider_type: 'NEON',
                provider_account_id: accountId
            };
        }
        
        console.warn(`[Router] Account ${accountId} creation failed: ${createResult.error}. Continuing search.`);
    }

    // --- Final Failure ---
    const errorMsg = "Database provisioning failed: AWS failed and all Neon accounts are full.";
    console.error(`[Router] CRITICAL FAILURE: ${errorMsg}`);
    return { success: false, provider_type: 'FAILURE', provider_account_id: '0', error: errorMsg };
}

 
/**
 * Fetches all known bot names from the primary tracking tables.
 * @param {object} pool - The main PostgreSQL pool.
 * @returns {Promise<Set<string>>} A Set of canonical database names (underscored).
 */
async function getKnownAppNames(pool) {
    // We check both tables for maximum coverage
    const botNamesResult = await pool.query('SELECT DISTINCT bot_name FROM user_bots');
    const deploymentNamesResult = await pool.query('SELECT DISTINCT app_name FROM user_deployments');

    const knownApps = new Set();
    
    // Add all names, converting them to the canonical database name format (underscores)
    botNamesResult.rows.forEach(row => knownApps.add(row.bot_name.replace(/-/g, '_')));
    deploymentNamesResult.rows.forEach(row => knownApps.add(row.app_name.replace(/-/g, '_')));
    
    // Add the default system DB name as well, just in case
    knownApps.add('neondb');

    return knownApps;
}




async function attemptCreateOnAccount(dbName, accountId) {
    // --- Step 1: Retrieve Credentials from the array ---
    const account = NEON_ACCOUNTS.find(acc => String(acc.id) === String(accountId));

    if (!account || !account.api_key || !account.project_id || !account.branch_id) {
        const errorMsg = `Neon Account ${accountId} config missing critical data in the NEON_ACCOUNTS array.`;
        console.error(`[Neon Create Attempt ${accountId}] ${errorMsg}`);
        return { success: false, error: errorMsg };
    }

    // --- Step 2: Build Request Payload and API URL ---
    const apiUrl = `https://console.neon.tech/api/v2/projects/${account.project_id}/branches/${account.branch_id}/databases`;
    const headers = {
        'Authorization': `Bearer ${account.api_key}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
    const payload = {
        database: {
            name: dbName.replace(/-/g, '_'), // Sanitize name for Neon
            owner_name: account.db_user // Use the user stored in the array config
        }
    };

    try {
        // --- Step 3: Execute API Call ---
        const response = await axios.post(apiUrl, payload, { headers });
        const createdDbName = response.data.database.name;

        // --- Step 4: Construct Connection String ---
        // Construct the connection string using the correct account's details from the array
        const newConnectionString = `postgresql://${account.db_user}:${account.db_password}@${account.db_host}/${createdDbName}?sslmode=require`;

        console.log(`[Neon Create Attempt ${accountId}] Successfully created database: ${createdDbName}`);
        return {
            success: true,
            db_name: createdDbName,
            connection_string: newConnectionString,
            account_id: accountId // **Return the account ID used**
        };
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[Neon Create Attempt ${accountId}] Error creating database: ${errorMsg}`);
        return { success: false, error: `Account ${accountId}: ${errorMsg}` };
    }
}

// In bot.js, alongside other scheduled/utility functions (e.g., near runCopyDbTask)

/**
 * Runs the core logic to scan all Neon accounts for databases that exist 
 * but are not referenced in the local database (orphans) and deletes them.
 */
async function runOrphanDbCleanup(adminId) {
    console.log('[Scheduler] Starting Orphan DB Cleanup...');

    let dbCounter = 0;
    let deletionPromises = [];
    let knownApps;
    
    // Use the admin's ID for logging critical results
    const LOG_TARGET = adminId || ADMIN_ID; 

    try {
        // Step 1: Get all apps we manage from local DB
        knownApps = await getKnownAppNames(pool);
        console.log(`[Orphan Cleanup] Found ${knownApps.size - 1} known apps. Scanning Neon accounts...`);

        // Step 2: Loop through all Neon accounts and find orphans
        for (const accountConfig of NEON_ACCOUNTS) {
            const accountId = String(accountConfig.id);
            const dbsUrl = `https://console.neon.tech/api/v2/projects/${accountConfig.project_id}/branches/${accountConfig.branch_id}/databases`;
            const headers = { 'Authorization': `Bearer ${accountConfig.api_key}`, 'Accept': 'application/json' };

            try {
                const dbsResponse = await axios.get(dbsUrl, { headers });
                const dbList = dbsResponse.data.databases;
                
                dbList.forEach(db => {
                    const dbName = db.name.replace(/-/g, '_'); // Sanitize name for comparison
                    
                    if (!knownApps.has(dbName) && dbName !== 'neondb') {
                        // Found an orphan!
                        dbCounter++;
                        deletionPromises.push({
                            promise: deleteNeonDatabase(dbName, accountId), // Use the specific account ID
                            dbName: dbName,
                            accountId: accountId
                        });
                        // Do not log every finding, only critical errors or final results
                    }
                });
            } catch (error) {
                // Log API failure for a single account
                console.error(`[Orphan Cleanup] Failed to scan Account ${accountId}. Error: ${error.message.substring(0, 50)}`);
            }
        }
        
        console.log(`[Orphan Cleanup] Scan complete. Found ${dbCounter} orphaned DBs. Starting deletion...`);

        if (dbCounter === 0) {
             console.log('[Orphan Cleanup] No orphans found. Job finished.');
             return;
        }

        // Step 3: Execute Deletion
        let successCount = 0;
        let failLog = [];
        
        for (const { promise, dbName, accountId } of deletionPromises) {
            const result = await promise;
            if (result.success) {
                successCount++;
            } else {
                failLog.push(`${dbName} (Acc ${accountId}): ${result.error || 'Unknown Error'}`);
            }
        }

        // Step 4: Final Report (send to admin via Telegram)
        let finalReport = `**Intelligent Orphan DB Cleanup Report**\n\n`;
        finalReport += `*Total Orphans Found:* ${dbCounter}\n`;
        finalReport += `*Successfully Deleted:* ${successCount}\n`;
        finalReport += `*Failed to Delete:* ${dbCounter - successCount}\n\n`;

        if (failLog.length > 0) {
            finalReport += `**Deletion Failures:**\n\`\`\`\n${failLog.join('\n')}\n\`\`\``;
        } else {
             finalReport += `All ${successCount} orphaned databases were successfully deleted.`;
        }
        
        await bot.sendMessage(LOG_TARGET, finalReport, { parse_mode: 'Markdown' });

    } catch (e) {
        console.error(`[Orphan Cleanup] CRITICAL FAILURE:`, e);
        await bot.sendMessage(LOG_TARGET, `**CRITICAL ERROR** during Orphan DB Cleanup: ${escapeMarkdown(e.message)}`, { parse_mode: 'Markdown' });
    }
}


// In bot_services.js (Add this helper function)

/**
 * Searches and attempts to delete a database by its name across AWS and all Neon accounts.
 * @returns {Promise<{success: boolean, location: string}>}
 */
async function deleteDatabaseGlobally(dbName) {
    let attemptedLocations = [];
    
    // 1. Try AWS Self-Hosted
    if (process.env.SELF_HOSTED_DB_URL && process.env.SELF_HOSTED_DB_SECRET) {
        const awsResult = await deleteSelfHostedDatabase(dbName);
        if (awsResult.success) return { success: true, location: 'AWS' };
        attemptedLocations.push('AWS');
    }

    // 2. Try All Neon Accounts
    for (const accountConfig of NEON_ACCOUNTS) {
        const accountId = String(accountConfig.id);
        attemptedLocations.push(`Neon-${accountId}`);

        if (checkCredentials(accountConfig)) {
            try {
                const apiUrl = `https://console.neon.tech/api/v2/projects/${accountConfig.project_id}/branches/${accountConfig.branch_id}/databases/${dbName}`;
                const headers = { 'Authorization': `Bearer ${accountConfig.api_key}`, 'Accept': 'application/json' };
                await axios.delete(apiUrl, { headers });
                return { success: true, location: `Neon Account ${accountId}` };
            } catch (error) {
                if (error.response?.status === 404) continue; // Not here, continue search
            }
        }
    }

    return { 
        success: false, 
        location: `Deletion failed across all ${attemptedLocations.length} sources.` 
    };
}


/**
 * Scans for logged-out bots and initiates AI-driven recovery conversations.
 */
async function checkAndNotifyLoggedOutBots() {
    console.log('[Monitor] Checking for logged-out bots...');
    try {
        // Find bots that are logged_out but haven't been notified today
        const result = await pool.query(`
            SELECT ub.user_id, ub.bot_name, v.email 
            FROM user_bots ub
            LEFT JOIN email_verification v ON ub.user_id = v.user_id
            WHERE ub.status = 'logged_out' 
            AND (ub.last_logout_alert_at IS NULL OR ub.last_logout_alert_at < NOW() - INTERVAL '24 hours')
        `);

        for (const row of result.rows) {
            const { user_id, bot_name } = row;

            // Update the alert timestamp immediately to prevent double-alerts
            await pool.query('UPDATE user_bots SET last_logout_alert_at = NOW() WHERE bot_name = $1', [bot_name]);

            // Create a specific state for the AI to handle this conversation
            userStates[user_id] = { 
                step: 'LOGOUT_RECOVERY_CHAT', 
                data: { botName: bot_name } 
            };

            // Proactive AI Message
            const message = `Hello! I noticed your bot **${bot_name}** has logged out. 
Is everything okay, or are you having trouble re-linking it? I'm here to help you get it back online!`;
            
            await bot.sendMessage(user_id, message, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('[Monitor Error]', e.message);
    }
}

// Run the check every 4 hours
setInterval(checkAndNotifyLoggedOutBots, 4 * 60 * 60 * 1000);


async function changeBotDatabase(appName) {
    console.log(`[ChangeDB] Starting database swap for ${appName}...`);
    
    // 0. Get current deployment details
    const deploymentInfo = await pool.query(`
        SELECT user_id, config_vars, neon_account_id
        FROM user_deployments 
        WHERE app_name = $1
    `, [appName]);
    
    if (deploymentInfo.rows.length === 0) {
        await bot.sendMessage(ADMIN_ID, `⚠️ CRITICAL: Migration failed for \`${appName}\`. Deployment record not found.`, { parse_mode: 'Markdown' });
        return { success: false, message: "Deployment record not found." };
    }

    const oldConfig = deploymentInfo.rows[0];
    const targetUserId = oldConfig.user_id; // Get owner ID (preserved)
    const oldDbUrl = oldConfig.config_vars?.DATABASE_URL;
    
    // --- 1. DELETE OLD DATABASE (FIRST STEP) ---
    // If this fails, we still proceed to Step 2 (Create New) to fix the bot,
    // but we track the failure for the final report.
    let deletionSuccess = true;
    let oldDbNameForDeletion;
    
    if (oldDbUrl) {
        const dbUrlMatch = oldDbUrl.match(/\/([\w-]+)\?/);
        oldDbNameForDeletion = dbUrlMatch ? dbUrlMatch[1] : null;

        if (oldDbNameForDeletion) {
            // Find and delete the old DB using the global search method (AWS -> Neon)
            const deleteResult = await deleteDatabaseGlobally(oldDbNameForDeletion);
            
            if (!deleteResult.success) {
                 deletionSuccess = false;
                 console.warn(`[ChangeDB] Failed to delete old DB ${oldDbNameForDeletion}. Result: ${deleteResult.location}`);
            }
        }
    }

    // --- 2. PROVISION NEW DATABASE (Clean Name) ---
    const newDbName = appName.replace(/-/g, '_'); 
    const creationResult = await createNeonDatabase(newDbName); 

    if (!creationResult.success) {
        const message = `❌ **MIGRATION FAILED for \`${appName}\`**\nReason: Database provisioning failed: ${creationResult.error}`;
        await bot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' });
        return { success: false, message: `Provisioning failed: ${creationResult.error}` };
    }

    const newDbUrl = creationResult.connection_string;
    const newAccountId = creationResult.provider_account_id;

    // --- 3. UPDATE LOCAL DATABASE RECORD (MUST SUCCEED FIRST) ---
    try {
        await pool.query(`
            UPDATE user_deployments 
            SET neon_account_id = $1,
                config_vars = jsonb_set(config_vars, '{DATABASE_URL}', to_jsonb($2::text), true)
            WHERE app_name = $3
        `, [newAccountId, newDbUrl, appName]);
        
    } catch (dbError) {
        // CRITICAL FAIL: Local records are now wrong. Clean up the new DB before exiting.
        console.error(`[ChangeDB] CRITICAL: Local DB record update failed for ${appName}:`, dbError);
        const message = `⚠️ MIGRATION CRITICAL FAIL for \`${appName}\` (Owner: ${targetUserId})\n\nLocal records failed to update. Deleting newly created DB: ${newDbName}.`;
        
        // Clean up the new database to prevent an orphan
        await deleteDatabaseGlobally(newDbName).catch(()=>{});

        await bot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' });
        return { success: false, message: "Local DB update failed." };
    }

    // --- 4. Update Heroku Config Var (Triggers Restart - NOW SAFE) ---
    try {
        await herokuApi.patch(`/apps/${appName}/config-vars`, 
            { DATABASE_URL: newDbUrl },
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );
    } catch (e) {
        const err = e.response?.data?.message || e.message;
        const message = `❌ **MIGRATION FAILED for \`${appName}\`**\nReason: Heroku update failed (Bot is down): ${err}`;
        await bot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' });
        return { success: false, message: `Heroku update failed: ${err}` };
    }
    
    // --- 5. Final Admin Success Notification ---
    const successMessage = `**MIGRATION SUCCESS** for \`${appName}\` (Owner: ${targetUserId})\n` +
                           `**New Location:** ${newAccountId}\n` +
                           `**Old DB Deleted?** ${deletionSuccess ? 'Yes' : 'No (Requires /deldb cleanup)'}`;
    
    await bot.sendMessage(ADMIN_ID, successMessage, { parse_mode: 'Markdown' });

    return { success: true, account: newAccountId };
}



/**
 * MASTER DELETION FUNCTION
 * Deletes a bot from Heroku, deletes its Neon DB, and cleans up all local DB records.
 * @param {string} userId The bot's owner ID.
 * @param {string} appName The bot's app name.
 */
async function deleteBotCompletely(userId, appName) {
    console.log(`[Delete] Starting complete deletion for bot: ${appName}`);
    
    // 1. Delete from Heroku (uses herokuApi for error handling)
    try {
        await herokuApi.delete(`/apps/${appName}`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
        console.log(`[Delete] Successfully deleted ${appName} from Heroku.`);
    } catch (error) {
        if (error.response && error.response.status === 404) {
            console.log(`[Delete] Bot ${appName} was already deleted from Heroku.`);
        } else {
            // Log other errors but continue cleanup
            console.error(`[Delete] Error deleting ${appName} from Heroku:`, error.response?.data?.message || error.message);
        }
    }

    // 2. Delete the associated Neon database
    try {
        await deleteNeonDatabase(appName);
        console.log(`[Delete] Successfully deleted Neon database for ${appName}.`);
    } catch (error) {
        console.error(`[Delete] Error deleting Neon database for ${appName}:`, error.message);
    }
    
    // 3. Clean up all local database records (in bot_services.js)
    try {
        await dbServices.permanentlyDeleteBotRecord(userId, appName);
        console.log(`[Delete] Successfully cleaned up all local DB records for ${appName}.`);
    } catch (error) {
        console.error(`[Delete] Error cleaning up local DB records for ${appName}:`, error.message);
    }
    
    console.log(`[Delete] Completed deletion process for ${appName}.`);
}


/**
 * Updates a specific environment variable on Render and explicitly triggers a restart.
 * @param {string} varName The name of the variable to update.
 * @param {string} varValue The new value for the variable.
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function updateRenderVar(varName, varValue) {
    const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
        return { success: false, message: "Render API Key or Service ID is not set." };
    }

    let finalValue = varValue;
    if (varName.includes('URL')) {
        finalValue = varValue.replace(/\/$/, ''); // Removes trailing slash
        if (finalValue !== varValue) {
            console.log(`[Sanitization] Automatically removed trailing slash from ${varName}.`);
        }
    }

    try {
        const headers = {
            'Authorization': `Bearer ${RENDER_API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        const envVarsUrl = `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`;

        // Step 1: Get current vars
        const { data: currentEnvVars } = await axios.get(envVarsUrl, { headers });
        const varIndex = currentEnvVars.findIndex(item => item.envVar.key === varName);

        if (varIndex > -1) {
            currentEnvVars[varIndex].envVar.value = finalValue;
        } else {
            currentEnvVars.push({ envVar: { key: varName, value: finalValue } });
        }
        
        // Step 2: Update the variables
        const payload = currentEnvVars.map(item => item.envVar);
        await axios.put(envVarsUrl, payload, { headers });
        
        // ❗️ FIX: Explicitly trigger the restart after the variable update succeeds.
        await triggerRenderRestart();
        
        return { success: true, message: `Successfully updated ${varName} on Render and triggered a restart.` };
    } catch (error) {
        const errorDetails = error.response?.data?.message || 'An unknown API error occurred.';
        console.error(`[Render API] Failed to update var ${varName}:`, errorDetails);
        return { success: false, message: errorDetails };
    }
}



let isRecoveryInProgress = false; // Global flag to prevent multiple recoveries at once


// NOTE: This assumes NEON_ACCOUNTS array, axios, and escapeMarkdown are available.

/**
 * Searches through all NEON_ACCOUNTS, finds the database by name, deletes it using the Neon API, and stops on success.
 * This version includes detailed console logging for debugging.
 * @param {string} dbName The name of the database to delete (e.g., 'atttesttt').
 * @returns {Promise<{success: boolean, accountId: string | null, error?: string, databaseGone?: boolean}>}
 */
async function findAndDeleteNeonDatabase(dbName) {
    // 1. Sanitize the database name: convert bot-side underscore (_) back to API-side dash (-)
    const dbNameForAPI = dbName.replace(/_/g, '-'); 
    
    console.log(`[Delete Debug] Starting search for DB: ${dbName} (API Name: ${dbNameForAPI})`);

    // Iterate through ALL configured Neon accounts
    for (const accountConfig of NEON_ACCOUNTS) {
        const accountId = String(accountConfig.id);
        const { project_id, branch_id, api_key } = accountConfig;
        
        // Construct the DELETE API URL
        const deleteUrl = `https://console.neon.tech/api/v2/projects/${project_id}/branches/${branch_id}/databases/${dbNameForAPI}`;
        const headers = { 'Authorization': `Bearer ${api_key}` };

        console.log(`[Delete Debug] Checking Account ${accountId}. URL: ${deleteUrl}`);

        try {
            // Attempt to delete the database from the current account
            const response = await axios.delete(deleteUrl, { headers });
            
            if (response.status === 200 || response.status === 204) {
                // SUCCESS!
                console.log(`[Delete Debug] SUCCESS! Deleted DB from Account ${accountId}. Status: ${response.status}`);
                return { success: true, accountId: accountId, databaseGone: false };
            }
            
        } catch (error) {
            const status = error.response?.status;
            const errorMessage = error.response?.data?.message || error.message;

            if (status === 404) {
                // Database not found on this account. Continue to the next one.
                console.log(`[Delete Debug] Account ${accountId} returned 404 (Not Found). Continuing search.`);
                continue; 
            }
            
            if (status === 403) {
                 // 403 Forbidden is often a bad API key or missing permissions
                console.error(`[Delete Debug] Account ${accountId} returned 403 (Forbidden). API Key likely invalid or missing delete permission.`);
            }

            // Report the critical error and stop
            return { 
                success: false, 
                accountId: accountId, 
                error: `API Error in Account ${accountId} (Status ${status || 'N/A'}): ${errorMessage.substring(0, 150)}` 
            };
        }
    }

    // If the loop finishes without finding or deleting the database:
    console.log(`[Delete Debug] Search complete. DB '${dbName}' not found in any account.`);
    return { 
        success: false, 
        accountId: null, 
        error: `Database '${dbName}' was not found in any of the ${NEON_ACCOUNTS.length} configured Neon accounts.` 
    };
}



/**
 * Handles the entire automated workflow when a Heroku API key is found to be invalid.
 * @param {string} failingKey The API key that just failed.
 */
// In bot.js (REPLACE the handleInvalidHerokuKeyWorkflow function)

async function handleInvalidHerokuKeyWorkflow(failingKey) {
    if (isRecoveryInProgress) {
        console.log('[Recovery] A recovery process is already in progress. Ignoring trigger.');
        return;
    }
    isRecoveryInProgress = true;
    console.log('[Recovery] Invalid Heroku API key detected! Starting automated recovery workflow.');

    try {
        // 1. Alert Admin and enable Maintenance Mode
        await bot.sendMessage(ADMIN_ID, "**CRITICAL: Heroku API Key Invalid!**\n\nStarting automated recovery process. The bot is now in maintenance mode.", { parse_mode: 'Markdown' });
        isMaintenanceMode = true;
        await saveMaintenanceStatus(true);

        // 2. Get a new, valid key from the database 
        const newKeyResult = await pool.query(
            "SELECT id, api_key FROM heroku_api_keys WHERE is_active = TRUE AND api_key != $1 ORDER BY added_at DESC LIMIT 1",
            [failingKey]
        );

        if (newKeyResult.rows.length === 0) {
            throw new Error("No alternative Heroku API keys found in the database. Manual intervention required.");
        }
        const newKey = newKeyResult.rows[0].api_key;
        const newKeyId = newKeyResult.rows[0].id;
        await bot.sendMessage(ADMIN_ID, `Found a new API key in the database. Masked: \`${newKey.substring(0, 4)}...${newKey.substring(newKey.length - 4)}\``, { parse_mode: 'Markdown' });
        
        // 3. Update the HEROKU_API_KEY on Render (This triggers the first restart)
        const updateResult = await updateRenderVar('HEROKU_API_KEY', newKey);
        if (!updateResult.success) {
            throw new Error(`Failed to update Render environment variable: ${updateResult.message}`);
        }
        await bot.sendMessage(ADMIN_ID, "Successfully updated the `HEROKU_API_KEY` on Render. A new deployment has been triggered to apply the new key.");

        // 4. Delete the used key from the database
        await pool.query("DELETE FROM heroku_api_keys WHERE id = $1", [newKeyId]);
        console.log('[Recovery] Deleted the newly used key from the database.');

        // 5. 💡 FIX: Schedule the Mass Restore in the database for 5 minutes from now 💡
        const delayMinutes = 5;
        const scheduledTime = new Date(Date.now() + delayMinutes * 60 * 1000);

        await pool.query(
            `INSERT INTO recovery_schedule (task_name, scheduled_at, status) 
             VALUES ($1, $2, $3)`,
            ['MASS_RESTORE', scheduledTime, 'PENDING']
        );
        
        // 6. Notify admin about the persistent wait
        await bot.sendMessage(ADMIN_ID, `The bot is restarting now with the new key. A **Mass Restore** is now scheduled to begin in **${delayMinutes} minutes** (${scheduledTime.toLocaleTimeString()}). This schedule is saved in the database and will survive the restart.`, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error('[Recovery] CRITICAL ERROR during recovery workflow:', error);
        await bot.sendMessage(ADMIN_ID, `**Automated Recovery Failed!**\n\n**Reason:** ${error.message}\n\nThe bot is stuck in maintenance mode. Please fix the issue manually.`);
    } finally {
        isRecoveryInProgress = false; // Reset flag on failure
    }
}


// Create a dedicated axios instance for Heroku API calls
const herokuApi = axios.create({
    baseURL: 'https://api.heroku.com',
    headers: {
        'Authorization': `Bearer ${process.env.HEROKU_API_KEY}`, // Add this line
        'Accept': 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }
});





/**
 * A reusable function to display the API key deletion menu.
 * @param {string} chatId The admin's chat ID.
 * @param {number|null} messageId The message to edit, if applicable.
 */
async function sendApiKeyDeletionList(chatId, messageId = null) {
    if (String(chatId) !== ADMIN_ID) return;

    try {
        const result = await pool.query("SELECT id, api_key, is_active FROM heroku_api_keys ORDER BY added_at DESC");
        const keys = result.rows;

        if (keys.length === 0) {
            const text = "No Heroku API keys are currently stored in the database.";
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, text);
        }

        const keyButtons = keys.map(k => {
            const statusIcon = k.is_active ? '🟢' : '🔴';
            const maskedKey = `${k.api_key.substring(0, 4)}...${k.api_key.substring(k.api_key.length - 4)}`;
            return [{
                text: `${statusIcon} ${maskedKey}`,
                callback_data: `delapi_select:${k.id}` // Use the unique ID for selection
            }];
        });

        const text = "Select a Heroku API key to delete:";
        const options = {
            chat_id: chatId,
            text: text,
            reply_markup: { inline_keyboard: keyButtons }
        };

        if (messageId) {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: options.reply_markup });
        } else {
            await bot.sendMessage(chatId, text, { reply_markup: options.reply_markup });
        }
    } catch (error) {
        console.error("Error sending API key deletion list:", error);
        await bot.sendMessage(chatId, "An error occurred while fetching the key list.");
    }
}


// In bot.js, REPLACE this entire function
async function runBackupAllTask(adminId, initialMessageId = null) {
    console.log('[Backup Task] Starting execution...');

    let progressMsg;
    if (initialMessageId) {
        progressMsg = { message_id: initialMessageId, chat: { id: adminId } };
    } else {
        progressMsg = await bot.sendMessage(adminId, 'Starting Bot Settings Backup...');
    }

    try {
        await bot.editMessageText('Collecting app list and backing up settings from Heroku...', { chat_id: adminId, message_id: progressMsg.message_id }).catch(()=>{});

        // Use the service function which centralizes Heroku API logic and DB writes
        const result = await dbServices.backupAllPaidBots();

        if (!result || !result.success) {
            const message = result && result.message ? result.message : 'Unknown error while performing backupAllPaidBots';
            console.error('[Backup Task] backupAllPaidBots reported failure:', message);
            await bot.editMessageText(`Backup failed: ${message}`, { chat_id: adminId, message_id: progressMsg.message_id }).catch(()=>{});
            await bot.sendMessage(adminId, `Backup failed: ${message}`);
            // Do not proceed to /copydb on failure
            return;
        }

        const stats = result.stats || {};
        const misc = result.miscStats || {};

        let summary = `Bot Settings Backup Complete!\n\nProcessed: ${misc.totalRelevantApps || 0}\nBacked up: ${misc.appsBackedUp || 0}\nFailed: ${misc.appsFailed || 0}\nNot found locally: ${misc.appsNotFoundLocally || 0}\n\nType Summary:\n`;
        for (const t of Object.keys(stats)) {
            const s = stats[t] || { backedUp: [], failed: [] };
            summary += `- ${t}: backed ${s.backedUp.length}, failed ${s.failed.length}\n`;
        }

        await bot.editMessageText(summary, { chat_id: adminId, message_id: progressMsg.message_id }).catch(()=>{});

        const backupSuccess = (misc.appsFailed || 0) === 0;

        // PHASE 2: copydb if the backup phase was successful
        if (backupSuccess) {
            await bot.sendMessage(adminId, 'Starting Phase 2: Automatically copying main database to backup database...');
            try {
                await runCopyDbTask();
                await bot.sendMessage(adminId, 'Full System Maintenance Complete!\n\nAll bot settings and the main database copy are finished.');
            } catch (copyError) {
                console.error('Error during automated /copydb task:', copyError);
                await bot.sendMessage(adminId, `Bot backup was successful, but the final /copydb task failed.\n\nReason: ${copyError.message}`);
            }
        } else {
            await bot.sendMessage(adminId, 'Main database copy was skipped because errors occurred during the bot backup phase.');
        }

    } catch (error) {
        console.error('[Backup Task] Critical error during /backupall:', error);
        await bot.editMessageText(`A critical error occurred during backup:\n\n${error.message}`, { chat_id: adminId, message_id: progressMsg.message_id }).catch(()=>{});
        await bot.sendMessage(adminId, `A critical error occurred during backup: ${error.message}`);
    }
}


async function handleRestoreAllConfirm(query) {
    const adminId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    
    let progressMsg;
    if (query.message && query.message.message_id) {
        progressMsg = await bot.editMessageText(`**Starting Full Restore: ${botType.toUpperCase()}**\n\nThis will recreate each bot using its saved settings.`, {
            chat_id: adminId, message_id: query.message.message_id, parse_mode: 'Markdown'
        }).catch(() => bot.sendMessage(adminId, "**Starting Full Restore...**", { parse_mode: 'Markdown' }));
    } else {
        progressMsg = await bot.sendMessage(adminId, "**Starting Full Restore...**", { parse_mode: 'Markdown' });
    }

    const deployments = await dbServices.getAllDeploymentsFromBackup(botType);
    let successCount = 0;
    let failureCount = 0;
    let progressLog = [`*Starting restore for ${deployments.length} ${botType} bots...*\n`];

    for (const [index, deployment] of deployments.entries()) {
        const originalAppName = deployment.app_name;
        const originalOwnerId = deployment.user_id;
        
        // --- THIS IS THE NEW LOGIC YOU WANTED ---
        // 1. Set the "in-progress" line for the current bot
        const currentTask = `**(${index + 1}/${deployments.length})** Restoring \`${originalAppName}\` for \`${originalOwnerId}\`... ⏳`;
        await bot.editMessageText(progressLog.join('\n') + "\n" + currentTask, { 
            chat_id: adminId, 
            message_id: progressMsg.message_id, 
            parse_mode: 'Markdown' 
        }).catch(()=>{}); // Ignore "message not modified"
        
        try {
            // --- Phase 1: Call the silent restore function (with fallback) ---
            let buildResult;
            if (dbServices.silentRestoreBuild && typeof dbServices.silentRestoreBuild === 'function') {
                buildResult = await dbServices.silentRestoreBuild(originalOwnerId, deployment.config_vars, botType);
            } else {
                // FALLBACK: If silentRestoreBuild doesn't exist, log warning and skip
                console.warn(`[RestoreAll] WARNING: dbServices.silentRestoreBuild is not defined. Skipping restore for ${originalAppName}`);
                throw new Error(`Function silentRestoreBuild not found in dbServices. This deployment cannot be restored.`);
            }
            
            if (!buildResult.success) {
                // Throw the specific error from the silent function
                throw new Error(buildResult.error || "App build process failed or timed out.");
            }

            // 2. Update the log with the "success" line
            const newAppName = buildResult.appName || originalAppName;
            progressLog.push(`**(${index + 1}/${deployments.length})** \`${newAppName}\`... ✅ *Success*`);
            successCount++;
            
            // --- ADD 1-MINUTE DELAY AFTER SUCCESS ---
            if (index < deployments.length - 1) { // Don't delay after last bot
                progressLog.push(`_Waiting 1 minute before next restore..._`);
                await bot.editMessageText(progressLog.join('\n'), { 
                    chat_id: adminId, 
                    message_id: progressMsg.message_id, 
                    parse_mode: 'Markdown' 
                }).catch(()=>{});
                await new Promise(resolve => setTimeout(resolve, 60000)); // 60 seconds
            }

        } catch (error) {
            failureCount++;
            const errorMsg = error.message; // Use the error message from the throw
            console.error(`[RestoreAll] CRITICAL ERROR while restoring ${originalAppName}:`, errorMsg);
            
            // 2. Update the log with the "failure" line
            progressLog.push(`**(${index + 1}/${deployments.length})** \`${originalAppName}\`... ❌ *Failed*: ${String(errorMsg).substring(0, 100)}...`);
        }
    }
    
    // --- Send final summary log ---
    await bot.editMessageText(
        `**Bot Restoration Complete!**\n\n*Success:* ${successCount}\n*Failed:* ${failureCount}\n\n--- Final Log ---\n${progressLog.join('\n')}`, 
        { chat_id: adminId, message_id: progressMsg.message_id, parse_mode: 'Markdown' }
    );

    // --- FLEXIBLE Phase 3 & 4: Run if there are ANY successes ---
    const hasOnlyMinorFailures = failureCount > 0 && successCount > 0;
    
    if (successCount > 0) {
        await bot.sendMessage(adminId, `**Starting Phase 3:** Deploying email service (${successCount} bots restored)...`);
        try {
            const { GMAIL_USER, GMAIL_APP_PASSWORD, SECRET_API_KEY, HEROKU_API_KEY } = process.env;
            if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !SECRET_API_KEY) throw new Error("Missing email credentials");
            const appName = `email-service-${crypto.randomBytes(4).toString('hex')}`;
            const createAppRes = await herokuApi.post('/apps', { name: appName }, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
            const appWebUrl = createAppRes.data.web_url;
            await herokuApi.patch(`/apps/${appName}/config-vars`, { GMAIL_USER, GMAIL_APP_PASSWORD, SECRET_API_KEY }, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
            await herokuApi.post(`/apps/${appName}/builds`, { source_blob: { url: "https://github.com/ultar1/Email-service-/tarball/main/" } }, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
            await updateRenderVar('EMAIL_SERVICE_URL', appWebUrl);
            await bot.sendMessage(adminId, `**Email Service Deployed!** (Phase 3 complete)`);
        } catch (error) {
            const errorMsg = error.response?.data?.message || error.message;
            await bot.sendMessage(adminId, `**Phase 3 Failed:** Email service deployment failed.\n*Reason:* ${escapeMarkdown(errorMsg)}\n\n${hasOnlyMinorFailures ? '_Note: Some bots were restored successfully._' : ''}`, { parse_mode: 'Markdown' });
        }
        
        await bot.sendMessage(adminId, `**Starting Phase 4:** Copying main database to backup (${successCount} bots syncing)...`);
        try {
            if (typeof runCopyDbTask === 'function') {
                await runCopyDbTask();
                await bot.sendMessage(adminId, `**Full System Recovery Complete!**\n\n✅ ${successCount} bots restored\n${failureCount > 0 ? `⚠️ ${failureCount} bots failed\n` : ''}Databases synchronized.`);
            } else {
                console.warn('[RestoreAll] runCopyDbTask function not found. Skipping database sync.');
                await bot.sendMessage(adminId, `**Restore Complete (Phase 4 Skipped)**\n\n✅ ${successCount} bots restored\n${failureCount > 0 ? `⚠️ ${failureCount} bots failed` : 'All restores successful!'}`);
            }
        } catch (copyError) {
            await bot.sendMessage(adminId, `**Phase 4 Failed:** Database sync failed.\n*Reason:* ${escapeMarkdown(copyError.message)}\n\n✅ ${successCount} bots were still restored successfully.`, { parse_mode: 'Markdown' });
        }
    } else {
        await bot.sendMessage(adminId, `**Recovery Cancelled:** No bots were successfully restored. Skipping Phase 3 & 4.`);
    }
}




// NEW: Handler for /restartall - Show confirmation and bots to restart
async function handleRestartAllSelection(query) {
    const chatId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    
    await bot.editMessageText(`Fetching list of ${botType} bots to restart...`, {
        chat_id: chatId,
        message_id: query.message.message_id
    });

    try {
        const bots = await pool.query(
            'SELECT bot_name, user_id FROM user_bots WHERE bot_type = $1 ORDER BY bot_name',
            [botType]
        );
        
        if (bots.rows.length === 0) {
            await bot.editMessageText(`No ${botType} bots found to restart.`, {
                chat_id: chatId,
                message_id: query.message.message_id
            });
            return;
        }

        let listMessage = `Found *${bots.rows.length}* ${botType} bot(s) ready to restart:\n\n`;
        bots.rows.forEach(bot => {
            listMessage += `• \`${bot.bot_name}\` (Owner: \`${bot.user_id}\`)\n`;
        });
        listMessage += `\nThis will trigger a restart/redeployment for each bot.\n\n*Do you want to proceed?*`;

        await bot.editMessageText(listMessage, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "Proceed", callback_data: `restart_all_confirm:${botType}` },
                        { text: "Cancel", callback_data: 'restart_all_cancel' }
                    ]
                ]
            }
        });
    } catch (error) {
        console.error(`[RestartAll] Error fetching bots:`, error);
        await bot.editMessageText(`Error: ${escapeMarkdown(error.message)}`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });
    }
}

// NEW: Handler for /restartall - Execute restart for all selected bot type
async function handleRestartAllConfirm(query) {
    const adminId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    
    let progressMsg = await bot.editMessageText(`**Starting Full Restart: ${botType.toUpperCase()}**\n\nThis will restart each bot using Heroku/Render.`, {
        chat_id: adminId, message_id: query.message.message_id, parse_mode: 'Markdown'
    }).catch(() => bot.sendMessage(adminId, "**Starting Full Restart...**", { parse_mode: 'Markdown' }));

    try {
        const bots = await pool.query(
            'SELECT bot_name, user_id FROM user_bots WHERE bot_type = $1 ORDER BY bot_name',
            [botType]
        );
        
        let successCount = 0;
        let failureCount = 0;
        let progressLog = [`*Starting restart for ${bots.rows.length} ${botType} bots...*\n`];

        for (const [index, botInfo] of bots.rows.entries()) {
            const appName = botInfo.bot_name;
            const ownerId = botInfo.user_id;
            
            // Update progress
            const currentTask = `**(${index + 1}/${bots.rows.length})** Restarting \`${appName}\`... ⏳`;
            await bot.editMessageText(progressLog.join('\n') + "\n" + currentTask, { 
                chat_id: adminId, 
                message_id: progressMsg.message_id, 
                parse_mode: 'Markdown' 
            }).catch(()=>{});
            
            try {
                // Try to restart using Heroku API
                const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
                if (!HEROKU_API_KEY) {
                    throw new Error("HEROKU_API_KEY not set in environment");
                }

                // Use axios directly with proper Heroku API headers
                // Heroku dyno restart requires DELETE request to /apps/{appName}/dynos/web
                await axios.delete(`https://api.heroku.com/apps/${appName}/dynos/web`, 
                    {
                        headers: {
                            'Authorization': `Bearer ${HEROKU_API_KEY}`,
                            'Accept': 'application/vnd.heroku+json; version=3',
                            'Content-Type': 'application/json'
                        }
                    }
                );
                
                progressLog.push(`**(${index + 1}/${bots.rows.length})** \`${appName}\`... ✅ *Restarted*`);
                successCount++;
                
                // 30-second delay between restarts to avoid rate limiting
                if (index < bots.rows.length - 1) {
                    progressLog.push(`_Waiting 30 seconds before next restart..._`);
                    await bot.editMessageText(progressLog.join('\n'), { 
                        chat_id: adminId, 
                        message_id: progressMsg.message_id, 
                        parse_mode: 'Markdown' 
                    }).catch(()=>{});
                    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds
                }

            } catch (error) {
                failureCount++;
                const errorMsg = error.message || error.response?.data?.message || 'Unknown error';
                console.error(`[RestartAll] Error restarting ${appName}:`, errorMsg);
                progressLog.push(`**(${index + 1}/${bots.rows.length})** \`${appName}\`... ❌ *Failed*: ${String(errorMsg).substring(0, 80)}...`);
            }
        }
        
        // Final summary
        await bot.editMessageText(
            `**Bot Restart Complete!**\n\n*Success:* ${successCount}\n*Failed:* ${failureCount}\n\n--- Final Log ---\n${progressLog.join('\n')}`, 
            { chat_id: adminId, message_id: progressMsg.message_id, parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error(`[RestartAll] CRITICAL ERROR:`, error);
        await bot.editMessageText(
            `**Restart Failed!**\n\n*Reason:* ${escapeMarkdown(error.message)}`,
            { chat_id: adminId, message_id: progressMsg.message_id, parse_mode: 'Markdown' }
        );
    }
}


async function sendUnregisteredUserList(chatId, page = 1, messageId = null) {
    try {
        const result = await pool.query(`
            SELECT user_id FROM user_activity 
            WHERE user_id NOT IN (SELECT DISTINCT user_id FROM user_bots)
            ORDER BY user_id
        `);
        const allUserIds = result.rows.map(row => row.user_id);

        if (allUserIds.length === 0) {
            return bot.editMessageText("No unregistered users found.", { chat_id: chatId, message_id: messageId });
        }

        const totalPages = Math.ceil(allUserIds.length / USERS_PER_PAGE);
        page = Math.max(1, Math.min(page, totalPages));
        const offset = (page - 1) * USERS_PER_PAGE;
        const userIdsOnPage = allUserIds.slice(offset, offset + USERS_PER_PAGE);

        let responseMessage = `*Unregistered Users - Page ${page}/${totalPages}*\n\n`;
        // ✅ FIX: Loop now fetches user names
        for (const userId of userIdsOnPage) {
            try {
                const user = await bot.getChat(userId);
                const fullName = escapeMarkdown(`${user.first_name || ''} ${user.last_name || ''}`.trim());
                responseMessage += `*Name:* ${fullName || 'N/A'}\n*ID:* \`${userId}\`\n\n`;
            } catch (e) {
                responseMessage += `*Name:* _User not accessible_\n*ID:* \`${userId}\`\n\n`;
            }
        }
        responseMessage += `_These users have started the bot but not deployed._`;

        const navRow = [];
        if (page > 1) navRow.push({ text: '« Prev', callback_data: `users_unregistered:${page - 1}` });
        if (page < totalPages) navRow.push({ text: 'Next »', callback_data: `users_unregistered:${page + 1}` });

        await bot.editMessageText(responseMessage, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [navRow] }
        });
    } catch (e) { console.error("Error sending unregistered user list:", e); }
}


// --- NEW FEATURE: 4K Image Upscaling ---
const Replicate = require('replicate');

// Initialize Replicate client if the API token exists
let replicate;
if (process.env.REPLICATE_API_TOKEN) {
    replicate = new Replicate({
        auth: process.env.REPLICATE_API_TOKEN,
    });
    console.log("🤖 Replicate AI for 4K upscaling initialized.");
} else {
    console.warn("⚠️ Replicate API token not found. /4k command will be disabled.");
}


// In bot.js

async function sendRegisteredUserList(chatId, page = 1, messageId = null) {
    try {
        const result = await pool.query('SELECT DISTINCT user_id FROM user_bots ORDER BY user_id');
        const allUserIds = result.rows.map(row => row.user_id);
        
        if (allUserIds.length === 0) {
            return bot.editMessageText("No registered users (with bots) found.", { chat_id: chatId, message_id: messageId });
        }
        
        const totalPages = Math.ceil(allUserIds.length / USERS_PER_PAGE);
        page = Math.max(1, Math.min(page, totalPages));
        const offset = (page - 1) * USERS_PER_PAGE;
        const userIdsOnPage = allUserIds.slice(offset, offset + USERS_PER_PAGE);

        let responseMessage = `*Registered Users - Page ${page}/${totalPages}*\n\n`;
        // ✅ FIX: Loop now fetches user names
        for (const userId of userIdsOnPage) {
            try {
                const user = await bot.getChat(userId);
                const fullName = escapeMarkdown(`${user.first_name || ''} ${user.last_name || ''}`.trim());
                responseMessage += `*Name:* ${fullName || 'N/A'}\n*ID:* \`${userId}\`\n\n`;
            } catch (e) {
                responseMessage += `*Name:* _User not accessible_\n*ID:* \`${userId}\`\n\n`;
            }
        }
        responseMessage += `_Use /info <ID> for full details._`;

        const navRow = [];
        if (page > 1) navRow.push({ text: '« Prev', callback_data: `users_registered:${page - 1}` });
        if (page < totalPages) navRow.push({ text: 'Next »', callback_data: `users_registered:${page + 1}` });

        await bot.editMessageText(responseMessage, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [navRow] }
        });
    } catch (e) { console.error("Error sending registered user list:", e); }
}



// REDUCED ANIMATION FREQUENCY
async function animateMessage(chatId, messageId, baseText) {
    const intervalId = setInterval(async () => {
        try {
            // --- REPLACE THIS LINE ---
            // await bot.editMessageText(`${getAnimatedEmoji()} ${baseText}`, {
            // --- WITH THIS ---
            await bot.editMessageText(`${baseText} ${getAnimatedEmoji()}`, {
            // --- END REPLACE ---
                chat_id: chatId,
                message_id: messageId
            }).catch(() => {});
        } catch (e) {
            console.error(`Error animating message ${messageId}:`, e.message);
            clearInterval(intervalId);
        }
    }, 2000);
    return intervalId;
}


async function sendPricingTiers(chatId, messageId) {
    // Check if user has existing bots to determine if they are a new user
    const userBotsResult = await pool.query('SELECT 1 FROM user_bots WHERE user_id = $1 LIMIT 1', [chatId]);
    const isExistingUser = userBotsResult.rows.length > 0;

    // 1. Get the rate from environment variables (Default to 1500 if not set)
    const rate = parseInt(process.env.DOLLAR_RATE || '1500', 10);

    // 2. Define Base Prices in USD
    const pricesUsd = {
        basic: 0.35,      // (~₦525)
        standard: 1.00,   // (₦1,500)
        quarterly: 2.00,  // (₦3,000)
        semi: 3.35,       // (~₦5,025)
        annual: 5.35      // (~₦8,025)
    };

    // 3. Calculate NGN prices dynamically for the callback data
    // These 'p' values are what get sent to the payment gateway
    const p = {
        basic: Math.ceil(pricesUsd.basic * rate),
        standard: Math.ceil(pricesUsd.standard * rate),
        quarterly: Math.ceil(pricesUsd.quarterly * rate),
        semi: Math.ceil(pricesUsd.semi * rate),
        annual: Math.ceil(pricesUsd.annual * rate)
    };

    // Message text showing the current exchange rate
    let pricingMessage = `Please select a plan to proceed with your payment (Rate: $1 = ₦${rate}):`; 
    const planButtons = []; 

    // --- BUTTONS CONFIGURATION ---
    
    // Basic Plan (Visible to New users ONLY)
    // callback_data format: action : amount_in_naira : duration_in_days
    if (!isExistingUser) {
        planButtons.push({ 
            text: `Basic: $${pricesUsd.basic} / 10 Days`, 
            callback_data: `select_plan:${p.basic}:10` 
        });
    }

    // Standard Plan
    planButtons.push({ 
        text: `Standard: $${pricesUsd.standard} / 45 Days`, 
        callback_data: `select_plan:${p.standard}:45` 
    });

    // Quarterly Plan
    planButtons.push({ 
        text: `Quarterly: $${pricesUsd.quarterly} / 3 Mos`, 
        callback_data: `select_plan:${p.quarterly}:92` 
    });

    // Semi-Annual Plan
    planButtons.push({ 
        text: `Semi-Annual: $${pricesUsd.semi} / 6 Mos`, 
        callback_data: `select_plan:${p.semi}:185` 
    });

    // Annual Plan
    planButtons.push({ 
        text: `Annual: $${pricesUsd.annual} / 1 Year`, 
        callback_data: `select_plan:${p.annual}:365` 
    });

    // --- Arrange buttons into rows of 2 ---
    // Ensure you have the 'chunkArray' helper function defined elsewhere in your bot.js
    const pricingKeyboardRows = chunkArray(planButtons, 2); 

    // Add the Cancel button at the bottom
    pricingKeyboardRows.push([{ text: '« Cancel', callback_data: 'cancel_payment_and_deploy' }]);

    const finalKeyboard = {
        inline_keyboard: pricingKeyboardRows
    };

    // Update the message with the buttons
    await bot.editMessageText(pricingMessage, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: finalKeyboard 
    });
}



// In bot.js (Add this function)

/**
 * Fetches the latest USD to NGN rate and updates the DOLLAR_RATE variable on Render.
 */
async function updateDollarRate() {
    console.log('[FX Rate] Starting daily USD/NGN rate check...');
    
    const fxApiKey = process.env.EXCHANGE_RATE_API_KEY;
    if (!fxApiKey) {
        console.error('[FX Rate] Aborted: EXCHANGE_RATE_API_KEY is missing.');
        return;
    }

    const apiUrl = `https://v6.exchangerate-api.com/v6/${fxApiKey}/latest/USD`;

    try {
        const response = await axios.get(apiUrl);
        const rate = response.data.conversion_rates.NGN;

        if (rate && rate > 100) { // Basic sanity check
            // Round up to the nearest whole Naira (e.g., 1452.34 -> 1453)
            const newRate = Math.ceil(rate);
            
            console.log(`[FX Rate] Fetched rate: 1 USD = ${rate.toFixed(2)} NGN. Setting Render variable to: ${newRate}`);

            // 1. Update the Render Environment Variable
            const updateResult = await updateRenderVar('DOLLAR_RATE', newRate.toString());

            if (updateResult.success) {
                await bot.sendMessage(ADMIN_ID, 
                    `**DOLLAR RATE UPDATED**\n\n` +
                    `New Rate: 1 USD = **₦${newRate}**\n` +
                    `Render variable \`DOLLAR_RATE\` updated successfully. Bot is restarting to apply changes.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                throw new Error(updateResult.message);
            }

        } else {
            throw new Error('API returned an invalid or missing NGN rate.');
        }

    } catch (error) {
        console.error('[FX Rate] CRITICAL FAILURE during rate update:', error.message);
        await bot.sendMessage(ADMIN_ID, 
            `**FATAL ERROR:** Failed to update dollar rate.\n\nReason: ${escapeMarkdown(error.message)}. Manual intervention required.`, 
            { parse_mode: 'Markdown' }
        );
    }
}





// --- FIX: Corrected sendLatestKeyboard function for reliable database updates ---
async function sendLatestKeyboard(chatId) {
    const isAdmin = String(chatId) === ADMIN_ID;
    const currentKeyboard = buildKeyboard(isAdmin);

    try {
        await bot.sendMessage(chatId, 'Keyboard updated to the latest version!', {
            reply_markup: { keyboard: currentKeyboard, resize_keyboard: true }
        });
        
        // This is the critical fix: we ensure the database update is properly handled.
        await pool.query('UPDATE user_activity SET keyboard_version = $1 WHERE user_id = $2', [KEYBOARD_VERSION, chatId]);
        console.log(`[Keyboard Update] User ${chatId} keyboard version updated to ${KEYBOARD_VERSION}.`);
    } catch (error) {
        console.error(`[Keyboard Update] CRITICAL ERROR: Failed to send latest keyboard or update database for user ${chatId}:`, error.message);
        // You may also want to notify the admin about this critical error
        bot.sendMessage(ADMIN_ID, `CRITICAL ERROR: Keyboard update failed for user ${chatId}. Check logs.`, { parse_mode: 'Markdown' });
    }
}

// Function to check for and release timed-out pending numbers
async function releaseTimedOutNumbers() {
    console.log('[Scheduler] Checking for timed-out pending payments...');
    const timeoutThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    try {
        const result = await pool.query(
            "UPDATE temp_numbers SET status = 'available', user_id = NULL, assigned_at = NULL WHERE status = 'pending_payment' AND assigned_at < $1 RETURNING number",
            [timeoutThreshold]
        );
        if (result.rowCount > 0) {
            console.log(`[Scheduler] Released ${result.rowCount} number(s) from pending status.`);
            result.rows.forEach(num => {
                bot.sendMessage(ADMIN_ID, `⚠️ Number <code>${num.number}</code> was automatically released due to a payment timeout.`, { parse_mode: 'HTML' });
            });
        }
    } catch (e) {
        console.error('[Scheduler] Error releasing timed-out numbers:', e);
    }
}

// Schedule this function to run every minute
setInterval(releaseTimedOutNumbers, 60 * 1000);



async function sendBannedUsersList(chatId, messageId = null) {
    if (String(chatId) !== ADMIN_ID) return;

    try {
        const result = await pool.query('SELECT user_id FROM banned_users ORDER BY banned_at DESC');
        const bannedUsers = result.rows;

        if (bannedUsers.length === 0) {
            const text = "No users are currently banned.";
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, text);
        }

        const userButtons = [];
        for (const user of bannedUsers) {
            let userName = `ID: ${user.user_id}`;
            try {
                const chat = await bot.getChat(user.user_id);
                userName = `${chat.first_name || ''} ${chat.last_name || ''} (${user.user_id})`.trim();
            } catch (e) {
                // User might have deleted their account, just use the ID
                console.warn(`Could not fetch info for banned user ${user.user_id}`);
            }
            userButtons.push([{ text: `${userName}`, callback_data: `unban_user:${user.user_id}` }]);
        }

        const options = {
            chat_id: chatId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: userButtons }
        };

        const text = "*Banned Users:*\n_Click a user to unban them._";
        if (messageId) {
            await bot.editMessageText(text, { ...options, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, text, options);
        }
    } catch (error) {
        console.error("Error sending banned users list:", error);
        await bot.sendMessage(chatId, "An error occurred while fetching the banned user list.");
    }
}


function generateOtp() {
    return crypto.randomInt(100000, 999999).toString();
}

async function isUserVerified(userId) {
    try {
        const result = await pool.query(
            'SELECT is_verified FROM email_verification WHERE user_id = $1',
            [userId]
        );
        return result.rows.length > 0 && result.rows[0].is_verified;
    } catch (error) {
        console.error(`[Verification] Error checking verification status for user ${userId}:`, error);
        return false;
    }
}

async function showPaymentOptions(chatId, messageId, priceNgn, days, appName = null) {
    const isRenewal = !!appName; // If appName is provided, it's a renewal
    
    // 1. Define USD Prices to display (Must match your pricing tiers)
    const usdPrices = {
        10: 0.35,
        30: 1.00,
        92: 2.00,
        185: 3.35,
        365: 5.35
    };
    // Fallback to 1.00 if days don't match
    const priceUsd = usdPrices[days] || 1.00;

    // 2. Define Callbacks
    // NOTE: We use 'nowpayments_deploy' to match the handler we created in the previous step.
    
    // Paystack
    const paystackCallback = isRenewal 
        ? `paystack_renew:${priceNgn}:${days}:${appName}` 
        : `paystack_deploy:${priceNgn}:${days}`;

    // Flutterwave
    const flutterwaveCallback = isRenewal 
        ? `flutterwave_renew:${priceNgn}:${days}:${appName}` 
        : `flutterwave_deploy:${priceNgn}:${days}`;

    // Crypto (NOWPayments)
    // Format: action : NGN_Amount : Days : AppName(optional)
    const cryptoCallback = isRenewal 
        ? `nowpayments_renew:${priceNgn}:${days}:${appName}` 
        : `nowpayments_deploy:${priceNgn}:${days}`;

    // Cancel
    const cancelCallback = isRenewal 
        ? `cancel_renewal:${appName}` 
        : 'cancel_payment_and_deploy';

    // 3. Send the Message
    // Displays: $5.35 (₦8025)
    await bot.editMessageText(
        `Please choose your preferred payment method to get your key for <b>$${priceUsd} (₦${priceNgn})</b> (${days} days).`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'HTML', // HTML is safer for bolding than Markdown
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Pay with Paystack', callback_data: paystackCallback }],
                    [{ text: 'Pay with Flutterwave', callback_data: flutterwaveCallback }],
                    [{ text: 'Pay with Crypto', callback_data: cryptoCallback }], 
                    [{ text: '« Cancel', callback_data: cancelCallback }]
                ]
            }
        }
    );
}

/**
 * Creates a Flutterwave payment link and returns the URL.
 */
async function initiateFlutterwavePayment(chatId, email, priceNgn, reference, metadata) {
    const isRenewal = metadata.product === 'Bot Renewal'; 
    const userEmail = await getUserEmail(chatId);
    
    // --- START OF MODIFIED LOGIC: ASK FOR EMAIL IF MISSING, AUTO-REGISTER ---
    if (!userEmail) {
        // Save the *entire* payment details object to the state to resume later
        userStates[chatId] = { 
            step: 'AWAITING_EMAIL_FOR_AUTO_REG', 
            data: { 
                // Store all metadata for resumption, plus the reference and provider
                ...metadata, 
                priceNgn: priceNgn, 
                reference: reference, // <-- CRUCIAL: Store the Flutterwave reference
                provider: 'flutterwave' // <-- CRUCIAL: Flag the payment provider
            } 
        };
        
        // Send a new message asking for email
        await bot.sendMessage(
            chatId,
            "Please enter your **e**mail address.",
            { parse_mode: 'Markdown' }
        );
        
        // Return null to stop the current payment flow and wait for user input
        return null; 
    }
    // --- END OF MODIFIED LOGIC ---

    const finalEmail = userEmail; // Guaranteed to be non-null here

    // ... (rest of the successful payment code remains the same)
    try {
        const response = await axios.post('https://api.flutterwave.com/v3/payments', {
            tx_ref: reference,
            amount: priceNgn,
            currency: "NGN",
            redirect_url: `https://t.me/${botUsername}`,
            customer: {
                email: finalEmail,
                name: `User ${chatId}`
            },
            meta: metadata,
            customizations: {
                title: "Ultar's WBD",
                description: metadata.product
            }
        }, {
            headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
        });
        
        return response.data.data.link;
    } catch (error) {
        console.error("[Flutterwave] Error creating payment link:", error.response?.data || error.message);
        return null;
    }
}

// In bot_services.js (REPLACE the entire deleteNeonDatabase function)

/**
 * Deletes a database by routing the request to the correct host (AWS or Neon).
 * This function is used by the /deldb command for both explicit and orphan cleanup.
 */
async function deleteNeonDatabase(dbName, expectedAccountId) {
    
    // Step 1: Input Validation
    if (!dbName) {
        return { success: false, error: "Missing dbName provided.", accounts_checked: 0 };
    }

    const expectedIdInt = parseInt(expectedAccountId, 10) || 1;
    const neonDbName = dbName.replace(/-/g, '_'); 

    // --- Sub-function to safely check credentials ---
    const checkCredentials = (account) => {
        return account && account.api_key && account.project_id && account.branch_id;
    }

    // --- Sub-function for Neon API deletion ---
    const attemptNeonDelete = async (account) => {
        const apiUrl = `https://console.neon.tech/api/v2/projects/${account.project_id}/branches/${account.branch_id}/databases/${neonDbName}`;
        const headers = { 'Authorization': `Bearer ${account.api_key}`, 'Accept': 'application/json' };
        await axios.delete(apiUrl, { headers });
    };

    // =================================================================
    // 1. STRATEGY A: EXPLICIT NEON DELETE (If ID is provided - Single Check Only)
    // =================================================================
    if (expectedAccountId && expectedAccountId !== '1') { 
        const primaryAccount = NEON_ACCOUNTS.find(acc => acc.id === expectedIdInt);
        
        if (checkCredentials(primaryAccount)) {
            try {
                await attemptNeonDelete(primaryAccount);
                console.log(`[Neon Delete] SUCCESS on Explicit Account ${expectedIdInt}.`);
                return { success: true, accounts_checked: expectedIdInt };
                
            } catch (error) {
                if (error.response?.status === 404) {
                     return { success: true, accounts_checked: expectedIdInt };
                }
                const primaryErrorMsg = error.response?.data?.message || error.message;
                return { success: false, error: `Neon Explicit Delete Failed: ${primaryErrorMsg.substring(0, 50)}`, accounts_checked: expectedIdInt };
            }
        } else {
             return { success: false, error: `Neon Account ${expectedIdInt} has invalid credentials.` };
        }
    }


    // =================================================================
    // 2. STRATEGY B: HYBRID SEARCH (If no ID provided - /deldb name or /deldb)
    // =================================================================
    
    // --- STEP 1: TRY AWS SELF-HOSTED FIRST ---
    if (process.env.SELF_HOSTED_DB_URL && process.env.SELF_HOSTED_DB_SECRET) {
        console.log(`[Delete Router] Attempting deletion via AWS Self-Hosted...`);
        // Assumes deleteSelfHostedDatabase is defined/exported in bot_services.js
        const awsResult = await deleteSelfHostedDatabase(dbName);
        
        if (awsResult.success) {
            console.log(`[Delete Router] AWS deletion successful (or confirmed missing).`);
            return { success: true, accounts_checked: 'AWS' };
        }
        console.warn(`[Delete Router] AWS deletion failed. Starting Neon Search...`);
    }

    // --- STEP 2: FALLBACK TO FULL NEON SEARCH ---
    
    let accountsChecked = 0;
    for (const fallbackAccount of NEON_ACCOUNTS) {
        const fallbackAccountId = fallbackAccount.id;
        accountsChecked++;
        
        console.log(`[Neon Delete] Search: Checking Account ${fallbackAccountId}...`);

        if (checkCredentials(fallbackAccount)) {
            try {
                await attemptNeonDelete(fallbackAccount);
                console.log(`[Neon Delete] SUCCESS on Fallback Account ${fallbackAccountId}.`);
                return { success: true, accounts_checked: fallbackAccountId }; 
                
            } catch (error) {
                 if (error.response?.status === 404) continue; 
                 const fallbackErrorMsg = error.response?.data?.message || error.message;
                 console.warn(`[Neon Delete] Fallback FAIL on Account ${fallbackAccountId}: ${fallbackErrorMsg}.`);
                 // Return the specific failure message
                 return { success: false, error: `Neon API Fail (Acc ${fallbackAccountId}): ${fallbackErrorMsg.substring(0, 50)}`, accounts_checked: fallbackAccountId };
            }
        }
    }
    
    // --- Step 3: Final Failure ---
    const finalErrorMsg = `Database not found in AWS or any configured Neon account.`;
    console.error(`[Delete Router] FINAL FAILURE: ${finalErrorMsg}`);
    return { success: false, error: finalErrorMsg, accounts_checked: accountsChecked };
}


/**
 * Fetches detailed statistics for a specific Neon account.
 * @param {string} accountId - The account identifier ('1' or '2').
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function getNeonStatsForAccount(accountId) {
    // Select the correct environment variables based on the account ID
    const apiKey = process.env[`NEON_API_KEY_${accountId}`];
    const projectId = process.env[`NEON_PROJECT_ID_${accountId}`];
    const branchId = process.env[`NEON_BRANCH_ID_${accountId}`];

    // Basic validation
    if (!apiKey || !projectId || !branchId) {
        const missing = [!apiKey && `API_KEY_${accountId}`, !projectId && `PROJECT_ID_${accountId}`, !branchId && `BRANCH_ID_${accountId}`].filter(Boolean).join(', ');
        console.error(`[Neon Stats ${accountId}] API credentials are not fully configured. Missing: ${missing}`);
        // Return an error, but don't stop the whole /dbstats command if one account is missing
        return { success: false, error: `Neon Account ${accountId} credentials (KEY, PROJECT_ID, BRANCH_ID) are not set.` };
    }

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
    };

    // API endpoints using the specific project/branch IDs
    const dbsUrl = `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}/databases`;
    const branchUrl = `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}`;

    try {
        // Fetch data for the specific account
        const [dbsResponse, branchResponse] = await Promise.all([
            axios.get(dbsUrl, { headers }),
            axios.get(branchUrl, { headers })
        ]);

        const databaseList = dbsResponse.data.databases;
        const branchData = branchResponse.data.branch;

        // Extract useful information
        // Convert bytes to MB, handle potential null/undefined size
        const logicalSizeMB = branchData.logical_size ? (branchData.logical_size / (1024 * 1024)).toFixed(2) : '0.00';
        const databases = databaseList.map(db => ({
            name: db.name,
            owner: db.owner_name,
            created_at: new Date(db.created_at).toLocaleDateString('en-US') // Or your preferred format
        }));

        // Return structured data including account info
        return {
            success: true,
            data: {
                accountId: accountId, // Include which account this is for
                logical_size_mb: logicalSizeMB,
                databases: databases,
                project_id: projectId,
                branch_id: branchId
            }
        };
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[Neon Stats ${accountId}] Error fetching stats: ${errorMsg}`);
        // Return specific error for this account
        return { success: false, error: `Account ${accountId}: ${errorMsg}` };
    }
}

// Keep a simple getNeonStats function IF you need it elsewhere,
// otherwise, you can remove it. This example assumes you might
// still call it without args to default to account 1.
async function getNeonStats() {
   console.warn("[Neon Stats] Deprecated: getNeonStats() called without account ID. Defaulting to Account 1.");
   return getNeonStatsForAccount('1');
}



/**
 * Creates a Paystack payment link and sends it to the user.
 */
// bot.js (Replace existing initiatePaystackPayment function)

async function initiatePaystackPayment(chatId, messageId, paymentDetails) {
    const { isRenewal, appName, days, priceNgn, botType, APP_NAME, SESSION_ID } = paymentDetails;
    const userEmail = await getUserEmail(chatId);

    // --- START OF MODIFIED LOGIC: ASK FOR EMAIL IF MISSING, AUTO-REGISTER ---
    if (!userEmail) {
        // Save the *entire* payment details object to the state to resume later
        userStates[chatId] = { 
            step: 'AWAITING_EMAIL_FOR_AUTO_REG', 
            data: { 
                ...paymentDetails, // Keep all deployment/renewal info
                messageId: messageId // Keep track of the message to edit later
            } 
        };
        await bot.editMessageText(
            "Please enter your **e**mail address.", {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }
        );
        return;
    }
    // --- END OF MODIFIED LOGIC ---
   
    const sentMsg = await bot.editMessageText('Generating Paystack payment link...', { chat_id: chatId, message_id: messageId });
    
    const reference = `psk_${crypto.randomBytes(12).toString('hex')}`;
    const priceInKobo = priceNgn * 100;
    
    const metadata = isRenewal 
        ? { user_id: chatId, product: 'Bot Renewal', days: days, appName: appName }
        : { user_id: chatId, product: `Deployment Key - ${days} Days`, days: days, price: priceNgn };

    // Store pending payment in the database
    if (!isRenewal) {
        await pool.query(
            'INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [reference, chatId, userEmail, botType, APP_NAME, SESSION_ID]
        );
    }

    try {
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            { email: userEmail, amount: priceInKobo, reference, metadata },
            { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
        );
        
        const paymentUrl = paystackResponse.data.data.authorization_url;
        await bot.editMessageText(
            `Click the button below to complete your payment with Paystack.`, {
                chat_id: chatId,
                message_id: sentMsg.message_id,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]]
                }
            }
        );
    } catch (error) {
        console.error("[Paystack] Error creating payment link:", error.response?.data || error.message);
        await bot.editMessageText('Sorry, an error occurred while creating the Paystack payment link. Please try another method.', {
            chat_id: chatId,
            message_id: sentMsg.message_id,
            reply_markup: {
                inline_keyboard: [
                    // This button takes them back to the "Pay with Paystack / Flutterwave / Crypto" menu
                    [{ text: '« Back to Payment Options', callback_data: `select_plan:${priceNgn}:${days}` }]
                ]
            }
        });
    }
}


async function sendBappList(chatId, messageId = null, botTypeFilter) {
    const checkingMsg = await bot.editMessageText(
        `Checking and syncing all *${botTypeFilter.toUpperCase()}* apps with Heroku...`, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown'
    }).catch(() => bot.sendMessage(chatId, `Checking apps...`, { parse_mode: 'Markdown' }));

    messageId = checkingMsg.message_id;

    try {
        // Step 1: Run the reconciliation process first
        await dbServices.reconcileDatabaseWithHeroku(botTypeFilter);

        // Step 2: Then, get the now-corrected list of bots from the database
        const dbResult = await pool.query(
            `SELECT user_id, app_name, deleted_from_heroku_at FROM user_deployments WHERE bot_type = $1 ORDER BY app_name ASC`,
            [botTypeFilter]
        );
        const allDbBots = dbResult.rows;

        if (allDbBots.length === 0) {
            return bot.editMessageText(`No bots (active or inactive) were found in the database for the type: *${botTypeFilter.toUpperCase()}*`, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown'
            });
        }

        // Step 3: Verify each bot against Heroku and update its status in our list
        const verificationPromises = allDbBots.map(async (bot) => {
            try {
                await herokuApi.get(`https://api.heroku.com/apps/${bot.app_name}`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                if (bot.deleted_from_heroku_at) {
                    await pool.query('UPDATE user_deployments SET deleted_from_heroku_at = NULL WHERE app_name = $1', [bot.app_name]);
                }
                return { ...bot, is_active: true };
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    if (!bot.deleted_from_heroku_at) {
                        await dbServices.markDeploymentDeletedFromHeroku(bot.user_id, bot.app_name);
                    }
                }
                return { ...bot, is_active: false };
            }
        });
        
        const verifiedBots = await Promise.all(verificationPromises);

        const appButtons = verifiedBots.map(entry => {
            const statusIndicator = entry.is_active ? '🟢' : '🔴';
            return {
                text: `${statusIndicator} ${entry.app_name}`,
                callback_data: `select_bapp:${entry.app_name}:${entry.user_id}`
            };
        });

        const rows = chunkArray(appButtons, 3);
        const text = `Select a *${botTypeFilter.toUpperCase()}* app to view details (🟢 Active, 🔴 Inactive):`;
        const options = {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows }
        };

        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });

    } catch (error) {
        console.error(`Error fetching and syncing app list for /bapp:`, error.message);
        await bot.editMessageText(`An error occurred while syncing the app list. Please check the logs.`, {
             chat_id: chatId, message_id: messageId
        });
    }
}


// AROUND LINE 520 (inside bot.js)

async function sendAnimatedMessage(chatId, baseText) {
    // --- REPLACE THIS LINE ---
    // const msg = await bot.sendMessage(chatId, `${getAnimatedEmoji()} ${baseText}...`);
    // --- WITH THIS ---
    const msg = await bot.sendMessage(chatId, `${baseText}... ${getAnimatedEmoji()}`);
    // --- END REPLACE ---
    await new Promise(r => setTimeout(r, 1200));
    return msg;
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}


async function streamLiveLogs(chatId, appName, messageId) {
    try {
        // 1. Create a Tail Log Session
        const session = await axios.post(
            `https://api.heroku.com/apps/${appName}/log-sessions`,
            { lines: 10, tail: true }, 
            {
                headers: {
                    'Accept': 'application/vnd.heroku+json; version=3',
                    'Authorization': `Bearer ${process.env.HEROKU_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        // 2. Open the Logplex Stream
        const streamResponse = await axios({
            method: 'get',
            url: session.data.logplex_url,
            responseType: 'stream'
        });

        let logBuffer = [];
        let lastMessageText = ""; // Track the last text sent to avoid redundant edits

        // 3. Listen for data and update Telegram
        streamResponse.data.on('data', async (chunk) => {
            const lines = chunk.toString().split('\n').filter(l => l.trim());
            if (lines.length === 0) return;

            logBuffer = [...logBuffer, ...lines].slice(-15); 
            const logText = `**Live Log Stream for ${appName}:**\n\n\`\`\`\n${logBuffer.join('\n')}\n\`\`\``;

            // Only attempt to edit if the content is actually different
            if (logText === lastMessageText) return;

            try {
                await bot.editMessageText(logText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
                lastMessageText = logText; // Update the tracker
            } catch (e) {
                // Specific fix for the "message is not modified" error
                if (e.message.includes("message is not modified")) {
                    // Do nothing, this is normal when logs haven't moved
                } else if (e.message.includes("429")) {
                    console.warn("[Live Logs] Rate limited by Telegram. Waiting...");
                } else {
                    console.error("Live log edit error:", e.message);
                }
            }
        });

        // Auto-stop after 2 minutes to save resources/API limits
        setTimeout(() => {
            if (streamResponse.data) streamResponse.data.destroy();
            bot.sendMessage(chatId, "Live log session ended. Click the button again to resume.");
        }, 120000);

    } catch (error) {
        console.error("Live Stream Error:", error.message);
        bot.sendMessage(chatId, "Error connecting to live logs. Ensure the bot is running.");
    }
}


// REPLACE WITH THIS
async function loadMaintenanceStatus() {
    try {
        const result = await pool.query("SELECT setting_value FROM app_settings WHERE setting_key = 'maintenance_mode'");
        if (result.rows.length > 0) {
            isMaintenanceMode = (result.rows[0].setting_value === 'on');
        } else {
            // If for some reason the row doesn't exist, create it
            await pool.query("INSERT INTO app_settings (setting_key, setting_value) VALUES ('maintenance_mode', 'off')");
            isMaintenanceMode = false;
            console.log('[Maintenance] Status not found in DB. Created with default OFF.');
        }
        console.log(`[Maintenance] Loaded status from DATABASE: ${isMaintenanceMode ? 'ON' : 'OFF'}`);
    } catch (error) {
        console.error('[Maintenance] CRITICAL ERROR loading status from database:', error.message);
        // Fallback to OFF if the database is unreachable on startup
        isMaintenanceMode = false; 
    }
}

/**
 * Explicitly triggers a new deployment (a restart) on Render.
 */
async function triggerRenderRestart() {
    const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
        console.error('[Restart] Cannot trigger restart: Render API details are not set.');
        return;
    }
    try {
        const deployUrl = `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`;
        const headers = { 'Authorization': `Bearer ${RENDER_API_KEY}` };
        await axios.post(deployUrl, {}, { headers });
        console.log('[Restart] Successfully triggered an explicit restart on Render.');
    } catch (error) {
        console.error('[Restart] Failed to trigger explicit restart:', error.message);
    }
}


// In bot.js (REPLACE the checkHerokuApiKey function)

async function checkHerokuApiKey() {
    if (!HEROKU_API_KEY) {
        console.error('[API Check] CRITICAL: HEROKU_API_KEY is not set.');
        return;
    }

    try {
        await axios.get('https://api.heroku.com/account', {
            headers: {
                'Authorization': `Bearer ${HEROKU_API_KEY}`,
                'Accept': 'application/vnd.heroku+json; version=3'
            }
        });
        
        console.log('[API Check] Periodic check: Heroku API key is valid.');

    } catch (error) {
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            
            const status = error.response.status;
            const reason = status === 403 ? 'Forbidden/Suspended' : 'Unauthorized';
            
            console.error(`[API Check] Status ${status} (${reason}): Triggering recovery workflow...`);
            
            // Trigger the auto-replacement logic (where the DB logic resides)
            await handleInvalidHerokuKeyWorkflow(HEROKU_API_KEY);

        } else {
            console.error(`[API Check] An unexpected error occurred during periodic check:`, error.message);
        }
    }
}


// In bot_services.js (Add this function)

/**
 * Sets the expiration_date for all deployed bots belonging to a specific user.
 * @param {string} userId - The target user's ID.
 * @param {number} days - The number of days to add to the current date.
 * @returns {Promise<{success: boolean, count: number}>} - Count of updated rows.
 */
async function setAllUserBotsExpiration(userId, days) {
    try {
        // Use a parameterized query to safely add the interval
        const result = await pool.query(
            `UPDATE user_deployments 
             SET expiration_date = NOW() + ($1 * INTERVAL '1 day') 
             WHERE user_id = $2 
             AND expiration_date IS NOT NULL 
             RETURNING app_name`,
            [days, userId]
        );
        
        console.log(`[DB] Mass expiration set for ${result.rowCount} bots belonging to user ${userId}.`);
        
        return { success: true, count: result.rowCount };

    } catch (error) {
        console.error(`[DB] Error performing mass expiration update for user ${userId}:`, error);
        return { success: false, count: 0 };
    }
}



async function runExternalDbCopy(adminId, sourceDbUrl, targetDbUrl) {
    const msg = await bot.sendMessage(adminId, `Starting database copy... This will **overwrite all data** in the destination. This may take several minutes.`, { parse_mode: 'Markdown' });

    try {
        console.log(`[DB Copy] Starting pg_dump pipe from source to destination...`);
        
        // ❗️ FIX: Added --no-owner and --no-privileges to the pg_dump command
        // This stops it from copying permission-related commands that crash the destination DB.
        const command = `pg_dump "${sourceDbUrl}" --clean --no-owner --no-privileges | psql "${targetDbUrl}"`;
        
        const { stderr } = await execPromise(command, { maxBuffer: 1024 * 1024 * 10 }); // 10MB buffer

        if (stderr && (stderr.toLowerCase().includes('error') || stderr.toLowerCase().includes('fatal'))) {
            // Ignore common, harmless psql warnings
            if (!stderr.includes(`schema "public" does not exist`)) {
                 throw new Error(stderr);
            }
        }
        
        console.log(`[DB Copy] Successfully copied database.`);
        await bot.editMessageText(`**Copy Complete!**\n\nData has been copied and the destination database was overwritten.`, { chat_id: adminId, message_id: msg.message_id, parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`[DB Copy] FAILED to copy database:`, error.message);
        await bot.editMessageText(`**Copy Failed!**\n\n*Reason:* ${escapeMarkdown(error.message)}\n\nCheck your bot's logs for details.`, { chat_id: adminId, message_id: msg.message_id, parse_mode: 'Markdown' });
    }
}



// REPLACE WITH THIS
async function saveMaintenanceStatus(status) {
    const statusValue = status ? 'on' : 'off';
    try {
        await pool.query("UPDATE app_settings SET setting_value = $1 WHERE setting_key = 'maintenance_mode'", [statusValue]);
        console.log(`[Maintenance] Saved status to DATABASE: ${statusValue.toUpperCase()}`);
    } catch (error) {
        console.error('[Maintenance] CRITICAL ERROR saving status to database:', error.message);
    }
}


function formatExpirationInfo(deployDateStr, expirationDateStr) {
    if (!deployDateStr) return 'N/A';

    const deployDate = new Date(deployDateStr);
    const fixedExpirationDate = new Date(deployDate.getTime() + 35 * 24 * 60 * 60 * 1000); // 45 days from original deploy
    const now = new Date();

    const expirationDisplay = fixedExpirationDate.toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' });

    const timeLeftMs = fixedExpirationDate.getTime() - now.getTime();
    const daysLeft = Math.ceil(timeLeftMs / (1000 * 60 * 60 * 24));

    if (daysLeft > 0) {
        return `${expirationDisplay} (Expires in ${daysLeft} days)`;
    } else {
        return `Expired on ${expirationDisplay}`;
    }
}


function buildKeyboard(isAdmin) {
  // --- Bot API 9.4 Colored Buttons Integration ---
  
  const baseMenu = [
      [
        { text: 'Get Session ID', style: 'primary' }, // Blue
        { text: 'Deploy', style: 'success' }         // Green
      ],
      [
        { text: 'Free Trial', style: 'primary' },        // Green
        { text: 'My Bots', style: 'success' }      // Blue
      ],
      [
        { text: 'FAQ', style: 'primary' }, 
        { text: 'Referrals', style: 'success' }
      ],
      [
        { text: 'Support', style: 'danger' }, 
        { text: 'More Features', style: 'success' }
      ] 
  ];

  if (isAdmin) {
      return [
          [
            { text: 'Deploy', style: 'success' }, 
            { text: 'Apps', style: 'primary' }
          ],
          [
            { text: 'Generate Key', style: 'success' }, 
            { text: 'Get Session ID', style: 'primary' }
          ],
          ['/stats', '/dbstats', '/bapp'],
          [
            { text: '/copydb', style: 'danger' },    // Red
            { text: '/backupall', style: 'danger' }, // Red
            { text: '/restoreall', style: 'success' } // Green
          ]
      ];
  }
  return baseMenu;
}



function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function startRestartCountdown(chatId, appName, messageId) {
    const totalSeconds = 60;
    const intervalTime = 5;
    const totalSteps = totalSeconds / intervalTime;

    await bot.editMessageText(`Bot "${appName}" restarting...`, {
        chat_id: chatId,
        message_id: messageId
    }).catch(() => {});

    for (let i = 0; i <= totalSteps; i++) {
        const secondsLeft = totalSeconds - (i * intervalTime);
        const minutesLeft = Math.floor(secondsLeft / 60);
        const remainingSeconds = secondsLeft % 60;

        const filledBlocks = '█'.repeat(i);
        const emptyBlocks = '░'.repeat(totalSteps - i);

        let countdownMessage = `Bot "${appName}" restarting...\n\n`;
        if (secondsLeft > 0) {
            countdownMessage += `[${filledBlocks}${emptyBlocks}] ${minutesLeft}m ${remainingSeconds}s left`;
        } else {
            countdownMessage += `[${filledBlocks}] Restart complete!`;
        }

        await bot.editMessageText(countdownMessage, {
            chat_id: chatId,
            message_id: messageId
        }).catch(() => {});

        if (secondsLeft <= 0) break;
        await new Promise(r => setTimeout(r, intervalTime * 1000));
    }
    await bot.editMessageText(`Bot "${appName}" has restarted successfully and is back online!`, {
        chat_id: chatId,
        message_id: messageId
    });
}

// --- REPLACE your old handleRestoreAll function with these TWO new functions ---

// This function runs when you first click "Levanter" or "Raganork"
async function handleRestoreAllSelection(query) {
    const chatId = query.message.chat.id;
    const botType = query.data.split(':')[1];
    
    await bot.editMessageText(`Fetching list of restorable ${botType} bots...`, {
        chat_id: chatId,
        message_id: query.message.message_id
    });

    const deployments = await dbServices.getAllDeploymentsFromBackup(botType);
    if (!deployments.length) {
        await bot.editMessageText(`No bots of type "${botType}" found in the backup to restore.`, {
            chat_id: chatId,
            message_id: query.message.message_id
        });
        return;
    }

    let listMessage = `Found *${deployments.length}* ${botType} bot(s) ready for restoration:\n\n`;
    deployments.forEach(dep => {
        listMessage += `• \`${dep.app_name}\` (Owner: \`${dep.user_id}\`)\n`;
    });
    listMessage += `\nThis process will deploy them one-by-one with a 3-minute delay between each success.\n\n*Do you want to proceed?*`;

    await bot.editMessageText(listMessage, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Proceed", callback_data: `restore_all_confirm:${botType}` },
                    { text: "Cancel", callback_data: 'restore_all_cancel' }
                ]
            ]
        }
    });
}
      

/**
 * Fetches all non-system user-created table names from the database.
 * @returns {Promise<string[]>} A list of table names.
 */
async function getAllTableNames() {
    // Query to select all table names that are not system tables
    const query = `
        SELECT tablename 
        FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename NOT IN ('sessions', 'all_users_backup')
        ORDER BY tablename;
    `;
    try {
        const result = await pool.query(query);
        return result.rows.map(row => row.tablename);
    } catch (e) {
        console.error("Error fetching table names:", e);
        return [];
    }
}


// A new reusable function to display the key deletion menu
async function sendKeyDeletionList(chatId, messageId = null) {
    if (chatId.toString() !== ADMIN_ID) return;

    try {
        const activeKeys = await dbServices.getAllDeployKeys();

        if (activeKeys.length === 0) {
            const text = "There are no active keys to delete.";
            if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
            return bot.sendMessage(chatId, text);
        }

        const keyButtons = activeKeys.map(k => ([{
            text: `${k.key} (${k.uses_left} uses left)`,
            callback_data: `dkey_select:${k.key}`
        }]));
        
        const options = {
            chat_id: chatId,
            text: "Select a deployment key to delete:",
            reply_markup: { inline_keyboard: keyButtons }
        };

        if (messageId) {
            await bot.editMessageReplyMarkup(options.reply_markup, { chat_id: chatId, message_id: messageId });
            await bot.editMessageText(options.text, { chat_id: chatId, message_id: messageId });
        } else {
            await bot.sendMessage(chatId, options.text, { reply_markup: options.reply_markup });
        }
    } catch (error) {
        console.error("Error sending key deletion list:", error);
        await bot.sendMessage(chatId, "An error occurred while fetching the key list.");
    }
}




function getNeonAccount(accountId) {
    // Assuming NEON_ACCOUNTS is accessible globally or imported.
    return NEON_ACCOUNTS.find(acc => acc.id === parseInt(accountId, 10));
}

/**
 * Fetches the count of databases for a specific Neon account.
 * (Used to check if the 3-database limit is reached.)
 */
async function getNeonDbCount(accountId) {
    const account = getNeonAccount(accountId);
    if (!account) return { success: false, error: "Account config not found." };

    const apiUrl = `https://console.neon.tech/api/v2/projects/${account.project_id}/branches/${account.branch_id}/databases`;
    const headers = {
        'Authorization': `Bearer ${account.api_key}`,
        'Accept': 'application/json'
    };

    try {
        const response = await axios.get(apiUrl, { headers });
        const dbCount = response.data.databases.length;
        return { success: true, count: dbCount, limit: account.active_db_limit };
    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[Neon DB Count ${accountId}] Error: ${errorMsg}`);
        return { success: false, error: errorMsg };
    }
}




async function notifyAdminUserOnline(msg) {
    // Ensure msg.from exists and has an ID to prevent errors for non-user messages (e.g., channel posts)
    if (!msg || !msg.from || !msg.from.id) {
        console.warn("[Admin Notification] Skipping: msg.from or msg.from.id is undefined.", msg);
        return;
    }

    // Prevent bot from notifying itself (or other bots)
    if (msg.from.is_bot) {
        console.log("[Admin Notification] Skipping: Message originated from a bot.");
        return;
    }

    const userId = msg.from.id.toString();
    const now = Date.now();

    if (userId === ADMIN_ID) { // Don't notify admin about themselves
        return;
    }

    const lastNotified = userLastSeenNotification.get(userId) || 0;
    const lastAdminMessageId = adminOnlineMessageIds.get(userId);

    // Capture the text of the message (button/command pressed)
    const userAction = msg.text || (msg.callback_query ? `Callback: ${msg.callback_query.data}` : 'Interacted');

    // Safely get user details, providing fallbacks for undefined properties
    const first_name = msg.from.first_name ? escapeMarkdown(msg.from.first_name) : 'N/A';
    const last_name = msg.from.last_name ? escapeMarkdown(msg.from.last_name) : '';
    const username = msg.from.username ? `@${escapeMarkdown(msg.from.username)}` : 'N/A';

    const userDetails = `
*User Online:*
*ID:* \`${userId}\`
*Name:* ${first_name} ${last_name}
*Username:* ${username}
*Last Action:* \`${escapeMarkdown(userAction)}\`
*Time:* ${new Date().toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Africa/Lagos' })}
    `;

    // If within cooldown, attempt to edit the existing message
    if (now - lastNotified < ONLINE_NOTIFICATION_COOLDOWN_MS && lastAdminMessageId) {
        try {
            await bot.editMessageText(userDetails, {
                chat_id: ADMIN_ID,
                message_id: lastAdminMessageId,
                parse_mode: 'Markdown'
            });
            userLastSeenNotification.set(userId, now); // Still update timestamp to reset cooldown
            console.log(`[Admin Notification] Edited admin notification for user ${userId} (action: ${userAction}).`);
        } catch (error) {
            console.error(`Error editing admin notification for user ${userId}:`, error.message);
            // If editing fails (e.g., message too old), send a new one
            try {
                const sentMsg = await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'Markdown' });
                adminOnlineMessageIds.set(userId, sentMsg.message_id);
                userLastSeenNotification.set(userId, now);
                console.log(`[Admin Notification] Sent new admin notification for user ${userId} after edit failure.`);
            } catch (sendError) {
                console.error(`Error sending new admin notification for user ${userId} after edit failure:`, sendError.message);
            }
        }
    } else { // Outside cooldown or no previous message to edit, send new message
        try {
            const sentMsg = await bot.sendMessage(ADMIN_ID, userDetails, { parse_mode: 'Markdown' });
            adminOnlineMessageIds.set(userId, sentMsg.message_id);
            userLastSeenNotification.set(userId, now);
            console.log(`[Admin Notification] Notified admin about user ${userId} being online (action: ${userAction}).`);
        } catch (error) {
            console.error(`Error notifying admin about user ${userId} online:`, error.message);
        }
    }
}


// 7) Initialize modular components
(async () => {
    // Initialize bot_monitor.js
    monitorInit({
        bot: bot,
        config: { SESSION: [] }, // SESSION is from config.js, will be loaded by bot.js. Placeholder for now.
        APP_NAME: process.env.APP_NAME || 'Raganork Bot',
        HEROKU_API_KEY: HEROKU_API_KEY,
        TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN,
        TELEGRAM_USER_ID: TELEGRAM_USER_ID,
        TELEGRAM_CHANNEL_ID: TELEGRAM_CHANNEL_ID,
        RESTART_DELAY_MINUTES: parseInt(process.env.RESTART_DELAY_MINUTES || '1', 10), // Keep 1 min for testing
        appDeploymentPromises: appDeploymentPromises,
        getUserIdByBotName: dbServices.getUserIdByBotName, // Pass DB service function
        deleteUserBot: dbServices.deleteUserBot,           // Pass DB service function
        deleteUserDeploymentFromBackup: dbServices.deleteUserDeploymentFromBackup, // Pass DB service function
        backupPool: backupPool,  // Pass the backup DB pool
        mainPool: pool,
        getAllUserBots: dbServices.getAllUserBots,
        getAllUserDeployments: dbServices.getAllUserDeployments,
        ADMIN_ID: ADMIN_ID, // Pass ADMIN_ID for critical errors
       escapeMarkdown: escapeMarkdown,
    });

    //// Initialize bot_services.js
   servicesInit({
    mainPool: pool,
    backupPool: backupPool,
    bot: bot,
    herokuApi: herokuApi,
    NEON_ACCOUNTS: NEON_ACCOUNTS,
    HEROKU_API_KEY: HEROKU_API_KEY,
    GITHUB_LEVANTER_REPO_URL: GITHUB_LEVANTER_REPO_URL,
    GITHUB_HERMIT_REPO_URL: GITHUB_HERMIT_REPO_URL,
    GITHUB_RAGANORK_REPO_URL: GITHUB_RAGANORK_REPO_URL,
    ADMIN_ID: ADMIN_ID,
    runOrphanDbCleanup: runOrphanDbCleanup,
    createNeonDatabase: createNeonDatabase, 
    deleteNeonDatabase: deleteNeonDatabase,
    storeNewVcfContact: dbServices.storeNewVcfContact,       // <-- ADD THIS
    generateAndSendVcf: dbServices.generateAndSendVcf,  
    // --- CRITICAL CHANGE START ---
    defaultEnvVars: { // <-- Pass an object containing both
        levanter: levanterDefaultEnvVars,
        raganork: raganorkDefaultEnvVars,
        hermit: hermitDefaultEnvVars
    },
    // --- CRITICAL CHANGE END ---
    appDeploymentPromises: appDeploymentPromises,
    RESTART_DELAY_MINUTES: parseInt(process.env.RESTART_DELAY_MINUTES || '1', 10),
    getAnimatedEmoji: getAnimatedEmoji,
    animateMessage: animateMessage,
    sendAnimatedMessage: sendAnimatedMessage,
    monitorSendTelegramAlert: monitorSendTelegramAlert,
     getAllUserBots: dbServices.getAllUserBots, 
    escapeMarkdown: escapeMarkdown, // <-- Ensure this is passed
   });

    // Initialize bot_faq.js
    faqInit({
        bot: bot,
        userStates: userStates, // Pass the central userStates object
        escapeMarkdown: escapeMarkdown,
    });
  mailListener.init(bot, pool); // Start the mail listener with the bot and database pool

  // This imports the functions from the module
const { handleGroupCommand, handleNewMembers, handleLeftMembers } = registerGroupHandlers(bot, dbServices);

// This tells the bot to use them for the correct events
bot.on('new_chat_members', handleNewMembers);
bot.on('left_chat_member', handleLeftMembers);


// Add this inside your main startup block
await recoverReminders();

    await loadMaintenanceStatus(); // Load initial maintenance status
// In bot.js, inside the main (async () => { ... })(); startup block

  startScheduledTasks();
    await checkHerokuApiKey(); 

  setTimeout(async () => {
      try {
          // This must run AFTER the pool is exported and available
          await loadAllClients(bot); 
          console.log('[WA-SYSTEM] Finished loading persistent WhatsApp sessions.');
      } catch (e) {
          console.error('[WA-SYSTEM] CRITICAL FAILURE loading clients after timeout:', e);
      }
  }, 5000); // Wait 5 seconds
  //

// Schedule the DB-backed recovery check every minute
setInterval(runScheduledRecoveryCheck, 60 * 1000); 
console.log('[Scheduler] Database-backed recovery check initiated.');

// Also run it once at startup
runScheduledRecoveryCheck(); 


  setInterval(checkNeonCapacity, CAPACITY_CHECK_INTERVAL_MS);
    console.log(`[Capacity Check] Proactive Neon capacity monitor scheduled every 6 hours.`);


// Check the environment to decide whether to use webhooks or polling
// At the top of your file, make sure you have crypto required
const crypto = require('crypto');

if (process.env.NODE_ENV === 'production') {
    // --- Webhook Mode (for Heroku) ---
    const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // <-- ADD THIS LINE

const APP_URL = process.env.APP_URL;

    if (!APP_URL) {
        console.error('CRITICAL ERROR: APP_URL environment variable is not set. The bot cannot start in webhook mode.');
        process.exit(1);
    }
    const PORT = process.env.PORT || 3000;
    
    const cleanedAppUrl = APP_URL.endsWith('/') ? APP_URL.slice(0, -1) : APP_URL;

    const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
    const fullWebhookUrl = `${cleanedAppUrl}${webhookPath}`;

    await bot.setWebHook(fullWebhookUrl);
    console.log(`[Webhook] Set successfully for URL: ${fullWebhookUrl}`);

  // --- REPLACE the previous pinging block with this one ---

    app.listen(PORT, () => {
        console.log(`[Web Server] Server running on port ${PORT}`);
    });

    // --- START: Auto-Ping Logic (Render ONLY) ---

    // This check now ensures it only runs if the APP_URL is set AND it's on Render
    if (process.env.APP_URL && process.env.RENDER === 'true') {
      const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
      
      setInterval(async () => {
        try {
          // Send a GET request to the app's own URL
          await axios.get(APP_URL);
          console.log(`[Pinger] Render self-ping successful to ${APP_URL}`);
        } catch (error) {
          // Log any errors without crashing the bot
          console.error(`[Pinger] Render self-ping failed: ${error.message}`);
        }
      }, PING_INTERVAL_MS);
      
      console.log(`[𝖀𝖑𝖙-𝕬𝕽] Render self-pinging service initialized for ${APP_URL} every 10 minutes.`);
    } else {
      console.log('[𝖀𝖑𝖙-𝕬𝕽] Self-pinging service is disabled (not running on Render).');
    }
    // --- END: Auto-Ping Logic ---

    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

    app.get('/', (req, res) => {
        res.send('Bot is running (webhook mode)!');
    });

  app.get('/verify', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'verify.html'));
    });
  
  app.get('/miniapp', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// NEW: Health check endpoint for the Mini App
app.get('/miniapp/health', (req, res) => {
    console.log('[Health Check] Mini App server is responsive.');
    res.status(200).json({ status: 'ok', message: 'Server is running.' });
});


 const validateWebAppInitData = (req, res, next) => {
    const initData = req.header('X-Telegram-Init-Data');
    if (!initData) {
        console.warn('[MiniApp Server] Unauthorized: No init data provided.');
        return res.status(401).json({ success: false, message: 'Unauthorized: No init data provided' });
    }

    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        urlParams.sort();

        // The correct way to build the data string for validation
        const dataCheckString = Array.from(urlParams.entries())
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');

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
};


// GET /api/app-name-check/:appName - Check if an app name is available
app.get('/api/app-name-check/:appName', validateWebAppInitData, async (req, res) => {
    const { appName } = req.params;

    // Check if the key is available before making the request
    if (!HEROKU_API_KEY) {
        console.error('[MiniApp] Heroku API key is not set in the environment.');
        return res.status(500).json({ success: false, message: 'Server configuration error: Heroku API key is missing.' });
    }

    try {
        await herokuApi.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        // If Heroku API call succeeds, the name is taken.
        res.json({ available: false });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            // A 404 error means the app name is available.
            res.json({ available: true });
        } else if (e.response && e.response.status === 403) {
            // Handle 403 Forbidden specifically
            console.error(`[MiniApp] Heroku API error checking app name: Permission denied (403). Check HEROKU_API_KEY.`);
            res.status(403).json({ success: false, message: 'API permission denied. Please contact support.' });
        } else {
            // Other errors (e.g., network issues)
            console.error(`[MiniApp] Heroku API error checking app name: ${e.message}`);
            res.status(500).json({ success: false, message: 'Could not check app name due to a server error.' });
        }
    }
});


app.get('/api/bots', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    try {
        // New Logic: Get the bot list directly from the database
        const botsResult = await pool.query(
            `SELECT 
                ub.bot_name, 
                ub.bot_type,
                ub.status,
                ud.expiration_date
            FROM user_bots ub
            LEFT JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
            WHERE ub.user_id = $1 AND (ud.deleted_from_heroku_at IS NULL OR ub.status = 'online')`,
            [userId]
        );

        const bots = botsResult.rows;

        // Log the number of bots found for debugging
        console.log(`[MiniApp V2] Found ${bots.length} bots in the database for user ${userId}.`);

        // The bot status is now fetched from the database, making this much more reliable
        const formattedBots = bots.map(bot => {
            let statusText = bot.status;
            if (bot.status === 'online') statusText = 'Online';
            if (bot.status === 'logged_out') statusText = 'Offline';

            return {
                appName: bot.bot_name,
                botType: bot.bot_type,
                expirationDate: bot.expiration_date,
                status: statusText,
            };
        });

        // Filter out any bots that were found but have a deleted status
        const filteredBots = formattedBots.filter(b => b.status !== 'Deleted');
        
        res.json({ success: true, bots: filteredBots });
    } catch (e) {
        console.error('[MiniApp V2] Error fetching user bots:', e.message);
        res.status(500).json({ success: false, message: 'Failed to fetch bot list.' });
    }
});




app.post('/api/bots/restart', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.body;
    try {
        const ownerCheck = await pool.query('SELECT user_id FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        await herokuApi.delete(`https://api.heroku.com/apps/${appName}/dynos`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        res.json({ success: true, message: 'Bot restart initiated.' });
    } catch (e) {
        console.error(`[MiniApp V2] Error restarting bot ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to restart bot.' });
    }
});


  // GET /api/check-deploy-key/:key - Check if a key is valid without consuming its use.
app.get('/api/check-deploy-key/:key', validateWebAppInitData, async (req, res) => {
    const { key } = req.params;
    if (!key) {
        return res.status(400).json({ valid: false, message: 'No key provided.' });
    }

    try {
        const result = await pool.query(
            'SELECT uses_left FROM deploy_keys WHERE key = $1 AND uses_left > 0',
            [key.toUpperCase()]
        );

        if (result.rows.length > 0) {
            res.json({ valid: true, message: 'Key is valid.' });
        } else {
            res.json({ valid: false, message: 'Invalid or expired key.' });
        }
    } catch (error) {
        console.error('Error checking deploy key:', error.message);
        res.status(500).json({ valid: false, message: 'Internal server error.' });
    }
});


// GET /api/bots/logs - Get a bot's logs
app.get('/api/bots/logs/:appName', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.params;
    try {
        const ownerCheck = await pool.query('SELECT user_id FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        
        const logSessionRes = await herokuApi.post(`https://api.heroku.com/apps/${appName}/log-sessions`, { tail: false, lines: 100 }, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const logsRes = await axios.get(logSessionRes.data.logplex_url);
        res.json({ success: true, logs: logsRes.data });
    } catch (e) {
        console.error(`[MiniApp V2] Error fetching logs for ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to get logs.' });
    }
});

// POST /api/bots/redeploy - Redeploy a bot
app.post('/api/bots/redeploy', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.body;
    try {
        const ownerCheck = await pool.query('SELECT user_id, bot_type FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }

        const botType = ownerCheck.rows[0].bot_type;
        const repoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
        
        await herokuApi.post(
            `https://api.heroku.com/apps/${appName}/builds`,
            { source_blob: { url: `${repoUrl}/tarball/main` } },
            {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3',
                    'Content-Type': 'application/json'
                }
            }
        );
        res.json({ success: true, message: 'Redeployment initiated.' });
    } catch (e) {
        console.error(`[MiniApp V2] Error redeploying bot ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to redeploy.' });
    }
});

// POST /api/bots/set-session - Set a new session ID
app.post('/api/bots/set-session', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName, sessionId } = req.body;
    try {
        const ownerCheck = await pool.query('SELECT user_id, bot_type FROM user_deployments WHERE app_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        
        const botType = ownerCheck.rows[0].bot_type;
        const isValid = (botType === 'raganork' && sessionId.startsWith(RAGANORK_SESSION_PREFIX)) ||
                        (botType === 'levanter' && sessionId.startsWith(LEVANTER_SESSION_PREFIX));
        if (!isValid) {
            return res.status(400).json({ success: false, message: `Invalid session ID format for ${botType}.` });
        }

        await herokuApi.patch(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { SESSION_ID: sessionId },
            {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' }
            }
        );
        res.json({ success: true, message: 'Session ID updated successfully.' });
    } catch (e) {
        console.error(`[MiniApp V2] Error setting session ID for ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to update session ID.' });
    }
});


  // GET /api/bots/config-vars/:appName - Gets editable config vars for a bot
app.get('/api/bots/config-vars/:appName', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.params;
    try {
        const ownerCheck = await pool.query('SELECT user_id, bot_type FROM user_bots WHERE bot_name = $1 AND user_id = $2', [appName, userId]);
        if (ownerCheck.rows.length === 0) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        const botType = ownerCheck.rows[0].bot_type;

        const configRes = await herokuApi.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        
        // Define which variables are relevant for each bot type
        const commonVars = ['SESSION_ID', 'ALWAYS_ONLINE', 'ANTI_DELETE', 'SUDO'];
        const raganorkVars = ['AUTO_READ_STATUS', 'HANDLERS'];
        const levanterVars = ['AUTO_STATUS_VIEW', 'PREFIX'];
        
        const relevantVarKeys = botType === 'raganork' 
            ? [...commonVars, ...raganorkVars]
            : [...commonVars, ...levanterVars];

        const relevantVars = {};
        for (const key of relevantVarKeys) {
            relevantVars[key] = configRes.data[key] || 'Not Set';
        }

        res.json({ success: true, configVars: relevantVars, botType: botType });
    } catch (e) {
        console.error(`[MiniApp V2] Error fetching config vars for ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to get bot settings.' });
    }
});

// GET /api/app-name-check/:appName - Check if an app name is available
app.get('/api/check-app-name/:appName', validateWebAppInitData, async (req, res) => {
    const { appName } = req.params;

    // Check if the key is available before making the request
    if (!HEROKU_API_KEY) {
        console.error('[MiniApp] Heroku API key is not set in the environment.');
        return res.status(500).json({ success: false, message: 'Server configuration error: Heroku API key is missing.' });
    }

    try {
        await herokuApi.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        // If Heroku API call succeeds, the name is taken.
        res.json({ available: false });
    } catch (e) {
        if (e.response && e.response.status === 404) {
            // A 404 error means the app name is available.
            res.json({ available: true });
        } else if (e.response && e.response.status === 403) {
            // Handle 403 Forbidden specifically
            console.error(`[MiniApp] Heroku API error checking app name: Permission denied (403). Check HEROKU_API_KEY.`);
            res.status(403).json({ success: false, message: 'API permission denied. Please contact support.' });
        } else {
            // Other errors (e.g., network issues)
            console.error(`[MiniApp] Heroku API error checking app name: ${e.message}`);
            res.status(500).json({ success: false, message: 'Could not check app name due to a server error.' });
        }
    }
});


    app.post('/api/deploy', validateWebAppInitData, async (req, res) => {
    const { botType, appName, sessionId, autoStatusView, deployKey, isFreeTrial } = req.body;
    const userId = req.telegramData.id.toString();

    // 1. Initial validation
    if (!userId || !botType || !appName || !sessionId) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const pendingPaymentResult = await pool.query(
        'SELECT reference FROM pending_payments WHERE user_id = $1 AND app_name = $2',
        [userId, appName]
    );
    if (pendingPaymentResult.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'A payment is already pending for this app. Please complete it.' });
    }

    const isSessionIdValid = (botType === 'raganork' && sessionId.startsWith(RAGANORK_SESSION_PREFIX) && sessionId.length >= 10) ||
        (botType === 'levanter' && sessionId.startsWith(LEVANTER_SESSION_PREFIX) && sessionId.length >= 10);
    
    if (!isSessionIdValid) {
        return res.status(400).json({ success: false, message: `Invalid session ID format for bot type "${botType}".` });
    }

    // 2. Map autoStatusView to correct Heroku variable
    let herokuAutoStatusView = '';
    if (botType === 'levanter' && autoStatusView === 'yes') {
        herokuAutoStatusView = 'no-dl';
    } else if (botType === 'raganork' && autoStatusView === 'yes') {
        herokuAutoStatusView = 'true';
    } else {
        herokuAutoStatusView = 'false';
    }

    const deployVars = {
        SESSION_ID: sessionId,
        APP_NAME: appName,
        AUTO_STATUS_VIEW: herokuAutoStatusView
    };

    let deploymentMessage = '';

    try {
        if (isFreeTrial) {
            const check = await dbServices.canDeployFreeTrial(userId);
            if (!check.can) {
                return res.status(400).json({ success: false, message: `You have already used your Free Trial. You can use it again after: ${check.cooldown.toLocaleString()}.` });
            }
            deploymentMessage = 'Free Trial deployment initiated. Check the bot chat for updates!';
        } else if (deployKey) {
            const usesLeft = await dbServices.useDeployKey(deployKey, userId);
            if (usesLeft === null) {
                return res.status(400).json({ success: false, message: 'Invalid or expired deploy key.' });
            }
            deploymentMessage = 'Deployment initiated with key. Check the bot chat for updates!';
            
            // Admin notification logic here
            const userChat = await bot.getChat(userId);
            const userName = userChat.username ? `@${userChat.username}` : `${userChat.first_name || 'N/A'}`;
            await bot.sendMessage(ADMIN_ID,
                `*New App Deployed (Mini App)*\n` +
                `*User:* ${escapeMarkdown(userName)} (\`${userId}\`)\n` +
                `*App Name:* \`${appName}\`\n` +
                `*Key Used:* \`${deployKey}\`\n` +
                `*Uses Left:* ${usesLeft}`,
                { parse_mode: 'Markdown' }
            );
        }
        
        // This is a CRITICAL fix. The build process should be awaited.
        // It's also important to add the bot to the database before the build, so the monitor can find it.
        await dbServices.addUserBot(userId, appName, sessionId, botType);
        
        // This promise will resolve when the build is complete.
        // The `buildWithProgress` function must be refactored to return a promise that resolves on success.
        const buildPromise = dbServices.buildWithProgress(userId, deployVars, isFreeTrial, false, botType);
        
        // We do NOT await here to avoid a long timeout for the HTTP request.
        // Instead, the frontend gets an immediate success response, and the bot will send a message to the user later when the build is done.
        
        // Notify the user that the process has started
        await bot.sendMessage(userId, 
            `Deployment of your *${escapeMarkdown(appName)}* bot has started via the Mini App.\n\n` +
            `You will receive a notification here when the bot is ready.`, 
            { parse_mode: 'Markdown' });

        // Finally, send the success response to the Mini App
        res.json({ success: true, message: deploymentMessage });

    } catch (e) {
        console.error('[MiniApp Server] Deployment error:', e);
        res.status(500).json({ success: false, message: e.message || 'An unknown error occurred during deployment.' });
    }
});
  
  // bot.js (Around Line 1628)

app.post('/pre-verify-user', validateWebAppInitData, async (req, res) => {
    try {
        const userId = req.telegramData.id.toString();
        const country = req.body.country || 'NG';
        const ipAddress = req.body.ip_address || req.socket.remoteAddress;
        const city = req.body.city || 'Unknown';

        console.log(`[Pre-Verify] User ${userId} | IP: ${ipAddress} | Country: ${country} | City: ${city}`);

        // Block India and Pakistan ONLY
        if (country === 'IN' || country === 'PK') {
            console.warn(`[Pre-Verify] User ${userId} blocked from: ${country}`);
            return res.json({ success: false, message: 'Service not available in your country.' });
        }

        // Save verification data to database
        try {
            await pool.query(
                `INSERT INTO pre_verified_users (user_id, ip_address, city) 
                 VALUES ($1, $2, $3) 
                 ON CONFLICT (user_id) DO UPDATE 
                 SET ip_address = $2, city = $3, verified_at = NOW()`,
                [userId, ipAddress, city]
            );
            console.log(`[Pre-Verify] ✅ User ${userId} passed verification - data saved`);
        } catch (dbErr) {
            console.warn('[Pre-Verify] DB error:', dbErr.message);
            // Don't fail - still approve the verification
        }

        return res.json({ success: true, message: 'Verified!', userId: userId, verified: true });

    } catch (error) {
        console.error("Error in /pre-verify-user:", error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});


app.post('/nowpayments-webhook', express.json(), async (req, res) => {
    
    // 1. Verify the signature
    const hmac = crypto.createHmac('sha512', process.env.NOWPAYMENTS_IPN_SECRET);
    hmac.update(JSON.stringify(req.body, Object.keys(req.body).sort()));
    const signature = hmac.digest('hex');

    if (req.headers['x-nowpayments-sig'] !== signature) {
        console.warn('[NOWPayments] Invalid IPN signature received. Ignoring.');
        return res.status(401).send('Invalid signature');
    }

    // 2. Process the payment
    const { payment_status, order_id, price_amount, pay_amount, pay_currency } = req.body;
    console.log(`[NOWPayments] Webhook received for order: ${order_id}, Status: ${payment_status}`);

    if (payment_status === 'finished') {
        try {
            // 3. Find the pending payment
            const pendingPayment = await pool.query(
                'SELECT * FROM pending_payments WHERE reference = $1', 
                [order_id]
            );

            if (pendingPayment.rows.length === 0) {
                console.warn(`[NOWPayments] Webhook for ${order_id} received, but no pending payment found.`);
                return res.status(200).send('OK');
            }
            
            const payment = pendingPayment.rows[0];
            const userId = payment.user_id;

            // 4. Check if it's a renewal or new deploy
            const isRenewal = payment.bot_type === 'renewal';
            
            // 5. Calculate days based on USD amount
            let days;
            if (price_amount >= 5.0) days = 365;
            else if (price_amount >= 3.0) days = 185;
            else if (price_amount >= 1.5) days = 92;
            else if (price_amount >= 0.8) days = 45;
            else days = 10;
            
            // --- 💡 FIX: Calculate Kobo for storage ---
            const rate = parseInt(process.env.DOLLAR_RATE || '1500', 10);
            const amount_kobo = Math.ceil(price_amount * rate * 100);
            
            const userChat = await bot.getChat(userId);
            const userName = userChat.username ? `@${escapeMarkdown(userChat.username)}` : `${escapeMarkdown(userChat.first_name || '')}`;
            
            // Check if already processed
            const checkProcessed = await pool.query('SELECT reference FROM completed_payments WHERE reference = $1', [order_id]);
            if (checkProcessed.rows.length > 0) return res.status(200).send('OK');

            // --- 💡 FIX: Save amount_kobo ---
            await pool.query(
                `INSERT INTO completed_payments (reference, user_id, email, amount, currency, paid_at) VALUES ($1, $2, $3, $4, $5, NOW())`,
                [order_id, userId, payment.email, amount_kobo, pay_currency.toUpperCase()]
            );

            if (isRenewal) {
                // --- RENEWAL LOGIC ---
                const appName = payment.app_name;
                await pool.query(
                    `UPDATE user_deployments SET expiration_date = CASE WHEN expiration_date IS NULL OR expiration_date < NOW() THEN NOW() + ($1 * INTERVAL '1 day') ELSE expiration_date + ($1 * INTERVAL '1 day') END WHERE user_id = $2 AND app_name = $3`,
                    [days, userId, appName]
                );
                await bot.sendMessage(userId, `Payment confirmed! \n\nYour bot *${escapeMarkdown(appName)}* has been renewed for **${days} days** with ${pay_amount} ${pay_currency.toUpperCase()}.`, { parse_mode: 'Markdown' });
                await bot.sendMessage(ADMIN_ID, `*Bot Renewed (Crypto)!*\n\n*User:* ${userName} (\`${userId}\`)\n*Bot:* \`${appName}\`\n*Amount:* $${price_amount} USD`, { parse_mode: 'Markdown' });
            
            } else { 
                // --- NEW DEPLOYMENT LOGIC ---
                await bot.sendMessage(userId, `Crypto payment confirmed! Your bot *${payment.app_name}* deployment has started.`, { parse_mode: 'Markdown' });
                const deployVars = { SESSION_ID: payment.session_id, APP_NAME: payment.app_name, DAYS: days }; 
                dbServices.buildWithProgress(userId, deployVars, false, false, payment.bot_type);
                await bot.sendMessage(ADMIN_ID, `*New App Deployed (Crypto)!*\n\n*User:* ${userName} (\`${userId}\`)\n*App Name:* \`${payment.app_name}\`\n*Amount:* $${price_amount} USD`, { parse_mode: 'Markdown' });
            }
            
            // 6. Clean up pending payment
            await pool.query('DELETE FROM pending_payments WHERE reference = $1', [order_id]);
            
        } catch (dbError) {
            console.error('[NOWPayments Webhook] DB Error:', dbError);
            await bot.sendMessage(ADMIN_ID, `CRITICAL NOWPAYMENTS WEBHOOK ERROR for ref ${order_id}. Manual review needed. Error: ${dbError.message}`);
        }
    }
    
    res.status(200).send('OK');
});


// POST /api/bots/delete - Deletes a bot from Heroku and the database
app.post('/api/bots/delete', validateWebAppInitData, async (req, res) => {
    const userId = req.telegramData.id.toString();
    const { appName } = req.body;
    console.log(`[API /bots/delete] User ${userId} initiated deletion for '${appName}'.`);
    
    try {
        // First, verify the user actually owns this bot to prevent unauthorized deletions
        const ownerCheck = await pool.query('SELECT user_id FROM user_deployments WHERE app_name = $1 AND user_id = $2', [appName, userId]);
        if (ownerCheck.rows.length === 0) {
            console.warn(`[API /bots/delete] Auth Failure: User ${userId} does not own '${appName}'.`);
            return res.status(403).json({ success: false, message: 'Authorization Failed: You are not the owner of this bot.' });
        }
        
        console.log(`[API /bots/delete] Ownership confirmed. Deleting '${appName}' from Heroku...`);
        // 1. Send the delete request to the Heroku API
        await herokuApi.delete(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        console.log(`[API /bots/delete] Heroku deletion successful for '${appName}'.`);

        // 2. Clean up all records from your local databases
        console.log(`[API /bots/delete] Cleaning up database records for '${appName}'.`);
        await dbServices.deleteUserBot(userId, appName);
        await dbServices.markDeploymentDeletedFromHeroku(userId, appName);
        console.log(`[API /bots/delete] Database cleanup complete for '${appName}'.`);

        res.json({ success: true, message: `Bot '${appName}' has been successfully and permanently deleted.` });

    } catch (e) {
        // This handles cases where the bot was already deleted on Heroku but still in your DB
        if (e.response && e.response.status === 404) {
            console.log(`[API /bots/delete] Bot '${appName}' not found on Heroku. Cleaning up DB records anyway.`);
            await dbServices.deleteUserBot(userId, appName);
            await dbServices.markDeploymentDeletedFromHeroku(userId, appName);
            return res.json({ success: true, message: `Bot '${appName}' was already deleted from the server. Your list has been updated.` });
        }
        // Handle other potential errors (API keys, network, etc.)
        console.error(`[API /bots/delete] CRITICAL ERROR deleting bot '${appName}':`, e.response?.data || e.message);
        res.status(500).json({ success: false, message: 'A server error occurred. Failed to delete the bot.' });
    }
});





// POST /api/bots/set-var - Updates a single config variable for a bot
app.post('/api/bots/set-var', validateWebAppInitData, async (req, res) => {
    const { appName, varName, varValue } = req.body;
    const userId = req.telegramData.id.toString();
    try {
        const ownerCheck = await pool.query('SELECT user_id FROM user_bots WHERE bot_name = $1', [appName]);
        if (ownerCheck.rows.length === 0 || ownerCheck.rows[0].user_id !== userId) {
            return res.status(403).json({ success: false, message: 'You do not own this bot.' });
        }
        await herokuApi.patch(`https://api.heroku.com/apps/${appName}/config-vars`, { [varName]: varValue }, {
            headers: {
                Authorization: `Bearer ${HEROKU_API_KEY}`,
                Accept: 'application/vnd.heroku+json; version=3',
                'Content-Type': 'application/json'
            }
        });
        res.json({ success: true, message: `Variable ${varName} updated successfully. Restarting bot...` });
    } catch (e) {
        console.error(`[MiniApp V2] Error setting variable ${varName} for ${appName}:`, e.message);
        res.status(500).json({ success: false, message: 'Failed to set variable.' });
    }
});


app.post('/api/pay', validateWebAppInitData, async (req, res) => {
    const { botType, appName, sessionId, autoStatusView, email } = req.body;
    const userId = req.telegramData.id;
    const KEY_PRICE_NGN = parseInt(process.env.KEY_PRICE_NGN, 10) || 1500;
    const priceInKobo = KEY_PRICE_NGN * 100;
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

    if (!userId || !botType || !appName || !sessionId || !email) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const reference = crypto.randomBytes(16).toString('hex');
        
        // Use metadata to store key information for the webhook
        const metaData = {
            user_id: userId,
            bot_type: botType,
            app_name: appName,
            session_id: sessionId,
            auto_status_view: autoStatusView
        };

        // Insert into pending_payments with a 'pending' status
        await client.query(
            `INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [reference, userId, email, botType, appName, sessionId, 'pending']
        );

        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email,
                amount: priceInKobo,
                reference,
                metadata: metaData,
                // A generic callback URL is fine as the webhook is the source of truth
                callback_url: `https://t.me/${process.env.BOT_USERNAME}`
            },
            { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            paymentUrl: paystackResponse.data.data.authorization_url,
            reference: reference
        });

    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Paystack transaction initialization error:', e.response?.data || e.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to create payment link. Please try again.',
            error: e.response?.data || e.message
        });
    } finally {
        client.release();
    }
});



app.get('/api/news', validateWebAppInitData, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT title, content, created_at FROM bot_news WHERE expires_at > NOW() ORDER BY created_at DESC LIMIT 5"
        );
        res.json({ success: true, news: result.rows });
    } catch (e) {
        console.error("[API News] Error:", e.message);
        res.status(500).json({ success: false, message: "Could not fetch news." });
    }
});

// In bot.js (REPLACE the Flutterwave webhook)



app.post('/api/levanter-callback', async (req, res) => {
    // The external service must POST: { status, number, code, sessionId, error }
    const { status, number, code, sessionId, error } = req.body;
    res.sendStatus(200); // Instantly reply to prevent timeouts

    const requestData = global.levanterPairingRequests.get(number);
    if (!requestData) return;

    const { cid, messageId, intervalId } = requestData;

    try {
        if (status === 'pairing_code') {
            // Update the base text of the loading clock to show the code while it continues spinning
            requestData.baseText = `**Pairing Code Ready!**\n\n\`${code}\`\n\nTap to copy and paste it into WhatsApp. Still waiting for session ID...`;
        } 
        else if (status === 'session_id') {
            // Stop the clock and deliver the session ID
            clearInterval(intervalId);
            global.levanterPairingRequests.delete(number);
            await bot.editMessageText(
                `**Session ID Generated!**\n\n\`${sessionId}\`\n\nCopy.`, 
                { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' }
            );
        } 
        else if (status === 'error') {
            // Stop the clock and show the error with the Levanter URL button
            clearInterval(intervalId);
            global.levanterPairingRequests.delete(number);
            await bot.editMessageText(
                `Automated pairing failed.\nReason: ${error}\n\nPlease generate your session manually.`, 
                {
                    chat_id: cid,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Get Session Manually', url: LEVANTER_SESSION_SITE_URL }]]
                    }
                }
            );
        }
    } catch (e) {
        console.error('[Webhook] Failed to update user:', e.message);
    }
});


app.post('/flutterwave/webhook', async (req, res) => {
    // 1. Verify the signature (Security)
    const signature = req.headers['verif-hash'];
    if (!signature || (signature !== process.env.FLUTTERWAVE_SECRET_HASH)) {
        console.warn('[Flutterwave] Invalid IPN signature received. Ignoring.');
        return res.status(401).end();
    }

    const payload = req.body;
    console.log('[Flutterwave] Webhook received:', payload.event);

    // 2. Only process successful charge completions
    if (payload.event === 'charge.completed' && payload.data.status === 'successful') {
        
        const reference = payload.data.tx_ref;
        const amount_ngn = payload.data.amount; // Amount is in NGN
        const customer = payload.data.customer;
        
        // 3. Find the pending payment to get necessary context
        const pendingPayment = await pool.query(
            'SELECT user_id, bot_type, app_name, session_id, email FROM pending_payments WHERE reference = $1', 
            [reference]
        );
        
        if (pendingPayment.rows.length === 0) {
            console.warn(`[Flutterwave Webhook] Cannot process reference ${reference}. Details missing in pending_payments.`);
            return res.status(200).end(); 
        }

        const { 
            user_id: userId, 
            bot_type, 
            app_name, 
            session_id, 
            email: pendingEmail 
        } = pendingPayment.rows[0];

        // Determine the intent flags
        const isGroupFiller = bot_type === 'group_filler';
        const isSwitch = bot_type && bot_type.startsWith('switch-'); 
        const isRenewal = bot_type === 'renewal';
        
        // --- 💡 DYNAMIC DURATION LOGIC 💡 ---
        // Convert NGN to USD to determine the correct plan duration
        const currentRate = parseInt(process.env.DOLLAR_RATE || '1500', 10);
        const amountPaidUsd = amount_ngn / currentRate;

        let days;
        if (amountPaidUsd >= 5.0) {
            days = 365; // Annual ($5.35)
        } else if (amountPaidUsd >= 3.0) {
            days = 185; // Semi-Annual ($3.35)
        } else if (amountPaidUsd >= 1.5) {
            days = 92;  // Quarterly ($2.00)
        } else if (amountPaidUsd >= 0.8) {
            days = 45;  // Standard ($1.00)
        } else {
            days = 10;  // Basic ($0.35)
        }

        console.log(`[Payment Logic] NGN: ${amount_ngn} | Rate: ${currentRate} | USD: $${amountPaidUsd.toFixed(2)} | Result: ${days} days`);

        try {
            // 4. Check if already processed (Idempotency)
            const checkProcessed = await pool.query('SELECT reference FROM completed_payments WHERE reference = $1', [reference]);
            if (checkProcessed.rows.length > 0) return res.status(200).end();
            
            // Convert amount from NGN to Kobo (multiply by 100)
            const amountInKobo = amount_ngn * 100;
            const finalEmail = customer.email || pendingEmail || 'flutterwave_user@email.com';
            
            // Log the completed payment
            await pool.query(
                `INSERT INTO completed_payments (reference, user_id, email, amount, currency, paid_at) VALUES ($1, $2, $3, $4, 'NGN', NOW())`,
                [reference, userId, finalEmail, amountInKobo]
            );

            // Notify user of confirmation and admin of sale
            const userChat = await bot.getChat(userId);
            const userName = userChat.username ? `@${escapeMarkdown(userChat.username)}` : `${escapeMarkdown(userChat.first_name || '')}`;

            // Send internal payment confirmation email
            await sendPaymentConfirmation(finalEmail, `User ${userId}`, reference, app_name || 'N/A', bot_type || 'N/A', session_id || 'N/A');


            // --- 5. EXECUTION LOGIC (Ordered by Intent) ---

            if (isGroupFiller) {
                const link = session_id; 
                const members = parseInt(app_name, 10); 
                
                await bot.sendMessage(userId, `**Payment Confirmed!** The job to add **${members} members** to your group has started. Hold on...`, { parse_mode: 'Markdown' });
                
                try {
                     const fillResponse = await axios.post(
                         `${process.env.GROUP_FILLER_API_URL}/api/join`, 
                         {
                             apiKey: process.env.GROUP_FILLER_API_SECRET,
                             amount: members,
                             link: link
                         },
                         { timeout: 300000 }
                     );

                     const responseData = fillResponse.data;
                     const finalMessage = `**Job Status Update** (Link: ${link})\n\n` +
                                          `Requested Members: ${responseData.data.requested}\n` +
                                          `Successfully Joined: ${responseData.data.success}\n` +
                                          `Already in Group: ${responseData.data.already_in}\n` +
                                          `Failed to Join: ${responseData.data.failed}`;

                     await bot.sendMessage(userId, finalMessage, { parse_mode: 'Markdown' });
                     await bot.sendMessage(ADMIN_ID, `[GROUP FILLER] Job complete for user ${userId}. Success: ${responseData.data.success}.`, { parse_mode: 'Markdown' });

                } catch (error) {
                     const errMsg = error.message || error.response?.data?.message || 'API connection failed';
                     await bot.sendMessage(userId, `**Group Filler Failed:** The external service could not start the job.\nReason: ${errMsg}`);
                     await bot.sendMessage(ADMIN_ID, `[GROUP FILLER] CRITICAL API Failure for ${userId}: ${errMsg}`, { parse_mode: 'Markdown' });
                }
                
            } else if (isRenewal) {
                await pool.query(
                    `UPDATE user_deployments 
                     SET expiration_date = 
                        CASE 
                           WHEN expiration_date IS NULL OR expiration_date < NOW() THEN NOW() + ($1 * INTERVAL '1 day')
                           ELSE expiration_date + ($1 * INTERVAL '1 day')
                        END
                     WHERE user_id = $2 AND app_name = $3`,
                    [days, userId, app_name]
                );

                await bot.sendMessage(userId, `Payment confirmed! *${escapeMarkdown(app_name)}* has been successfully **renewed** for ${days} days.`, { parse_mode: 'Markdown' });
            
            } else if (isSwitch) {
                await bot.sendMessage(userId, 'Payment confirmed! Processing your bot migration now...', { parse_mode: 'Markdown' });
                const targetType = bot_type.replace('switch-', '');
                await dbServices.processBotSwitch(userId, app_name, targetType, session_id);
                await bot.sendMessage(ADMIN_ID, `*Bot Switch Paid (Flutterwave)*\nUser: \`${userId}\`\nApp: \`${app_name}\`\nTo: ${targetType.toUpperCase()}`, { parse_mode: 'Markdown' });

            } else { 
                await bot.sendMessage(userId, 'Payment confirmed! Your bot deployment has started.', { parse_mode: 'Markdown' });
                const deployVars = { SESSION_ID: session_id, APP_NAME: app_name, DAYS: days }; 
                
                dbServices.buildWithProgress(userId, deployVars, false, false, bot_type);
                await bot.sendMessage(ADMIN_ID, `*New App Deployed (Flutterwave)!*\n\nUser: ${userName}\nApp Name: \`${app_name}\`\nAmount: ₦${amount_ngn}`, { parse_mode: 'Markdown' });
            }
            
            // 6. Clean up pending payment
            await pool.query('DELETE FROM pending_payments WHERE reference = $1', [reference]);
            
            // Clear Awaiting Key state if it exists
            if (userStates[userId]) delete userStates[userId];

        } catch (dbError) {
            console.error('[Flutterwave Webhook] DB Error:', dbError);
            await bot.sendMessage(ADMIN_ID, `CRITICAL FLUTTERWAVE WEBHOOK ERROR for ref ${reference}. Manual review needed. Error: ${dbError.message}`);
        }
    }
    res.status(200).end();
});




    // At the top of your file, ensure 'crypto' is required
const crypto = require('crypto');

// bot.js (Replace the entire app.post('/paystack/webhook', ...) block)

app.post('/paystack/webhook', express.json(), async (req, res) => {
    // 1. Verify the Paystack signature to ensure the request is legitimate
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
        .update(JSON.stringify(req.body))
        .digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
        console.warn('Invalid Paystack signature received.');
        return res.sendStatus(401); // Unauthorized
    }

    const event = req.body;

    // 2. Only process successful payments
    if (event.event === 'charge.success') {
        const { reference, metadata, amount, currency, customer } = event.data;
        const userId = metadata.user_id; // Get the user ID from the metadata
        const days = metadata.days; // Retrieve the 'days' from metadata

        try {
            // Check if this payment has already been processed to prevent duplicates
            const checkProcessed = await pool.query('SELECT reference FROM completed_payments WHERE reference = $1', [reference]);
            if (checkProcessed.rows.length > 0) {
                console.log(`Webhook for reference ${reference} already processed. Ignoring.`);
                return res.sendStatus(200);
            }

            // 3. Process the payment and insert into completed_payments
            await pool.query(
                `INSERT INTO completed_payments (reference, user_id, email, amount, currency, paid_at) VALUES ($1, $2, $3, $4, $5, $6)`,
                [reference, userId, customer.email, amount, currency, event.data.paid_at]
            );

          await sendPaymentConfirmation(customer.email, `User ${userId}`, reference, metadata.appName || 'N/A', metadata.botType || 'N/A', 'N/A');

            const userChat = await bot.getChat(userId);
            const userName = userChat.username ? `@${userChat.username}` : `${userChat.first_name || ''}`;
            
            // --- START OF FIX: RENEWAL/DEPLOYMENT LOGIC ---
            if (metadata.product === 'Bot Renewal') {
                const { appName } = metadata;

                // 🚨 FIX: Add days to the expiration date. Use CASE WHEN to handle past expiration.
                await pool.query(
                    `UPDATE user_deployments 
                     SET expiration_date = 
                        CASE 
                           WHEN expiration_date IS NULL OR expiration_date < NOW() THEN NOW() + ($1 * INTERVAL '1 day')
                           ELSE expiration_date + ($1 * INTERVAL '1 day')
                        END
                     WHERE user_id = $2 AND app_name = $3`,
                    [days, userId, appName]
                );

                await bot.sendMessage(userId, `Payment confirmed! \n\nYour bot *${escapeMarkdown(appName)}* has been successfully renewed for **${days} days**.`, { parse_mode: 'Markdown' });
                await bot.sendMessage(ADMIN_ID, `*Bot Renewed (Paystack)!*\n\n*User:* ${escapeMarkdown(userName)} (\`${userId}\`)\n*Bot:* \`${appName}\`\n*Duration:* ${days} days`, { parse_mode: 'Markdown' });

            } else if (metadata.product !== 'temporary_number') { // This handles new deployments
                // This logic still relies on pending_payments, which is correct for *new* deploys.
                const pendingPayment = await pool.query('SELECT bot_type, app_name, session_id FROM pending_payments WHERE reference = $1', [reference]);
                
                if (pendingPayment.rows.length === 0) {
                     console.warn(`Pending deployment payment not found for reference: ${reference}.`);
                     // We already logged the payment, so just return OK.
                     return res.sendStatus(200);
                }
                const { bot_type, app_name, session_id } = pendingPayment.rows[0];

                await bot.sendMessage(userId, `Payment confirmed! Your bot deployment has started.`, { parse_mode: 'Markdown' });
                const deployVars = { SESSION_ID: session_id, APP_NAME: app_name, DAYS: days };
                dbServices.buildWithProgress(userId, deployVars, false, false, bot_type);
                await bot.sendMessage(ADMIN_ID, `*New App Deployed (Paid)*\n\n*User:* ${escapeMarkdown(userName)} (\`${userId}\`)\n*App Name:* \`${app_name}\``, { parse_mode: 'Markdown' });

                await pool.query('DELETE FROM pending_payments WHERE reference = $1', [reference]);
            }
            // --- END OF FIX: RENEWAL/DEPLOYMENT LOGIC ---
            
            console.log(`Successfully processed payment for reference: ${reference}`);

        } catch (dbError) {
            console.error(`Webhook DB Error for reference ${reference}:`, dbError);
            await bot.sendMessage(ADMIN_ID, `⚠️ CRITICAL: Webhook processing failed for reference ${reference}. Manual intervention required.`);
            return res.sendStatus(500);
        }
    }
    res.sendStatus(200);
});





    // This GET handler is for users who visit the webhook URL in a browser
    app.get('/paystack/webhook', (req, res) => {
        res.status(200).send('<h1>Webhook URL</h1><p>Please return to the Telegram bot.</p>');
    });

    // This is your separate API endpoint for getting a key
    // In bot.js (REPLACE the '/api/get-key' endpoint)

app.get('/api/get-key', async (req, res) => {
    const providedApiKey = req.headers['x-api-key'];
    const secretApiKey = process.env.INTER_BOT_API_KEY;

    if (!secretApiKey || providedApiKey !== secretApiKey) {
        console.warn('[API] Unauthorized attempt to get a key.');
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // Check if a specific number of uses was requested via URL (e.g. ?uses=5)
    const requestedUses = parseInt(req.query.uses);

    try {
        // --- CASE 1: Admin requested specific uses (Force Create New Key) ---
        if (!isNaN(requestedUses) && requestedUses > 0) {
            const newKey = generateKey();
            // Create specific key with the requested amount
            await pool.query(
                'INSERT INTO deploy_keys (key, uses_left, created_by) VALUES ($1, $2, $3)',
                [newKey, requestedUses, 'WhatsApp API']
            );
            console.log(`[API] Created custom key ${newKey} with ${requestedUses} uses.`);
            return res.json({ success: true, key: newKey, uses: requestedUses });
        }

        // --- CASE 2: Default (Get existing key OR create 1-use key) ---
        // Try to get an existing general key (user_id IS NULL)
        const result = await pool.query(
            'SELECT key FROM deploy_keys WHERE uses_left > 0 AND user_id IS NULL ORDER BY created_at DESC LIMIT 1'
        );

        if (result.rows.length > 0) {
            const key = result.rows[0].key;
            console.log(`[API] Provided existing key ${key}.`);
            return res.json({ success: true, key: key, uses: 'existing' });
        } else {
            // Create a new standard 1-use key
            const newKey = generateKey();
            await pool.query(
                'INSERT INTO deploy_keys (key, uses_left, created_by) VALUES ($1, 1, $2)',
                [newKey, 'WhatsApp API Auto']
            );
            console.log(`[API] Created new standard key ${newKey}.`);
            return res.json({ success: true, key: newKey, uses: 1 });
        }

    } catch (error) {
        console.error('[API] Database error:', error);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});


    // The command to start the server listening for requests
    app.listen(PORT, () => {
        console.log(`[Web Server] Server running on port ${PORT}`);
    });

} else {
    // --- Polling Mode (for local development) ---
    console.log('Bot is running in development mode (polling)...');
    bot.startPolling();
}
}) ();

// 8) Polling error handler
bot.on('polling_error', console.error);

// 9) Command handlers
// Make sure you have your geminiModel initialized somewhere above this code
// const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro" });

bot.onText(/^\/start(?: (.+))?$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const inviterId = match?.[1];

    await dbServices.updateUserActivity(cid);
    const isAdmin = cid === ADMIN_ID;
    delete userStates[cid];
    const { first_name, last_name, username } = msg.from;
    console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}] | IsAdmin: ${isAdmin}`);

    if (inviterId && inviterId !== cid) {
        try {
            await bot.getChat(inviterId);
            await pool.query(
                `INSERT INTO sessions (id, user_id, data, expires_at) 
                 VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')
                 ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`,
                [`referral_session:${cid}`, cid, { inviterId: inviterId }]
            );
            console.log(`[Referral] Stored inviter ID ${inviterId} for new user ${cid}.`);
        } catch (e) {
            console.error(`[Referral] Invalid inviter ID ${inviterId} from user ${cid}:`, e.message);
        }
    }

    if (isAdmin) {
        console.log(`[Admin Start] Admin ${cid} used /start command. Showing admin menu.`);
        await bot.sendMessage(cid, '*Welcome, Admin!*\n\nHere is your admin menu:', {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: buildKeyboard(isAdmin),
                resize_keyboard: true
            }
        });
    } else {
        const userDisplayName = username ? `@${escapeMarkdown(username)}` : escapeMarkdown(first_name || 'User');
        const welcomeVideoUrl = 'https://files.catbox.moe/9gn267.mp4';
        let welcomeCaption;

        // ======================================================
        // --- 🤖 NEW: AI-Generated Welcome Caption Logic ---
        // ======================================================
        try {
            // This prompt tells the AI exactly what to do and what NOT to do.
            const prompt = `You are a friendly and professional assistant for a Telegram Bot Deployment Service.
Generate a short, welcoming caption (2-3 sentences) for a new user.

RULES:
1. The response MUST start with this exact header: "Welcome ${userDisplayName} to our Bot Deployment Service!"
2. After the header, add a creative and encouraging message about deploying bots. Please it should very conciseand short. it'sfor deploying WhatsApp bot.
3. **CRITICAL RULE: Do NOT mention any specific hosting platforms like Heroku, Render, AWS, or any other brand name.** Focus on the ease and power of our generic service.`;

            const result = await geminiModel.generateContent(prompt);
            const response = await result.response;
            welcomeCaption = response.text();

        } catch (error) {
            console.error("Gemini API failed, using a fallback welcome message.", error);
            // This is a safe, static message in case the AI service is down.
            welcomeCaption = `Welcome ${userDisplayName} to our Bot Deployment Service!\n\nYour journey to deploying powerful bots starts here. Let's get your first Bot online in just a few clicks.`;
        }
        // ======================================================
        // --- End of AI Logic ---
        // ======================================================

        const inlineKeyboard = {
            inline_keyboard: [
                [
                    { text: 'Get Session ID', callback_data: 'get_session_start_flow' },
                    { text: 'Deploy Your Bot', callback_data: 'deploy_first_bot' }
                ]
            ]
        };

        const sentMessage = await bot.sendVideo(cid, welcomeVideoUrl, {
            caption: welcomeCaption, // Use the new AI-generated or fallback caption
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: buildKeyboard(false),
                resize_keyboard: true,
                ...inlineKeyboard
            }
        });

        if (sentMessage) {
            try {
                await bot.setMessageReaction(cid, sentMessage.message_id, {
                    reaction: [{ type: 'emoji', emoji: '🎉' }]
                });
            } catch (error) {
                console.error(`Failed to set reaction on message ${sentMessage.message_id}:`, error.message);
            }
        }
    }
});





// Add this with your other admin commands
bot.onText(/^\/dkey$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) {
        return;
    }
    await sendKeyDeletionList(cid);
});

bot.onText(/^\/menu$/i, async msg => {
  const cid = msg.chat.id.toString();
  await dbServices.updateUserActivity(cid);
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid]; // Clear user state
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, async msg => {
  const cid = msg.chat.id.toString();
  await dbServices.updateUserActivity(cid);
  if (cid === ADMIN_ID) {
    dbServices.sendAppList(cid); // Use dbServices
  }
});


bot.onText(/^\/deploymsg$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const appName = `msgbot-${Math.floor(Math.random() * 9000) + 1000}`;
    const statusMsg = await bot.sendMessage(cid, `**Starting Build for ${appName}...**\nProvisioning Postgres database...`, { parse_mode: 'Markdown' });

    try {
        const body = {
            source_blob: {
                // ❗️ FIX: Added .tarball/master so Heroku can download the code
                url: 'https://github.com/Ultar12/MESSAGEBOT/tarball/master'
            },
            app: {
                name: appName,
                region: 'us'
            },
        
            // ❗️ FIX: Specific plan name for the new Heroku billing system
            addons: [
                { plan: "heroku-postgresql" } 
            ]
        };

        const res = await herokuApi.post('/app-setups', body);
        
        await bot.editMessageText(`**Deployment Created!**\n\n**App Name:** \`${appName}\`\n**Status:** Building\n\nTrack progress: https://dashboard.heroku.com/apps/${appName}/activity`, {
            chat_id: cid,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown'
        });

        // Save to DB so it shows up in your lists
        await pool.query(
            "INSERT INTO user_bots (user_id, bot_name, bot_type, status) VALUES ($1, $2, $3, $4)",
            [cid, appName, 'messagebot', 'Building']
        );

    } catch (e) {
        // Detailed error logging to tell us WHY it failed
        const herokuError = e.response?.data?.message || e.message;
        console.error("Deploy Error:", herokuError);
        await bot.editMessageText(`**Deployment Failed**\n\nReason: ${herokuError}`, {
            chat_id: cid,
            message_id: statusMsg.message_id
        });
    }
});


// ADMIN COMMAND: /maintenance
bot.onText(/^\/maintenance (on|off)$/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    await dbServices.updateUserActivity(chatId);
    const status = match[1].toLowerCase();

    if (chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "You are not authorized to use this command.");
    }

    if (status === 'on') {
        isMaintenanceMode = true;
        await saveMaintenanceStatus(true);
        await bot.sendMessage(chatId, "Maintenance mode is now *ON*.", { parse_mode: 'Markdown' });
    } else if (status === 'off') {
        isMaintenanceMode = false;
        await saveMaintenanceStatus(false);
        await bot.sendMessage(chatId, "Maintenance mode is now *OFF*.", { parse_mode: 'Markdown' });
    }
});


// In bot.js

bot.onText(/^\/key (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    
    // 1. Security Check: Admin Only
    if (cid !== ADMIN_ID) return;

    // 2. Parse the number of uses
    const uses = parseInt(match[1], 10);

    if (isNaN(uses) || uses <= 0) {
        return bot.sendMessage(cid, "Please provide a valid number of uses (e.g., `/key 5`).");
    }

    try {
        // 3. Generate and Save
        const newKey = generateKey(); // Uses your existing helper function
        // Passing 'null' as the 4th argument makes it a general key (not tied to specific user)
        await dbServices.addDeployKey(newKey, uses, 'Admin Command', null); 

        // 4. Send Confirmation
        await bot.sendMessage(cid, 
            `**Key Generated!**\n\n` +
            `Key: \`${newKey}\`\n` +
            `Uses: *${uses}*`, 
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error("Error generating key via command:", error);
        await bot.sendMessage(cid, "❌ Failed to generate key. Check logs.");
    }
});


bot.onText(/^\/id$/, async (msg) => {
    const cid = msg.chat.id.toString();
    await dbServices.updateUserActivity(cid);
    const repliedMsg = msg.reply_to_message;

    // --- FIX 1: Safely access the forward_from_chat object ---
    const forwardInfo = repliedMsg?.forward_from_chat;

    // --- Case 1: Reply to a forwarded message from a channel ---
    if (repliedMsg && forwardInfo) {
        
        const channelTitle = escapeMarkdown(forwardInfo.title);
        const channelId = forwardInfo.id; // This is the ID you need

        await bot.sendMessage(cid, `The ID for the channel **${channelTitle}** is:\n\n\`${channelId}\``, { 
            parse_mode: 'Markdown' 
        });

    // --- Case 2: Reply to a regular message (or no forward info found) ---
    } else if (repliedMsg) {
        // This is the error case you were hitting incorrectly
        await bot.sendMessage(cid, "It looks like you replied to a regular message. To get a channel ID, you must **reply to a forwarded message** from that channel.", {
            parse_mode: 'Markdown'
        });

    // --- Case 3: The user did not reply to anything. ---
    } else {
        await bot.sendMessage(cid, `Your Telegram User ID is: \`${cid}\`\n\n*To get a channel ID, please forward a message from the channel here first, then reply to it with /id.*`, { 
            parse_mode: 'Markdown' 
        });
    }
});



// In bot.js (REPLACE this handler)

bot.onText(/^\/changedb (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const target = match[1].trim();
    
    // --- CASE 1: MASS MIGRATION (/changedb all) ---
    if (target.toLowerCase() === 'all') {
        const confirmMsg = await bot.sendMessage(adminId, `⚠️ **Mass Database Migration (AWS Only)**\n\nThis will create a new database for EVERY bot currently on the **AWS Self-Hosted** platform and restart them.\n\nBots on Neon will *not* be affected. Proceed?`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Yes, Migrate AWS Bots', callback_data: 'changedb_confirm_all' }],
                    [{ text: 'No, Cancel', callback_data: 'changedb_cancel' }]
                ]
            }
        });
        return;
    }

    if (target === 'confirm_all') {
        const workingMsg = await bot.sendMessage(adminId, "Starting Mass Database Migration (AWS Bots Only)...");
        
        // --- 💡 FIX: Query for AWS bots only ---
        const allBotsResult = await pool.query(
            "SELECT app_name as bot_name FROM user_deployments WHERE neon_account_id = 'AWS_MAIN'"
        );
        const allBots = allBotsResult.rows;
        
        if (allBots.length === 0) {
            return bot.editMessageText("No bots found on the AWS platform to migrate.", { chat_id: adminId, message_id: workingMsg.message_id });
        }

        let success = 0;
        let failed = 0;
        
        for (const [i, botRow] of allBots.entries()) {
            const appName = botRow.bot_name;
            
            if (i % 5 === 0) {
                await bot.editMessageText(
                    `**Migrating AWS Databases...**\nProgress: ${i}/${allBots.length}\nSuccess: ${success} | Failed: ${failed}\n\nCurrent: \`${appName}\``, 
                    { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
                ).catch(()=>{});
            }

            // Call the helper (dbServices is imported in bot.js)
            const result = await changeBotDatabase(appName);
            
            if (result.success) success++;
            else {
                failed++;
                console.error(`Failed to migrate ${appName}: ${result.message}`);
            }
            
            await new Promise(r => setTimeout(r, 2000));
        }

        await bot.editMessageText(
            `**AWS Migration Complete**\n\nTotal: ${allBots.length}\nSuccess: ${success}\nFailed: ${failed}`, 
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
        return;
    }

    // --- CASE 2: SINGLE APP MIGRATION (/changedb botname) ---
    const appName = target;
    const workingMsg = await bot.sendMessage(adminId, `Changing database for \`${appName}\`...`, { parse_mode: 'Markdown' });

    // Call helper
    const result = await changeBotDatabase(appName);

    if (result.success) {
        await bot.editMessageText(
            `**Success!**\n\nDatabase for \`${appName}\` has been changed.\nNew Location: **${result.account}**\nBot is restarting...`,
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
    } else {
        await bot.editMessageText(
            `**Failed**\n\nReason: ${result.message}`,
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
    }
});


// In bot.js

bot.onText(/^\/vcf (.+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    // Note: Remove this check if you want regular users to use it too.
    if (cid !== ADMIN_ID) return; 

    const countryName = match[1].trim();

    const workingMsg = await bot.sendMessage(cid, `Generating 500 random contacts for *${escapeMarkdown(countryName)}*...`, { parse_mode: 'Markdown' });

    try {
        // Call the service function
        const result = await generateCountryVcf(countryName);

        if (result.success) {
            await bot.deleteMessage(cid, workingMsg.message_id); // Remove "Generating..." msg
            
            await bot.sendDocument(cid, result.buffer, {
                caption: `**Generated Successfully!**\n\n500 Random ${countryName} Numbers.\n📝 Name Format: ${countryName}1 plus data`,
                parse_mode: 'Markdown'
            }, {
                filename: result.fileName,
                contentType: 'text/vcard'
            });
        } else {
            await bot.editMessageText(`**Error:** ${result.message}`, {
                chat_id: cid,
                message_id: workingMsg.message_id
            });
        }
    } catch (error) {
        console.error("Error generating VCF:", error);
        await bot.editMessageText("An error occurred while generating the file.", {
            chat_id: cid,
            message_id: workingMsg.message_id
        });
    }
});




// ADMIN COMMAND: /restartaws (Strict Rebuild Only)
bot.onText(/^\/restartaws$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const apiUrl = process.env.SELF_HOSTED_DB_URL;
    const apiKey = process.env.SELF_HOSTED_DB_SECRET;

    if (!apiUrl || !apiKey) {
        return bot.sendMessage(adminId, "Config Missing: Ensure SELF_HOSTED_DB_URL and SELF_HOSTED_DB_SECRET are set.");
    }

    const workingMsg = await bot.sendMessage(adminId, "🏗️ **Sending Rebuild Signal to AWS...**");

    try {
        const response = await axios.post(`${apiUrl}/rebuild`, {}, {
            headers: { 'x-api-key': apiKey },
            timeout: 60000 
        });

        if (response.data.success) {
            await bot.editMessageText(
                "**AWS Rebuild Successful**\n\nThe EC2 infrastructure is rebuilding.",
                { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
            );
        } else {
            throw new Error(response.data.error || "EC2 failed to initiate rebuild.");
        }

    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        await bot.editMessageText(`**Rebuild Failed**\n\nReason: \`${errorMsg}\``, {
            chat_id: adminId,
            message_id: workingMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
});


// --- Command: /createawsdb <dbname> ---
bot.onText(/^\/createawsdb (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const dbName = match[1].trim();
    
    // Basic validation
    if (!/^[a-z0-9_]+$/.test(dbName)) {
        return bot.sendMessage(adminId, "⚠️ Invalid name. Use lowercase letters, numbers, and underscores only.");
    }

    const workingMsg = await bot.sendMessage(adminId, `Creating database \`${dbName}\` on AWS Self-Hosted Platform...`, { parse_mode: 'Markdown' });

    try {
        // Call the specific AWS function directly
        const result = await createSelfHostedDatabase(dbName);

        if (result.success) {
            await bot.editMessageText(
                `**AWS Database Created!**\n\n` +
                `**Name:** \`${result.db_name}\`\n` +
                `**Connection:** \`${result.connection_string}\``,
                {
                    chat_id: adminId,
                    message_id: workingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        } else {
            await bot.editMessageText(
                `**AWS Creation Failed.**\n\nReason: ${result.error}`,
                {
                    chat_id: adminId,
                    message_id: workingMsg.message_id
                }
            );
        }
    } catch (e) {
        console.error(e);
        await bot.editMessageText(`Error: ${e.message}`, { chat_id: adminId, message_id: workingMsg.message_id });
    }
});


bot.onText(/^\/aa (\d+) (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const targetNumber = match[1];
    const hours = parseInt(match[2], 10);
    const remindAt = new Date(Date.now() + (hours * 60 * 60 * 1000));

    try {
        await pool.query(
            "INSERT INTO reminders (user_id, target_number, remind_at, hours_duration) VALUES ($1, $2, $3, $4)",
            [adminId, targetNumber, remindAt, hours]
        );

        const timeString = remindAt.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
        await bot.sendMessage(adminId, `Timer saved for ${targetNumber}. I will remind you in ${hours} hour(s) (at ${timeString}).`);
        
        // Start a timeout for the current session
        setTimeout(() => sendReminder(targetNumber, adminId, hours), hours * 60 * 60 * 1000);

    } catch (e) {
        console.error("Failed to save reminder:", e);
        await bot.sendMessage(adminId, "Failed to save reminder to database.");
    }
});

bot.onText(/^\/aalist$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    try {
        // This query only gets active timers because sent ones are deleted
        const result = await pool.query("SELECT target_number, remind_at FROM reminders ORDER BY remind_at ASC");
        
        if (result.rows.length === 0) {
            return bot.sendMessage(adminId, "You have no active timers.");
        }

        let listMsg = "*Active Number Timers:*\n\n";
        result.rows.forEach((row, index) => {
            const timeStr = new Date(row.remind_at).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
            listMsg += `${index + 1}. \`${row.target_number}\`\n   ⏳ Due: ${timeStr}\n\n`;
        });

        await bot.sendMessage(adminId, listMsg, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Error fetching aalist:", e);
        await bot.sendMessage(adminId, "Error retrieving timer list.");
    }
});


// --- Command: /deleteawsdb <dbname> ---
bot.onText(/^\/deleteawsdb (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const dbName = match[1].trim();

    const workingMsg = await bot.sendMessage(adminId, `Deleting database \`${dbName}\` from AWS Self-Hosted Platform...`, { parse_mode: 'Markdown' });

    try {
        // Call the specific AWS function directly
        const result = await deleteSelfHostedDatabase(dbName);

        if (result.success) {
            await bot.editMessageText(
                `**AWS Database Deleted.**\n\nThe database \`${dbName}\` has been removed from your self-hosted server.`,
                {
                    chat_id: adminId,
                    message_id: workingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        } else {
            await bot.editMessageText(
                `**AWS Deletion Failed.**\n\nReason: ${result.error}`,
                {
                    chat_id: adminId,
                    message_id: workingMsg.message_id
                }
            );
        }
    } catch (e) {
        console.error(e);
        await bot.editMessageText(`Error: ${e.message}`, { chat_id: adminId, message_id: workingMsg.message_id });
    }
});


// New /add <user_id> command for admin
bot.onText(/^\/add (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    await dbServices.updateUserActivity(cid);
    const targetUserId = match[1];

    console.log(`[Admin] /add command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /add attempt by ${cid}.`);
        return bot.sendMessage(cid, "You are not authorized to use this command.");
    }

    delete userStates[cid]; // Clear user state
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    try {
        await bot.getChat(targetUserId);
        console.log(`[Admin] Verified target user ID ${targetUserId} exists.`);
    } catch (error) {
        console.error(`[Admin] Error verifying target user ID ${targetUserId} for /add command:`, error.message);
        if (error.response && error.response.body && error.response.body.description) {
            const apiError = error.response.body.description;
            if (apiError.includes("chat not found") || apiError.includes("user not found")) {
                return bot.sendMessage(cid, `Cannot assign app: User with ID \`${targetUserId}\` not found or has not interacted with the bot.`, { parse_mode: 'Markdown' });
            } else if (apiError.includes("bot was blocked by the user")) {
                return bot.sendMessage(cid, `Cannot assign app: The bot is blocked by user \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
            }
        }
        return bot.sendMessage(cid, `An error occurred while starting the add process for user \`${targetUserId}\`: ${error.message}. Please check logs.`, { parse_mode: 'Markdown' });
    }

    console.log(`[Admin] Admin ${cid} initiated /add for user ${targetUserId}. Prompting for app selection.`);

    try {
        const sentMsg = await bot.sendMessage(cid, `Select the app to assign to user \`${targetUserId}\`:`, { parse_mode: 'Markdown' });
        userStates[cid] = {
            step: 'AWAITING_APP_FOR_ADD',
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid}:`, userStates[cid]);
        dbServices.sendAppList(cid, sentMsg.message_id, 'add_assign_app', targetUserId); // Use dbServices
    }
    catch (error) {
        console.error("Error sending initial /add message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the add process. Please try again.");
    }
});

bot.onText(/^\/changessl\s+(no-verify|disable)$/i, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    const sslMode = match[1].toLowerCase();
    
    // 1. Send working message
    const workingMsg = await bot.sendMessage(adminId, `**Starting Mass DB SSL Update**\n\nTargeting: \`${sslMode}\`\n\n1️⃣ Phase 1: Fetching all deployed apps...`, { parse_mode: 'Markdown' });

    let successCount = 0;
    let failCount = 0;
    
    try {
        // 2. Get all deployed apps from the database (to get the list of appNames)
        const allBotsResult = await pool.query("SELECT user_id, app_name FROM user_deployments");
        const allBots = allBotsResult.rows;

        if (allBots.length === 0) {
            return bot.editMessageText(`No deployed bots found in the database.`, { chat_id: adminId, message_id: workingMsg.message_id });
        }
        
        // 3. Process each bot sequentially
        for (const [index, botRow] of allBots.entries()) {
            const appName = botRow.app_name;
            
            // Update progress message periodically
            if (index % 5 === 0 || index === allBots.length - 1) {
                await bot.editMessageText(
                    `**Mass DB SSL Update**\n\nTargeting: \`${sslMode}\`\nProgress: ${index + 1}/${allBots.length}\nSuccess: ${successCount} | Failed: ${failCount}\n\nCurrent App: \`${appName}\``, 
                    { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
                ).catch(()=>{});
            }

            try {
                // 4. Fetch current config vars
                const configRes = await herokuApi.get(`/apps/${appName}/config-vars`, { 
                    headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } 
                });
                const configVars = configRes.data;
                const oldDbUrl = configVars.DATABASE_URL;

                if (!oldDbUrl) {
                    failCount++;
                    continue;
                }
                
                // 5. Parse and modify the DATABASE_URL
                const dbUrlObj = new URL(oldDbUrl);
                const params = new URLSearchParams(dbUrlObj.search);
                params.set('sslmode', sslMode);
                
                // Reconstruct the new URL with the updated parameters
                dbUrlObj.search = params.toString();
                const newDbUrl = dbUrlObj.toString();

                // 6. Update Heroku config var (triggers bot restart)
                await herokuApi.patch(`/apps/${appName}/config-vars`,
                    { DATABASE_URL: newDbUrl },
                    { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
                );

                // ❌ STEP 7: REMOVED LOCAL DB UPDATE (dbServices.saveUserDeployment) ❌

                successCount++;
                
                // Small delay to prevent Heroku rate limiting
                await new Promise(r => setTimeout(r, 1000));

            } catch (e) {
                failCount++;
                console.error(`[SSL Update] Failed to process ${appName}:`, e.message);
            }
        }

        // 8. Final Success Report
        await bot.editMessageText(
            `**Mass DB SSL Update Complete!**\n\n` +
            `Target SSL Mode: \`${sslMode}\`\n` +
            `Successfully Updated: **${successCount}** app(s).\n` +
            `Failed to Update: **${failCount}** app(s).`, 
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error(`[SSL Update] CRITICAL ERROR:`, error.message);
        await bot.editMessageText(`**CRITICAL FAILURE!**\n\nReason: ${error.message}`, 
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
    }
});


bot.onText(/^\/mynum$/, async (msg) => {
    const userId = msg.chat.id.toString();
    try {
        const result = await pool.query("SELECT number, status, assigned_at FROM temp_numbers WHERE user_id = $1 ORDER BY assigned_at DESC", [userId]);
        const numbers = result.rows;
        
        if (numbers.length === 0) {
            return bot.sendMessage(userId, "You dont have any number,  use /buytemp");
        }
        
        let message = "<b>Your WhatsApp Numbers:</b>\n\n";
        numbers.forEach(num => {
            const statusEmoji = num.status === 'assigned' ? '🔵' : '🔴';
            message += `${statusEmoji} <code>${num.number}</code> | <b>Status:</b> ${num.status}\n`;
        });
        
        await bot.sendMessage(userId, message, { parse_mode: 'HTML' });
    } catch (e) {
        console.error(`Error fetching numbers for user ${userId}:`, e);
        await bot.sendMessage(userId, "An error occurred while fetching your numbers.");
    }
});

// This will track the current page for the admin
const adminDashboardState = {
    currentPage: 1
};

// Updated /num command handler
bot.onText(/^\/num$/, async (msg) => {
    adminDashboardState.currentPage = 1; // Reset to page 1 every time the command is run
    await sendNumbersDashboard(msg.chat.id, 1);
});

// Callback handler for page navigation
bot.on('callback_query', async (query) => {
    if (query.data.startsWith('num_page:')) {
        const page = parseInt(query.data.split(':')[1]);
        adminDashboardState.currentPage = page;
        await sendNumbersDashboard(query.message.chat.id, page, query.message.message_id);
    }
});

// A new reusable function to send the dashboard
async function sendNumbersDashboard(chatId, page = 1, messageId = null) {
    if (chatId.toString() !== ADMIN_ID) return;
    const NUMBERS_PER_PAGE = 10;
    const offset = (page - 1) * NUMBERS_PER_PAGE;

    try {
        // Get counts for each status
        const countsResult = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE status = 'available') AS available_count,
                COUNT(*) FILTER (WHERE status = 'pending_payment') AS pending_count,
                COUNT(*) FILTER (WHERE status = 'assigned') AS assigned_count,
                COUNT(*) AS total_count
            FROM temp_numbers;
        `);
        const { available_count, pending_count, assigned_count, total_count } = countsResult.rows[0];

        // Get the numbers for the current page
        const pageResult = await pool.query(
            "SELECT number, status, user_id FROM temp_numbers ORDER BY status DESC, number ASC LIMIT $1 OFFSET $2",
            [NUMBERS_PER_PAGE, offset]
        );
        const numbersOnPage = pageResult.rows;

        if (total_count == 0) {
            return bot.sendMessage(chatId, "No temporary numbers found in the database.");
        }

        const totalPages = Math.ceil(total_count / NUMBERS_PER_PAGE);

        let message = `<b>Numbers Dashboard (Page ${page}/${totalPages})</b>\n\n`;
        message += `🟢 Available: <b>${available_count}</b>\n`;
        message += `🟡 Pending: <b>${pending_count}</b>\n`;
        message += `🔵 Assigned: <b>${assigned_count}</b>\n`;
        message += `------------------------------\n`;

        numbersOnPage.forEach(num => {
            const statusEmoji = num.status === 'available' ? '🟢' : num.status === 'pending_payment' ? '🟡' : '🔵';
            message += `${statusEmoji} <code>${num.number}</code> | <b>User:</b> ${num.user_id || 'N/A'}\n`;
        });

        // Create navigation buttons
        const navButtons = [];
        if (page > 1) {
            navButtons.push({ text: 'Previous', callback_data: `num_page:${page - 1}` });
        }
        if (page < totalPages) {
            navButtons.push({ text: 'Next', callback_data: `num_page:${page + 1}` });
        }

        const options = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [navButtons]
            }
        };

        if (messageId) {
            await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...options });
        } else {
            await bot.sendMessage(chatId, message, options);
        }

    } catch (e) {
        console.error("Error fetching number dashboard:", e);
        await bot.sendMessage(chatId, "An error occurred while fetching the number dashboard.");
    }
}


// In bot.js (REPLACE the existing /expire handler)

bot.onText(/^\/expire (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const days = parseInt(match[1], 10);
    if (isNaN(days) || days <= 0) {
        return bot.sendMessage(cid, "Please provide a valid number of days (e.g., /expire 45).");
    }

    try {
        let allBots = await dbServices.getAllUserBots();
        if (allBots.length === 0) {
            return bot.sendMessage(cid, "There are no bots deployed to set an expiration for.");
        }

        // --- START OF CHANGES ---
        // Sort the bots alphabetically by name
        allBots.sort((a, b) => a.bot_name.localeCompare(b.bot_name));

        userStates[cid] = {
            step: 'AWAITING_APP_FOR_EXPIRATION',
            data: { days: days }
        };

        const appButtons = allBots.map(bot => ({
            text: bot.bot_name,
            callback_data: `set_expiration:${bot.bot_name}`
        }));

        // Arrange the buttons in rows of 3
        const keyboard = chunkArray(appButtons, 3);
        // --- END OF CHANGES ---

        await bot.sendMessage(cid, `Select an app to set its expiration to *${days} days* from now:`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
    } catch (error) {
        console.error("Error fetching bots for /expire command:", error);
        await bot.sendMessage(cid, "An error occurred while fetching the bot list.");
    }
});


bot.onText(/^\/postnews (\d+)\s*\|(.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    if (!msg.reply_to_message) {
        return bot.sendMessage(adminId, "Please reply to the message you want to post as news.");
    }

    const hours = parseInt(match[1]);
    const title = match[2].trim();
    
    // Get the content from the replied message (text or caption)
    const content = msg.reply_to_message.text || msg.reply_to_message.caption;

    if (!content) {
        return bot.sendMessage(adminId, "The replied message has no text content to post.");
    }
    
    const expiresAt = new Date(Date.now() + (hours * 60 * 60 * 1000));

    try {
        await pool.query(
            "INSERT INTO bot_news (title, content, expires_at) VALUES ($1, $2, $3)",
            [title, content, expiresAt]
        );
        
        const timeStr = expiresAt.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
        await bot.sendMessage(adminId, `News posted! Body taken from reply. Auto-delete at: ${timeStr}`);
    } catch (e) {
        console.error("Error posting news:", e.message);
        await bot.sendMessage(adminId, "Failed to post news. Ensure database table 'bot_news' exists.");
    }
});


// In bot.js, with your other admin commands

bot.onText(/^\/deluser (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    const targetUserId = match[1];
    
    if (cid !== ADMIN_ID) return;
    if (targetUserId === ADMIN_ID) {
        return bot.sendMessage(cid, "You cannot delete yourself.");
    }
    
    await bot.sendMessage(cid, `⚠️ Are you sure you want to permanently delete user \`${targetUserId}\` and all their data? This cannot be undone.`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Yes, Delete User', callback_data: `confirm_deluser:${targetUserId}` },
                    { text: 'Cancel', callback_data: 'cancel_deluser' }
                ]
            ]
        }
    });
});



// In bot.js

bot.onText(/^\/info (\d+)$/, async (msg, match) => {
    const callerId = msg.chat.id.toString();
    const targetUserId = match[1];

    if (callerId !== ADMIN_ID) {
        return bot.sendMessage(callerId, "You are not authorized to use this command.");
    }
    
    await dbServices.updateUserActivity(callerId);

    try {
        const targetChat = await bot.getChat(targetUserId);
        const firstName = escapeMarkdown(targetChat.first_name || 'N/A');
        const username = targetChat.username ? escapeMarkdown(targetChat.username) : 'N/A';
        const userIdEscaped = escapeMarkdown(targetUserId);

        let userDetails = `*User Info for ID:* \`${userIdEscaped}\`\n\n`;
        userDetails += `*Name:* ${firstName}\n`;
        userDetails += `*Username:* ${targetChat.username ? `@${username}` : 'N/A'}\n`;
        
        // ✅ FIX: Get and add the user's verified email if it exists.
        const userEmail = await getUserEmail(targetUserId);
        if (userEmail) {
            userDetails += `*Email:* \`${escapeMarkdown(userEmail)}\`\n`;
        }
        
        // Fetch bots deployed by this user
        const userBots = await dbServices.getUserBots(targetUserId);
        if (userBots.length > 0) {
            userDetails += `\n*Deployed Bots:*\n`;
            for (const botName of userBots) {
                userDetails += `  - \`${botName}\`\n`;
            }
        } else {
            userDetails += `\n*Deployed Bots:* None\n`;
        }

        // Fetch user's last seen activity
        const lastSeen = await dbServices.getUserLastSeen(targetUserId);
        userDetails += `*Last Activity:* ${lastSeen ? new Date(lastSeen).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) : 'Never seen'}\n`;

        // Check ban status
        const bannedStatus = await dbServices.isUserBanned(targetUserId);
        userDetails += `*Banned:* ${bannedStatus ? 'Yes' : 'No'}\n`;

        await bot.sendMessage(callerId, userDetails, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error fetching user info for ID ${targetUserId}:`, error.message);

        if (error.response?.body?.description.includes("chat not found")) {
            await bot.sendMessage(callerId, `User with ID \`${targetUserId}\` not found or has not interacted with the bot.`);
        } else {
            await bot.sendMessage(callerId, `An unexpected error occurred while fetching info for user \`${targetUserId}\`.`);
        }
    }
});




bot.onText(/^\/getdb (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    
    // --- 1. Admin Check ---
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    const dbName = match[1].trim().toLowerCase();
    let workingMsg;

    try {
        // --- 2. Send initial message ---
        workingMsg = await bot.sendMessage(adminId, `Fetching details for \`${dbName}\`...`, { parse_mode: 'Markdown' });

        // --- 3. Call the Manager API using your sample variables ---
        const apiUrl = process.env.SELF_HOSTED_DB_URL;
        const apiKey = process.env.SELF_HOSTED_DB_SECRET;

        const res = await axios.get(`${apiUrl}/getdb/${dbName}`, {
            headers: { 'x-api-key': apiKey },
            timeout: 5000 // 5s timeout
        });

        const data = res.data;

        if (data.success) {
            await bot.editMessageText(
                `**Database Details Found**\n\n` +
                `**Name:** \`${data.db_name}\`\n` +
                `**User:** \`${data.db_user}\`\n\n` +
                `**Connection String:**\n\`${data.connection_string}\``,
                {
                    chat_id: adminId,
                    message_id: workingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        }
    } catch (e) {
        let errorMessage = "Database not found or API error.";
        
        // Handle Axios specific error responses
        if (e.response && e.response.data && e.response.data.error) {
            errorMessage = e.response.data.error;
        } else if (e.code === 'ECONNABORTED') {
            errorMessage = "Request timed out.";
        } else if (!e.response) {
            errorMessage = "Manager API is offline or unreachable.";
        }

        console.error(`Error fetching DB ${dbName}:`, e.message);

        if (workingMsg) {
            await bot.editMessageText(
                `Error: ${errorMessage}`,
                {
                    chat_id: adminId,
                    message_id: workingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            ).catch(err => console.error("Edit failed:", err.message));
        }
    }
});




// In bot.js, with your other command handlers (e.g., near /revenue)

bot.onText(/^\/addsale (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const amountNaira = parseInt(match[1], 10);
    const amountKobo = amountNaira * 100;
    
    if (isNaN(amountNaira) || amountNaira <= 0) {
        return bot.sendMessage(adminId, "Please provide a valid sale amount in Naira (e.g., `/addsale 1500`).", { parse_mode: 'Markdown' });
    }

    try {
        const reference = `manual_${crypto.randomBytes(8).toString('hex')}`;
        const adminEmail = await getUserEmail(adminId) || 'admin@ultarbot.com';

        // Insert into completed_payments table
        await pool.query(
            `INSERT INTO completed_payments (reference, user_id, email, amount, currency, paid_at) 
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [reference, adminId, adminEmail, amountKobo, 'NGN']
        );
        
        await bot.sendMessage(adminId, 
            `**Manual Sale Recorded!**\n\n` +
            `*Amount:* ₦${amountNaira.toLocaleString()}\n` +
            `*Reference:* \`${reference}\`\n\n` +
            `Revenue stats will reflect this entry.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error("Error recording manual sale:", error);
        await bot.sendMessage(adminId, `❌ Failed to record manual sale. Reason: ${error.message}`);
    }
});

// In bot.js
bot.onText(/^\/copy$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    // Check if pg_dump is available
    try {
        await execPromise('pg_dump --version');
    } catch (e) {
        return bot.sendMessage(adminId, "**Prerequisite Missing!**\nThis feature requires `pg_dump`. Please ensure your `render.yaml` file is set up correctly.", { parse_mode: 'Markdown' });
    }

    userStates[adminId] = { step: 'AWAITING_COPY_SOURCE_URL' };
    await bot.sendMessage(adminId, "Please send the full URL for **Database 1 (Source)**.\n\n*his URL will be visible in your chat history and logs.*", { parse_mode: 'Markdown' });
});


// New /remove <user_id> command for admin
bot.onText(/^\/remove (\d+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    await dbServices.updateUserActivity(cid);
    const targetUserId = match[1];

    console.log(`[Admin] /remove command received from ${cid}. Target user ID: ${targetUserId}`);

    if (cid !== ADMIN_ID) {
        console.log(`[Admin] Unauthorized /remove attempt by ${cid}.`);
        return bot.sendMessage(cid, "You are not authorized to use this command.");
    }

    delete userStates[cid]; // Clear user state
    console.log(`[Admin] userStates cleared for ${cid}. Current state:`, userStates[cid]);

    const userBots = await dbServices.getUserBots(targetUserId); // Use dbServices
    if (!userBots.length) {
        return bot.sendMessage(cid, `User \`${targetUserId}\` has no bots deployed via this system.`, { parse_mode: 'Markdown' });
    }

    console.log(`[Admin] Admin ${cid} initiated /remove for user ${targetUserId}. Prompting for app removal selection.`);

    try {
        const sentMsg = await bot.sendMessage(cid, `Select app to remove from user \`${targetUserId}\`'s dashboard:`, { parse_mode: 'Markdown' });

        userStates[cid] = {
            step: 'AWAITING_APP_FOR_REMOVAL',
            data: {
                targetUserId: targetUserId,
                messageId: sentMsg.message_id
            }
        };
        console.log(`[Admin] State set for ${cid} for removal:`, userStates[cid]);

        const rows = chunkArray(userBots, 3).map(r => r.map(name => ({
            text: name,
            callback_data: `remove_app_from_user:${name}:${targetUserId}`
        })));

        await bot.editMessageReplyMarkup({ inline_keyboard: rows }, {
            chat_id: cid,
            message_id: sentMsg.message_id
        });

    } catch (error) {
        console.error("Error sending initial /remove message or setting state:", error);
        bot.sendMessage(cid, "An error occurred while starting the removal process. Please try again.");
    }
});


// In bot.js (REPLACE the existing /updatehost handler)

bot.onText(/^\/updatehost (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const newHost = match[1].trim();
    
    // Smart IP validation - must be exactly 4 octets, each 0-255
    function isValidIPAddress(ip) {
        const ipRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
        const match = ip.match(ipRegex);
        
        if (!match) return false;
        
        // Check each octet is between 0-255
        for (let i = 1; i <= 4; i++) {
            const octet = parseInt(match[i], 10);
            if (octet < 0 || octet > 255) return false;
        }
        
        return true;
    }
    
    // Validate IP address
    if (!isValidIPAddress(newHost)) {
        return bot.sendMessage(adminId, "❌ Invalid IP address format.\n\nRequired: Must be exactly 4 octets (0-255 each).\nExample: `13.48.5.119`\n\nUsage: `/updatehost 13.48.5.119`");
    }

    const workingMsg = await bot.sendMessage(adminId, `**Migration Started**\n\nTarget Host: \`${newHost}\`\n\n1️⃣ Phase 1: Updating User Bots...`, { parse_mode: 'Markdown' });

    // --- PHASE 1: Update User Bots & Backup ---
    let success = 0;
    let failed = 0;
    let skipped = 0;

    try {
        // Get ALL bots with their config vars
        const result = await pool.query("SELECT user_id, app_name, config_vars FROM user_deployments");
        const allBots = result.rows;

        if (allBots.length > 0) {
            for (const [i, botEntry] of allBots.entries()) {
                const appName = botEntry.app_name;
                const oldConfig = botEntry.config_vars || {};
                const oldUrl = oldConfig.DATABASE_URL;

                if (!oldUrl) {
                    skipped++;
                    continue;
                }

                // ✅ CRITICAL: Only update if DATABASE_URL does NOT contain 'neon' (i.e., it's AWS)
                if (oldUrl.includes('neon')) {
                    skipped++;
                    continue;
                }

                try {
                    // 1. Parse and modify the URL
                    const dbUrlObj = new URL(oldUrl);
                    
                    // Skip if it's already updated
                    if (dbUrlObj.hostname === newHost) {
                        skipped++;
                        continue;
                    }

                    dbUrlObj.hostname = newHost;
                    const newUrl = dbUrlObj.toString();

                    // 2. Update Heroku (This restarts the user bot)
                    await herokuApi.patch(`/apps/${appName}/config-vars`,
                        { DATABASE_URL: newUrl },
                        { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
                    );

                    // 3. BACKUP: Update Local Database Record Immediately
                    // We update the JSON blob so your backup is always in sync with Heroku
                    await pool.query(`
                        UPDATE user_deployments
                        SET config_vars = jsonb_set(config_vars, '{DATABASE_URL}', to_jsonb($1::text), true)
                        WHERE app_name = $2
                    `, [newUrl, appName]);

                    success++;
                    
                    // Update progress message every 5 bots
                    if (i % 5 === 0) {
                         await bot.editMessageText(
                             `1. Updating User Bots... (${i + 1}/${botsToUpdate.length})\n` +
                             `Current: \`${appName}\`\n` +
                             `OK: ${success} | Fail: ${failed}`, 
                             { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
                         ).catch(()=>{});
                    }
                    
                    // Small delay to prevent Heroku rate limiting
                    await new Promise(r => setTimeout(r, 1000));

                } catch (e) {
                    console.error(`Failed to migrate ${appName}:`, e.message);
                    failed++;
                }
            }
        }
    } catch (error) {
        console.error("Critical error during user bot update:", error);
        return bot.sendMessage(adminId, `**Critical Error:** Database query failed. Migration stopped.\n${error.message}`);
    }

    // --- PHASE 2: Update Main Bot (Render) ---
    
    await bot.editMessageText(
        `**Phase 1 Complete**\n\n` +
        `User Bots Updated/Backed Up: ${success}\n` +
        `Skipped (Already Done): ${skipped}\n` +
        `Failed: ${failed}\n\n` +
        `2. Updating Main Bot Config & Restarting...`, 
        { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
    );

    try {
        // Construct the API URL (http://IP:3000)
        const newApiUrl = `http://${newHost}:3000`;
        
        // Use your existing helper function to update Render
        const updateResult = await updateRenderVar('SELF_HOSTED_DB_URL', newApiUrl);
        
        if (updateResult.success) {
            await bot.sendMessage(adminId, 
                `**Migration Successful!**\n\n` +
                `1. All AWS User bots updated to \`${newHost}\`.\n` +
                `2. Backups synchronized.\n` +
                `3. Render \`SELF_HOSTED_DB_URL\` updated.\n\n` +
                `**Main Bot is restarting now.** Back online in ~1 minute.`
            );
        } else {
            throw new Error(updateResult.message);
        }

    } catch (error) {
        await bot.sendMessage(adminId, `**Phase 2 Failed:** User bots are updated, but Main Bot failed to update Render.\nError: ${error.message}\n\nPlease update \`SELF_HOSTED_DB_URL\` manually in Render Dashboard.`);
    }
});


// Command: /aa mode
bot.onText(/^\/aa mode$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    // Set the state
    userStates[adminId] = {
        step: 'AA_CONTINUOUS_MODE',
        data: { startTime: Date.now() }
    };

    // Auto-exit timer (15 minutes)
    const exitTimer = setTimeout(async () => {
        if (userStates[adminId] && userStates[adminId].step === 'AA_CONTINUOUS_MODE') {
            delete userStates[adminId];
            await bot.sendMessage(adminId, "AA Mode expired due to 15 minutes of inactivity.");
        }
    }, 15 * 60 * 1000);

    userStates[adminId].data.timeoutId = exitTimer;

    await bot.sendMessage(adminId, "AA Mode active. Just send: number time\nExample: 2349012345678 2\n\nType 'exit' to stop.");
});


// In bot.js

bot.onText(/^\/dellogout$/, async (msg) => {
    const adminId = msg.chat.id.toString();

    // --- Step 1: Admin Check ---
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "This command is for the admin only.");
    }

    // Ensure dependencies are available (deleteNeonDatabase, pool, herokuApi, HEROKU_API_KEY)
    if (typeof deleteNeonDatabase !== 'function' || !pool || !herokuApi || !HEROKU_API_KEY) {
         console.error("[/dellogout Admin] CRITICAL: Required dependencies are unavailable. Command aborted.");
         return bot.sendMessage(adminId, "Error: Critical dependencies (DB or Neon helper) are unavailable. Command aborted.");
    }

    let workingMsg;
    try {
        workingMsg = await bot.sendMessage(adminId, "Finding all logged-out bots to prune external resources (Heroku/Neon)...");
    } catch (sendError) {
        console.error("[/dellogout Admin] Failed to send initial message:", sendError);
        return;
    }

    let prunedCount = 0; // Counts bots where both Heroku + Neon deleted successfully
    let failedHerokuCount = 0;
    let failedNeonCount = 0;
    let botsToPrune = [];

    try {
        // --- Step 2: Query main DB for ALL logged-out bots ---
        // Fetches bots with status='logged_out'
        const result = await pool.query(
            "SELECT user_id, bot_name FROM user_bots WHERE status = 'logged_out'"
        );
        botsToPrune = result.rows; 

        if (botsToPrune.length === 0) {
            await bot.editMessageText("No logged-out bots found to prune external resources for.", { chat_id: adminId, message_id: workingMsg.message_id });
            return;
        }

        await bot.editMessageText(`Found ${botsToPrune.length} logged-out bot(s). Starting external resource deletion (Heroku app & Neon DB)... This might take a moment.\n\n⚠️ Local database records will NOT be deleted.`, { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' });

        // --- Step 3: Loop and Delete External Resources ---
        for (const [index, botInfo] of botsToPrune.entries()) {
            const originalUserId = botInfo.user_id; // Owner ID from the 'logged_out' bot record
            const appName = botInfo.bot_name;
            const progressText = `Pruning "${appName}" (Owner: ${originalUserId})... (${index + 1}/${botsToPrune.length})`;
            await bot.editMessageText(progressText, { chat_id: adminId, message_id: workingMsg.message_id }).catch(() => {});

            let herokuDeleted = false;
            let neonDeleted = false;
            let neonAccountIdToDelete = '1'; // Default

            // --- START FIX: Tiered Lookup for Neon Account ID ---
            try {
                // TIER 1: Try to find deployment using the ID from the logged_out record
                let deploymentInfo = await pool.query(
                    'SELECT user_id, neon_account_id FROM user_deployments WHERE user_id = $1 AND app_name = $2',
                    [originalUserId, appName]
                );

                if (deploymentInfo.rows.length === 0) {
                    // TIER 2: Search globally by app_name, as ownership may have changed
                    deploymentInfo = await pool.query(
                        'SELECT user_id, neon_account_id FROM user_deployments WHERE app_name = $1 LIMIT 1',
                        [appName]
                    );
                }

                // Final Assignment: Use the found account ID
                if (deploymentInfo.rows.length > 0 && deploymentInfo.rows[0].neon_account_id) {
                    neonAccountIdToDelete = deploymentInfo.rows[0].neon_account_id;
                    console.log(`[/dellogout Admin] Found Neon Account ID ${neonAccountIdToDelete} for ${appName}.`);
                } else {
                    console.warn(`[/dellogout Admin] Neon account ID not found in user_deployments for ${appName}. Assuming Account '1'.`);
                }
            } catch (dbError) {
                console.error(`[/dellogout Admin] Error fetching Neon Account ID for ${appName}, assuming Account '1':`, dbError.message);
            }
            // --- END FIX ---

            // --- Part A: Delete Heroku App ---
            try {
                console.log(`[/dellogout Admin] Attempting Heroku delete for ${appName} (Owner: ${originalUserId})`);
                await herokuApi.delete(`/apps/${appName}`, { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } });
                console.log(`[/dellogout Admin] Successfully deleted ${appName} from Heroku.`);
                herokuDeleted = true;
            } catch (herokuError) {
                if (herokuError.response && herokuError.response.status === 404) {
                    console.log(`[/dellogout Admin] Bot ${appName} (Owner: ${originalUserId}) not found on Heroku (404).`);
                    herokuDeleted = true;
                } else {
                    const errorMsg = herokuError.response?.data?.message || herokuError.message || 'Unknown Heroku API error';
                    console.error(`[/dellogout Admin] Heroku API error deleting ${appName} (Owner: ${originalUserId}):`, errorMsg);
                    failedHerokuCount++;
                    await bot.sendMessage(ADMIN_ID, `Failed Heroku delete for "${appName}" (Owner: ${originalUserId}): ${escapeMarkdown(errorMsg)}`, { parse_mode: 'Markdown' });
                    herokuDeleted = false;
                }
            }

            // --- Part B: Delete Neon Database (Using Correct Account ID) ---
            if (herokuDeleted) {
                const dbName = appName.replace(/-/g, '_');
                try {
                    console.log(`[/dellogout Admin] Attempting Neon DB delete: ${dbName} from Account ${neonAccountIdToDelete}`);
                    const neonResult = await deleteNeonDatabase(dbName, neonAccountIdToDelete);

                    if (neonResult.success) {
                        console.log(`[/dellogout Admin] Successfully deleted Neon DB ${dbName} from Account ${neonAccountIdToDelete}.`);
                        neonDeleted = true;
                    } else {
                        // deleteNeonDatabase handles 404 as success, so this error is likely real
                        throw new Error(neonResult.error || 'Unknown Neon deletion error');
                    }
                } catch (neonError) {
                    console.error(`[/dellogout Admin] Failed to delete Neon DB ${dbName} from Account ${neonAccountIdToDelete}: ${neonError.message}`);
                    failedNeonCount++;
                    await bot.sendMessage(ADMIN_ID, `Failed Neon DB delete for ${appName} (Owner: ${originalUserId}, Acc: ${neonAccountIdToDelete}): ${escapeMarkdown(neonError.message)}`, { parse_mode: 'Markdown' });
                    neonDeleted = false;
                }
            } else {
                 console.log(`[/dellogout Admin] Skipping Neon DB deletion for ${appName} because Heroku deletion failed.`);
                 failedNeonCount++;
            }


            // --- Part C: Tally ---
            if (herokuDeleted && neonDeleted) {
                prunedCount++;
                console.log(`[/dellogout Admin] Successfully pruned external resources for ${appName}.`);
            } else {
                 console.warn(`[/dellogout Admin] Failed to prune all external resources for ${appName}. Heroku success: ${herokuDeleted}, Neon success: ${neonDeleted}.`);
            }

            await new Promise(resolve => setTimeout(resolve, 500));
        } // End loop

        // --- Step 4: Final Summary (Admin only) ---
        let summary = `Logged-out bot external resource cleanup finished.\n\n`;
        summary += `Bots pruned (Heroku+Neon): ${prunedCount}\n`;
        summary += `Failed Heroku deletions: ${failedHerokuCount}\n`;
        summary += `Failed Neon deletions: ${failedNeonCount}\n\n`;
        summary += `Local database records remain untouched.`;

        await bot.editMessageText(summary, { chat_id: adminId, message_id: workingMsg.message_id });

    } catch (error) { // Outer catch block
        console.error("[/dellogout Admin] Critical error during the process:", error);
        if (workingMsg && workingMsg.message_id) {
            try {
                await bot.editMessageText(`An unexpected error occurred: ${escapeMarkdown(error.message)}. Check logs.`, { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' });
            } catch (editError) {
                console.error("[/dellogout Admin] Failed to edit the error message:", editError);
            }
        } else {
            console.error("[/dellogout Admin] Critical error occurred, no initial message reference.");
        }
         // Send a separate message just in case editing failed
         await bot.sendMessage(ADMIN_ID, `An unexpected critical error occurred during /dellogout: ${escapeMarkdown(error.message)}. Check logs.`, { parse_mode: 'Markdown' });
    }
});



bot.onText(/^\/deploytls$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const { GMAIL_USER, GMAIL_APP_PASSWORD, SECRET_API_KEY, HEROKU_API_KEY, MESSAGE_BOT_API_KEY } = process.env;
    
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !HEROKU_API_KEY) {
        return bot.sendMessage(adminId, "Setup Incomplete: Missing GMAIL credentials or Heroku Key.");
    }

    const progressMsg = await bot.sendMessage(adminId, "Starting TLS Stack Deployment (3 Apps)...");

    try {
        // --- STEP 1: DEPLOY MESSAGEBOT FIRST (To get the URL for the Scraper) ---
        await bot.editMessageText("(1/3) Deploying MessageBot...", { chat_id: adminId, message_id: progressMsg.message_id });
        const msgAppName = `msg-tls-${crypto.randomBytes(3).toString('hex')}`;
        await herokuApi.post('/apps', { name: msgAppName });
        
        await herokuApi.put(`/apps/${msgAppName}/buildpack-installations`, {
            updates: [
                { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest.git' },
                { buildpack: 'heroku/nodejs' }
            ]
        });

        await herokuApi.patch(`/apps/${msgAppName}/config-vars`, { 
            SECRET_API_KEY, 
            MESSAGE_BOT_API_KEY,
            DATABASE_URL: process.env.DATABASE_URL 
        });

        await herokuApi.post(`/apps/${msgAppName}/builds`, { source_blob: { url: "https://github.com/Ultar12/MESSAGEBOT/tarball/main" } });

        // Retrieve exact URL for MessageBot to give to Scraper
        const msgAppInfo = await herokuApi.get(`/apps/${msgAppName}`);
        const messageBotUrl = msgAppInfo.data.web_url; // Exact URL for Scraper config

        // --- STEP 2: DEPLOY SCARPERBOT (SCRAPER) ---
        await bot.editMessageText("(2/3) Deploying ScraperBot...", { chat_id: adminId, message_id: progressMsg.message_id });
        const scAppName = `scr-tls-${crypto.randomBytes(3).toString('hex')}`;
        await herokuApi.post('/apps', { name: scAppName });

        await herokuApi.put(`/apps/${scAppName}/buildpack-installations`, {
            updates: [
                { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest.git' },
                { buildpack: 'https://github.com/jontewks/heroku-buildpack-puppeteer-firefox' },
                { buildpack: 'https://buildpack-registry.s3.amazonaws.com/buildpacks/heroku-community/chrome-for-testing.tgz' },
                { buildpack: 'heroku/python' },
                { buildpack: 'heroku/nodejs' }
            ]
        });

        // 💡 Injects MessageBot URL into Scraper as APP_URL
        await herokuApi.patch(`/apps/${scAppName}/config-vars`, { 
            APP_URL: messageBotUrl,
            SECRET_API_KEY 
        });

        await herokuApi.post(`/apps/${scAppName}/builds`, { source_blob: { url: "https://github.com/Ultar12/Scarper/tarball/main" } });

        // --- STEP 3: DEPLOY EMAIL SERVICE ---
        await bot.editMessageText("(3/3) Deploying Email Service...", { chat_id: adminId, message_id: progressMsg.message_id });
        const emAppName = `email-tls-${crypto.randomBytes(3).toString('hex')}`;
        await herokuApi.post('/apps', { name: emAppName });
        await herokuApi.patch(`/apps/${emAppName}/config-vars`, { GMAIL_USER, GMAIL_APP_PASSWORD, SECRET_API_KEY });
        await herokuApi.post(`/apps/${emAppName}/builds`, { source_blob: { url: "https://github.com/ultar1/Email-service-/tarball/main/" } });

        // Retrieve exact URL for Email Service to update Render
        const emAppInfo = await herokuApi.get(`/apps/${emAppName}`);
        const emailServiceUrl = emAppInfo.data.web_url;

        // --- FINAL SYNC TO RENDER & RESTART ---
        await bot.editMessageText("Finalizing: Updating Render EMAIL_SERVICE_URL and restarting...", { chat_id: adminId, message_id: progressMsg.message_id });

        // Update Render variable for Email Service
        await updateRenderVar('EMAIL_SERVICE_URL', emailServiceUrl);

        // Explicitly trigger Render restart
        await triggerRenderRestart();

        await bot.editMessageText(
            "Full TLS Stack Deployed Successfully\n\n" +
            "Message Bot URL: " + messageBotUrl + "\n" +
            "Scraper Bot: Configured with APP_URL = " + messageBotUrl + "\n" +
            "Email Service: " + emailServiceUrl + "\n\n" +
            "Render is restarting to apply the new Email Service link.", 
            { chat_id: adminId, message_id: progressMsg.message_id }
        );

    } catch (error) {
        console.error(error);
        const errDetails = error.response?.data?.message || error.message;
        await bot.editMessageText("Deployment Failed\n\nReason: " + errDetails, {
            chat_id: adminId, message_id: progressMsg.message_id
        });
    }
});



// In bot.js (in the command handlers section, e.g., near line 5150)

bot.onText(/^\/exp$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    const workingMsg = await bot.sendMessage(adminId, "Fetching list of bots expiring within 7 days...");

    try {
        // Query for bots expiring in the next 7 days that are NOT paused
        const query = `
            SELECT user_id, app_name, expiration_date 
            FROM user_deployments 
            WHERE 
                expiration_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
                AND paused_at IS NULL
            ORDER BY 
                expiration_date ASC;
        `;
        
        const result = await pool.query(query);
        const expiringBots = result.rows;

        if (expiringBots.length === 0) {
            return bot.editMessageText("No active bots are expiring in the next 7 days.", {
                chat_id: adminId,
                message_id: workingMsg.message_id
            });
        }

        let responseMessage = `*Bots Expiring Soon (Next 7 Days):*\n\n`;
        const now = new Date();

        for (const bot of expiringBots) {
            const expDate = new Date(bot.expiration_date);
            const timeLeftMs = expDate.getTime() - now.getTime();
            
            // Calculate days, hours, and minutes
            const daysLeft = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
            const hoursLeft = Math.floor((timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutesLeft = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));

            let timeRemaining;
            
            if (daysLeft > 0) {
                timeRemaining = `*${daysLeft}d ${hoursLeft}h left*`;
            } else if (hoursLeft > 0) {
                timeRemaining = `*${hoursLeft}h ${minutesLeft}m left*`;
            } else {
                // If less than an hour, show only minutes
                timeRemaining = `*${minutesLeft}m left* (Expiring very soon!)`;
            }

            responseMessage += `▪️ \`${escapeMarkdown(bot.app_name)}\`\n`;
            responseMessage += `  (Owner: \`${bot.user_id}\`)\n`;
            responseMessage += `  (Expires: ${timeRemaining})\n\n`;
        }

        await bot.editMessageText(responseMessage, {
            chat_id: adminId,
            message_id: workingMsg.message_id,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error("Error fetching /exp list:", error);
        await bot.editMessageText(`An error occurred: ${error.message}`, {
            chat_id: adminId,
            message_id: workingMsg.message_id
        });
    }
});


// In bot.js, replace your entire bot.onText(/^\/dbstats$/, async (msg) => { ... }) function with this:





// --- NEW COMMAND: /sync ---
bot.onText(/^\/sync$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const sentMsg = await bot.sendMessage(cid, 'Starting full database synchronization with Heroku. This may take a moment...');

    try {
        const result = await dbServices.syncDatabaseWithHeroku();
        
        if (result.success) {
            const finalMessage = `
*Synchronization Complete!*
- *Added to Database:* ${result.stats.addedToUserBots} missing apps.
- *Total Heroku Apps now recognized:* The number on Heroku should now match your bot commands.

You can now use /stats or /bapp to see the updated count of all your bots.
            `;
            await bot.editMessageText(finalMessage, {
                chat_id: cid,
                message_id: sentMsg.message_id,
                parse_mode: 'Markdown'
            });
        } else {
            await bot.editMessageText(`Sync failed! Reason: ${result.message}`, {
                chat_id: cid,
                message_id: sentMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    } catch (error) {
        await bot.editMessageText(`An unexpected error occurred during sync: ${error.message}`, {
            chat_id: cid,
            message_id: sentMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
});


bot.onText(/^\/deldb\s+([\w-]+)(?:\s+(\d+))?$/i, async (msg, match) => {
    const adminId = msg.chat.id.toString();

    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "This command is restricted to the administrator.");
    }
    
    const singleDbName = match[1];      // Required DB Name
    const singleAccountId = match[2];   // Optional Account ID (e.g., '19')

    const workingMsg = await bot.sendMessage(adminId, `Attempting to delete database \`${singleDbName}\`...`, {
        parse_mode: 'Markdown'
    });

    let result = { success: false, error: "Database not found." };
    let location = 'Unknown';
    
    // --- START LOGIC ROUTER ---

    if (singleAccountId) {
        // CASE 1: /deldb <name> <ID> (Explicit Check only)
        // This is a direct command to the Neon API for a specific account.
        
        location = `Neon Account ${singleAccountId}`;
        // Use the explicit ID for the check (Strategy A in the deletion function)
        result = await deleteNeonDatabase(singleDbName, singleAccountId);
        
    } else {
        // CASE 2: /deldb <name> (Hybrid Search: AWS -> Neon Search)
        
        // A. Try AWS Self-Hosted First
        if (process.env.SELF_HOSTED_DB_URL) {
            const awsResult = await deleteSelfHostedDatabase(singleDbName);
            if (awsResult.success) {
                result = { success: true, accounts_checked: 'AWS' };
                location = 'AWS Self-Hosted';
            }
        }

        // B. Fallback to Neon Search if AWS failed
        if (!result.success) {
            // Passing '1' tells the function to run the full Neon search logic (Strategy B)
            const neonResult = await deleteNeonDatabase(singleDbName, '1');
            if (neonResult.success) {
                 result = neonResult;
                 location = `Neon Account ${neonResult.accounts_checked}`;
            }
        }
    }
    
    // --- Final Response ---
    if (result.success) {
        await bot.editMessageText(
            `**SUCCESS! Database Deleted.**\n\nDatabase \`${escapeMarkdown(singleDbName)}\` has been removed.\n**Source:** ${location}`,
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
    } else {
        await bot.editMessageText(
            `**DELETION FAILED.**\n\nCould not find/delete \`${escapeMarkdown(singleDbName)}\`.\n\n*Reason:* ${escapeMarkdown(result.error || 'Check local logs for API error details.')}`,
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
    }
    return;
});

bot.onText(/^\/getallaws$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const workingMsg = await bot.sendMessage(adminId, "Scanning AWS and Heroku to find unowned databases...");

    try {
        const apiUrl = process.env.SELF_HOSTED_DB_URL;
        const apiKey = process.env.SELF_HOSTED_DB_SECRET;

        if (!apiUrl || !apiKey) {
            return bot.editMessageText("AWS Configuration missing.", { chat_id: adminId, message_id: workingMsg.message_id });
        }

        // 1. Fetch data from both platforms
        const [awsRes, herokuRes] = await Promise.all([
            axios.get(`${apiUrl}/list`, { headers: { 'x-api-key': apiKey }, timeout: 15000 }),
            herokuApi.get('/apps', { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } })
        ]);

        if (awsRes.data.success) {
            const allAwsDbs = awsRes.data.databases;
            const herokuAppNames = new Set(herokuRes.data.map(app => app.name.replace(/-/g, '_')));

            // 2. Filter for databases not matched to any Heroku app
            const unownedDbs = allAwsDbs.filter(db => {
                const dbName = db.name.replace(/-/g, '_');
                return !herokuAppNames.has(dbName) && dbName !== 'neondb' && dbName !== 'postgres';
            });

            // Remove the scanning message
            await bot.deleteMessage(adminId, workingMsg.message_id).catch(() => {});

            if (unownedDbs.length === 0) {
                return bot.sendMessage(adminId, "Clean: All AWS databases are matched to Heroku bots.", { parse_mode: 'HTML' });
            }

            // 3. Build the response with escaping for every database name
            let currentMessage = "Unowned AWS Databases (" + unownedDbs.length + "):\n\n";
            const MAX_LENGTH = 3500;

            for (const [index, db] of unownedDbs.entries()) {
                // This escaping prevents the 'can't parse entities' error
                const safeName = escapeHTML(db.name); 
                const nameLine = (index + 1) + ". <code>" + safeName + "</code>\n";

                if ((currentMessage + nameLine).length > MAX_LENGTH) {
                    await bot.sendMessage(adminId, currentMessage, { parse_mode: 'HTML' });
                    currentMessage = "Unowned AWS Databases (Continued):\n\n";
                }
                currentMessage += nameLine;
            }

            currentMessage += "\nUse /deleteawsdb &lt;name&gt; to remove.";
            await bot.sendMessage(adminId, currentMessage, { parse_mode: 'HTML' });

        } else {
            throw new Error("AWS server reported failure.");
        }

    } catch (e) {
        console.error("Failed /getallaws:", e.message);
        const safeError = escapeHTML(e.message);
        await bot.sendMessage(adminId, "Error:\n" + safeError, { parse_mode: 'HTML' }).catch(() => {});
    }
});



// In bot.js (REPLACE the entire /dbstats function)

bot.onText(/^\/dbstats$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const workingMsg = await bot.sendMessage(adminId, "Fetching database lists (AWS + Neon)...");

    // --- 0. FUZZY OWNER MAPPING WITH SIMILARITY MATCHING ---
    // This query uses UNION to merge user_id and app/bot_name from both core tables
    const allBotsResult = await pool.query(`
        SELECT bot_name, user_id FROM user_bots
        UNION 
        SELECT app_name AS bot_name, user_id FROM user_deployments
    `);
    
    // Build owner list with canonical names for fuzzy matching
    const botList = allBotsResult.rows.map(bot => ({
        name: bot.bot_name,
        canonical: bot.bot_name.replace(/-/g, '_'),
        userId: bot.user_id
    }));
    
    // Similarity function: Levenshtein distance ratio
    function getSimilarity(str1, str2) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const editDistance = getEditDistance(longer, shorter);
        return (longer.length - editDistance) / longer.length;
    }
    
    function getEditDistance(s1, s2) {
        const costs = [];
        for (let i = 0; i <= s1.length; i++) {
            let lastValue = i;
            for (let j = 0; j <= s2.length; j++) {
                if (i === 0) {
                    costs[j] = j;
                } else if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
            if (i > 0) costs[s2.length] = lastValue;
        }
        return costs[s2.length];
    }
    
    // Function to find owner by exact or fuzzy match
    function findOwnerByName(dbName) {
        // 1. Try exact match on canonical name
        for (const bot of botList) {
            if (bot.canonical === dbName) return bot.userId;
        }
        
        // 2. Try exact match on original name (with underscores)
        const dbNameWithUnderscores = dbName.replace(/-/g, '_');
        for (const bot of botList) {
            if (bot.canonical === dbNameWithUnderscores) return bot.userId;
        }
        
        // 3. Try prefix matching (for renamed apps like mecusgift-4221 matching mecusgift)
        // Check if DB name starts with any bot's base name
        for (const bot of botList) {
            // Extract base name (remove hex suffix if present)
            const baseName = bot.canonical.replace(/_[a-f0-9]{4,}$/, '');
            
            // Check if database name matches the base name or is a renamed version
            if (dbNameWithUnderscores.startsWith(baseName + '_') || 
                dbNameWithUnderscores === baseName) {
                return bot.userId;
            }
        }
        
        // 4. Fuzzy match: find the most similar name with lower threshold > 65%
        let bestMatch = null;
        let bestSimilarity = 0.65; // 65% similarity threshold (lowered for better matching)
        
        for (const bot of botList) {
            const similarity = getSimilarity(dbNameWithUnderscores, bot.canonical);
            if (similarity > bestSimilarity) {
                bestSimilarity = similarity;
                bestMatch = bot.userId;
            }
        }
        
        return bestMatch || 'Unknown';
    }

    // --- 1. AWS SELF-HOSTED REPORT ---
    let awsReport = "";
    let awsDbCount = 0;
    
    if (process.env.SELF_HOSTED_DB_URL) {
        try {
            const apiUrl = process.env.SELF_HOSTED_DB_URL;
            const apiKey = process.env.SELF_HOSTED_DB_SECRET;
            
            const res = await axios.get(`${apiUrl}/list`, {
                headers: { 'x-api-key': apiKey },
                timeout: 5000 // 5s timeout
            });

            if (res.data.success) {
                const awsDbs = res.data.databases;
                awsDbCount = awsDbs.length;
                
                awsReport += `**AWS SELF-HOSTED (${awsDbCount} DBs)**\n`;
                awsReport += `**Status:** Online | **Capacity:** Unlimited\n\n`;
                
                if (awsDbs.length > 0) {
                    awsDbs.forEach((db, index) => {
                        const dbName = db.name;
                        const size = db.size;
                        // Use fuzzy matching to find owner
                        const owner = findOwnerByName(dbName);
                        
                        // Format: #1 dbname | size | ownerID
                        awsReport += `▫️ #${index + 1} <code>${escapeHTML(dbName)}</code> | ${size} | <code>${owner}</code>\n`;
                    });
                } else {
                    awsReport += `_No active databases found on AWS._\n`;
                }
                awsReport += `\n----------------------------------------\n\n`;
            }
        } catch (e) {
            awsReport = `**AWS SELF-HOSTED**\n` +
                        `**Status:** Offline / Unreachable\n` + 
                        `**Error:** ${e.message}\n` +
                        `----------------------------------------\n\n`;
        }
    } else {
        awsReport = `**AWS SELF-HOSTED**\n**Status:** Not Configured\n----------------------------------------\n\n`;
    }

    // --- 2. NEON ACCOUNTS REPORT ---
    async function getNeonAccountStats(accountConfig) {
        const accountId = accountConfig.id;
        const USER_DB_LIMIT = 1; 
        
        const apiUrl = `https://console.neon.tech/api/v2/projects/${accountConfig.project_id}/branches/${accountConfig.branch_id}`;
        const dbsUrl = `${apiUrl}/databases`;
        const headers = { 'Authorization': `Bearer ${accountConfig.api_key}`, 'Accept': 'application/json' };

        try {
            const [dbsResponse, branchResponse] = await Promise.all([
                axios.get(dbsUrl, { headers }),
                axios.get(apiUrl, { headers })
            ]);

            const dbList = dbsResponse.data.databases;
            const branchData = branchResponse.data.branch;
            const logicalSizeMB = branchData.logical_size ? (branchData.logical_size / (1024 * 1024)).toFixed(2) : '0.00';
            
            const userDBs = dbList.filter(db => db.name !== 'neondb');
            
            return {
                success: true, id: accountId, totalDBCount: dbList.length, userDBCount: userDBs.length,     
                slotsLeft: USER_DB_LIMIT - userDBs.length, dbLimit: USER_DB_LIMIT, storageUsed: logicalSizeMB,
                dbList: userDBs, error: null
            };
        } catch (error) {
            return { success: false, id: accountId, error: error.response?.data?.message || error.message };
        }
    }
    
    const resultsPromises = NEON_ACCOUNTS.map(accountConfig => getNeonAccountStats(accountConfig));
    const allResults = await Promise.all(resultsPromises);
    
    let totalStorageUsedMB = 0;
    let totalUserDBs = 0; 
    let totalSlotsLeft = 0; 
    const TOTAL_USER_SLOTS = NEON_ACCOUNTS.length * 1; 
    let accountsWithCapacity = 0;
    let dbCounter = 1;
    let consolidatedDBListMessage = ``; 

    for (const result of allResults) {
        const accountId = result.id ? String(result.id) : 'N/A';
        if (result.success) {
            totalUserDBs += result.userDBCount; 
            totalSlotsLeft += Math.max(0, result.slotsLeft); 
            totalStorageUsedMB += parseFloat(result.storageUsed || 0); 
            if (result.slotsLeft > 0) accountsWithCapacity++;
            
            if (result.dbList && result.dbList.length > 0) {
                result.dbList.forEach(db => {
                    const dbNameSanitized = db.name.replace(/-/g, '_'); 
                    // Use fuzzy matching to find owner
                    const ownerUserId = findOwnerByName(dbNameSanitized); 
                    consolidatedDBListMessage += `#${dbCounter++} (Acc ${accountId}) <code>${escapeHTML(db.name)}</code> | <code>${ownerUserId}</code>\n`;
                });
            }
        } else {
            consolidatedDBListMessage += `Account ${accountId} failed: ${escapeHTML(result.error || 'Unknown Error').substring(0, 30)}...\n`;
        }
    }
    
    // --- 3. CONSTRUCT FINAL MESSAGE ---
    let combinedMessage = awsReport;
    
    combinedMessage += `**NEON ACTIVE DATABASES (${totalUserDBs}):**\n\n`;
    combinedMessage += consolidatedDBListMessage;

    combinedMessage += `\n========================================\n`;
    combinedMessage += `<b>NEON RESOURCE SUMMARY</b>\n`;
    combinedMessage += `Neon Slots Available: <b>${totalSlotsLeft} / ${TOTAL_USER_SLOTS}</b>\n`;
    combinedMessage += `Neon Active DBs: <b>${totalUserDBs}</b>\n`;
    combinedMessage += `Neon Accounts with Space: <b>${accountsWithCapacity} / ${NEON_ACCOUNTS.length}</b>\n`;
    
    // The total max storage should ideally be taken from NEON_ACCOUNTS config if specified, 
    // but assuming 512MB default * number of accounts as per your configuration context.
    const totalMaxStorage = NEON_ACCOUNTS.length * 512; 
    const storageRemaining = Math.max(0, totalMaxStorage - totalStorageUsedMB);
    combinedMessage += `Neon Storage Left: <b>${storageRemaining.toFixed(2)} MB</b>\n`;
    combinedMessage += `========================================\n`;

    await bot.editMessageText(combinedMessage.trim(), {
        chat_id: adminId,
        message_id: workingMsg.message_id,
        parse_mode: 'HTML',
        disable_web_page_preview: true
    }).catch(err => {
        console.error("Failed to edit /dbstats message:", err.message);
        bot.sendMessage(adminId, "Error: Could not format all stats. Check logs.");
    });
});

// --- ADMIN COMMAND: /setbot <type> <on/off> ---
bot.onText(/^\/setbot (levanter|raganork|hermit) (on|off)$/i, async (msg, match) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const botType = match[1].toLowerCase();
    const status = match[2].toLowerCase() === 'on' ? 'available' : 'down';

    try {
        await pool.query(
            `INSERT INTO app_settings (setting_key, setting_value) 
             VALUES ($1, $2) 
             ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
            [`status_${botType}`, status]
        );
        await bot.sendMessage(cid, `Bot *${botType.toUpperCase()}* is now set to: *${status.toUpperCase()}*`, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error(e);
        await bot.sendMessage(cid, "Error saving bot status.");
    }
});


bot.onText(/^\/addapi (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    // ... (logic to get finalNewKey remains the same) ...
    const finalNewKey = msg.text.substring(msg.text.indexOf(' ')).trim();


    if (finalNewKey.length < 30) {
        return bot.sendMessage(adminId, "Invalid key length. Heroku API keys are long tokens. Please provide the full key.");
    }

    try {
        // --- CRITICAL FIX: Explicitly insert TRUE into the is_active column. ---
        await pool.query(
            `INSERT INTO heroku_api_keys (id, api_key, added_by, is_active) 
             VALUES (DEFAULT, $1, $2, TRUE)`, // <--- ADDED is_active: TRUE
            [finalNewKey, adminId]
        );
        // ------------------------------------------------------------------------

        await bot.sendMessage(adminId, `New Heroku API Key added successfully and marked **🟢 Active**!`, { parse_mode: 'Markdown' });
    } catch (e) {
        if (e.code === '23505') { // Unique violation
            return bot.sendMessage(adminId, `Key already exists in the database.`);
        }
        console.error("Error adding new API key:", e);
        await bot.sendMessage(adminId, `Failed to add API key: ${e.message}`);
    }
});




bot.onText(/^\/apilist$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    try {
        const result = await pool.query("SELECT api_key, is_active, added_at FROM heroku_api_keys ORDER BY added_at DESC");
        const keys = result.rows;

        if (keys.length === 0) {
            return bot.sendMessage(adminId, "No Heroku API keys stored in the database.");
        }

        let message = "*Security Warning:* This message contains sensitive API keys. Please delete it after use.\n\n";
        message += "*Stored Heroku API Keys:*\n\n";
        
        keys.forEach((k, index) => {
            const status = k.is_active ? '🟢 (Active)' : '🔴 (Inactive)';
            const addedDate = new Date(k.added_at).toLocaleDateString('en-US', { timeZone: 'Africa/Lagos' });
            
            // ❗️ FIX: Using the full API key directly instead of masking it.
            const fullApiKey = k.api_key;
            
            message += `*${index + 1}.* \`${fullApiKey}\`\n`;
            message += `   - *Status:* ${status}\n`;
            message += `   - *Added:* ${addedDate}\n\n`;
        });
        
        message += "_The bot will attempt to use the most recent active key upon failure._";

        await bot.sendMessage(adminId, message, { parse_mode: 'Markdown' });
    } catch (e) {
        console.error("Error listing API keys:", e);
        await bot.sendMessage(adminId, `Failed to list API keys: ${e.message}`);
    }
});



// NEW: /askadmin command for users to initiate support
bot.onText(/^\/askadmin (.+)$/, async (msg, match) => {
    // ❗️ FIX: Escape the user's question text immediately.
    const userQuestion = escapeMarkdown(match[1]);
    const userChatId = msg.chat.id.toString();
    await dbServices.updateUserActivity(userChatId);
    const userMessageId = msg.message_id;

    if (userChatId === ADMIN_ID) {
        return bot.sendMessage(userChatId, "You are the admin, you cannot ask yourself questions!");
    }

    try {
        const adminMessage = await bot.sendMessage(ADMIN_ID,
            `*New Question from User:* \`${userChatId}\` (U: @${msg.from.username || msg.from.first_name || 'N/A'})\n\n` +
            `*Message:* ${userQuestion}\n\n` + // This is now safe to send
            `_Reply to this message to send your response back to the user._`,
            { parse_mode: 'Markdown' }
        );

        forwardingContext[adminMessage.message_id] = {
            original_user_chat_id: userChatId,
            original_user_message_id: userMessageId,
            request_type: 'support_question'
        };

        await bot.sendMessage(userChatId, 'Your question has been sent to the admin. You will be notified when they reply.');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, 'Failed to send your question to the admin. Please try again later.');
    }
});


// Admin command to add a temporary number
// Updated /addnum command handler
bot.onText(/^\/addnum (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    // --- THIS IS THE FIX ---
    // Remove all whitespace (spaces, tabs, etc.) from the input number
    const number = match[1].replace(/\s/g, '');

    // The rest of the validation and logic remains the same
    if (!/^\+\d{10,15}$/.test(number)) {
        return bot.sendMessage(adminId, "Invalid number format. Please use the full international format, e.g., `+48 699 524 995`", { parse_mode: 'Markdown' });
    }

    const maskedNumber = number.slice(0, 6) + '***' + number.slice(-3);

    try {
        await pool.query("INSERT INTO temp_numbers (number, masked_number) VALUES ($1, $2)", [number, maskedNumber]);
        await bot.sendMessage(adminId, `Successfully added number \`${number}\` to the database.`, { parse_mode: 'Markdown' });
    } catch (e) {
        if (e.code === '23505') { 
            return bot.sendMessage(adminId, `⚠️ Number \`${number}\` already exists in the database.`, { parse_mode: 'Markdown' });
        }
        console.error(`Error adding number ${number}:`, e);
        await bot.sendMessage(adminId, `Failed to add number. An error occurred.`);
    }
});


// Admin command to remove a temporary number
bot.onText(/^\/removenum (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }
    
    const number = match[1].trim();
    try {
        const result = await pool.query("DELETE FROM temp_numbers WHERE number = $1", [number]);
        if (result.rowCount > 0) {
            await bot.sendMessage(adminId, `Successfully removed number \`${number}\` from the database.`, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(adminId, `⚠Number \`${number}\` not found in the database.`, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error(`Error removing number ${number}:`, e);
        await bot.sendMessage(adminId, `Failed to remove number. An error occurred.`);
    }
});


bot.onText(/^\/stats$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    await dbServices.updateUserActivity(cid);

    try {
        // Active Bot Stats
        const botCountsResult = await pool.query('SELECT bot_type, COUNT(bot_name) as count FROM user_bots GROUP BY bot_type');
        let levanterCount = 0, raganorkCount = 0;
        botCountsResult.rows.forEach(row => {
            if (row.bot_type === 'levanter') levanterCount = parseInt(row.count, 10);
            else if (row.bot_type === 'raganork') raganorkCount = parseInt(row.count, 10);
        });
        const totalUsers = (await pool.query('SELECT COUNT(DISTINCT user_id) AS count FROM user_bots')).rows[0].count;
        const totalBots = levanterCount + raganorkCount;

        // Backup Bot Stats
        const backupCountsResult = await backupPool.query('SELECT bot_type, COUNT(app_name) as count FROM user_deployments GROUP BY bot_type');
        let backupLevanterCount = 0, backupRaganorkCount = 0;
        backupCountsResult.rows.forEach(row => {
            if (row.bot_type === 'levanter') backupLevanterCount = parseInt(row.count, 10);
            else if (row.bot_type === 'raganork') backupRaganorkCount = parseInt(row.count, 10);
        });
        const totalBackupBots = backupLevanterCount + backupRaganorkCount;

        // --- START OF NEW LOGIC: Logged Out Bot Stats ---
        const loggedOutResult = await pool.query(`SELECT bot_name, bot_type FROM user_bots WHERE status = 'logged_out'`);
        const loggedOutBots = loggedOutResult.rows;
        const totalLoggedOut = loggedOutBots.length;

        const loggedOutLevanter = loggedOutBots.filter(b => b.bot_type === 'levanter').map(b => `  - \`${b.bot_name}\``).join('\n');
        const loggedOutRaganork = loggedOutBots.filter(b => b.bot_type === 'raganork').map(b => `  - \`${b.bot_name}\``).join('\n');
        // --- END OF NEW LOGIC ---

        // --- NEW LOGIC: Query for Top Deployers ---
        const topDeployersResult = await pool.query(`
            SELECT user_id, COUNT(bot_name) AS bot_count
            FROM user_bots
            GROUP BY user_id
            ORDER BY bot_count DESC
            LIMIT 5
        `);
        const topDeployers = [];
        for (const row of topDeployersResult.rows) {
            try {
                const chat = await bot.getChat(row.user_id);
                const userName = chat.username ? `@${escapeMarkdown(chat.username)}` : escapeMarkdown(chat.first_name || 'N/A');
                topDeployers.push(`- ${userName} (Bots: ${row.bot_count})`);
            } catch (e) {
                // If bot can't get chat info, fall back to user ID
                topDeployers.push(`- \`${row.user_id}\` (Bots: ${row.bot_count})`);
            }
        }
        const topDeployersList = topDeployers.length > 0 ? topDeployers.join('\n') : 'No users found.';
        // --- END NEW LOGIC ---

        const activeKeys = await dbServices.getAllDeployKeys();
        const keyDetails = activeKeys.length > 0 ? activeKeys.map(k => `\`${k.key}\` (Uses: ${k.uses_left})`).join('\n') : 'No active deploy keys.';
        const totalFreeTrialUsers = (await pool.query('SELECT COUNT(user_id) AS count FROM temp_deploys')).rows[0].count;
        const totalBannedUsers = (await pool.query('SELECT COUNT(user_id) AS count FROM banned_users')).rows[0].count;

        let statsMessage = `
*Bot Statistics:*

*Total Unique Users:* ${totalUsers}
*Total Deployed Bots:* ${totalBots}
  - *Levanter Bots:* ${levanterCount}
  - *Raganork Bots:* ${raganorkCount}

*Total Backup Bots:* ${totalBackupBots}
  - *Levanter Backups:* ${backupLevanterCount}
  - *Raganork Backups:* ${backupRaganorkCount}

*Users Who Used Free Trial:* ${totalFreeTrialUsers}
*Total Banned Users:* ${totalBannedUsers}

*Top Deployers:*
${topDeployersList}

*Active Deploy Keys:*
${keyDetails}
        `;

        // --- Add the new section to the message ---
        if (totalLoggedOut > 0) {
            statsMessage += `\n*Logged Out Bots (${totalLoggedOut}):*\n`;
            if (loggedOutLevanter) {
                statsMessage += `*Levanter:*\n${loggedOutLevanter}\n`;
            }
            if (loggedOutRaganork) {
                statsMessage += `*Raganork:*\n${loggedOutRaganork}\n`;
            }
        }
        
        await bot.sendMessage(cid, statsMessage, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error fetching stats:`, error.message);
        await bot.sendMessage(cid, `An error occurred while fetching stats: ${error.message}`);
    }
});


// In bot.js, with your other commands

bot.onText(/^\/users$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;
    
    await bot.sendMessage(cid, "Please select which user group you'd like to view:", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Registered Users (Have Bots)', callback_data: 'users_registered:1' },
                    { text: 'Unregistered Users (No Bots)', callback_data: 'users_unregistered:1' }
                ]
            ]
        }
    });
});



bot.onText(/^\/list$/, async (msg) => {
    const cid = msg.chat.id.toString();
    const isAdmin = cid === ADMIN_ID;

    const commands = `
📋 **BOT COMMANDS SUMMARY**

🔧 **ADMIN COMMANDS:**
\`/menu\` - Show admin menu
\`/apps\` - List all deployed bots
\`/dbstats\` - DB stats with owner lookup
\`/sync\` - Sync databases

💾 **BACKUP & RESTORE:**
\`/backupall\` - Backup all paid bots
\`/copydb\` - Copy database
\`/restoreall\` - Restore all bots
\`/restartall\` - Restart all bots

🌐 **DATABASE:**
\`/createawsdb <name>\` - Create AWS database
\`/deleteawsdb <name>\` - Delete AWS database
\`/getawsdb <name>\` - Get AWS database info
\`/createneondb <name>\` - Create Neon database
\`/changedb <url>\` - Change database URL
\`/updatehost <ip>\` - Update database host IP

⏱️ **EXPIRATION:**
\`/expire <days>\` - Set bot expiration (admin)
\`/exp\` - View my expiration
\`/addexpall <days>\` - Add days to ALL bots
\`/addexp <days>\` - Add days to my bot
\`/addexp <user_id> <days>\` - Add days to user's bots

👥 **USER MANAGEMENT:**
\`/add <user_id>\` - Add user (free trial)
\`/deluser <user_id>\` - Delete user
\`/ban <user_id>\` - Ban user
\`/unban\` - Show banned users
\`/info <user_id>\` - User info
\`/num\` - View pending users
\`/mynum\` - My number
\`/users\` - List all users
\`/revenue\` - Revenue stats

🔍 **BOT MANAGEMENT:**
\`/findbot <name>\` - Find bot by name
\`/restart\` - Restart main bot
\`/dellogout\` - Delete logged-out bots
\`/deldb <name>\` - Delete bot database
\`/remove <user_id>\` - Remove user bot

🔐 **SECURITY:**
\`/id\` - Show my ID
\`/dkey\` - Get deployment key
\`/key <1-5>\` - Get API key

📨 **MESSAGING:**
\`/send <user_id> <text>\` - Send message to user
\`/sendall <type> <text>\` - Send to all bots
\`/askadmin <text>\` - Ask admin question

📱 **WHATSAPP & STICKERS:**
\`/pair <number>\` - Pair WhatsApp number
\`/sticker <pack>\` - Download stickers

🛠️ **OTHER:**
\`/maintenance on|off\` - Toggle maintenance
\`/addapi <url>\` - Add API endpoint
\`/apilist\` - List APIs
\`/delapi\` - Delete API
\`/editvar\` - Edit variables
\`/deployem\` - Deploy test bot
\`/updateall <type>\` - Update bot type
\`/vcf <data>\` - Generate VCF
\`/copy\` - Copy something
\`/bapp\` - Bot app info

✅ **USER COMMANDS:**
\`/start\` - Start bot
\`/menu\` - Show menu
\`/exp\` - Check expiration
\`/addexp <days>\` - Extend my bot
\`/askadmin <text>\` - Contact admin
    `;

    await bot.sendMessage(cid, commands.trim(), { parse_mode: 'Markdown' });
});


// In bot.js (REPLACE the existing /pair handler)

bot.onText(/^\/pair (\d+)$/, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const targetNumber = match[1]; // Number without '+'

    // 1. Security Check
    if (chatId !== ADMIN_ID) return;

    // 2. Get Credentials from Environment
    const messageBotUrl = process.env.MESSAGE_BOT_URL;
    const messageBotApiKey = process.env.MESSAGE_BOT_API_KEY; // This is the 'secret' parameter

    if (!messageBotUrl || !messageBotApiKey) {
        return bot.sendMessage(chatId, "**Configuration Error:** `MESSAGE_BOT_URL` or `MESSAGE_BOT_API_KEY` is missing from environment variables.", { parse_mode: 'Markdown' });
    }
    
    if (!targetNumber || targetNumber.length < 10) {
        return bot.sendMessage(chatId, 'Usage: /pair 2349012345678 (Provide full international number)');
    }
    
    const waitingMsg = await bot.sendMessage(chatId, `Connecting to external server to pair +${targetNumber}...`);

    try {
        // 3. Call External API using GET with Query Parameters
        // Format: URL/pair?number=...&secret=...
        
        const baseUrl = messageBotUrl.replace(/\/$/, ''); // Ensure no trailing slash
        
        // We use 'secret' as the parameter name based on your request
        const requestUrl = `${baseUrl}/pair?number=${targetNumber}&secret=${messageBotApiKey}`;
        
        // console.log(`[Pairing] Requesting: ${requestUrl}`); // Uncomment for debugging (Be careful with logs!)

        const response = await axios.get(requestUrl, { 
            timeout: 120000 // 120s timeout
        });

        const data = response.data;

        // 4. Check Response
        if (data.status === 'success' || data.success === true) {
            const code = data.pairing_code || data.code; 
            
            // 5. Send Success Message
            await bot.editMessageText(
                `**Pairing Code Generated!**\n\n` +
                `Number: \`+${targetNumber}\`\n\n` +
                `Code: \`${code}\`\n\n` +
                `_Tap code to copy._`, 
                {
                    chat_id: chatId,
                    message_id: waitingMsg.message_id, 
                    parse_mode: 'Markdown'
                }
            );
        } else {
            throw new Error(data.message || "Unknown API error");
        }

    } catch (error) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error("[Pairing] External API Error:", errorMsg);
        await bot.editMessageText(`**Pairing Failed.**\n\nReason: ${escapeMarkdown(errorMsg)}`, {
            chat_id: chatId,
            message_id: waitingMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
});



// --- REPLACE your old /bapp command with this one ---
bot.onText(/^\/bapp$/, (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== ADMIN_ID) return;

    const opts = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Levanter', callback_data: 'bapp_select_type:levanter' },
                    { text: 'Raganork', callback_data: 'bapp_select_type:raganork' }
                ],
                [
                    { text: 'Hermit', callback_data: 'bapp_select_type:hermit' } // <-- ADDED
                ]
            ]
        }
    };
    bot.sendMessage(chatId, 'Which bot type do you want to manage from the backup list?', opts);
});




// Replace your existing /sendall command handler with this one
bot.onText(/^\/sendall(?:\s+(levanter|raganork|hermit))?\s*([\s\S]*)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }
    
    const botType = match[1]; 
    const messageText = match[2] ? match[2].trim() : '';
    const caption = escapeMarkdown(messageText);
    const repliedMsg = msg.reply_to_message;
    const isPhoto = repliedMsg && repliedMsg.photo && repliedMsg.photo.length > 0;
    const isVideo = repliedMsg && repliedMsg.video;
    
    if (!isPhoto && !isVideo && !caption) {
         return bot.sendMessage(adminId, "Please provide a message to broadcast, optionally targeting 'levanter' or 'raganork' users.");
    }

    let userIds;
    let targetAudience = "all users with deployed bots";

    try {
        if (botType) {
            // This part already works correctly for targeted messages.
            targetAudience = `all *${botType.toUpperCase()}* users`;
            const result = await pool.query(
                'SELECT DISTINCT user_id FROM user_bots WHERE bot_type = $1',
                [botType]
            );
            userIds = result.rows.map(row => row.user_id);
        } else {
            // ❗️ FIX: This now fetches only users who have at least one bot.
            const result = await pool.query('SELECT DISTINCT user_id FROM user_bots');
            userIds = result.rows.map(row => row.user_id);
        }
    } catch (dbError) {
        return bot.sendMessage(adminId, `A database error occurred: ${dbError.message}`);
    }

    if (userIds.length === 0) {
        return bot.sendMessage(adminId, `No users found for the target audience: ${targetAudience}.`);
    }
    
    await bot.sendMessage(adminId, `Broadcasting message to ${targetAudience} (${userIds.length} users). This may take a while...`, { parse_mode: 'Markdown' });

    let successCount = 0;
    let failCount = 0;
    let blockedCount = 0;
    
    const fileId = isPhoto ? repliedMsg.photo[repliedMsg.photo.length - 1].file_id : (isVideo ? repliedMsg.video.file_id : null);

    for (const userId of userIds) {
        if (userId === adminId) continue;
        
        try {
            if (await dbServices.isUserBanned(userId)) continue;
            
            if (isPhoto) {
                await bot.sendPhoto(userId, fileId, { caption: `*Broadcast from Admin:*\n\n${caption}`, parse_mode: 'Markdown' });
            } else if (isVideo) {
                await bot.sendVideo(userId, fileId, { caption: `*Broadcast from Admin:*\n\n${caption}`, parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(userId, `*Broadcast:*\n\n${caption}`, { parse_mode: 'Markdown' });
            }
            
            successCount++;
            await new Promise(resolve => setTimeout(resolve, 100)); // Delay
        } catch (error) {
            const errorDescription = error.response?.body?.description || error.message;
            if (errorDescription.includes("bot was blocked")) {
                blockedCount++;
            } else {
                console.error(`Error sending broadcast to user ${userId}:`, errorDescription);
                failCount++;
            }
        }
    }
    
    await bot.sendMessage(adminId,
        `Broadcast complete!\n\n*Target Audience:* ${targetAudience}\n*Successfully sent:* ${successCount}\n*Blocked by user:* ${blockedCount}\n*Other failures:* ${failCount}`,
        { parse_mode: 'Markdown' }
    );
});


bot.onText(/\/sticker(?: (.+))?/, async (msg, match) => {
    // 1. Check permissions
    if (String(msg.from.id) !== ADMIN_ID) {
        return bot.sendMessage(msg.chat.id, "You are not authorized.");
    }
    
    // 2. Check that the command is used correctly
    if (!msg.reply_to_message || !msg.reply_to_message.photo) {
        return bot.sendMessage(msg.chat.id, "Please reply to a photo.");
    }

    const emojis = match[1];
    if (!emojis) {
        return bot.sendMessage(msg.chat.id, "Please provide an emoji, e.g., `/sticker 😂`");
    }

    const sentMsg = await bot.sendMessage(msg.chat.id, "Processing sticker...");
    let stickerBuffer;

    try {
        // 3. Download and process the photo
        const photo = msg.reply_to_message.photo.pop();
        const file = await bot.getFile(photo.file_id);
        
        // This URL uses the BOT_TOKEN from the top of your file
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;

        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const photoBuffer = Buffer.from(response.data, 'binary');

        stickerBuffer = await sharp(photoBuffer)
            .resize(512, 512, { 
                fit: 'contain', 
                background: { r: 0, g: 0, b: 0, alpha: 0 } 
            })
            .webp()
            .toBuffer();

    } catch (err) {
        console.error(err);
        return bot.editMessageText(`Error processing image: ${err.message}`, {
            chat_id: msg.chat.id,
            message_id: sentMsg.message_id
        });
    }

    // 4. Try to ADD the sticker
    try {
        // We use the STICKER_PACK_NAME from the top of your file
        await bot.addStickerToSet(
            msg.from.id,
            STICKER_PACK_NAME,
            stickerBuffer,
            emojis
        );
        
        await bot.editMessageText(`Sticker added!`, {
            chat_id: msg.chat.id,
            message_id: sentMsg.message_id
        });

    } catch (addError) {
        // 5. If adding failed, check if it's because the pack doesn't exist
        if (addError.response && addError.response.body.description.includes('STICKERSET_INVALID')) {
            // Pack doesn't exist. Let's create it!
            await bot.editMessageText("Pack not found, creating a new one...", {
                chat_id: msg.chat.id,
                message_id: sentMsg.message_id
            });
            
            try {
                // We use all the pre-defined constants
                await bot.createNewStickerSet(
                    msg.from.id,
                    STICKER_PACK_NAME,
                    STICKER_PACK_TITLE, // Title from the top
                    stickerBuffer,
                    emojis
                );
                
                await bot.editMessageText(`New pack created and sticker added!`, {
                    chat_id: msg.chat.id,
                    message_id: sentMsg.message_id
                });

            } catch (createError) {
                // This might fail if the name is still wrong (e.g., BOT_USERNAME is incorrect)
                console.error(createError);
                await bot.editMessageText(`Error creating new pack: ${createError.response.body.description}`, {
                    chat_id: msg.chat.id,
                    message_id: sentMsg.message_id
                });
            }
        } else {
            // It was a different error (e.g., "Too many stickers in pack")
            console.error(addError);
            await bot.editMessageText(`Error adding sticker: ${addError.response.body.description}`, {
                chat_id: msg.chat.id,
                message_id: sentMsg.message_id
            });
        }
    }
});


bot.onText(/^\/copydb$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) {
        return; // Admin only
    }

    // Ask for a simple confirmation before proceeding
    await bot.sendMessage(cid, "Are you sure you want to overwrite the backup database (`DATABASE_URL2`) with the current main database (`DATABASE_URL`)? This cannot be undone.", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Yes, proceed with copy", callback_data: 'copydb_confirm_simple' },
                    { text: "Cancel", callback_data: 'copydb_cancel' }
                ]
            ]
        }
    });
});



// In bot.js
bot.onText(/^\/backupall$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    // Just call the main task function directly when triggered manually
    runBackupAllTask(adminId); 
});


// ========== ADD EXPIRATION DAYS COMMANDS ==========

// /addexpall <days> - Add days to ALL bots in the system
bot.onText(/^\/addexpall (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;
    
    const daysToAdd = parseInt(match[1], 10);
    if (daysToAdd <= 0 || daysToAdd > 3650) {
        return bot.sendMessage(adminId, "Invalid number of days. Please use a value between 1 and 3650.");
    }
    
    try {
        const result = await pool.query(
            `UPDATE user_deployments 
             SET expiration_date = expiration_date + INTERVAL '${daysToAdd} days'
             WHERE expiration_date IS NOT NULL AND deleted_from_heroku_at IS NULL
             RETURNING user_id, app_name, expiration_date`
        );
        
        const updated = result.rowCount;
        let summary = `✅ Added ${daysToAdd} days to ${updated} bot(s).\n\n`;
        
        if (result.rows.length > 0 && result.rows.length <= 20) {
            summary += `Updated:\n`;
            result.rows.forEach((row, idx) => {
                const newDate = new Date(row.expiration_date).toLocaleDateString();
                summary += `${idx + 1}. ${row.app_name} (User: ${row.user_id}) → ${newDate}\n`;
            });
        } else if (result.rows.length > 20) {
            summary += `First 20 of ${result.rows.length} updates:\n`;
            result.rows.slice(0, 20).forEach((row, idx) => {
                const newDate = new Date(row.expiration_date).toLocaleDateString();
                summary += `${idx + 1}. ${row.app_name} (User: ${row.user_id}) → ${newDate}\n`;
            });
        }
        
        await bot.sendMessage(adminId, summary);
    } catch (error) {
        console.error('[AddExpAll] Error:', error);
        await bot.sendMessage(adminId, `Error updating expirations: ${error.message}`);
    }
});

bot.onText(/^\/addexp (\d+)$/, async (msg, match) => {
    const userId = msg.chat.id.toString();
    const daysToAdd = parseInt(match[1], 10);
    
    if (isNaN(daysToAdd) || daysToAdd <= 0) {
        return bot.sendMessage(userId, "Please provide a valid number of days.");
    }
    
    const checkingMsg = await bot.sendMessage(userId, "Scanning Heroku for all active bots...");
    
    try {
        // 1. Fetch ALL apps from Heroku API
        const herokuAppsRes = await herokuApi.get('/apps', {
            headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` }
        });
        
        const allApps = herokuAppsRes.data;
        const buttons = [];

        // 2. Filter for apps owned by this user (or all apps if admin)
        // Note: Since Heroku doesn't know your TG IDs, we cross-reference with your DB
        for (const app of allApps) {
            const appName = app.name;
            
            // Cross-check owner in DB
            const ownerCheck = await pool.query("SELECT user_id FROM user_deployments WHERE app_name = $1", [appName]);
            const ownerId = ownerCheck.rows[0]?.user_id;

            // Show if user is admin OR if user owns the bot
            if (userId === ADMIN_ID || ownerId === userId) {
                buttons.push({
                    text: appName,
                    callback_data: `addexp_select:${appName}:${daysToAdd}`
                });
            }
        }

        if (buttons.length === 0) {
            return bot.editMessageText("No active bots found on your Heroku account.", { chat_id: userId, message_id: checkingMsg.message_id });
        }

        const keyboard = chunkArray(buttons, 2);
        
        await bot.editMessageText(`Select a bot to add ${daysToAdd} days to:`, {
            chat_id: userId,
            message_id: checkingMsg.message_id,
            reply_markup: { inline_keyboard: keyboard }
        });

    } catch (error) {
        console.error('[AddExp] Error:', error.message);
        await bot.sendMessage(userId, "Failed to fetch apps from Heroku.");
    }
});



// bot.js (REPLACE the entire bot.onText(/^\/send (\d+)$/, ...) function)

// Updated regex to capture optional text after the user ID: /send <user_id> <optional_text>
bot.onText(/^\/send (\d+)\s*([\s\S]*)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    const targetUserId = match[1];
    // Capture all text after the user ID, trimming any leading/trailing whitespace
    const directCaptionOrText = match[2] ? match[2].trim() : ''; 
    
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }
    
    const repliedMsg = msg.reply_to_message;
    
    // --- Step 1: Pre-Checks ---
    
    // Check if the target user ID exists and is accessible
    try {
        await bot.getChat(targetUserId);
    } catch (e) {
        return bot.sendMessage(adminId, `❌ Cannot send: User with ID \`${targetUserId}\` not found or has blocked the bot.`, { parse_mode: 'Markdown' });
    }
    
    // Ensure there is SOMETHING to send (either a replied message OR direct text)
    if (!repliedMsg && !directCaptionOrText) {
        return bot.sendMessage(adminId, "❌ Please reply to media/file/sticker OR provide a message after the user ID to send.", { parse_mode: 'Markdown' });
    }

    try {
        let sentMessage;
        let baseOptions = { parse_mode: 'Markdown' };

        // --- Step 2: Sending Logic (Prioritize Reply Content) ---

        if (repliedMsg) {
            // A. Handle REPLIED MESSAGE (Media/File + Optional Caption)
            
            // Use caption from the replied message, but allow text from the command to overwrite it
            const mediaCaption = repliedMsg.caption ? repliedMsg.caption : '';
            const finalCaption = directCaptionOrText || mediaCaption;
            
            // Set the caption in the base options
            if (finalCaption) {
                baseOptions.caption = finalCaption;
            }

            if (repliedMsg.text) {
                // 1. Text message (if replying to text)
                const finalContent = directCaptionOrText || repliedMsg.text;
                sentMessage = await bot.sendMessage(targetUserId, finalContent, baseOptions);
            } else if (repliedMsg.photo) {
                // 2. Photo message
                const fileId = repliedMsg.photo[repliedMsg.photo.length - 1].file_id;
                sentMessage = await bot.sendPhoto(targetUserId, fileId, baseOptions);
            } else if (repliedMsg.video) {
                // 3. Video message
                const fileId = repliedMsg.video.file_id;
                sentMessage = await bot.sendVideo(targetUserId, fileId, baseOptions);
            } else if (repliedMsg.animation) {
                // 4. GIF (Animation)
                const fileId = repliedMsg.animation.file_id;
                sentMessage = await bot.sendAnimation(targetUserId, fileId, baseOptions);
            } else if (repliedMsg.sticker) {
                // 5. Sticker (Stickers do not support captions)
                sentMessage = await bot.sendSticker(targetUserId, repliedMsg.sticker.file_id);
            } else if (repliedMsg.document) {
                // 6. Document/File
                const fileId = repliedMsg.document.file_id;
                sentMessage = await bot.sendDocument(targetUserId, fileId, baseOptions);
            } else {
                // Fallback for unsupported types (like voice notes, video notes, etc.)
                return bot.sendMessage(adminId, `⚠️ The replied message type is not supported for direct sending.`, { parse_mode: 'Markdown' });
            }
        } else if (directCaptionOrText) {
            // B. Handle DIRECT TEXT/CAPTION (If no reply message)
            
            // 7. Text from command line
            sentMessage = await bot.sendMessage(targetUserId, directCaptionOrText, baseOptions);
        }


        // --- Step 3: Confirmation ---
        await bot.sendMessage(adminId, `Message successfully sent (without forwarding tag) to user \`${targetUserId}\`.`, { parse_mode: 'Markdown' });
        
    } catch (error) {
        const escapedError = escapeMarkdown(error.message);
        console.error(`Error manually sending content to user ${targetUserId}:`, escapedError);
        
        await bot.sendMessage(adminId, `Failed to send content to user \`${targetUserId}\`: ${escapedError}`, { parse_mode: 'Markdown' });
    }
});





// In bot.js (REPLACE this handler)

bot.onText(/^\/revenue$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()).toISOString();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()).toISOString(); 

        const todayResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [todayStart]);
        const weekResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [weekStart]);
        const monthResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [monthStart]);
        const threeMonthsResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments WHERE paid_at >= $1", [threeMonthsAgo]);
        const allTimeResult = await pool.query("SELECT SUM(amount) as total, COUNT(reference) as count FROM completed_payments");

        const formatRevenue = (result) => {
            const total = result.rows[0].total || 0; // This is in Kobo
            const count = result.rows[0].count || 0;
            // --- 💡 FIX: Divide by 100, remove decimals, and format ---
            return `₦${(total / 100).toFixed(0).toLocaleString()} (${count} sales)`;
        };

        const revenueMessage = `
*Sales Revenue:*

*Today:* ${formatRevenue(todayResult)}
*This Week:* ${formatRevenue(weekResult)}
*This Month:* ${formatRevenue(monthResult)}
*Last 3 Months:* ${formatRevenue(threeMonthsResult)}
*All Time:* ${formatRevenue(allTimeResult)}
        `;
        
        await bot.sendMessage(cid, revenueMessage, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error("Error fetching revenue:", error);
        await bot.sendMessage(cid, "An error occurred while calculating revenue.");
    }
});





// NEW ADMIN COMMAND: /ban <user_id>
bot.onText(/^\/ban (\d+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    const targetUserId = match[1];

    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    if (targetUserId === ADMIN_ID) {
        return bot.sendMessage(adminId, "You cannot ban yourself, admin.");
    }

    const isBanned = await dbServices.isUserBanned(targetUserId); // Use dbServices
    if (isBanned) {
        return bot.sendMessage(adminId, `User \`${targetUserId}\` is already banned.`, { parse_mode: 'Markdown' });
    }

    const banned = await dbServices.banUser(targetUserId, adminId); // Use dbServices
    if (banned) {
        await bot.sendMessage(adminId, `User \`${targetUserId}\` has been banned.`, { parse_mode: 'Markdown' });
        try {
            await bot.sendMessage(targetUserId, `You have been banned from using this bot by the admin. All bot functions are now unavailable.`);
        } catch (error) {
            console.warn(`Could not notify banned user ${targetUserId}: ${error.message}`);
        }
    } else {
        await bot.sendMessage(adminId, `Failed to ban user \`${targetUserId}\`. Check logs.`, { parse_mode: 'Markdown' });
    }
});

// ADMIN COMMAND: /editvar to show the variable selection menu
bot.onText(/^\/editvar$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    // Check if the required Render keys are set up first
    if (!process.env.RENDER_API_KEY || !process.env.RENDER_SERVICE_ID) {
        return bot.sendMessage(adminId, "**Setup Incomplete:** Please set `RENDER_API_KEY` and `RENDER_SERVICE_ID` in your bot's environment to use this feature.");
    }

    // Create a button for each editable variable
    const buttons = EDITABLE_RENDER_VARS.map(varName => ([{
        text: varName,
        callback_data: `editvar_select:${varName}`
    }]));

    await bot.sendMessage(adminId, "Please select the Render environment variable you wish to edit:", {
        reply_markup: {
            inline_keyboard: buttons
        }
    });
});


// ADMIN COMMAND: /delapi to start the key deletion process
bot.onText(/^\/delapi$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    await sendApiKeyDeletionList(adminId);
});


bot.onText(/^\/findbot (.+)$/, async (msg, match) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    const appName = match[1].trim();

    try {
        const botInfoResult = await pool.query(
    `SELECT ub.user_id, ub.bot_type, ub.status, ud.expiration_date, ud.is_free_trial, ud.deploy_date
     FROM user_bots ub
     LEFT JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
     WHERE ub.bot_name = $1`,
    [appName]
);


        if (botInfoResult.rows.length === 0) {
            return bot.sendMessage(cid, `Sorry, no bot named \`${appName}\` was found in the database.`, { parse_mode: 'Markdown' });
        }

        const botInfo = botInfoResult.rows[0];
        const ownerId = botInfo.user_id;

        // FIX: The ownerDetails string is now fully escaped.
        let ownerDetails = `*Owner ID:* \`${escapeMarkdown(ownerId)}\``;
        try {
            const ownerChat = await bot.getChat(ownerId);
            const ownerName = `${ownerChat.first_name || ''} ${ownerChat.last_name || ''}`.trim();
            ownerDetails += `\n*Owner Name:* ${escapeMarkdown(ownerName)}`;
            if (ownerChat.username) {
                ownerDetails += `\n*Owner Username:* @${escapeMarkdown(ownerChat.username)}`;
            }
        } catch (e) {
            ownerDetails += "\n_Could not fetch owner's Telegram profile._";
        }

        // FIX: The expirationInfo string is now fully escaped.
        let expirationInfo = escapeMarkdown("Not Set");
        if (botInfo.is_free_trial) {
            const deployDate = new Date(botInfo.deploy_date);
            const expirationDate = new Date(deployDate.getTime() + 1 * 24 * 60 * 60 * 1000); // 3 days for free trial
            const now = new Date();
            const timeLeftMs = expirationDate.getTime() - now.getTime();
            const daysLeft = Math.ceil(timeLeftMs / (1000 * 60 * 60 * 24));

            if (daysLeft > 0) {
                expirationInfo = escapeMarkdown(`${daysLeft} days remaining (Free Trial)`);
            } else {
                expirationInfo = escapeMarkdown('Expired (Free Trial)');
            }
        } else if (botInfo.expiration_date) {
            const expiration = new Date(botInfo.expiration_date);
            const now = new Date();
            const daysLeft = Math.ceil((expiration - now) / (1000 * 60 * 60 * 24));
            expirationInfo = escapeMarkdown(daysLeft > 0 ? `${daysLeft} days remaining` : "Expired");
        }


        const botStatus = botInfo.status === 'online' ? 'Online' : 'Logged Out';

        // FIX: The final response string is now fully escaped to prevent errors.
        const response = `
*Bot Details for: \`${appName}\`*

*Owner Info:*
${ownerDetails}

*Bot Info:*
*Type:* ${escapeMarkdown(botInfo.bot_type ? botInfo.bot_type.toUpperCase() : 'Unknown')}
*Status:* ${escapeMarkdown(botStatus)}
*Expiration:* ${expirationInfo}
        `;

        await bot.sendMessage(cid, response, { parse_mode: 'Markdown' });

    } catch (error) {
        console.error(`Error during /findbot for "${appName}":`, error);
        await bot.sendMessage(cid, `An error occurred while searching for the bot.`);
    }
});


// ADMIN COMMAND: /restart to restart the bot's own Render service remotely
bot.onText(/^\/restart$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    // Security: Only the admin can use this command.
    if (adminId !== ADMIN_ID) return;

    // Check if the necessary API keys are configured in your environment.
    const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
        return bot.sendMessage(adminId, "**Setup Incomplete:** `RENDER_API_KEY` and `RENDER_SERVICE_ID` must be set in your bot's environment to use this feature.");
    }

    const workingMsg = await bot.sendMessage(adminId, "Sending restart command to Render...");

    try {
        const headers = {
            'Authorization': `Bearer ${RENDER_API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        
        // This is the Render API endpoint to trigger a new deployment (which restarts the app).
        const deployUrl = `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/deploys`;
        
        // We send a POST request with an empty body to trigger the restart.
        await axios.post(deployUrl, {}, { headers });

        // On success, notify the admin.
        await bot.editMessageText(
            "**Restart Triggered!**\n\nRender has started a new deployment. The bot will go offline and should be back online within a minute or two.",
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );

    } catch (error) {
        // If the API call fails, report the error.
        console.error("Error restarting Render service:", error.response?.data || error.message);
        const errorDetails = error.response?.data?.message || 'An unknown API error occurred.';
        await bot.editMessageText(
            `**Failed to trigger restart!**\n\n**Reason:** ${errorDetails}\n\nPlease check your Render API Key and Service ID.`,
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
    }
});


// NEW CODE
bot.onText(/^\/unban$/, async (msg) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return;
    await sendBannedUsersList(adminId);
});

// --- NEW COMMAND: /updateall <botType> ---
bot.onText(/^\/updateall (levanter|raganork|hermit)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) {
        return bot.sendMessage(adminId, "You are not authorized to use this command.");
    }

    const botType = match[1];

    try {
        const allBots = await pool.query('SELECT bot_name FROM user_bots WHERE bot_type = $1', [botType]);
        const botCount = allBots.rows.length;

        if (botCount === 0) {
            return bot.sendMessage(adminId, `No *${botType.toUpperCase()}* bots found in the database to update.`, { parse_mode: 'Markdown' });
        }

        const confirmMessage = `You are about to trigger a mass redeployment for all *${botCount}* *${botType.toUpperCase()}* bots. This will cause a brief downtime for each bot. Do you want to proceed?`;
        
        await bot.sendMessage(adminId, confirmMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Yes, Proceed', callback_data: `confirm_updateall:${botType}` }],
                    [{ text: 'Cancel', callback_data: `cancel_updateall` }]
                ]
            }
        });
    } catch (error) {
        console.error(`Error with /updateall command:`, error.message);
        await bot.sendMessage(adminId, `An error occurred: ${error.message}`, { parse_mode: 'Markdown' });
    }
});


bot.onText(/^\/createneondb (.+)$/, async (msg, match) => {
    const adminId = msg.chat.id.toString();
    if (adminId !== ADMIN_ID) return; // Admin only

    const newDbName = match[1];

    const workingMsg = await bot.sendMessage(adminId, `Attempting to create new database: \`${newDbName}\`...`);

    const result = await createNeonDatabase(newDbName);

    if (result.success) {
        await bot.editMessageText(
            `**Database Created!**\n\n` +
            `**Name:** \`${result.db_name}\`\n` +
            `**Connection URL:** \`${result.connection_string}\``,
            { 
                chat_id: adminId, 
                message_id: workingMsg.message_id, 
                parse_mode: 'Markdown' 
            }
        );
    } else {
        await bot.editMessageText(
            `**Failed to create database!**\n\n*Reason:* ${escapeMarkdown(result.error)}`, 
            { 
                chat_id: adminId, 
                message_id: workingMsg.message_id, 
                parse_mode: 'Markdown' 
            }
        );
    }
});





bot.onText(/^\/restoreall$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    await bot.sendMessage(cid, "Select the Bot Type you want to restore all instances of:", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "Restore All Levanter", callback_data: "mass_restore:levanter" }],
                [{ text: "Restore All Raganork", callback_data: "mass_restore:raganork" }],
                [{ text: "Restore All Hermit", callback_data: "mass_restore:hermit" }]
            ]
        }
    });
});



// NEW COMMAND: /restartall - Restart all bots of a selected type
bot.onText(/^\/restartall$/, async (msg) => {
    const cid = msg.chat.id.toString();
    if (cid !== ADMIN_ID) return;

    await bot.sendMessage(cid, "Please select the bot type you wish to restart:", {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Levanter', callback_data: 'restart_all_bots:levanter' },
                    { text: 'Raganork', callback_data: 'restart_all_bots:raganork' }
                ]
            ]
        }
    });
});


// REPLACE your entire bot.on('message', ...) function with this:
bot.on('message', async msg => {
    const text = msg.text?.trim() || ""; 
    const cid = msg.chat.id.toString();
    const st = userStates[cid];
  if (msg.text && msg.text.startsWith('/')) {
  return; 
}



    // --- Step 1: Universal Security Check ---
    // This runs first for every message type to block banned users.
    if (cid !== ADMIN_ID) {
        const banned = await dbServices.isUserBanned(cid);
        if (banned) {
            console.log(`[Security] Banned user ${cid} (message_id: ${msg.message_id}) interaction blocked.`);
            return;
        }
    }

    // --- Step 2: Handle High-Priority Special Data (from Mini App) ---
    // This block is checked immediately after security. This is the key fix.
    if (msg.web_app_data) {
        try {
            const data = JSON.parse(msg.web_app_data.data);
            console.log("[MiniApp] Data received from Mini App:", data);
            console.log("[MiniApp] User state:", userStates[cid]);

            const userState = userStates[cid];
            
            // NEW PATTERN: Use callback_data to trigger bot response instead of web_app_data handler
            if (userState && userState.step === 'AWAITING_MINI_APP_VERIFICATION') {
                if (data.status === 'verified') {
                    console.log(`[MiniApp] User ${cid} passed verification - marking in DB and sending callback`);
                    
                    // Mark verification as complete in database
                    try {
                        await pool.query(
                            'UPDATE pre_verified_users SET verified_at = NOW() WHERE user_id = $1',
                            [cid]
                        );
                    } catch (dbErr) {
                        console.warn('[MiniApp] DB update error:', dbErr.message);
                    }
                    
                    // Update state for callback processing
                    userStates[cid] = { step: 'FREE_TRIAL_VERIFIED', data: { verifiedAt: new Date(), miniAppMessageId: userState.miniAppMessageId } };
                    
                    // Delete mini app message
                    if (userState.miniAppMessageId) {
                        bot.deleteMessage(cid, userState.miniAppMessageId).catch(e => 
                            console.warn(`[MiniApp] Could not delete message:`, e.message)
                        );
                    }
                    
                    // Send verification success with callback button that triggers next step
                    await bot.sendMessage(cid, 
                        "*Security check passed!*\n\nYour IP address and location have been verified.\n\n**Final step:** Join our support channel and click below to proceed.",
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Join Channel', url: MUST_JOIN_CHANNEL_LINK }],
                                    [{ text: 'I have joined - Proceed!', callback_data: 'verify_join_after_miniapp' }]
                                ]
                            }
                        }
                    );
                    
                    console.log(`[MiniApp] Callback setup complete for user ${cid}`);
                } else {
                    // Verification failed
                    const reason = data.reason || data.error || "An unknown issue occurred.";
                    console.warn(`[MiniApp] User ${cid} failed verification: ${reason}`);
                    
                    // Delete mini app message
                    if (userState.miniAppMessageId) {
                        bot.deleteMessage(cid, userState.miniAppMessageId).catch(e => 
                            console.warn(`[MiniApp] Could not delete message:`, e.message)
                        );
                    }
                    
                    delete userStates[cid];
                    
                    // Send error and retry button
                    await bot.sendMessage(cid, 
                        `*Verification failed*\n\n*Reason:* ${escapeMarkdown(reason)}\n\nPlease try again or contact support.`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Try Again', callback_data: 'free_trial_start' }],
                                    [{ text: 'Contact Support', url: `https://t.me/${SUPPORT_USERNAME}` }]
                                ]
                            }
                        }
                    );
                }
            } else {
                // Non-free-trial verification - still use callback pattern
                if (data.status === 'verified') {
                    console.log(`[MiniApp] Regular verification passed for user ${cid}`);
                    
                    if (userState && userState.miniAppMessageId) {
                        bot.deleteMessage(cid, userState.miniAppMessageId).catch(e => 
                            console.warn(`[MiniApp] Could not delete message:`, e.message)
                        );
                    }
                    
                    // Update state and show callback button
                    userStates[cid] = { step: 'VERIFICATION_COMPLETE' };
                    
                    await bot.sendMessage(cid, 
                        "*Security check passed!*\n\n**Next step:** Join our channel and continue.",
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: 'Join Channel', url: MUST_JOIN_CHANNEL_LINK }],
                                    [{ text: 'I have joined', callback_data: 'verify_join_after_miniapp' }]
                                ]
                            }
                        }
                    );
                }
            }
        } catch (err) {
            console.error("[MiniApp] Failed to parse web_app_data:", err.message);
            await bot.sendMessage(cid, "An error occurred during verification. Please try again.", {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Retry', callback_data: 'free_trial_start' }]]
                }
            });
        }
        return; // Stop processing - callback will handle next steps
    }

    



    // --- Step 3: Handle Regular Text-Based Commands ---
    // This only runs if the message was not from the Mini App.
    // If the message has no text (e.g., a sticker, photo), ignore it.
    if (!text) 
        return;
  
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        // This message is from a group. Pass it to the group handler.
        // The group handler will manage commands, logging, and @admin calls.
        await handleGroupCommand(msg);
        return; // Stop. Do not let group messages fall through to the state machine.
    }

    // --- Step 5: Handle Private Chat / Bot Commands ---
    // (If we are here, it's a private chat with the bot)


  // Now the rest of your code for handling text messages will run correctly
  await dbServices.updateUserActivity(cid); 
  await notifyAdminUserOnline(msg); 
    
     

  if (isMaintenanceMode && cid !== ADMIN_ID) {
      await bot.sendMessage(cid, "Bot is currently undergoing maintenance. Please check back later.");
      return;
  }

  // ... the rest of your message handler code (if (text === 'More Features'), etc.)


 // Automatic Keyboard Update Check
const userActivity = await pool.query('SELECT keyboard_version FROM user_activity WHERE user_id = $1', [cid]);
if (userActivity.rows.length > 0) {
    const userVersion = userActivity.rows[0].keyboard_version || 0;
    if (userVersion < KEYBOARD_VERSION) {
        await sendLatestKeyboard(cid);
    }
}

  
  const isAdmin = cid === ADMIN_ID;

  if (isAdmin && st && st.step === 'AWAITING_ADMIN_PAIRING_CODE_INPUT') {
      const pairingCode = text.trim();
      const pairingCodeRegex = /^[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}$/;

      if (!pairingCodeRegex.test(pairingCode)) {
          return bot.sendMessage(cid, 'Invalid pairing code format. Please send a 9-character alphanumeric code with a hyphen (e.g., `ABCD-1234`).');
      }

      const { targetUserId, userWaitingMessageId, userAnimateIntervalId, botType } = st.data; // Get botType from state

      // MODIFICATION 1: Change user's waiting message to "Pairing code available!"
      // Ensure this message is NOT edited back by animateMessage if it's still running
      if (userAnimateIntervalId) {
          clearInterval(userAnimateIntervalId); // Stop the animation for the previous "Admin getting your pairing code..." message
      }
      if (userWaitingMessageId) {
          await bot.editMessageText(`Pairing code available!`, { // Updated message, no emoji, final message
              chat_id: targetUserId,
              message_id: userWaitingMessageId
          }).catch(err => console.error(`Failed to edit user's waiting message to "Pairing code available!": ${err.message}`));
      }
      // END MODIFICATION 1

      try {
          await bot.sendMessage(targetUserId,
              `Your Pairing-code is:\n\n` +
              `\`${pairingCode}\`\n\n` +
              `Tap to Copy the CODE and paste it to your WhatsApp linked device as soon as possible!\n\n` +
              `When you are ready, tap the 'Deploy' button to continue.`,
              { parse_mode: 'Markdown' }
          );
          await bot.sendMessage(cid, `Pairing code sent to user \`${targetUserId}\`. Bot Type: ${botType}.`);

          delete userStates[targetUserId];
          delete userStates[cid];
          console.log(`[Pairing] Pairing code sent by admin to user ${targetUserId}. Admin and user states cleared/updated.`);

      } catch (e) {
          console.error(`Error sending pairing code to user ${targetUserId}:`, e);
          await bot.sendMessage(cid, `Failed to send pairing code to user \`${targetUserId}\`. They might have blocked the bot or the chat no longer exists.`);
      }
      return;
  }

  if (st && st.step === 'AWAITING_OTHER_VAR_VALUE') {
      const { APP_NAME, VAR_NAME, targetUserId: targetUserIdFromState, botType } = st.data; // Get botType from state
      const varValue = text.trim();

      try {
          await bot.sendChatAction(cid, 'typing');
          const updateMsg = await bot.sendMessage(cid, `Updating *${VAR_NAME}* for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

          console.log(`[API_CALL] Patching Heroku config vars for ${APP_NAME}: { ${VAR_NAME}: '***' }`);
          const patchResponse = await axios.patch(
              `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
              { [VAR_NAME]: varValue },
              {
                  headers: {
                      Authorization: `Bearer ${HEROKU_API_KEY}`,
                      Accept: 'application/vnd.heroku+json; version=3',
                      'Content-Type': 'application/json'
                  }
              }
          );
          console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${APP_NAME}. Status: ${patchResponse.status}`);

          await bot.editMessageText(`Variable *${VAR_NAME}* for "*${APP_NAME}*" updated successfully!`, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'Markdown'
          });
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL_ERROR] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
      } finally {
          delete userStates[cid];
      }
      return;
  }


if (st && st.step === 'LOGOUT_RECOVERY_CHAT') {
    bot.sendChatAction(cid, 'typing');

    // Track how many attempts the AI has made to help the user
    st.data.attempts = (st.data.attempts || 0) + 1;

    const prompt = `
      The user's bot '${st.data.botName}' is logged out.
      User message: "${text}"
      Attempt number: ${st.data.attempts}
      
      ## YOUR INSTRUCTIONS:
      1. If the user says the issue is NOT solved, they "tried it and it failed", or if this is Attempt #3, set intent to 'ESCALATE_TO_ADMIN'.
      2. If the user is asking a question, try to solve it simply.
      3. If the issue is solved, set intent to 'SOLVED'.
      
      Output JSON only: {"intent": "...", "response": "..."}
    `;

    try {
        const result = await geminiModel.generateContent(prompt);
        const aiResponse = JSON.parse(result.response.text());

        // --- CASE 1: ESCALATION TO ADMIN ---
        if (aiResponse.intent === 'ESCALATE_TO_ADMIN' || st.data.attempts >= 3) {
            delete userStates[cid]; // End the AI session

            // 1. Notify Admin with Context
            const adminAlert = `
**ADMIN HELP REQUIRED**
User ID: \`${cid}\`
Bot Name: \`${st.data.botName}\`
Status: AI Troubleshooting Failed after ${st.data.attempts} attempts.
User Message: _"${text}"_

_Reply to this message to chat with the user._
            `;
            await bot.sendMessage(ADMIN_ID, adminAlert, { parse_mode: 'Markdown' });

            // 2. Inform User
            return bot.sendMessage(cid, "I'm sorry I couldn't resolve this for you. I have escalated this issue to our Admin. They will review your logs and message you directly here shortly.");
        }

        // --- CASE 2: ISSUE SOLVED ---
        if (aiResponse.intent === 'SOLVED') {
            delete userStates[cid];
            return bot.sendMessage(cid, "Great! I'm glad we could get your bot back on track. Let me know if you need anything else!");
        }

        // --- CASE 3: CONTINUE TROUBLESHOOTING ---
        await bot.sendMessage(cid, aiResponse.response, { parse_mode: 'Markdown' });

    } catch (err) {
        console.error('[Escalation Error]', err);
        delete userStates[cid];
    }
    return;
}


// REPLACE your existing 'AWAITING_EMAIL' handler with this one.

if (st && st.step === 'AWAITING_EMAIL') {
    const email = text.trim().toLowerCase();
    
    // Check if the input is a valid email format
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        // --- VALID EMAIL ---
        const otp = generateOtp();
        const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

        try {
            await pool.query(
                `INSERT INTO email_verification (user_id, email, otp, otp_expires_at, is_verified) 
                 VALUES ($1, $2, $3, $4, FALSE)
                 ON CONFLICT (user_id) DO UPDATE SET
                   email = EXCLUDED.email,
                   otp = EXCLUDED.otp,
                   otp_expires_at = EXCLUDED.otp_expires_at,
                   is_verified = FALSE`,
                [cid, email, otp, otpExpiresAt]
            );

            const emailSent = await sendVerificationEmail(email, otp);

            if (emailSent) {
                st.step = 'AWAITING_OTP';
                // --- THIS IS THE UPDATED MESSAGE AND KEYBOARD ---
                await bot.sendMessage(cid, `Code sent to **${email}**. Please enter the verification code.\n\n_The code expires in 10 minutes._`, { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: 'Resend Code', callback_data: 'resend_otp' },
                                { text: 'Change Email', callback_data: 'change_email' }
                            ]
                        ]
                    }
                });
            } else {
                delete userStates[cid];
                await bot.sendMessage(cid, 'Sorry, I couldn\'t send a verification email at this time. Please contact support or try again later.');
            }
        } catch (dbError) {
            console.error('[DB] Error saving OTP:', dbError);
            delete userStates[cid];
            await bot.sendMessage(cid, 'A database error occurred. Please try again later.');
        }
    } else {
        // --- INVALID EMAIL ATTEMPT LOGIC ---
        st.data.emailAttempts = (st.data.emailAttempts || 0) + 1;

        if (st.data.emailAttempts >= 2) {
            await bot.sendMessage(cid, 'Too many invalid attempts. Registration has been cancelled. Please tap "Deploy" to try again.');
            delete userStates[cid];
        } else {
            await bot.sendMessage(cid, "That doesn't look like a valid email address. Please try again. You have 1 attempt left.");
        }
    }
    return;
}

  // bot.js (Insert this in the bot.on('message', ...) block)

// ... existing code ...

if (st && st.step === 'AWAITING_EMAIL_FOR_AUTO_REG') {
    const email = text.trim().toLowerCase();
    
    // Check if the input is a valid email format
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        // --- VALID EMAIL ---
        
        try {
            // 1. Automatically register the email as verified (no OTP needed)
            await pool.query(
                `INSERT INTO email_verification (user_id, email, is_verified) 
                 VALUES ($1, $2, TRUE)
                 ON CONFLICT (user_id) DO UPDATE SET
                   email = EXCLUDED.email,
                   is_verified = TRUE`, // Always set to TRUE
                [cid, email]
            );

            // 2. Resume the payment process using the newly stored email
            const paymentDetails = st.data;
            const isRenewal = paymentDetails.isRenewal;
            const provider = paymentDetails.provider || 'paystack'; // Get provider, default to paystack
            
            // Determine product for metadata (needed for Flutterwave resumption)
            const product = isRenewal ? 'Bot Renewal' : `Deployment Key - ${paymentDetails.days} Days`;
            
            // Define metadata for the current transaction (needed for Flutterwave resumption)
            const resumeMetadata = {
                user_id: cid, 
                product: product,
                days: paymentDetails.days,
                appName: paymentDetails.appName,
                ...(isRenewal ? {} : { price: paymentDetails.priceNgn, botType: paymentDetails.botType }) 
            };


            // This is the message we want to edit/send the payment link to. 
            // If the messageId exists from the Paystack flow, use it to edit.
            // Otherwise, use the new message ID.
            const messageToEdit = paymentDetails.messageId 
                ? await bot.editMessageText('Email registered! Resuming payment...', { chat_id: cid, message_id: paymentDetails.messageId })
                : await bot.sendMessage(cid, `Email \`${email}\` registered and saved! Continuing payment...`, {parse_mode: 'Markdown'});
            
            const messageIdToUse = messageToEdit.message_id || msg.message_id;

            // 🚨 FIX: Payment Resumption Logic
            if (provider === 'flutterwave') {
                // Flutterwave Resumption
                const paymentUrl = await initiateFlutterwavePayment(
                    cid, 
                    email, // Use the newly saved email
                    paymentDetails.priceNgn, 
                    paymentDetails.reference, // Use the reference saved in the state
                    resumeMetadata
                );
                
                if (paymentUrl) {
                    await bot.editMessageText(
                        `Click the button below to complete your payment with Flutterwave.`, {
                            chat_id: cid,
                            message_id: messageIdToUse,
                            reply_markup: {
                                inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]]
                            }
                        }
                    );
                } else {
                     await bot.editMessageText('Sorry, an error occurred while creating the Flutterwave payment link.', { chat_id: cid, message_id: messageIdToUse });
                }

            } else {
                // Paystack Resumption (Original Logic)
                await initiatePaystackPayment(cid, messageIdToUse, {
                    isRenewal: isRenewal, 
                    appName: paymentDetails.appName, 
                    days: paymentDetails.days, 
                    priceNgn: paymentDetails.priceNgn,
                    botType: paymentDetails.botType,
                    APP_NAME: paymentDetails.APP_NAME,
                    SESSION_ID: paymentDetails.SESSION_ID
                });
            }

        } catch (dbError) {
            console.error('[DB] Error saving and resuming payment:', dbError);
            await bot.sendMessage(cid, 'A database error occurred. Please try again later.');
        } finally {
            delete userStates[cid];
        }
    } else {
        // --- INVALID EMAIL ATTEMPT LOGIC ---
        st.data.emailAttempts = (st.data.emailAttempts || 0) + 1;

        if (st.data.emailAttempts >= 2) {
            await bot.sendMessage(cid, 'Too many invalid attempts. Transaction cancelled. Please try again.');
            delete userStates[cid];
        } else {
            await bot.sendMessage(cid, "That doesn't look like a valid email address. Please try again. You have 1 attempt left.");
        }
    }
    return;
}


// In bot.js (bot.on('message'))

// 1. HANDLE SESSION ID INPUT
if (st && st.step === 'AWAITING_SWITCH_SESSION') {
    const sessionId = text.trim();
    const targetType = st.data.targetType;
    
    // Validate Session ID based on type
    let isValid = false;
    if (targetType === 'levanter' && sessionId.startsWith(LEVANTER_SESSION_PREFIX)) isValid = true;
    else if (targetType === 'raganork' && sessionId.startsWith(RAGANORK_SESSION_PREFIX)) isValid = true;
    else if (targetType === 'hermit' && sessionId.startsWith(HERMIT_SESSION_PREFIX)) isValid = true;
    
    if (!isValid) {
        return bot.sendMessage(cid, `Invalid Session ID for ${targetType}. Please try again.`);
    }
    
    // Save and Show Review
    st.data.sessionId = sessionId;
    st.step = 'AWAITING_SWITCH_CONFIRM';
    
    const reviewMsg = 
        `**Review Migration**\n\n` +
        `Bot: \`${st.data.appName}\`\n` +
        `New Type: **${targetType.toUpperCase()}**\n` +
        `Session: \`${sessionId}\`\n\n` +
        `*Your old bot will be migrated.*`;

    await bot.sendMessage(cid, reviewMsg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Confirm & Pay (₦500)', callback_data: 'confirm_switch_pay' }],
                [{ text: 'Cancel', callback_data: `selectapp:${st.data.appName}` }]
            ]
        }
    });
    return;
}

// 2. HANDLE KEY INPUT FOR SWITCH
if (st && st.step === 'AWAITING_KEY_FOR_SWITCH') {
    const keyAttempt = text.toUpperCase().trim();
    
    const usesLeft = await dbServices.useDeployKey(keyAttempt, cid);
    if (usesLeft === null) {
        return bot.sendMessage(cid, "Invalid or expired key.");
    }
    
    await bot.sendMessage(cid, "Key verified! Starting migration...");
    
    // CALL THE SERVICE FUNCTION
    await dbServices.processBotSwitch(cid, st.data.appName, st.data.targetType, st.data.sessionId);
    
    delete userStates[cid];
    return;
}

// In bot.js, inside bot.on('message', ...)

if (st && st.step === 'AWAITING_OTP') {
    const userOtp = text.trim();
    if (!/^\d{6}$/.test(userOtp)) {
        return bot.sendMessage(cid, 'Invalid code.');
    }

    try {
        const result = await pool.query(
            'SELECT otp, otp_expires_at FROM email_verification WHERE user_id = $1',
            [cid]
        );

        if (result.rows.length === 0) {
            delete userStates[cid];
            return bot.sendMessage(cid, 'Registration session expired. Please start over.');
        }

        const { otp, otp_expires_at } = result.rows[0];

        if (new Date() > new Date(otp_expires_at)) {
            delete userStates[cid];
            return bot.sendMessage(cid, 'Your verification code has expired. Please start over.');
        }

        if (userOtp === otp) {
            // --- SUCCESS! ---
            await pool.query('UPDATE email_verification SET is_verified = TRUE, otp = NULL WHERE user_id = $1', [cid]);
            const successMsg = await bot.sendMessage(cid, 'Verified successfully!');
            
            // --- UPDATED LOGIC TO HANDLE DIFFERENT ACTIONS ---
            if (st.data && st.data.action === 'renew') {
                // User was trying to renew a bot
                const appName = st.data.appName;
                delete userStates[cid];
                
                // Show the renewal pricing tiers immediately.
                await showPaymentOptions(cid, successMsg.message_id, 1500, 30, appName); // Defaulting to show standard plan
            
            } else if (st.data && st.data.action === 'view_bots') {
                // User was trying to view "My Bots"
                delete userStates[cid];
                const fakeMsg = { ...msg, text: 'My Bots' }; 
                bot.emit('message', fakeMsg); // Re-run the 'My Bots' command for them

            } else {
                // Default behavior for new users (Deploy/Free Trial)
                delete userStates[cid];
                const deployCommand = st.data.isFreeTrial ? 'Free Trial' : 'Deploy';
                const fakeMsg = { ...msg, text: deployCommand }; 
                bot.emit('message', fakeMsg);
            }
            // --- END OF UPDATED LOGIC ---

        } else {
            // Incorrect code logic
            st.data.otpAttempts = (st.data.otpAttempts || 0) + 1;
            if (st.data.otpAttempts >= 2) {
                delete userStates[cid];
                // Clear state after too many failed attempts
                await bot.sendMessage(cid, 'Too many invalid attempts. Verification cancelled. Please start over.');
            } else {
                await bot.sendMessage(cid, 'Invalid code. Please try again.');
            }
        }
    } catch (dbError) {
        console.error('[DB] Error verifying OTP:', dbError);
        delete userStates[cid];
        await bot.sendMessage(cid, 'A database error occurred during verification.');
    }
    return;
}


// --- NEW STATE: AWAITING CONTACT NAME ---
if (st && st.step === 'AWAITING_VCF_NAME') {
    const fullName = text.trim();
    if (fullName.length < 3 || fullName.length > 50) {
        return bot.sendMessage(cid, "Your name must be between 3 and 50 characters. Please try again.");
    }

    st.data.fullName = fullName;
    st.step = 'AWAITING_VCF_NUMBER';
    
    return bot.sendMessage(cid, "Great. Now, please enter your WhatsApp number in **full international format** (e.g., `+23491...`):", { parse_mode: 'Markdown' });
}

// --- NEW STATE: AWAITING CONTACT NUMBER ---
if (st && st.step === 'AWAITING_VCF_NUMBER') {
    const phoneNumber = text.trim();
    const phoneRegex = /^\+\d{10,15}$/; // Validates + followed by 10-15 digits

    if (!phoneRegex.test(phoneNumber)) {
        return bot.sendMessage(cid, "Invalid format. Please ensure the number starts with the country code (e.g., `+234...`).");
    }

    st.data.phoneNumber = phoneNumber;
    st.step = 'AWAITING_VCF_CONFIRM';

    const reviewMessage = `*Review Your Contact Details:*\n\n` +
                          `*Name:* ${escapeMarkdown(st.data.fullName)} WBD\n` +
                          `*Number:* \`${escapeMarkdown(phoneNumber)}\`\n\n` +
                          `Tap 'Submit'.`;

    await bot.sendMessage(cid, reviewMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Submit Number', callback_data: `vcf_submit_confirm` }],
                [{ text: 'Edit Details', callback_data: `vcf_start_over` }]
            ]
        }
    });
    return;
}

// In bot.js (inside bot.on('message', ...) handler)

// --- STEP 2: AWAITING GROUP LINK ---
if (st && st.step === 'AWAITING_GROUP_LINK') {
    const groupLink = text.trim();
    // Validate common WhatsApp group link format (https://chat.whatsapp.com/...)
    if (!groupLink.startsWith('https://chat.whatsapp.com/')) {
        return bot.sendMessage(cid, "❌ Invalid Link. Please send the full WhatsApp group invite link, starting with `https://chat.whatsapp.com/`.");
    }

    st.data.groupLink = groupLink;
    st.step = 'AWAITING_MEMBER_AMOUNT';

    const rate = process.env.RATE_PER_NUMBER || 50;
    
    return bot.sendMessage(cid, 
        `Group Link received. The rate is **₦${rate} per number**.\n\n` +
        `How many members do you want to add? (Min: 1, Max: 500)`, 
        { parse_mode: 'Markdown' }
    );
}

// --- STEP 3: AWAITING MEMBER AMOUNT & CONFIRMATION ---
if (st && st.step === 'AWAITING_MEMBER_AMOUNT') {
    const amount = parseInt(text.trim(), 10);
    const rate = parseInt(process.env.RATE_PER_NUMBER || '50', 10);

    if (isNaN(amount) || amount < 1 || amount > 500) {
        return bot.sendMessage(cid, "❌ Invalid Amount. Please enter a number between 1 and 500.");
    }
    
    const totalPrice = amount * rate;
    
    // Save data and transition to confirmation
    st.data.memberAmount = amount;
    st.data.totalPrice = totalPrice;
    st.step = 'AWAITING_GROUP_CONFIRM';
    
    const confirmationMessage = 
        `**ORDER SUMMARY**\n\n` +
        `**Members to Add:** ${amount}\n` +
        `**Price per Member:** ₦${rate}\n` +
        `───────────────────────\n` +
        `**TOTAL COST:** ₦${totalPrice.toLocaleString()}\n\n` +
        `Group Link: \`${st.data.groupLink}\`\n\n` +
        `Do you want to proceed with payment?`;

    await bot.sendMessage(cid, confirmationMessage, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: `Pay ₦${totalPrice.toLocaleString()}`, callback_data: `group_filler_pay:${totalPrice}` }],
                [{ text: 'Cancel Order', callback_data: 'group_filler_cancel' }]
            ]
        }
    });
    return;
}


// In bot.js, inside bot.on('message', ...)

if (st && st.step === 'AWAITING_COPY_SOURCE_URL') {
    const sourceUrl = text.trim();
    if (!sourceUrl.startsWith('postgres://')) {
        return bot.sendMessage(cid, "Invalid format. Please send the full `postgres://...` URL for the **Source** database.");
    }

    st.data = { sourceUrl: sourceUrl };
    st.step = 'AWAITING_COPY_DEST_URL';
    await bot.sendMessage(cid, "Source DB URL received.\n\nNow, please send the full URL for **Database 2 (Destination)**.\n\n⚠️ *This database will be completely erased and overwritten.*", { parse_mode: 'Markdown' });
    return;
}

if (st && st.step === 'AWAITING_COPY_DEST_URL') {
    const destUrl = text.trim();
    if (!destUrl.startsWith('postgres://')) {
        return bot.sendMessage(cid, "Invalid format. Please send the full `postgres://...` URL for the **Destination** database.");
    }

    st.data.destUrl = destUrl;
    st.step = 'AWAITING_COPY_FINAL_CONFIRM';

    await bot.sendMessage(cid, 
        `**Final Confirmation**\n\nYou are about to overwrite **Database 2** with all data from **Database 1**.\n\nThis action is irreversible.`, 
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Yes, Proceed with Copy", callback_data: "copy_external_confirm:YES" }],
                    [{ text: "Cancel", callback_data: "copy_cancel" }]
                ]
            }
        }
    );
    return;
}


  // --- REPLACE this entire block in bot.js ---

if (st && st.step === 'AWAITING_OTHER_VAR_NAME') {
    // --- FIX: Changed 'APP_NAME' to 'appName' to match the state data ---
    const { appName, targetUserId: targetUserIdFromState } = st.data;
    const varName = text.trim().toUpperCase();

    if (!/^[A-Z0-9_]+$/.test(varName)) {
        return bot.sendMessage(cid, 'Invalid variable name. Please use only uppercase letters, numbers, and underscores.');
    }

    if (varName === 'SUDO') {
        delete userStates[cid];
        await bot.sendMessage(cid, `The *SUDO* variable must be managed using "Add Number" or "Remove Number" options. How do you want to manage it for "*${appName}*"?`, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Add Number', callback_data: `sudo_action:add:${appName}` }],
                    [{ text: 'Remove Number', callback_data: `sudo_action:remove:${appName}` }],
                    [{ text: 'Back to Set Variable Menu', callback_data: `setvar:${appName}` }]
                ]
            }
        });
        return;
    }

    try {
        const configRes = await axios.get(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        );
        const existingConfigVars = configRes.data;

        if (existingConfigVars.hasOwnProperty(varName)) {
            userStates[cid].step = 'AWAITING_OVERWRITE_CONFIRMATION';
            userStates[cid].data.VAR_NAME = varName;
            userStates[cid].data.APP_NAME = appName; // Note: This should be appName
            userStates[cid].data.targetUserId = targetUserIdFromState;
            const message = `Variable *${varName}* already exists for "*${appName}*" with value: \`${escapeMarkdown(String(existingConfigVars[varName]))}\`\n\nDo you want to overwrite it?`;
            await bot.sendMessage(cid, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Yes, Overwrite', callback_data: `overwrite_var:yes:${varName}:${appName}` }],
                        [{ text: 'No, Cancel', callback_data: `overwrite_var:no:${varName}:${appName}` }]
                    ]
                }
            });
        } else {
            userStates[cid].step = 'AWAITING_OTHER_VAR_VALUE';
            userStates[cid].data.VAR_NAME = varName;
            userStates[cid].data.APP_NAME = appName; // Note: This should be appName
            userStates[cid].data.targetUserId = targetUserIdFromState;
            const botTypeForOtherVar = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';
            userStates[cid].data.botType = botTypeForOtherVar;
            return bot.sendMessage(cid, `Please enter the value for *${varName}*:`, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[API Call Error] Error checking variable existence for ${appName}:`, errorMsg);
        await bot.sendMessage(cid, `Error checking variable existence: ${escapeMarkdown(errorMsg)}`);
        delete userStates[cid];
    }
    return;
}

if (st && st.step === 'AA_CONTINUOUS_MODE') {
    const input = text.trim();

    // Allow manual exit
    if (input.toLowerCase() === 'exit') {
        clearTimeout(st.data.timeoutId);
        delete userStates[cid];
        return bot.sendMessage(cid, "AA Mode deactivated.");
    }

    // Reset the 15-min timer on every message
    clearTimeout(st.data.timeoutId);
    st.data.timeoutId = setTimeout(async () => {
        if (userStates[cid] && userStates[cid].step === 'AA_CONTINUOUS_MODE') {
            delete userStates[cid];
            await bot.sendMessage(cid, "AA Mode expired due to inactivity.");
        }
    }, 15 * 60 * 1000);

    // Parse the input: Expecting "number hours"
    const parts = input.split(' ');
    if (parts.length < 2) {
        return bot.sendMessage(cid, "Invalid input. Send: number time (e.g. 234901234567 2)");
    }

    const targetNumber = parts[0];
    const hours = parseInt(parts[1], 10);

    if (isNaN(hours) || hours <= 0) {
        return bot.sendMessage(cid, "Invalid time. Please provide hours as a number.");
    }

    const remindAt = new Date(Date.now() + (hours * 60 * 60 * 1000));

    try {
        // Save to Database (Persistent)
        await pool.query(
            "INSERT INTO reminders (user_id, target_number, remind_at, hours_duration) VALUES ($1, $2, $3, $4)",
            [cid, targetNumber, remindAt, hours]
        );

        // Start the timeout
        setTimeout(() => sendReminder(targetNumber, cid, hours), hours * 60 * 60 * 1000);

        const timeString = remindAt.toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
        await bot.sendMessage(cid, `Timer saved for ${targetNumber}. Due at ${timeString}.\n\nKeep sending or type 'exit'.`);
    } catch (e) {
        console.error("AA Mode DB Error:", e);
        await bot.sendMessage(cid, "Failed to save timer to database.");
    }
    return; // Stop processing further
}

  

if (st && st.step === 'AWAITING_RENDER_VAR_VALUE') {
    const { varName, messageId } = st.data;
    const varValue = msg.text.trim();
    const adminId = msg.chat.id.toString();

    // Clean up the state and the previous message
    delete userStates[adminId];
    await bot.deleteMessage(adminId, messageId).catch(() => {});
    
    const workingMsg = await bot.sendMessage(adminId, `⚙️ Got it. Attempting to update \`${varName}\` on Render...`);

    try {
        const { RENDER_API_KEY, RENDER_SERVICE_ID } = process.env;
        const headers = {
            'Authorization': `Bearer ${RENDER_API_KEY}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        const envVarsUrl = `https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`;

        const { data: currentEnvVars } = await axios.get(envVarsUrl, { headers });

        const varIndex = currentEnvVars.findIndex(item => item.envVar.key === varName);
        if (varIndex > -1) {
            currentEnvVars[varIndex].envVar.value = varValue;
        } else {
            currentEnvVars.push({ envVar: { key: varName, value: varValue } });
        }
        
        const payload = currentEnvVars.map(item => item.envVar);
        await axios.put(envVarsUrl, payload, { headers });

        await bot.editMessageText(
            `**Success!**\n\nVariable \`${varName}\` has been updated.\n\nA new deployment has been triggered on Render to apply the change.`,
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error("Error updating Render env var:", error.response?.data || error.message);
        const errorDetails = error.response?.data?.message || 'An unknown API error occurred.';
        await bot.editMessageText(
            `**Failed to update \`${varName}\`!**\n\n**Reason:** ${errorDetails}`,
            { chat_id: adminId, message_id: workingMsg.message_id, parse_mode: 'Markdown' }
        );
    }
    return; // Stop further message processing
}



  if (st && st.step === 'AWAITING_OVERWRITE_CONFIRMATION') {
      return bot.sendMessage(cid, 'Please use the "Yes" or "No" buttons to confirm.');
  }

  if (st && st.step === 'AWAITING_SUDO_ADD_NUMBER') {
      const { APP_NAME } = st.data;
      const phoneNumber = text.trim();

      if (!/^\d+$/.test(phoneNumber)) {
          return bot.sendMessage(cid, 'Invalid input. Please enter numbers only, without plus signs or spaces. Example: `2349163916314`');
      }

      try {
          await bot.sendChatAction(cid, 'typing');
          const updateMsg = await bot.sendMessage(cid, `Adding number to SUDO variable for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

          const configRes = await axios.get(
              `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
              {
                  headers: {
                      Authorization: `Bearer ${HEROKU_API_KEY}`,
                      Accept: 'application/vnd.heroku+json; version=3',
                      'Content-Type': 'application/json'
                  }
              }
          );
          const currentSudo = configRes.data.SUDO || '';

          const newSudoValue = currentSudo ? `${currentSudo},${phoneNumber}` : phoneNumber;

          console.log(`[API_CALL] Patching Heroku config vars for ${APP_NAME}: { SUDO: '***' }`);
          const patchResponse = await axios.patch(
              `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
              { SUDO: newSudoValue },
              {
                  headers: {
                      Authorization: `Bearer ${HEROKU_API_KEY}`,
                      Accept: 'application/vnd.heroku+json; version=3',
                      'Content-Type': 'application/json'
                  }
              }
          );
          console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${APP_NAME}. Status: ${patchResponse.status}`);

          await bot.editMessageText(`Number added to SUDO variable for "*${APP_NAME}*" successfully! New value: \`${newSudoValue}\``, {
              chat_id: cid,
              message_id: updateMsg.message_id,
              parse_mode: 'Markdown'
          });
      } catch (e) {
          const errorMsg = e.response?.data?.message || e.message;
          console.error(`[API_CALL_ERROR] Error updating SUDO variable for ${APP_NAME}:`, errorMsg, e.response?.data);
          await bot.sendMessage(cid, `Error updating SUDO variable: ${errorMsg}`);
      } finally {
          delete userStates[cid];
      }
      return;
  }

  if (st && st.step === 'AWAITING_SUDO_REMOVE_NUMBER') {
    const { APP_NAME } = st.data;
    const numberToRemove = text.trim();

    st.data.attempts = (st.data.attempts || 0) + 1;

    if (!/^\d+$/.test(numberToRemove)) {
        if (st.data.attempts >= 3) {
            delete userStates[cid];
            return bot.sendMessage(cid, 'Too many invalid attempts. Please try again later.');
        }
        return bot.sendMessage(cid, `Invalid input. Please enter numbers only, without plus signs or spaces. Example: \`2349163916314\` (Attempt ${st.data.attempts} of 3)`);
    }

    if (ADMIN_SUDO_NUMBERS.includes(numberToRemove)) {
        if (st.data.attempts >= 3) {
            delete userStates[cid];
            return bot.sendMessage(cid, "Too many attempts to remove an admin number. Please try again later.");
        }
        return bot.sendMessage(cid, `You cannot remove the admin number. (Attempt ${st.data.attempts} of 3)`);
    }

    try {
        await bot.sendChatAction(cid, 'typing');
        const updateMsg = await bot.sendMessage(cid, `Attempting to remove number from SUDO for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

        const configRes = await axios.get(
            `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        );
        const currentSudo = configRes.data.SUDO || '';
        let sudoNumbers = currentSudo.split(',').map(s => s.trim()).filter(Boolean);

        const initialLength = sudoNumbers.length;
        sudoNumbers = sudoNumbers.filter(num => num !== numberToRemove);

        if (sudoNumbers.length === initialLength) {
            if (st.data.attempts >= 3) {
                delete userStates[cid];
                return bot.editMessageText(`Number \`${numberToRemove}\` not found in SUDO variable. Too many attempts. Please try again later.`, {
                    chat_id: cid,
                    message_id: updateMsg.message_id,
                    parse_mode: 'Markdown'
                });
            }
            await bot.editMessageText(`Number \`${numberToRemove}\` not found in SUDO variable for "*${APP_NAME}*". No changes made. You have ${3 - st.data.attempts} attempts left.`, {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'Markdown'
            });
        } else {
            const newSudoValue = sudoNumbers.join(',');
            await axios.patch(
                `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
                { SUDO: newSudoValue },
                {
                    headers: {
                        Authorization: `Bearer ${HEROKU_API_KEY}`,
                        Accept: 'application/vnd.heroku+json; version=3',
                        'Content-Type': 'application/json'
                    }
                }
            );
            await bot.editMessageText(`Number \`${numberToRemove}\` removed from SUDO variable for "*${APP_NAME}*" successfully! New value: \`${newSudoValue}\``, {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'Markdown'
            });
            delete userStates[cid];
        }
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[API_CALL_ERROR] Error removing SUDO number for ${APP_NAME}:`, errorMsg, e.response?.data);
        await bot.sendMessage(cid, `Error removing number from SUDO variable: ${errorMsg}`);
    }
    return;
  }


if (msg.reply_to_message && msg.reply_to_message.from.id.toString() === botId) {
      const repliedToBotMessageId = msg.reply_to_message.message_id;
      const context = forwardingContext[repliedToBotMessageId];

      // Ensure it's the admin replying AND the context matches a support question
      if (isAdmin && context && context.request_type === 'support_question') {
          const { original_user_chat_id, original_user_message_id } = context;
          try {
              await bot.sendMessage(original_user_chat_id, `*Admin replied:*\n${msg.text}`, {
                  parse_mode: 'Markdown',
                  reply_to_message_id: original_user_message_id
              });
              await bot.sendMessage(cid, 'Your reply has been sent to the user.');
              delete forwardingContext[repliedToBotMessageId];
              console.log(`[Forwarding] Stored context for support question reply ${repliedToBotMessageId} cleared.`);
          } catch (e) {
              console.error('Error forwarding admin reply (support question):', e);
              await bot.sendMessage(cid, 'Failed to send your reply to the user. They might have blocked the bot or the chat no longer exists.');
          }
          return;
      }
      console.log(`Received reply to bot message ${repliedToBotMessageId} from ${cid} but not a support question reply or not from admin. Ignoring.`);
      return;
  }

  if (st && st.step === 'AWAITING_ADMIN_QUESTION_TEXT') {
    // ❗️ FIX: Escape the user's question text immediately.
    const userQuestion = escapeMarkdown(msg.text);
    const userChatId = cid;
    const userMessageId = msg.message_id;

    try {
        const adminMessage = await bot.sendMessage(ADMIN_ID,
            `*New Question from User:* \`${userChatId}\` (U: @${msg.from.username || msg.from.first_name || 'N/A'})\n\n` +
            `*Message:* ${userQuestion}\n\n` + // This is now safe to send
            `_Reply to this message to send your response back to the user._`,
            { parse_mode: 'Markdown' }
        );

        forwardingContext[adminMessage.message_id] = {
            original_user_chat_id: userChatId,
            original_user_message_id: userMessageId,
            request_type: 'support_question'
        };

        await bot.sendMessage(userChatId, 'Your question has been sent to the admin. You will be notified when they reply.');
    } catch (e) {
        console.error('Error forwarding message to admin:', e);
        await bot.sendMessage(userChatId, 'Failed to send your question to the admin. Please try again later.');
    } finally {
        delete userStates[cid];
    }
    return;
}

  
if (text === 'Deploy' || text === 'Free Trial') {
    const isFreeTrial = (text === 'Free Trial');

    if (isFreeTrial) {
        // --- THIS IS THE FREE TRIAL FLOW ---
        const check = await dbServices.canDeployFreeTrial(cid);
        if (!check.can) {
            const formattedDate = check.cooldown.toLocaleString('en-US', {
                timeZone: 'Africa/Lagos',
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true
            });
            return bot.sendMessage(cid, `You have already used your Free Trial. You can use it again after: ${formattedDate}\n\nWould you like to start a standard deployment instead?`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Deploy Now', callback_data: 'deploy_first_bot' }]
                    ]
                }
            });
        }

        try {
            if (!process.env.APP_URL) {
                console.error("CRITICAL: APP_URL environment variable is not set. Cannot launch Mini App.");
                return bot.sendMessage(cid, "Error: The verification service is currently unavailable. Please try again later.");
            }

            userStates[cid] = { step: 'AWAITING_MINI_APP_VERIFICATION' };
            const verificationUrl = `${process.env.APP_URL}/verify`;

            const miniAppMessage = await bot.sendMessage(cid, "*Security Verification Required*\n\nBefore you can access the free trial, we need to verify your IP address and location to prevent abuse.\n\nPlease complete the security check in the window below:", {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Start Security Check', web_app: { url: verificationUrl } }]
                    ]
                }
            });
            
            userStates[cid].miniAppMessageId = miniAppMessage.message_id;
        } catch (error) { 
            console.error("Error in free trial verification flow:", error.message);
            await bot.sendMessage(cid, "An error occurred. Please try again later.");
        }
        return;

        } else {
        // --- THIS IS THE "DEPLOY" BUTTON FLOW (MANDATORY VERIFICATION) ---
        const isVerified = await isUserVerified(cid);
    
        if (!isVerified) {
            userStates[cid] = { step: 'AWAITING_EMAIL', data: { isFreeTrial: false } };
            await bot.sendMessage(cid, 'To deploy a bot, you first need to register. Please enter your email address:');
            return;
        }
    
        // --- 🤖 NEW DYNAMIC AVAILABILITY CHECK ---
        const res = await pool.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'status_%'");
        const statusMap = Object.fromEntries(res.rows.map(r => [r.setting_key, r.setting_value]));

        const allBots = [
            { id: 'levanter', text: 'Levanter' },
            { id: 'raganork', text: 'Raganork MD' },
            { id: 'hermit', text: 'Hermit' }
        ];

        const availableBots = allBots.filter(bot => (statusMap[`status_${bot.id}`] || 'available') === 'available');

        if (availableBots.length === 0) {
            return bot.sendMessage(cid, "All bot types are currently not available. Please try again later.");
        }

        // --- 💡 FIX: Set style to 'success' for GREEN buttons ---
        const botButtons = availableBots.map(bot => ({
            text: bot.text,
            callback_data: `select_deploy_type:${bot.id}`,
            style: 'success' // 🟢 This property makes the button Green in API 9.4
        }));

        // Arrange buttons in rows of 2
        const keyboard = chunkArray(botButtons, 2);

        delete userStates[cid];
        userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: false } };
        
        await bot.sendMessage(cid, 'Which bot type would you like to deploy?', {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });
        return;
    }
}


// In bot.js, find and replace the entire "Deploy" / "Free Trial" block with this:

    
  if (text === 'Apps' && isAdmin) {
    return dbServices.sendAppList(cid); // Use dbServices
  }

  if (text === 'Generate Key' && isAdmin) {
    const buttons = [
      [1, 2, 3, 4, 5].map(n => ({
        text: String(n),
        callback_data: `genkeyuses:${n}`
      }))
    ];
    return bot.sendMessage(cid, 'How many uses for this key?', {
      reply_markup: { inline_keyboard: buttons }
    });
  }


   if (text === 'Get Session ID') {
    const cid = msg.chat.id.toString();
    delete userStates[cid]; 
    userStates[cid] = { step: 'AWAITING_GET_SESSION_BOT_TYPE', data: {} };

    try {
        // --- 🤖 DYNAMIC AVAILABILITY CHECK ---
        // Fetch current statuses set by the admin via /setbot
        const res = await pool.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key LIKE 'status_%'");
        const statusMap = Object.fromEntries(res.rows.map(r => [r.setting_key, r.setting_value]));

        // Define the bots available for session generation
        const sessionBots = [
            { id: 'levanter', text: 'Levanter' },
            { id: 'raganork', text: 'Raganork MD' },
            { id: 'hermit', text: 'Hermit' }
        ];

        // Filter only those marked as 'available'
        const availableBots = sessionBots.filter(bot => (statusMap[`status_${bot.id}`] || 'available') === 'available');

        if (availableBots.length === 0) {
            return bot.sendMessage(cid, "Bots are currently undergoing maintenance. Please try again later.");
        }

        // Create buttons with 'success' style (🟢 Green in API 9.4)
        const botButtons = availableBots.map(bot => ({
            text: bot.text,
            callback_data: `select_get_session_type:${bot.id}`,
            style: 'success' // 🟢 Makes the button GREEN
        }));

        // Arrange the dynamic buttons in rows of 2
        const keyboard = chunkArray(botButtons, 2);

        await bot.sendMessage(cid, 'Which bot type do you need a session ID for?', {
            reply_markup: {
                inline_keyboard: keyboard
            }
        });

    } catch (error) {
        console.error("Error in Get Session ID handler:", error.message);
        await bot.sendMessage(cid, "An error occurred while checking bot availability.");
    }
    return;
}
 


        // In bot.js

// In bot.js (inside the main bot.on('message', ...) handler)

if (text === 'My Bots') {
    const cid = msg.chat.id.toString();

    // --- Verification Check ---
    const isVerified = await isUserVerified(cid);
    if (!isVerified) {
        userStates[cid] = { step: 'AWAITING_EMAIL', data: { action: 'view_bots' } }; 
        await bot.sendMessage(cid, 'To manage your bots, you must first verify your email address. Please enter your email address:');
        return;
    }

    const checkingMsg = await bot.sendMessage(cid, 'Syncing your bot list with the server, please wait...');

    try {
        // 1. Get all bots from DB
        const dbBotsResult = await pool.query(
            `SELECT ub.bot_name, ub.status, ud.expiration_date, ud.deleted_from_heroku_at
             FROM user_bots ub
             LEFT JOIN user_deployments ud ON ub.user_id = ud.user_id AND ub.bot_name = ud.app_name
             WHERE ub.user_id = $1`,
            [cid]
        );
        const userBotsFromDb = dbBotsResult.rows;

        if (userBotsFromDb.length === 0) {
            await bot.editMessageText("You have no bots deployed.", {
                chat_id: cid, message_id: checkingMsg.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot', style: 'success' }],
                        [{ text: 'Restore From Backup', callback_data: 'restore_from_backup', style: 'primary' }]
                    ]
                }
            });
            return;
        }

        // 2. Cross-check with Heroku API
        const verificationPromises = userBotsFromDb.map(bot =>
            herokuApi.get(`/apps/${bot.bot_name}/formation`, {
                headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` }
            }).then(response => {
                const webDyno = response.data.find(d => d.type === 'web');
                return { ...bot, exists_on_heroku: true, is_active: webDyno && webDyno.quantity > 0 };
            }).catch(() => ({ ...bot, exists_on_heroku: false, is_active: false }))
        );

        const results = await Promise.all(verificationPromises);
        const botsToDisplay = results.filter(r => r.exists_on_heroku);

        // 3. Generate Colored Buttons
        const appButtons = botsToDisplay.map(bot => {
            let statusText = bot.is_active ? (bot.status === 'logged_out' ? 'Logged Out' : 'Connected') : 'Off';
            const expirationCountdown = formatTimeLeft(bot.expiration_date);
            
            // --- Logic for Colors ---
            let btnStyle = 'success'; // Default: Green
            let labelPrefix = '';

            const now = new Date();
            const expDate = bot.expiration_date ? new Date(bot.expiration_date) : null;
            const daysLeft = expDate ? (expDate - now) / (1000 * 60 * 60 * 24) : 99;

            // Mark Red if Logged Out, Off, or Expiring in <= 3 days
            if (bot.status === 'logged_out' || !bot.is_active || daysLeft <= 3) {
                btnStyle = 'danger'; // Red
                labelPrefix = '⚠️ ';
            }

            return { 
                text: `${labelPrefix}${bot.bot_name} - ${statusText}${expirationCountdown}`, 
                callback_data: `selectbot:${bot.bot_name}`,
                style: btnStyle // Apply API 9.4 color style
            };
        });

        const rows = chunkArray(appButtons, 2);
        
        // Restore button in Blue (Primary)
        rows.push([{ 
            text: 'Bot not found? Restore', 
            callback_data: 'restore_from_backup',
            style: 'primary' 
        }]);

        await bot.editMessageText('Select a bot to manage:', {
            chat_id: cid, 
            message_id: checkingMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: rows }
        });

    } catch (error) {
        console.error("Error in 'My Bots' handler:", error);
        await bot.editMessageText("An error occurred. Please try again.", {
            chat_id: cid, message_id: checkingMsg.message_id
        });
    }
    return;
}


if (text === 'Referrals') {
    const userId = msg.chat.id.toString();
    const referralLink = `https://t.me/${botUsername}?start=${userId}`;
    await dbServices.updateUserActivity(userId);

    // ✅ FIX: Fetch the list of referred users from the database
    const referredUsersResult = await pool.query(
        'SELECT referred_user_id, bot_name FROM user_referrals WHERE inviter_user_id = $1',
        [userId]
    );
    const referredUsers = referredUsersResult.rows;

    // --- 🎨 DESIGN UPDATE START 🎨 ---
    
    // Build the text-art message using Markdown
    let referralMessage = `*═══ YOUR REFERRALS ═══⊷*\n`;
    referralMessage += `┃❃╭──────────────\n`;
    referralMessage += `┃❃│ Share your link to earn rewards!\n`;
    referralMessage += `┃❃│ \n`;
    referralMessage += `┃❃│ *Your Link:*\n`;
    referralMessage += `┃❃│ \`${referralLink}\`\n`; // Use backticks for easy copy
    referralMessage += `┃❃│ \n`;
    referralMessage += `┃❃│ *Your Rewards:*\n`;
    referralMessage += `┃❃│ • *20 days* for a direct referral.\n`;
    referralMessage += `┃❃│ • *7 days* for a 2nd-level referral.\n`;
    referralMessage += `┃❃╰───────────────\n\n`;
    // --- 🎨 DESIGN UPDATE END 🎨 ---

    // ✅ FIX: Dynamically build the list of referred users
    if (referredUsers.length > 0) {
        referralMessage += `*Users you've successfully referred:*\n`;
        for (const ref of referredUsers) {
            try {
                const user = await bot.getChat(ref.referred_user_id);
                const userName = user.first_name || `User ${ref.referred_user_id}`;
                referralMessage += `▪️ *${escapeMarkdown(userName)}* (Bot: \`${escapeMarkdown(ref.bot_name)}\`)\n`;
            } catch (e) {
                // Fallback in case user info can't be fetched
                referralMessage += `▪️ *A user* (Bot: \`${escapeMarkdown(ref.bot_name)}\`)\n`;
            }
        }
    } else {
        referralMessage += `_You haven't referred any users yet._`;
    }

    await bot.sendMessage(userId, referralMessage, { 
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Share Your Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Deploy your own bot with my referral link!')}` }
                ]
            ]
        }
    });
}




if (text === 'More Features') {
    await dbServices.updateUserActivity(cid);
    const moreFeaturesText = "Here are some additional features and services:";

    // Check if the user has already claimed a free trial number
    const trialCheck = await pool.query("SELECT user_id FROM free_trial_numbers WHERE user_id = $1", [cid]);
    const hasUsedTrial = trialCheck.rows.length > 0;

    // --- New Logic Starts Here ---

    // 1. Create a list of all buttons that should be displayed
    const allButtons = [];

    // Conditionally add the free trial button
    if (!hasUsedTrial) {
        allButtons.push({ text: "Get a Free Trial Number", callback_data: 'free_trial_temp_num' });
    }

     // 💡 NEW BUTTON
     allButtons.push({ text: "Group Filler", callback_data: 'group_filler_start' });

    // --- 💡 ADD NEW CONTACT GAIN FEATURE 💡 ---
    allButtons.push({ text: "Contact Gain (VCF Exchange)", callback_data: 'vcf_start' });
    // --- 💡 END NEW FEATURE 💡 ---

    // Add all other standard buttons, including the new Referrals button
    allButtons.push(
        { text: "Test out my downloader Bot", url: 'https://t.me/tagtgbot' }
    );

    // 2. Arrange the buttons into rows of two
    const keyboardLayout = [];
    for (let i = 0; i < allButtons.length; i += 2) {
        const row = [allButtons[i]]; // Start a new row with the first button
        if (allButtons[i + 1]) {     // Check if a second button exists for this row
            row.push(allButtons[i + 1]);
        }
        keyboardLayout.push(row); // Add the completed row to the final layout
    }
    
    // --- New Logic Ends Here ---

    const moreFeaturesKeyboard = {
        inline_keyboard: keyboardLayout
    };
    
    await bot.sendMessage(cid, moreFeaturesText, { reply_markup: moreFeaturesKeyboard });
    return;
}


// Add this inside your bot.on('message') handler
if (text === 'Support') {
    return bot.sendMessage(cid, "Contact our official support here: @staries1", {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Message Support', url: 'https://t.me/staries1', style: 'success' }]
            ]
        }
    });
}




  if (text === 'FAQ') {
      // Clear previous state for consistency, but retain message_id if existing for edit
      if (userStates[cid] && userStates[cid].step === 'VIEWING_FAQ') {
          // If already in FAQ, just refresh the current page, no notice
          await sendFaqPage(cid, userStates[cid].faqMessageId, userStates[cid].faqPage || 1); // Use sendFaqPage
      } else {
          // First time opening FAQ
          delete userStates[cid]; // Clear previous general states
          await bot.sendMessage(cid, 'Please note that your bot might go offline temporarily at the end or beginning of every month. We appreciate your patience during these periods.');
          await sendFaqPage(cid, null, 1); // Use sendFaqPage
      }
      return;
  }

  
        
if (st && st.step === 'AWAITING_PHONE_NUMBER') {
    const phoneNumber = text;
    // Relaxed regex slightly to ensure it catches all valid formats
    const phoneRegex = /^\+\d{10,15}$/; 

    if (!phoneRegex.test(phoneNumber)) {
        const errorMessage = 'Invalid format. Please send your WhatsApp number in the full international format (e.g., `+23491630000000`).';
        const sessionUrl = (st.data.botType === 'raganork') ? RAGANORK_SESSION_SITE_URL : LEVANTER_SESSION_SITE_URL;
        
        return bot.sendMessage(cid, errorMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Get Session ID', url: sessionUrl },
                        { text: 'Deploy Now', callback_data: 'deploy_first_bot' }
                    ]
                ]
            }
        });
    }

    if (st.data.botType === 'levanter') {
        const targetNumber = phoneNumber.replace(/[^0-9]/g, '');
        const pairingUrl = process.env.PAIRING_URL;
        const callbackUrl = `${process.env.APP_URL}/api/levanter-callback`;

        // 1. Initial Loading Message
        const loadingMsg = await bot.sendMessage(cid, `Processing ${phoneNumber} [|]`, { parse_mode: 'Markdown' });

        // 2. Setup the "No-Emoji" Text Clock Animation
        const frames = ['[ | ]', '[ / ]', '[ - ]', '[ \\ ]'];
        let frameIdx = 0;
        
        const intervalId = setInterval(() => {
            const reqData = global.levanterPairingRequests.get(targetNumber);
            if (!reqData) {
                clearInterval(intervalId);
                return;
            }
            frameIdx = (frameIdx + 1) % frames.length;
            bot.editMessageText(`${reqData.baseText}\n\n${frames[frameIdx]}`, {
                chat_id: cid,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown'
            }).catch(() => {}); // Ignore rate-limit / unmodified errors
        }, 1500);

        // 3. Save to Global Map
        global.levanterPairingRequests.set(targetNumber, { 
            cid, 
            messageId: loadingMsg.message_id, 
            intervalId,
            baseText: `Processing ${phoneNumber}` 
        });

        // 4. Send request to the External PAIRING_URL
        if (!pairingUrl) {
            clearInterval(intervalId);
            global.levanterPairingRequests.delete(targetNumber);
            return bot.editMessageText(`System Error: PAIRING_URL is not configured.`, {
                chat_id: cid, message_id: loadingMsg.message_id,
                reply_markup: { inline_keyboard: [[{ text: 'Get Session Manually', url: LEVANTER_SESSION_SITE_URL }]] }
            });
        }

        axios.post(pairingUrl, {
            number: targetNumber,
            callbackUrl: callbackUrl
        }).catch(err => {
            clearInterval(intervalId);
            global.levanterPairingRequests.delete(targetNumber);
            bot.editMessageText(`Connection to pairing server failed: ${err.message}`, {
                chat_id: cid, message_id: loadingMsg.message_id,
                reply_markup: { inline_keyboard: [[{ text: 'Get Session Manually', url: LEVANTER_SESSION_SITE_URL }]] }
            });
        });

        // Clear user state so the bot can accept other commands while waiting
        delete userStates[cid];
        return;
    }
    
    // ... [Your existing manual admin logic for Raganork/Hermit goes here] ...
}



if (st && st.step === 'SESSION_ID') {
    const sessionID = text.trim();
    const botType = st.data.botType;

    let isValidSession = false;
  
    if (botType === 'levanter') {
        // (Assuming LEVANTER_SESSION_PREFIX is defined at the top of bot.js)
        if (sessionID.startsWith(LEVANTER_SESSION_PREFIX) && sessionID.length >= 10) {
            isValidSession = true;
        }
    } else if (botType === 'raganork') {
        // (Assuming RAGANORK_SESSION_PREFIX is defined at the top of bot.js)
        if (sessionID.startsWith(RAGANORK_SESSION_PREFIX) && sessionID.length >= 10) {
            isValidSession = true;
        }
    } else if (botType === 'hermit') {
        // --- 💡 NEW LOGIC 💡 ---
        // (Assuming HERMIT_SESSION_PREFIX is defined at the top of bot.js)
        if (sessionID.startsWith(HERMIT_SESSION_PREFIX) && sessionID.length >= 10) {
            isValidSession = true;
        }
        // --- 💡 END OF NEW LOGIC 💡 ---
    }

    if (!isValidSession) {
        // This is the updated logic to send an error with a button
        let botName = botType.charAt(0).toUpperCase() + botType.slice(1);
        let errorMessage = `Incorrect session ID. Your *${botName}* session ID is not valid. Please input the correct one`;
        
        // --- 💡 UPDATED URL LOGIC 💡 ---
        let sessionUrl;
        if (botType === 'raganork') {
            sessionUrl = RAGANORK_SESSION_SITE_URL;
        } else if (botType === 'hermit') {
            sessionUrl = HERMIT_SESSION_SITE_URL;
        } else {
            sessionUrl = LEVANTER_SESSION_SITE_URL;
        }
        // --- 💡 END OF UPDATE 💡 ---
        
        return bot.sendMessage(cid, errorMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Get Session ID', url: sessionUrl }]]
            }
        });
    }

    // This part runs if the session was valid
    st.data.SESSION_ID = sessionID;
    st.step = 'AWAITING_APP_NAME';
    return bot.sendMessage(cid, 'Great. Now enter a unique name for your bot (e.g., mybot123):');
}

// Now, replace it with this single, comprehensive handler.
if (st && st.step === 'AWAITING_APP_NAME') {
    const appName = text.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');

    // Validate app name format. Heroku app names can only contain lowercase letters, numbers, and dashes.
    if (!/^[a-z0-9-]{3,30}$/.test(appName)) {
        // Send a new message asking for the name again, possibly with a hint.
        await bot.sendMessage(cid, 'Invalid app name. It must be between 3 and 30 characters and only contain lowercase letters, numbers, and dashes.');
        // Don't change the state, just wait for a new valid input.
        return;
    }

    try {
        // Check if the app name is already taken on Heroku.
        await herokuApi.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        // If the request succeeds, the app exists.
        await bot.sendMessage(cid, 'That app name is already taken. Please try another one:');
        return;
    } catch (e) {
        // A 404 error is expected and means the app name is available.
        if (e.response?.status !== 404) {
            console.error(`[Heroku Check] Error checking app name existence for ${appName}:`, e.message);
            await bot.sendMessage(cid, 'An error occurred while checking the app name. Please try again later.');
            return;
        }
    }

    // App name is valid and available. Proceed to the next step.
    st.data.APP_NAME = appName;
    st.step = 'AWAITING_AUTO_STATUS_CHOICE';

    const confirmationMessage = `*Next Step:*\n` +
                                `Enable automatic status view?`;
    
    await bot.sendMessage(cid, confirmationMessage, {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Yes', callback_data: `set_auto_status_choice:true` }],
                [{ text: 'No', callback_data: `set_auto_status_choice:false` }]
            ]
        },
        parse_mode: 'Markdown'
    });
    return;
}

// ... existing code ...





  if (st && st.step === 'SETVAR_ENTER_VALUE') { // This state is reached after variable selection or overwrite confirmation
    const { APP_NAME, VAR_NAME, botType } = st.data; // Get botType from state
    const newVal = text.trim();

    if (VAR_NAME === 'SESSION_ID') {
        let isValidSession = false;
        let requiredPrefix = '';
        let errorMessage = 'Incorrect session ID.';

        // Allow empty string to clear session ID
        if (newVal === '') {
            isValidSession = true;
        } else if (botType === 'levanter') {
            requiredPrefix = LEVANTER_SESSION_PREFIX;
            if (newVal.startsWith(requiredPrefix) && newVal.length >= 10) {
                isValidSession = true;
            }
            errorMessage += ` Your session ID must start with \`${requiredPrefix}\` and be at least 10 characters long, or be empty to clear.`;
        
        } else if (botType === 'raganork') {
            requiredPrefix = RAGANORK_SESSION_PREFIX;
            if (newVal.startsWith(requiredPrefix) && newVal.length >= 10) {
                isValidSession = true;
            }
            errorMessage += ` Your Raganork session ID must start with \`${requiredPrefix}\` and be at least 10 characters long, or be empty to clear.`;
        
        // --- 💡 START OF FIX (Adding Hermit) 💡 ---
        } else if (botType === 'hermit') {
            requiredPrefix = HERMIT_SESSION_PREFIX;
            if (newVal.startsWith(requiredPrefix) && newVal.length >= 10) {
                isValidSession = true;
            }
            errorMessage += ` Your Hermit session ID must start with \`${requiredPrefix}\` and be at least 10 characters long, or be empty to clear.`;
        // --- 💡 END OF FIX 💡 ---
        
        } else {
            // This is the error you were seeing
            errorMessage = 'Unknown bot type in state. Please start the variable update process again.';
        }

        if (!isValidSession) {
            return bot.sendMessage(cid, errorMessage, { parse_mode: 'Markdown' });
        }
    }


    try {
      await bot.sendChatAction(cid, 'typing');
      const updateMsg = await bot.sendMessage(cid, `Updating *${VAR_NAME}* for "*${APP_NAME}*"...`, { parse_mode: 'Markdown' });

      console.log(`[API_CALL] Patching Heroku config vars for ${APP_NAME}: { ${VAR_NAME}: '***' }`);
      const patchResponse = await herokuApi.patch(
          `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
          { [VAR_NAME]: newVal },
          {
              headers: {
                  Authorization: `Bearer ${HEROKU_API_KEY}`,
                  Accept: 'application/vnd.heroku+json; version=3',
                  'Content-Type': 'application/json'
              }
          }
      );
      console.log(`[API_CALL_SUCCESS] Heroku config vars patched successfully for ${APP_NAME}. Status: ${patchResponse.status}`);

      if (VAR_NAME === 'SESSION_ID') {
          console.log(`[Flow] SETVAR_ENTER_VALUE: Config var updated for "${APP_NAME}". Updating bot in user_bots DB for user "${cid}".`);
          await dbServices.addUserBot(cid, APP_NAME, newVal, botType); // Use dbServices, pass botType
      }
      
      // NEW: Update config_vars in user_deployments backup
      // This logic needs to retrieve the full config and then save.
      const herokuConfigVars = (await herokuApi.get( // Fetch latest config vars
          `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
          { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
      )).data;
      // Save/Update to user_deployments with original deploy date logic (deploy_date and expiration_date are NOT touched on update)
      await dbServices.saveUserDeployment(cid, APP_NAME, herokuConfigVars.SESSION_ID, herokuConfigVars, botType); // Use dbServices, pass botType


      const baseWaitingText = `Updated ${VAR_NAME} for "${APP_NAME}". Waiting for bot status confirmation...`;
      await bot.editMessageText(`${baseWaitingText} ${getAnimatedEmoji()}`, { // Emoji at end
          chat_id: cid,
          message_id: updateMsg.message_id
      });
      const animateIntervalId = await animateMessage(cid, updateMsg.message_id, baseWaitingText);

      const appStatusPromise = new Promise((resolve, reject) => {
          appDeploymentPromises.set(APP_NAME, { resolve, reject, animateIntervalId });
      });

      const STATUS_CHECK_TIMEOUT = 180 * 1000;
      let timeoutId;

      try {
          timeoutId = setTimeout(() => {
              const appPromise = appDeploymentPromises.get(APP_NAME);
              if (appPromise) {
                  appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.`));
                  appDeploymentPromises.delete(APP_NAME);
              }
          }, STATUS_CHECK_TIMEOUT);

          await appStatusPromise;
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);

          await bot.editMessageText(
            `Your bot is now live!`,
            { chat_id: cid, message_id: updateMsg.message_id }
          );
          console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${APP_NAME}`);

      } catch (err) {
          clearTimeout(timeoutId);
          clearInterval(animateIntervalId);
          console.error(`App status check failed for ${APP_NAME} after variable update:`, err.message);
          await bot.editMessageText(
              `Bot "${APP_NAME}" failed to come online after variable "${VAR_NAME}" update: ${err.message}\n\n` +
              `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
              {
                  chat_id: cid,
                  message_id: updateMsg.message_id,
                  reply_markup: {
                      inline_keyboard: [
                          [{ text: 'Change Session ID', callback_data: `change_session:${APP_NAME}:${cid}` }]
                      ]
                  }
              }
          );
      } finally {
          appDeploymentPromises.delete(APP_NAME);
      }

      delete userStates[cid];

    } catch (e) {
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`[API_CALL_ERROR] Error updating variable ${VAR_NAME} for ${APP_NAME}:`, errorMsg, e.response?.data);
      return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
    }
}

  else {
        // If no other command or state matched, send it to Gemini
        handleFallbackWithGemini(cid, text);
  }
});

// 11) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const dataParts = q.data ? q.data.split(':') : [];
  const action = dataParts[0];
  const payload = dataParts[1];
  const extra = dataParts[2];
  const flag = dataParts[3];
  const st = userStates[cid];
  // IMPORTANT: Ban check before any other logic for non-admin users
  if (cid !== ADMIN_ID) {
      const banned = await dbServices.isUserBanned(cid); // Use dbServices
      if (banned) {
          console.log(`[Security] Banned user ${cid} attempted callback query: "${q.data}"`);
          await bot.answerCallbackQuery(q.id, { text: "You are currently banned from using this bot.", showAlert: true });
          return; // Stop processing for banned users
      }
  }

  await bot.answerCallbackQuery(q.id).catch(() => {});
  await dbServices.updateUserActivity(cid); // Update user activity on any callback query
  await notifyAdminUserOnline(q); // Call notifyAdminUserOnline for callback queries

  console.log(`[CallbackQuery] Received: action=${action}, payload=${payload}, extra=${extra}, flag=${flag} from ${cid}`);
  console.log(`[CallbackQuery] Current state for ${cid}:`, userStates[cid]);

  // --- ADD this block inside your bot.on('callback_query', ...) handler ---

if (action === 'bapp_select_type') {
    const botTypeToManage = payload;
    // Call the sendBappList function with the selected filter
    await sendBappList(cid, q.message.message_id, botTypeToManage);
}

if (action === 'addexp_select') {
    // FIX: Payload is the appName, Extra is the daysToAdd
    const appName = payload; 
    const daysToAdd = parseInt(extra, 10);
    const userId = cid;

    if (isNaN(daysToAdd)) {
        return bot.answerCallbackQuery(q.id, { text: "Error: Invalid day count.", show_alert: true });
    }

    try {
        // Update the expiration in the database
        const result = await pool.query(
            `UPDATE user_deployments 
             SET expiration_date = COALESCE(expiration_date, NOW()) + ($1 * INTERVAL '1 day')
             WHERE app_name = $2
             RETURNING expiration_date`,
            [daysToAdd, appName]
        );
        
        if (result.rowCount > 0) {
            const newDate = new Date(result.rows[0].expiration_date).toLocaleDateString('en-GB');
            await bot.answerCallbackQuery(q.id, { text: `Success: Added ${daysToAdd} days to ${appName}` });
            await bot.editMessageText(
                `Successfully added **${daysToAdd} days** to \`${appName}\`.\n\nNew Expiration: **${newDate}**`,
                { chat_id: userId, message_id: q.message.message_id, parse_mode: 'Markdown' }
            );
        } else {
            // If not in deployments table, create the record
            await bot.answerCallbackQuery(q.id, { text: "Bot record updated in system.", show_alert: true });
            const newDate = new Date(Date.now() + (daysToAdd * 24 * 60 * 60 * 1000));
            
            await pool.query(
                `INSERT INTO user_deployments (user_id, app_name, expiration_date, deploy_date) 
                 VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, app_name) 
                 DO UPDATE SET expiration_date = user_deployments.expiration_date + ($4 * INTERVAL '1 day')`,
                [userId, appName, newDate, daysToAdd]
            );
            
            await bot.editMessageText(`Bot record was missing but has been created/updated with ${daysToAdd} days.`, { chat_id: userId, message_id: q.message.message_id });
        }
    } catch (error) {
        console.error('[AddExp Callback] Error:', error);
        await bot.sendMessage(cid, `Database Error: ${error.message}`);
    }
    return;
}

// --- AWS DB FIX: Restart all bots ---
if (action === 'fix_db_restart_all') {
    if (cid !== ADMIN_ID) {
        await bot.answerCallbackQuery(q.id, { text: 'Only admin can use this action', showAlert: true });
        return;
    }

    await bot.editMessageText('Fixing database issue... Restarting all bots (Levanter & Raganork)...', {
        chat_id: cid,
        message_id: q.message.message_id
    }).catch(() => {});

    try {
        const HEROKU_API_KEY = process.env.HEROKU_API_KEY;
        if (!HEROKU_API_KEY) {
            throw new Error('HEROKU_API_KEY not configured');
        }

        // Get all bots
        const allBots = await dbServices.getAllUserBots();
        let successCount = 0;
        let failureCount = 0;
        const logMessages = [];

        for (const bot_info of allBots) {
            const appName = bot_info.bot_name;
            try {
                // Restart using Heroku API
                await axios.delete(`https://api.heroku.com/apps/${appName}/dynos/web`, {
                    headers: {
                        'Authorization': `Bearer ${HEROKU_API_KEY}`,
                        'Accept': 'application/vnd.heroku+json; version=3',
                        'Content-Type': 'application/json'
                    }
                });
                successCount++;
                logMessages.push(`✓ Restarted: ${appName}`);
                console.log(`[DB-Fix] Successfully restarted ${appName}`);
            } catch (error) {
                failureCount++;
                logMessages.push(`✗ Failed: ${appName}`);
                console.error(`[DB-Fix] Failed to restart ${appName}:`, error.message);
            }
            // Wait 30 seconds between restarts
            await new Promise(resolve => setTimeout(resolve, 30000));
        }

        // Send completion message
        const summary = `Database Fix Complete\n\nRestarted All Bots:\nSuccess: ${successCount}\nFailed: ${failureCount}\n\n${logMessages.join('\n')}`;
        await bot.editMessageText(summary, {
            chat_id: cid,
            message_id: q.message.message_id
        }).catch(() => {});

    } catch (error) {
        console.error('[DB-Fix] Error during restart:', error);
        await bot.editMessageText(`Error: ${error.message}`, {
            chat_id: cid,
            message_id: q.message.message_id
        }).catch(() => {});
    }
    return;
}

// In bot.js, inside bot.on('callback_query', async q => { ... })

if (action === 'editvar_select') {
    const varName = payload;
    const cid = q.message.chat.id.toString();

    // Set the state to wait for the user's next message
    userStates[cid] = {
        step: 'AWAITING_RENDER_VAR_VALUE',
        data: {
            varName: varName,
            messageId: q.message.message_id // Store message ID to delete it later
        }
    };

    // Ask the user for the new value
    await bot.editMessageText(`Okay, please send the new value for \`${varName}\`:`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });
    return;
}


  if (action === 'faq_page') {
      const page = parseInt(payload);
      const messageId = q.message.message_id; // Use message ID from the callback query
      await sendFaqPage(cid, messageId, page); // Use sendFaqPage
      return;
  }

  if (action === 'back_to_main_menu') {
      delete userStates[cid].faqPage; // Clear FAQ specific state
      delete userStates[cid].faqMessageId; // Clear FAQ message ID
      delete userStates[cid].step; // Clear main step if desired, or reset to default
      const isAdmin = cid === ADMIN_ID;
      await bot.editMessageText('Returning to main menu.', {
          chat_id: cid,
          message_id: q.message.message_id,
          reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
      }).catch(err => {
          console.error(`Error editing message back to main menu: ${err.message}. Sending new menu.`, err);
          bot.sendMessage(cid, 'Returning to main menu.', {
              reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
          });
      });
      return;
  }

  // Inside bot.on('callback_query', ...)

if (action === 'delapi_select') {
    const keyId = payload;

    // Fetch the key to show a confirmation
    const keyResult = await pool.query('SELECT api_key FROM heroku_api_keys WHERE id = $1', [keyId]);
    if (keyResult.rows.length === 0) {
        return bot.answerCallbackQuery(q.id, { text: "This key may have already been deleted.", show_alert: true });
    }
    const apiKey = keyResult.rows[0].api_key;
    const maskedKey = `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`;

    await bot.editMessageText(
        `Are you sure you want to permanently delete the key \`${maskedKey}\`?`,
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "Yes, Delete Now", callback_data: `delapi_confirm:${keyId}` },
                        { text: "No, Go Back", callback_data: `delapi_cancel` }
                    ]
                ]
            }
        }
    );
    return;
}

if (action === 'delapi_confirm') {
    const keyId = payload;
    try {
        await pool.query('DELETE FROM heroku_api_keys WHERE id = $1', [keyId]);
        await bot.answerCallbackQuery(q.id, { text: `API Key deleted successfully.` });
        // Refresh the list to show the key is gone
        await sendApiKeyDeletionList(cid, q.message.message_id);
    } catch (dbError) {
        console.error("Error deleting API key:", dbError);
        await bot.answerCallbackQuery(q.id, { text: `Error: Could not delete key.`, show_alert: true });
    }
    return;
}

if (action === 'delapi_cancel') {
    // Just go back to the list
    await sendApiKeyDeletionList(cid, q.message.message_id);
    return;
}


// --- ADD these handlers and REMOVE the old copydb ones ---

if (action === 'copydb_confirm_simple') {
    await bot.editMessageText('Copying main database to backup... This may take a moment.', {
        chat_id: cid,
        message_id: q.message.message_id
    });

    try {
        // Directly call syncDatabases with main pool as source and backup pool as target
        const result = await dbServices.syncDatabases(pool, backupPool); 
        if (result.success) {
            await bot.editMessageText(`Copy Complete! ${result.message}`, {
                chat_id: cid,
                message_id: q.message.message_id
            });
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        await bot.editMessageText(`Copy Failed! Reason: ${error.message}`, {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }
    return;
}

// Add these to your bot.on('callback_query', ...) function in bot.js

if (action === 'changedb_confirm_all') {
    // This simulates running the command again to trigger the full loop
    // Ensure you use q.message.chat.id for context
    bot.emit('message', { chat: q.message.chat, text: '/changedb confirm_all' });
    // Delete the original buttons
    await bot.deleteMessage(q.message.chat.id, q.message.message_id).catch(() => {});
    return;
}

if (action === 'changedb_cancel') {
    await bot.editMessageText('Mass migration cancelled.', { chat_id: q.message.chat.id, message_id: q.message.message_id });
    return;
}
  
if (action === 'copydb_cancel') {
    await bot.editMessageText('Database copy cancelled.', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}


// ===================================================================
if (action === 'users_page') {
    const newPage = parseInt(payload, 10);
    await sendUserListPage(q.message.chat.id, newPage, q.message.message_id);
    return;
}


// --- FIX: Refactored select_deploy_type to ask for Session ID first with Image ---
if (action === 'select_deploy_type') {
    const botType = payload;
    const cid = q.message.chat.id.toString();
    const messageIdToDelete = q.message.message_id;

    if (!st || st.step !== 'AWAITING_BOT_TYPE_SELECTION') {
        return bot.editMessageText('This session has expired. Please start the deployment process again.', { 
            chat_id: cid, 
            message_id: messageIdToDelete 
        });
    }
      
    st.data.botType = botType;
    st.step = 'SESSION_ID';
    
    // --- START OF UPDATED LOGIC ---
    let prefix;
    let imageGuideUrl;
    let sessionSiteUrl;

    if (botType === 'raganork') {
        prefix = RAGANORK_SESSION_PREFIX;
        imageGuideUrl = 'https://files.catbox.moe/lqk3gj.jpeg'; 
        sessionSiteUrl = RAGANORK_SESSION_SITE_URL;
    } else if (botType === 'hermit') {
        prefix = HERMIT_SESSION_PREFIX;
        imageGuideUrl = 'https://files.catbox.moe/udjrjg.jpeg'; 
        sessionSiteUrl = HERMIT_SESSION_SITE_URL;
    } else { 
        prefix = LEVANTER_SESSION_PREFIX;
        imageGuideUrl = 'https://files.catbox.moe/k6wgxl.jpeg'; 
        sessionSiteUrl = LEVANTER_SESSION_SITE_URL;
    }

    const botName = botType.charAt(0).toUpperCase() + botType.slice(1);
    const sessionPrompt = `You've selected *${botName}*. Please send your session id. It must start with \`${prefix}\`.`;
    
    // 1. Send the new image with a COLORED BLUE button
    await bot.sendPhoto(cid, imageGuideUrl, { 
        caption: sessionPrompt,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { 
                        text: `Get Session ID for ${botName}`, 
                        url: sessionSiteUrl,
                        style: 'primary' // 🔵 Sets the button color to Blue (API 9.4+)
                    }
                ]
            ]
        }
    });

    // 2. Delete the original bot selection message
    await bot.deleteMessage(cid, messageIdToDelete)
        .catch(e => console.log(`Could not delete message ${messageIdToDelete}: ${e.message}`));

    return;
}





   if (action === 'buy_key') {
        if (!st || !st.data.botType) {
            return bot.answerCallbackQuery(q.id, { text: "Session expired. Please start the deployment process again.", show_alert: true });
        }
        userStates[cid] = { step: 'AWAITING_EMAIL_FOR_PAYMENT', data: { botType: st.data.botType } };
        await bot.editMessageText('To proceed with the payment, please enter your email address:', {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }



// --- FIX 2: REPLACE this block to remove the extra nested code ---

if (action === 'verify_join') {
    const userId = q.from.id;
    const messageId = q.message.message_id;

    try {
        const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, userId);
        const isMember = ['creator', 'administrator', 'member'].includes(member.status);

        if (isMember) {
            const { first_name, username } = q.from;
            const userIdentifier = username ? `@${username}` : first_name;
            bot.sendMessage(ADMIN_ID, `User ${escapeMarkdown(userIdentifier)} (\`${userId}\`) has joined the channel for a free trial.`, { parse_mode: 'Markdown' });

            await bot.answerCallbackQuery(q.id);

            await bot.editMessageText('Verification successful!', {
                chat_id: cid,
                message_id: messageId
            });

            await new Promise(resolve => setTimeout(resolve, 1500)); 
            
            delete userStates[cid];
            userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: true } };

            // --- 💡 START OF UPDATE 💡 ---
            await bot.editMessageText('Great! Which bot type would you like to deploy for your free trial?', {
                chat_id: cid,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [ // Row 1
                            { text: 'Levanter', callback_data: `select_deploy_type:levanter` },
                            { text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }
                        ],
                        [ // Row 2
                            { text: 'Hermit', callback_data: `select_deploy_type:hermit` }
                        ]
                    ]
                }
            });
            // --- 💡 END OF UPDATE 💡 ---

        } else {
            await bot.answerCallbackQuery(q.id); 

            await bot.editMessageText("You must join our channel to proceed. Please join and then tap 'Verify' again.", {
                chat_id: cid,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Join Our Channel', url: MUST_JOIN_CHANNEL_LINK }],
                        [{ text: 'I have joined, Verify me!', callback_data: 'verify_join' }]
                    ]
                }
            });
        }
    } catch (error) { 
        console.error("Error verifying channel membership:", error.message);
        await bot.answerCallbackQuery(q.id, {
            text: "Could not verify membership. Please contact an admin.",
            show_alert: true
        });
        await bot.sendMessage(ADMIN_ID, `Error checking channel membership for channel ID ${MUST_JOIN_CHANNEL_ID}. Ensure the bot is an admin in this channel. Error: ${error.message}`);
    }
    return;
}


      if (action === 'start_deploy_after_payment') {
        const botType = payload; // Get the botType we saved in the callback_data
        
        // Set the state correctly to continue the deployment flow
        userStates[cid] = { 
            step: 'AWAITING_KEY', 
            data: { 
                botType: botType,
                isFreeTrial: false 
            } 
        };
        
        // Send a NEW message asking for the key
        await bot.sendMessage(cid, `You chose *${botType.toUpperCase()}*.\n\nPlease enter the Deploy Key you just received:`, {
            parse_mode: 'Markdown'
        });
        return;
    }


  if (action === 'deploy_first_bot') { // Handled by select_deploy_type now
      const isAdmin = cid === ADMIN_ID;
      delete userStates[cid]; // Clear previous state
      userStates[cid] = { step: 'AWAITING_BOT_TYPE_SELECTION', data: { isFreeTrial: false } }; // Go to bot type selection

      await bot.editMessageText('Which bot type would you like to deploy?', {
          chat_id: cid,
          message_id: q.message.message_id,
          reply_markup: {
              inline_keyboard: [
                  [{ text: 'Levanter', callback_data: `select_deploy_type:levanter` }],
                  [{ text: 'Raganork MD', callback_data: `select_deploy_type:raganork` }]
              ]
          }
      });
      return;
  }

  // --- NEW: Callback handler for the 'Edit' button ---
if (action === 'edit_deployment_start_over') {
    delete userStates[cid]; // Clear the state entirely
    const botType = st.data.botType;
    const sessionUrl = (botType === 'raganork') ? RAGANORK_SESSION_SITE_URL : 'https://levanter-delta.vercel.app/';

    userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: st.data.isFreeTrial, botType: botType } };

    await bot.editMessageText(
        'Okay, let\'s start over. Please get your session ID from the link below and send it here.',
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Get Session ID for ${botType.toUpperCase()}`, url: sessionUrl, style: 'primary' }]
                ]
            }
        }
    );
    return;
}


// 2. In bot.on('callback_query', ...) handler (Add new actions)

if (action === 'vcf_start') {
    await bot.editMessageText(
        `*Contact Gain (VCF Exchange)*\n\n` +
        `Share your contact to receive a full list of contacts from other users every night at 11 PM (WAT) for WhatsApp Status boosting.\n\n` +
        `Your name will be saved as "{Name} WBD".`,
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Submit Number', callback_data: 'vcf_start_submit' }],
                    [{ text: '« Back', callback_data: 'more_features_menu' }]
                ]
            }
        }
    );
    return;
}

if (action === 'vcf_start_submit' || action === 'vcf_start_over') {
    delete userStates[cid];
    userStates[cid] = { step: 'AWAITING_VCF_NAME', data: {} };
    await bot.editMessageText("Please enter your preferred **Full Name** (e.g., Ultar, John Doe):", {
         chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
    });
    return;
}

if (action === 'vcf_submit_confirm') {
    if (!st || st.step !== 'AWAITING_VCF_CONFIRM') return;

    const { fullName, phoneNumber } = st.data;

    // Use the new service function
    const result = await dbServices.storeNewVcfContact(cid, fullName, phoneNumber);
    
    delete userStates[cid];
    
    if (result.success) {
        await bot.editMessageText(
            `**Success!** Your contact has been added to the list.\n\n` + 
            `Check the group channel for the VCF file at 11 PM (WAT) tonight!`, 
            {
                chat_id: cid, 
                message_id: q.message.message_id, 
                parse_mode: 'Markdown',
                reply_markup: { // <<< ADDED INLINE BUTTON
                    inline_keyboard: [
                        [{ text: 'Join VCF GROUP', url: VCF_GROUP_LINK }]
                    ]
                }
            }
        );
    } else {
        await bot.editMessageText(`**Failed to Submit.** This phone number may already be registered.`, {
            chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
        });
    }
    return;
}



// --- FIX: This block now handles auto status choice and then moves to final confirmation ---
if (action === 'set_auto_status_choice') {
    const st = userStates[cid];
    const autoStatusChoice = payload;
    if (!st || st.step !== 'AWAITING_AUTO_STATUS_CHOICE') return;

    // --- THIS IS THE FIX (NOW INCLUDES HERMIT) ---
    if (st.data.botType === 'levanter') {
      st.data.AUTO_STATUS_VIEW = autoStatusChoice === 'true' ? 'no-dl' : 'false';
    } else if (st.data.botType === 'raganork') {
      st.data.AUTO_STATUS_VIEW = autoStatusChoice; // Sets to 'true' or 'false'
    } else if (st.data.botType === 'hermit') {
      // Assuming Hermit works like Raganork
      st.data.AUTO_STATUS_VIEW = autoStatusChoice; 
    }
    // --- END OF FIX ---

    st.step = 'AWAITING_FINAL_CONFIRMATION';

    // --- 🎨 DESIGN UPDATE START 🎨 ---
    
    // Get the variables
    const botType = st.data.botType.toUpperCase();
    const session = st.data.SESSION_ID.slice(0, 15) + '...';
    const appName = st.data.APP_NAME;
    const statusView = st.data.AUTO_STATUS_VIEW;

    // Build the message inside a code block (```) for perfect formatting
    let confirmationMessage = "```\n"; // Start code block
    confirmationMessage += ` ═══ ${botType} ═══⊷\n`;
    confirmationMessage += ` ┃❃╭──────────────\n`;
    confirmationMessage += ` ┃❃│ Bot Type    : ${botType}\n`;
    confirmationMessage += ` ┃❃│ App Name    : ${appName}\n`;
    confirmationMessage += ` ┃❃│ Session     : ${session}\n`;
    confirmationMessage += ` ┃❃│ Auto Status : ${statusView}\n`;
    confirmationMessage += ` ┃❃╰───────────────\n\n`;
    confirmationMessage += ` Looks good? Tap 'Confirm' to build your bot!`;
    confirmationMessage += "\n```"; // End code block
    
    // --- 🎨 DESIGN UPDATE END 🎨 ---
    
    await bot.editMessageText(confirmationMessage, {
        chat_id: cid,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Confirm', callback_data: `confirm_and_pay_step`, style: 'success' }],
                [{ text: 'Edit (Start Over)', callback_data: `edit_deployment_start_over`, style: 'primary' }]
            ]
        },
        parse_mode: 'Markdown' // This parse_mode works with the ``` code block
    });
    return;
}




  if (action === 'restore_from_backup') { // Handle Restore button click
    const userDeployments = await dbServices.getUserDeploymentsForRestore(cid); // Use dbServices
    
    // Filter out bots that are already active on Heroku (deleted_from_heroku_at IS NULL)
    // and those whose original 45-day expiration has passed
    const now = new Date();
    const restorableDeployments = userDeployments.filter(dep => {
        const isCurrentlyActive = dep.deleted_from_heroku_at === null; // Must not be active
        const hasExpired = dep.expiration_date && new Date(dep.expiration_date) <= now; // Must not have expired

        // Also check if deploy_date is null or missing, it implies it's a very old record not correctly saved
        const hasDeployDate = dep.deploy_date !== null && dep.deploy_date !== undefined;

        return !isCurrentlyActive && hasDeployDate && !hasExpired; // Only show if not currently deployed, has a deploy date, and not expired
    });


    if (restorableDeployments.length === 0) {
        return bot.editMessageText('No restorable backups found for your account. Please deploy a new bot.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }

    const restoreOptions = restorableDeployments.map(dep => {
        const deployDate = new Date(dep.deploy_date).toLocaleDateString();
        // Calculate remaining time from original deploy date
        const originalExpirationDate = new Date(new Date(dep.deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.ceil((originalExpirationDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        let expirationText = '';
        if (daysLeft > 0) {
            expirationText = ` (Expires in ${daysLeft} days)`;
        } else {
            expirationText = ` (Expired on ${originalExpirationDate.toLocaleDateString()})`;
        }


        return [{
            text: `${dep.app_name} (${dep.bot_type ? dep.bot_type.toUpperCase() : 'Unknown'}) - Deployed: ${deployDate}${expirationText}`,
            callback_data: `select_restore_app:${dep.app_name}`
        }];
    });

    await bot.editMessageText('Select a bot to restore:', {
        chat_id: cid,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: restoreOptions
        }
    });
    return;
  }

// In bot.js (inside bot.on('callback_query', ...))

// --- 1. GROUP FILLER START / DESCRIPTION ---
if (action === 'group_filler_start') {
    delete userStates[cid];
    
    const description = 
        `**Group Filler Service**\n\n` +
        `Fill your group instantly with our verified bot members at a decent rate.\n\n` +
        `*NOTE:* We only add numbers.\n\n` +
        `Tap **Proceed** to start the order process.`;

    await bot.editMessageText(description, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Proceed to Order', callback_data: 'group_filler_proceed' }],
                [{ text: '« Back', callback_data: 'more_features_menu' }]
            ]
        }
    });
    return;
}

// --- 2. PROCEED: Ask for Link ---
if (action === 'group_filler_proceed') {
    delete userStates[cid];
    userStates[cid] = { step: 'AWAITING_GROUP_LINK', data: {} };
    
    await bot.editMessageText("Please send the full **WhatsApp Group Invite Link**", {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });
    return;
}

// --- 3. PAYMENT TRIGGER ---
if (action === 'group_filler_pay') {
    const priceNgn = parseInt(payload, 10);
    const st = userStates[cid];
    
    if (!st || st.step !== 'AWAITING_GROUP_CONFIRM') {
        return bot.answerCallbackQuery(q.id, { text: "Session expired. Please start over.", show_alert: true });
    }
    
    // Call function to show payment options (Flutterwave only, as requested)
    const messageId = q.message.message_id;
    
    // We reuse showPaymentOptions but customize the metadata for the webhook
    
    const reference = `flw_fill_${crypto.randomBytes(8).toString('hex')}`;
    const metadata = {
        user_id: cid,
        product: 'Group Filler',
        link: st.data.groupLink,
        amount: st.data.totalPrice,
        members: st.data.memberAmount
    };

    // We do NOT use initiateFlutterwavePayment here as we need a direct link to the external webhook.
    // Instead, we store PENDING and send user to pay.

    try {
        // Store PENDING payment (only if the user has a verified email)
        const userEmail = await getUserEmail(cid);
        if (!userEmail) {
             return bot.editMessageText("You must verify your email address before making a payment. Please use the menu to verify first.", { chat_id: cid, message_id: messageId });
        }
        
        await pool.query(
            'INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [reference, cid, userEmail, 'group_filler', st.data.memberAmount.toString(), st.data.groupLink]
        );
        
        // --- Generate FLUTTERWAVE link directly for this service ---
        const response = await axios.post('https://api.flutterwave.com/v3/payments', {
            tx_ref: reference,
            amount: priceNgn,
            currency: "NGN",
            redirect_url: `https://t.me/${botUsername}`,
            customer: {
                email: userEmail,
                name: `Group Filler User ${cid}`
            },
            meta: metadata,
            customizations: {
                title: "Group Filler",
                description: `Adding ${metadata.members} members to group.`
            }
        }, {
            headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
        });

        const paymentUrl = response.data.data.link;

        await bot.editMessageText(
            `Click the button below to complete your payment (₦${priceNgn.toLocaleString()}).`, {
                chat_id: cid,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Pay with Flutterwave', url: paymentUrl }]]
                }
            }
        );
        
    } catch (error) {
        console.error("[Group Filler Payment] Error:", error.response?.data || error.message);
        await bot.editMessageText(`Payment failed. Try again later.`, { chat_id: cid, message_id: messageId });
    }
    return;
}

// Add these new `if` blocks inside your bot.on('callback_query', ...) handler

if (action === 'dkey_select') {
    const keyToDelete = payload;
    await bot.editMessageText(
        `Are you sure you want to permanently delete the key \`${keyToDelete}\`?`,
        {
            chat_id: q.message.chat.id,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "Yes, Delete Now", callback_data: `dkey_confirm:${keyToDelete}` },
                        { text: "No, Cancel", callback_data: `dkey_cancel` }
                    ]
                ]
            }
        }
    );
    return;
}

if (action === 'dkey_confirm') {
    const keyToDelete = payload;
    const success = await dbServices.deleteDeployKey(keyToDelete);
    if (success) {
        await bot.answerCallbackQuery(q.id, { text: `Key ${keyToDelete} deleted.` });
    } else {
        await bot.answerCallbackQuery(q.id, { text: `Failed to delete key ${keyToDelete}.`, show_alert: true });
    }
    // Refresh the list
    await sendKeyDeletionList(q.message.chat.id, q.message.message_id);
    return;
}

if (action === 'dkey_cancel') {
    // Just go back to the list
    await sendKeyDeletionList(q.message.chat.id, q.message.message_id);
    return;
}


  if (action === 'select_bapp') {
    const appName = payload;
    const appUserId = extra;
    const messageId = q.message.message_id;

    await bot.editMessageText(`Verifying *${escapeMarkdown(appName)}* on Heroku and fetching details...`, {
        chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
    }).catch(()=>{});

    let herokuStatus = '';
    let isAppActive = false;
    try {
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        herokuStatus = '🟢 Currently on Heroku';
        isAppActive = true;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            herokuStatus = '🔴 Deleted from Heroku';
            isAppActive = false;
        } else {
            herokuStatus = '⚪ Unknown (API Error)';
            isAppActive = false;
        }
    }

    const dbResult = await pool.query(
        `SELECT * FROM user_deployments WHERE app_name = $1 AND user_id = $2;`,
        [appName, appUserId]
    );

    if (dbResult.rows.length === 0) {
        return bot.editMessageText(`Record for "*${escapeMarkdown(appName)}*" not found in the database.`, {
            chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
        });
    }
    const deployment = dbResult.rows[0];

    // Build the action buttons based on status
    const actionButtons = [];
    if (isAppActive) {
        actionButtons.push([{ text: 'App is Active', callback_data: 'no_action' }]);
    } else {
        actionButtons.push([{ text: 'Restore App', callback_data: `restore_from_bapp:${appName}:${appUserId}` }]);
    }
    actionButtons.push(
        [{ text: 'Delete From Database', callback_data: `delete_bapp:${appName}:${appUserId}` }],
        [{ text: 'Back to List', callback_data: `back_to_bapp_list:${deployment.bot_type}` }]
    );

    let userDisplay = `\`${escapeMarkdown(deployment.user_id)}\``;
    try {
        const targetChat = await bot.getChat(deployment.user_id);
        userDisplay = `${escapeMarkdown(targetChat.first_name || '')} (@${escapeMarkdown(targetChat.username || 'N/A')})`;
    } catch (e) { /* ignore */ }

    const deployDateDisplay = new Date(deployment.deploy_date).toLocaleString('en-US', { timeZone: 'Africa/Lagos' });

    const detailMessage = `
*App Details:*

*App Name:* \`${escapeMarkdown(appName)}\`
*Bot Type:* ${deployment.bot_type ? deployment.bot_type.toUpperCase() : 'Unknown'}
*Owner:* ${userDisplay}
*Deployed On:* ${deployDateDisplay}
*Heroku Status:* ${herokuStatus}
    `;

    await bot.editMessageText(detailMessage, {
        chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: actionButtons }
    });
    return;
}



      if (action === 'set_expiration') {
        const appName = payload;
        const st = userStates[cid];

        if (!st || st.step !== 'AWAITING_APP_FOR_EXPIRATION') {
            return bot.editMessageText("This session has expired. Please use the /expire command again.", {
                chat_id: cid,
                message_id: q.message.message_id
            });
        }

        const days = st.data.days;
        try {
            const ownerIdResult = await pool.query('SELECT user_id FROM user_bots WHERE bot_name = $1', [appName]);
            if (ownerIdResult.rows.length === 0) {
                throw new Error(`Could not find owner for ${appName}`);
            }
            const ownerId = ownerIdResult.rows[0].user_id;

            // Use a parameterized query to safely add the interval
            const result = await pool.query(
                `UPDATE user_deployments SET expiration_date = NOW() + ($1 * INTERVAL '1 day') WHERE app_name = $2 AND user_id = $3`,
                [days, appName, ownerId]
            );

            if (result.rowCount > 0) {
                await bot.editMessageText(`Success! Expiration for *${escapeMarkdown(appName)}* has been set to *${days} days* from now.`, {
                    chat_id: cid,
                    message_id: q.message.message_id,
                    parse_mode: 'Markdown'
                });
            } else {
                 await bot.editMessageText(`Could not find *${escapeMarkdown(appName)}* in the deployments table to update.`, {
                    chat_id: cid,
                    message_id: q.message.message_id,
                    parse_mode: 'Markdown'
                });
            }

        } catch (error) {
            console.error(`Error setting expiration for ${appName}:`, error);
            await bot.editMessageText(`An error occurred while updating the expiration date. Please check the logs.`, {
                chat_id: cid,
                message_id: q.message.message_id
            });
        } finally {
            delete userStates[cid];
        }
        return;
    }

  // --- FIX: Refactored confirm_updateall to use an editable progress message ---
if (action === 'confirm_updateall') {
    const adminId = q.message.chat.id.toString();
    if (adminId !== ADMIN_ID) return;

    const botType = payload;
    const messageId = q.message.message_id;
    let progressMessage = `Starting mass redeployment for all *${botType.toUpperCase()}* bots...`;
    
    // Send an initial message to be edited later
    const progressMsg = await bot.editMessageText(progressMessage, {
        chat_id: adminId,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    try {
        const allBots = await pool.query('SELECT bot_name FROM user_bots WHERE bot_type = $1', [botType]);
        const botsToUpdate = allBots.rows.map(row => row.bot_name);
        const botCount = botsToUpdate.length;
        
        let progressLog = [];

        for (const [index, appName] of botsToUpdate.entries()) {
            let status = '...';
            let statusEmoji = '⏳';
            let messageToLog = '';

            // Update progress message with current bot
            progressMessage = `*Progress:* ${index + 1}/${botCount}\n`;
            progressMessage += `*Current Bot:* \`${escapeMarkdown(appName)}\`\n\n`;
            progressMessage += `*Log:*\n${progressLog.slice(-5).join('\n')}\n`; // Show last 5 logs

            await bot.editMessageText(progressMessage, {
                chat_id: adminId,
                message_id: progressMsg.message_id,
                parse_mode: 'Markdown'
            }).catch(() => {});

            try {
                const githubRepoUrl = botType === 'raganork' ? GITHUB_RAGANORK_REPO_URL : GITHUB_LEVANTER_REPO_URL;
                await axios.post(
                    `https://api.heroku.com/apps/${appName}/builds`,
                    { source_blob: { url: `${githubRepoUrl}/tarball/main` } },
                    { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
                );
                statusEmoji = '✅';
                messageToLog = `${statusEmoji} Redeploy triggered for \`${escapeMarkdown(appName)}\`.`;
            } catch (error) {
                if (error.response?.status === 404) {
                    statusEmoji = '❌';
                    messageToLog = `${statusEmoji} App \`${escapeMarkdown(appName)}\` not found on Heroku. Skipping...`;
                    await dbServices.handleAppNotFoundAndCleanDb(adminId, appName, null, false);
                } else {
                    statusEmoji = '❌';
                    const errorMsg = escapeMarkdown(error.response?.data?.message || error.message);
                    messageToLog = `${statusEmoji} Failed for \`${escapeMarkdown(appName)}\`: ${errorMsg}. Skipping...`;
                }
            }
            
            progressLog.push(messageToLog);

            // Add a final log entry for the current bot to the message
            progressMessage = `*Progress:* ${index + 1}/${botCount}\n`;
            progressMessage += `*Current Bot:* \`${escapeMarkdown(appName)}\`\n\n`;
            progressMessage += `*Log:*\n${progressLog.slice(-5).join('\n')}\n`;
            if (index < botCount - 1) {
                progressMessage += `\nWaiting 30 seconds before next bot...`;
            }

            await bot.editMessageText(progressMessage, {
                chat_id: adminId,
                message_id: progressMsg.message_id,
                parse_mode: 'Markdown'
            }).catch(() => {});

            if (index < botCount - 1) {
                await new Promise(r => setTimeout(r, 30000)); // 30-second delay
            }
        }

        // Final message with a summary
        const finalMessage = `Mass redeployment complete! Processed ${botCount} bots.`;
        await bot.editMessageText(finalMessage, {
            chat_id: adminId,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown'
        });

    } catch (error) {
        console.error(`Error confirming /updateall:`, error.message);
        await bot.editMessageText(`An error occurred during mass redeployment: ${escapeMarkdown(error.message)}`, {
            chat_id: adminId,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown'
        });
    }
}

if (action === 'get_session_start_flow') {
    // This starts the session ID flow (which is the same as the "Get Session ID" button)
    delete userStates[cid];
    userStates[cid] = { step: 'AWAITING_GET_SESSION_BOT_TYPE', data: {} };

    await bot.editMessageText('Which bot type do you need a session ID for?', {
        chat_id: cid,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: [
                [ // Row 1
                    { text: 'Levanter', callback_data: `select_get_session_type:levanter` },
                    { text: 'Raganork MD', callback_data: `select_get_session_type:raganork` }
                ],
                [ // Row 2
                    { text: 'Hermit', callback_data: `select_get_session_type:hermit` }
                ]
            ]
        }
    });
    return;
}


  // In bot.js, inside bot.on('callback_query', ...)

if (action === 'restore_from_backup') {
    const userId = q.message.chat.id.toString();
    const messageId = q.message.message_id;

    await bot.editMessageText('Checking for restorable bots in your backup...', {
        chat_id: userId,
        message_id: messageId
    });

    try {
        const userDeployments = await dbServices.getUserDeploymentsForRestore(userId);
        
        const restorableDeployments = [];
        const now = new Date();

        for (const dep of userDeployments) {
            // A bot is restorable if its original expiration period hasn't passed
            const deployDate = new Date(dep.deploy_date);
            // Assuming a 45-day expiration for this example
            const originalExpirationDate = new Date(deployDate.getTime() + 45 * 24 * 60 * 60 * 1000);
            
            if (originalExpirationDate <= now) {
                // If it has truly expired, remove it from the backup permanently
                await dbServices.deleteUserDeploymentFromBackup(userId, dep.app_name);
                continue; // Skip to the next one
            }

            // Check if it is already active on Heroku
            try {
                await axios.get(`https://api.heroku.com/apps/${dep.app_name}`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                // If the request succeeds, it's active, so we don't list it for restore.
            } catch (e) {
                // A 404 means the app is not on Heroku, so it's restorable.
                if (e.response && e.response.status === 404) {
                    restorableDeployments.push(dep);
                }
            }
        }

        if (restorableDeployments.length === 0) {
            return bot.editMessageText('No restorable backups were found. You can deploy a new bot from the main menu.', {
                chat_id: userId,
                message_id: messageId
            });
        }

        // Create a button for each restorable bot
        const restoreOptions = restorableDeployments.map(dep => {
            const daysLeft = Math.ceil((new Date(dep.expiration_date) - now) / (1000 * 60 * 60 * 24));
            const expirationText = daysLeft > 0 ? `(${daysLeft} days left)` : '(Expired)';
            
            return [{
                text: `${dep.app_name} ${expirationText}`,
                callback_data: `select_restore_app:${dep.app_name}`
            }];
        });

        await bot.editMessageText('Select a bot to restore from your backup:', {
            chat_id: userId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: restoreOptions
            }
        });

    } catch (error) {
        console.error("Error fetching restore list:", error);
        await bot.editMessageText("An error occurred while fetching your backups.", {
            chat_id: userId,
            message_id: messageId
        });
    }
    return;
}

// In bot.js, inside bot.on('callback_query', ...)

if (action === 'select_restore_app') {
    const appName = payload;
    
    await bot.editMessageText(`Are you sure you want to restore the bot "*${escapeMarkdown(appName)}*"? This will start a new deployment using your saved settings.`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: 'Yes, Restore Now', callback_data: `confirm_restore_app:${appName}` },
                    { text: 'No, Cancel', callback_data: 'restore_from_backup' } // Go back to the list
                ]
            ]
        }
    });
    return;
}


if (action === 'mass_restore') {
    const botType = payload; // e.g., 'levanter'
    const messageId = q.message.message_id;

    try {
        // 1. Fetch matching bots from DB
        const result = await pool.query(
            "SELECT bot_name FROM user_bots WHERE bot_type = $1", 
            [botType]
        );
        const apps = result.rows;

        if (apps.length === 0) {
            return bot.editMessageText(`No ${botType} bots found to restore.`, { chat_id: cid, message_id: messageId });
        }

        await bot.editMessageText(`Found ${apps.length} ${botType} bots. Starting mass restoration with 1-min intervals...`, {
            chat_id: cid,
            message_id: messageId
        });

        // 2. The Sequential Loop
        for (let i = 0; i < apps.length; i++) {
            const appName = apps[i].bot_name;
            
            // Update UI
            await bot.sendMessage(cid, `Step ${i + 1}/${apps.length}: Restoring **${appName}**...`);

            // 3. Trigger the Restore logic (using your existing app-restore function)
            try {
                // We use the same function your manual "Restore" button uses
                await triggerRestoreLogic(appName, botType); 
            } catch (err) {
                await bot.sendMessage(cid, `Failed to restore ${appName}: ${err.message}`);
            }

            // 4. Wait for 1 minute before the next one, unless it's the last app
            if (i < apps.length - 1) {
                await bot.sendMessage(cid, "Waiting 60 seconds before next restoration...");
                await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay
            }
        }

        await bot.sendMessage(cid, `Mass restoration for ${botType} completed.`);
    } catch (e) {
        console.error("Mass Restore Error:", e.message);
        await bot.sendMessage(cid, "Error during mass restore process.");
    }
    return;
}


  /// In bot.js, inside bot.on('callback_query', ...)

if (action === 'confirm_restore_app') {
    const appName = payload;

    await bot.editMessageText(`Fetching backup data for "*${escapeMarkdown(appName)}*" and starting the restore process. This may take a few minutes...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        // --- START MODIFIED QUERY LOGIC ---
        // 1. First, attempt to fetch the deployment details using the user's ID (cid) from the backup pool.
        let backupResult = await backupPool.query(
            'SELECT * FROM user_deployments WHERE user_id = $1 AND app_name = $2',
            [cid, appName]
        );

        // 2. If the record is NOT found under the user's ID, search globally by app name.
        if (backupResult.rows.length === 0) {
            console.warn(`[Restore] Backup not found for user ${cid}. Searching backup pool globally by app name.`);
            backupResult = await backupPool.query( // Search globally in the backup pool
                'SELECT * FROM user_deployments WHERE app_name = $1 LIMIT 1',
                [appName]
            );
        }
        // --- END MODIFIED QUERY LOGIC ---

        if (backupResult.rows.length === 0) {
            return bot.sendMessage(cid, 'Sorry, could not find the backup data for this app.');
        }

        // The configuration data, regardless of which user_id it was found under
        const deployment = backupResult.rows[0];
        
        // --- IMPORTANT: Ensure current user's ID (cid) is used as the owner, even if the backup record had a different or wiped ID ---
        const originalOwnerId = deployment.user_id; // Store original owner ID if needed for logging

        // Prepare the variables for the build process
        const vars = { 
            ...deployment.config_vars, 
            APP_NAME: deployment.app_name, 
            SESSION_ID: deployment.session_id,
            expiration_date: deployment.expiration_date // This preserves the original expiration date
        };
        
        // Call your existing build function with the current user's ID (cid) as the owner
        // buildWithProgress will redeploy the bot and assign ownership to cid.
        await dbServices.buildWithProgress(cid, vars, false, true, deployment.bot_type);

    } catch (error) {
        console.error(`[Restore] Error during restore of ${appName}:`, error);
        await bot.sendMessage(cid, `An error occurred while trying to restore "*${escapeMarkdown(appName)}*". Please check the logs.`, { parse_mode: 'Markdown' });
    }
    return;
}



// ... (existing code in bot.on('callback_query', async q => { ... })) ...

  if (action === 'restore_from_bapp') {
      const appName = payload;
      const appUserId = extra; // Owner of the app
      const messageId = q.message.message_id;

      await bot.editMessageText(`Preparing to restore "*${escapeMarkdown(appName)}*" for user \`${escapeMarkdown(appUserId)}\`...`, { // Added preliminary message
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown'
      }).catch(err => console.warn(`Failed to edit message with preliminary restore text: ${err.message}`));

      let selectedDeployment;
      try {
          const result = await pool.query(
              `SELECT user_id, app_name, session_id, config_vars, bot_type, deploy_date, expiration_date, deleted_from_heroku_at
               FROM user_deployments WHERE app_name = $1 AND user_id = $2;`,
              [appName, appUserId]
          );
          selectedDeployment = result.rows[0];
      } catch (e) {
          console.error(`DB Error fetching backup deployment for restore ${appName} (${appUserId}):`, e.message);
          return bot.editMessageText(`Error preparing restore for "*${escapeMarkdown(appName)}*": ${escapeMarkdown(e.message)}.`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }

      if (!selectedDeployment) {
          console.warn(`Backup for ${appName} for user ${appUserId} not found during restore attempt.`);
          return bot.editMessageText(`Backup for "*${escapeMarkdown(appName)}*" not found for restore. It might have been deleted or expired.`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }

      const now = new Date();
      // Recalculate fixed expiration from deploy_date for consistency
      const originalExpirationDate = new Date(new Date(selectedDeployment.deploy_date).getTime() + 45 * 24 * 60 * 60 * 1000);
      if (originalExpirationDate <= now) {
          // If expired, try to delete from backup table and notify
          await dbServices.deleteUserDeploymentFromBackup(appUserId, appName).catch(err => console.error(`Error deleting expired backup ${appName}: ${err.message}`));
          return bot.editMessageText(`Cannot restore "*${escapeMarkdown(appName)}*". Its original 45-day deployment period has expired. It has been removed from backup list.`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }

      // Determine the default env vars for the bot type being restored
      const botTypeToRestore = selectedDeployment.bot_type || 'levanter';
      let defaultVarsForRestore;
      if (botTypeToRestore === 'raganork') {
          defaultVarsForRestore = raganorkDefaultEnvVars;
      } else if (botTypeToRestore === 'hermit') {
          defaultVarsForRestore = hermitDefaultEnvVars;
      } else {
          defaultVarsForRestore = levanterDefaultEnvVars;
      }
      const combinedVarsForRestore = {
          ...defaultVarsForRestore,    // Apply type-specific defaults first
          ...selectedDeployment.config_vars, // Overlay with the saved config vars (these take precedence)
          APP_NAME: selectedDeployment.app_name, // Ensure APP_NAME is always correct
          SESSION_ID: selectedDeployment.session_id // Explicitly ensure saved SESSION_ID is used
      };

      await bot.editMessageText(`Attempting to restore and deploy "*${escapeMarkdown(appName)}*" for user \`${escapeMarkdown(appUserId)}\`... This may take a few minutes.`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown'
      });
      // Call buildWithProgress with isRestore flag and the original botType
      await dbServices.buildWithProgress(appUserId, combinedVarsForRestore, false, true, botTypeToRestore); // IMPORTANT: Use appUserId as target chatId for build

      // The buildWithProgress function itself will update the message upon success/failure.
      // No explicit return here, as buildWithProgress takes over the message flow.
      // Ensure buildWithProgress always updates the message.
      // If you need immediate feedback before buildWithProgress, it's done by the first editMessageText.
      return; // Ensure this function exits
  }


  // In bot.js, inside bot.on('callback_query', ...)

if (action === 'copy_external_confirm') {
    if (!st || st.step !== 'AWAITING_COPY_FINAL_CONFIRM') {
        return bot.answerCallbackQuery(q.id, { text: "This action has expired.", show_alert: true });
    }

    const { sourceUrl, destUrl } = st.data;
    
    await bot.editMessageText("Starting database copy... This may take several minutes. You will be notified when it is complete.", {
        chat_id: cid,
        message_id: q.message.message_id
    });

    // Run the task
    runExternalDbCopy(cid, sourceUrl, destUrl);
    delete userStates[cid];
    return;
}

if (action === 'copy_cancel') {
    delete userStates[cid];
    await bot.editMessageText("Database copy cancelled.", {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}


  // Add this new 'if' block inside your bot.on('callback_query', ...) function

if (action === 'gemini_select_bot') {
    const selectedBotName = payload;
    const st = userStates[cid];

    // Ensure this callback is coming from the correct state
    if (st && st.step === 'AWAITING_BOT_SELECTION_FOR_GEMINI') {
        const originalMessage = st.originalMessage;
        delete userStates[cid]; // Clean up the state

        // Re-run the Gemini handler with a more specific, clarified message
        const clarifiedMessage = `${originalMessage} for my bot named "${selectedBotName}"`;
        
        await bot.editMessageText(`Okay, applying the action to your bot: *${selectedBotName}*`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        // This will now trigger the function call directly because the bot name is included.
        await handleFallbackWithGemini(cid, clarifiedMessage);
    } else {
        await bot.answerCallbackQuery(q.id, { text: "This selection has expired.", show_alert: true });
    }
    return;
}


  if (action === 'delete_bapp') {
    const appName = payload;
    const appUserId = extra; // Owner of the app
    const messageId = q.message.message_id;

    // Confirmation step for deleting from backup database
    await bot.editMessageText(`Are you sure you want to PERMANENTLY delete backup for "*${escapeMarkdown(appName)}*" (User ID: \`${escapeMarkdown(appUserId)}\`) from the backup database? This cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Yes, Delete Backup', callback_data: `confirm_delete_bapp:${appName}:${appUserId}` }],
                [{ text: 'No, Cancel', callback_data: `select_bapp:${appName}:${appUserId}` }] // Go back to app details
            ]
        }
    });
    return; // Ensure this function exits
  }

  if (action === 'confirm_delete_bapp') {
    const appName = payload;
    const appUserId = extra;

    // --- Updated "Deleting" message ---
    await bot.editMessageText(`Permanently deleting all database records and Neon database for "*${escapeMarkdown(appName)}*"...`, {
        chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
    }).catch(()=>{});

    try {
        // 1. ✅ NEW: Delete from Neon
        console.log(`[ConfirmDeleteBApp] Deleting associated Neon database: ${appName}`);
        const deleteResult = await deleteNeonDatabase(appName); 
        if (!deleteResult.success) {
            // Log the error, but continue deleting from our local DB
            console.error(`[ConfirmDeleteBApp] Failed to delete Neon database ${appName}: ${deleteResult.error}`);
            // We'll still proceed to delete the local records.
        }

        // 2. Call the new, more thorough delete function for local DB
        const deleted = await dbServices.permanentlyDeleteBotRecord(appUserId, appName);
        
        if (deleted) {
            await bot.answerCallbackQuery(q.id, { text: `All records for ${appName} deleted.`, show_alert: true });
            // --- Updated success message ---
            await bot.editMessageText(`All database records and the Neon database for "*${escapeMarkdown(appName)}*" have been permanently deleted.`, {
                chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });
        } else {
            // --- Updated "not found" message ---
            await bot.editMessageText(`Could not find local records for "*${escapeMarkdown(appName)}*" to delete. It may have already been removed. (Neon DB deletion was attempted.)`, {
                 chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });
        }
    } catch (e) {
        // This catch is for the local DB deletion
        await bot.editMessageText(`Failed to delete local records for "*${escapeMarkdown(appName)}*": ${escapeMarkdown(e.message)} (Neon DB deletion was attempted.)`, {
            chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
        });
    }
    return;
}




// --- REPLACE your old 'back_to_bapp_list' logic with this ---

if (action === 'back_to_bapp_list') {
    const opts = {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: [
                [ // Row 1
                    { text: 'Levanter', callback_data: 'bapp_select_type:levanter' },
                    { text: 'Raganork', callback_data: 'bapp_select_type:raganork' }
                ],
                [ // Row 2
                    { text: 'Hermit', callback_data: 'bapp_select_type:hermit' }
                ]
            ]
        }
    };
    await bot.editMessageText('Which bot type do you want to manage from the backup list?', opts);
    return; 
}


  
  
  if (action === 'Referrals') {
    // 1. Get user and message details
    const userId = q.from.id.toString();
    const chatId = q.message.chat.id;
    const messageId = q.message.message_id;

    // 2. Create the referral link
    const referralLink = `https://t.me/${botUsername}?start=${userId}`; // Use userId, not ref_userId

    await dbServices.updateUserActivity(userId);

    // 3. Fetch the list of referred users from the database
    const referredUsersResult = await pool.query(
        'SELECT referred_user_id, bot_name FROM user_referrals WHERE inviter_user_id = $1',
        [userId]
    );
    const referredUsers = referredUsersResult.rows;

    // --- 🎨 DESIGN UPDATE START 🎨 ---
    
    // Build the text-art message using Markdown
    let referralMessage = `*═══ YOUR REFERRALS ═══⊷*\n`;
    referralMessage += `┃❃╭──────────────\n`;
    referralMessage += `┃❃│ Share your link to earn rewards!\n`;
    referralMessage += `┃❃│ \n`;
    referralMessage += `┃❃│ *Your Link:*\n`;
    referralMessage += `┃❃│ \`${referralLink}\`\n`; // Use backticks for easy copy
    referralMessage += `┃❃│ \n`;
    referralMessage += `┃❃│ *Your Rewards:*\n`;
    referralMessage += `┃❃│ • *20 days* for a direct referral.\n`;
    referralMessage += `┃❃│ • *7 days* for a 2nd-level referral.\n`;
    referralMessage += `┃❃╰───────────────\n\n`;

    // Dynamically build the list of referred users
    if (referredUsers.length > 0) {
        referralMessage += `*Users you've successfully referred:*\n`;
        for (const ref of referredUsers) {
            try {
                const user = await bot.getChat(ref.referred_user_id);
                const userName = user.first_name || `User ${ref.referred_user_id}`;
                referralMessage += `▪️ *${escapeMarkdown(userName)}* (Bot: \`${escapeMarkdown(ref.bot_name)}\`)\n`;
            } catch (e) {
                referralMessage += `▪️ *A user* (Bot: \`${escapeMarkdown(ref.bot_name)}\`)\n`;
            }
        }
    } else {
        referralMessage += `_You haven't referred any users yet._`;
    }
    // --- 🎨 DESIGN UPDATE END 🎨 ---

    try {
        // Acknowledge the button press
        await bot.answerCallbackQuery(q.id);

        // Edit the original message
        await bot.editMessageText(referralMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        // This share button will still work
                        { text: 'Share Your Link', url: `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Deploy your own bot with my referral link!')}` }
                    ],
                    [
                        { text: '« Back to More Features', callback_data: 'more_features_menu' }
                    ]
                ]
            }
        });

    } catch (error) {
        console.error("Error editing message for referrals:", error);
    }
}



if (action === 'select_get_session_type') {
    const botType = payload;
    const st = userStates[cid];

    if (!st || st.step !== 'AWAITING_GET_SESSION_BOT_TYPE') {
        await bot.editMessageText('This session request has expired. Please start over by tapping "Get Session ID".', {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid];
        return;
    }

    st.data.botType = botType;

    if (botType === 'raganork') {
        await bot.editMessageText(`You chose *Raganork MD*. Please use the button below to generate your session ID.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Get Session', url: RAGANORK_SESSION_SITE_URL, style: 'primary' }],
                    [{ text: 'Deploy Now', callback_data: 'deploy_first_bot', style: 'success' }]
                ]
            }
        });
        delete userStates[cid];
        return;
    } else if (botType === 'hermit') {
        await bot.editMessageText(`You chose *Hermit*. Please use the button below to generate your session ID.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Get Session', url: HERMIT_SESSION_SITE_URL, style: 'primary' }],
                    [{ text: 'Deploy Now', callback_data: 'deploy_first_bot', style: 'success' }]
                ]
            }
        });
        delete userStates[cid];
        return;
    } else { 
        // --- LEVANTER DIRECT AUTO-PAIRING FLOW ---
        // Instantly transition the user to the phone number step
        userStates[cid].step = 'AWAITING_PHONE_NUMBER';
        
        await bot.editMessageText(
            `You chose *Levanter*.\n\nPlease send your WhatsApp number now in the full international format (e.g., \`+23491630000000\`).`, 
            {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        // Safe cancel button that drops them back to the main menu
                        [{ text: '« Cancel', callback_data: 'back_to_main_menu', style: 'danger' }]
                    ]
                }
            }
        );
        return;
    }
}



if (action === 'deldb_select') {
    const tableName = payload;
    
    await bot.editMessageText(
        `🚨 **CONFIRM DELETE: ${tableName.toUpperCase()}** 🚨\n\nAre you absolutely sure you want to drop the table \`${tableName}\`? This will erase **ALL** data and cannot be recovered.`,
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: `YES, DROP TABLE ${tableName}`, callback_data: `deldb_confirm:${tableName}` },
                    ],
                    [
                        { text: 'NO, CANCEL', callback_data: 'deldb_cancel' }
                    ]
                ]
            }
        }
    );
    return;
}

if (action === 'deldb_confirm') {
    const tableName = payload;
    
    await bot.editMessageText(`Attempting to drop table \`${tableName}\`...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });
    
    // Safety check: Final check to prevent dropping core tables (case insensitive)
    const coreTables = ['user_bots', 'user_deployments', 'deploy_keys', 'user_activity', 'email_verification', 'completed_payments', 'pending_payments', 'app_settings', 'banned_users', 'user_referrals', 'key_rewards', 'free_trial_monitoring', 'temp_deploys', 'temp_numbers', 'pre_verified_users', 'free_trial_numbers', 'pinned_messages', 'heroku_api_keys'];
    if (coreTables.includes(tableName.toLowerCase())) {
         return bot.editMessageText(`🛑 ERROR: Table \`${tableName}\` is a CORE table and cannot be deleted via this command.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    }

    try {
        // Use a parameterized query. Although table names cannot be parameterized with $1 in all drivers,
        // we construct the query string using the trusted input from getAllTableNames, which is safer.
        await pool.query(`DROP TABLE IF EXISTS ${tableName} CASCADE;`);
        
        await bot.editMessageText(`Table \`${tableName}\` successfully dropped (deleted).`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        console.error(`Error dropping table ${tableName}:`, e);
        await bot.editMessageText(`Failed to drop table \`${tableName}\`.\nReason: ${e.message}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    }
    return;
}

if (action === 'deldb_cancel') {
    await bot.editMessageText('Table deletion cancelled.', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}


  // In bot.js, inside bot.on('callback_query', ...)

// ✅ FIX: This new handler shows the list of bots for a referral reward.
if (action === 'show_reward_bot_list') {
    const inviterId = q.from.id.toString();
    const referredUserId = payload; // The ID of the user who was referred

    const inviterBots = await dbServices.getUserBots(inviterId);

    if (inviterBots.length === 0) {
        await bot.editMessageText('You do not have any active bots to apply a reward to.', {
            chat_id: inviterId,
            message_id: q.message.message_id
        });
        return;
    }

    const keyboard = inviterBots.map(botName => ([{
        text: botName,
        callback_data: `apply_referral_reward:${botName}:${referredUserId}`
    }]));

    await bot.editMessageText('Please select which of your bots to apply the 20-day reward to:', {
        chat_id: inviterId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: keyboard }
    });
    return;
}

  // Add this new handler inside bot.on('callback_query', ...)
if (action === 'apply_referral_reward') {
    const inviterId = q.from.id.toString();
    const botToUpdate = payload;
    const referredUserId = extra;
    const isSecondLevel = flag === 'second_level';
    const rewardDays = isSecondLevel ? 7 : 20;

    await bot.editMessageText(`Applying your *${rewardDays}-day* reward to bot "*${escapeMarkdown(botToUpdate)}*"...`, {
        chat_id: inviterId,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        await pool.query(
            `UPDATE user_deployments SET expiration_date = expiration_date + INTERVAL '${rewardDays} days'
             WHERE user_id = $1 AND app_name = $2 AND expiration_date IS NOT NULL`,
            [inviterId, botToUpdate]
        );

        // Mark the reward as applied in the user_referrals table
        await pool.query(
            `UPDATE user_referrals SET inviter_reward_pending = FALSE WHERE referred_user_id = $1`,
            [referredUserId]
        );

        await bot.editMessageText(`Success! A *${rewardDays}-day extension* has been added to your bot "*${escapeMarkdown(botToUpdate)}*".`, {
            chat_id: inviterId,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

    } catch (e) {
        console.error(`Error applying referral reward to bot ${botToUpdate} for user ${inviterId}:`, e);
        await bot.editMessageText(`Failed to apply the reward to your bot "*${escapeMarkdown(botToUpdate)}*". Please contact support.`, {
            chat_id: inviterId,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    }
}


  

  // --- NEW: Handler for using a suggested app name ---
if (action === 'use_suggested_name') {
    const appName = payload;
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_NAME') return;
    
    st.data.APP_NAME = appName;
    st.step = 'AWAITING_AUTO_STATUS_CHOICE';

    const confirmationMessage = `*Next Step:*\n` +
                                `Enable automatic status view?`;
    
    await bot.editMessageText(confirmationMessage, {
        chat_id: cid,
        message_id: q.message.message_id,
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Yes', callback_data: `set_auto_status_choice:true` }],
                [{ text: 'No', callback_data: `set_auto_status_choice:false` }]
            ]
        },
        parse_mode: 'Markdown'
    });
    return;
}


  // --- ADD this new block ---

if (action === 'levanter_wa_fallback') {
    // 1. Set the state to wait for the user's phone number.
    // This will trigger your existing logic when the user sends their number.
    userStates[cid] = {
        step: 'AWAITING_PHONE_NUMBER',
        data: {
            botType: 'levanter'
        }
    };

    // 2. Acknowledge the button press
    await bot.answerCallbackQuery(q.id);
    
    // 3. Edit the message to ask for the number and remove the old buttons.
    await bot.editMessageText(
        'Okay, please send your WhatsApp number now in the full international format (e.g., `+23491630000000`).', 
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        }
    );
    
    return;
}



// Add this inside bot.on('callback_query', ...)
if (action === 'verify_join_after_miniapp') {
    const userId = q.from.id.toString();
    const cid = q.message.chat.id.toString();

    try {
        // 1. Check if user is pre-verified (with IP and location data)
        const preVerifiedCheck = await pool.query("SELECT ip_address, city, latitude, longitude FROM pre_verified_users WHERE user_id = $1", [userId]);
        if (preVerifiedCheck.rows.length === 0) {
            await bot.answerCallbackQuery(q.id, { text: "You must complete the security check first.", show_alert: true });
            return;
        }
        
        const { ip_address: userIpAddress, city, latitude, longitude } = preVerifiedCheck.rows[0];
        console.log(`[Free Trial Verification] User ${userId} | IP: ${userIpAddress} | City: ${city} | Location: ${latitude},${longitude}`);

        // 2. Check if user is in the channel (joining requirement)
        const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, userId);
        if (!['creator', 'administrator', 'member'].includes(member.status)) {
            await bot.answerCallbackQuery(q.id, { text: "You haven't joined the channel yet.", show_alert: true });
            return;
        }

        // 3. Double-check: Ensure user hasn't already claimed a trial (abuse prevention)
        const existingTrialCheck = await pool.query("SELECT user_id FROM free_trial_numbers WHERE user_id = $1", [userId]);
        if (existingTrialCheck.rows.length > 0) {
            await bot.answerCallbackQuery(q.id, { text: "You have already claimed your free trial.", show_alert: true });
            return;
        }

        // All checks passed! Assign a free trial number
        const numberResult = await pool.query("SELECT number FROM temp_numbers WHERE status = 'available' ORDER BY RANDOM() LIMIT 1");
        if (numberResult.rows.length === 0) {
            await bot.editMessageText("Sorry, no free trial numbers are available right now.", { chat_id: cid, message_id: q.message.message_id });
            return;
        }
        const freeNumber = numberResult.rows[0].number;

        // Use a transaction to finalize the free trial claim
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            
            // Mark the number as assigned to this user
            await client.query("UPDATE temp_numbers SET status = 'assigned', user_id = $1, assigned_at = NOW() WHERE number = $2", [userId, freeNumber]);
            
            // Record this free trial claim with IP and location data for fraud prevention
            await client.query("INSERT INTO free_trial_numbers (user_id, number_used, ip_address) VALUES ($1, $2, $3)", [userId, freeNumber, userIpAddress]);
            
            // Clean up the pre-verified record
            await client.query("DELETE FROM pre_verified_users WHERE user_id = $1", [userId]);
            
            await client.query('COMMIT');
            console.log(`[Free Trial] ✅ Successfully assigned number ${freeNumber} to user ${userId} from IP ${userIpAddress}`);
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }

        // Success! Show the user their number
        await bot.editMessageText(`✅ *All steps complete!*\n\nYour free trial number is:\n\n<code>${freeNumber}</code>\n\nOTP will be sent automatically if detected.`, { chat_id: cid, message_id: q.message.message_id, parse_mode: 'HTML' });
        
        // Notify the admin about the free trial claim with security details
        await bot.sendMessage(ADMIN_ID, 
            `*Free Trial Claimed!*\n\n` +
            `*User:* \`${userId}\`\n` +
            `*Number:* \`${freeNumber}\`\n` +
            `*IP Address:* \`${userIpAddress}\`\n` +
            `*City:* ${city || 'N/A'}\n` +
            `*Coordinates:* ${latitude && longitude ? `${latitude.toFixed(4)}, ${longitude.toFixed(4)}` : 'N/A'}\n` +
            `*Status:* ✅ Verification Passed`, 
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error("Error during final verification:", error);
        await bot.answerCallbackQuery(q.id, { text: "An error occurred. Please try again.", show_alert: true });
    }
    return;
}

  // In bot.js, inside bot.on('callback_query', ...)

if (action === 'confirm_deluser') {
    const targetUserId = payload;
    
    await bot.editMessageText(`Deleting user ${targetUserId}...`, {
        chat_id: cid,
        message_id: q.message.message_id
    });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Delete from all relevant tables
        await client.query('DELETE FROM user_bots WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM user_deployments WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM user_activity WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM user_referrals WHERE referred_user_id = $1 OR inviter_user_id = $1', [targetUserId]);
        await client.query('DELETE FROM email_verification WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM completed_payments WHERE user_id = $1', [targetUserId]);
        await client.query('DELETE FROM banned_users WHERE user_id = $1', [targetUserId]);
        await client.query('COMMIT');
        
        await bot.editMessageText(`User \`${targetUserId}\` and all their associated data have been permanently deleted.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Error deleting user:", e);
        await bot.editMessageText(`❌ Failed to delete user ${targetUserId}. Check logs.`, {
            chat_id: cid,
            message_id: q.message.message_id
        });
    } finally {
        client.release();
    }
    return;
}

if (action === 'cancel_deluser') {
    await bot.editMessageText('User deletion cancelled.', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}


  // Add this inside bot.on('callback_query', async q => { ... })

  if (action === 'verify_join_temp_num') {
    const userId = q.from.id;
    // The cid variable was missing, which would cause an error later.
    const cid = q.message.chat.id.toString();

    try {
        const member = await bot.getChatMember(MUST_JOIN_CHANNEL_ID, userId);
        const isMember = ['creator', 'administrator', 'member'].includes(member.status);

        if (isMember) {
            // This code runs if the user IS a member
            const numberResult = await pool.query(
                "SELECT number FROM temp_numbers WHERE status = 'available' ORDER BY RANDOM() LIMIT 1"
            );

            if (numberResult.rows.length === 0) {
                await bot.editMessageText("Sorry, no free trial numbers are available right now. Please check back later.", {
                    chat_id: cid,
                    message_id: q.message.message_id
                });
                return;
            }

            const freeNumber = numberResult.rows[0].number;
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query("UPDATE temp_numbers SET status = 'assigned', user_id = $1, assigned_at = NOW() WHERE number = $2", [userId, freeNumber]);
                await client.query("INSERT INTO free_trial_numbers (user_id, number_used) VALUES ($1, $2)", [userId, freeNumber]);
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }

            await bot.editMessageText(`Verification successful! Your free trial number is: <code>${freeNumber}</code>`, {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'HTML'
            });
            await bot.sendMessage(userId, 'OTP will send automatically if detected.');
            await bot.sendMessage(ADMIN_ID, `User \`${userId}\` has claimed a free trial number: \`${freeNumber}\``, { parse_mode: 'Markdown' });

        } else {
            // --- THIS IS THE FIX ---
            // User is not in the channel. Send the alert and immediately stop the function.
            await bot.answerCallbackQuery(q.id, { text: "You haven't joined the channel yet. Please join and try again.", show_alert: true });
            return; // <-- This crucial line stops the code from continuing.
        }
    } catch (error) {
        console.error("Error during free trial number verification:", error);
        await bot.answerCallbackQuery(q.id, { text: "An error occurred during verification. Please try again.", show_alert: true });
    }
    return;
}

// In bot.js, inside bot.on('callback_query', ...)

if (action === 'users_registered') {
    const page = parseInt(payload, 10);
    await sendRegisteredUserList(cid, page, q.message.message_id);
    return;
}

if (action === 'users_unregistered') {
    const page = parseInt(payload, 10);
    await sendUnregisteredUserList(cid, page, q.message.message_id);
    return;
}

// bot.js (Inside bot.on('callback_query', ...))

if (action === 'free_trial_temp_num') {
    const userId = q.from.id.toString();
    const cid = q.message.chat.id.toString();
    
    // 🚨 FIX 1: Answer the callback query immediately to acknowledge the click.
    await bot.answerCallbackQuery(q.id, { text: "Starting security check..." }); // Added acknowledgement
    
    // Check if the APP_URL is configured, which is essential for the Mini App
    if (!process.env.APP_URL) {
        console.error("CRITICAL: APP_URL environment variable is not set. Cannot launch Mini App.");
        await bot.sendMessage(cid, "Error: The verification service is currently unavailable.", { show_alert: true });
        return;
    }
    
    try {
        // Check if the user has already claimed a trial
        const trialUserCheck = await pool.query("SELECT user_id FROM free_trial_numbers WHERE user_id = $1", [userId]);
        if (trialUserCheck.rows.length > 0) {
            await bot.editMessageText("You have already claimed your one-time free trial number.", { chat_id: cid, message_id: q.message.message_id });
            return;
        }

        // If the user is eligible, prepare to launch the Mini App
        const verificationUrl = `${process.env.APP_URL}/verify`;

        // This line sets the state before the Mini App is launched.
        userStates[cid] = { step: 'AWAITING_MINI_APP_VERIFICATION' };

        await bot.editMessageText("Please complete the security check in the window below to begin the verification process.", {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Start Security Check', web_app: { url: verificationUrl } }]
                ]
            }
        });

    } catch (error) {
        console.error("Error during free trial eligibility check:", error);
        // 🚨 FIX 2: Send the error message directly instead of using answerCallbackQuery, which was already sent.
        await bot.sendMessage(cid, "An error occurred during eligibility check. Please try again.");
    }
    return;
}



  
// Replace this block inside bot.on('callback_query', ...)

if (action === 'buy_temp_num') {
    const cid = q.message.chat.id.toString();
    const number = payload; // This is the full number

    // Check if the number is still available
    const numberCheck = await pool.query("SELECT status FROM temp_numbers WHERE number = $1", [number]);
    if (numberCheck.rows.length === 0 || numberCheck.rows[0].status !== 'available') {
        await bot.editMessageText('Sorry, this number is no longer available.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }
    
    // --- THIS IS THE UPDATED MESSAGE ---
    const message = `
*Important Instructions:*

1.  This is a Poland (**+48**) number. Ensure you select Poland as the country in WhatsApp.
2.  Request the verification code **only via Gmail**. Do not request an SMS code.
3.  Do not use this number to start new chats to avoid bans. It's best for joining groups or replying to messages.
`;
    // --- END OF UPDATED MESSAGE ---

    // Send the instructions message first
    await bot.sendMessage(cid, message, { parse_mode: 'Markdown' });

    // Generate a unique payment reference
    const reference = crypto.randomBytes(16).toString('hex');
    const priceInKobo = 200 * 100; // N200 in kobo

    try {
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: 'customer@email.com', // Replace with the user's actual email
                amount: priceInKobo,
                reference: reference,
                metadata: {
                    user_id: cid,
                    product: 'temporary_number',
                    phone_number: number
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        const paymentUrl = paystackResponse.data.data.authorization_url;

        // Edit the original message to show the payment button after the instructions
        await bot.editMessageText('Please click the button below to complete your payment.', {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Pay Now', url: paymentUrl }]
                ]
            }
        });
        
        // Update the number's status to pending payment
        await pool.query("UPDATE temp_numbers SET status = 'pending_payment', user_id = $1, assigned_at = NOW() WHERE number = $2", [cid, number]);

    } catch (error) {
        console.error('Paystack transaction failed:', error.response?.data || error.message);
        await bot.editMessageText('Sorry, an error occurred while creating the payment link. Please try again later.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }
}



  if (action === 'ask_admin_question') {
      delete userStates[cid]; // Clear user state
      userStates[cid] = { step: 'AWAITING_ADMIN_QUESTION_TEXT', data: {} };
      await bot.sendMessage(cid, 'Please type your question for the admin:');
      return;
  }

  

  // In bot.js, inside bot.on('callback_query', ...) handler

if (action === 'renew_bot') {
    const appName = payload;
    const renewalMessage = `Your bot "*${appName}*" is about to expire or has expired. Please select a renewal plan:`;

    // --- Create list of plan buttons ---
    const planButtons = [
        { text: 'Basic: ₦500 / 10 Days', callback_data: `select_renewal:500:10:${appName}` },
        { text: 'Standard: ₦1500 / 45 Days', callback_data: `select_renewal:1500:45:${appName}` },
        { text: 'Quarterly: ₦3,000 / 3 months', callback_data: `select_renewal:3000:92:${appName}` },
        { text: 'Semi-Annual: ₦5,000 / 6 months', callback_data: `select_renewal:5000:185:${appName}` },
        { text: 'Annual: ₦8,000 / 1 year', callback_data: `select_renewal:8000:365:${appName}` },
    ];
    // --- End list ---

    // --- Arrange buttons into rows of 2 ---
    const keyboardRows = chunkArray(planButtons, 2);

    // Add the 'Back' button as its own row at the end
    keyboardRows.push([{ text: '« Back', callback_data: `selectbot:${appName}` }]);
    // --- End arrangement ---

    await bot.editMessageText(renewalMessage, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: keyboardRows // Use the structured rows
        }
    });
    return;
}




// In bot.js, REPLACE your 'select_renewal' handler

if (action === 'select_renewal') {
    const priceNgn = parseInt(payload, 10);
    const days = parseInt(extra, 10);
    const appName = flag;

    // Call the new function to show payment choices, including the appName for renewal
    await showPaymentOptions(cid, q.message.message_id, priceNgn, days, appName);
    return;
}




  if (action === 'setup') {
      const st = userStates[cid];
      // Check if state is valid and message ID matches the one being edited
      if (!st || st.step !== 'AWAITING_WIZARD_CHOICE' || q.message.message_id !== st.message_id) {
          await bot.editMessageText('This menu has expired. Please start over by tapping /menu.', {
              chat_id: cid,
              message_id: q.message.message_id
          });
          delete userStates[cid]; // Clear invalid state
          return;
      }

      const [step, value] = [payload, extra];

      if (step === 'autostatus') {
          // --- 💡 START OF FIX: Add Raganork/Hermit Logic 💡 ---
          const botType = st.data.botType;
          if (botType === 'levanter') {
            st.data.AUTO_STATUS_VIEW = value === 'true' ? 'no-dl' : 'false';
          } else if (botType === 'raganork') {
            st.data.AUTO_STATUS_VIEW = (value === 'true').toString(); // 'true' or 'false'
          } else if (botType === 'hermit') {
            st.data.AUTO_STATUS_VIEW = (value === 'true').toString(); // 'true' or 'false'
          }
          // --- 💡 END OF FIX 💡 ---

          // --- 🎨 DESIGN UPDATE START 🎨 ---
          const session = st.data.SESSION_ID.slice(0, 15) + '...';
          const appName = st.data.APP_NAME;
          const statusView = st.data.AUTO_STATUS_VIEW;

          // Build the message inside a code block (```) for perfect formatting
          let confirmationText = "```\n"; // Start code block
          confirmationText += ` ═══ ${botType.toUpperCase()} ═══⊷\n`;
          confirmationText += ` ┃❃╭──────────────\n`;
          confirmationText += ` ┃❃│ Bot Type    : ${botType.toUpperCase()}\n`;
          confirmationText += ` ┃❃│ App Name    : ${appName}\n`;
          confirmationText += ` ┃❃│ Session     : ${session}\n`;
          confirmationText += ` ┃❃│ Auto Status : ${statusView}\n`;
          confirmationText += ` ┃❃╰───────────────\n\n`;
          confirmationText += ` Ready to proceed?`;
          confirmationText += "\n```"; // End code block
          // --- 🎨 DESIGN UPDATE END 🎨 ---

          const confirmationKeyboard = {
              reply_markup: {
                  inline_keyboard: [
                      [
                          { text: 'Confirm & Deploy', callback_data: `setup:startbuild`, style: 'success' },
                          { text: 'Cancel', callback_data: `setup:cancel`, style: 'danger' }
                      ]
                  ]
              }
          };

          await bot.editMessageText(confirmationText, {
              chat_id: cid,
              message_id: st.message_id,
              parse_mode: 'Markdown', // Use Markdown for the code block
              ...confirmationKeyboard
          });
      }

      // --- This part remains the same, but we add botType to the build call ---
      if (step === 'startbuild') {
          await bot.editMessageText('Configuration confirmed. Initiating deployment...', {
              chat_id: cid,
              message_id: st.message_id
          });
          const deployData = st.data; // Get all data
          delete userStates[cid]; // Clear user state
          
          // Pass botType to buildWithProgress
          await dbServices.buildWithProgress(cid, deployData, deployData.isFreeTrial, false, deployData.botType);
      }

      if (step === 'cancel') {
          await bot.editMessageText('Deployment cancelled.', {
              chat_id: cid,
              message_id: q.message.message_id
          });
          delete userStates[cid]; // Clear user state
      }
      return;
  }



  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await dbServices.addDeployKey(key, uses, cid); // Use dbServices
    // Clear the message with uses selection after generating key
    await bot.editMessageText(`Generated key: \`${key}\`\nUses: ${uses}`, {
      chat_id: cid,
      message_id: q.message.message_id,
      parse_mode: 'Markdown'
    }).catch(() => {});
    return;
  }

/// --- FIX: This block now bypasses key/payment for admin ---
if (action === 'confirm_and_pay_step') {
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_FINAL_CONFIRMATION') return;

    const price = process.env.KEY_PRICE_NGN || '1500';
    const isFreeTrial = st.data.isFreeTrial;
    const isAdmin = cid === ADMIN_ID;

    if (isFreeTrial || isAdmin) {
        await bot.editMessageText('Initiating deployment...', { chat_id: cid, message_id: q.message.message_id });
        delete userStates[cid];

        // ✅ FIX: Check for a pending referral session before building.
        let inviterId = null;
        try {
            const sessionResult = await pool.query(
                `SELECT data FROM sessions WHERE id = $1 AND expires_at > NOW()`,
                [`referral_session:${cid}`]
            );
            if (sessionResult.rows.length > 0) {
                inviterId = sessionResult.rows[0].data.inviterId;
            }
        } catch (e) { /* Ignore errors, proceed without inviterId */ }
        
        // Pass the found inviterId to the build function.
        await dbServices.buildWithProgress(cid, st.data, isFreeTrial, false, st.data.botType, inviterId);

    } else {
        st.step = 'AWAITING_KEY';
        await bot.editMessageText('Enter your Deploy key:', {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Make payment`, callback_data: 'buy_key_for_deploy', style: 'success' }, { text: 'Cancel', callback_data: 'cancel_payment_and_deploy', style: 'danger' }]
                ]
            }
        });
    }
    return;
}

// In bot.js (inside bot.on('callback_query', ...))

if (action === 'nowpayments_deploy' || action === 'nowpayments_renew') {
    const isRenewal = action === 'nowpayments_renew';
    
    // We receive NGN amount in payload, but we need to ignore it or use it for display.
    // We primarily rely on the 'days' (extra) to determine the USD price.
    
    // 1. Calculate USD Price based on Days
    const days = parseInt(extra, 10);
    const usdPrices = {
        10: 0.35,
        30: 1.00,
        92: 2.00,
        185: 3.35,
        365: 5.35
    };
    const priceUsd = usdPrices[days] || 1.00; // Fallback safety
    
    const appName = isRenewal ? extra2 : null; // extra2 might be undefined if not renewal, handled below

    // State check for new deployments
    let deployAppName, deploySessionId;
    if (!isRenewal) {
        const st = userStates[cid];
        // Safety check: if state is lost (bot restart), ask user to restart
        if (!st || !st.data) {
            return bot.answerCallbackQuery(q.id, { text: "Session expired. Please start /deploy again.", show_alert: true });
        }
        deployAppName = st.data.APP_NAME;
        deploySessionId = st.data.SESSION_ID;
    }

    // Generate Order ID
    let orderId;
    if (isRenewal) {
        orderId = `renew_${appName}_${crypto.randomBytes(8).toString('hex')}`;
    } else {
        orderId = `deploy_${deployAppName}_${crypto.randomBytes(4).toString('hex')}`;
    }

    await bot.editMessageText('Generating Crypto Invoice...', {
        chat_id: cid, message_id: q.message.message_id
    });

    try {
        // 2. Save to Pending Payments
        const userEmail = await getUserEmail(cid);
        await pool.query(
            `INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id, amount_expected) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (reference) DO NOTHING`,
            [
                orderId, 
                cid, 
                userEmail || 'crypto@user.com', 
                isRenewal ? 'renewal' : 'deploy', 
                isRenewal ? appName : deployAppName, 
                isRenewal ? 'renewal' : deploySessionId,
                priceUsd // Storing USD amount here for reference
            ]
        );
        
        // 3. Call NOWPayments INVOICE API (Changed from /payment to /invoice)
        const response = await axios.post('https://api.nowpayments.io/v1/invoice', 
        {
            price_amount: priceUsd,
            price_currency: 'usd',
            order_id: orderId,
            order_description: isRenewal ? `Renew ${appName} (${days} days)` : `Deploy Bot (${days} days)`,
            ipn_callback_url: `${process.env.APP_URL}/nowpayments-webhook`,
            success_url: `https://t.me/${process.env.BOT_USERNAME}`,
            cancel_url: `https://t.me/${process.env.BOT_USERNAME}`
        }, 
        {
            headers: {
                'x-api-key': process.env.NOWPAYMENTS_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        // Note: Invoice API returns 'invoice_url', not 'payment_url'
        const paymentUrl = response.data.invoice_url; 
        
        // 4. Send the Invoice Link
        await bot.editMessageText(
            `<b>Crypto Invoice Created</b>\n\nAmount: <b>$${priceUsd}</b>\nDuration: ${days} Days\n\nPlease click the button below to choose your coin (BTC, ETH, USDT, etc) and pay.\n\n<i>Your bot will start automatically once the network confirms the transaction.</i>`, 
            {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Click to Pay Crypto', url: paymentUrl }],
                        [{ text: '« Cancel', callback_data: 'cancel_payment_and_deploy' }]
                    ]
                }
            }
        );

    } catch (error) {
        console.error("[NOWPayments] Error:", error.response?.data || error.message);
        await bot.editMessageText('Could not generate crypto invoice. Please try again later.', {
            chat_id: cid,
            message_id: q.message.message_id
        });
    }
    return;
}

  // In bot.js, inside bot.on('callback_query', ...)

if (action === 'start_verification') {
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_VERIFICATION_BEFORE_ACTION') return;

    // Transition to the email entry step, preserving the original action data
    st.step = 'AWAITING_EMAIL';
    await bot.editMessageText('Please enter your email address to begin verification:', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}


// REPLACE your 'resend_otp' handler with this one

if (action === 'resend_otp') {
    if (!st || st.step !== 'AWAITING_OTP') {
        return bot.answerCallbackQuery(q.id); 
    }

    try {
        // Fetch the user's email and the last time a code was sent
        const result = await pool.query(
            'SELECT email, last_otp_sent_at FROM email_verification WHERE user_id = $1', 
            [cid]
        );
        
        if (result.rows.length === 0) {
            return bot.answerCallbackQuery(q.id, { text: 'Error: Your session expired.', show_alert: true });
        }

        const { email, last_otp_sent_at } = result.rows[0];
        
        // --- COOLDOWN CHECK ---
        if (last_otp_sent_at) {
            const timeSinceLastSend = Date.now() - new Date(last_otp_sent_at).getTime();
            const oneMinute = 60 * 1000;

            if (timeSinceLastSend < oneMinute) {
                const secondsLeft = Math.ceil((oneMinute - timeSinceLastSend) / 1000);
                return bot.answerCallbackQuery(q.id, { 
                    text: `Please wait ${secondsLeft} more seconds before resending.`, 
                    show_alert: true 
                });
            }
        }

        // If cooldown passes, proceed to send a new code
        const newOtp = generateOtp();
        const newOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

        // Update the database with the new code, expiration, AND the new "last sent" time
        await pool.query(
            'UPDATE email_verification SET otp = $1, otp_expires_at = $2, last_otp_sent_at = NOW() WHERE user_id = $3',
            [newOtp, newOtpExpiresAt, cid]
        );

        await sendVerificationEmail(email, newOtp);

        await bot.answerCallbackQuery(q.id, { text: `A new code has been sent to ${email}`, show_alert: true });

    } catch (error) {
        console.error('[Resend OTP] Error:', error);
        await bot.answerCallbackQuery(q.id, { text: 'Failed to resend code. Please try again.', show_alert: true });
    }
    return;
}



// This runs when the user clicks "✅ Yes, update"
if (action === 'confirm_session_update') {
    if (!st || st.step !== 'AWAITING_SESSION_UPDATE_CONFIRMATION') return;
    
    const { sessionId } = st.data;

    // ❗️ FIX: Determine session type and query only for matching bots.
    let sessionType;
    if (sessionId.startsWith(LEVANTER_SESSION_PREFIX)) {
        sessionType = 'levanter';
    } else if (sessionId.startsWith(RAGANORK_SESSION_PREFIX)) {
        sessionType = 'raganork';
    } else if (sessionId.startsWith(HERMIT_SESSION_PREFIX)) {
        sessionType = 'hermit';
    } else {
        sessionType = 'unknown'; // Fallback
    }
    const botsResult = await pool.query(
        "SELECT bot_name FROM user_bots WHERE user_id = $1 AND bot_type = $2",
        [cid, sessionType]
    );
    const matchingBots = botsResult.rows.map(row => row.bot_name);

    if (matchingBots.length === 0) {
        delete userStates[cid];
        return bot.editMessageText(`You don't have any *${sessionType}* bots to update.`, {
            chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
        });
    }

    if (matchingBots.length === 1) {
        // User has only one matching bot, update it directly.
        const botName = matchingBots[0];
        const workingMsg = await bot.editMessageText(`Updating session for your bot *${botName}*...`, {
            chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
        });
        
        const result = await updateUserVariable(cid, botName, 'SESSION_ID', sessionId);
        
        // ❗️ FIX: Edit the "Updating..." message with the final result.
        await bot.editMessageText(result.message, {
            chat_id: cid, message_id: workingMsg.message_id, parse_mode: 'Markdown'
        });
        delete userStates[cid];

    } else {
        // User has multiple matching bots, ask them to choose.
        const botButtons = matchingBots.map(botName => ({
            text: botName,
            callback_data: `apply_session_update:${botName}`
        }));
        
        const keyboard = chunkArray(botButtons, 3);
        await bot.editMessageText(`You have multiple *${sessionType}* bots. Please select which one to update:`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }
    return;
}

  
if (action === 'apply_session_update') {
    if (!st || st.step !== 'AWAITING_SESSION_UPDATE_CONFIRMATION') return;

    const botName = payload;
    const { sessionId } = st.data;

    const workingMsg = await bot.editMessageText(`Validating and updating session for *${escapeMarkdown(botName)}*...`, {
        chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
    });
    
    const botTypeResult = await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, botName]);
    const botType = botTypeResult.rows[0]?.bot_type;
    const isLevanter = botType === 'levanter' && sessionId.startsWith(LEVANTER_SESSION_PREFIX);
    const isRaganork = botType === 'raganork' && sessionId.startsWith(RAGANORK_SESSION_PREFIX);
    const isHermit = botType === 'hermit' && sessionId.startsWith(HERMIT_SESSION_PREFIX);

    if (!isLevanter && !isRaganork && !isHermit) { // <-- ADDED HERMIT
        delete userStates[cid];
        return bot.editMessageText(`**Validation Error:** The session ID is not valid for your *${botType}* bot named *${escapeMarkdown(botName)}*.`, {
            chat_id: cid, message_id: workingMsg.message_id, parse_mode: 'Markdown'
        });
    }

    // Call the updated function
    const result = await updateUserVariable(cid, botName, 'SESSION_ID', sessionId);
    
    // ❗️ FIX: Create the final message here and use escapeMarkdown
    let finalMessage;
    if (result.status === 'success') {
        finalMessage = `**Success!**\n\nThe session for your bot *${escapeMarkdown(botName)}* has been updated. The bot will now restart.`;
    } else {
        finalMessage = `**Failed!**\n\nCould not update the session for *${escapeMarkdown(botName)}*.\n*Reason:* ${escapeMarkdown(result.message)}`;
    }

    await bot.editMessageText(finalMessage, {
        chat_id: cid, message_id: workingMsg.message_id, parse_mode: 'Markdown'
    });
    delete userStates[cid];
    return;
}


// ADD this new handler inside your bot.on('callback_query', ...) function

// Handler for the "Change Email" button
if (action === 'change_email') {
    // First, check if the user is in the correct state to perform this action.
    if (!st || st.step !== 'AWAITING_OTP') {
        // Silently ignore if the state is wrong (e.g., from an old message).
        return bot.answerCallbackQuery(q.id); 
    }
    
    // Acknowledge the button press to stop the loading animation.
    await bot.answerCallbackQuery(q.id);

    // 1. Change the user's state back to waiting for an email.
    st.step = 'AWAITING_EMAIL';

    // 2. Reset the invalid email attempt counter so they get fresh tries.
    if (st.data.emailAttempts) {
        delete st.data.emailAttempts;
    }

    // 3. Edit the message to ask for the new email and remove the old buttons.
    await bot.editMessageText('Please enter the new email address you would like to use:', {
        chat_id: cid,
        message_id: q.message.message_id,
        // No reply_markup is needed, so the old buttons will be removed.
    });
    
    return;
}

// --- FIX: New callbacks to handle key entry or payment ---

// --- FIX: Awaiting key handler now includes a payment button ---
if (action === 'deploy_with_key') {
    const isFreeTrialFromCallback = payload === 'free_trial';
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_KEY_OR_PAYMENT') return;

    // For paid deployments, ask for the key with a payment option.
    if (!isFreeTrialFromCallback) {
        st.step = 'AWAITING_KEY';
        const price = process.env.KEY_PRICE_NGN || '1500';
        await bot.editMessageText('Enter your Deploy key:', {
            chat_id: cid,
            message_id: q.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Make payment (₦${price})`, callback_data: 'buy_key_for_deploy' }]
                ]
            }
        });
    } else {
        // For free trials, trigger the deployment directly.
        await bot.editMessageText('Initiating Free Trial deployment...', { chat_id: cid, message_id: q.message.message_id });
        delete userStates[cid];
        await dbServices.buildWithProgress(cid, st.data, true, false, st.data.botType);
    }
    return;
}


// REPLACE your existing 'buy_key_for_deploy' handler with this one.

// In bot.js, inside the callback_query handler

if (action === 'buy_key_for_deploy') {
    const st = userStates[cid];
    // This state check is crucial
    if (!st || st.step !== 'AWAITING_KEY') {
        await bot.answerCallbackQuery(q.id, { text: "Your session has expired. Please start over.", show_alert: true });
        return;
    }
    
    // Instead of asking for email, now we show the pricing tiers
    await sendPricingTiers(cid, q.message.message_id);
    return;
}

  // In bot.js, add this new handler inside the callback_query function

// In bot.js, REPLACE your 'select_plan' handler

if (action === 'select_plan') {
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_KEY') return;
    
    const priceNgn = parseInt(payload, 10);
    const days = parseInt(extra, 10);

    // Call the new function to show payment choices
    await showPaymentOptions(cid, q.message.message_id, priceNgn, days);
    return;
}

  // In bot.js, ADD these new handlers to your callback_query function

// This handles the final choice to pay with Paystack
// REPLACE the 'paystack_deploy'/'paystack_renew' handler with this one

if (action === 'paystack_deploy' || action === 'paystack_renew') {
    const isRenewal = action === 'paystack_renew';
    const priceNgn = parseInt(payload, 10);
    const days = parseInt(extra, 10);
    
    if (isRenewal) {
        // For renewals, we get the appName from the callback and don't need to check state.
        const appName = flag;
        await initiatePaystackPayment(cid, q.message.message_id, {
            isRenewal: true, priceNgn, days, appName
        });
    } else {
        // For new deployments, we must check the user's state.
        const st = userStates[cid];
        if (!st || st.step !== 'AWAITING_KEY') {
            return bot.answerCallbackQuery(q.id, { text: "Your session has expired. Please start over.", show_alert: true });
        }
        await initiatePaystackPayment(cid, q.message.message_id, {
            isRenewal: false, priceNgn, days,
            appName: st.data.APP_NAME,
            botType: st.data.botType,
            APP_NAME: st.data.APP_NAME,
            SESSION_ID: st.data.SESSION_ID
        });
    }
    return;
}


if (action === 'flutterwave_deploy' || action === 'flutterwave_renew') {
    const isRenewal = action === 'flutterwave_renew';
    const priceNgn = parseInt(payload, 10);
    const days = parseInt(extra, 10);
    const appName = isRenewal ? flag : null;
    const userEmail = await getUserEmail(cid); // Get current verified email

    // --- NEW DEPLOYMENT CONTEXT ---
    let deployMetadata = {};
    if (!isRenewal) {
        const st = userStates[cid];
        if (!st || st.step !== 'AWAITING_KEY') {
            return bot.answerCallbackQuery(q.id, { text: "Your session has expired. Please start over.", show_alert: true });
        }
        // 🚨 FIX 1: Capture deployment details from state for metadata
        deployMetadata = {
            botType: st.data.botType,
            APP_NAME: st.data.APP_NAME,
            SESSION_ID: st.data.SESSION_ID,
            price: priceNgn,
        };
    }
    // --- END NEW DEPLOYMENT CONTEXT ---
    
    // 🚨 FIX 2: Define FINAL Metadata
    const metadata = { 
        user_id: cid, 
        product: isRenewal ? 'Bot Renewal' : `Deployment Key - ${days} Days`, 
        days: days,
        appName: appName, // For renewal
        ...deployMetadata, // For new deploy
    };
    
    // We generate the reference here whether or not we have the email.
    const reference = `flw_${crypto.randomBytes(12).toString('hex')}`;

    // --- The key difference: Do NOT insert into pending_payments yet if no email exists! ---
    // The payment link generation will fail if the email is null, and the next function must handle the state change.
    
    if (userEmail) {
        // If email exists, proceed to insert pending payment and generate link immediately
        await bot.editMessageText('Generating Flutterwave payment link...', {
            chat_id: cid, message_id: q.message.message_id
        });
        
        await pool.query(
            'INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [reference, cid, userEmail, metadata.botType || 'unknown', metadata.APP_NAME, metadata.SESSION_ID]
        );
    }
    
    // 🚨 FIX 3: Call initiateFlutterwavePayment. It will check userEmail internally.
    const paymentUrl = await initiateFlutterwavePayment(
        cid, 
        userEmail, // Pass current email (can be null)
        priceNgn, 
        reference, 
        metadata
    );
    
    if (paymentUrl) {
        // This block runs if initiateFlutterwavePayment succeeded (i.e., email existed)
        await bot.editMessageText(
            `Click the button below to complete your payment with Flutterwave.`, {
                chat_id: cid, message_id: q.message.message_id,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl, style: 'success' }]]
                }
            }
        );
    } else {
        // This block runs if initiateFlutterwavePayment returned null, meaning:
        // 1. The key was bad.
        // 2. The userEmail was null, AND the state was set to AWAITING_EMAIL_FOR_AUTO_REG.
        
        // If the state was set (userEmail was null), we trust the subsequent message handler.
        // Otherwise, send a generic error.
        if (!userStates[cid] || userStates[cid].step !== 'AWAITING_EMAIL_FOR_AUTO_REG') {
            await bot.editMessageText('Sorry, an error occurred while creating the Flutterwave payment link.', {
                chat_id: cid, message_id: q.message.message_id
            });
        }
        // If state was set, the message asking for email was already sent inside initiateFlutterwavePayment.
    }
    return;
}






// ADD this new handler for the renewal cancel button

if (action === 'cancel_renewal') {
    const appName = payload;
    // Simulate a click on the 'selectbot' button to return to the bot's main menu.
    await bot.answerCallbackQuery(q.id);
    q.data = `selectbot:${appName}`;
    bot.emit('callback_query', q);
    return;
}





// --- NEW: Handler for the 'Cancel' button on the payment screen ---
if (action === 'cancel_payment_and_deploy') {
    const st = userStates[cid];
    if (!st) return;

    // Delete the pending payment record if it exists
    if (st.data && st.data.reference) {
        try {
            await pool.query('DELETE FROM pending_payments WHERE reference = $1', [st.data.reference]);
            console.log(`[Payment] Canceled pending payment with reference: ${st.data.reference}`);
        } catch (error) {
            console.error(`Error deleting pending payment:`, error.message);
        }
    }

    delete userStates[cid]; // Clear the state to cancel the deployment flow
    await bot.editMessageText('Deployment process canceled.', {
        chat_id: cid,
        message_id: q.message.message_id
    });
    return;
}


if (action === 'selectapp' || action === 'selectbot') {
    const messageId = q.message.message_id;
    const appName = payload;

    userStates[cid] = { step: 'APP_MANAGEMENT', data: { appName: appName } };
    
    if (userStates[cid]?.data?.logInterval) {
        clearInterval(userStates[cid].data.logInterval);
        delete userStates[cid].data.logInterval;
    }

    await bot.editMessageText(`Checking status for "*${appName}*" ...`, {
        chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
    });
    
    const dbBotInfo = (await pool.query(
        'SELECT ud.expiration_date, ud.paused_at, ub.status AS wpp_status, ub.bot_type FROM user_deployments ud ' +
        'LEFT JOIN user_bots ub ON ud.app_name = ub.bot_name AND ud.user_id = ub.user_id ' +
        'WHERE ud.user_id=$1 AND ud.app_name=$2', 
        [cid, appName]
    )).rows[0];

    const dynoStatus = await dbServices.getDynoStatus(appName);
    if (dynoStatus === 'deleted' || dynoStatus === 'error') {
        return bot.editMessageText(`Could not retrieve status for "*${appName}*". It may have been deleted.`, {
            chat_id: cid, message_id: messageId, parse_mode: 'Markdown'
        });
    }

    const botType = (dbBotInfo?.bot_type || 'Bot').toUpperCase();
    const expirationDate = dbBotInfo?.expiration_date ? new Date(dbBotInfo.expiration_date) : null;
    const now = new Date();
    const keyboard = [];
    
    // TEMPLATE LITERAL FIX: Use backticks (`) for the variables inside the string to work
    const daysLeft = expirationDate ? Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24)) : 'N/A';
    const finalStatusText = dbBotInfo?.paused_at ? 'Paused' : (dbBotInfo?.wpp_status === 'logged_out' ? 'Logged Out' : 'Connected');

    const isExpired = expirationDate && expirationDate < now;
    const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;

    if (isExpired) {
        const timeSinceExpiry = now - expirationDate.getTime();
        const hoursRemaining = Math.max(0, Math.round((GRACE_PERIOD_MS - timeSinceExpiry) / (1000 * 60 * 60)));

        let message = "```\n ═══ SUSPENDED ═══⊷\n ┃❃╭──────────────\n ┃❃│ Bot Name : " + appName + "\n ┃❃│ Status   : Expired\n ┃❃│ Deletion : in " + hoursRemaining + " hours\n ┃❃╰───────────────\n\n This bot is suspended. Renew now to restore it.\n```";

        keyboard.push(
            [{ text: 'Renew Bot', callback_data: `renew_bot:${appName}`, style: 'success' }], 
            [{ text: 'Delete Bot', callback_data: `userdelete:${appName}`, style: 'danger' }]
        );

        await bot.editMessageText(message, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });

    } else if (dbBotInfo?.paused_at) {
        let message = "```\n ═══ " + botType + " ═══⊷\n ┃❃╭──────────────\n ┃❃│ Bot Name : " + appName + "\n ┃❃│ Status   : Paused\n ┃❃│ Expires  : Paused\n ┃❃╰───────────────\n\n This bot is turned off and its timer is paused.\n```";

        keyboard.push([{ text: 'Turn Bot On (Resume)', callback_data: `toggle_dyno:on:${appName}`, style: 'success' }]);
        keyboard.push([{ text: '« Back', callback_data: 'back_to_app_list', style: 'primary' }]); // Corrected callback_data

        await bot.editMessageText(message, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        
    } else if (dynoStatus === 'on') {
        let message = "```\n ═══ " + botType + " ═══⊷\n ┃❃╭──────────────\n ┃❃│ Bot Name : " + appName + "\n ┃❃│ Status   : " + finalStatusText + "\n ┃❃│ Expires  : " + daysLeft + " days left\n ┃❃╰───────────────\n```";
        
        // FIX: All buttons in the row must be objects if style is used
        const mainRow = [
            { text: 'Info', callback_data: `info:${appName}`, style: 'success' },
            { text: 'Restart', callback_data: `restart:${appName}`, style: 'success' },
            { text: 'Logs', callback_data: `logs:${appName}`, style: 'success' }
        ];

        if (daysLeft <= 7) {
            mainRow.splice(2, 0, { text: 'Renew', callback_data: `renew_bot:${appName}`, style: 'danger' });
        }
        
        keyboard.push(
            mainRow,
            [
                { text: 'Redeploy', callback_data: `redeploy_app:${appName}`, style: 'success' },
                { text: 'Delete', callback_data: `userdelete:${appName}`, style: 'danger' },
                { text: 'Set Variable', callback_data: `setvar:${appName}`, style: 'success' }
            ],
            [
                { text: 'Backup', callback_data: `backup_app:${appName}`, style: 'success' },
                { text: 'Switch Bot', callback_data: `switch_bot_start:${appName}`, style: 'success' },
                { text: 'Turn Off (Pause)', callback_data: `toggle_dyno:off:${appName}`, style: 'danger' }
            ],
            [{ text: '« Back', callback_data: 'back_to_app_list', style: 'primary' }] // Fixed property name
        );

        await bot.editMessageText(message, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });

    } else { 
        let message = "```\n ═══ " + botType + " ═══⊷\n ┃❃╭──────────────\n ┃❃│ Bot Name : " + appName + "\n ┃❃│ Status   : Off\n ┃❃│ Expires  : Active\n ┃❃╰───────────────\n\n This bot is currently turned off.\n```";

        keyboard.push([{ text: 'Turn Bot On (Resume)', callback_data: `toggle_dyno:on:${appName}`, style: 'success' }]);
        keyboard.push([{ text: '« Back', callback_data: 'back_to_app_list', style: 'primary' }]);

        await bot.editMessageText(message, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    }
}



// 1. START SWITCH: Show available types
if (action === 'switch_bot_start') {
    const appName = payload;
    
    // Fetch current bot type to exclude it
    const botResult = await pool.query('SELECT bot_type FROM user_bots WHERE bot_name = $1', [appName]);
    const currentType = botResult.rows[0]?.bot_type || 'levanter';
    
    const options = [];
    if (currentType !== 'levanter') options.push({ text: 'Switch to Levanter', callback_data: `switch_select_type:levanter:${appName}` });
    if (currentType !== 'raganork') options.push({ text: 'Switch to Raganork', callback_data: `switch_select_type:raganork:${appName}` });
    if (currentType !== 'hermit') options.push({ text: 'Switch to Hermit', callback_data: `switch_select_type:hermit:${appName}` });
    
    options.push({ text: '« Cancel', callback_data: `selectapp:${appName}` });

    await bot.editMessageText(`**Switch Bot Type**\n\nCurrent Type: *${currentType.toUpperCase()}*\n\nSelect the new bot type you want to migrate to.`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: chunkArray(options, 1) }
    });
    return;
}

// 2. TYPE SELECTED: Ask for Session ID
if (action === 'switch_select_type') {
    const targetType = payload;
    const appName = extra;
    
    // Set State
    userStates[cid] = {
        step: 'AWAITING_SWITCH_SESSION',
        data: {
            appName: appName,
            targetType: targetType
        }
    };
    
    let guideUrl = LEVANTER_SESSION_SITE_URL;
    if (targetType === 'raganork') guideUrl = RAGANORK_SESSION_SITE_URL;
    if (targetType === 'hermit') guideUrl = HERMIT_SESSION_SITE_URL;

    await bot.editMessageText(`You are switching to *${targetType.toUpperCase()}*.\n\nPlease enter your **New Session ID** for ${targetType}:`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: 'Get Session ID', url: guideUrl }]]
        }
    });
    return;
}

// 3. CONFIRM SWITCH: Verify Key/Payment
if (action === 'confirm_switch_pay') {
    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_SWITCH_CONFIRM') return;
    
    // Move to Key/Payment State
    st.step = 'AWAITING_KEY_FOR_SWITCH';
    
    // 500 NGN Price
    const price = 500;
    
    await bot.editMessageText(
        `**Complete Migration**\n\nCost: **₦${price}** (or 1 Key)\n\nPlease enter your **Deploy Key** or make a payment to proceed.`, 
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Pay ₦${price} (Flutterwave)`, callback_data: `flutterwave_switch:${price}`, style: 'success' }],
                    [{ text: 'Cancel', callback_data: `selectapp:${st.data.appName}`,  style: 'danger' }]
                ]
            }
        }
    );
    return;
}

// 4. PAYMENT HANDLERS (Paystack/Flutterwave for Switch)
if (action === 'paystack_switch' || action === 'flutterwave_switch') {
    const price = parseInt(payload);
    const provider = action.split('_')[0]; 
    const st = userStates[cid];
    
    // 1. Safety Check
    if (!st || st.step !== 'AWAITING_KEY_FOR_SWITCH') {
        return bot.answerCallbackQuery(q.id, { text: "Session expired. Please start over.", show_alert: true });
    }

    const appName = st.data.appName;

    // --- 💡 START OF FIX: GET REMAINING DAYS FROM DB 💡 ---
    let remainingDays = 0;
    try {
        const result = await pool.query(
            `SELECT expiration_date FROM user_deployments WHERE app_name = $1 AND user_id = $2`,
            [appName, cid]
        );
        
        if (result.rows.length > 0 && result.rows[0].expiration_date) {
            const expDate = new Date(result.rows[0].expiration_date);
            const now = new Date();
            const diffTime = expDate - now;
            // Calculate days left (round up so they don't lose the partial day)
            remainingDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            // If expired (negative), set to 0
            if (remainingDays < 0) remainingDays = 0;
        }
    } catch (e) {
        console.error(`Error calculating remaining days for ${appName}:`, e);
        // Fallback to 0 if DB fails, but proceed with switch
    }
    
    console.log(`[Switch] User ${cid} switching ${appName}. Remaining Days: ${remainingDays}`);
    // --- 💡 END OF FIX 💡 ---
    
    // 2. Define a special botType so the webhook knows this is a MIGRATION
    const switchBotType = `switch-${st.data.targetType}`; 

    // --- PAYSTACK LOGIC ---
    if (provider === 'paystack') {
        // We pass the calculated remainingDays
        await initiatePaystackPayment(cid, q.message.message_id, {
            isRenewal: false, 
            priceNgn: price, 
            days: remainingDays, 
            appName: appName,
            botType: switchBotType, 
            APP_NAME: appName,
            SESSION_ID: st.data.sessionId
        });
        // Note: initiatePaystackPayment handles state internally if email is missing.
        // If email exists, it sends link. You can optionally delete state here if you trust it won't conflict.
    } 

    // --- FLUTTERWAVE LOGIC ---
    if (provider === 'flutterwave') {
        const reference = `flw_sw_${crypto.randomBytes(8).toString('hex')}`;
        
        // Define metadata specific to the switch
        const metadata = {
            user_id: cid,
            product: 'Bot Switch',
            days: remainingDays, // <--- NOW USES CALCULATED DAYS
            appName: appName,    
            botType: switchBotType,
            SESSION_ID: st.data.sessionId,
            price: price
        };

        // 3. Call initiateFlutterwavePayment
        const paymentUrl = await initiateFlutterwavePayment(
            cid, 
            null, // Forces email check/prompt
            price, 
            reference, 
            metadata
        );
        
        // 4. If we got a URL back, it means the user HAS an email and we can proceed.
        if (paymentUrl) {
            const userEmail = await getUserEmail(cid);
            
            // Save to Pending Payments
            await pool.query(
                'INSERT INTO pending_payments (reference, user_id, email, bot_type, app_name, session_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [reference, cid, userEmail, switchBotType, appName, st.data.sessionId]
            );

            await bot.editMessageText(
                `Click the button below to complete your migration payment (₦${price}).`, {
                    chat_id: cid, message_id: q.message.message_id,
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Pay Now', url: paymentUrl }]]
                    }
                }
            );

            // --- 💡 FIX: TERMINATE STATE IMMEDIATELY ---
            // Since the link is generated, we don't need to wait for a key anymore.
            delete userStates[cid];
            // ------------------------------------------
        }
    }
    
    return;
}



  
if (action === 'toggle_dyno') {
    const desiredState = payload; // 'on' or 'off'
    const appName = extra;
    const quantity = (desiredState === 'on') ? 1 : 0;

    await bot.answerCallbackQuery(q.id, { text: `Turning bot ${desiredState}...` });
    
    try {
        // --- NEW PAUSE/RESUME LOGIC ---
        if (desiredState === 'on') {
            // Bot is being turned ON. We need to un-pause it.
            const pauseData = await pool.query("SELECT paused_at, expiration_date FROM user_deployments WHERE user_id = $1 AND app_name = $2", [cid, appName]);
            
            if (pauseData.rows.length > 0 && pauseData.rows[0].paused_at) {
                const pausedAt = new Date(pauseData.rows[0].paused_at);
                const expirationDate = new Date(pauseData.rows[0].expiration_date);
                
                // Calculate how long it was paused (in milliseconds)
                const pausedDurationMs = Date.now() - pausedAt.getTime();
                
                // Add the paused time back to the original expiration date
                const newExpirationDate = new Date(expirationDate.getTime() + pausedDurationMs);

                // Update the database: set new expiry and remove the pause timestamp
                await pool.query(
                    "UPDATE user_deployments SET paused_at = NULL, expiration_date = $1 WHERE user_id = $2 AND app_name = $3",
                    [newExpirationDate, cid, appName]
                );
                console.log(`[Dyno] Un-paused bot ${appName}. Paused duration: ${pausedDurationMs}ms. New expiry: ${newExpirationDate.toISOString()}`);
            }
        } else {
            // Bot is being turned OFF. We need to pause it.
            await pool.query(
                "UPDATE user_deployments SET paused_at = NOW() WHERE user_id = $1 AND app_name = $2",
                [cid, appName]
            );
            console.log(`[Dyno] Paused bot ${appName}. Expiration countdown is now stopped.`);
        }
        // --- END OF NEW LOGIC ---

        // This is the original Heroku API call
        await herokuApi.patch(`/apps/${appName}/formation/web`, 
            { quantity: quantity },
            { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
        );
        
        await bot.answerCallbackQuery(q.id, { text: `Bot successfully turned ${desiredState}!` });
        
        // Refresh the bot menu to show the new status
        q.data = `selectbot:${appName}`;
        bot.emit('callback_query', q);

    } catch (error) {
        console.error(`[Dyno Toggle] Error toggling dyno for ${appName}:`, error.message);
        await bot.answerCallbackQuery(q.id, { text: 'An error occurred. Please try again.', show_alert: true });
    }
    return;
}


// ... (existing code within bot.on('callback_query', async q => { ... })) ...

  if (action === 'backup_app') { // Handle Backup button click
    const appName = payload;
    const messageId = q.message.message_id;
    const cid = q.message.chat.id.toString(); // Ensure cid is defined here

    await bot.editMessageText(`Checking backup status for "*${escapeMarkdown(appName)}*"...`, { // Preliminary message
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    }).catch(err => console.warn(`Failed to edit message with preliminary backup text: ${err.message}`));

    try {
        // --- NEW: Check if already backed up and active on Heroku ---
        const existingBackup = await pool.query(
            `SELECT deleted_from_heroku_at FROM user_deployments WHERE user_id = $1 AND app_name = $2;`,
            [cid, appName] // Query by user_id and app_name
        );

        // If a record exists AND deleted_from_heroku_at is NULL, it means it's currently backed up and active.
        if (existingBackup.rows.length > 0 && existingBackup.rows[0].deleted_from_heroku_at === null) {
            return bot.editMessageText(`App "*${escapeMarkdown(appName)}*" is already backed up and currently active.`, {
                chat_id: cid,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
                }
            });
        }
        // --- END NEW CHECK ---

        // Proceed with actual backup. If it was previously marked as deleted, saveUserDeployment will update it.
        const appVars = (await herokuApi.get(
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        )).data;
        const currentSessionId = appVars.SESSION_ID; // Assuming SESSION_ID is important for restore
        const botTypeResult = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter'; // Get bot type from main DB


        if (!currentSessionId) {
            return bot.editMessageText(`Cannot backup "*${escapeMarkdown(appName)}*": No SESSION_ID found. Please set it first.`, {
                chat_id: cid,
                message_id: messageId,
                parse_mode: 'Markdown'
            });
        }
        // Save/Update to user_deployments. deploy_date & expiration_date are preserved on conflict.
        // saveUserDeployment will also set deleted_from_heroku_at to NULL, marking it as active/backed-up.
        await dbServices.saveUserDeployment(cid, appName, currentSessionId, appVars, botTypeResult); // Use dbServices

        await bot.editMessageText(`App "*${escapeMarkdown(appName)}*" successfully backed up! You can restore it later if needed.`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        await bot.editMessageText(`❌ Failed to backup app "*${escapeMarkdown(appName)}*": ${escapeMarkdown(errorMsg)}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    }
    return; // Ensure this function exits cleanly
  }


      if (action === 'add_assign_app') {
    const appName = payload;
    const targetUserId = extra;

    if (cid !== ADMIN_ID) {
        return bot.editMessageText("You are not authorized for this action.", { chat_id: cid, message_id: q.message.message_id });
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_ADD' || st.data.targetUserId !== targetUserId) {
        await bot.editMessageText("This session has expired. Please use `/add <user_id>` again.", { chat_id: cid, message_id: q.message.message_id });
        delete userStates[cid];
        return;
    }

    await bot.editMessageText(`Verifying and assigning app "*${appName}*" to user \`${targetUserId}\`...`, {
        chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
    });

    try {
        // 1. Get the app's current config from Heroku. This also verifies it exists there.
        const configRes = await herokuApi.get(`https://api.heroku.com/apps/${appName}/config-vars`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const configVars = configRes.data;
        const sessionId = configVars.SESSION_ID;

        // 2. Determine bot type from session ID
        let botType = 'levanter';
        if (sessionId && sessionId.startsWith(RAGANORK_SESSION_PREFIX)) {
            botType = 'raganork';
        }

        // 3. Check if the bot is already in our DB to see if this is an INSERT or an UPDATE
        const existingOwnerResult = await pool.query('SELECT user_id FROM user_bots WHERE bot_name = $1', [appName]);

        if (existingOwnerResult.rows.length > 0) {
            // --- SCENARIO 1: OWNERSHIP TRANSFER ---
            const oldOwnerId = existingOwnerResult.rows[0].user_id;
            console.log(`[Admin] Transferring ownership of "${appName}" from ${oldOwnerId} to ${targetUserId}.`);

            await pool.query('UPDATE user_bots SET user_id = $1, session_id = $2, bot_type = $3 WHERE bot_name = $4 AND user_id = $5', [targetUserId, sessionId, botType, appName, oldOwnerId]);
            await pool.query('UPDATE user_deployments SET user_id = $1, session_id = $2, config_vars = $3, bot_type = $4 WHERE app_name = $5 AND user_id = $6', [targetUserId, sessionId, configVars, botType, appName, oldOwnerId]);
            
            await bot.editMessageText(`App "*${appName}*" successfully *transferred* to user \`${targetUserId}\`. Its expiration date is preserved.`, {
                chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });

        } else {
            // --- SCENARIO 2: ADDING A NEW BOT ---
            console.log(`[Admin] Adding new bot "${appName}" to database for user ${targetUserId}.`);

            await dbServices.addUserBot(targetUserId, appName, sessionId, botType);
            await dbServices.saveUserDeployment(targetUserId, appName, sessionId, configVars, botType);

            await bot.editMessageText(`App "*${appName}*" successfully *added* to the database and assigned to user \`${targetUserId}\`.`, {
                chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
            });
        }

        await bot.sendMessage(targetUserId, `The admin has assigned the bot "*${appName}*" to your account. You can now manage it from "My Bots".`, { parse_mode: 'Markdown' });

    } catch (e) {
        let errorMsg = e.message;
        if (e.response?.status === 404) {
            errorMsg = `The app "${appName}" was not found on your Heroku account.`;
        } else if (e.response?.data?.message) {
            errorMsg = e.response.data.message;
        }
        console.error(`[Admin] Error assigning app "${appName}":`, errorMsg);
        await bot.editMessageText(`Failed to assign app "*${appName}*": ${errorMsg}`, {
            chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown'
        });
    } finally {
        delete userStates[cid];
    }
    return;
  }




  if (action === 'remove_app_from_user') {
    const appName = payload;
    const targetUserId = extra;

    console.log(`[CallbackQuery - remove_app_from_user] Received selection for app: ${appName} to remove from user: ${targetUserId}`);
    console.log(`[CallbackQuery - remove_app_from_user] Current state for ${cid} is:`, userStates[cid]);

    if (cid !== ADMIN_ID) {
        await bot.editMessageText("You are not authorized to perform this action.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        return;
    }

    const st = userStates[cid];
    if (!st || st.step !== 'AWAITING_APP_FOR_REMOVAL' || st.data.targetUserId !== targetUserId) {
        console.error(`[CallbackQuery - remove_app_from_user] State mismatch for ${cid}. Expected AWAITING_APP_FOR_REMOVAL for ${targetUserId}, got:`, st);
        await bot.editMessageText("This removal session has expired or is invalid. Please start over with `/remove <user_id>`.", {
            chat_id: cid,
            message_id: q.message.message_id
        });
        delete userStates[cid]; // Clear user state
        return;
    }

    await bot.editMessageText(`Removing app "*${appName}*" from user \`${targetUserId}\`'s dashboard...`, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown'
    });

    try {
        await dbServices.deleteUserBot(targetUserId, appName); // Use dbServices
        await dbServices.markDeploymentDeletedFromHeroku(targetUserId, appName); // NEW: Mark from backup DB as deleted, not delete

        console.log(`[Admin] Successfully called deleteUserBot for ${appName} from user ${targetUserId}.`);

        await bot.editMessageText(`App "*${appName}*" successfully removed from user \`${targetUserId}\`'s dashboard.`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });

        await bot.sendMessage(targetUserId, `The admin has removed bot "*${appName}*" from your "My Bots" menu.`, { parse_mode: 'Markdown' });
        console.log(`[Admin] Sent removal notification to target user ${targetUserId}.`);

    } catch (e) {
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[Admin] Error removing app "${appName}" from user ${targetUserId}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to remove app "*${appName}*" from user \`${targetUserId}\`'s dashboard: ${errorMsg}`, {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown'
        });
    } finally {
        delete userStates[cid]; // Clear user state
        console.log(`[Admin] State cleared for ${cid} after remove_app_from_user flow.`);
    }
    return;
  }

  // --- REPLACE your old 'info' block with this new one ---
// --- REPLACE your old 'info' block with this new one ---


if (action === 'info') {
    const appName = payload;
    const messageId = q.message.message_id;

    await bot.editMessageText(`Fetching app info for "*${escapeMarkdown(appName)}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
    
    try {
        const [appRes, configRes, dynoRes] = await Promise.all([
            herokuApi.get(`https://api.heroku.com/apps/${appName}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }),
            herokuApi.get(`https://api.heroku.com/apps/${appName}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }),
            herokuApi.get(`https://api.heroku.com/apps/${appName}/dynos`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } })
        ]);

        const appData = appRes.data;
        const configData = configRes.data;
        const dynoData = dynoRes.data;

        let dynoStatus = 'Inactive';
        if (dynoData.length > 0 && ['up', 'starting', 'restarting'].includes(dynoData[0].state)) {
            dynoStatus = 'Active';
        }
      
        // --- START OF FIX ---
        const ownerId = await dbServices.getUserIdByBotName(appName);
        let expirationInfo = "N/A";

        if (ownerId) {
            // Correctly read the expiration_date from the main database
            const deploymentDetails = (await pool.query('SELECT expiration_date FROM user_deployments WHERE user_id=$1 AND app_name=$2', [ownerId, appName])).rows[0];
            
            if (deploymentDetails && deploymentDetails.expiration_date) {
                const expirationDate = new Date(deploymentDetails.expiration_date);
                const now = new Date();
                const daysLeft = Math.ceil((expirationDate - now) / (1000 * 60 * 60 * 24));
                
                if (daysLeft > 0) {
                    expirationInfo = `${daysLeft} days remaining`;
                } else {
                    expirationInfo = 'Expired';
                }
            }
        }
        // --- END OF FIX ---

        const infoText = `*App Info: ${appData.name}*\n\n` +
                       `*Dyno Status:* ${dynoStatus}\n` +
                       `*Created:* ${new Date(appData.created_at).toLocaleDateString()}\n` +
                       `*Expiration:* ${expirationInfo}\n\n` +
                       `*Key Config Vars:*\n` +
                       `  \`SESSION_ID\`: ${configData.SESSION_ID ? 'Set' : 'Not Set'}\n` +
                       `  \`AUTO_STATUS_VIEW\`: \`${configData.AUTO_STATUS_VIEW || 'false'}\`\n`;

      return bot.editMessageText(infoText, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
        }
      });
    } catch (e) {
      if (e.response && e.response.status === 404) {
          await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, true);
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      return bot.editMessageText(`Error fetching info: ${errorMsg}`, {
        chat_id: cid, message_id: messageId,
        reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]] }
      });
    }
}

  if (action === 'restart') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        await bot.sendMessage(cid, "Please select an app again from 'My Bots'.");
        delete userStates[cid]; // Clear invalid state
        return;
    }
    const messageId = q.message.message_id;

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Restarting bot "*${payload}*"...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    try {
      await herokuApi.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });

      await bot.editMessageText(`Bot "*${payload}*" restarted successfully!`, {
          chat_id: cid,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}` }]]
          }
      });
      console.log(`Sent "restarted successfully" notification to user ${cid} for bot ${payload}`);

    } catch (e) {
      if (e.response && e.response.status === 404) {
          await dbServices.handleAppNotFoundAndCleanDb(cid, payload, messageId, true); // Use dbServices
          return;
      }
      const errorMsg = e.response?.data?.message || e.message;
      console.error(`Error restarting ${payload}:`, errorMsg, e.stack);
      return bot.editMessageText(`Error restarting bot: ${errorMsg}`, {
        chat_id: cid,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${payload}`, style: 'success' }]]
        }
      });
    } finally {
        delete userStates[cid]; // Clear user state
    }
  }

  if (action === 'logs') {
    const st = userStates[cid];
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        await bot.sendMessage(cid, "Please select an app again from 'My Bots'.");
        delete userStates[cid];
        return;
    }

    const messageId = q.message.message_id;
    
    // BUG FIX: Clear any existing interval if the user clicks "Logs" multiple times
    if (st.data.logInterval) {
        clearInterval(st.data.logInterval);
    }

    await bot.editMessageText(`Logs for ${payload}:\nConnecting...`, { 
        chat_id: cid, 
        message_id: messageId 
    });

    let lastText = ""; // To prevent "message not modified" errors

    const refreshLogs = async () => {
        try {
            const sess = await herokuApi.post(`https://api.heroku.com/apps/${payload}/log-sessions`,
                { tail: false, lines: 30 },
                { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
            );

            const logRes = await axios.get(sess.data.logplex_url);
            const logs = logRes.data.trim().slice(-3000);
            const logText = `Logs for "*${payload}*":\n\`\`\`\n${logs || 'Waiting for activity...'}\n\`\`\``;

            // Only edit if the content actually changed
            if (logText !== lastText) {
                await bot.editMessageText(logText, {
                    chat_id: cid,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Summarize with AI', callback_data: `ai_summary:${payload}` }],
                            [{ text: 'Stop Stream', callback_data: `selectapp:${payload}` }]
                        ]
                    }
                });
                lastText = logText;
            }
        } catch (e) {
            // Ignore common harmless Telegram errors
            if (!e.message.includes("message is not modified") && !e.message.includes("message to edit not found")) {
                console.error("Live log error:", e.message);
            }
        }
    };

    // Store the interval in the state so we can stop it later
    const intervalId = setInterval(refreshLogs, 4000);
    st.data.logInterval = intervalId;

    // Trigger first run immediately
    refreshLogs();

    // Auto-stop after 1 minute
    setTimeout(() => {
        if (st.data && st.data.logInterval === intervalId) {
            clearInterval(intervalId);
            delete st.data.logInterval;
            bot.editMessageText(`Log Session Ended for ${payload}.`, {
                chat_id: cid,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Summarize with AI', callback_data: `ai_summary:${payload}` }],
                        [{ text: 'Back', callback_data: `selectapp:${payload}` }]
                    ]
                }
            }).catch(() => {});
        }
    }, 60000); 

    return;
}

if (action === 'ai_summary') {
    const appName = payload;
    const messageId = q.message.message_id;
    const st = userStates[cid];

    // 1. Stop the log loop immediately to prevent the "jump back" bug
    if (st && st.data && st.data.logInterval) {
        clearInterval(st.data.logInterval);
        delete st.data.logInterval;
    }

    await bot.editMessageText(`AI is analyzing logs for "${appName}"...`, { 
        chat_id: cid, 
        message_id: messageId 
    });

    try {
        // 2. Fetch the last 50 lines of logs
        const sess = await herokuApi.post(`https://api.heroku.com/apps/${appName}/log-sessions`,
            { tail: false, lines: 50 },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        );
        const logRes = await axios.get(sess.data.logplex_url);
        const rawLogs = logRes.data;

        // 3. Call Groq API
        const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: "llama-3.3-70b-versatile", // Fast and smart model
            messages: [
                {
                    role: "system",
                    content: "You are a technical support assistant. Summarize WhatsApp bot logs in 2 clear sentences. Identify if it is connected or show the specific error."
                },
                {
                    role: "user",
                    content: `Analyze these logs for bot "${appName}":\n${rawLogs}`
                }
            ],
            temperature: 0.5,
            max_tokens: 150
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        const explanation = groqRes.data.choices[0].message.content;

        // 4. Show the result
        await bot.editMessageText(`AI Log Analysis:\n\n${explanation}`, {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Return to Logs', callback_data: `logs:${appName}` }],
                    [{ text: 'Back to Menu', callback_data: `selectapp:${appName}` }]
                ]
            }
        });

    } catch (error) {
        console.error("Analysis Failed:", error.response?.data || error.message);
        await bot.editMessageText("Analysis failed. Please check raw logs.", {
            chat_id: cid,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `logs:${appName}` }]]
            }
        });
    }
    return;
}



  if (action === 'delete' || action === 'userdelete') {
    const st = userStates[cid];
    // Check if state is valid and appName matches
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== payload) {
        await bot.sendMessage(cid, "Please select an app again from 'My Bots' or 'Apps'.");
        delete userStates[cid]; // Clear invalid state
        return;
    }
    const messageId = q.message.message_id;

      return bot.editMessageText(`Are you sure you want to delete the app "*${payload}*"? This action cannot be undone.`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: "Yes, I am sure", callback_data: `confirmdelete:${payload}:${action}`, style: 'danger' },
            { text: "No, cancel", callback_data: `selectapp:${payload}`, style: 'primary' }
          ]]
        }
      });
  }

      if (action === 'has_session') {
    const botType = payload;
    const st = userStates[cid];
    if (!st) return; // State check

    // If admin, skip deploy key and go straight to SESSION_ID step
    if (cid === ADMIN_ID) {
        st.step = 'SESSION_ID';
        await bot.editMessageText(
            `My boss. Please enter your SESSION ID for *${botType.toUpperCase()}* deployment:`,
            {
                chat_id: cid,
                message_id: q.message.message_id,
                parse_mode: 'Markdown'
            }
        );
        return;
    }

    // Non-admin: normal deploy key flow
    st.step = 'AWAITING_KEY';
    const price = process.env.KEY_PRICE_NGN || '1000';
    await bot.editMessageText(
        `Please enter your Deploy Key to continue deploying your *${botType.toUpperCase()}* bot.`, 
        {
            chat_id: cid,
            message_id: q.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: `Buy a Key (₦${price})`, callback_data: 'buy_key' }]
                ]
            }
        }
    );
    return;
}

    if (action === 'needs_session') {
    const botType = payload;
    const st = userStates[cid];
    if (!st) return; // State check

    let sessionPrompt = `Please use the button below to get your session ID for *${botType.toUpperCase()}*.`;

    // --- 💡 START OF FIX (Adding Hermit) 💡 ---
    let sessionUrl;
    if (botType === 'raganork') {
        sessionUrl = RAGANORK_SESSION_SITE_URL;
    } else if (botType === 'hermit') {
        sessionUrl = HERMIT_SESSION_SITE_URL;
    } else {
        // Default to Levanter
        sessionUrl = LEVANTER_SESSION_SITE_URL; 
    }
    // --- 💡 END OF FIX 💡 ---

    await bot.editMessageText(sessionPrompt, {
        chat_id: cid,
        message_id: q.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Get Session ID', url: sessionUrl, style: 'primary' }],
                [{ text: "I have my Session ID now", callback_data: `has_session:${botType}`, style: 'success' }]
            ]
        }
    });
    return;
}


if (action === 'confirmdelete') {
    let appToDelete = payload;
    const originalAction = extra; // 'userdelete' or 'delete'
    const messageId = q.message.message_id;
    let targetUserId = q.message.chat.id.toString(); // Start with the user who clicked the button
    let neonAccountIdToDelete = '1'; // Default if all lookups fail

    // --- START FIX: Tiered Lookup for Neon Account ID and Owner ID ---
    try {
        // 1. TIER 1: Try to fetch the deployment record using the CURRENT USER's ID (targetUserId).
        let deploymentInfo = await pool.query(
            'SELECT user_id, neon_account_id FROM user_deployments WHERE user_id = $1 AND app_name = $2',
            [targetUserId, appToDelete]
        );

        if (deploymentInfo.rows.length === 0) {
            // TIER 1 FAILED: Record not found under the user's ID. Try TIER 2: Global Search.
            console.warn(`[ConfirmDelete] Record missing under user ID ${targetUserId}. Initiating global search.`);

            // TIER 2: Search the entire table using ONLY the app name (most reliable data)
            deploymentInfo = await pool.query(
                'SELECT user_id, neon_account_id FROM user_deployments WHERE app_name = $1 LIMIT 1',
                [appToDelete]
            );
        }
        
        // 3. Final Assignment: Use the found account ID (from TIER 1 or TIER 2)
        if (deploymentInfo.rows.length > 0 && deploymentInfo.rows[0].neon_account_id) {
            // **CRITICAL FIX:** Overwrite the account ID and the Target User ID if a valid record was found.
            neonAccountIdToDelete = String(deploymentInfo.rows[0].neon_account_id);
            targetUserId = String(deploymentInfo.rows[0].user_id); // ASSIGN CORRECT OWNER ID
            
            console.log(`[ConfirmDelete] Using Neon Account ID ${neonAccountIdToDelete} for deletion.`);
        } else {
            // If TIER 2 fails, the record is gone. Keep default '1'.
            console.warn(`[ConfirmDelete] Account ID not found after global search. Sticking to default '1'.`);
        }

    } catch (dbError) {
        console.error(`[ConfirmDelete] CRITICAL DB Error during lookup:`, dbError.message);
    }
    // --- END FIX ---

    // Update the message with the correct determined Account ID
    await bot.editMessageText(`Deleting "*${escapeMarkdown(appToDelete)}*" from Heroku and Neon Account ${neonAccountIdToDelete}...`, { 
        chat_id: q.message.chat.id,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    try {
        // 1. Delete from Heroku
        await herokuApi.delete(`https://api.heroku.com/apps/${appToDelete}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });

        // 2. Delete the associated Neon database
        const deleteResult = await deleteNeonDatabase(appToDelete, neonAccountIdToDelete); // Pass the determined ID
        
        if (!deleteResult.success) {
            console.error(`[ConfirmDelete] Failed to delete Neon database ${appToDelete} (Account ${neonAccountIdToDelete}):`, deleteResult.error);
             // Notify admin ONLY if the user is not the admin
             if (q.message.chat.id.toString() !== ADMIN_ID && ADMIN_ID) {
                  bot.sendMessage(ADMIN_ID, `User ${q.message.chat.id} deleted ${appToDelete}, but failed to delete Neon DB (Account ${neonAccountIdToDelete}). Manual cleanup may be needed. Error: ${deleteResult.error}`).catch(()=>{});
             }
             // Inform the current user about the Neon failure but that local cleanup will proceed
             await bot.sendMessage(q.message.chat.id, `Warning: Failed to automatically delete the external Neon database. Records will still be cleaned up locally.`).catch(()=>{});
        } else {
             console.log(`[ConfirmDelete] Successfully deleted or confirmed deletion of Neon DB for ${appToDelete} from Account ${neonAccountIdToDelete}.`);
        }

        // 3. Clean up local database (This cleans the record, removing it from future /dbstats reports)
        await dbServices.permanentlyDeleteBotRecord(targetUserId, appToDelete); // **Use targetUserId here**

        // --- Updated success message ---
        await bot.editMessageText(`App "*${escapeMarkdown(appToDelete)}*" has been deleted.`, {
            chat_id: q.message.chat.id,
            message_id: messageId,
            parse_mode: 'Markdown'
        });

        // Follow-up logic (showing remaining bots or deploy prompt)
        if (originalAction === 'userdelete') { // User initiated
            const remainingUserBots = await dbServices.getUserBots(targetUserId);
            if (remainingUserBots.length > 0) {
                 const rows = chunkArray(remainingUserBots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
                 await bot.sendMessage(q.message.chat.id, 'Your remaining deployed bots:', { reply_markup: { inline_keyboard: rows } });
            } else {
                 await bot.sendMessage(q.message.chat.id, "You no longer have any deployed bots. Would you like to deploy a new one?", {
                     reply_markup: {
                         inline_keyboard: [
                             [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }],
                             [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]
                         ]
                     }
                 });
            }
        } else if (q.message.chat.id.toString() === ADMIN_ID) { // Admin initiated via /apps
            await dbServices.sendAppList(q.message.chat.id, messageId); // Refresh admin list
        }

    } catch (e) {
        // Handle Heroku 404 error
        if (e.response && e.response.status === 404) {
            console.log(`[ConfirmDelete-404] Heroku app ${appToDelete} not found. Proceeding with Neon/DB cleanup.`);

            // Attempt Neon Deletion even on 404 (using the fetched ID)
            if (neonAccountIdToDelete) {
                 console.log(`[ConfirmDelete-404] Deleting Neon DB ${appToDelete} from Account ${neonAccountIdToDelete}.`);
                 const deleteResult = await deleteNeonDatabase(appToDelete, neonAccountIdToDelete);
                 if (!deleteResult.success) {
                      console.error(`[ConfirmDelete-404] Failed to delete Neon DB ${appToDelete} (Account ${neonAccountIdToDelete}):`, deleteResult.error);
                      if (q.message.chat.id.toString() !== ADMIN_ID && ADMIN_ID) {
                           bot.sendMessage(ADMIN_ID, `Heroku app ${appToDelete} (User ${q.message.chat.id}) was 404, also failed to delete Neon DB (Account ${neonAccountIdToDelete}). Manual cleanup needed. Error: ${deleteResult.error}`).catch(()=>{});
                      }
                 }
            } else {
                 console.warn(`[ConfirmDelete-404] Skipped Neon deletion for ${appToDelete}, account ID unknown.`);
            }

            // Clean up local DB
            await dbServices.permanentlyDeleteBotRecord(targetUserId, appToDelete);

            await bot.editMessageText(`App "*${escapeMarkdown(appToDelete)}*" was already gone from Heroku. Associated Neon DB (Account ${neonAccountIdToDelete}) deletion attempted, and local records cleaned.`, {
                 chat_id: q.message.chat.id,
                 message_id: messageId,
                 parse_mode: 'Markdown'
            });
             // Follow-up logic after 404 cleanup
             if (originalAction === 'userdelete') {
                  const remainingUserBots = await dbServices.getUserBots(targetUserId);
                  if (remainingUserBots.length > 0) {
                     const rows = chunkArray(remainingUserBots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
                     await bot.sendMessage(q.message.chat.id, 'Your remaining deployed bots:', { reply_markup: { inline_keyboard: rows } });
                  } else {
                     await bot.sendMessage(q.message.chat.id, "You no longer have any deployed bots. Would you like to deploy a new one?", {
                          reply_markup: {
                               inline_keyboard: [
                                   [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot' }],
                                   [{ text: 'Restore From Backup', callback_data: 'restore_from_backup' }]
                               ]
                          }
                     });
                  }
             } else if (q.message.chat.id.toString() === ADMIN_ID) {
                  await dbServices.sendAppList(q.message.chat.id, messageId);
             }
            return; // Stop after 404 handling
        }

        // Handle other errors (API key, network, etc.)
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`[ConfirmDelete] Error during deletion process for ${appToDelete}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to delete app "*${escapeMarkdown(appToDelete)}*": ${escapeMarkdown(errorMsg)}`, {
            chat_id: q.message.chat.id,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appToDelete}` }]] // Link back to the app menu
            }
        });
    } finally {
        delete userStates[q.message.chat.id]; // Clear the state regardless of outcome
    }
    return; // Stop processing
}




  if (action === 'canceldelete') {
      return bot.editMessageText('Deletion cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
  }

  if (action === 'setvar') {
    const appName = payload;
    const messageId = q.message.message_id;

    const st = userStates[cid];
    if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) {
        await bot.sendMessage(cid, "This menu has expired. Please select an app again.");
        delete userStates[cid];
        return;
    }

    let configVars = {};
    try {
        const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
        configVars = configRes.data;
    } catch (e) {
        if (e.response && e.response.status === 404) {
            await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, true);
            return;
        }
        return bot.editMessageText(`Error fetching config variables: ${e.response?.data?.message || e.message}`, { chat_id: cid, message_id: messageId });
    }
    
    // Helper function to format the value string
    function formatVarValue(val, maxLength = 20) {
        if (!val) return 'Not Set';
        if (val === 'p') return 'enabled (anti-delete)';
        if (val === 'no-dl') return 'enabled (no download)';
        
        let displayVal = String(val);
        if (displayVal.length > maxLength) {
            displayVal = displayVal.substring(0, maxLength) + '...';
        }
        return displayVal;
    }

    const ownerId = await dbServices.getUserIdByBotName(appName);
    if (!ownerId) {
        return bot.editMessageText(`Error: Could not find the owner for "${appName}".`, { chat_id: cid, message_id: messageId });
    }

    // --- 💡 START OF HERMIT LOGIC FIX 💡 ---
    const botTypeForSetVar = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [ownerId, appName])).rows[0]?.bot_type || 'levanter';
    
    let statusViewVar;
    let prefixVar;

    if (botTypeForSetVar === 'raganork') {
        statusViewVar = 'AUTO_READ_STATUS';
        prefixVar = 'HANDLERS';
    } else { 
        // Levanter and Hermit both use these
        statusViewVar = 'AUTO_STATUS_VIEW';
        prefixVar = 'PREFIX';
    }
    // --- 💡 END OF HERMIT LOGIC FIX 💡 ---

    // --- 🎨 DESIGN UPDATE START 🎨 ---
    // Build the message inside a code block (```) for perfect formatting
    let varInfo = "```\n"; // Start code block
    varInfo += ` ═══ ${botTypeForSetVar.toUpperCase()} VARS ═══⊷\n`;
    varInfo += ` ┃❃╭──────────────\n`;
    varInfo += ` ┃❃│ App Name    : ${appName}\n`;
    varInfo += ` ┃❃│ SESSION_ID  : ${formatVarValue(configVars.SESSION_ID, 15)}\n`;
    varInfo += ` ┃❃│ ${statusViewVar.padEnd(14, ' ')}: ${formatVarValue(configVars[statusViewVar])}\n`;
    varInfo += ` ┃❃│ ALWAYS_ONLINE : ${formatVarValue(configVars.ALWAYS_ONLINE)}\n`;
    varInfo += ` ┃❃│ ${prefixVar.padEnd(14, ' ')}: ${formatVarValue(configVars[prefixVar])}\n`;
    varInfo += ` ┃❃│ ANTI_DELETE : ${formatVarValue(configVars.ANTI_DELETE)}\n`;
    varInfo += ` ┃❃│ SUDO        : ${formatVarValue(configVars.SUDO, 20)}\n`;

    const keyboard = [
        [{ text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${appName}:${botTypeForSetVar}` }],
        [{ text: statusViewVar, callback_data: `varselect:${statusViewVar}:${appName}:${botTypeForSetVar}` }, { text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${appName}:${botTypeForSetVar}` }],
        [{ text: prefixVar, callback_data: `varselect:${prefixVar}:${appName}:${botTypeForSetVar}` }, { text: 'ANTI_DELETE', callback_data: `varselect:ANTI_DELETE:${appName}:${botTypeForSetVar}` }]
    ];
    
    // Add bot-specific variables and complete the text-art box
    if (botTypeForSetVar === 'levanter' || botTypeForSetVar === 'hermit') {
        varInfo += ` ┃❃│ STATUS_VIEW_EMOJI : ${formatVarValue(configVars.STATUS_VIEW_EMOJI)}\n`;
        keyboard.push([
            { text: 'SUDO', callback_data: `varselect:SUDO_VAR:${appName}:${botTypeForSetVar}` },
            { text: 'STATUS_VIEW_EMOJI', callback_data: `varselect:STATUS_VIEW_EMOJI:${appName}:${botTypeForSetVar}` }
        ]);
    } else { // Raganork
        keyboard.push([{ text: 'SUDO', callback_data: `varselect:SUDO_VAR:${appName}:${botTypeForSetVar}` }]);
    }
    
    varInfo += ` ┃❃╰───────────────\n\n`;
    varInfo += ` Select a variable to set:`;
    varInfo += "\n```"; // End code block
    // --- 🎨 DESIGN UPDATE END 🎨 ---

    keyboard.push([{ text: 'Add/Set Other Variable', callback_data: `varselect:OTHER_VAR:${appName}:${botTypeForSetVar}` }]);
    keyboard.push([{ text: 'Back', callback_data: `selectapp:${appName}` }]);

    return bot.editMessageText(varInfo, {
      chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
}





  if (action === 'restore_all_bots') {
      handleRestoreAllSelection(q); // This shows the list
      return;
  }
  if (action === 'restore_all_confirm') {
      handleRestoreAllConfirm(q); // This starts the deployment
      return;
  }
  if (action === 'restore_all_cancel') {
      await bot.editMessageText('Restore cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
      return;
  }

  // NEW: Handle restart all bots
  if (action === 'restart_all_bots') {
      handleRestartAllSelection(q); // This shows confirmation and starts restart
      return;
  }
  if (action === 'restart_all_confirm') {
      handleRestartAllConfirm(q); // This executes the restart
      return;
  }
  if (action === 'restart_all_cancel') {
      await bot.editMessageText('Restart cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
      return;
  }

        if (action === 'varselect') {
        const [varKey, appName, botTypeFromVarSelect] = [payload, extra, flag];
        const st = userStates[cid];
        
        if (!st || st.step !== 'APP_MANAGEMENT' || st.data.appName !== appName) {
            await bot.sendMessage(cid, "This menu has expired. Please select an app again.");
            delete userStates[cid];
            return;
        }
        const messageId = q.message.message_id;

        // Set state for the next step
        userStates[cid].step = 'SETVAR_ENTER_VALUE';
        userStates[cid].data.APP_NAME = appName;
        userStates[cid].data.botType = botTypeFromVarSelect;

        if (varKey === 'STATUS_VIEW_EMOJI') {
             // This needs a different handler, so we change the step
             userStates[cid].step = 'AWAITING_EMOJI_CHOICE'; // A placeholder step
             return bot.editMessageText(`Set *STATUS_VIEW_EMOJI* to:`, {
                chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'On', callback_data: `set_emoji_status:${appName}:on` }],
                        [{ text: 'Off', callback_data: `set_emoji_status:${appName}:off` }],
                        [{ text: 'Back', callback_data: `setvar:${appName}` }]
                    ]
                }
            });
        } else if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE', 'AUTO_READ_STATUS'].includes(varKey)) {
            // This also needs a different handler
            userStates[cid].step = 'AWAITING_BOOL_CHOICE'; // A placeholder step
            return bot.editMessageText(`Set *${varKey}* to:`, {
                chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Enable', callback_data: `setvarbool:${varKey}:${appName}:true` }],
                        [{ text: 'Disable', callback_data: `setvarbool:${varKey}:${appName}:false` }],
                        [{ text: 'Back', callback_data: `setvar:${appName}` }]
                    ]
                }
            });
        } else if (varKey === 'SUDO_VAR') {
             userStates[cid].step = 'AWAITING_SUDO_CHOICE'; // Placeholder
             return bot.editMessageText(`Manage *SUDO* for "*${appName}*":`, {
                chat_id: cid, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Add Number', callback_data: `sudo_action:add:${appName}` }],
                        [{ text: 'Remove Number', callback_data: `sudo_action:remove:${appName}` }],
                        [{ text: 'Back', callback_data: `setvar:${appName}` }]
                    ]
                }
            });
        } else if (varKey === 'OTHER_VAR') {
            userStates[cid].step = 'AWAITING_OTHER_VAR_NAME';
            userStates[cid].data.appName = appName;
            return bot.sendMessage(cid, 'Enter the variable name (e.g., `WORK_TYPE`):', { parse_mode: 'Markdown' });
        } else {
            // This is for SESSION_ID, HANDLERS, PREFIX, etc.
            // It correctly asks the user to type the value.
            userStates[cid].data.VAR_NAME = varKey;
            await bot.editMessageText(`Please enter the new value for *${varKey}*:`, {
                chat_id: cid,
                message_id: messageId,
                parse_mode: 'Markdown'
            });
        }
    }




  // --- FIX: Corrected sudo_action handler with proper state management ---
if (action === 'sudo_action') {
    const sudoAction = payload;
    const appName = extra;
    const st = userStates[cid];

    // FIX: This check is now more robust and looks for the correct state
    if (!st || (st.step !== 'APP_MANAGEMENT' && st.step !== 'AWAITING_SUDO_CHOICE')) {
        await bot.sendMessage(cid, "This session has expired or is invalid. Please select an app again.");
        delete userStates[cid];
        return;
    }
    
    // Store the appName in the state if it's not already there
    st.data.APP_NAME = appName;
    st.data.targetUserId = cid;
    st.data.attempts = 0;
    st.data.isFreeTrial = false;

    if (sudoAction === 'add') {
        st.step = 'AWAITING_SUDO_ADD_NUMBER';
        await bot.editMessageText('Please enter the number to *add* to SUDO (without + or spaces, e.g., `2349163916314`):', {
             chat_id: cid,
             message_id: q.message.message_id,
             parse_mode: 'Markdown'
        });
        return;
    } else if (sudoAction === 'remove') {
        st.step = 'AWAITING_SUDO_REMOVE_NUMBER';
        await bot.editMessageText('Please enter the number to *remove* from SUDO (without + or spaces, e.g., `2349163916314`):', {
             chat_id: cid,
             message_id: q.message.message_id,
             parse_mode: 'Markdown'
        });
        return;
    }
}


      if (action === 'unban_user') {
        const targetUserId = payload;
        const unbanned = await dbServices.unbanUser(targetUserId);

        if (unbanned) {
            await bot.answerCallbackQuery(q.id, { text: `User ${targetUserId} has been unbanned.` });
            try {
                await bot.sendMessage(targetUserId, `You have been unbanned by the admin. Welcome back!`);
            } catch (error) {
                console.warn(`Could not notify unbanned user ${targetUserId}: ${error.message}`);
            }
        } else {
            await bot.answerCallbackQuery(q.id, { text: `Failed to unban user ${targetUserId}.`, show_alert: true });
        }

        // Refresh the list of banned users
        await sendBannedUsersList(cid, q.message.message_id);
        return;
    }


  if (action === 'overwrite_var') {
      const confirmation = payload;
      const varName = extra;
      const appName = flag;

      const st = userStates[cid];
      // More robust check for overwrite state
      if (!st || st.step !== 'AWAITING_OVERWRITE_CONFIRMATION' || st.data.VAR_NAME !== varName || st.data.APP_NAME !== appName) {
          await bot.editMessageText('This overwrite session has expired or is invalid. Please try setting the variable again.', {
              chat_id: cid,
              message_id: q.message.message_id
          });
          delete userStates[cid]; // Clear user state
          return;
      }

      if (confirmation === 'yes') {
          await bot.editMessageText(`You chose to overwrite *${varName}*.`, {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'Markdown'
          });
          // Get bot type from main DB to pass to next state
          const botTypeForOverwrite = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';
          // Transition to the step where user provides the new value
          userStates[cid].step = 'AWAITING_OTHER_VAR_VALUE';
          userStates[cid].data.isFreeTrial = false; // Ensure it's treated as permanent for backup on update
          userStates[cid].data.botType = botTypeForOverwrite; // Pass bot type to next state for validation
          return bot.sendMessage(cid, `Please enter the *new* value for *${varName}*:`, { parse_mode: 'Markdown' });
      } else {
          await bot.editMessageText(`Variable *${varName}* was not overwritten.`, {
              chat_id: cid,
              message_id: q.message.message_id,
              parse_mode: 'Markdown'
          });
          delete userStates[cid]; // Clear user state
          return;
      }
  }

      if (action === 'set_emoji_status') {
        const [appName, value] = [payload, extra];
        const varKey = 'STATUS_VIEW_EMOJI';
        const herokuValue = value === 'on' ? '❤️,💕,💜' : '';

        try {
            const updateMsg = await bot.editMessageText(`Updating *${varKey}* for "*${appName}*"...`, { chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown' });
            
            await herokuApi.patch(`https://api.heroku.com/apps/${appName}/config-vars`, { [varKey]: herokuValue }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
            
            const herokuConfigVars = (await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`,{ headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }})).data;
            const botType = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter';
            await dbServices.saveUserDeployment(cid, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, botType);
            
            await bot.editMessageText(`Variable *${varKey}* for "*${appName}*" updated successfully! The bot will restart to apply changes.`, {
                chat_id: cid, message_id: updateMsg.message_id, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]] }
            });
        } catch (e) {
            await bot.editMessageText(`Error updating variable: ${e.response?.data?.message || e.message}`, { chat_id: cid, message_id: q.message.message_id });
        }
        return;
    }


// AROUND LINE 3000 in bot.js

if (action === 'setvarbool') {
  const [varKeyFromCallback, appName, valStr] = [payload, extra, flag]; 
  const flagVal = valStr === 'true';
  let newVal;

  const currentBotType = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName])).rows[0]?.bot_type || 'levanter'; 

  // This logic correctly handles Raganork's different var names
  const actualVarNameForHeroku = (currentBotType === 'raganork' && varKeyFromCallback === 'AUTO_STATUS_VIEW') ? 'AUTO_READ_STATUS' :
                                 (currentBotType === 'raganork' && varKeyFromCallback === 'PREFIX') ? 'HANDLERS' : varKeyFromCallback;

  // --- 💡 START OF FIX (Adding Hermit) 💡 ---
  if (actualVarNameForHeroku === 'AUTO_STATUS_VIEW' || actualVarNameForHeroku === 'AUTO_READ_STATUS') {
      if (currentBotType === 'levanter' || currentBotType === 'hermit') {
          // Levanter and Hermit use 'no-dl' for 'on'
          newVal = flagVal ? 'no-dl' : 'false';
      } else if (currentBotType === 'raganork') {
          // Raganork uses 'true'
          newVal = flagVal ? 'true' : 'false';
      }
  }
  // --- 💡 END OF FIX 💡 ---
  else if (actualVarNameForHeroku === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
  else newVal = flagVal ? 'true' : 'false'; // Covers ALWAYS_ONLINE

  try {
    await bot.sendChatAction(cid, 'typing');
    const updateMsg = await bot.sendMessage(cid, `Updating *${actualVarNameForHeroku}* for "*${appName}*"...`, { parse_mode: 'Markdown' }); 

    console.log(`[API_CALL] Patching Heroku config vars (boolean) for ${appName}: { ${actualVarNameForHeroku}: '${newVal}' }`); 
    const patchResponse = await herokuApi.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { [actualVarNameForHeroku]: newVal }, 
      { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
    );
    console.log(`[API_CALL_SUCCESS] Heroku config vars (boolean) patched successfully for ${appName}. Status: ${patchResponse.status}`);

    console.log(`[Flow] setvarbool: Config var updated for "${appName}". Updating bot in user_bots DB.`);
    const herokuConfigVars = (await axios.get(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
    )).data;
    await dbServices.saveUserDeployment(cid, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, currentBotType); 

    const baseWaitingText = `Updated *${actualVarNameForHeroku}* for "*${appName}*". Waiting for bot status confirmation...`; 
    await bot.editMessageText(`${baseWaitingText} ${getAnimatedEmoji()}`, { // <-- Swapped emoji position
        chat_id: cid,
        message_id: updateMsg.message_id,
        parse_mode: 'Markdown'
    });
    const animateIntervalId = await animateMessage(cid, updateMsg.message_id, baseWaitingText);

    const appStatusPromise = new Promise((resolve, reject) => {
        appDeploymentPromises.set(appName, { resolve, reject, animateIntervalId });
    });

    const STATUS_CHECK_TIMEOUT = 180 * 1000;
    let timeoutId;

    try {
        timeoutId = setTimeout(() => {
            const appPromise = appDeploymentPromises.get(appName);
            if (appPromise) {
                appPromise.reject(new Error(`Bot did not report connected or logged out status within ${STATUS_CHECK_TIMEOUT / 1000} seconds after variable update.`));
                appDeploymentPromises.delete(appName);
            }
        }, STATUS_CHECK_TIMEOUT);

        await appStatusPromise;
        clearTimeout(timeoutId);
        clearInterval(animateIntervalId);

        await bot.editMessageText(`Variable "*${actualVarNameForHeroku}*" for "*${appName}*" updated successfully and bot is back online!`, { 
            chat_id: cid,
            message_id: updateMsg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
        console.log(`Sent "variable updated and online" notification to user ${cid} for bot ${appName}`);

    } catch (err) {
        clearTimeout(timeoutId);
        clearInterval(animateIntervalId);
        console.error(`App status check failed for ${appName} after variable update:`, err.message);
        await bot.editMessageText(
            `Bot "${appName}" failed to come online after variable "*${actualVarNameForHeroku}*" update: ${err.message}\n\n` +
            `The bot is in your "My Bots" list, but you may need to try changing the session ID again.`,
            {
                chat_id: cid,
                message_id: updateMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Change Session ID', callback_data: `change_session:${appName}:${cid}` }],
                        [{ text: 'Back', callback_data: `selectapp:${appName}` }]
                    ]
                }
            }
        );
    } finally {
        appDeploymentPromises.delete(appName);
    }
    delete userStates[cid];
  } catch (e) {
    const errorMsg = e.response?.data?.message || e.message;
    console.error(`[API_CALL_ERROR] Error updating boolean variable ${actualVarNameForHeroku} for ${appName}:`, errorMsg, e.response?.data);
    return bot.sendMessage(cid, `Error updating variable: ${errorMsg}`);
  }
}



  // bot.js (Inside bot.on('callback_query', async q => { ... }))

if (action === 'change_session') {
    const appName = payload;
    const targetUserId = extra;
    const cid = q.message.chat.id.toString();
    const messageIdToDelete = q.message.message_id;

    if (cid !== targetUserId) {
        await bot.sendMessage(cid, "You can only change the session ID for your own bots.");
        return;
    }

    // Set state immediately to prevent race conditions or session timeouts
    userStates[cid] = {
        step: 'SETVAR_ENTER_VALUE',
        data: {
            APP_NAME: appName,
            VAR_NAME: 'SESSION_ID',
            targetUserId: targetUserId,
            isFreeTrial: false
        }
    };

    try {
        // Fetch bot type to determine the correct guide and prefix
        const dbRes = await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [cid, appName]);
        const botType = dbRes.rows[0]?.bot_type || 'levanter';
        userStates[cid].data.botType = botType;

        let imageGuideUrl;
        let sessionSiteUrl;
        let prefix;

        if (botType === 'raganork') {
            imageGuideUrl = 'https://files.catbox.moe/lqk3gj.jpeg';
            sessionSiteUrl = RAGANORK_SESSION_SITE_URL;
            prefix = RAGANORK_SESSION_PREFIX;
        } else if (botType === 'hermit') {
            imageGuideUrl = 'https://files.catbox.moe/udjrjg.jpeg';
            sessionSiteUrl = HERMIT_SESSION_SITE_URL;
            prefix = HERMIT_SESSION_PREFIX;
        } else {
            imageGuideUrl = 'https://files.catbox.moe/k6wgxl.jpeg';
            sessionSiteUrl = LEVANTER_SESSION_SITE_URL;
            prefix = LEVANTER_SESSION_PREFIX;
        }

        const sessionPrompt = `Please send the *new* session ID for your bot "*${escapeMarkdown(appName)}*". It must start with \`${prefix}\`.`;

        // Send the instruction photo first
        await bot.sendPhoto(cid, imageGuideUrl, {
            caption: sessionPrompt,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Get New Session ID", url: sessionSiteUrl, style: 'primary' }]
                ]
            }
        });

        // Delete the original button message only after the instruction is sent
        await bot.deleteMessage(cid, messageIdToDelete).catch(() => {});

    } catch (error) {
        console.error("Error in change_session callback:", error);
        // Fallback message if the photo fails to send
        await bot.sendMessage(cid, "Please send your new session ID now.");
    }
    return;
}


  
  if (action === 'admin_delete_trial_app') {
      const appToDelete = payload;
      const messageId = q.message.message_id;

      if (cid !== ADMIN_ID) {
          await bot.editMessageText("You are not authorized to perform this action.", { chat_id: cid, message_id: messageId });
          return;
      }

      await bot.sendChatAction(cid, 'typing');
      await bot.editMessageText(`Admin deleting Free Trial app "*${appToDelete}*"...`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          const ownerId = await dbServices.getUserIdByBotName(appToDelete); // Use dbServices
          if (ownerId) {
              await dbServices.deleteUserBot(ownerId, appToDelete); // Delete from main DB
              await dbServices.markDeploymentDeletedFromHeroku(ownerId, appToDelete); // NEW: Mark from backup DB as deleted
          }

          await bot.editMessageText(`Free Trial app "*${appToDelete}*" permanently deleted by Admin.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
          if (ownerId && ownerId !== cid) {
              await bot.sendMessage(ownerId, `Your Free Trial bot "*${appToDelete}*" has been manually deleted by the admin.`, { parse_mode: 'Markdown' });
          }
      } catch (e) {
          if (e.response && e.response.status === 404) {
              await dbServices.handleAppNotFoundAndCleanDb(cid, appToDelete, messageId, false); // Use dbServices
              return;
          }
          const errorMsg = e.response?.data?.message || e.message;
          await bot.editMessageText(`Failed to delete Free Trial app "*${appToDelete}*": ${errorMsg}`, {
              chat_id: cid,
              message_id: messageId,
              parse_mode: 'Markdown'
          });
      }
      return;
  }

  // AROUND LINE 1400 (inside bot.on('callback_query', async q => { ... }))

    if (action === 'redeploy_app') {
    const appName = payload;
    const messageId = q.message.message_id;

    // --- CRITICAL FIX START ---
    // 1. Get the actual owner's user_id from the database based on the appName
    const actualOwnerId = await dbServices.getUserIdByBotName(appName);
    if (!actualOwnerId) {
        await bot.editMessageText(`Cannot redeploy "*${appName}*": Bot owner not found in database.`, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown' });
        return;
    }

    // 2. Check authorization: current user (cid) must be ADMIN OR the actual owner
    const isAdmin = cid === ADMIN_ID; // Your ADMIN_ID is already defined
    const isOwner = actualOwnerId.toString() === cid; // Use .toString() for safety

    if (!isAdmin && !isOwner) { // Only admin or owner can redeploy
        await bot.editMessageText("You are not authorized to redeploy this app.", { chat_id: cid, message_id: messageId });
        return;
    }

    // 3. Now, get the bot type using the actual owner's ID and appName
    const botTypeForRedeploy = (await pool.query('SELECT bot_type FROM user_bots WHERE user_id = $1 AND bot_name = $2', [actualOwnerId, appName])).rows[0]?.bot_type || 'levanter';
    // --- CRITICAL FIX END ---

    await bot.sendChatAction(cid, 'typing');
    await bot.editMessageText(`Redeploying "*${appName}*" from GitHub...`, {
        chat_id: cid,
        message_id: messageId,
        parse_mode: 'Markdown'
    });

    let animateIntervalId = null;
    try {
        // --- 💡 START OF UPDATE (Adding Hermit) 💡 ---
        let repoUrl;
        if (botTypeForRedeploy === 'raganork') {
            repoUrl = GITHUB_RAGANORK_REPO_URL;
        } else if (botTypeForRedeploy === 'hermit') {
            repoUrl = GITHUB_HERMIT_REPO_URL;
        } else {
            repoUrl = GITHUB_LEVANTER_REPO_URL;
        }
        // --- 💡 END OF UPDATE 💡 ---

        const bres = await axios.post(
            `https://api.heroku.com/apps/${appName}/builds`,
            { source_blob: { url: `${repoUrl}/tarball/main` } }, // <-- Use the new repoUrl variable
            {
                headers: {
                    Authorization: `Bearer ${HEROKU_API_KEY}`,
                    Accept: 'application/vnd.heroku+json; version=3',
                    'Content-Type': 'application/json'
                }
            }
        );

        const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;

        await bot.editMessageText(`Build initiated for "*${appName}*". Waiting for completion...`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown'
        });
        animateIntervalId = await animateMessage(cid, messageId, `Building "*${appName}*" from GitHub...`);

        const BUILD_POLL_TIMEOUT = 300 * 1000;

        const buildPromise = new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                clearInterval(checkBuildStatusInterval);
                reject(new Error('Redeploy build process timed out.'));
            }, BUILD_POLL_TIMEOUT);

            const checkBuildStatusInterval = setInterval(async () => {
                try {
                    const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
                    if (poll.data.status === 'succeeded') {
                        clearInterval(checkBuildStatusInterval);
                        clearTimeout(timeoutId);
                        resolve('succeeded');
                    } else if (poll.data.status === 'failed') {
                        clearInterval(checkBuildStatusInterval);
                        clearTimeout(timeoutId);
                        reject(new Error(`Redeploy build failed: ${poll.data.slug?.id ? `https://dashboard.heroku.com/apps/${appName}/activity/build/${poll.data.id}` : 'Check Heroku logs.'}`));
                    }
                } catch (error) {
                    clearInterval(checkBuildStatusInterval);
                    clearTimeout(timeoutId);
                    reject(new Error(`Error polling build status: ${error.message}`));
                }
            }, 10000);
        });

        await buildPromise;

        // On successful redeploy, update deleted_from_heroku_at to NULL in user_deployments
        const herokuConfigVars = (await herokuApi.get( // Fetch latest config vars
            `https://api.heroku.com/apps/${appName}/config-vars`,
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
        )).data;

        // --- IMPORTANT FIX: Pass the actualOwnerId to saveUserDeployment ---
        await dbServices.saveUserDeployment(actualOwnerId, appName, herokuConfigVars.SESSION_ID, herokuConfigVars, botTypeForRedeploy);
        // --- END IMPORTANT FIX ---

        await bot.editMessageText(`App "*${appName}*" redeployed successfully!`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
        console.log(`App "${appName}" redeployed successfully for user ${cid}.`);

    } catch (e) {
        if (e.response && e.response.status === 404) {
            // Pass true for isUserFacing if the current user (cid) is the owner, false if admin is doing it.
            await dbServices.handleAppNotFoundAndCleanDb(cid, appName, messageId, isOwner);
            return;
        }
        const errorMsg = e.response?.data?.message || e.message;
        console.error(`Error redeploying ${appName}:`, errorMsg, e.stack);
        await bot.editMessageText(`Failed to redeploy "*${appName}*": ${errorMsg}`, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: 'Back', callback_data: `selectapp:${appName}` }]]
            }
        });
    } finally {
        if (animateIntervalId) clearInterval(animateIntervalId);
        delete userStates[cid]; // Clear user state
    }
    return;
  }



  if (action === 'back_to_app_list') {
    const isAdmin = cid === ADMIN_ID;
    const currentMessageId = q.message.message_id;

    // Clear APP_MANAGEMENT state, return to general menu or My Bots list
    delete userStates[cid];

    if (isAdmin) {
      return dbServices.sendAppList(cid, currentMessageId); // Use dbServices
    } else {
      const bots = await dbServices.getUserBots(cid); // Use dbServices
      if (bots.length > 0) {
          const rows = chunkArray(bots, 3).map(r => r.map(n => ({
            text: n,
            callback_data: `selectbot:${n}`,
              style: 'primary'
          })));
          return bot.editMessageText('Your remaining deployed bots:', {
            chat_id: cid,
            message_id: currentMessageId,
            reply_markup: { inline_keyboard: rows }
          });
      } else {
          // Add Restore button here again for clarity if they have no bots active
          return bot.editMessageText("You have not deployed any bots yet. Would you like to deploy your first bot or restore a backup?", {
            chat_id: cid,
            message_id: currentMessageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Deploy Now!', callback_data: 'deploy_first_bot', style: 'success' }],
                    [{ text: 'Restore From Backup', callback_data: 'restore_from_backup', style: 'primary' }]
                ]
            }
        });
      }
    }
  }
});


bot.on('channel_post', async msg => {
    if (String(msg.chat.id) !== TELEGRAM_CHANNEL_ID || !msg.text) {
        return;
    }
    const text = msg.text.trim();
    console.log(`[Channel Post] Received: "${text}"`);

    let appName = null;
    let status = null;
    let match;

  // --- 💡 1. AUTO-FIX: NEON DATA QUOTA EXCEEDED 💡 ---
    // If a bot reports it hit the limit, we move it to a new DB immediately.
    if (text.includes('NEON QUOTA EXCEEDED')) {
        // Extract app name from format: "App: `bot-name`"
        match = text.match(/App:\s*`?([\w-]+)`?/i);
        if (match) {
            const targetApp = match[1];
            console.log(`[Auto-Fix] Quota exceeded for ${targetApp}. Triggering automatic database migration...`);
            
            // Notify admin that fix is starting
            await bot.sendMessage(ADMIN_ID, `**Auto-Fix Triggered**\n\nDetected Quota Limit for \`${targetApp}\`. Moving to new database...`, { parse_mode: 'Markdown' });

            try {
                // Call the changeDB function
                const result = await changeBotDatabase(targetApp);
                
                if (result.success) {
                    await bot.sendMessage(ADMIN_ID, `**Auto-Fix Successful!**\n\n\`${targetApp}\` has been moved to **Account ${result.account}** and is restarting.`, { parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(ADMIN_ID, `**Auto-Fix Failed** for \`${targetApp}\`.\nReason: ${result.message}`, { parse_mode: 'Markdown' });
                }
            } catch (e) {
                console.error(`[Auto-Fix] Error migrating ${targetApp}:`, e);
                await bot.sendMessage(ADMIN_ID, `**Auto-Fix Critical Error** for \`${targetApp}\`: ${e.message}`, { parse_mode: 'Markdown' });
            }
        }
        return; // Stop processing this message
    }
    // --- 💡 END OF AUTO-FIX 💡 ---

    // --- High-priority check for a single, raw R14 Memory Error log ---
    const r14Match = text.match(/^\[([\w-]+)\].*Error R14/);
    if (r14Match) {
        const erroredAppName = r14Match[1];
        console.log(`[Log Monitor] Raw R14 Memory Error DETECTED for app: ${erroredAppName}`);
        
        await bot.sendMessage(ADMIN_ID, `⚠️ R14 Memory error detected for bot \`${erroredAppName}\`. Triggering an automatic restart.`, { parse_mode: 'Markdown' });
        await restartBot(erroredAppName);
        
        return; // Stop processing this log further
    }

    // ✅ FIX: This new block handles the consolidated R14 alert message.
    const consolidatedR14Header = 'R14 Memory Errors Detected';
    if (text.startsWith(consolidatedR14Header)) {
        console.log('[Auto-Restart] Consolidated R14 alert detected. Parsing bot names...');
        
        // Regex to find all bot names in the format: - `bot-name`
        const botNameRegex = /- ([\w-]+)/g;
        const matches = text.matchAll(botNameRegex);
        const botsToRestart = Array.from(matches, match => match[1]);

        if (botsToRestart.length > 0) {
            // Notify the admin that the process is starting
            await bot.sendMessage(ADMIN_ID, `Detected ${botsToRestart.length} bots with R14 errors. Starting sequential restart process...`);

            for (const [index, appName] of botsToRestart.entries()) {
                console.log(`[Auto-Restart] Restarting bot ${index + 1}/${botsToRestart.length}: ${appName}`);
                const success = await restartBot(appName);
                
                const statusMessage = success 
                    ? `Successfully initiated restart for \`${appName}\`.`
                    : `Failed to restart \`${appName}\`. Please check logs.`;
                await bot.sendMessage(ADMIN_ID, statusMessage, { parse_mode: 'Markdown' });

                // Wait for 15 seconds before restarting the next bot to avoid API rate limits
                if (index < botsToRestart.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 15000)); 
                }
            }
            
            await bot.sendMessage(ADMIN_ID, 'All listed bots have been processed.');
        } else {
            console.log('[Auto-Restart] R14 alert detected, but no bot names could be parsed.');
        }
        
        return; // Stop further processing of this message
    }

    // --- This is the existing logic for ONLINE/LOGGED OUT statuses ---
    match = text.match(/\[LOG\] App: (.*?) \| Status: (.*?) \|/);
    if (match) {
        appName = match[1];
        status = match[2];
    } else {
        // Updated regex to detect "Name connected" OR "[Name] connected"
        // \[? matches an optional opening bracket.
        // ([^\]\s]+) captures one or more characters that are NOT a closing bracket or space.
        // \]? matches an optional closing bracket.
        match = text.match(/\[?([^\]\s]+)\]?\s+connected/i);
        if (match) {
            appName = match[1];
            status = 'ONLINE';
        } else {
            // Regex to detect "User Name has logged out" OR "User [Name] has logged out"
            match = text.match(/User\s+\[?([^\]\s]+)\]?\s+has logged out/i);
            if (match) {
                appName = match[1];
                status = 'LOGGED OUT';
            }
        }
    }

    if (!appName) {
        console.log(`[Channel Post] Message did not match any known format. Ignoring.`);
        return;
    }
    
    // bot.js (Replace the entire provided code block)

    if (status === 'ONLINE') {
        const pendingPromise = appDeploymentPromises.get(appName);
        if (pendingPromise) {
            if (pendingPromise.animateIntervalId) clearInterval(pendingPromise.animateIntervalId);
            if (pendingPromise.timeoutId) clearTimeout(pendingPromise.timeoutId);
            pendingPromise.resolve('connected');
            appDeploymentPromises.delete(appName);
        }
        
        // 🚨 FIX 1: Reset the initial Telegram warning flag on connection
        await pool.query(
            `UPDATE user_bots SET status = 'online', status_changed_at = NULL, last_email_notification_at = NULL, initial_tg_warning_sent = FALSE WHERE bot_name = $1`, 
            [appName]
        );
        console.log(`[Status Update] Set "${appName}" to 'online' and reset notification timer and warning flag.`);
        
    } else if (status === 'LOGGED OUT') {
        const pendingPromise = appDeploymentPromises.get(appName);
        if (pendingPromise) {
            if (pendingPromise.animateIntervalId) clearInterval(pendingPromise.animateIntervalId);
            if (pendingPromise.timeoutId) clearTimeout(pendingPromise.timeoutId);
            pendingPromise.reject(new Error('Bot session has logged out.'));
            appDeploymentPromises.delete(appName);
        }
        
        await pool.query(`UPDATE user_bots SET status = 'logged_out', status_changed_at = NOW() WHERE bot_name = $1`, [appName]);
        console.log(`[Status Update] Set "${appName}" to 'logged_out'.`);
        
        const userId = await dbServices.getUserIdByBotName(appName);
        if (userId) {
            // 1. Check the DB if the initial Telegram warning has been sent
            const checkResult = await pool.query(
                `SELECT initial_tg_warning_sent 
                 FROM user_bots
                 WHERE bot_name = $1 AND user_id = $2`,
                [appName, userId]
            );
            const warningAlreadySent = checkResult.rows.length > 0 && checkResult.rows[0].initial_tg_warning_sent;
            
            if (warningAlreadySent) {
                console.log(`[Warning] Skipping initial Telegram warning for ${appName}. Already sent.`);
                // 🚨 Skip the rest of the Telegram message logic (except email, which follows)
            } else {
                // 2. If NO, send the warning message
                const warningMessage = `Your bot "*${escapeMarkdown(appName)}*" has been logged out.\n` +
                                       `*Reason:* Bot session has logged out.\n` +
                                       `Please update your session ID.\n\n` +
                                       `*Warning: This app will be automatically deleted in **7 days** if the issue is not resolved.*`;
                
                const sentMessage = await bot.sendMessage(userId, warningMessage, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${appName}:${userId}`, style: 'success' }]]
                    }
                }).catch(e => console.error(`Failed to send Telegram warning to user ${userId}: ${e.message}`));
                
                if (sentMessage) {
                    try {
                        await bot.pinChatMessage(userId, sentMessage.message_id);
                        const unpinAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
                        await pool.query(
                            'INSERT INTO pinned_messages (message_id, chat_id, unpin_at) VALUES ($1, $2, $3)',
                            [sentMessage.message_id, userId, unpinAt]
                        );
                        
                        // 3. Record that the message was sent
                        await pool.query(
                            `UPDATE user_bots SET initial_tg_warning_sent = TRUE WHERE bot_name = $1 AND user_id = $2`,
                            [appName, userId]
                        );
                        console.log(`[Warning] Recorded initial Telegram warning sent for ${appName}.`);

                    } catch (pinError) {
                        console.error(`[PinChat] Failed to pin message or update record for user ${userId}:`, pinError.message);
                    }
                }
            }

            // --- Existing Email Logic (runs regardless of initial TG warning) ---
                
            try {
                const ownerInfoResult = await pool.query(
                    `SELECT b.last_email_notification_at, v.email
                     FROM user_bots b
                     JOIN email_verification v ON b.user_id = v.user_id
                     WHERE b.bot_name = $1 AND v.is_verified = TRUE`,
                    [appName]
                );

                if (ownerInfoResult.rows.length > 0) {
                    const { last_email_notification_at, email } = ownerInfoResult.rows[0];
                    
                    // ❗️ FIX: Changed cooldown from 30 to 24 hours ❗️
                    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

                    if (!last_email_notification_at || new Date(last_email_notification_at) < twentyFourHoursAgo) {
                        console.log(`[Email] Cooldown passed for ${appName}. Sending logged-out reminder to ${email}.`);
                        
                        // ✅ This line correctly calls your new email service function
                        await sendLoggedOutReminder(email, appName, botUsername, 7);
                        
                        await pool.query(
                            `UPDATE user_bots SET last_email_notification_at = NOW() WHERE bot_name = $1`,
                            [appName]
                        );
                    } else {
                        console.log(`[Email] Skipping email for ${appName}. A reminder was already sent within the last 24 hours.`);
                    }
                } else {
                    console.log(`[Email] Skipping email for ${appName}. Owner has no verified email.`);
                }
            } catch (emailError) {
                console.error(`[Email] Failed to process email notification for ${appName}:`, emailError);
            }
        }
    }


});

    




// === Free Trial Channel Membership Monitoring ===
const ONE_HOUR_IN_MS = 60 * 60 * 1000;

async function checkMonitoredUsers() {
    console.log('[Monitor] Running free trial channel membership check...');
    const usersToMonitor = await dbServices.getMonitoredFreeTrials();

    for (const user of usersToMonitor) {
        try {
            const member = await bot.getChatMember(user.channel_id, user.user_id);
            const isMember = ['creator', 'administrator', 'member'].includes(member.status);

            if (!isMember) {
                // User has left the channel
                if (user.warning_sent_at) {
                    // Warning was already sent, check if 1 hour has passed
                    const warningTime = new Date(user.warning_sent_at).getTime();
                    if (Date.now() - warningTime > ONE_HOUR_IN_MS) {
                        // Time's up. Delete the bot.
                        console.log(`[Monitor] User ${user.user_id} did not rejoin. Deleting app ${user.app_name}.`);
                        await bot.sendMessage(user.user_id, `You did not rejoin the channel in time. Your free trial bot *${escapeMarkdown(user.app_name)}* is being deleted.`, { parse_mode: 'Markdown' });
                        
                        await axios.delete(`https://api.heroku.com/apps/${user.app_name}`, {
                            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                        }).catch(e => console.error(`[Monitor] Failed to delete Heroku app ${user.app_name}: ${e.message}`));
                        
                        await dbServices.deleteUserBot(user.user_id, user.app_name);
                        await dbServices.removeMonitoredFreeTrial(user.user_id);
                        await bot.sendMessage(ADMIN_ID, `Free trial bot *${escapeMarkdown(user.app_name)}* for user \`${user.user_id}\` was auto-deleted because they left the channel and did not rejoin.`, { parse_mode: 'Markdown' });
                    }
                } else {
                    // No warning sent yet, send one now
                    console.log(`[Monitor] User ${user.user_id} left the channel. Sending warning.`);
                    await bot.sendMessage(user.user_id, `We noticed you left our support channel. To continue using your free trial bot *${escapeMarkdown(user.app_name)}*, you must rejoin within 1 hour, or it will be automatically deleted.`, { parse_mode: 'Markdown' });
                    await dbServices.updateFreeTrialWarning(user.user_id);
                }
            }
        } catch (error) {
            console.error(`[Monitor] Error checking user ${user.user_id}:`, error.message);
        }
    }
}

// Run the check every 30 minutes
setInterval(checkMonitoredUsers, 30 * 60 * 1000);


const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

async function checkAndManageExpirations() {
    console.log('[Expiration] Running daily check for expiring and expired bots...');
    const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
    const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000; // 48 Hours

    // 1. Handle Warnings for Soon-to-Expire Bots
    const expiringBots = await dbServices.getExpiringBackups(); 
    
    for (const botInfo of expiringBots) {
        const daysLeft = Math.ceil((new Date(botInfo.expiration_date) - Date.now()) / ONE_DAY_IN_MS);
        let warningToSend = null; 
        let newWarningLevel = 0;

        if (botInfo.warning_level === 0 && daysLeft <= 7) {
            warningToSend = 7;
            newWarningLevel = 7;
        } else if (botInfo.warning_level === 7 && daysLeft <= 3) {
            warningToSend = 3;
            newWarningLevel = 3;
        } else if (botInfo.warning_level === 3 && daysLeft <= 1) {
            warningToSend = 1;
            newWarningLevel = 1;
        }

        if (warningToSend) {
            let warningMessageText = '';
            if (warningToSend === 7) {
                warningMessageText = `Your paid bot *${escapeMarkdown(botInfo.app_name)}* will expire in *${daysLeft} day(s)*. Please renew it to prevent suspension.`;
            } else if (warningToSend === 3) {
                warningMessageText = `URGENT: Your bot *${escapeMarkdown(botInfo.app_name)}* expires in *${daysLeft} day(s)* only! Renew now or it will be suspended.`;
            } else if (warningToSend === 1) {
                warningMessageText = `CRITICAL: Your bot *${escapeMarkdown(botInfo.app_name)}* expires TODAY/TOMORROW! This is your last chance to renew before suspension and eventual deletion.`;
            }
            
            console.log(`[Expiration] Sending ${warningToSend}-day warning for ${botInfo.app_name}.`);
            
            try {
                await bot.sendMessage(botInfo.user_id, warningMessageText, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: `Renew "${botInfo.app_name}" Now`, callback_data: `renew_bot:${botInfo.app_name}` }]]
                    }
                });

                try {
                    const ownerInfoResult = await pool.query(
                        `SELECT email FROM email_verification WHERE user_id = $1 AND is_verified = TRUE`,
                        [botInfo.user_id]
                    );
                    if (ownerInfoResult.rows.length > 0 && ownerInfoResult.rows[0].email) {
                        await sendExpirationReminder(ownerInfoResult.rows[0].email, botInfo.app_name, botUsername, daysLeft);
                    }
                } catch (emailError) {
                    console.error(`[Expiration] Email error for ${botInfo.app_name}:`, emailError.message);
                }

                await dbServices.setBackupWarningLevel(botInfo.user_id, botInfo.app_name, newWarningLevel);
            } catch (error) {
                console.error(`[Expiration] Failed to send ${warningToSend}-day warning to user ${botInfo.user_id}:`, error.message);
            }
        }
    }

    // 2. Handle Suspension and Deletion of Expired Bots
    const expiredBots = await dbServices.getExpiredBackups();
    for (const botInfo of expiredBots) {
        try {
            const expiryTime = new Date(botInfo.expiration_date).getTime();
            const timeSinceExpiry = Date.now() - expiryTime;

            if (timeSinceExpiry < GRACE_PERIOD_MS) {
                // --- PHASE A: WITHIN GRACE PERIOD (SUSPEND) ---
                if (!botInfo.paused_at) {
                    console.log(`[Grace Period] Suspending ${botInfo.app_name}.`);
                    
                    // Pause on Heroku
                    await herokuApi.patch(`/apps/${botInfo.app_name}/formation/web`, 
                        { quantity: 0 },
                        { headers: { 'Authorization': `Bearer ${HEROKU_API_KEY}` } }
                    ).catch(() => {});

                    // Record suspension in DB
                    await pool.query("UPDATE user_deployments SET paused_at = NOW() WHERE app_name = $1", [botInfo.app_name]);

                    const hoursLeft = Math.round((GRACE_PERIOD_MS - timeSinceExpiry) / (1000 * 60 * 60));
                    await bot.sendMessage(botInfo.user_id, 
                        `Notice: Bot Suspended - ${escapeMarkdown(botInfo.app_name)}\n\n` +
                        `Your subscription has expired. The bot is now offline.\n` +
                        `You have ${hoursLeft} hours to renew before the bot and its data are permanently deleted.`,
                        { 
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: 'Renew Now', callback_data: `renew_bot:${botInfo.app_name}` }]] }
                        }
                    ).catch(() => {});
                }
            } else {
                // --- PHASE B: GRACE PERIOD ENDED (DELETE) ---
                console.log(`[Expiration] Grace period ended for ${botInfo.app_name}. Deleting.`);
                
                await herokuApi.delete(`https://api.heroku.com/apps/${botInfo.app_name}`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                }).catch(() => {});
                
                let accountIdToDelete = '1';
                try {
                     const deployInfo = await pool.query('SELECT neon_account_id FROM user_deployments WHERE user_id = $1 AND app_name = $2', [botInfo.user_id, botInfo.app_name]);
                     if (deployInfo.rows.length > 0) accountIdToDelete = deployInfo.rows[0].neon_account_id;
                } catch(e) {}
                
                await deleteNeonDatabase(botInfo.app_name, accountIdToDelete).catch(() => {});
                await dbServices.permanentlyDeleteBotRecord(botInfo.user_id, botInfo.app_name);

                await bot.sendMessage(botInfo.user_id, `Final Notice: Your bot ${escapeMarkdown(botInfo.app_name)} has been permanently deleted because the grace period ended.`, { parse_mode: 'Markdown' }).catch(() => {});
                await bot.sendMessage(ADMIN_ID, `Bot ${escapeMarkdown(botInfo.app_name)} for user ${botInfo.user_id} was deleted after grace period.`).catch(() => {});
            }
        } catch (error) {
            console.error(`[Expiration Critical] Error managing ${botInfo.app_name}:`, error.message);
        }
    }
}



// Run the check once every day
setInterval(checkAndManageExpirations, ONE_DAY_IN_MS);
console.log('[Expiration] Scheduled daily check for expired bots.');

// === Automatic Daily Database Backup ===
async function runDailyBackup() {
    console.log('[Backup] Starting daily automatic database sync...');
    try {
        // This uses the sync function from your services, which powers /copydb
        const result = await dbServices.syncDatabases(pool, backupPool); 
        if (result.success) {
            console.log(`[Backup] Daily database sync successful. ${result.message}`);
            // Optional: Notify admin on success
            // await bot.sendMessage(ADMIN_ID, "Daily database backup completed successfully.");
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        console.error(`[Backup] CRITICAL ERROR during daily automatic backup:`, error.message);
        // Notify admin on failure
        await bot.sendMessage(ADMIN_ID, `CRITICAL ERROR: The automatic daily database backup failed. Please check the logs.\n\nReason: ${error.message}`);
    }
}

// --- NEW SCHEDULED TASK ---
async function checkAndUnpinMessages() {
    console.log('[Unpin] Running scheduled check for messages to unpin...');
    try {
        const now = new Date();
        const messagesToUnpin = await pool.query(
            'SELECT message_id, chat_id FROM pinned_messages WHERE unpin_at <= $1',
            [now]
        );

        for (const row of messagesToUnpin.rows) {
            console.log(`[Unpin] Unpinning message ${row.message_id} in chat ${row.chat_id}`);
            try {
                await bot.unpinChatMessage(row.chat_id, { message_id: row.message_id });
                // Delete the record from the database after unpinning
                await pool.query('DELETE FROM pinned_messages WHERE message_id = $1', [row.message_id]);
            } catch (error) {
                console.error(`[Unpin] Failed to unpin message ${row.message_id} in chat ${row.chat_id}:`, error.message);
            }
        }
    } catch (dbError) {
        console.error('[Unpin] DB Error fetching messages to unpin:', dbError.message);
    }
}

// Run the check every 5 minutes
setInterval(checkAndUnpinMessages, 5 * 60 * 1000);
console.log('[Unpin] Scheduled task to check for messages to unpin.');

// Run the backup every 24 hours (24 * 60 * 60 * 1000 milliseconds)
setInterval(runDailyBackup, 60 * 60 * 1000);
console.log('[Backup] Scheduled hourly automatic database backup.');


async function pruneInactiveUsers() {
    console.log('[Prune] Running daily check for inactive users with no bots...');
    
    try {
        const thirtyDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

        // This query finds users seen over 30 days ago who are NOT in the user_bots table.
        const result = await pool.query(
            `SELECT ua.user_id FROM user_activity ua
             LEFT JOIN user_bots ub ON ua.user_id = ub.user_id
             WHERE ua.last_seen <= $1 AND ub.user_id IS NULL`,
            [thirtyDaysAgo]
        );

        const usersToDelete = result.rows;
        if (usersToDelete.length === 0) {
            console.log('[Prune] No inactive users found for deletion.');
            return;
        }

        console.log(`[Prune] Found ${usersToDelete.length} inactive user(s) to delete.`);

        for (const user of usersToDelete) {
            const userId = user.user_id;
            try {
                // Delete the user from all relevant tables
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query('DELETE FROM user_activity WHERE user_id = $1', [userId]);
                    await client.query('DELETE FROM email_verification WHERE user_id = $1', [userId]);
                    // Add other tables if necessary (e.g., free_trial_numbers, temp_deploys)
                    await client.query('DELETE FROM free_trial_numbers WHERE user_id = $1', [userId]);
                    await client.query('DELETE FROM temp_deploys WHERE user_id = $1', [userId]);
                    await client.query('COMMIT');
                    console.log(`[Prune] Successfully deleted all records for inactive user: ${userId}`);
                } catch (e) {
                    await client.query('ROLLBACK');
                    throw e;
                } finally {
                    client.release();
                }
            } catch (deleteError) {
                console.error(`[Prune] Failed to delete user ${userId}:`, deleteError);
            }
        }

    } catch (dbError) {
        console.error('[Prune] DB Error while checking for inactive users:', dbError);
    }
}

// In bot.js (e.g., around line 5800, in the global scope)

// --- Proactive Capacity Monitor ---
const SLOT_WARNING_THRESHOLD = 10; // Warn if available slots are 9 or fewer
const CAPACITY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let isCapacityWarningSent = false; // Flag to prevent spamming

/**
 * Automatically checks Neon DB capacity and warns the admin if slots are low.
 */
async function checkNeonCapacity() {
    console.log(' running scheduled check for Neon DB capacity...');
    const USER_DB_LIMIT = 2; // Your established limit of 2 user slots per account
    let totalSlotsLeft = 0;
    let failedAccounts = 0;

    // This is a minimal, fast version of the /dbstats logic
    for (const accountConfig of NEON_ACCOUNTS) {
        const { api_key, project_id, branch_id } = accountConfig;
        
        // Skip if essential keys are missing (prevents crashes)
        if (!api_key || !project_id || !branch_id) {
            console.error(`[Capacity Check] Skipping Account ${accountConfig.id}: Missing credentials.`);
            failedAccounts++;
            continue;
        }

        const dbsUrl = `https://console.neon.tech/api/v2/projects/${project_id}/branches/${branch_id}/databases`;
        const headers = { 'Authorization': `Bearer ${api_key}`, 'Accept': 'application/json' };

        try {
            const dbsResponse = await axios.get(dbsUrl, { headers });
            const dbList = dbsResponse.data.databases;
            const userDBs = dbList.filter(db => db.name !== 'neondb');
            const userDBCount = userDBs.length;
            
            // Add this account's remaining slots to the total
            totalSlotsLeft += Math.max(0, USER_DB_LIMIT - userDBCount);

        } catch (error) {
            // If an account check fails, log it and assume it's full (0 slots left)
            console.error(`[Capacity Check] Failed to check Account ${accountConfig.id}: ${error.message.substring(0, 50)}`);
            failedAccounts++;
        }
    }

    console.log(`[Capacity Check] Check complete. Total slots left: ${totalSlotsLeft}. Failed accounts: ${failedAccounts}.`);

    // Now, check against the threshold
    if (totalSlotsLeft < SLOT_WARNING_THRESHOLD) {
        // If slots are low AND we haven't sent the warning yet
        if (!isCapacityWarningSent) {
            const message = `
            *LOW CAPACITY WARNING!*
            
            Only *${totalSlotsLeft}* free database slots remain across the system.
            
            Please add more Neon accounts immediately to prevent deployment failures for new users.
            
            (${NEON_ACCOUNTS.length} total accounts, ${failedAccounts} failed to respond)
            `;
            
            try {
                await bot.sendMessage(ADMIN_ID, message, { parse_mode: 'Markdown' });
                isCapacityWarningSent = true; // Set the flag so we don't spam
            } catch (e) {
                console.error(`[Capacity Check] Failed to send alert to ADMIN_ID: ${e.message}`);
            }
        } else {
            console.log(`[Capacity Check] Slots are low (${totalSlotsLeft}), but warning was already sent.`);
        }
    } else if (totalSlotsLeft > (SLOT_WARNING_THRESHOLD * 2)) { 
        // If capacity is restored (e.g., > 20), reset the warning flag
        if (isCapacityWarningSent) {
            console.log('[Capacity Check] Capacity restored. Resetting warning flag.');
            isCapacityWarningSent = false;
        }
    }
}


// bot.js (Insert this at the bottom of bot.js, outside any main function)

// Assuming ONE_DAY_IN_MS is 24 * 60 * 60 * 1000
const WARNING_DAYS = 7; 

async function sendLoggedOutCountdownReminders() {
    console.log('[Countdown] Running scheduled logged-out bot countdown check...');
    
    // 1. Fetch bots logged out for less than 7 days but more than 0 days
    // This fetches the user's verified email along with the log-out time.
    const result = await pool.query(
        `SELECT ub.user_id, ub.bot_name, ub.status_changed_at, v.email
         FROM user_bots ub
         LEFT JOIN email_verification v ON ub.user_id = v.user_id AND v.is_verified = TRUE
         WHERE ub.status = 'logged_out' 
         AND ub.status_changed_at IS NOT NULL
         AND ub.status_changed_at > NOW() - INTERVAL '${WARNING_DAYS} days'`,
    );

    for (const botInfo of result.rows) {
        const { user_id, bot_name, status_changed_at, email } = botInfo;

        const timeSinceLogout = Date.now() - new Date(status_changed_at).getTime();
        const daysElapsed = Math.floor(timeSinceLogout / (24 * 60 * 60 * 1000));
        const daysRemaining = WARNING_DAYS - daysElapsed;

        // Only send a countdown reminder if we are between Day 1 and Day 6 (exclusive of the initial Day 0 warning)
        if (daysRemaining >= 1 && daysRemaining <= WARNING_DAYS - 1) { 
            
            const daysLeftMessage = `⚠️ Bot *${escapeMarkdown(bot_name)}* is still logged out. It will be **permanently deleted** in **${daysRemaining} day(s)**. Please update your session ID now!`;
            
            // Send the precise Telegram warning
            await bot.sendMessage(user_id, daysLeftMessage, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: 'Change Session ID', callback_data: `change_session:${bot_name}:${user_id}` }]]
                }
            }).catch(e => console.error(`Failed to send countdown reminder to user ${user_id}: ${e.message}`));
            
            // If email service is available, send email reminder too (using your existing logic/function)
            if (email) {
                 // Assuming you have a function like sendLoggedOutReminder defined elsewhere
                 // await sendLoggedOutReminder(email, bot_name, bot.username, daysRemaining);
            }
        }
    }
}

// 🚨 Schedule this to run every 24 hours (1 day)
setInterval(sendLoggedOutCountdownReminders, 24 * 60 * 60 * 1000); 
console.log('[Countdown] Scheduled daily logged-out bot countdown reminders.');


async function checkAndSendLoggedOutReminders() {
    console.log('[Email] Running daily logged-out bot email check...');
    try {
        // This function should get bots that need an email reminder
        const botsToEmail = await dbServices.getLoggedOutBotsForEmail();

        for (const botInfo of botsToEmail) {
            // Make sure your DB query returns these fields
            const { bot_name, email, status_changed_at } = botInfo;
            
            if (email && status_changed_at) {
                // Calculate how many days are left before the 7-day auto-deletion
                const timeSinceLogout = Date.now() - new Date(status_changed_at).getTime();
                const daysElapsed = Math.floor(timeSinceLogout / (24 * 60 * 60 * 1000));
                const daysRemaining = Math.max(0, 7 - daysElapsed);

                // Only send the email if there's still time left
                if (daysRemaining > 0) {
                    await sendLoggedOutReminder(email, bot_name, bot.username, daysRemaining);
                }
            }
        }
    } catch (error) {
        console.error('[Email] Error in scheduled logged-out reminder task:', error);
    }
}


// Run the check for inactive users every 24 hours
setInterval(pruneInactiveUsers, ONE_DAY_IN_MS);
console.log('[Prune] Scheduled daily check for inactive users.');


// Run the check every 24 hours
setInterval(checkAndSendLoggedOutReminders, ONE_DAY_IN_MS);
console.log('[Email] Scheduled daily logged-out bot email reminders.');
