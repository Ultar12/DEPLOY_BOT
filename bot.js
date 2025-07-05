// bot.js

// Global error handlers
process.on('unhandledRejection', err =>
  console.error('🛑 Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('🛑 Uncaught Exception:', err));

require('dotenv').config();
const fs          = require('fs');
const axios       = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');

// Load defaults from app.json (fallback for Heroku env vars)
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch {}

// Environment config
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// PostgreSQL setup
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-create user_bots table
async function ensureTableExists() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
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

// Database helpers
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
async function updateUserSession(userId, botName, sessionId) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [sessionId, userId, botName]
  );
}

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// In-memory state
const userStates = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds that passed key
const validKeys = new Set();       // one-time deploy keys

// Utility functions
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}
function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['🚀 Deploy','📦 Apps'], ['🔐 Generate Key','🧾 Get Session'], ['🆘 Support']]
    : [['🧾 Get Session','🚀 Deploy'], ['📦 My Bots'], ['🆘 Support']];
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Error logging
bot.on('polling_error', console.error);

// /start handler
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);

  const welcome = isAdmin
    ? '👑 Welcome back, Admin!\n\nYou have full control over deployments and users.'
    : '🌟 Welcome to 𝖀𝖑𝖙-𝕬𝕽 BOT Deploy! 🌟\n\nEffortlessly deploy and take full control of your WhatsApp bot 💀';

  await bot.sendMessage(cid, welcome, {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /menu alias
bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// Admin: generate one-time key
bot.onText(/^\/generate$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
});

// Admin: list Heroku apps
bot.onText(/^\/apps$/i, async msg => {
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
    await bot.sendMessage(cid, '📦 Your Heroku Apps:', {
      reply_markup: { inline_keyboard: rows }
    });
  } catch (err) {
    bot.sendMessage(cid, `❌ Error fetching apps: ${err.message}`);
  }
});

// Main text handler
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const raw = msg.text?.trim() || '';
  const lc = raw.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // Admin buttons
  if (raw === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
  }
  if (raw === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat:{id:cid}, text:'/apps' });
  }

  // Support
  if (raw === '🆘 Support' || lc === 'support') {
    return bot.sendMessage(cid, `🆘 Contact Admin: ${SUPPORT_USERNAME}`);
  }

  // Get Session flow
  if (raw === '🧾 Get Session' || lc === 'get session') {
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: `🧾 *How to Get Your Session ID:*\n\n` +
                 `1. Tap the link below\n` +
                 `2. Click *Session* on the left\n` +
                 `3. Enter your custom session ID\n\n` +
                 `🔗 https://levanter-delta.vercel.app/`,
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, '⚠️ Visit:\nhttps://levanter-delta.vercel.app/');
    }
    return bot.sendMessage(cid,
      `💡 *Note:*\n` +
      `• On iPhone, use Chrome\n` +
      `• Skip any ad you see\n` +
      `• Use a *custom session ID* to auto-start\n\n` +
      `When ready, tap 🚀 Deploy.`,
      { parse_mode: 'Markdown' }
    );
  }

  // Deploy flow
  if (raw === '🚀 Deploy' || lc === 'deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid, '🔐 Please enter your one-time deploy key.');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '📝 Please send your SESSION_ID:');
  }

  // My Bots flow
  if (raw === '📦 My Bots' || lc === 'my bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, '📭 You haven’t deployed any bots yet.');
    const rows = chunkArray(bots, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectbot:${name}` }))
    );
    return bot.sendMessage(cid, '🤖 Your bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // Stateful conversation
  const state = userStates[cid];
  if (!state) return;

  // 1) Awaiting one-time key
  if (state.step === 'AWAITING_KEY') {
    const key = raw.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step: 'SESSION_ID', data: {} };
      await bot.sendMessage(ADMIN_ID, `🔐 Key used by: ${cid}`);
      return bot.sendMessage(cid, '✅ Key accepted! Send your SESSION_ID:');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key.');
  }

  // 2) Got SESSION_ID → ask for APP_NAME
  if (state.step === 'SESSION_ID') {
    if (raw.length < 5) return bot.sendMessage(cid, '⚠️ SESSION_ID must be ≥5 characters.');
    state.data.SESSION_ID = raw;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid, '📝 What name would you like for your bot?');
  }

  // 3) Got APP_NAME → ask AUTO_STATUS_VIEW
  if (state.step === 'APP_NAME') {
    const nm = raw.toLowerCase().replace(/\s+/g, '-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid, '⚠️ Name invalid. Use ≥5 chars, lowercase, numbers, hyphens.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `❌ "${nm}" is taken. Choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = nm;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid, '🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW → deploy & record
  if (state.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, '⚠️ Reply with "true" or "false".');
    }
    state.data.AUTO_STATUS_VIEW = lc === 'true' ? 'no-dl' : 'false';
    await bot.sendMessage(cid, '📦 Build queued...');
    await deployToHeroku(cid, state.data);
    await addUserBot(cid, state.data.APP_NAME, state.data.SESSION_ID);
    delete userStates[cid];
    return;
  }

  // 5) Text fallback for SETVAR
  if (state.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = state.data;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: raw },
        { headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }}
      );
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(cid, APP_NAME, raw);
      }
      bot.sendMessage(cid, `✅ Updated ${VAR_NAME} to \`${raw}\` for ${APP_NAME}`, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(cid, `❌ Update failed: ${err.message}`);
    }
    delete userStates[cid];
    return;
  }
});

