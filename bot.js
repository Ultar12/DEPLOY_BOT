// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err =>
  console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// 2) Load fallback env vars from app.json (if using Heroku config)
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch {
  // no app.json or invalid
}

// 3) Environment variables
// Ensure your .env contains:
// TELEGRAM_BOT_TOKEN, HEROKU_API_KEY, GITHUB_REPO_URL=https://github.com/ultar1/lev
// ADMIN_ID, DATABASE_URL
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// 4) PostgreSQL setup & ensure tables exist
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deploy_keys (
      key        TEXT PRIMARY KEY,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
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
async function updateUserSession(userId, botName, sessionId) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [sessionId, userId, botName]
  );
}
async function addDeployKey(key, createdBy) {
  await pool.query(
    'INSERT INTO deploy_keys(key, created_by) VALUES($1,$2)',
    [key, createdBy]
  );
}
async function useDeployKey(key) {
  const res = await pool.query(
    'DELETE FROM deploy_keys WHERE key=$1 RETURNING key',
    [key]
  );
  return res.rowCount > 0;
}

// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds with valid key

// 7) Utility functions
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}
function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['Deploy','Apps'], ['Generate Key','Get Session'], ['Support']]
    : [['Get Session','Deploy'], ['My Bots'], ['Support']];
}
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// 8) Send list of Heroku apps (admin only)
async function sendAppList(chatId) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) {
      return bot.sendMessage(chatId, 'No apps found.');
    }
    const rows = chunkArray(apps, 3).map(r =>
      r.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(chatId,
      `Total apps: ${apps.length}\nSelect an app:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (e) {
    console.error('sendAppList error:', e);
    bot.sendMessage(chatId, `Error fetching apps: ${e.message}`);
  }
}

// 9) Build & deploy helper with progress animation
async function buildWithProgress(chatId, vars) {
  const name = vars.APP_NAME;

  // 1. Create app
  await axios.post('https://api.heroku.com/apps', { name }, {
    headers:{
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  // 2. Provision Postgres
  await axios.post(
    `https://api.heroku.com/apps/${name}/addons`,
    { plan: 'heroku-postgresql:hobby-dev' },
    { headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
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
    throw new Error('Heroku build failed. Check session ID & repo URL.');
  }

  // 6. Animate progress
  const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
  let status = 'pending';
  const progMsg = await bot.sendMessage(chatId, 'Building... 0%');
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
    await bot.editMessageText(`Building... ${pct}%`, {
      chat_id: chatId, message_id: progMsg.message_id
    });
    if (status !== 'pending') break;
  }

  // 7. Final result
  if (status === 'succeeded') {
    await bot.editMessageText(
      `Build complete! Live at https://${name}.herokuapp.com`,
      { chat_id: chatId, message_id: progMsg.message_id }
    );
  } else {
    await bot.editMessageText(
      `Build ${status}. Check your Heroku dashboard.`,
      { chat_id: chatId, message_id: progMsg.message_id }
    );
  }
}

// 10) Polling error handler
bot.on('polling_error', console.error);

// 11) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name,last_name].filter(Boolean).join(' ')} (@${username||'N/A'}) [${cid}]`);
  await bot.sendMessage(cid,
    isAdmin ? 'Admin menu:' : 'User menu:',
    { reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true } }
  );
});

bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, 'Menu:', {
    reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true }
  });
});

bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) sendAppList(cid);
});

// 12) Message handler (commands & buttons)
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;
  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;
  const st = userStates[cid];

  // Deploy button
  if (text === 'Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid, 'Enter your deploy key:');
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid, 'Enter your session ID:');
  }

  // Apps button
  if (text === 'Apps' && isAdmin) {
    return sendAppList(cid);
  }

  // Generate Key button (one-time)
  if (text === 'Generate Key' && isAdmin) {
    const key = generateKey();
    await addDeployKey(key, cid);
    return bot.sendMessage(cid,
      `One-time deploy key:\n\`${key}\``,
      { parse_mode:'Markdown' }
    );
  }

  // Get Session button
  if (text === 'Get Session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption:
          'How to get your session ID:\n\n' +
          '1. Open the link below\n' +
          '2. Click "Session" on the left\n' +
          '3. Enter a custom session ID (e.g. your name)\n\n' +
          `Link: ${GITHUB_REPO_URL}`,
        parse_mode:'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, `Visit: ${GITHUB_REPO_URL}`);
    }
    return bot.sendMessage(cid,
      'Note:\n' +
      '- Use a modern browser (Chrome)\n' +
      '- Skip any ads/popups\n' +
      '- Enter a custom session ID (your name)\n' +
      '- This auto-starts your bot\n\n' +
      'Then tap "Deploy".'
    );
  }

  // My Bots button
  if (text === 'My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, 'No bots deployed.');
    const rows = chunkArray(bots, 3).map(r =>
      r.map(n => ({ text:n, callback_data:`selectbot:${n}` }))
    );
    return bot.sendMessage(cid, 'Your bots:', {
      reply_markup:{ inline_keyboard: rows }
    });
  }

  // Support button
  if (text === 'Support') {
    return bot.sendMessage(cid, `Need help? Contact admin:\n${SUPPORT_USERNAME}`);
  }

  // AWAITING_KEY step
  if (st?.step === 'AWAITING_KEY') {
    const valid = await useDeployKey(text.toUpperCase());
    if (!valid) {
      return bot.sendMessage(cid, 'Invalid or expired key.');
    }
    authorizedUsers.add(cid);
    userStates[cid] = { step:'SESSION_ID', data:{} };
    await bot.sendMessage(ADMIN_ID, `🔑 One-time key used by ${cid}`);
    return bot.sendMessage(cid, 'Key accepted. Enter your session ID:');
  }

  // SESSION_ID step
  if (st?.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid, 'Session ID must be at least 5 characters.');
    }
    st.data.SESSION_ID = text;
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, 'Enter a name for your bot:');
  }

  // APP_NAME step
  if (st?.step === 'APP_NAME') {
    const name = text.toLowerCase().replace(/\s+/g,'-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(cid,
        'Invalid bot name. ≥5 chars: lowercase, numbers or hyphens only.'
      );
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `Name "${name}" is already taken.`);
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = name;
        st.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid, 'Enable automatic status view? (true/false)');
      }
      console.error('APP_NAME error:', e);
      return bot.sendMessage(cid, 'Error checking name.');
    }
  }

  // AUTO_STATUS_VIEW step → deploy
  if (st?.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, 'Reply "true" or "false".');
    }
    st.data.AUTO_STATUS_VIEW = lc === 'true' ? 'no-dl' : 'false';
    try {
      await bot.sendMessage(cid, 'Starting deployment...');
      await buildWithProgress(cid, st.data);
      await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
      await bot.sendMessage(cid,
        `✅ Bot "${st.data.APP_NAME}" deployed successfully!`
      );
    } catch (err) {
      console.error('Deployment error:', err);
      await bot.sendMessage(cid, `⚠️ Deployment failed: ${err.message}`);
    }
    delete userStates[cid];
    return;
  }
});

