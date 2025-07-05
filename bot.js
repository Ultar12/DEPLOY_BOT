// bot.js

// Global error handlers
process.on('unhandledRejection', err =>
  console.error('🛑 Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('🛑 Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// Load defaults from app.json (Heroku fallback)
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

// Postgres pool & auto-create table
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id    TEXT NOT NULL,
      bot_name   TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ user_bots table is ready');
})().catch(console.error);

// DB helpers
async function addUserBot(u, b, s) {
  await pool.query(
    'INSERT INTO user_bots(user_id,bot_name,session_id) VALUES($1,$2,$3)',
    [u, b, s]
  );
}
async function getUserBots(u) {
  const r = await pool.query(
    'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
    [u]
  );
  return r.rows.map(x => x.bot_name);
}
async function deleteUserBot(u, b) {
  await pool.query(
    'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
    [u, b]
  );
}
async function updateUserSession(u, b, s) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [s, u, b]
  );
}

// Initialize bot & state
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

// Send Heroku apps list with count
async function sendAppList(cid) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) return bot.sendMessage(cid, '📭 No apps found.');
    const rows = chunkArray(apps, 3).map(r =>
      r.map(name => ({ text:name, callback_data:`selectapp:${name}` }))
    );
    await bot.sendMessage(cid,
      `📦 Total Apps: ${apps.length}\n\nTap an app to manage:`,
      { reply_markup:{ inline_keyboard: rows } }
    );
  } catch (e) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${e.message}`);
  }
}

// Build & deploy with progress & Postgres add-on
async function buildWithProgress(chatId, vars) {
  const appName = vars.APP_NAME;

  // 1. Create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  // 2. Provision Postgres
  await axios.post(
    `https://api.heroku.com/apps/${appName}/addons`,
    { plan:'heroku-postgresql' },
    { headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
    }}
  );

  // 3. Buildpacks
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

  // 4. Config vars
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    {
      SESSION_ID: vars.SESSION_ID,
      AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
      ...defaultEnvVars
    },
    { headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
    }}
  );

  // 5. Start build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` }},
    { headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
    }}
  );

  // 6. Progress animation
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let status = 'pending';
  const progMsg = await bot.sendMessage(chatId, '⏳ Building... 0%');

  for (let i = 1; i <= 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const poll = await axios.get(statusUrl, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      status = poll.data.status;
    } catch { break; }
    const pct = Math.min(100, i * 5);
    await bot.editMessageText(`⏳ Building... ${pct}%`, {
      chat_id: chatId, message_id: progMsg.message_id
    });
    if (status !== 'pending') break;
  }

  if (status === 'succeeded') {
    await bot.editMessageText(
      `✅ Build complete! Live at https://${appName}.herokuapp.com`,
      { chat_id: chatId, message_id: progMsg.message_id }
    );
  } else {
    await bot.editMessageText(
      `❌ Build ${status}. Check your Heroku dashboard.`,
      { chat_id: chatId, message_id: progMsg.message_id }
    );
  }
}

// Polling errors
bot.on('polling_error', console.error);

// /start
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);

  // Log user info
  const { first_name, last_name, username } = msg.from;
  const fullName = [first_name, last_name].filter(Boolean).join(' ');
  console.log(`👤 User started: ${fullName} (@${username||'N/A'}) [${cid}]`);

  const welcome = isAdmin
    ? '👑 Welcome back, Admin!\nYou manage deployments & users.'
    : '🌟 Welcome to BOT Deploy! Effortlessly deploy your WhatsApp bot 💀';

  await bot.sendMessage(cid, welcome, {
    reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true }
  });
});

// /menu
bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid,'📲 Choose an option:',{
    reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true }
  });
});

// Admin: generate key
bot.onText(/^\/generate$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid,'❌ Only admin.');
  const key = generateKey(); validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode:'Markdown' });
});

// Admin: /apps
bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) sendAppList(cid);
});

