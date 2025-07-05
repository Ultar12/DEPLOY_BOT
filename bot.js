// bot.js

// 0) Imports & Setup
require('dotenv').config();
const fs          = require('fs');
const axios       = require('axios');
const { Client }  = require('pg');
const TelegramBot = require('node-telegram-bot-api');

// 0.1) Read app.json defaults
const appJson        = JSON.parse(fs.readFileSync('./app.json', 'utf8'));
const defaultEnvVars = appJson.env || {};

const {
  HEROKU_API_KEY,
  TELEGRAM_BOT_TOKEN,
  ADMIN_ID,
  DATABASE_URL,
  GITHUB_REPO_URL
} = process.env;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const db  = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
db.connect();

// 1) In-memory state & auth
const userStates     = {};
const authorizedUsers = new Set();

// 2) Ensure tables exist
(async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      id SERIAL PRIMARY KEY,
      chat_id TEXT,
      app_name TEXT,
      session_id TEXT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS deploy_keys (
      id SERIAL PRIMARY KEY,
      chat_id TEXT,
      key TEXT,
      used BOOLEAN DEFAULT false
    );
  `);
})();

// 3) Helpers
async function addUserBot(chatId, appName, sessionId) {
  await db.query(
    `INSERT INTO user_bots (chat_id, app_name, session_id)
     VALUES ($1, $2, $3)`,
    [chatId, appName, sessionId]
  );
}

async function getUserBots(chatId) {
  const res = await db.query(
    `SELECT app_name FROM user_bots WHERE chat_id = $1`,
    [chatId]
  );
  return res.rows.map(r => r.app_name);
}

async function useDeployKey(chatId, key) {
  const res = await db.query(
    `UPDATE deploy_keys
     SET used = true
     WHERE chat_id = $1 AND key = $2 AND used = false
     RETURNING id`,
    [chatId, key]
  );
  return res.rowCount > 0;
}

async function updateUserSession(chatId, appName, newSession) {
  await db.query(
    `UPDATE user_bots
     SET session_id = $3
     WHERE chat_id = $1 AND app_name = $2`,
    [chatId, appName, newSession]
  );
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function buildKeyboard(isAdmin) {
  const kb = [];
  if (isAdmin) kb.push(['Deploy', 'Apps']);
  else         kb.push(['Deploy']);
  kb.push(['My Bots']);
  return kb;
}

// 4) Admin: list all Heroku apps
async function sendAppList(chatId) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) {
      return bot.sendMessage(chatId, 'No apps found.');
    }
    const keyboard = chunkArray(apps, 3).map(group =>
      group.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(chatId,
      `Total apps: ${apps.length}\nSelect one:`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  } catch (e) {
    bot.sendMessage(chatId, `Error fetching apps: ${e.message}`);
  }
}

// 5) Deploy helper with progress
async function buildWithProgress(chatId, vars) {
  const name = vars.APP_NAME;

  // Create app
  await axios.post('https://api.heroku.com/apps', { name }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept:        'application/vnd.heroku+json; version=3'
    }
  });

  // Provision Postgres
  await axios.post(
    `https://api.heroku.com/apps/${name}/addons`,
    { plan: 'heroku-postgresql' },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
      }
    }
  );

  // Configure buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${name}/buildpack-installations`,
    {
      updates: [
        { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
        { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
        { buildpack: 'heroku/nodejs' }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
      }
    }
  );

  // Debug
  console.log('🧪 Deploying with vars:', vars);

  // Set config vars
  await axios.patch(
    `https://api.heroku.com/apps/${name}/config-vars`,
    {
      SESSION_ID:       vars.SESSION_ID,
      APP_NAME:         vars.APP_NAME,
      AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
      ALWAYS_ONLINE:    'true',
      STATUS_VIEW_EMOJI: '🫥',
      PREFIX:           '.',
      ...defaultEnvVars
    },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
      }
    }
  );

  // Trigger build
  const buildRes = await axios.post(
    `https://api.heroku.com/apps/${name}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
      }
    }
  );

  // Track build progress
  const statusUrl = `https://api.heroku.com/apps/${name}/builds/${buildRes.data.id}`;
  const progMsg  = await bot.sendMessage(chatId, 'Building... 0%');
  let status     = 'pending';

  for (let i = 1; i <= 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const poll = await axios.get(statusUrl, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      });
      status = poll.data.status;
    } catch {
      break;
    }
    const pct = Math.min(100, i * 5);
    await bot.editMessageText(`Building... ${pct}%`, {
      chat_id:    chatId,
      message_id: progMsg.message_id
    });
    if (status !== 'pending') break;
  }

  // Final status
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

// 6) Polling error
bot.on('polling_error', console.error);

// 7) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);

  const nameLog = [msg.from.first_name, msg.from.last_name]
    .filter(Boolean).join(' ');
  console.log(`User: ${nameLog} (@${msg.from.username||'N/A'}) [${cid}]`);

  await bot.sendMessage(cid,
    isAdmin ? 'Admin menu:' : 'User menu:',
    { reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true } }
  );
});

bot.onText(/^\/menu$/i, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) sendAppList(cid);
});

