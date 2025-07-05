// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err =>
  console.error('🛑 Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('🛑 Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// 2) Load defaults from app.json (Heroku fallback)
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
  console.log('✅ Loaded defaults from app.json');
} catch {
  console.log('ℹ️ No app.json defaults found');
}

// 3) Environment variables
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,       // e.g. https://github.com/ultar1/lev
  ADMIN_ID,              // your Telegram user ID (string)
  DATABASE_URL           // PostgreSQL connection URL
} = process.env;

const SUPPORT_USERNAME = '@star_ies1';

// 4) PostgreSQL setup & tables
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  // table to track user-deployed bots
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id TEXT NOT NULL,
      bot_name TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // table to store one-time deploy keys with usage count
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deploy_keys (
      key TEXT PRIMARY KEY,
      uses_left INTEGER NOT NULL,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Tables are ready');
})().catch(console.error);

// 5) DB helper functions
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

async function addDeployKey(key, uses, createdBy) {
  await pool.query(
    'INSERT INTO deploy_keys(key, uses_left, created_by) VALUES($1,$2,$3)',
    [key, uses, createdBy]
  );
}
async function useDeployKey(key) {
  const res = await pool.query(
    `UPDATE deploy_keys 
       SET uses_left = uses_left - 1 
     WHERE key = $1 AND uses_left > 0
     RETURNING uses_left`,
    [key]
  );
  if (res.rowCount === 0) return null;        // invalid or expired
  const left = res.rows[0].uses_left;
  if (left === 0) {
    await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]);
  }
  return left;
}

// 6) Initialize Telegram bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates      = {};   // chatId -> { step, data }
const authorizedUsers = new Set(); 
// (chatIds that have validated a key in this session)

// 7) Utility functions
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
function buildUsageInlineKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [ [1,2,3,4,5].map(n => ({
        text: String(n),
        callback_data: `keyusage:${n}`
      })) ]
    }
  };
}

// 8) Build & deploy with progress animation
async function buildWithProgress(chatId, vars) {
  const name = vars.APP_NAME;

  // 1) Create app
  await axios.post('https://api.heroku.com/apps', { name }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  // 2) Provision Postgres
  await axios.post(
    `https://api.heroku.com/apps/${name}/addons`,
    { plan: 'heroku-postgresql' },
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );

  // 3) Install buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${name}/buildpack-installations`,
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

  // 4) Set config vars (including defaults)
  await axios.patch(
    `https://api.heroku.com/apps/${name}/config-vars`,
    {
      SESSION_ID: vars.SESSION_ID,
      AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
      ...defaultEnvVars
    },
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );

  // 5) Trigger build
  let bres;
  try {
    bres = await axios.post(
      `https://api.heroku.com/apps/${name}/builds`,
      { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
      { headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
      }}
    );
  } catch (err) {
    console.error('Build failed:', err.response?.data || err.message);
    throw new Error('Heroku build failed. Check repo URL, Procfile, config-vars.');
  }

  // 6) Animate progress
  const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
  let status = 'pending';
  const progMsg = await bot.sendMessage(chatId, '🛠️ Building... 0%');
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
    await bot.editMessageText(`🛠️ Building... ${pct}%`, {
      chat_id: chatId, message_id: progMsg.message_id
    });
    if (status !== 'pending') break;
  }

  // 7) Final result
  if (status === 'succeeded') {
    await bot.editMessageText(
      `✅ Build complete! Live at https://${name}.herokuapp.com`,
      { chat_id: chatId, message_id: progMsg.message_id }
    );
  } else {
    await bot.editMessageText(
      `❌ Build ${status}. Check your Heroku dashboard.`,
      { chat_id: chatId, message_id: progMsg.message_id }
    );
  }
}

// 9) /start handler
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (isAdmin) authorizedUsers.add(cid);
  delete userStates[cid];
  bot.sendMessage(cid,
    isAdmin ? '👑 Admin Menu:' : '🤖 User Menu:',
    { reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true } }
  );
});

