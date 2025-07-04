require('dotenv').config();  // Load .env

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const crypto      = require('crypto');

// === CONFIG FROM .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEROKU_API_KEY     = process.env.HEROKU_API_KEY;
const GITHUB_REPO_URL    = process.env.GITHUB_REPO_URL;
const ADMIN_ID           = process.env.ADMIN_ID;  // e.g. "7302005705"

// === INIT BOT ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === IN-MEMORY STATE ===
const userStates      = {};         // { chatId: { step, data } }
const authorizedUsers = new Set();  // chatIds allowed to /deploy
const validKeys       = new Set();  // one-time 8-char uppercase keys

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
bot.onText(/^\/generate$/, msg => {
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

// === /start — All users begin here ===
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    authorizedUsers.add(cid);
    return bot.sendMessage(cid, '✅ Admin access granted. You may use all commands.');
  }
  userStates[cid] = { step: 'AWAITING_KEY' };
  bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
});

// === /alive — Healthcheck ===
bot.onText(/^\/alive$/, msg => {
  const cid = msg.chat.id;
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  bot.sendMessage(cid, `✅ I'm alive and ready!\n🕒 ${now}`);
});

// === /apps — Admin only: list Heroku apps ===
bot.onText(/^\/apps$/, async msg => {
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
    if (res.data.length === 0) {
      return bot.sendMessage(cid, '📭 No apps found.');
    }
    const list = res.data.map(a => `• \`${a.name}\``).join('\n');
    bot.sendMessage(cid, `📦 Heroku Apps:\n${list}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// === /delete — Admin only: interactive delete ===
bot.onText(/^\/delete$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can delete apps.');
  }
  userStates[cid] = { step: 'AWAITING_DELETE_APP' };
  bot.sendMessage(cid, '🗑️ Enter the name of the Heroku app you want to delete:');
});

// === /deploy — Interactive deploy flow ===
bot.onText(/^\/deploy$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    return bot.sendMessage(cid, '❌ Not authorized. Use /start and enter a valid key.');
  }
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Please enter SESSION_ID:');
});

// === MESSAGE HANDLER: keys, delete, and deploy flows ===
bot.on('message', async msg => {
  const cid   = msg.chat.id.toString();
  const text  = msg.text;
  const state = userStates[cid];

  // 1) No active flow & slash command → ignore
  if (!state && text.startsWith('/')) return;

  // 2) Handle one-time key entry
  if (state && state.step === 'AWAITING_KEY') {
    if (text.startsWith('/')) return;  // ignore commands while waiting key

    const key = text.trim().toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      delete userStates[cid];
      return bot.sendMessage(cid, '✅ Key accepted! You may now use /deploy.');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key. Please try again:');
  }

  // 3) Handle interactive delete
  if (state && state.step === 'AWAITING_DELETE_APP') {
    const appToDelete = text.trim();
    try {
      await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      });
      bot.sendMessage(cid,
        `✅ App \`${appToDelete}\` deleted.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      bot.sendMessage(cid,
        `❌ Could not delete \`${appToDelete}\`: ${err.message}`,
        { parse_mode: 'Markdown' }
      );
    }
    delete userStates[cid];
    return;
  }

  // 4) Not in any flow → ignore
  if (!state) return;

  // 5) Deploy flow
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
          return bot.sendMessage(cid,
            `❌ \`${appName}\` already exists. Choose another.`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {
          if (e.response && e.response.status === 404) {
            state.data.APP_NAME = appName;
            state.step = 'AUTO_STATUS_VIEW';
            return bot.sendMessage(cid,
              '📝 Enter AUTO_STATUS_VIEW (type "true" to enable):'
            );
          }
          throw e;
        }

      case 'AUTO_STATUS_VIEW':
        if (text.toLowerCase() !== 'true') {
          return bot.sendMessage(cid,
            '⚠️ Please type "true" to enable AUTO_STATUS_VIEW:'
          );
        }
        state.data.AUTO_STATUS_VIEW = 'no-dl';  // always store as "no-dl"
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI (e.g. 👁️):');

      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text;
        bot.sendMessage(cid, '🚀 Deploying to Heroku…');
        await deployToHeroku(cid, state.data);
        delete userStates[cid];
        authorizedUsers.delete(cid);  // revoke one-time access
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

// === HELPER: Perform the Heroku deploy steps ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  const configVars = {
    SESSION_ID:        vars.SESSION_ID,
    AUTO_STATUS_VIEW:  vars.AUTO_STATUS_VIEW,
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
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    configVars,
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
      }
    }
  );

  // 3) Trigger build from GitHub tarball
  await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type':'application/json'
      }
    }
  );

  // 4) Notify user
  bot.sendMessage(
    chatId,
    `✅ App deployed!\n🌐 https://${appName}.herokuapp.com`
  );
}
