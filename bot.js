const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// === CONFIG ===
const TELEGRAM_BOT_TOKEN = '7350697926:AAFNtsuGfJy4wOkA0Xuv_uY-ncx1fXPuTGI';
const HEROKU_API_KEY = 'HRKU-AAAMAdZpLGcOXNIsooI3esdjfzVJUaTHqBnaMYZJFjOA_____weN3O9gU6ep';
const GITHUB_REPO_URL = 'https://github.com/ultar1/lev'; // your repo

// === INIT BOT ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === DEPLOY HANDLER ===
bot.onText(/\/deploy(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const appName = `levanter-${Date.now()}`;

  // Parse config vars from command
  const input = match[1] || '';
  const configVars = input.split(/\s+/).reduce((acc, pair) => {
    const [key, ...rest] = pair.split('=');
    if (key && rest.length) acc[key] = rest.join('=');
    return acc;
  }, {});

  // Always include HEROKU_API_KEY
  configVars.HEROKU_API_KEY = HEROKU_API_KEY;

  bot.sendMessage(chatId, `🚀 Creating Heroku app: ${appName}...`);

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
});
