// bot.js

// Global error handlers
process.on('unhandledRejection', err =>
  console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// Load default env vars from app.json (Heroku fallback)
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

// PostgreSQL setup & ensure table exists
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id    TEXT NOT NULL,
      bot_name   TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('user_bots table ready');
})().catch(console.error);

// Database helper functions
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
const authorizedUsers = new Set(); // chatIds with valid key
const validKeys = new Set();       // one-time deploy keys

// Utility functions
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

function buildKeyboard(isAdmin) {
  if (isAdmin) {
    return [
      ['Deploy', 'Apps'],
      ['Generate Key', 'Get Session'],
      ['Support']
    ];
  } else {
    return [
      ['Get Session', 'Deploy'],
      ['My Bots'],
      ['Support']
    ];
  }
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Send Heroku apps list with total count
async function sendAppList(chatId) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(app => app.name);
    if (apps.length === 0) {
      return bot.sendMessage(chatId, 'No apps found.');
    }
    const rows = chunkArray(apps, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(chatId,
      `Total apps: ${apps.length}\n\nSelect an app to manage:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    bot.sendMessage(chatId, `Error fetching apps: ${err.message}`);
  }
}

// Build and deploy with Heroku Postgres add-on & progress
async function buildWithProgress(chatId, vars) {
  const appName = vars.APP_NAME;
  // Create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });
  // Provision Postgres add-on
  await axios.post(
    `https://api.heroku.com/apps/${appName}/addons`,
    { plan: 'heroku-postgresql:hobby-dev' },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    }
  );
  // Configure buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    {
      updates: [
        { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
        { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
        { buildpack: 'heroku/nodejs' }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    }
  );
  // Set config vars
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    {
      SESSION_ID: vars.SESSION_ID,
      AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
      ...defaultEnvVars
    },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    }
  );
  // Start build
  const buildRes = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    }
  );
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${buildRes.data.id}`;
  let status = 'pending';
  const progressMsg = await bot.sendMessage(chatId, 'Building... 0%');
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
    await bot.editMessageText(`Building... ${pct}%`, {
      chat_id: chatId,
      message_id: progressMsg.message_id
    });
    if (status !== 'pending') break;
  }
  if (status === 'succeeded') {
    await bot.editMessageText(
      `Build complete! Your app is live at https://${appName}.herokuapp.com`,
      { chat_id: chatId, message_id: progressMsg.message_id }
    );
  } else {
    await bot.editMessageText(
      `Build ${status}. Check your Heroku dashboard.`,
      { chat_id: chatId, message_id: progressMsg.message_id }
    );
  }
}

// Handle polling errors
bot.on('polling_error', console.error);

