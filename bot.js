// Global error handlers
process.on('unhandledRejection', err => console.error('🛑 Unhandled Rejection:', err));
process.on('uncaughtException',  err => console.error('🛑 Uncaught Exception:', err));

require('dotenv').config();
const fs          = require('fs');
const path        = require('path');
const axios       = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');

// Load default env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json','utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k,v]) => [k, v.value])
  );
} catch {}

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

// Initialize bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// In-memory state
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds that used a key
const validKeys       = new Set(); // one-time deploy keys

// Helpers
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

// Include a "📋 Menu" button
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

// Admin: send Heroku app list
async function sendAppList(cid) {
  try {
    const res  = await axios.get('https://api.heroku.com/apps', {
      headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) return bot.sendMessage(cid,'📭 No apps found.');
    const rows = chunkArray(apps,3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(cid,
      `📦 Total Apps: ${apps.length}\nTap an app to manage:`,
      { reply_markup:{ inline_keyboard: rows } }
    );
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
}

bot.on('polling_error', console.error);

// /start handler with admin/user welcome
bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);

  const keyboard = { keyboard: buildKeyboard(isAdmin), resize_keyboard: true };

  if (isAdmin) {
    return bot.sendMessage(cid,
      '👑 Welcome back, Admin!\n\nYou have full control over all deployments and users.',
      keyboard
    );
  }

  return bot.sendMessage(cid,
    '🌟 Welcome to 𝖀𝖑𝖙-𝕬𝕽 BOT Deploy! 🌟\n\n' +
    'Effortlessly deploy and take full control of your WhatsApp bot 💀',
    keyboard
  );
});

// /menu command or Menu button
bot.onText(/^\/?menu$/i, (msg) => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /help command
bot.onText(/^\/?help$/i, (msg) => {
  const cid = msg.chat.id.toString();
  bot.sendMessage(cid,
    '🆘 Help Menu\n\n' +
    '• Type deploy to start deploying a bot\n' +
    '• Type my bots to view your deployed bots\n' +
    '• Type support to contact admin'
  );
});

// Admin: generate one-time key
bot.onText(/^\/?generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid,'❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: ${key}`);
});

// Admin: /apps command
bot.onText(/^\/?apps$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) sendAppList(cid);
});

