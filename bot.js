// bot.js

require('dotenv').config();
const axios       = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');

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
async function ensureTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bots (
        user_id    TEXT NOT NULL,
        bot_name   TEXT NOT NULL,
        session_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ user_bots table ready');
  } catch (err) {
    console.error('❌ Table creation failed:', err);
  }
}
ensureTable();

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
async function updateUserSession(userId, botName, sessionId) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [sessionId, userId, botName]
  );
}

// Init bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds with valid key
const validKeys       = new Set(); // one-time deploy keys

// Utils
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
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Error logging
bot.on('polling_error', console.error);

// /start
bot.onText(/^\/start$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);
  const welcome = isAdmin
    ? '👑 Welcome back, Admin!\nYou control deployments & users.'
    : '🌟 Welcome to 𝖀𝖑𝖙-𝕬𝕽 BOT Deploy! 🌟\nEffortlessly deploy & manage your WhatsApp bot 💀';
  bot.sendMessage(cid, welcome, {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /menu alias
bot.onText(/^\/menu$/i, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /generate (admin)
bot.onText(/^\/generate$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid,'❌ Only admin.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
});

// /apps (admin)
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
    if (!apps.length) return bot.sendMessage(cid, '📭 No apps.');
    const rows = chunk(apps, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    bot.sendMessage(cid, '📦 Your Heroku Apps:', {
      reply_markup: { inline_keyboard: rows }
    });
  } catch (err) {
    bot.sendMessage(cid, `❌ Fetch error: ${err.message}`);
  }
});