// 8) Main message handler
bot.on('message', async msg => {
  const cid     = msg.chat.id.toString();
  const text    = msg.text?.trim();
  if (!text) return;
  const lc      = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  if (!authorizedUsers.has(cid) && !isAdmin && text !== 'Deploy') {
    return bot.sendMessage(cid, '🔒 You’re not authorized. Use /start.');
  }

  let st = userStates[cid];

  // Trigger Deploy
  if (text === 'Deploy') {
    if (!isAdmin) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid, '🔐 Please enter your deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '🧾 Enter your session ID:');
  }

  // My Bots
  if (text === 'My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) {
      return bot.sendMessage(cid, 'You have no bots deployed.');
    }
    const keyboard = chunkArray(bots, 3).map(group =>
      group.map(name => ({ text: name, callback_data: `selectbot:${name}` }))
    );
    return bot.sendMessage(cid, 'Your bots:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  // AWAITING_KEY
  if (st?.step === 'AWAITING_KEY') {
    if (await useDeployKey(cid, text)) {
      st.step = 'SESSION_ID';
      return bot.sendMessage(cid, '✅ Key accepted! Enter your session ID:');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key.');
  }

  // SESSION_ID
  if (st?.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid, '❌ Session ID must be at least 5 characters.');
    }
    st.data.SESSION_ID = text;
    st.step            = 'BOT_NAME';
    return bot.sendMessage(cid,
      '🤖 Please enter a name for your bot.\n\n' +
      '✅ Use only lowercase letters & numbers.\n' +
      '✅ Min length: 5 characters.'
    );
  }

  // BOT_NAME
  if (st?.step === 'BOT_NAME') {
    const name = text.toLowerCase().replace(/\s+/g, '-');
    if (name.length < 5 || !/^[a-z0-9-]+$/.test(name)) {
      return bot.sendMessage(cid,
        '❌ Invalid name. Use ≥5 chars: lowercase letters & numbers only.'
      );
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `❌ "${name}" is already taken on Heroku.`);
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = name;
        st.step           = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,
          '✅ Name available!\n\nEnable automatic status view? Reply "true" or "false".'
        );
      }
      console.error('Name check error:', e);
      return bot.sendMessage(cid, '❌ Error checking name.');
    }
  }

  // AUTO_STATUS_VIEW
  if (st?.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, '❌ Reply "true" or "false".');
    }
    st.data.AUTO_STATUS_VIEW = lc === 'true' ? 'no-dl' : 'false';

    try {
      console.log('🧪 Deploying with vars:', st.data);
      await bot.sendMessage(cid, '🚀 Starting deployment...');
      await buildWithProgress(cid, st.data);
      await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
      await bot.sendMessage(cid,
        `✅ Bot "${st.data.APP_NAME}" deployed successfully!`
      );
    } catch (err) {
      console.error('❌ Deployment error:', err);
      await bot.sendMessage(cid, `❌ Deployment failed: ${err.message}`);
    }

    delete userStates[cid];
    return;
  }
});

// 9) Callback query handler
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const [action, payload, extra, flag] = query.data.split(':');

  // Admin: select any Heroku app
  if (action === 'selectapp') {
    const appName = payload;
    const res     = await axios.get(
      `https://api.heroku.com/apps/${appName}/config-vars`,
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      }
    );
    const cfg     = res.data;
    const keys    = Object.keys(cfg);
    const rows    = chunkArray(keys, 2).map(group =>
      group.map(key => {
        const val    = cfg[key];
        const next   = (val === 'true' || val === 'no-dl') ? 'false' : 'true';
        return {
          text: `${key}: ${val}`,
          callback_data: `setvarbool:${key}:${appName}:${next}`
        };
      })
    );
    rows.push([{
      text: '🗑️ Delete App',
      callback_data: `delete:${appName}`
    }]);
    return bot.sendMessage(cid,
      `Settings for ${appName}:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  }

  // User: select own bot
  if (action === 'selectbot') {
    return bot.emit('callback_query', {
      ...query,
      data: `selectapp:${payload}`
    });
  }

  // Toggle boolean var
  if (action === 'setvarbool') {
    const varKey  = payload;
    const appName = extra;
    const newVal  = flag;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept:        'application/vnd.heroku+json; version=3',
            'Content-Type':'application/json'
          }
        }
      );
      if (varKey === 'SESSION_ID') {
        await updateUserSession(cid, appName, newVal);
      }
      return bot.sendMessage(cid, `${varKey} set to ${newVal}`);
    } catch (e) {
      return bot.sendMessage(cid, `Error: ${e.message}`);
    }
  }

  // Delete app
  if (action === 'delete') {
    const appName = payload;
    try {
      await axios.delete(
        `https://api.heroku.com/apps/${appName}`,
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept:        'application/vnd.heroku+json; version=3'
          }
        }
      );
      await db.query(
        `DELETE FROM user_bots WHERE app_name = $1`,
        [appName]
      );
      return bot.sendMessage(cid, `App ${appName} deleted.`);
    } catch (e) {
      return bot.sendMessage(cid, `Error deleting ${appName}: ${e.message}`);
    }
  }
});
