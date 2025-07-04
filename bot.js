require('dotenv').config(); // Load environment variables

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// === CONFIG FROM .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEROKU_API_KEY     = process.env.HEROKU_API_KEY;
const GITHUB_REPO_URL    = process.env.GITHUB_REPO_URL;
const ADMIN_ID           = process.env.ADMIN_ID;

// === INIT BOT ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === IN-MEMORY STATE ===
const userStates      = {};
const authorizedUsers = new Set();
const validKeys       = new Set();

// === UTIL: Generate 8-char uppercase alphanumeric key ===
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 8; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// === GLOBAL ERROR HANDLER ===
bot.on('polling_error', err => {
  console.error('[polling_error]', err.code, err.message);
});

// === /generate (admin only) ===
bot.onText(/\/generate/, (msg) => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can generate keys.');

  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 Key generated: \`${key}\`\nShare this with a user for one deploy.`, { parse_mode: 'Markdown' });
});

// === /start ===
bot.onText(/\/start/, (msg) => {
  const cid = msg.chat.id.toString();

  if (cid === ADMIN_ID) {
    authorizedUsers.add(cid);
    return bot.sendMessage(cid, '✅ Admin access granted. You may use all commands.');
  }

  userStates[cid] = { step: 'AWAITING_KEY' };
  bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
});

// === /alive ===
bot.onText(/\/alive/, (msg) => {
  const cid = msg.chat.id;
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  bot.sendMessage(cid, `✅ I'm alive!\n🕒 ${now}`);
});

// === /apps (admin only) ===
bot.onText(/\/apps/, async (msg) => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can list apps.');

  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    if (res.data.length === 0) return bot.sendMessage(cid, '📭 No apps found.');
    const list = res.data.map(a => `• ${a.name}`).join('\n');
    bot.sendMessage(cid, `📦 Heroku Apps:\n${list}`);
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// === /delete <app> (admin only) ===
bot.onText(/\/delete (.+)/, async (msg, match) => {
  const cid = msg.chat.id.toString();
  const appName = match[1].trim();

  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can delete apps.');

  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    bot.sendMessage(cid, `🗑️ App "${appName}" deleted.`);
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not delete "${appName}": ${err.message}`);
  }
});

// === /deploy ===
bot.onText(/\/deploy/, (msg) => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;

  if (!isAdmin && !authorizedUsers.has(cid)) {
    return bot.sendMessage(cid, '❌ You are not authorized. Use /start and enter a valid key.');
  }

  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Please enter SESSION_ID:');
});

// === MESSAGE HANDLER ===
bot.on('message', async (msg) => {
  const cid = msg.chat.id.toString();
  const text = msg.text;
  const state = userStates[cid];

  if (state && state.step === 'AWAITING_KEY') {
    if (validKeys.has(text)) {
      validKeys.delete(text);
      authorizedUsers.add(cid);
      delete userStates[cid];
      return bot.sendMessage(cid, '✅ Key accepted! You may now /deploy.');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key.');
  }

  if (!state || text.startsWith('/')) return;

  try {
    switch (state.step) {
      case 'SESSION_ID':
        if (!text || text.length < 5) return bot.sendMessage(cid, '⚠️ SESSION_ID must be ≥5 chars.');
        state.data.SESSION_ID = text;
        state.step = 'APP_NAME';
        return bot.sendMessage(cid, '📝 Enter APP_NAME (Heroku app name):');

      case 'APP_NAME':
        const appName = text.toLowerCase().replace(/\s+/g, '-');
        try {
          await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept: 'application/vnd.heroku+json; version=3'
            }
          });
          return bot.sendMessage(cid, `❌ "${appName}" already exists. Choose another.`);
        } catch (e) {
          if (e.response && e.response.status === 404) {
            state.data.APP_NAME = appName;
            state.step = 'AUTO_STATUS_VIEW';
            return bot.sendMessage(cid, '📝 Enter AUTO_STATUS_VIEW ("no-dl" or "false"):');
          }
          throw e;
        }

      case 'AUTO_STATUS_VIEW':
        const val = text.toLowerCase();
        if (val !== 'no-dl' && val !== 'false') {
          return bot.sendMessage(cid, '⚠️ Must be "no-dl" or "false". Try again:');
        }
        state.data.AUTO_STATUS_VIEW = val;
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI (e.g. 👁️):');

      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text;
        bot.sendMessage(cid, '🚀 Deploying to Heroku…');
        await deployToHeroku(cid, state.data);
        delete userStates[cid];
        authorizedUsers.delete(cid);
        return;

      default:
        delete userStates[cid];
        return;
    }
  } catch (err) {
    delete userStates[cid];
    bot.sendMessage(cid, `❌ An error occurred: ${err.message}`);
  }
});

// === DEPLOY FUNCTION ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  const configVars = {
    SESSION_ID: vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
    STATUS_VIEW_EMOJI: vars.STATUS_VIEW_EMOJI,
    HEROKU_API_KEY: HEROKU_API_KEY
  };

  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3'
    }
  });

  await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, configVars, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    }
  });

  await axios.post(`https://api.heroku.com/apps/${appName}/builds`, {
    source_blob: {
      url: `${GITHUB_REPO_URL}/tarball/main`
    }
  }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json'
    }
  });

  bot.sendMessage(chatId, `✅ App deployed!\n🌐 https://${appName}.herokuapp.com`);
}
