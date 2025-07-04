require('dotenv').config();              // Load .env

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const crypto      = require('crypto');

// === CONFIG FROM .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEROKU_API_KEY     = process.env.HEROKU_API_KEY;
const GITHUB_REPO_URL    = process.env.GITHUB_REPO_URL;
const ADMIN_ID           = process.env.ADMIN_ID; // e.g. "7302005705"

// === INIT BOT ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === IN-MEMORY STATE ===
const userStates      = {};   // Tracks per-user conversation state
const authorizedUsers = new Set(); // Users allowed to /deploy
const validKeys       = new Set(); // One-time uppercase keys

// === UTIL: Generate an 8-char uppercase alphanumeric key ===
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = '';
  for (let i = 0; i < 8; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// === GLOBAL POLLING ERROR HANDLER ===
bot.on('polling_error', err => {
  console.error('[polling_error]', err.code, err.message);
});

// === /generate — Admin only: create one-time keys ===
bot.onText(/^\/generate$/, (msg) => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  }
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid,
    `🔑 Key generated: \`${key}\`\n` +
    `Share this with a user for one deploy.`,
    { parse_mode: 'Markdown' }
  );
});

// === /start — All users must begin here ===
bot.onText(/^\/start$/, (msg) => {
  const cid = msg.chat.id.toString();
  // Admin auto-authorized
  if (cid === ADMIN_ID) {
    authorizedUsers.add(cid);
    return bot.sendMessage(cid, '✅ Admin access granted. You may use all commands.');
  }
  // Others supply one-time key
  userStates[cid] = { step: 'AWAITING_KEY' };
  bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
});

// === /alive — Healthcheck ===
bot.onText(/^\/alive$/, (msg) => {
  const cid = msg.chat.id;
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  bot.sendMessage(cid, `✅ I'm alive!\n🕒 ${now}`);
});

// === /apps — Admin only: list all Heroku apps ===
bot.onText(/^\/apps$/, async (msg) => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can list apps.');
  }
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3'
      }
    });
    if (!res.data.length) {
      return bot.sendMessage(cid, '📭 No apps found.');
    }
    const list = res.data
      .map(a => `• \`${a.name}\``)
      .join('\n');
    bot.sendMessage(cid, `📦 Heroku Apps:\n${list}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// === /delete — Admin only: interactive delete ===
bot.onText(/^\/delete$/, (msg) => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can delete apps.');
  }
  userStates[cid] = { step: 'AWAITING_DELETE_APP' };
  bot.sendMessage(cid, '🗑️ Enter the name of the Heroku app you want to delete:');
});

// === /deploy — Interactive deploy flow ===
bot.onText(/^\/deploy$/, (msg) => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    return bot.sendMessage(cid, '❌ Not authorized. Use /start and enter a valid key.');
  }
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Please enter SESSION_ID:');
});

// === MESSAGE HANDLER: key entry, delete and deploy flows ===
bot.on('message', async (msg) => {
  const cid   = msg.chat.id.toString();
  const text  = msg.text;
  const state = userStates[cid];

  // 1) Handle one-time key entry
  if (state && state.step === 'AWAITING_KEY') {
    if (validKeys.has(text)) {
      validKeys.delete(text);
      authorizedUsers.add(cid);
      delete userStates[cid];
      return bot.sendMessage(cid, '✅ Key accepted! You may now /deploy.');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key.');
  }

  // 2) Handle interactive delete
  if (state && state.step === 'AWAITING_DELETE_APP') {
    const appName = text.trim();
    try {
      await axios.delete(`https://api.heroku.com/apps/${appName}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      });
      bot.sendMessage(cid, `✅ App \`${appName}\` deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(cid, `❌ Could not delete \`${appName}\`: ${err.message}`, { parse_mode: 'Markdown' });
    }
    delete userStates[cid];
    return;
  }

  // 3) Ignore other messages outside a flow or new commands
  if (!state || text.startsWith('/')) return;

  // 4) Handle deploy flow steps
  try {
    switch (state.step) {
      case 'SESSION_ID':
        if (!text || text.length < 5) {
          return bot.sendMessage(cid, '⚠️ SESSION_ID must be at least 5 characters.');
        }
        state.data.SESSION_ID = text;
        state.step = 'APP_NAME';
        return bot.sendMessage(cid, '📝 Enter APP_NAME (lowercase, no spaces):');

      case 'APP_NAME':
        const appName = text.toLowerCase().replace(/\s+/g, '-');
        try {
          await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept:        'application/vnd.heroku+json; version=3'
            }
          });
          return bot.sendMessage(cid, `❌ \`${appName}\` already exists. Choose another.`, { parse_mode: 'Markdown' });
        } catch (e) {
          if (e.response && e.response.status === 404) {
            state.data.APP_NAME = appName;
            state.step = 'AUTO_STATUS_VIEW';
            return bot.sendMessage(cid, '📝 Enter AUTO_STATUS_VIEW ("no-dl" or "false"):');
          }
          throw e;
        }

      case 'AUTO_STATUS_VIEW':
        const v = text.toLowerCase();
        if (v !== 'no-dl' && v !== 'false') {
          return bot.sendMessage(cid, '⚠️ Must be "no-dl" or "false". Try again:');
        }
        state.data.AUTO_STATUS_VIEW = v;
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI (e.g. 👁️):');

      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text;
        bot.sendMessage(cid, '🚀 Deploying to Heroku…');
        await deployToHeroku(cid, state.data);
        delete userStates[cid];
        authorizedUsers.delete(cid); // revoke one-time access
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
    SESSION_ID:        vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW,
    STATUS_VIEW_EMOJI: vars.STATUS_VIEW_EMOJI,
    HEROKU_API_KEY:    HEROKU_API_KEY
  };

  // 1) Create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept:        'application/vnd.heroku+json; version=3'
    }
  });

  // 2) Set config vars
  await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, configVars, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept:        'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }
  });

  // 3) Trigger build
  await axios.post(`https://api.heroku.com/apps/${appName}/builds`, {
    source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` }
  }, {
    headers: {
      Authorization: `Bearer ${HEROKU_API_KEY}`,
      Accept:        'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }
  });

  // 4) Notify user
  bot.sendMessage(chatId,
    `✅ App deployed!\n🌐 https://${appName}.herokuapp.com`
  );
}
