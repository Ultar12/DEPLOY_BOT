require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// Config
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// PostgreSQL pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-create user_bots table
async function ensureTableExists() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ user_bots table is ready');
  } catch (err) {
    console.error('❌ Failed to create user_bots table:', err);
  }
}
ensureTableExists();

// DB helpers
async function addUserBot(userId, botName, sessionId) {
  await pool.query(
    'INSERT INTO user_bots(user_id, bot_name, session_id) VALUES($1,$2,$3)',
    [userId, botName, sessionId]
  );
}
async function getUserBots(userId) {
  const res = await pool.query(
    'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
    [userId]
  );
  return res.rows.map(r => r.bot_name);
}
async function deleteUserBot(userId, botName) {
  await pool.query(
    'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
    [userId, botName]
  );
}

// Initialize bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// In-memory state
const userStates = {};
const authorizedUsers = new Set();
const validKeys = new Set();

// Helpers
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}
function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['📋 Menu','🚀 Deploy','📦 Apps'], ['🔐 Generate Key','🧾 Get Session'], ['🆘 Support']]
    : [['📋 Menu','🧾 Get Session','🚀 Deploy'], ['📦 My Bots'], ['🆘 Support']];
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// /start
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);

  const keyboard = { keyboard: buildKeyboard(isAdmin), resize_keyboard: true };
  const welcome = isAdmin
    ? '👑 Welcome back, Admin!\n\nYou have full control over deployments and users.'
    : '🌟 Welcome to 𝖀𝖑𝖙-𝕬𝕽 BOT Deploy! 🌟\n\nEffortlessly deploy and take full control of your WhatsApp bot 💀';

  await bot.sendMessage(cid, welcome, keyboard);
});

// /menu
bot.onText(/^\/menu$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /generate (admin)
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
});

// /apps (admin)
bot.onText(/^\/apps$/, async msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return;
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) return bot.sendMessage(cid, '📭 No apps found.');
    const rows = chunkArray(apps, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(cid, '📦 Total Apps:\nTap one to manage:', {
      reply_markup: { inline_keyboard: rows }
    });
  } catch (err) {
    bot.sendMessage(cid, `❌ Error fetching apps: ${err.message}`);
  }
});

// Get Session
bot.onText(/^🧾 Get Session$/, async msg => {
  const cid = msg.chat.id.toString();
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  try {
    await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
      caption: `🧾 *How to Get Your Session ID:*\n\n` +
               `1. Tap the link below\n2. Click *Session* on the left\n3. Enter your custom session ID\n\n` +
               `🔗 https://levanter-delta.vercel.app/`,
      parse_mode: 'Markdown'
    });
  } catch {
    await bot.sendMessage(cid, '⚠️ Failed to send image. Visit:\nhttps://levanter-delta.vercel.app/');
  }
  await bot.sendMessage(cid,
    `💡 *Note:*\n• On iPhone, use Chrome\n• Skip any ad\n• Use a *custom session ID* for auto-start\n\nWhen ready, tap 🚀 Deploy.`,
    { parse_mode: 'Markdown' }
  );
});

// Deploy
bot.onText(/^🚀 Deploy$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    userStates[cid] = { step: 'AWAITING_KEY', data: {} };
    return bot.sendMessage(cid, '🔐 Please enter your one-time deploy key.');
  }
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Please send your SESSION_ID:');
});

// My Bots
bot.onText(/^📦 My Bots$/, async msg => {
  const cid = msg.chat.id.toString();
  const bots = await getUserBots(cid);
  if (!bots.length) return bot.sendMessage(cid, '📭 You haven’t deployed any bots yet.');
  const rows = chunkArray(bots, 3).map(row =>
    row.map(name => ({ text: name, callback_data: `selectbot:${name}` }))
  );
  return bot.sendMessage(cid, '🤖 Select a bot:', {
    reply_markup: { inline_keyboard: rows }
  });
});

// Callback handler
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const data = query.data;
  await bot.answerCallbackQuery(query.id);

  const [action, payload] = data.split(':');

  if (action === 'selectapp') {
    return bot.sendMessage(cid,
      `🔧 Admin actions for "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'ℹ️ Info', callback_data: `info:${payload}` },
            { text: '📜 Logs', callback_data: `logs:${payload}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `delete:${payload}` },
            { text: '⚙️ SetVar', callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  if (action === 'selectbot') {
    return bot.sendMessage(cid,
      `🔧 What would you like to do with "${payload}"?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Restart', callback_data: `restart:${payload}` },
            { text: '📜 Logs', callback_data: `logs:${payload}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `userdelete:${payload}` },
            { text: '⚙️ SetVar', callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  // Add more handlers here (info:, logs:, delete:, etc.)
