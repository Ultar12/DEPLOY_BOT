// Global error handlers
process.on('unhandledRejection', err => console.error('🛑 Unhandled Rejection:', err));
process.on('uncaughtException', err   => console.error('🛑 Uncaught Exception:', err));

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
  return Array.from({length:8})
    .map(() => chars[Math.floor(Math.random()*chars.length)])
    .join('');
}
function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['🚀 Deploy','📦 Apps'], ['🔐 Generate Key','🧾 Get Session'], ['🆘 Support']]
    : [['🧾 Get Session','🚀 Deploy'], ['📦 My Bots'], ['🆘 Support']];
}
function chunkArray(arr,size) {
  const out = [];
  for(let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size));
  return out;
}
async function sendAppList(cid) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a=>a.name);
    if(!apps.length) return bot.sendMessage(cid,'📭 No apps found.');
    const rows = chunkArray(apps,3).map(row=>
      row.map(name=>({ text:name, callback_data:`selectapp:${name}` }))
    );
    await bot.sendMessage(cid,
      `📦 Total Apps: ${apps.length}\nTap an app to manage:`,
      { reply_markup:{ inline_keyboard: rows } }
    );
  } catch(err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
}

// Polling errors
bot.on('polling_error', console.error);

// /start with new welcome
bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if(isAdmin) authorizedUsers.add(cid);

  const welcome =
    '🌟 Welcome to 𝖀𝖑𝖙-𝕬𝕽 BOT Deploy! 🌟\n\n' +
    'I’m here to help you deploy and manage your bots on Heroku.\n\n' +
    'Type menu to get started or help if you need assistance.';
  await bot.sendMessage(cid, welcome);
});

// /menu
bot.onText(/^\/menu$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true }
  });
});

// Admin: generate key
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if(cid !== ADMIN_ID) return bot.sendMessage(cid,'❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: ${key}`);
});

// Admin: /apps
bot.onText(/^\/apps$/, msg => {
  const cid = msg.chat.id.toString();
  if(cid === ADMIN_ID) sendAppList(cid);
});

// Main message handler
bot.on('message', async msg => {
  const cid     = msg.chat.id.toString();
  const text    = msg.text?.trim().toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // menu and help
  if(text === 'menu') {
    return bot.sendMessage(cid, '📲 Choose an option:', {
      reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true }
    });
  }
  if(text === 'help') {
    return bot.sendMessage(cid,
      '🆘 Help Menu\n\n' +
      '• Type deploy to start deploying a bot\n' +
      '• Type my bots to view your deployed bots\n' +
      '• Type support to contact admin'
    );
  }

  // Admin shortcuts
  if(text === '📦 apps' && isAdmin) return sendAppList(cid);
  if(text === '🔐 generate key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: ${key}`);
  }

  // Get Session
  if(text === '🧾 get session' || text === 'get session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg');
    return bot.sendMessage(cid,
      '📝 Go to https://levanter-delta.vercel.app/, click Session, enter your session ID.\n\n' +
      'When ready, type deploy.'
    );
  }

  // Deploy
  if(text === '🚀 deploy' || text === 'deploy') {
    if(!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid,
        '🔐 Enter your one-time deploy key or contact admin.'
      );
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid,'📝 Please send your session ID:');
  }

  // My Bots
  if(text === '📦 my bots' || text === 'my bots') {
    const bots = await getUserBots(cid);
    if(!bots.length) return bot.sendMessage(cid,'📭 No bots deployed yet.');
    const list = bots.map((b,i)=>`${i+1}. ${b}`).join('\n');
    return bot.sendMessage(cid, `🤖 Your bots:\n\n${list}`);
  }

  // Support
  if(text === '🆘 support' || text === 'support') {
    return bot.sendMessage(cid, `🆘 Contact Admin: ${SUPPORT_USERNAME}`);
  }

  // Stateful flows
  const state = userStates[cid];
  if(!state) return;

  // 1) Awaiting key
  if(state.step === 'AWAITING_KEY') {
    const key = msg.text.trim().toUpperCase();
    if(validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step:'SESSION_ID', data:{} };
      await bot.sendMessage(ADMIN_ID, `🔐 Key used by: ${cid}`);
      return bot.sendMessage(cid,'✅ Key accepted! Send session ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid key.');
  }

  // 2) Got session ID
  if(state.step === 'SESSION_ID') {
    const sid = msg.text.trim();
    if(sid.length < 5) return bot.sendMessage(cid,'⚠️ Session ID too short.');
    state.data.SESSION_ID = sid;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid,'📝 Send a name for your bot (lowercase, hyphens):');
  }

  // 3) Got app name
  if(state.step === 'APP_NAME') {
    const nm = msg.text.trim().toLowerCase().replace(/\s+/g,'-');
    if(nm.length<5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid,'⚠️ Name invalid.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `❌ ${nm} taken.`);
    } catch(e) {
      if(e.response?.status === 404) {
        state.data.APP_NAME = nm;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW & deploy
  if(state.step === 'AUTO_STATUS_VIEW') {
    const v = msg.text.trim().toLowerCase();
    if(v !== 'true' && v !== 'false') {
      return bot.sendMessage(cid,'⚠️ Reply true or false.');
    }
    const auto = v==='true'?'no-dl':'false';
    state.data.AUTO_STATUS_VIEW = auto;

    await bot.sendMessage(cid,'📦 Queued build...');
    await deployToHeroku(cid, state.data);
    await addUserBot(cid, state.data.APP_NAME, state.data.SESSION_ID);
    delete userStates[cid];
    return;
  }
});

// Callback handler omitted for brevity...

// Deploy helper
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  // create app
  await axios.post('https://api.heroku.com/apps',{ name:appName },{
    headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
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
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  // config vars
  const cfg = {
    ...defaultEnvVars,
    SESSION_ID: vars.SESSION_ID,
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
  // build
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
  let at = 0;
  while(status==='pending' && at<20) {
    await new Promise(r=>setTimeout(r,5000));
    const poll = await axios.get(statusUrl,{
      headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
    });
    status = poll.data.status; at++;
  }
  if(status==='succeeded') {
    bot.sendMessage(chatId,
      `✅ Deployed! https://${appName}.herokuapp.com`
    );
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}.`);
  }
}
