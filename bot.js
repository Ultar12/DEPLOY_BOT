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

// 2) Load defaults from app.json
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
  GITHUB_REPO_URL,    // e.g. https://github.com/ultar1/lev
  ADMIN_ID,           // e.g. "123456789"
  DATABASE_URL        // your PostgreSQL URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// 4) PostgreSQL setup & tables
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id TEXT NOT NULL,
      bot_name TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
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

// 5) DB helpers
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
  if (res.rowCount === 0) return null;
  const left = res.rows[0].uses_left;
  if (left === 0) {
    await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]);
  }
  return left;
}

// 6) Initialize bot & state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {};        // chatId -> { step, data }
const authorizedUsers = new Set();

// 7) Utilities
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
      inline_keyboard: [
        [1,2,3,4,5].map(n => ({
          text: String(n),
          callback_data: `keyusage:${n}`
        }))
      ]
    }
  };
}

// 8) Build & deploy with progress
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

  // 3) Buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${name}/buildpack-installations`,
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

  // 4) Config vars
  await axios.patch(
    `https://api.heroku.com/apps/${name}/config-vars`,
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

  // 5) Trigger build
  let bres;
  try {
    bres = await axios.post(
      `https://api.heroku.com/apps/${name}/builds`,
      { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` } },
      { headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3',
          'Content-Type':'application/json'
      }}
    );
  } catch (err) {
    console.error('Build failed:', err.response?.data || err.message);
    throw new Error('Heroku build failed. Check repo URL, Procfile, config-vars.');
  }

  // 6) Animate
  const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
  let status = 'pending';
  const progMsg = await bot.sendMessage(chatId, '🛠️ Building... 0%');
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
    } catch {
      break;
    }
    const pct = Math.min(100, i * 5);
    await bot.editMessageText(`🛠️ Building... ${pct}%`, {
      chat_id: chatId, message_id: progMsg.message_id
    });
    if (status !== 'pending') break;
  }

  // 7) Finish
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
  userStates[cid] = null;
  bot.sendMessage(cid,
    isAdmin ? '👑 Admin Menu:' : '🤖 User Menu:',
    { reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true } }
  );
});

// 10) Main message handler
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;
  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;
  const st = userStates[cid];

  // 🚀 Deploy
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid, '🔐 Enter your deploy key:');
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid, '🧾 Enter your session ID:');
  }

  // 🔐 Generate Key
  if (text === '🔐 Generate Key' && isAdmin) {
    userStates[cid] = { step:'SELECT_KEY_USAGE' };
    return bot.sendMessage(cid,
      'Choose key usage count:',
      buildUsageInlineKeyboard()
    );
  }

  // 📦 Apps (admin)
  if (text === '📦 Apps' && isAdmin) {
    try {
      const res = await axios.get('https://api.heroku.com/apps', {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      const apps = res.data.map(a => a.name);
      if (!apps.length) return bot.sendMessage(cid, '📭 No apps found.');
      const rows = chunkArray(apps,3).map(r=>
        r.map(n=>({ text:n, callback_data:`selectapp:${n}` }))
      );
      return bot.sendMessage(cid,
        `📦 Total Apps: ${apps.length}\n\nTap an app:`,
        { reply_markup:{ inline_keyboard: rows } }
      );
    } catch(e){
      return bot.sendMessage(cid, `❌ Could not fetch apps: ${e.message}`);
    }
  }

  // 🧾 Get Session
  if (text === '🧾 Get Session') {
  userStates[cid] = { step: 'SESSION_ID', data: {} };

  await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
    caption:
      '📸 *How to get your Session ID:*\n\n' +
      '1. Visit [Levanter Session Tool](https://levanter-delta.vercel.app/)\n' +
      '2. Click the *"Session"* tab on the left\n' +
      '3. Enter a custom session ID (e.g. your name, no spaces)\n' +
      '4. Click *"Submit"* and continue with the rest\n\n' +
      'Once you have it, tap "🚀 Deploy" to continue.',
    parse_mode: 'Markdown'
  });

  return bot.sendMessage(cid,
    '💡 *Note:*\n' +
    '• Make use of Chrome — especially iPhone users\n' +
    '• Skip ads and continue\n' +
    '• Use a *Custom Session ID* for auto-start when rescanned (Make sure to use same name)',
    { parse_mode: 'Markdown' }
  );
}
  // 📦 My Bots
  if (text === '📦 My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, '📭 You have no bots.');
    const rows = chunkArray(bots,3).map(r=>
      r.map(n=>({ text:n, callback_data:`selectbot:${n}` }))
    );
    return bot.sendMessage(cid,
      `📦 Your Bots:\nTap to manage:`,
      { reply_markup:{ inline_keyboard: rows } }
    );
  }

  // 🆘 Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `Need help? Contact admin:\n${SUPPORT_USERNAME}`);
  }

  // 🔐 Awaiting Key
  if (st?.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    const left = await useDeployKey(key);
    if (left === null) {
      return bot.sendMessage(cid, '❌ Invalid or expired key.');
    }
    authorizedUsers.add(cid);
    userStates[cid] = { step:'SESSION_ID', data:{} };
    await bot.sendMessage(ADMIN_ID,
      `🔑 Key "${key}" used by ${cid}. Uses left: ${left}`
    );
    return bot.sendMessage(cid, '✅ Key accepted! Enter your session ID:');
  }

  // 🧾 Session ID
  if (st?.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid, '❌ Session ID must be ≥5 chars.');
    }
    st.data.SESSION_ID = text;
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, '📛 Enter your bot name (min 5 chars):');
  }

  // 📛 App Name
  if (st?.step === 'APP_NAME') {
    const name = text.toLowerCase().replace(/\s+/g,'-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(cid,
        '❌ Invalid name. Use lowercase, numbers, hyphens.'
      );
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `❌ "${name}" is taken.`);
    } catch(e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = name;
        st.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,
          'Enable automatic status view? Reply "true" or "false".'
        );
      }
      console.error(e);
      return bot.sendMessage(cid, '❌ Error checking name.');
    }
  }

  // ⚙️ AUTO_STATUS_VIEW → Deploy
  if (st?.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, '❌ Reply "true" or "false".');
    }
    st.data.AUTO_STATUS_VIEW = lc==='true'?'no-dl':'false';
    try {
      await bot.sendMessage(cid, '🚀 Starting deployment...');
      await buildWithProgress(cid, st.data);
      await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
      await bot.sendMessage(cid,
        `🎉 Bot "${st.data.APP_NAME}" deployed!`
      );
    } catch(err) {
      console.error(err);
      await bot.sendMessage(cid,
        `⚠️ Deployment failed: ${err.message}`
      );
    }
    delete userStates[cid];
  }
});

// 11) Inline callback handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // Key usage selection
  if (action === 'keyusage') {
    const uses = parseInt(payload,10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    userStates[cid] = null;
    return bot.sendMessage(cid,
      `🔑 Key: \`${key}\`\n🔁 Uses: ${uses}`,
      { parse_mode:'Markdown' }
    );
  }

  // Admin: select app
  if (action === 'selectapp') {
    const name = payload;
    return bot.sendMessage(cid, `Manage "${name}":`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'Info',    callback_data:`info:${name}` },
          { text:'Restart', callback_data:`restart:${name}` },
          { text:'Logs',    callback_data:`logs:${name}` }
        ],
        [
          { text:'Delete',  callback_data:`delete:${name}` }
        ]
      ] }
    });
  }

  // User: select bot
  if (action === 'selectbot') {
    const name = payload;
    return bot.sendMessage(cid, `Manage your bot "${name}":`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'Info',    callback_data:`info:${name}` },
          { text:'Restart', callback_data:`restart:${name}` },
          { text:'Logs',    callback_data:`logs:${name}` }
        ],
        [
          { text:'Delete',  callback_data:`userdelete:${name}` }
        ]
      ] }
    });
  }

  // Info
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${payload}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      const { name, web_url, stack, region, created_at } = res.data;
      const age = Math.floor((Date.now() - new Date(created_at)) / (1000*60*60*24));
      return bot.sendMessage(cid,
        `📦 Info:\n`+
        `• Name: ${name}\n`+
        `• URL: ${web_url}\n`+
        `• Stack: ${stack}\n`+
        `• Region: ${region?.name||'unknown'}\n`+
        `• Created: ${new Date(created_at).toDateString()}\n`+
        `• Age: ${age} day${age===1?'':'s'}`
      );
    } catch(e) {
      return bot.sendMessage(cid, `❌ Error: ${e.message}`);
    }
  }

  // Restart
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `🔄 "${payload}" restarted.`);
    } catch(e) {
      return bot.sendMessage(cid, `❌ Error: ${e.message}`);
    }
  }

  // Logs
  if (action === 'logs') {
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
      const logData = await axios.get(sess.data.logplex_url);
      const logs = logData.data.trim().slice(-4000);
      return bot.sendMessage(cid,
        `📜 Logs:\n\`\`\`\n${logs}\n\`\`\``,
        { parse_mode:'Markdown' }
      );
    } catch(e) {
      return bot.sendMessage(cid, `❌ Error: ${e.message}`);
    }
  }

  // Delete (admin)
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `🗑️ "${payload}" deleted.`);
    } catch(e) {
      return bot.sendMessage(cid, `❌ Error: ${e.message}`);
    }
  }

  // Delete (user)
  if (action === 'userdelete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      await deleteUserBot(cid, payload);
      return bot.sendMessage(cid, `🗑️ Your bot "${payload}" deleted.`);
    } catch(e) {
      return bot.sendMessage(cid, `❌ Error: ${e.message}`);
    }
  }
 // SetVar menu
