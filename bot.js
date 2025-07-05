// bot.js

require('dotenv').config();
const fs          = require('fs');
const axios       = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');

// Load config
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

// 1) Auto-create user_bots table
async function ensureTableExists() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id    TEXT NOT NULL,
      bot_name   TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
ensureTableExists().catch(err => console.error(
  '❌ Failed to ensure user_bots table:', err
));

// 2) DB helpers
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

// 3) Initialize bot & state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds who've used a valid key
const validKeys       = new Set(); // one-time deploy keys

// 4) Utilities
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}
function buildKeyboard(isAdmin) {
  if (isAdmin) {
    return [
      ['🚀 Deploy','📦 Apps'],
      ['🔐 Generate Key','🧾 Get Session'],
      ['🆘 Support']
    ];
  }
  return [
    ['🧾 Get Session','🚀 Deploy'],
    ['📦 My Bots'],
    ['🆘 Support']
  ];
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
async function sendAppList(cid) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) {
      return bot.sendMessage(cid, '📭 No apps found.');
    }
    const rows = chunkArray(apps, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(cid,
      `📦 Total Apps: ${apps.length}\nTap an app to manage:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
}

// 5) Error logging
bot.on('polling_error', console.error);

// 6) /start handler
bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
  const cid     = msg.chat.id.toString();
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

// 7) /generate (admin only)
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  }
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
});

// 8) /apps (admin only)
bot.onText(/^\/apps$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) sendAppList(cid);
});

// 9) Main message handler
bot.on('message', async msg => {
  const cid       = msg.chat.id.toString();
  const rawText   = msg.text?.trim() || '';
  const textLower = rawText.toLowerCase();
  const isAdmin   = cid === ADMIN_ID;

  // 🔐 Generate Key button
  if (rawText === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
  }

  // 📦 Apps button (admin)
  if (rawText === '📦 Apps' && isAdmin) {
    return sendAppList(cid);
  }

  // 🆘 Support
  if (rawText === '🆘 Support' || textLower === 'support') {
    return bot.sendMessage(cid, `🆘 Contact Admin: ${SUPPORT_USERNAME}`);
  }

  // 🧾 Get Session
  if (rawText === '🧾 Get Session' || textLower === 'get session') {
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
      await bot.sendMessage(cid,
        '⚠️ Failed to send image. Visit:\nhttps://levanter-delta.vercel.app/'
      );
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

  // 🚀 Deploy
  if (rawText === '🚀 Deploy' || textLower === 'deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid,
        '🔐 Please enter your one-time deploy key.');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '📝 Please send your SESSION_ID:');
  }

  // 📦 My Bots
  if (rawText === '📦 My Bots' || textLower === 'my bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) {
      return bot.sendMessage(cid, '📭 You haven’t deployed any bots yet.');
    }
    const rows = chunkArray(bots, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectbot:${name}` }))
    );
    return bot.sendMessage(cid, '🤖 Select a bot:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // --- State machine ---
  const state = userStates[cid];
  if (!state) return;

  // 1) Awaiting one-time key
  if (state.step === 'AWAITING_KEY') {
    const key = rawText.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step: 'SESSION_ID', data: {} };
      await bot.sendMessage(ADMIN_ID,
        `🔐 Key used by: ${cid}`);
      return bot.sendMessage(cid,'✅ Key accepted! Send your SESSION_ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid or expired key.');
  }

  // 2) Got SESSION_ID → ask APP_NAME
  if (state.step === 'SESSION_ID') {
    if (rawText.length < 5) {
      return bot.sendMessage(cid,'⚠️ SESSION_ID must be at least 5 characters.');
    }
    state.data.SESSION_ID = rawText;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid,'📝 What name would you like to give your bot?');
  }

  // 3) Got APP_NAME → ask AUTO_STATUS_VIEW
  if (state.step === 'APP_NAME') {
    const nm = rawText.trim().toLowerCase().replace(/\s+/g,'-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid,
        '⚠️ Name must be at least 5 chars: lowercase, numbers, or hyphens.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `❌ "${nm}" is already taken. Choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = nm;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW → deploy & record
  if (state.step === 'AUTO_STATUS_VIEW') {
    const v = textLower;
    if (v !== 'true' && v !== 'false') {
      return bot.sendMessage(cid,'⚠️ Please reply with "true" or "false".');
    }
    state.data.AUTO_STATUS_VIEW = (v === 'true' ? 'no-dl' : 'false');
    await bot.sendMessage(cid,'📦 Build queued...');
    await deployToHeroku(cid, state.data);
    await addUserBot(cid, state.data.APP_NAME, state.data.SESSION_ID);
    delete userStates[cid];
    return;
  }
});

// 10) Handle callback queries
bot.on('callback_query', async query => {
  const cid  = query.message.chat.id.toString();
  const [action, payload] = query.data.split(':');
  await bot.answerCallbackQuery(query.id);

  // Admin: app menu
  if (action === 'selectapp') {
    return bot.sendMessage(cid,
      `🔧 Admin actions for "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'ℹ️ Info',    callback_data: `info:${payload}` },
            { text: '📜 Logs',    callback_data: `logs:${payload}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `delete:${payload}` },
            { text: '⚙️ SetVar',  callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  // User: bot menu
  if (action === 'selectbot') {
    return bot.sendMessage(cid,
      `🔧 What would you like to do with "${payload}"?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Restart', callback_data: `restart:${payload}` },
            { text: '📜 Logs',    callback_data: `logs:${payload}` }
          ],
          [
            { text: '🗑️ Delete', callback_data: `userdelete:${payload}` },
            { text: '⚙️ SetVar',  callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  // ... add handlers for restart, logs, delete, userdelete, info,
  // setvar, varselect, setvarbool, and text-var fallback here
});

// 11) Deploy helper
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  // buildpacks
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

  // config vars
  const cfg = {
    SESSION_ID:       vars.SESSION_ID,
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

  // build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` }},
    { headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    }}
  );

  // poll build status
  let status = bres.data.status;
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  for (let i = 0; status === 'pending' && i < 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(statusUrl, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    status = poll.data.status;
  }

  if (status === 'succeeded') {
    await bot.sendMessage(chatId,
      `✅ Deployed! Your bot is live at https://${appName}.herokuapp.com`
    );
  } else {
    await bot.sendMessage(chatId,
      `❌ Build ${status}. Check your Heroku dashboard.`
    );
  }
}
