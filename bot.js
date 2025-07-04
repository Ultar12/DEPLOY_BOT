require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// === Load app.json default env vars ===
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch (err) {
  console.error('⚠️ Failed to load app.json:', err.message);
}

// === Config from .env ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEROKU_API_KEY     = process.env.HEROKU_API_KEY;
const GITHUB_REPO_URL    = process.env.GITHUB_REPO_URL;
const ADMIN_ID           = process.env.ADMIN_ID;  // e.g. "123456789"

// === Init bot ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === In-memory state ===
const userStates      = {};        // { chatId: { step, data } }
const authorizedUsers = new Set(); // chatIds allowed to /deploy
const validKeys       = new Set(); // one-time 8-char uppercase keys

// === Util: generate one-time key ===
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

// === Global polling error handler ===
bot.on('polling_error', err => {
  console.error('[polling_error]', err.code, err.message);
});

// === /menu — show reply keyboard ===
bot.onText(/^\/menu$/, msg => {
  const cid = msg.chat.id;
  const keyboard = {
    keyboard: [
      ['🚀 Deploy', '📦 Apps'],
      ['🗑️ Delete', '📜 Logs'],
      ['🔐 Generate Key']
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
  bot.sendMessage(cid, '📲 Choose a command:', {
    reply_markup: keyboard
  });
});

// === /generate — Admin only: create one-time keys ===
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID)
    return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid,
    `🔑 Key generated: \`${key}\`\nShare this with a user for one deploy.`,
    { parse_mode: 'Markdown' }
  );
});

// === /start — prompt for key ===
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    authorizedUsers.add(cid);
    return bot.sendMessage(cid, '✅ Admin access granted.');
  }
  userStates[cid] = { step: 'AWAITING_KEY' };
  bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
});

// === /alive — health check ===
bot.onText(/^\/alive$/, msg => {
  const cid = msg.chat.id.toString();
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Lagos' });
  bot.sendMessage(cid, `✅ I'm alive!\n🕒 ${now}`);
});

