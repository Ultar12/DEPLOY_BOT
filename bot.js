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

// 3) Environment config
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,       // e.g. https://github.com/ultar1/lev
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// 4) Postgres setup & user_bots table
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
async function updateUserSession(userId, botName, sessionId) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [sessionId, userId, botName]
  );
}

// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds authorized to deploy
const validKeys       = new Set(); // in-memory one-time deploy keys

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

// 8) Build & deploy with progress animation
async function buildWithProgress(chatId, vars) {
  const name = vars.APP_NAME;

  // 1. Create app
  await axios.post('https://api.heroku.com/apps', { name }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  // 2. Provision Postgres
  await axios.post(
    `https://api.heroku.com/apps/${name}/addons`,
    { plan: 'heroku-postgresql:hobby-dev' },
    { headers:{
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );

  // 3. Install buildpacks
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

  // 4. Set config vars
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

  // 5. Trigger build
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
    console.error('Build request failed:', err.response?.data || err.message);
    throw new Error('Heroku build failed. Check repo URL, Procfile, or config-vars.');
  }

  // 6. Animate progress
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

  // 7. Final result
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

// 9) Polling error handler
bot.on('polling_error', console.error);

// 10) /start handler
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (isAdmin) authorizedUsers.add(cid);
  delete userStates[cid];
  bot.sendMessage(cid,
    isAdmin ? '👑 Admin Menu:' : '🤖 Bot Menu:',
    { reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true } }
  );
});

// 11) Command & message handler
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;
  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;
  const st = userStates[cid];

  // Deploy button
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid, '🔐 Enter your deploy key:');
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid, '🧾 Enter your session ID:');
  }

  // Apps button (admin)
  if (text === '📦 Apps' && isAdmin) {
    // list all Heroku apps
    try {
      const res = await axios.get('https://api.heroku.com/apps', {
        headers: {
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      const apps = res.data.map(a => a.name);
      if (!apps.length) return bot.sendMessage(cid, 'No apps.');
      const rows = chunkArray(apps,3).map(r=>r.map(n=>({
        text:n, callback_data:`selectapp:${n}`
      })));
      return bot.sendMessage(cid, 'Select an app:', {
        reply_markup:{ inline_keyboard: rows }
      });
    } catch(e){
      return bot.sendMessage(cid, `Error fetching apps: ${e.message}`);
    }
  }

  // Generate Key (admin)
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid,
      `✅ One-time key:\n\`${key}\``,
      { parse_mode:'Markdown' }
    );
  }

  // Get Session guide
  if (text === '🧾 Get Session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption:
          'How to get your session ID:\n\n' +
          '1. Open the link below\n' +
          '2. Click "Session" on the left\n' +
          '3. Enter a custom session ID (e.g. your name)\n\n' +
          `Link: https://levanter-delta.vercel.app/`,
        parse_mode:'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, 'Visit: https://levanter-delta.vercel.app/');
    }
    return bot.sendMessage(cid, 'Then tap "🚀 Deploy".');
  }

  // My Bots (user)
  if (text === '📦 My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, 'No bots deployed.');
    const rows = chunkArray(bots,3).map(r=>r.map(n=>({
      text:n, callback_data:`selectbot:${n}`
    })));
    return bot.sendMessage(cid, 'Your bots:', {
      reply_markup:{ inline_keyboard: rows }
    });
  }

  // Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `Need help? Contact admin:\n${SUPPORT_USERNAME}`);
  }

  // Awaiting deploy key
  if (st?.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (!validKeys.has(key)) {
      return bot.sendMessage(cid, '❌ Invalid or expired key.');
    }
    validKeys.delete(key);
    authorizedUsers.add(cid);
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid, '✅ Key accepted. Enter your session ID:');
  }

  // Session ID
  if (st?.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid, '❌ Session ID must be at least 5 characters.');
    }
    st.data.SESSION_ID = text;
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, '📛 Enter a name for your bot:');
  }

  // App Name
  if (st?.step === 'APP_NAME') {
    const name = text.toLowerCase().replace(/\s+/g,'-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(cid,
        '❌ Invalid name. Use lowercase, numbers or hyphens (min 5 chars).'
      );
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `Name "${name}" is taken.`);
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = name;
        st.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid, 'Enable AUTO_STATUS_VIEW? (true/false)');
      }
      console.error('Name check error:', e);
      return bot.sendMessage(cid, 'Error checking name.');
    }
  }

  // AUTO_STATUS_VIEW → deploy
  if (st?.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, '❌ Reply "true" or "false".');
    }
    st.data.AUTO_STATUS_VIEW = lc==='true'?'no-dl':'false';
    try {
      await bot.sendMessage(cid, '🚀 Starting deployment...');
      await buildWithProgress(cid, st.data);
      await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
      await bot.sendMessage(cid, `🎉 Bot "${st.data.APP_NAME}" deployed!`);
    } catch (err) {
      console.error('Deploy error:', err);
      await bot.sendMessage(cid, `⚠️ Deployment failed: ${err.message}`);
    }
    delete userStates[cid];
    return;
  }
});

// 12) Callback Query Handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // Admin: select an app
  if (action === 'selectapp') {
    const name = payload;
    return bot.sendMessage(cid, `Manage app "${name}":`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'Info',    callback_data:`info:${name}` },
          { text:'Restart', callback_data:`restart:${name}` },
          { text:'Logs',    callback_data:`logs:${name}` }
        ],
        [
          { text:'Delete',  callback_data:`delete:${name}` }
        ]
      ]}
    });
  }

  // User: select own bot
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
      ]}
    });
  }

  // Info
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${payload}`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      const { name, web_url, stack, region, created_at } = res.data;
      const createdDate = new Date(created_at);
      const ageDays = Math.floor((Date.now() - createdDate) / (1000*60*60*24));
      return bot.sendMessage(cid,
        `📦 App Info:\n` +
        `• Name: ${name}\n` +
        `• URL: ${web_url}\n` +
        `• Stack: ${stack}\n` +
        `• Region: ${region?.name||'unknown'}\n` +
        `• Created: ${createdDate.toDateString()}\n` +
        `• Age: ${ageDays} day${ageDays===1?'':'s'}`
      );
    } catch (e) {
      return bot.sendMessage(cid, `Error fetching info: ${e.message}`);
    }
  }

  // Restart
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `"${payload}" restarted.`);
    } catch (e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
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
      const logRes = await axios.get(sess.data.logplex_url);
      const logs = logRes.data.trim().slice(-4000);
      return bot.sendMessage(cid,
        `Logs for "${payload}":\n\`\`\`\n${logs}\n\`\`\``,
        { parse_mode:'Markdown' }
      );
    } catch (e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
    }
  }

  // Delete (admin)
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `"${payload}" deleted.`);
    } catch (e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
    }
  }

  // Delete (user)
  if (action === 'userdelete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      await deleteUserBot(cid, payload);
      return bot.sendMessage(cid, `Your bot "${payload}" deleted.`);
    } catch (e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
    }
  }
});
