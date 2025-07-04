const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');

// === CONFIG ===
const TELEGRAM_BOT_TOKEN = '7350697926:AAFNtsuGfJy4wOkA0Xuv_uY-ncx1fXPuTGI';
const HEROKU_API_KEY = 'HRKU-AAAMAdZpLGcOXNIsooI3esdjfzVJUaTHqBnaMYZJFjOA_____weN3O9gU6ep';
const GITHUB_REPO_URL = 'https://github.com/ultar1/lev';
const ADMIN_ID = '7302005705'; // your Telegram user ID

// === INIT BOT ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === STATE ===
const userStates = {};
const authorizedUsers = new Set();
const validKeys = new Set();

// === /generate (admin only) ===
bot.onText(/\/generate/, (msg) => {
  const chatId = msg.chat.id.toString();
  if (chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ You are not authorized to generate keys.');

  const key = crypto.randomBytes(4).toString('hex');
  validKeys.add(key);
  bot.sendMessage(chatId, `🔑 Key generated: \`${key}\`\nShare this with a user to allow one deploy.`, { parse_mode: 'Markdown' });
});

// === /start (user enters key) ===
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🔐 Please enter your one-time deploy key:');
  userStates[chatId] = { step: 'AWAITING_KEY' };
});

// === /alive ===
bot.onText(/\/alive/, (msg) => {
  const chatId = msg.chat.id;
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  bot.sendMessage(chatId, `✅ I'm alive and ready to deploy!\n🕒 ${now}`);
});

// === /apps (admin only) ===
bot.onText(/\/apps/, async (msg) => {
  const chatId = msg.chat.id.toString();
  if (chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Only the admin can use this command.');

  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    if (res.data.length === 0) return bot.sendMessage(chatId, '📭 No apps found.');
    const apps = res.data.map(app => `• ${app.name}`).join('\n');
    bot.sendMessage(chatId, `📦 Your Heroku Apps:\n\n${apps}`);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to fetch apps: ${err.message}`);
  }
});

// === /delete app-name (admin only) ===
bot.onText(/\/delete (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  if (chatId !== ADMIN_ID) return bot.sendMessage(chatId, '❌ Only the admin can delete apps.');

  const appName = match[1].trim();
  try {
    await axios.delete(`https://api.heroku.com/apps/${appName}`, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    bot.sendMessage(chatId, `🗑️ App "${appName}" deleted.`);
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to delete "${appName}": ${err.message}`);
  }
});

// === /deploy ===
bot.onText(/\/deploy/, (msg) => {
  const chatId = msg.chat.id;
  if (!authorizedUsers.has(chatId)) return bot.sendMessage(chatId, '❌ You are not authorized. Use /start with a valid key.');

  userStates[chatId] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(chatId, '📝 Please enter SESSION_ID:');
});

// === MESSAGE HANDLER ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!userStates[chatId] || text.startsWith('/')) return;

  const state = userStates[chatId];

  // Handle key entry
  if (state.step === 'AWAITING_KEY') {
    if (validKeys.has(text)) {
      validKeys.delete(text);
      authorizedUsers.add(chatId);
      delete userStates[chatId];
      return bot.sendMessage(chatId, '✅ Key accepted! You can now use /deploy.');
    } else {
      return bot.sendMessage(chatId, '❌ Invalid or expired key.');
    }
  }

  // Handle deploy flow
  switch (state.step) {
    case 'SESSION_ID':
      if (!text || text.length < 5) return bot.sendMessage(chatId, '⚠️ SESSION_ID must be at least 5 characters.');
      state.data.SESSION_ID = text;
      state.step = 'APP_NAME';
      bot.sendMessage(chatId, '📝 Enter APP_NAME (Heroku app name):');
      break;

    case 'APP_NAME':
      const appName = text.toLowerCase().replace(/\s+/g, '-');
      try {
        await axios.get(`https://api.heroku.com/apps/${appName}`, {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
          }
        });
        bot.sendMessage(chatId, `❌ The app name "${appName}" is already taken. Try another:`);
      } catch (err) {
        if (err.response && err.response.status === 404) {
          state.data.APP_NAME = appName;
          state.step = 'AUTO_STATUS_VIEW';
          bot.sendMessage(chatId, '📝 Enter AUTO_STATUS_VIEW (must be "no-dl" or "false"):');
        } else {
          bot.sendMessage(chatId, `❌ Error checking app name: ${err.message}`);
          delete userStates[chatId];
        }
      }
      break;

    case 'AUTO_STATUS_VIEW':
      const val = text.toLowerCase();
      if (val !== 'no-dl' && val !== 'false') {
        return bot.sendMessage(chatId, '⚠️ AUTO_STATUS_VIEW must be "no-dl" or "false". Try again:');
      }
      state.data.AUTO_STATUS_VIEW = val;
      state.step = 'STATUS_VIEW_EMOJI';
      bot.sendMessage(chatId, '📝 Enter STATUS_VIEW_EMOJI (e.g. 👁️):');
      break;

    case 'STATUS_VIEW_EMOJI':
      state.data.STATUS_VIEW_EMOJI = text;
      bot.sendMessage(chatId, '🚀 Deploying to Heroku...');
      deployToHeroku(chatId, state.data);
      delete userStates[chatId];
      authorizedUsers.delete(chatId); // revoke access after deploy
      break;
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

  try {
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
  } catch (err) {
    bot.sendMessage(chatId, `❌ Deployment failed: ${err.message}`);
  }
}