// === /apps — Admin only: list Heroku apps ===
bot.onText(/^\/apps$/, async msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID)
    return bot.sendMessage(cid, '❌ Only admin can list apps.');
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3'
      }
    });
    if (!res.data.length)
      return bot.sendMessage(cid, '📭 No apps found.');
    const list = res.data.map(a => `• \`${a.name}\``).join('\n');
    bot.sendMessage(cid, `📦 Heroku Apps:\n${list}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// === /delete — Admin only: interactive delete ===
bot.onText(/^\/delete$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID)
    return bot.sendMessage(cid, '❌ Only admin can delete apps.');
  userStates[cid] = { step: 'AWAITING_DELETE_APP' };
  bot.sendMessage(cid, '🗑️ Enter the Heroku app name to delete:');
});

// === /log — Admin only: fetch recent logs ===
bot.onText(/^\/log (.+)$/, async (msg, match) => {
  const cid     = msg.chat.id.toString();
  const appName = match[1].trim();
  if (cid !== ADMIN_ID)
    return bot.sendMessage(cid, '❌ Only admin can fetch logs.');
  try {
    const session = await axios.post(
      `https://api.heroku.com/apps/${appName}/log-sessions`,
      { dyno: 'web', tail: false },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      }
    );
    const logs = (await axios.get(session.data.logplex_url)).data;
    if (logs.length < 4000) {
      return bot.sendMessage(cid,
        `📜 Logs for \`${appName}\`:\n\`\`\`\n${logs}\n\`\`\``,
        { parse_mode: 'Markdown' }
      );
    }
    const filePath = path.join(os.tmpdir(), `${appName}-logs.txt`);
    fs.writeFileSync(filePath, logs);
    await bot.sendDocument(cid, filePath, {}, {
      filename: `${appName}-logs.txt`,
      contentType: 'text/plain'
    });
    fs.unlinkSync(filePath);
  } catch (err) {
    bot.sendMessage(cid,
      `❌ Failed to fetch logs for \`${appName}\`: ${err.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// === /deploy — Interactive deploy flow ===
bot.onText(/^\/deploy$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid))
    return bot.sendMessage(cid, '❌ Not authorized. Use /start and enter a valid key.');
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Enter your SESSION_ID:');
});

// === Message handler: buttons, key, delete, deploy ===
bot.on('message', async msg => {
  const cid   = msg.chat.id.toString();
  const text  = msg.text || '';
  const state = userStates[cid];

  // Handle reply-keyboard buttons when not in a state
  if (!state) {
    if (text === '🚀 Deploy')  return bot.emit('text', { chat:{ id:cid }, text:'/deploy' });
    if (text === '📦 Apps')    return bot.emit('text', { chat:{ id:cid }, text:'/apps' });
    if (text === '🗑️ Delete')  return bot.emit('text', { chat:{ id:cid }, text:'/delete' });
    if (text === '📜 Logs')    return bot.sendMessage(cid, '📥 Please type: /log [app-name]');
    if (text === '🔐 Generate Key') return bot.emit('text',{chat:{id:cid},text:'/generate'});
    return; // nothing else to do when no state
  }

  // 1) One-time-key entry
  if (state.step === 'AWAITING_KEY') {
    const key = text.trim().toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      delete userStates[cid];
      return bot.sendMessage(cid, '✅ Key accepted! You may now use /deploy.');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key. Try again:');
  }

  // 2) Delete flow
  if (state.step === 'AWAITING_DELETE_APP') {
    const appToDelete = text.trim();
    try {
      await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      });
      bot.sendMessage(cid, `✅ App \`${appToDelete}\` deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(cid, `❌ Could not delete \`${appToDelete}\`: ${err.message}`, { parse_mode: 'Markdown' });
    }
    delete userStates[cid];
    return;
  }

  // 3) Deploy flow steps
  try {
    switch (state.step) {
      case 'SESSION_ID':
        if (text.length < 5)
          return bot.sendMessage(cid, '⚠️ SESSION_ID must be at least 5 characters.');
        state.data.SESSION_ID = text.trim();
        state.step = 'APP_NAME';
        return bot.sendMessage(cid, '📝 Enter APP_NAME (lowercase, no spaces):');

      case 'APP_NAME':
        const appName = text.toLowerCase().trim().replace(/\s+/g, '-');
        if (!/^[a-z0-9-]+$/.test(appName))
          return bot.sendMessage(cid, '⚠️ APP_NAME may only contain lowercase letters, numbers, and dashes:');
        try {
          await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept:        'application/vnd.heroku+json; version=3'
            }
          });
          return bot.sendMessage(cid, `❌ \`${appName}\` already exists. Choose another:`, { parse_mode: 'Markdown' });
        } catch (e) {
          if (e.response?.status === 404) {
            state.data.APP_NAME = appName;
            state.step = 'AUTO_STATUS_VIEW';
            return bot.sendMessage(cid, '📝 Enter AUTO_STATUS_VIEW (type "true" to enable):');
          }
          throw e;
        }

      case 'AUTO_STATUS_VIEW':
        if (text.toLowerCase() !== 'true')
          return bot.sendMessage(cid, '⚠️ Please type "true" to enable AUTO_STATUS_VIEW:');
        state.data.AUTO_STATUS_VIEW = 'no-dl';
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI (e.g. 👁️):');

      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text.trim();
        bot.sendMessage(cid, '🚀 Deploying to Heroku…');
        await deployToHeroku(cid, state.data);
        delete userStates[cid];
        authorizedUsers.delete(cid);
        return;
    }
  } catch (err) {
    delete userStates[cid];
    bot.sendMessage(cid, `❌ Error: ${err.message}`);
  }
});

// === Helper: deploy to Heroku ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // 1) Create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
  });

  // 2) Set buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
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
        'Content-Type': 'application/json'
      }
    }
  );

  // 3) Set config vars
  const configVars = {
    ...defaultEnvVars,
    SESSION_ID:        vars.SESSION_ID,
    AUTO_STATUS_VIEW:  vars.AUTO_STATUS_VIEW,
    STATUS_VIEW_EMOJI: vars.STATUS_VIEW_EMOJI,
    HEROKU_API_KEY
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    configVars,
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    }
  );

  // 4) Trigger build
  const buildRes = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
    {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    }
  );

  // 5) Poll build status
  const buildId = buildRes.data.id;
  const buildStatusUrl = `https://api.heroku.com/apps/${appName}/builds/${buildId}`;
  let status = 'pending', attempts = 0;
  while (status === 'pending' && attempts < 20) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(buildStatusUrl, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3'
      }
    });
    status = poll.data.status;
    attempts++;
  }

  // 6) Notify user
  if (status === 'succeeded') {
    bot.sendMessage(chatId, `✅ App deployed and live!\n🌐 https://${appName}.herokuapp.com`);
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}. Check your Heroku dashboard for details.`);
  }
          }
