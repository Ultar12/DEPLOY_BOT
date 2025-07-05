// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err =>
  console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs   = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// 2) Load fallback env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json','utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k,v]) => [k, v.value])
  );
} catch {}

// 3) Environment config
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// 4) Postgres setup & ensure tables exist
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
      uses_left  INTEGER NOT NULL,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
})().catch(console.error);

// 5) DB helper functions
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
async function addDeployKey(key, uses, createdBy) {
  await pool.query(
    'INSERT INTO deploy_keys(key,uses_left,created_by) VALUES($1,$2,$3)',
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

// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds who've passed a key

// 7) Utilities
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

// 8) Send Heroku apps list
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
    bot.sendMessage(chatId, `Error fetching apps: ${e.message}`);
  }
}

// 9) Build & deploy helper
async function buildWithProgress(chatId, vars) {
  const name = vars.APP_NAME;

  // Create app
  await axios.post('https://api.heroku.com/apps', { name }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  // Provision Postgres
  await axios.post(
    `https://api.heroku.com/apps/${name}/addons`,
    { plan: 'heroku-postgresql' },
    { headers:{
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );

  // Configure buildpacks
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

  // Set config vars (including APP_NAME)
  await axios.patch(
  `https://api.heroku.com/apps/${name}/config-vars`,
  {
    APP_NAME: name,
    SESSION_ID: vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
    ...defaultEnvVars
  },
  { headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
  }}
);  // Start build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${name}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` }},
    { headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
    }}
  );

  // Progress
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

  // Final status
  if (status === 'succeeded') {
    await bot.editMessageText(
      `Build complete! Live at https://${name}.herokuapp.com`,
      { chat_id: chatId, message_id: progMsg.message_id }
    );
  } else {
    await bot.editMessageText(
      `Build ${status}. Check your dashboard.`,
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

// 12) Message handler for buttons & state
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;
  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

// Button: Deploy
if (text === 'Deploy') {
  if (cid === ADMIN_ID) {
    // Skip key for admin
    authorizedUsers.add(cid);
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '🔐 Admin access granted. Enter your session ID:');
  } else {
    userStates[cid] = { step: 'AWAITING_KEY', data: {} };
    return bot.sendMessage(cid, 'Enter your deploy key:');
  }
}
  // Button: Apps
  if (text === 'Apps' && isAdmin) {
    return sendAppList(cid);
  }

  // Button: Generate Key → ask uses
  if (text === 'Generate Key' && isAdmin) {
    const buttons = [[1,2,3,4,5].map(n=>({
      text: String(n),
      callback_data: `genkeyuses:${n}`
    }))];
    return bot.sendMessage(cid, 'How many uses for this key?', {
      reply_markup:{ inline_keyboard: buttons }
    });
  }

  // Button: Get Session
  if (text === 'Get Session') {
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption:
          'How to get your session ID:\n\n' +
          '1. Open the link below\n' +
          '2. Click "Session" on the left\n' +
          '3. Enter a custom session ID (e.g. your name)\n\n' +
          'Link: https://levanter-delta.vercel.app/',
        parse_mode:'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, 'Visit: https://levanter-delta.vercel.app/');
    }
    return bot.sendMessage(cid,
      'Note:\n' +
      '- Use a modern browser (Chrome recommended)\n' +
      '- Skip any ads or popups\n' +
      '- Enter a custom session ID (e.g. your name or username)\n' +
      '- This ID will be used to automatically start your bot\n\n' +
      'Once you have it, tap "Deploy".'
    );
  }

  // Button: My Bots
  if (text === 'My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, 'No bots deployed.');
    const rows = chunkArray(bots, 3).map(r=>r.map(n=>({
      text: n, callback_data: `selectbot:${n}`
    })));
    return bot.sendMessage(cid, 'Your bots:', {
      reply_markup:{ inline_keyboard: rows }
    });
  }

  // Button: Support
  if (text === 'Support') {
    return bot.sendMessage(cid, `Need help? Contact the admin:\n${SUPPORT_USERNAME}`);
  }

// Stateful flows
const st = userStates[cid];
if (!st) return;

// Awaiting deploy key
if (st.step === 'AWAITING_KEY') {
  const keyAttempt = text.toUpperCase();
  const usesLeft = await useDeployKey(keyAttempt);
  if (usesLeft === null) {
    return bot.sendMessage(cid, 'Invalid or expired key.');
  }
  authorizedUsers.add(cid);
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  await bot.sendMessage(ADMIN_ID,
    `🔑 Key used by ${cid}. Uses left: ${usesLeft}`
  );
  return bot.sendMessage(cid, 'Key accepted. Enter your session ID:');
}

// SESSION_ID
if (st.step === 'SESSION_ID') {
  if (text.length < 5) {
    return bot.sendMessage(cid, 'Session ID must be at least 5 characters.');
  }
  st.data.SESSION_ID = text.trim();
  st.step = 'APP_NAME';
  return bot.sendMessage(cid, 'Enter a name for your bot:');
}

// APP_NAME
if (st.step === 'APP_NAME') {
  const nm = text.toLowerCase().replace(/\s+/g, '-');
  if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
    return bot.sendMessage(cid,
      'Invalid name. Use at least 5 characters: lowercase letters, numbers or hyphens.'
    );
  }
  try {
    await axios.get(`https://api.heroku.com/apps/${nm}`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    return bot.sendMessage(cid, `❌ The name "${nm}" is already taken.`);
  } catch (e) {
    if (e.response?.status === 404) {
      st.data.APP_NAME = nm;
      st.step = 'AUTO_STATUS_VIEW';
      return bot.sendMessage(cid, 'Enable automatic status view? (true/false)');
    }
    throw e;
  }
}

// AUTO_STATUS_VIEW
if (st.step === 'AUTO_STATUS_VIEW') {
  if (lc !== 'true' && lc !== 'false') {
    return bot.sendMessage(cid, 'Reply "true" or "false".');
  }
  st.data.AUTO_STATUS_VIEW = lc === 'true' ? 'no-dl' : 'false';

  // ✅ ENSURE APP_NAME & SESSION_ID are not missing
  const { APP_NAME, SESSION_ID } = st.data;
  if (!APP_NAME || !SESSION_ID) {
    delete userStates[cid];
    return bot.sendMessage(cid, '❌ Missing APP_NAME or SESSION_ID during deploy. Please start over.');
  }

  await buildWithProgress(cid, st.data); // ⬅ Make sure this uses `st.data`
  await addUserBot(cid, APP_NAME, SESSION_ID);
  delete userStates[cid];
  return;
}

// SETVAR flow
if (st.step === 'SETVAR_ENTER_VALUE') {
  const { APP_NAME, VAR_NAME } = st.data;
  const newVal = text.trim();
  try {
    await axios.patch(
      `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
      { [VAR_NAME]: newVal },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );
    if (VAR_NAME === 'SESSION_ID') {
      await updateUserSession(cid, APP_NAME, newVal);
    }
    delete userStates[cid];
    return bot.sendMessage(cid, `${VAR_NAME} updated successfully.`);
  } catch (e) {
    return bot.sendMessage(cid, `Error updating variable: ${e.message}`);
  }
}
// 13) Callback query handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // After pressing uses count for key generation
  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key  = generateKey();
    await addDeployKey(key, uses, cid);
    return bot.sendMessage(cid,
      `Generated key: \`${key}\`\nUses: ${uses}`,
      { parse_mode:'Markdown' }
    );
  }

  // Admin app menu
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

    // User bot menu
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

  // Info
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${payload}`, {
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      const { name, web_url, stack, created_at } = res.data;
      return bot.sendMessage(cid,
        `Name: ${name}\nURL: ${web_url}\nStack: ${stack}\nCreated: ${created_at}`
      );
    } catch(e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
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
    } catch(e) {
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
    } catch(e) {
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
    } catch(e) {
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
    } catch(e) {
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
      step:'SETVAR_ENTER_VALUE',
      data:{ APP_NAME:appName, VAR_NAME:varKey }
    };
    return bot.sendMessage(cid, `Enter new value for ${varKey}:`);
  }

  // setvarbool
  if (action === 'setvarbool') {
    const varKey = payload, appName = extra, flagVal = flag === 'true';
    let newVal;
    if (varKey === 'AUTO_STATUS_VIEW')    newVal = flagVal ? 'no-dl' : 'false';
    else if (varKey === 'ANTI_DELETE')     newVal = flagVal ? 'p'    : 'false';
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
    } catch(e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
    }
  }
});
