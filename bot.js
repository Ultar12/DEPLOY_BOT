// bot.js

// Global error handlers
process.on('unhandledRejection', err =>
  console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('Uncaught Exception:', err));

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

// PostgreSQL setup & ensure table exists
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
})().catch(console.error);

// Database helpers
async function addUserBot(u, b, s) {
  await pool.query(
    'INSERT INTO user_bots(user_id, bot_name, session_id) VALUES($1,$2,$3)',
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
const userStates = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds with valid key
const validKeys = new Set();       // one-time deploy keys

// Utilities
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

// Send Heroku app list with count
async function sendAppList(chatId) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (apps.length === 0) {
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

// Build & deploy with progress
async function buildWithProgress(chatId, vars) {
  const appName = vars.APP_NAME;
  // create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });
  // provision Postgres
  await axios.post(
    `https://api.heroku.com/apps/${appName}/addons`,
    { plan: 'heroku-postgresql:hobby-dev' },
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );
  // buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
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
  // config vars
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
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
  // start build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` }},
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
    }}
  );
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let status = 'pending';
  const msg = await bot.sendMessage(chatId, 'Building... 0%');
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
    await bot.editMessageText(`Building... ${pct}%`, {
      chat_id: chatId,
      message_id: msg.message_id
    });
    if (status !== 'pending') break;
  }
  if (status === 'succeeded') {
    await bot.editMessageText(
      `Build complete! Live at https://${appName}.herokuapp.com`,
      { chat_id: chatId, message_id: msg.message_id }
    );
  } else {
    await bot.editMessageText(
      `Build ${status}. Check your dashboard.`,
      { chat_id: chatId, message_id: msg.message_id }
    );
  }
}

// polling errors
bot.on('polling_error', console.error);

// /start
bot.onText(/^\/start$/, async msg => {
  const chatId = msg.chat.id.toString();
  const isAdmin = chatId === ADMIN_ID;
  delete userStates[chatId];
  if (isAdmin) authorizedUsers.add(chatId);
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username||'N/A'})`);

  const welcome = isAdmin
    ? 'Admin menu'
    : 'User menu';
  await bot.sendMessage(chatId, welcome, {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /menu
bot.onText(/^\/menu$/i, msg => {
  const chatId = msg.chat.id.toString();
  const isAdmin = chatId === ADMIN_ID;
  bot.sendMessage(chatId, 'Menu', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// /generate
bot.onText(/^\/generate$/i, msg => {
  const chatId = msg.chat.id.toString();
  if (chatId !== ADMIN_ID) return bot.sendMessage(chatId, 'Unauthorized');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(chatId, `Key:\n\`${key}\``, { parse_mode: 'Markdown' });
});

// /apps
bot.onText(/^\/apps$/i, msg => {
  const chatId = msg.chat.id.toString();
  if (chatId === ADMIN_ID) sendAppList(chatId);
});