// 10) Message handler for text commands
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;
  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;
  const st = userStates[cid];

  // 🚀 Deploy button
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid, '🔐 Please enter your deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '🧾 Enter your session ID:');
  }

  // 🔐 Generate Key (admin only)
  if (text === '🔐 Generate Key' && isAdmin) {
    userStates[cid] = { step: 'SELECT_KEY_USAGE' };
    return bot.sendMessage(cid,
      'Select how many times this key can be used:',
      buildUsageInlineKeyboard()
    );
  }

  // 🧾 Get Session guide
  if (text === '🧾 Get Session') {
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    // more detailed instructions
    await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
      caption:
        'How to get your session ID:\n\n' +
        '1. Visit https://levanter-delta.vercel.app/\n' +
        '2. Click on "Session" tab on the left sidebar\n' +
        '3. Enter a custom session ID (e.g. your name, no spaces)\n' +
        '4. Click "Generate" and copy the Session ID string\n\n' +
        '📋 Once you have it, tap "🚀 Deploy" below.',
      parse_mode: 'Markdown'
    });
    return;
  }

  // 📦 My Bots (user)
  if (text === '📦 My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, '📭 You have no deployed bots.');
    const rows = chunkArray(bots, 3).map(r =>
      r.map(name => ({ text: name, callback_data: `selectbot:${name}` }))
    );
    return bot.sendMessage(cid,
      `📦 Your Bots:\nTap to manage:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  }

  // 🆘 Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid,
      `Need help? Contact admin:\n${SUPPORT_USERNAME}`
    );
  }

  // 🔐 Awaiting deploy key
  if (st?.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    const usesLeft = await useDeployKey(key);
    if (usesLeft === null) {
      return bot.sendMessage(cid, '❌ Invalid or expired key.');
    }
    authorizedUsers.add(cid);
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    await bot.sendMessage(ADMIN_ID,
      `🔑 Key "${key}" used by ${cid}. Uses left: ${usesLeft}`
    );
    return bot.sendMessage(cid, '✅ Key accepted! Now enter your session ID:');
  }

  // 🧾 Session ID entry
  if (st?.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid, '❌ Session ID must be at least 5 characters.');
    }
    st.data.SESSION_ID = text;
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, '📛 Now enter a name for your bot (min 5 chars, a–z0–9-):');
  }

  // 📛 App Name entry
  if (st?.step === 'APP_NAME') {
    const name = text.toLowerCase().replace(/\s+/g, '-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(cid,
        '❌ Invalid name. Use lowercase letters, numbers, or hyphens (min 5 chars).'
      );
    }
    // check availability
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `❌ Name "${name}" is already taken.`);
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = name;
        st.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid, '✅ Name OK.\nEnable automatic status view? Reply "true" or "false".');
      }
      console.error('Name check error:', e);
      return bot.sendMessage(cid, '❌ Error checking name availability.');
    }
  }

  // ⚙️ AUTO_STATUS_VIEW entry → deploy
  if (st?.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, '❌ Reply exactly "true" or "false".');
    }
    st.data.AUTO_STATUS_VIEW = (lc === 'true' ? 'no-dl' : 'false');
    try {
      await bot.sendMessage(cid, '🚀 Starting deployment...');
      await buildWithProgress(cid, st.data);
      await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
      await bot.sendMessage(cid,
        `🎉 Your bot "${st.data.APP_NAME}" has been deployed!`
      );
    } catch (err) {
      console.error('Deployment error:', err);
      await bot.sendMessage(cid,
        `⚠️ Deployment failed: ${err.message}`
      );
    }
    delete userStates[cid];
    return;
  }
});

// 11) Handle inline callbacks
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // 🔢 Key usage selection (admin)
  if (action === 'keyusage') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    userStates[cid] = null;
    return bot.sendMessage(cid,
      `🔑 Generated key: \`${key}\`\n🔁 Can be used ${uses} time${uses>1?'s':''}.`,
      { parse_mode: 'Markdown' }
    );
  }

  // Admin: list all apps
  if (action === 'selectapp') {
    const name = payload;
    return bot.sendMessage(cid, `Manage app "${name}":`, {
      reply_markup: { inline_keyboard: [
        [
          { text: 'Info',    callback_data: `info:${name}` },
          { text: 'Restart', callback_data: `restart:${name}` },
          { text: 'Logs',    callback_data: `logs:${name}` }
        ],
        [
          { text: 'Delete',  callback_data: `delete:${name}` }
        ]
      ] }
    });
  }

  // User: list own bots
  if (action === 'selectbot') {
    const name = payload;
    return bot.sendMessage(cid, `Manage your bot "${name}":`, {
      reply_markup: { inline_keyboard: [
        [
          { text: 'Info',    callback_data: `info:${name}` },
          { text: 'Restart', callback_data: `restart:${name}` },
          { text: 'Logs',    callback_data: `logs:${name}` }
        ],
        [
          { text: 'Delete',  callback_data: `userdelete:${name}` }
        ]
      ] }
    });
  }

  // ℹ️ Info
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      const { name, web_url, stack, region, created_at } = res.data;
      const ageDays = Math.floor((Date.now() - new Date(created_at)) / (1000*60*60*24));
      return bot.sendMessage(cid,
        `📦 App Info:\n` +
        `• Name: ${name}\n` +
        `• URL: ${web_url}\n` +
        `• Stack: ${stack}\n` +
        `• Region: ${region?.name || 'unknown'}\n` +
        `• Created: ${new Date(created_at).toDateString()}\n` +
        `• Age: ${ageDays} day${ageDays===1?'':'s'}`
      );
    } catch (e) {
      return bot.sendMessage(cid, `❌ Error fetching info: ${e.message}`);
    }
  }

  // 🔄 Restart
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `🔄 "${payload}" has been restarted.`);
    } catch (e) {
      return bot.sendMessage(cid, `❌ Error restarting: ${e.message}`);
    }
  }

  // 📜 Logs
  if (action === 'logs') {
    try {
      const sess = await axios.post(
        `https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: false, lines: 100 },
        { headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
        }}
      );
      const logData = await axios.get(sess.data.logplex_url);
      const logs = logData.data.trim().slice(-4000);
      return bot.sendMessage(cid,
        `📜 Logs for "${payload}":\n\`\`\`\n${logs}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return bot.sendMessage(cid, `❌ Error fetching logs: ${e.message}`);
    }
  }

  // 🗑️ Delete (admin)
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `🗑️ "${payload}" deleted.`);
    } catch (e) {
      return bot.sendMessage(cid, `❌ Error deleting: ${e.message}`);
    }
  }

  // 🗑️ Delete (user)
  if (action === 'userdelete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      await deleteUserBot(cid, payload);
      return bot.sendMessage(cid, `🗑️ Your bot "${payload}" deleted.`);
    } catch (e) {
      return bot.sendMessage(cid, `❌ Error deleting: ${e.message}`);
    }
  }
});