// /start handler
bot.onText(/^\/start$/, async msg => {
  const chatId = msg.chat.id.toString();
  const isAdmin = chatId === ADMIN_ID;
  delete userStates[chatId];
  if (isAdmin) authorizedUsers.add(chatId);

  // Log user info
  const { first_name, last_name, username } = msg.from;
  const fullName = [first_name, last_name].filter(Boolean).join(' ');
  console.log(`User started: ${fullName} (@${username || 'N/A'}) [${chatId}]`);

  const welcome = isAdmin
    ? 'Welcome back, admin. You have full control over deployments.'
    : 'Welcome! Use this bot to deploy and manage your WhatsApp bot.';

  await bot.sendMessage(chatId, welcome, {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /menu handler
bot.onText(/^\/menu$/i, msg => {
  const chatId = msg.chat.id.toString();
  const isAdmin = chatId === ADMIN_ID;
  bot.sendMessage(chatId, 'Choose an option:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// Admin: generate key
bot.onText(/^\/generate$/i, msg => {
  const chatId = msg.chat.id.toString();
  if (chatId !== ADMIN_ID) {
    return bot.sendMessage(chatId, 'Only admin can generate keys.');
  }
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(chatId, `One-time deploy key:\n\`${key}\``, { parse_mode: 'Markdown' });
});

// Admin: list apps
bot.onText(/^\/apps$/i, msg => {
  const chatId = msg.chat.id.toString();
  if (chatId === ADMIN_ID) {
    sendAppList(chatId);
  }
});

// Main message handler
bot.on('message', async msg => {
  const chatId = msg.chat.id.toString();
  const text = msg.text?.trim() || '';
  const lc = text.toLowerCase();
  const isAdmin = chatId === ADMIN_ID;

  // Admin buttons
  if (text === 'Apps' && isAdmin) {
    return sendAppList(chatId);
  }
  if (text === 'Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(chatId, `One-time deploy key:\n\`${key}\``, { parse_mode: 'Markdown' });
  }

  // Support
  if (text === 'Support' || lc === 'support') {
    return bot.sendMessage(chatId, 'Contact admin for support.');
  }

  // Get Session instructions
  if (text === 'Get Session' || lc === 'get session') {
    userStates[chatId] = { step: 'SESSION_ID', data: {} };
    try {
      await bot.sendPhoto(chatId, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption:
          'How to get your session ID:\n\n' +
          '1. Open the link below\n' +
          '2. Click "Session" in the sidebar\n' +
          '3. Enter a custom session ID (for example your name)\n\n' +
          'Link: https://levanter-delta.vercel.app/',
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(chatId,
        'Visit this link to get your session ID:\nhttps://levanter-delta.vercel.app/'
      );
    }
    return bot.sendMessage(chatId,
      'Note:\n' +
      '- Use a modern browser (Chrome recommended)\n' +
      '- Skip any ads or popups\n' +
      '- Enter a custom session ID (e.g. your name)\n' +
      '- This ID will be used to automatically start your bot\n\n' +
      'When ready, tap "Deploy".'
    );
  }

  // Deploy flow
  if (text === 'Deploy' || lc === 'deploy') {
    if (!isAdmin && !authorizedUsers.has(chatId)) {
      userStates[chatId] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(chatId, 'Enter your one-time deploy key:');
    }
    userStates[chatId] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(chatId, 'Please send your session ID:');
  }

  // My Bots flow
  if (text === 'My Bots' || lc === 'my bots') {
    const bots = await getUserBots(chatId);
    if (bots.length === 0) {
      return bot.sendMessage(chatId, 'You have not deployed any bots.');
    }
    const rows = chunkArray(bots, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectbot:${name}` }))
    );
    return bot.sendMessage(chatId, 'Your deployed bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // Stateful conversation
  const state = userStates[chatId];
  if (!state) return;

  // Awaiting deploy key
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(chatId);
      userStates[chatId] = { step: 'SESSION_ID', data: {} };
      // Notify admin
      const { first_name, last_name, username } = msg.from;
      const fullName = [first_name, last_name].filter(Boolean).join(' ');
      await bot.sendMessage(ADMIN_ID,
        `A deploy key was used:\n\n` +
        `Name: ${fullName}\n` +
        `ID: \`${chatId}\`\n` +
        `Username: @${username || 'N/A'}`,
        { parse_mode: 'Markdown' }
      );
      return bot.sendMessage(chatId, 'Key accepted. Please send your session ID:');
    }
    return bot.sendMessage(chatId, 'Invalid or expired key.');
  }

  // Got session ID
  if (state.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(chatId, 'Session ID must be at least 5 characters.');
    }
    state.data.SESSION_ID = text;
    state.step = 'APP_NAME';
    return bot.sendMessage(chatId, 'Enter a name for your bot:');
  }

  // Got app name
  if (state.step === 'APP_NAME') {
    const name = text.toLowerCase().replace(/\s+/g, '-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(chatId,
        'Invalid name. Use at least 5 characters: lowercase letters, numbers or hyphens.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(chatId, `The name "${name}" is already taken. Choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = name;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(chatId, 'Enable automatic status view? (true/false)');
      }
      throw e;
    }
  }

  // AUTO_STATUS_VIEW
  if (state.step === 'AUTO_STATUS_VIEW') {
    const lcText = text.toLowerCase();
    if (lcText !== 'true' && lcText !== 'false') {
      return bot.sendMessage(chatId, 'Please reply with "true" or "false".');
    }
    state.data.AUTO_STATUS_VIEW = lcText === 'true' ? 'no-dl' : 'false';
    await buildWithProgress(chatId, state.data);
    await addUserBot(chatId, state.data.APP_NAME, state.data.SESSION_ID);
    delete userStates[chatId];
    return;
  }

  // Text-based SetVar (session ID, prefix, etc.)
  if (state.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = state.data;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: text },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
          }
        }
      );
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(chatId, APP_NAME, text);
      }
      return bot.sendMessage(chatId,
        `Updated ${VAR_NAME} to:\n\`\`\`\n${text}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      return bot.sendMessage(chatId, `Failed to update: ${err.message}`);
    } finally {
      delete userStates[chatId];
    }
  }
});

// Callback query handler
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id.toString();
  const [action, payload, extra, flag] = query.data.split(':');
  await bot.answerCallbackQuery(query.id);

  // Admin submenu for apps
  if (action === 'selectapp') {
    return bot.sendMessage(chatId, `Manage app "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Restart', callback_data: `restart:${payload}` },
            { text: 'Logs',    callback_data: `logs:${payload}` }
          ],
          [
            { text: 'Delete',  callback_data: `delete:${payload}` },
            { text: 'SetVar',  callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  // User submenu for bots
  if (action === 'selectbot') {
    return bot.sendMessage(chatId, `Manage your bot "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Restart', callback_data: `restart:${payload}` },
            { text: 'Logs',    callback_data: `logs:${payload}` }
          ],
          [
            { text: 'Delete',  callback_data: `userdelete:${payload}` },
            { text: 'SetVar',  callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  // Restart dynos
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(chatId, `App "${payload}" restarted.`);
    } catch (err) {
      return bot.sendMessage(chatId, `Restart failed: ${err.message}`);
    }
  }

  // Logs: fetch and send as code block
  if (action === 'logs') {
    try {
      const session = await axios.post(
        `https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: false, lines: 100 },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
          }
        }
      );
      const logUrl = session.data.logplex_url;
      const logRes = await axios.get(logUrl);
      const logs = logRes.data.trim().slice(-4000);
      return bot.sendMessage(chatId,
        `Logs for "${payload}":\n\`\`\`\n${logs}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      return bot.sendMessage(chatId, `Logs failed: ${err.message}`);
    }
  }

  // Delete (admin)
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(chatId, `App "${payload}" deleted.`);
    } catch (err) {
      return bot.sendMessage(chatId, `Delete failed: ${err.message}`);
    }
  }

  // Delete (user)
  if (action === 'userdelete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      await deleteUserBot(chatId, payload);
      return bot.sendMessage(chatId, `Your bot "${payload}" deleted.`);
    } catch (err) {
      return bot.sendMessage(chatId, `Delete failed: ${err.message}`);
    }
  }

  // SetVar menu
  if (action === 'setvar') {
    return bot.sendMessage(chatId, `Set variable for "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'SESSION_ID',       callback_data: `varselect:SESSION_ID:${payload}` },
            { text: 'AUTO_STATUS_VIEW', callback_data: `varselect:AUTO_STATUS_VIEW:${payload}` }
          ],
          [
            { text: 'ALWAYS_ONLINE',    callback_data: `varselect:ALWAYS_ONLINE:${payload}` },
            { text: 'PREFIX',           callback_data: `varselect:PREFIX:${payload}` }
          ]
        ]
      }
    });
  }

  // Variable selected
  if (action === 'varselect') {
    const varKey = payload;
    const appName = extra;
    if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE'].includes(varKey)) {
      return bot.sendMessage(chatId, `Set ${varKey} to:`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'true',  callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ]]
        }
      });
    }
    // Text input fallback for SESSION_ID, PREFIX, etc.
    userStates[chatId] = {
      step: 'SETVAR_ENTER_VALUE',
      data: { APP_NAME: appName, VAR_NAME: varKey }
    };
    return bot.sendMessage(chatId, `Enter new value for ${varKey}:`);
  }

  // Boolean var update
  if (action === 'setvarbool') {
    const varKey = payload;
    const appName = extra;
    const flagVal = flag === 'true';
    const newVal = varKey === 'AUTO_STATUS_VIEW'
      ? (flagVal ? 'no-dl' : 'false')
      : (flagVal ? 'true' : 'false');
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
          }
        }
      );
      if (varKey === 'SESSION_ID') {
        await updateUserSession(chatId, appName, newVal);
      }
      return bot.sendMessage(chatId, `${varKey} updated to ${newVal}`);
    } catch (err) {
      return bot.sendMessage(chatId, `Update failed: ${err.message}`);
    }
  }
});