// message handler
bot.on('message', async msg => {
  const chatId = msg.chat.id.toString();
  const text = msg.text?.trim() || '';
  const lc = text.toLowerCase();
  const isAdmin = chatId === ADMIN_ID;

  // Deploy button
  if (text === 'Deploy') {
    if (!isAdmin && !authorizedUsers.has(chatId)) {
      userStates[chatId] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(chatId, 'Enter deploy key:');
    }
    userStates[chatId] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(chatId, 'Enter session ID:');
  }

  // Apps button
  if (text === 'Apps' && isAdmin) {
    return sendAppList(chatId);
  }

  // Generate Key button
  if (text === 'Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(chatId, `Key:\n\`${key}\``, { parse_mode: 'Markdown' });
  }

  // Get Session button
  if (text === 'Get Session') {
    userStates[chatId] = { step: 'SESSION_ID', data: {} };
    try {
      await bot.sendPhoto(chatId, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption:
          '1. Open link\n2. Click Session\n3. Enter custom ID\n\n' +
          'https://levanter-delta.vercel.app/',
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(chatId, 'https://levanter-delta.vercel.app/');
    }
    return bot.sendMessage(chatId,
      'Note:\n' +
      '- Use Chrome\n' +
      '- Skip ads\n' +
      '- Custom ID starts bot\n' +
      'Then tap Deploy.'
    );
  }

  // My Bots button
  if (text === 'My Bots') {
    const bots = await getUserBots(chatId);
    if (!bots.length) return bot.sendMessage(chatId, 'No bots.');
    const rows = chunkArray(bots, 3).map(r =>
      r.map(n => ({ text: n, callback_data: `selectbot:${n}` }))
    );
    return bot.sendMessage(chatId, 'Your bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // Support button
  if (text === 'Support') {
    return bot.sendMessage(chatId, 'Contact admin.');
  }

  const state = userStates[chatId];
  if (!state) return;

  // Await deploy key
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(chatId);
      userStates[chatId] = { step: 'SESSION_ID', data: {} };
      await bot.sendMessage(ADMIN_ID, `Key used by ${chatId}`);
      return bot.sendMessage(chatId, 'Key accepted. Enter session ID:');
    }
    return bot.sendMessage(chatId, 'Invalid key.');
  }

  // Got session ID
  if (state.step === 'SESSION_ID') {
    if (text.length < 5) return bot.sendMessage(chatId, 'Session ID too short.');
    state.data.SESSION_ID = text;
    state.step = 'APP_NAME';
    return bot.sendMessage(chatId, 'Enter bot name:');
  }

  // Got app name
  if (state.step === 'APP_NAME') {
    const name = text.toLowerCase().replace(/\s+/g, '-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(chatId, 'Invalid name.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(chatId, 'Name taken.');
    } catch (e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = name;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(chatId, 'Enable auto status view? (true/false)');
      }
      throw e;
    }
  }

  // AUTO_STATUS_VIEW
  if (state.step === 'AUTO_STATUS_VIEW') {
    const v = text.toLowerCase();
    if (v !== 'true' && v !== 'false') {
      return bot.sendMessage(chatId, 'Reply true or false.');
    }
    state.data.AUTO_STATUS_VIEW = v === 'true' ? 'no-dl' : 'false';
    await buildWithProgress(chatId, state.data);
    await addUserBot(chatId, state.data.APP_NAME, state.data.SESSION_ID);
    delete userStates[chatId];
    return;
  }

  // Text SetVar fallback
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
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(chatId, APP_NAME, text);
      }
      await bot.sendMessage(chatId, `Set ${VAR_NAME} to:\n\`\`\`\n${text}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (e) {
      await bot.sendMessage(chatId, `Failed: ${e.message}`);
    }
    delete userStates[chatId];
    return;
  }
});

// Callback queries
bot.on('callback_query', async q => {
  const chatId = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // Admin "Apps" submenu
  if (action === 'selectapp') {
    return bot.sendMessage(chatId, `Manage "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Info',    callback_data: `info:${payload}` },
            { text: 'Restart', callback_data: `restart:${payload}` },
            { text: 'Logs',    callback_data: `logs:${payload}` }
          ],
          [
            { text: 'Delete',  callback_data: `delete:${payload}` },
            { text: 'SetVar',  callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  // User "My Bots" submenu
  if (action === 'selectbot') {
    return bot.sendMessage(chatId, `Manage your bot "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Info',    callback_data: `info:${payload}` },
            { text: 'Restart', callback_data: `restart:${payload}` },
            { text: 'Logs',    callback_data: `logs:${payload}` }
          ],
          [
            { text: 'Delete',  callback_data: `userdelete:${payload}` },
            { text: 'SetVar',  callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  // Info
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      const { name, web_url, stack, created_at } = res.data;
      return bot.sendMessage(chatId,
        `Name: ${name}\nURL: ${web_url}\nStack: ${stack}\nCreated: ${created_at}`
      );
    } catch (e) {
      return bot.sendMessage(chatId, `Info error: ${e.message}`);
    }
  }

  // Restart
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(chatId, `"${payload}" restarted.`);
    } catch (e) {
      return bot.sendMessage(chatId, `Restart error: ${e.message}`);
    }
  }

  // Logs
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
      const logRes = await axios.get(sess.data.logplex_url);
      const logs = logRes.data.trim().slice(-4000);
      return bot.sendMessage(chatId, `Logs:\n\`\`\`\n${logs}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (e) {
      return bot.sendMessage(chatId, `Logs error: ${e.message}`);
    }
  }

  // Delete (admin)
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(chatId, `"${payload}" deleted.`);
    } catch (e) {
      return bot.sendMessage(chatId, `Delete error: ${e.message}`);
    }
  }

  // Delete (user)
  if (action === 'userdelete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      await deleteUserBot(chatId, payload);
      return bot.sendMessage(chatId, `Your bot "${payload}" deleted.`);
    } catch (e) {
      return bot.sendMessage(chatId, `Delete error: ${e.message}`);
    }
  }

  // SetVar menu
  if (action === 'setvar') {
    return bot.sendMessage(chatId, `Set variable for "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'SESSION_ID',       callback_data: `varselect:SESSION_ID:${payload}` },
            { text: 'AUTO_STATUS_VIEW', callback_data: `varselect:AUTO_STATUS_VIEW:${payload}` }
          ],
          [
            { text: 'ALWAYS_ONLINE',    callback_data: `varselect:ALWAYS_ONLINE:${payload}` },
            { text: 'PREFIX',           callback_data: `varselect:PREFIX:${payload}` }
          ],
          [
            { text: 'ANTI_DELETE',      callback_data: `varselect:ANTI_DELETE:${payload}` }
          ]
        ]
      }
    });
  }

  // varselect
  if (action === 'varselect') {
    const varKey = payload;
    const appName = extra;
    if (['AUTO_STATUS_VIEW','ALWAYS_ONLINE','ANTI_DELETE'].includes(varKey)) {
      return bot.sendMessage(chatId, `Set ${varKey} to:`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'true',  callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ]]
        }
      });
    }
    userStates[chatId] = { step: 'SETVAR_ENTER_VALUE', data: { APP_NAME: appName, VAR_NAME: varKey } };
    return bot.sendMessage(chatId, `Enter new value for ${varKey}:`);
  }

  // setvarbool
  if (action === 'setvarbool') {
    const varKey = payload;
    const appName = extra;
    const flagVal = flag === 'true';
    let newVal;
    if (varKey === 'AUTO_STATUS_VIEW') {
      newVal = flagVal ? 'no-dl' : 'false';
    } else if (varKey === 'ANTI_DELETE') {
      newVal = flagVal ? 'p' : 'false';
    } else {
      newVal = flagVal ? 'true' : 'false';
    }
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
          }}
      );
      if (varKey === 'SESSION_ID') {
        await updateUserSession(chatId, appName, newVal);
      }
      return bot.sendMessage(chatId, `${varKey} updated to ${newVal}`);
    } catch (e) {
      return bot.sendMessage(chatId, `Update error: ${e.message}`);
    }
  }
});