if (action === 'setvar') {
  return bot.sendMessage(cid, `Set variable for "${p}":`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'SESSIONID', callback_data: `varselect:SESSION_ID:${p}` },
          { text: 'AUTOSTATUSVIEW', callback_data: `varselect:AUTOSTATUS_VIEW:${p}` }
        ],
        [
          { text: 'ALWAYSONLINE', callback_data: `varselect:ALWAYS_ONLINE:${p}` },
          { text: 'PREFIX', callback_data: `varselect:PREFIX:${p}` }
        ],
        [
          { text: 'ANTIDELETE', callback_data: `varselect:ANTI_DELETE:${p}` }
        ]
      ]
    }
  });
}

// varselect
if (action === 'varselect') {
  const varKey = p, appName = extra;
  if (['AUTOSTATUSVIEW', 'ALWAYSONLINE', 'ANTIDELETE'].includes(varKey)) {
    return bot.sendMessage(cid, `Set ${varKey} to:`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
          { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
        ]]
      }
    });
  }
  userStates[cid] = { step: 'SETVARENTERVALUE', data: { APPNAME: appName, VARNAME: varKey } };
  return bot.sendMessage(cid, `Enter new value for ${varKey}:`);
}

// setvarbool
if (action === 'setvarbool') {
  const varKey = p, appName = extra, flagVal = flag === 'true';
  let newVal;
  if (varKey === 'AUTOSTATUSVIEW') newVal = flagVal ? 'no-dl' : 'false';
  else if (varKey === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
  else newVal = flagVal ? 'true' : 'false';

  try {
    await axios.patch(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      { [varKey]: newVal },
      {
        headers: {
          Authorization: `Bearer ${HEROKUAPIKEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    if (varKey === 'SESSION_ID') {
      await updateUserSession(cid, appName, newVal);
    }

    return bot.sendMessage(cid, `${varKey} updated to ${newVal}`);
  } catch (e) {
    return bot.sendMessage(cid, `Error: ${e.message}`);
  }
});