// Main message handler
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const raw = msg.text?.trim()||'';
  const lc  = raw.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // Admin buttons
  if (raw==='📦 Apps' && isAdmin) return sendAppList(cid);
  if (raw==='🔐 Generate Key' && isAdmin) {
    const key = generateKey(); validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode:'Markdown' });
  }

  // Support
  if (raw==='🆘 Support' || lc==='support') {
    return bot.sendMessage(cid, `🆘 Contact Admin: ${SUPPORT_USERNAME}`);
  }

  // Get Session
  if (raw==='🧾 Get Session' || lc==='get session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    try {
      await bot.sendPhoto(cid,'https://files.catbox.moe/an2cc1.jpeg',{ 
        caption:`🧾 *How to Get Your Session ID:*\n\n`+
                `1. Tap the link\n2. Click *Session*\n3. Enter your custom ID\n\n`+
                `🔗 https://levanter-delta.vercel.app/`, parse_mode:'Markdown' 
      });
    } catch {
      bot.sendMessage(cid,'⚠️ Visit:\nhttps://levanter-delta.vercel.app/');
    }
    return bot.sendMessage(cid,
      `💡 *Note:*\n• iPhone use Chrome\n• Skip ads\n• Custom ID auto-starts\n\n`+
      `When ready, tap 🚀 Deploy.`,
      { parse_mode:'Markdown' }
    );
  }

  // Deploy
  if (raw==='🚀 Deploy' || lc==='deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid]={step:'AWAITING_KEY',data:{}};
      return bot.sendMessage(cid,'🔐 Enter your one-time key.');
    }
    userStates[cid]={step:'SESSION_ID',data:{}};
    return bot.sendMessage(cid,'📝 Send your SESSION_ID:');
  }

  // My Bots
  if (raw==='📦 My Bots' || lc==='my bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid,'📭 No bots deployed.');
    const rows = chunkArray(bots,3).map(r=>r.map(n=>({
      text:n, callback_data:`selectbot:${n}`
    })));
    return bot.sendMessage(cid,'🤖 Your bots:',{
      reply_markup:{ inline_keyboard:rows }
    });
  }

  // Stateful flows
  const st = userStates[cid];
  if (!st) return;

  // 1) Await key
  if (st.step==='AWAITING_KEY') {
    const key = raw.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid]={step:'SESSION_ID',data:{}};

      // Notify admin
      const { first_name, last_name, username } = msg.from;
      const fullName = [first_name, last_name].filter(Boolean).join(' ');
      await bot.sendMessage(ADMIN_ID,
        `🔐 *Key Used!*\n\n`+
        `👤 Name: ${fullName}\n`+
        `🆔 ID: \`${cid}\`\n`+
        `📛 Username: @${username||'N/A'}`,
        { parse_mode:'Markdown' }
      );
      return bot.sendMessage(cid,'✅ Key accepted! Send SESSION_ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid key.');
  }

  // 2) Got SESSION_ID
  if (st.step==='SESSION_ID') {
    if (raw.length<5) return bot.sendMessage(cid,'⚠️ SESSION_ID ≥5 chars.');
    st.data.SESSION_ID = raw; st.step='APP_NAME';
    return bot.sendMessage(cid,'📝 Bot name?');
  }

  // 3) Got APP_NAME
  if (st.step==='APP_NAME') {
    const nm = raw.toLowerCase().replace(/\s+/g,'-');
    if (nm.length<5||!/^[a-z0-9-]+$/.test(nm)){
      return bot.sendMessage(cid,'⚠️ Invalid name.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`,{
        headers:{Authorization:`Bearer ${HEROKU_API_KEY}`,Accept:'application/vnd.heroku+json; version=3'}
      });
      return bot.sendMessage(cid,`❌ "${nm}" taken.`);
    } catch(e){
      if (e.response?.status===404) {
        st.data.APP_NAME=nm; st.step='AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW
  if (st.step==='AUTO_STATUS_VIEW') {
    if (lc!=='true'&&lc!=='false'){
      return bot.sendMessage(cid,'⚠️ Reply true or false.');
    }
    st.data.AUTO_STATUS_VIEW = lc==='true'?'no-dl':'false';
    await buildWithProgress(cid, st.data);
    await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
    delete userStates[cid];
    return;
  }

  // 5) SETVAR text fallback
  if (st.step==='SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = st.data;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: raw },
        { headers:{
            Authorization:`Bearer ${HEROKU_API_KEY}`,
            Accept:'application/vnd.heroku+json; version=3',
            'Content-Type':'application/json'
          }}
      );
      if (VAR_NAME==='SESSION_ID') {
        await updateUserSession(cid, APP_NAME, raw);
      }
      await bot.sendMessage(cid,
        `✅ Updated *${VAR_NAME}* to:\n\`\`\`\n${raw}\n\`\`\``,
        { parse_mode:'Markdown' }
      );
    } catch (e) {
      await bot.sendMessage(cid, `❌ Update failed: ${e.message}`);
    }
    delete userStates[cid];
    return;
  }
});

