const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// === CONFIG ===
const TELEGRAM_BOT_TOKEN = '7350697926:AAFNtsuGfJy4wOkA0Xuv_uY-ncx1fXPuTGI';
const HEROKU_API_KEY = 'HRKU-AAAMAdZpLGcOXNIsooI3esdjfzVJUaTHqBnaMYZJFjOA_____weN3O9gU6ep';
const GITHUB_REPO_URL = 'https://github.com/ultar1/lev';

// === INIT BOT ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === USER STATE TRACKING ===
const userStates = {};

// === /alive COMMAND ===
bot.onText(/\/alive/, (msg) => {
  const chatId = msg.chat.id;
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  bot.sendMessage(chatId, `✅ I'm alive and ready to deploy!\n🕒 ${now}`);
});

// === /apps COMMAND ===
bot.onText(/\/apps/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    if (res.data.length === 0) {
      return bot.sendMessage(chatId, '📭 No apps found in your Heroku account.');
    }

    const apps = res.data.map(app => `• ${app.name}`).join('\n');
    bot.sendMessage(chatId, `📦 Your Heroku Apps:\n\n${apps}`);
  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, `❌ Failed to fetch apps: ${err.message}`);
  }
});

// === /deploy COMMAND ===
bot.onText(/\/deploy/, (msg) => {
  const chatId = msg.chat.id;
  userStates[chatId] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(chatId, '📝 Please enter SESSION_ID:');
});

// === MESSAGE HANDLER ===
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!userStates[chatId] || text.startsWith('/')) return;

  const state = userStates[chatId];

  switch (state.step) {
    case 'SESSION_ID':
      if (!text || text.length < 5) {
        return bot.sendMessage(chatId, '⚠️ SESSION_ID must be at least 5 characters. Try again:');
      }
      state.data.SESSION_ID = text;
      state.step = 'APP_NAME';
      bot.sendMessage(chatId, '📝 Please enter APP_NAME (this will be your Heroku app name):');
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
        bot.sendMessage(chatId, `❌ The app name "${appName}" is already taken. Please choose another:`);
      } catch (err) {
        if (err.response && err.response.status === 404) {
          state.data.APP_NAME = appName;
          state.step = 'AUTO_STATUS_VIEW';
          bot.sendMessage(chatId, '📝 Please enter AUTO_STATUS_VIEW (true or false):');
        } else {
          bot.sendMessage(chatId, `❌ Error checking app name: ${err.message}`);
          delete userStates[chatId];
        }
      }
      break;

    case 'AUTO_STATUS_VIEW':
      const val = text.toLowerCase();
      if (val !== 'true' && val !== 'false') {
        return bot.sendMessage(chatId, '⚠️ Please enter "true" or "false" for AUTO_STATUS_VIEW:');
      }
      state.data.AUTO_STATUS_VIEW = val;
      state.step = 'STATUS_VIEW_EMOJI';
      bot.sendMessage(chatId, '📝 Please enter STATUS_VIEW_EMOJI (e.g. 👁️):');
      break;

    case 'STATUS_VIEW_EMOJI':
      state.data.STATUS_VIEW_EMOJI = text;
      bot.sendMessage(chatId, '🚀 Deploying your app to Heroku...');
      deployToHeroku(chatId, state.data);
      delete userStates[chatId];
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
    // 1. Create Heroku app
    await axios.post('https://api.heroku.com/apps', { name: appName }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    // 2. Set config vars
    await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`, configVars, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    });

    // 3. Trigger build from GitHub tarball
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

    // 4. Respond with app URL
    bot.sendMessage(chatId, `✅ App deployed!\n🌐 https://${appName}.herokuapp.com`);
  } catch (err) {
    console.error(err.message);
    bot.sendMessage(chatId, `❌ Deployment failed: ${err.message}`);
  }
}