// Main message handler
bot.on('message', async msg => {
  const cid       = msg.chat.id.toString();
  const rawText   = msg.text?.trim() || '';
  const textLower = rawText.toLowerCase();
  const isAdmin   = cid === ADMIN_ID;

  // Menu & Help shortcuts
  if (rawText === '📋 Menu' || textLower === 'menu') {
    return bot.emit('text', { chat:{id:cid}, text:'/menu' });
  }
  if (textLower === 'help') {
    return bot.emit('text', { chat:{id:cid}, text:'/help' });
  }

  // Support
  if (rawText === '🆘 Support' || textLower === 'support') {
    return bot.sendMessage(cid, `🆘 Contact Admin: ${SUPPORT_USERNAME}`);
  }

  // Get Session
  if (rawText === '🧾 Get Session' || textLower === 'get session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    await bot.sendPhoto(cid,'https://files.catbox.moe/an2cc1.jpeg');
    return bot.sendMessage(cid,
      '📝 Visit https://levanter-delta.vercel.app/, click Session, enter your session ID.\n\n' +
      'When ready, tap 🚀 Deploy.'
    );
  }

  // Deploy
  if (rawText === '🚀 Deploy' || textLower === 'deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid,'🔐 Please enter your one-time deploy key.');
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid,'📝 Please send your session ID:');
  }

  // My Bots
  if (rawText === '📦 My Bots' || textLower === 'my bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid,'📭 You haven’t deployed any bots yet.');
    const list = bots.map((b,i)=>`${i+1}. ${b}`).join('\n');
    return bot.sendMessage(cid, `🤖 Your deployed bots:\n\n${list}`);
  }

  // Stateful flows
  const state = userStates[cid];
  if (!state) return;

  // 1) Await key
  if (state.step === 'AWAITING_KEY') {
    const key = rawText.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step:'SESSION_ID', data:{} };
      await bot.sendMessage(ADMIN_ID, `🔐 Key used by: ${cid}`);
      return bot.sendMessage(cid,'✅ Key accepted! Send your session ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid or expired key.');
  }

  // 2) Got SESSION_ID → APP_NAME
  if (state.step === 'SESSION_ID') {
    if (rawText.length < 5) {
      return bot.sendMessage(cid,'⚠️ Session ID must be at least 5 characters.');
    }
    state.data.SESSION_ID = rawText;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid,'📝 What name would you like for your bot?');
  }

  // 3) Got APP_NAME → AUTO_STATUS_VIEW
  if (state.step === 'APP_NAME') {
    const nm = rawText.toLowerCase().replace(/\s+/g,'-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid,'⚠️ Name must be ≥5 characters: lowercase, numbers, or hyphens.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `❌ ${nm} is already taken. Choose another.`);
    } catch(e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = nm;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW → deploy + record
  if (state.step === 'AUTO_STATUS_VIEW') {
    const v = textLower;
    if (v !== 'true' && v !== 'false') {
      return bot.sendMessage(cid,'⚠️ Please reply with "true" or "false".');
    }
    state.data.AUTO_STATUS_VIEW = v === 'true' ? 'no-dl' : 'false';

    await bot.sendMessage(cid,'📦 Build queued...');
    await deployToHeroku(cid, state.data);
    await addUserBot(cid, state.data.APP_NAME, state.data.SESSION_ID);
    delete userStates[cid];
    return;
  }
});

// Callback handler
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const [action,payload] = query.data.split(':');
  await bot.answerCallbackQuery(query.id);

  // Admin: select app
  if (action === 'selectapp') {
    const name = payload;
    return bot.sendMessage(cid,
      `🔧 Admin actions for "${name}":`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'ℹ️ Info',    callback_data:`info:${name}` },
          { text:'📜 Logs',    callback_data:`logs:${name}` }
        ],
        [
          { text:'🗑️ Delete', callback_data:`delete:${name}` },
          { text:'⚙️ SetVar',  callback_data:`setvar:${name}` }
        ]
      ]}
    });
  }

  // User: select bot
  if (action === 'selectbot') {
    const name = payload;
    return bot.sendMessage(cid,
      `🔧 What would you like to do with "${name}"?`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'🔄 Restart', callback_data:`restart:${name}` },
          { text:'📜 Logs',    callback_data:`logs:${name}` }
        ],
        [
          { text:'🗑️ Delete', callback_data:`userdelete:${name}` },
          { text:'⚙️ SetVar',  callback_data:`setvar:${name}` }
        ]
      ]}
    });
  }

  // ... handle restart, logs, delete, info, setvar, varselect, setvarbool as before
});

// Deploy helper
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  // Create app
  await axios.post('https://api.heroku.com/apps',{ name:appName },{
    headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
  });
  // Buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    { updates:[
      { buildpack:'https://github.com/heroku/heroku-buildpack-apt' },
      { buildpack:'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
      { buildpack:'heroku/nodejs' }
    ]},
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  // Config vars
  const cfg = {
    ...defaultEnvVars,
    SESSION_ID:       vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    cfg,
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  // Build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` }},
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  let status = bres.data.status;
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let attempts = 0;
  while (status === 'pending' && attempts < 20) {
    await new Promise(res => setTimeout(res,5000));
    const poll = await axios.get(statusUrl,{
      headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
    });
    status = poll.data.status; attempts++;
  }
  if (status === 'succeeded') {
    bot.sendMessage(chatId,
      `✅ Deployed! https://${appName}.herokuapp.com`
    );
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}.`);
  }
}