// 13) Callback queries handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // Admin app submenu
  if (action === 'selectapp') {
    return bot.sendMessage(cid, `Manage app "${payload}":`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'Info',    callback_data:`info:${payload}` },
          { text:'Restart', callback_data:`restart:${payload}` },
          { text:'Logs',    callback_data:`logs:${payload}` }
        ],
        [
          { text:'Delete',  callback_data:`delete:${payload}` },
          { text:'SetVar',  callback_data:`setvar:${payload}` }
        ]
      ]}
    });
  }

  // User bot submenu
  if (action === 'selectbot') {
    return bot.sendMessage(cid, `Manage your bot "${payload}":`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'Info',    callback_data:`info:${payload}` },
          { text:'Restart', callback_data:`restart:${payload}` },
          { text:'Logs',    callback_data:`logs:${payload}` }
        ],
        [
          { text:'Delete',  callback_data:`userdelete:${payload}` },
          { text:'SetVar',  callback_data:`setvar:${payload}` }
        ]
      ]}
    });
  }

  // Info (detailed + age)
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
        `📦 App Info:\n\n` +
        `• Name: ${name}\n` +
        `• URL: ${web_url}\n` +
        `• Stack: ${stack}\n` +
        `• Region: ${region?.name || 'unknown'}\n` +
        `• Created: ${createdDate.toDateString()}\n` +
        `• Age: ${ageDays} day${ageDays === 1 ? '' : 's'}`
      );
    } catch (e) {
      console.error('Info error:', e);
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
      console.error('Restart error:', e);
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
      console.error('Logs error:', e);
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
      console.error('Delete error:', e);
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
      console.error('User delete error:', e);
      return bot.sendMessage(cid, `Error: ${e.message}`);
    }
  }

  // SetVar menu
  if (action === 'setvar') {
    return bot.sendMessage(cid, `Set variable for "${payload}":`, {
      reply_markup:{ inline_keyboard:[
        [
          { text:'SESSION_ID',       callback_data:`varselect:SESSION_ID:${payload}` },
          { text:'AUTO_STATUS_VIEW', callback_data:`varselect:AUTO_STATUS_VIEW:${payload}` }
        ],
        [
          { text:'ALWAYS_ONLINE',    callback_data:`varselect:ALWAYS_ONLINE:${payload}` },
          { text:'PREFIX',           callback_data:`varselect:PREFIX:${payload}` }
        ],
        [
          { text:'ANTI_DELETE',      callback_data:`varselect:ANTI_DELETE:${payload}` }
        ]
      ]}
    });
  }

  // varselect
  if (action === 'varselect') {
    const varKey = payload, appName = extra;
    if (['AUTO_STATUS_VIEW','ALWAYS_ONLINE','ANTI_DELETE'].includes(varKey)) {
      return bot.sendMessage(cid, `Set ${varKey} to:`, {
        reply_markup:{ inline_keyboard:[[
          { text:'true',  callback_data:`setvarbool:${varKey}:${appName}:true` },
          { text:'false', callback_data:`setvarbool:${varKey}:${appName}:false` }
        ]]}
      });
    }
    userStates[cid] = {
      step: 'SETVAR_ENTER_VALUE',
      data: { APP_NAME: appName, VAR_NAME: varKey }
    };
    return bot.sendMessage(cid, `Enter new value for ${varKey}:`);
  }

  // setvarbool
  if (action === 'setvarbool') {
    const varKey = payload, appName = extra, flagVal = flag === 'true';
    let newVal;
    if (varKey === 'AUTO_STATUS_VIEW') newVal = flagVal ? 'no-dl' : 'false';
    else if (varKey === 'ANTI_DELETE')   newVal = flagVal ? 'p'    : 'false';
    else                                   newVal = flagVal ? 'true' : 'false';
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
      if (varKey === 'SESSION_ID') {
        await updateUserSession(cid, appName, newVal);
      }
      return bot.sendMessage(cid, `${varKey} updated to ${newVal}`);
    } catch (e) {
      console.error('SetVar error:', e);
      return bot.sendMessage(cid, `Error: ${e.message}`);
    }
  }
});
