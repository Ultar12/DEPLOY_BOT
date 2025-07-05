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

// 2) Load fallback env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
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

// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds with valid key

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

// 9) Build & deploy helper with progress
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

  // 3. Buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${name}/buildpack-installations`,
    { updates: [
        { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
        { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
        { buildpack: 'heroku/nodejs' }
    ]},
    { headers:{
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );

  // 4. Config vars
  await axios.patch(
    `https://api.heroku.com/apps/${name}/config-vars`,
    {
      SESSION_ID: vars.SESSION_ID,
      AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
      ...defaultEnvVars
    },
    { headers:{
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );

  // 5. Start build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${name}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
    { headers:{
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );

  // 6. Progress animation
  const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
  let status = 'pending';
  const progMsg = await bot.sendMessage(chatId, 'Building... 0%');
  for (let i = 1; i <= 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const poll = await axios.get(statusUrl, {
        headers:{
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      status = poll.data.status;
    } catch {
      break;
    }
    const pct = Math.min(100, i * 5);
    await bot.editMessageText(`Building... ${pct}%`, {
      chat_id: chatId, message_id: progMsg.message_id
    });
    if (status !== 'pending') break;
  }

  // 7. Final status
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

// 10) Handle polling errors
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
    { reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true } }
  );
});

bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
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

  // ── Button: Deploy
  if (text === 'Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid, 'Enter your deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, 'Enter your session ID:');
  }

  // ── Button: Apps
  if (text === 'Apps' && isAdmin) {
    return sendAppList(cid);
  }

  // ── Button: Generate Key → ask uses
  if (text === 'Generate Key' && isAdmin) {
    const buttons = [[1,2,3,4,5].map(n => ({
      text: String(n),
      callback_data: `genkeyuses:${n}`
    }))];
    return bot.sendMessage(cid, 'How many uses for this key?', {
      reply_markup: { inline_keyboard: buttons }
    });
  }

  // ── Button: Get Session
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
        parse_mode: 'Markdown'
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

  // ── Button: My Bots
  if (text === 'My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, 'No bots deployed.');
    const rows = chunkArray(bots, 3).map(r =>
      r.map(n => ({ text: n, callback_data: `selectbot:${n}` }))
    );
    return bot.sendMessage(cid, 'Your bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // ── Button: Support
  if (text === 'Support') {
    return bot.sendMessage(cid,
      `Need help? Contact the admin:\n${SUPPORT_USERNAME}`
    );
  }

  // ── Stateful flows
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
      `Deploy key used by ${cid}. Uses left: ${usesLeft}`
    );
    return bot.sendMessage(cid, 'Key accepted. Enter your session ID:');
  }

  // Got session ID
  if (st.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid, 'Session ID must be at least 5 characters.');
    }
    st.data.SESSION_ID = text;
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, 'Enter a name for your bot:');
  }

  // Got app name
  if (st.step === 'APP_NAME') {
    const nm = text.toLowerCase().replace(/\s+/g, '-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid,
        'Invalid name. Use at least 5 characters: lowercase letters, numbers or hyphens.'
      );
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers:{
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `The name "${nm}" is already taken.`);
    } catch(e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = nm;
        st.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid, 'Enable automatic status view? (true/false)');
      }
      console.error('App name check error:', e);
      return bot.sendMessage(cid, 'Error checking app name.');
    }
  }

  // AUTO_STATUS_VIEW → deploy
  if (st.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, 'Reply "true" or "false".');
    }
    st.data.AUTO_STATUS_VIEW = lc === 'true' ? 'no-dl' : 'false';

    try {
      await bot.sendMessage(cid, 'Starting deployment...');
      await buildWithProgress(cid, st.data);
      await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
      await bot.sendMessage(cid,
        `Bot "${st.data.APP_NAME}" deployed successfully.`
      );
    } catch (err) {
      console.error('Deployment error:', err);
      await bot.sendMessage(cid,
        `Deployment failed: ${err.message}`
      );
    }

    delete userStates[cid];
    return;
  }

  // Text-based SetVar fallback
  if (st.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = st.data;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: text },
        { headers:{
            Authorization:`Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type':'application/json'
        }}
      );
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(cid, APP_NAME, text);
      }
      return bot.sendMessage(cid,
        `Set ${VAR_NAME} to:\n\`\`\`\n${text}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
    } finally {
      delete userStates[cid];
    }
  }
});

// 13) Callback query handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // After pressing uses count for key gen
  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key  = generateKey();
    await addDeployKey(key, uses, cid);
    return bot.sendMessage(cid,
      `Generated key: \`${key}\`\nUses: ${uses}`,
      { parse_mode: 'Markdown' }
    );
  }

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
    } catch (e) {
      return bot.sendMessage