// Callback queries handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const parts = q.data.split(':');
  const action = parts[0];
  await bot.answerCallbackQuery(q.id);

  // Admin: selectapp
  if (action === 'selectapp') {
    const appName = parts[1];
    return bot.sendMessage(cid,
      `🔧 Admin actions for "${appName}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'ℹ️ Info',    callback_data: `info:${appName}` },
            { text: '📜 Logs',    callback_data: `logs:${appName}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `delete:${appName}` },
            { text: '⚙️ SetVar',  callback_data: `setvar:${appName}` }
          ]
        ]
      }
    });
  }

  // User: selectbot
  if (action === 'selectbot') {
    const botName = parts[1];
    return bot.sendMessage(cid,
      `🔧 What would you like to do with "${botName}"?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Restart', callback_data: `restart:${botName}` },
            { text: '📜 Logs',    callback_data: `logs:${botName}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `userdelete:${botName}` },
            { text: '⚙️ SetVar',  callback_data: `setvar:${botName}` }
          ]
        ]
      }
    });
  }

  // SetVar menu
  if (action === 'setvar') {
    const appName = parts[1];
    return bot.sendMessage(cid,
      `⚙️ Choose variable for "${appName}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${appName}` },
            { text: 'AUTO_STATUS_VIEW', callback_data: `varselect:AUTO_STATUS_VIEW:${appName}` }
          ],
          [
            { text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${appName}` },
            { text: 'PREFIX', callback_data: `varselect:PREFIX:${appName}` }
          ]
        ]
      }
    });
  }

  // Variable selected
  if (action === 'varselect') {
    const varKey = parts[1];
    const appName = parts[2];
    if (['AUTO_STATUS_VIEW','ALWAYS_ONLINE'].includes(varKey)) {
      return bot.sendMessage(cid, `Set *${varKey}* to:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: 'true',  callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ]]
        }
      });
    }
    // Text input fallback
    userStates[cid] = {
      step: 'SETVAR_ENTER_VALUE',
      data: { APP_NAME: appName, VAR_NAME: varKey }
    };
    return bot.sendMessage(cid, `Please send the new value for *${varKey}*:`, { parse_mode: 'Markdown' });
  }

  // Boolean var update
  if (action === 'setvarbool') {
    const varKey = parts[1];
    const appName = parts[2];
    const valFlag = parts[3];
    const newVal = (valFlag === 'true')
      ? (varKey === 'AUTO_STATUS_VIEW' ? 'no-dl' : 'true')
      : 'false';
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }}
      );
      if (varKey === 'SESSION_ID') {
        await updateUserSession(cid, appName, newVal);
      }
      return bot.sendMessage(cid,
        `✅ Updated *${varKey}* to \`${newVal}\` for *${appName}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      return bot.sendMessage(cid, `❌ Update failed: ${err.message}`);
    }
  }

  // Additional callback handlers (info, logs, delete, restart, userdelete) go here...
});

// Deploy helper with simulated progress
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // Create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  // Configure buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    { updates: [
      { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
      { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
      { buildpack: 'heroku/nodejs' }
    ]},
    { headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    }}
  );

  // Set config vars
  const cfg = {
    ...defaultEnvVars,
    SESSION_ID: vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    cfg,
    { headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    }}
  );

  // Start build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` }},
    { headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    }}
  );

  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let status = 'pending';
  const progressMsg = await bot.sendMessage(chatId, '⏳ Building... 0%');

  for (let i = 1; i <= 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const poll = await axios.get(statusUrl, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      status = poll.data.status;
    } catch {
      break;
    }
    const pct = Math.min(100, i * 5);
    await bot.editMessageText(`⏳ Building... ${pct}%`, {
      chat_id: chatId,
      message_id: progressMsg.message_id
    });
    if (status !== 'pending') break;
  }

  if (status === 'succeeded') {
    await bot.editMessageText(`✅ Build complete! Your bot is live at:\nhttps://${appName}.herokuapp.com`, {
      chat_id: chatId,
      message_id: progressMsg.message_id
    });
  } else {
    await bot.editMessageText(`❌ Build ${status}. Check your Heroku dashboard.`, {
      chat_id: chatId,
      message_id: progressMsg.message_id
    });
  }
    }