// message handler
bot.on('message', async msg => {
  const cid       = msg.chat.id.toString();
  const text      = msg.text?.trim() || '';
  const lc        = text.toLowerCase();
  const isAdmin   = cid === ADMIN_ID;

  // Generate Key button
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
  }

  // Apps button
  if (text === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat:{id:cid}, text:'/apps' });
  }

  // Support
  if (text === '🆘 Support' || lc === 'support') {
    return bot.sendMessage(cid, `🆘 Contact Admin: ${SUPPORT_USERNAME}`);
  }

  // Get Session
  if (text === '🧾 Get Session' || lc === 'get session') {
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: `🧾 *How to get your Session ID:*\n\n` +
                 `1. Open the link below\n` +
                 `2. Click *Session* in the sidebar\n` +
                 `3. Enter your custom ID\n\n` +
                 `🔗 https://levanter-delta.vercel.app/`,
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, '⚠️ Visit:\nhttps://levanter-delta.vercel.app/');
    }
    return bot.sendMessage(cid,
      `💡 *Note:*\n• On iPhone use Chrome\n• Skip any ads\n• Custom ID auto-starts\n\n` +
      `When ready, tap 🚀 Deploy.`,
      { parse_mode: 'Markdown' }
    );
  }

  // Deploy
  if (text === '🚀 Deploy' || lc === 'deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid,'🔐 Enter your one-time deploy key.');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid,'📝 Please send your SESSION_ID:');
  }

  // My Bots
  if (text === '📦 My Bots' || lc === 'my bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid,'📭 No bots deployed.');
    const rows = chunk(bots, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectbot:${name}` }))
    );
    return bot.sendMessage(cid, '🤖 Your bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // State machine
  const state = userStates[cid];
  if (!state) return;

  // 1) Awaiting deploy key
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step: 'SESSION_ID', data: {} };
      bot.sendMessage(ADMIN_ID, `🔐 Key used by ${cid}`);
      return bot.sendMessage(cid,'✅ Key accepted! Send your SESSION_ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid key.');
  }

  // 2) Got SESSION_ID
  if (state.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid,'⚠️ SESSION_ID must be ≥5 chars.');
    }
    state.data.SESSION_ID = text;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid,'📝 What name for your bot?');
  }

  // 3) Got APP_NAME
  if (state.step === 'APP_NAME') {
    const name = text.toLowerCase().replace(/\s+/g,'-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(cid,'⚠️ Name invalid.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `❌ ${name} taken.`);
    } catch (e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = name;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW → deploy & record
  if (state.step === 'AUTO_STATUS_VIEW') {
    const v = lc;
    if (v !== 'true' && v !== 'false') {
      return bot.sendMessage(cid,'⚠️ Reply true or false.');
    }
    state.data.AUTO_STATUS_VIEW = v === 'true' ? 'no-dl' : 'false';
    bot.sendMessage(cid,'📦 Build queued...');
    await deployToHeroku(cid, state.data);
    await addUserBot(cid, state.data.APP_NAME, state.data.SESSION_ID);
    delete userStates[cid];
    return;
  }

  // 5) SETVAR text fallback
  if (state.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = state.data;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: text },
        { headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }}
      );
      bot.sendMessage(cid, `✅ Updated ${VAR_NAME} to \`${text}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(cid, `❌ Update failed: ${err.message}`);
    }
    delete userStates[cid];
    return;
  }
});

// Callback queries
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action,payload,varName,val] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // Admin: selectapp
  if (action === 'selectapp') {
    const name = payload;
    return bot.sendMessage(cid,
      `🔧 Admin actions for "${name}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text:'ℹ️ Info',    callback_data:`info:${name}` },
            { text:'📜 Logs',    callback_data:`logs:${name}` }
          ],
          [
            { text:'🗑️ Delete', callback_data:`delete:${name}` },
            { text:'⚙️ SetVar',  callback_data:`setvar:${name}` }
          ]
        ]
      }
    });
  }

  // User: selectbot
  if (action === 'selectbot') {
    const name = payload;
    return bot.sendMessage(cid,
      `🔧 What to do with "${name}"?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text:'🔄 Restart', callback_data:`restart:${name}` },
            { text:'📜 Logs',    callback_data:`logs:${name}` }
          ],
          [
            { text:'🗑️ Delete', callback_data:`userdelete:${name}` },
            { text:'⚙️ SetVar',  callback_data:`setvar:${name}` }
          ]
        ]
      }
    });
  }

  // SetVar menu
  if (action === 'setvar') {
    const name = payload;
    return bot.sendMessage(cid,
      `⚙️ Choose variable for "${name}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text:'SESSION_ID', callback_data:`varselect:SESSION_ID:${name}` },
            { text:'AUTO_STATUS_VIEW', callback_data:`varselect:AUTO_STATUS_VIEW:${name}` }
          ],
          [
            { text:'ALWAYS_ONLINE', callback_data:`varselect:ALWAYS_ONLINE:${name}` },
            { text:'PREFIX', callback_data:`varselect:PREFIX:${name}` }
          ]
        ]
      }
    });
  }

  // Variable selected
  if (action === 'varselect') {
    const varKey = payload;
    const name   = varName;
    if (['AUTO_STATUS_VIEW','ALWAYS_ONLINE'].includes(varKey)) {
      return bot.sendMessage(cid, `Set *${varKey}* to:`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text:'true',  callback_data:`setvarbool:${varKey}:${name}:true` },
            { text:'false', callback_data:`setvarbool:${varKey}:${name}:false` }
          ]]
        }
      });
    }
    userStates[cid] = {
      step:'SETVAR_ENTER_VALUE',
      data:{ APP_NAME:name, VAR_NAME:varKey }
    };
    return bot.sendMessage(cid, `Please send new value for *${varKey}*:`, { parse_mode: 'Markdown' });
  }

  // Boolean var update
  if (action === 'setvarbool') {
    const varKey = payload;
    const name   = varName;
    const newVal = val === 'true'
      ? (varKey==='AUTO_STATUS_VIEW'?'no-dl':'true')
      : 'false';
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${name}/config-vars`,
        { [varKey]: newVal },
        { headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3',
          'Content-Type':'application/json'
        }}
      );
      if (varKey === 'SESSION_ID') {
        await updateUserSession(cid, name, newVal);
      }
      return bot.sendMessage(cid,
        `✅ Updated *${varKey}* to \`${newVal}\` for *${name}*`,
        { parse_mode:'Markdown' }
      );
    } catch (err) {
      return bot.sendMessage(cid, `❌ Update failed: ${err.message}`);
    }
  }

  // ... you can add handlers for restart, logs, delete, userdelete, info here
});

// Deploy helper with progress animation
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3'
    }
  });

  // buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    { updates:[
      { buildpack:'https://github.com/heroku/heroku-buildpack-apt' },
      { buildpack:'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
      { buildpack:'heroku/nodejs' }
    ]},
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );

  // config vars
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    {
      SESSION_ID: vars.SESSION_ID,
      AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW
    },
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );

  // start build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` }},
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );

  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let status = 'pending';
  const msg = await bot.sendMessage(chatId, '⏳ Building... 0%');

  for (let i = 1; i <= 20; i++) {
    await new Promise(res => setTimeout(res, 5000));
    try {
      const poll = await axios.get(statusUrl, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      status = poll.data.status;
    } catch {
      break;
    }
    const pct = Math.min(100, i * 5);
    await bot.editMessageText(`⏳ Building... ${pct}%`, {
      chat_id: chatId,
      message_id: msg.message_id
    });
    if (status !== 'pending') break;
  }

  if (status === 'succeeded') {
    await bot.editMessageText(`✅ Build complete! Live at https://${appName}.herokuapp.com`, {
      chat_id: chatId,
      message_id: msg.message_id
    });
  } else {
    await bot.editMessageText(`❌ Build ${status}. Check your Heroku dashboard.`, {
      chat_id: chatId,
      message_id: msg.message_id
    });
  }
}