// Callback handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // Admin submenu
  if (action==='selectapp') {
    return bot.sendMessage(cid,
      `🔧 Admin actions for "${payload}":`,{
      reply_markup:{ inline_keyboard:[
        [
          {text:'🔄 Restart', callback_data:`restart:${payload}`},
          {text:'📜 Logs',    callback_data:`logs:${payload}`}
        ],
        [
          {text:'🗑️ Delete', callback_data:`delete:${payload}`},
          {text:'⚙️ SetVar',  callback_data:`setvar:${payload}`}
        ]
      ]}
    });
  }

  // User submenu
  if (action==='selectbot') {
    return bot.sendMessage(cid,
      `🔧 What to do with "${payload}"?`,{
      reply_markup:{ inline_keyboard:[
        [
          {text:'🔄 Restart', callback_data:`restart:${payload}`},
          {text:'📜 Logs',    callback_data:`logs:${payload}`}
        ],
        [
          {text:'🗑️ Delete', callback_data:`userdelete:${payload}`},
          {text:'⚙️ SetVar',  callback_data:`setvar:${payload}`}
        ]
      ]}
    });
  }

  // Restart
  if (action==='restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`,{
        headers:{Authorization:`Bearer ${HEROKU_API_KEY}`,Accept:'application/vnd.heroku+json; version=3'}
      });
      return bot.sendMessage(cid,`✅ "${payload}" restarted.`);
    } catch(e){
      return bot.sendMessage(cid,`❌ Restart failed: ${e.message}`);
    }
  }

  // Logs (fetch & send as code block)
  if (action==='logs') {
    try {
      const sess = await axios.post(
        `https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail:false, lines:100 },
        { headers:{
            Authorization:`Bearer ${HEROKU_API_KEY}`,
            Accept:'application/vnd.heroku+json; version=3',
            'Content-Type':'application/json'
          }}
      );
      const logUrl = sess.data.logplex_url;
      const lr = await axios.get(logUrl);
      const logs = lr.data.trim().slice(-4000);
      return bot.sendMessage(cid,
        `📜 Logs for *${payload}*:\n\`\`\`\n${logs}\n\`\`\``,
        { parse_mode:'Markdown' }
      );
    } catch(e){
      return bot.sendMessage(cid,`❌ Logs failed: ${e.message}`);
    }
  }

  // Delete (admin)
  if (action==='delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`,{
        headers:{Authorization:`Bearer ${HEROKU_API_KEY}`,Accept:'application/vnd.heroku+json; version=3'}
      });
      return bot.sendMessage(cid,`🗑️ "${payload}" deleted.`);
    } catch(e){
      return bot.sendMessage(cid,`❌ Delete failed: ${e.message}`);
    }
  }

  // Delete (user)
  if (action==='userdelete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`,{
        headers:{Authorization:`Bearer ${HEROKU_API_KEY}`,Accept:'application/vnd.heroku+json; version=3'}
      });
      await deleteUserBot(cid,payload);
      return bot.sendMessage(cid,`🗑️ Your bot "${payload}" deleted.`);
    } catch(e){
      return bot.sendMessage(cid,`❌ Delete failed: ${e.message}`);
    }
  }

  // SetVar menu
  if (action==='setvar') {
    return bot.sendMessage(cid,
      `⚙️ Choose variable for "${payload}":`,{
      reply_markup:{ inline_keyboard:[
        [
          {text:'SESSION_ID', callback_data:`varselect:SESSION_ID:${payload}`},
          {text:'AUTO_STATUS_VIEW', callback_data:`varselect:AUTO_STATUS_VIEW:${payload}`}
        ],
        [
          {text:'ALWAYS_ONLINE', callback_data:`varselect:ALWAYS_ONLINE:${payload}`},
          {text:'PREFIX', callback_data:`varselect:PREFIX:${payload}`}
        ]
      ]}
    });
  }

  // Variable selected
  if (action==='varselect') {
    const varKey = payload, appName = extra;
    if (['AUTO_STATUS_VIEW','ALWAYS_ONLINE'].includes(varKey)) {
      return bot.sendMessage(cid,`Set *${varKey}* to:`,{
        parse_mode:'Markdown',
        reply_markup:{ inline_keyboard:[[
          {text:'true',callback_data:`setvarbool:${varKey}:${appName}:true`},
          {text:'false',callback_data:`setvarbool:${varKey}:${appName}:false`}
        ]]}
      });
    }
    // Text fallback (SESSION_ID, PREFIX, etc.)
    userStates[cid] = {
      step: 'SETVAR_ENTER_VALUE',
      data: { APP_NAME: appName, VAR_NAME: varKey }
    };
    return bot.sendMessage(cid,
      `Please send new value for *${varKey}*:`,
      { parse_mode:'Markdown' }
    );
  }

  // Boolean var update
  if (action==='setvarbool') {
    const varKey = payload, appName = extra, flagVal = flag;
    const newVal = flagVal==='true'
      ? (varKey==='AUTO_STATUS_VIEW'?'no-dl':'true')
      : 'false';
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers:{
            Authorization:`Bearer ${HEROKU_API_KEY}`,
            Accept:'application/vnd.heroku+json; version=3',
            'Content-Type':'application/json'
          }}
      );
      if (varKey==='SESSION_ID') {
        await updateUserSession(cid, appName, newVal);
      }
      return bot.sendMessage(cid,
        `✅ Updated *${varKey}* to \`${newVal}\` for *${appName}*`,
        { parse_mode:'Markdown' }
      );
    } catch(e){
      return bot.sendMessage(cid,`❌ Update failed: ${e.message}`);
    }
  }
});
