require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// === Load default env vars from app.json ===
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
const ADMIN_ID           = process.env.ADMIN_ID;
const SUPPORT_USERNAME   = '@star_ies1';

// === Initialize Telegram Bot ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === In-memory & Persistent State ===
const userStates      = {};        // { chatId: { step, data } }
const authorizedUsers = new Set(); // chatIds that used a valid key
const validKeys       = new Set(); // one-time deploy keys

const userAppsPath = 'userApps.json';
let userApps = {};
if (fs.existsSync(userAppsPath)) {
  try {
    userApps = JSON.parse(fs.readFileSync(userAppsPath, 'utf8'));
  } catch (err) {
    console.error('⚠️ Could not parse userApps.json:', err.message);
  }
}
function saveUserApps() {
  fs.writeFileSync(userAppsPath, JSON.stringify(userApps, null, 2));
}

// === Utilities ===
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}
function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['🚀 Deploy', '📦 Apps'], ['📜 Logs', '🗑️ Delete'], ['🔐 Generate Key', '🆘 Support']]
    : [['🚀 Deploy', '📦 My App'], ['📜 Logs', '🆘 Support']];
}

// === Global Error Handler ===
bot.on('polling_error', err => console.error('Polling error:', err));

// === /start & /menu Commands ===
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);
  bot.sendMessage(cid, `👋 Welcome${isAdmin ? ' Admin' : ''}!`, {
    reply_markup: {
      keyboard: buildKeyboard(isAdmin),
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});
bot.onText(/^\/menu$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: {
      keyboard: buildKeyboard(isAdmin),
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

// === Admin Commands ===
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID)
    return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid,
    `🔑 One-time Key: \`${key}\`\nShare this for one deploy.`,
    { parse_mode: 'Markdown' }
  );
});

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
    bot.sendMessage(cid, `📦 All Heroku Apps:\n${list}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// === Fallback /deploy Command ===
bot.onText(/^\/deploy$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    userStates[cid] = { step: 'AWAITING_KEY' };
    return bot.sendMessage(cid, '🔐 Enter your one-time deploy key:');
  }
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Enter your SESSION_ID:');
});

// === Main Message Handler ===
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  const isAdmin = cid === ADMIN_ID;

  // Reset any in-progress flow on button press
  const buttons = ['🚀 Deploy','📦 My App','📦 Apps','📜 Logs','🗑️ Delete','🔐 Generate Key','🆘 Support'];
  if (buttons.includes(text)) delete userStates[cid];

  // 🚀 Deploy button
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY' };
      return bot.sendMessage(cid, '🔐 Enter your one-time deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '📝 Enter your SESSION_ID:');
  }

  // 📦 My App (user)
  if (text === '📦 My App' && !isAdmin) {
    const apps = userApps[cid] || [];
    if (!apps.length)
      return bot.sendMessage(cid, '📭 You haven’t deployed any apps yet.');
    const list = apps.map(a => `• \`${a}\``).join('\n');
    return bot.sendMessage(cid, `📦 Your Apps:\n${list}`, { parse_mode: 'Markdown' });
  }

  // 📦 Apps (admin)
  if (text === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat: { id: cid }, text: '/apps' });
  }

  // 📜 Logs → inline buttons
  if (text === '📜 Logs') {
    let apps = [];
    if (isAdmin) {
      try {
        const res = await axios.get('https://api.heroku.com/apps', {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
          }
        });
        apps = res.data.map(a => a.name);
      } catch (err) {
        return bot.sendMessage(cid, `❌ Error fetching apps: ${err.message}`);
      }
    } else {
      apps = userApps[cid] || [];
    }
    if (!apps.length)
      return bot.sendMessage(cid, '📭 No apps found.');
    const kb = apps.map(name => [{ text: `📜 ${name}`, callback_data: `logs:${name}` }]);
    return bot.sendMessage(cid, '📜 Choose an app for logs:', {
      reply_markup: { inline_keyboard: kb }
    });
  }

  // 🗑️ Delete → inline buttons (admin)
  if (text === '🗑️ Delete' && isAdmin) {
    try {
      const res = await axios.get('https://api.heroku.com/apps', {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      const apps = res.data.map(a => a.name);
      if (!apps.length)
        return bot.sendMessage(cid, '📭 No apps found.');
      const kb = apps.map(name => [{ text: `🗑️ ${name}`, callback_data: `delete:${name}` }]);
      return bot.sendMessage(cid, '🗑️ Choose an app to delete:', {
        reply_markup: { inline_keyboard: kb }
      });
    } catch (err) {
      return bot.sendMessage(cid, `❌ Error fetching apps: ${err.message}`);
    }
  }

  // 🔐 Generate Key button
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
  }

  // 🆘 Support button
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `🆘 Support Contact: ${SUPPORT_USERNAME}`);
  }

  // === Stateful Flows ===
  const state = userStates[cid];
  if (!state) return;

  // 1) One-time key entry
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      delete userStates[cid];
      // Notify admin
      const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
      const un   = msg.from.username ? `@${msg.from.username}` : 'No username';
      bot.sendMessage(ADMIN_ID,
        `🔔 Key used by:\nName: ${name}\nUsername: ${un}\nID: ${cid}`
      );
      return bot.sendMessage(cid, '✅ Key accepted! Now tap 🚀 Deploy.');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key. Try again.');
  }

  // 3) Deploy flow
  try {
    switch (state.step) {
      case 'SESSION_ID':
        if (!text || text.length < 5)
          return bot.sendMessage(cid, '⚠️ SESSION_ID must be at least 5 characters.');
        state.data.SESSION_ID = text;
        state.step = 'APP_NAME';
        return bot.sendMessage(cid, '📝 Enter APP_NAME (lowercase, no spaces):');

      case 'APP_NAME':
        const appName = text.toLowerCase().replace(/\s+/g, '-');
        if (!/^[a-z0-9-]+$/.test(appName))
          return bot.sendMessage(cid, '⚠️ Invalid APP_NAME format.');
        try {
          await axios.get(`https://api.heroku.com/apps/${appName}`, {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept:        'application/vnd.heroku+json; version=3'
            }
          });
          return bot.sendMessage(cid, `❌ \`${appName}\` already exists. Choose another.`);
        } catch (e) {
          if (e.response?.status === 404) {
            state.data.APP_NAME = appName;
            state.step = 'AUTO_STATUS_VIEW';
            return bot.sendMessage(cid, '📝 Enter AUTO_STATUS_VIEW (type "true"):');
          }
          throw e;
        }

      case 'AUTO_STATUS_VIEW':
        if (text.toLowerCase() !== 'true')
          return bot.sendMessage(cid, '⚠️ Please type "true" to enable.');
        state.data.AUTO_STATUS_VIEW = 'no-dl';
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI (e.g. 👁️):');

      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text;
        await bot.sendMessage(cid, '🕓 Build queued...');
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

// === Inline Callback Handler (logs & delete) ===
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const [action, name] = query.data.split(':');
  await bot.answerCallbackQuery(query.id);

  if (action === 'logs') {
    try {
      const session = await axios.post(
        `https://api.heroku.com/apps/${name}/log-sessions`,
        { dyno: 'web', tail: false },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
          }
        }
      );
      const logs = (await axios.get(session.data.logplex_url)).data;
      if (logs.length < 4000) {
        return bot.sendMessage(cid,
          `📜 Logs for \`${name}\`:\n\`\`\`\n${logs}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      }
      const fp = path.join(os.tmpdir(), `${name}-logs.txt`);
      fs.writeFileSync(fp, logs);
      await bot.sendDocument(cid, fp);
      fs.unlinkSync(fp);
    } catch (err) {
      bot.sendMessage(cid, `❌ Could not fetch logs: ${err.message}`);
    }
  }

  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${name}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      await bot.sendMessage(cid, `✅ App \`${name}\` deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      await bot.sendMessage(cid, `❌ Delete failed: ${err.message}`, { parse_mode: 'Markdown' });
    }
  }
});

// === Deploy Helper with Status Updates ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // 1) Create app
  await axios.post('https://api.heroku.com/apps',
    { name: appName },
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3'
      }
    }
  );

  // 2) Set buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    { updates: [
        { buildpack: 'https://github.com/heroku/heroku-buildpack-apt' },
        { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
        { buildpack: 'heroku/nodejs' }
      ]
    },
    { headers: {
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
    STATUS_VIEW_EMOJI: vars.STATUS_VIEW_EMOJI
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    configVars,
    { headers: {
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
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3',
        'Content-Type': 'application/json'
      }
    }
  );

  // 5) Poll status
  let status = buildRes.data.status;
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${buildRes.data.id}`;
  let attempts = 0;
  await bot.sendMessage(chatId, '🛠️ Building...');
  while (status === 'pending' && attempts < 20) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(statusUrl, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3'
      }
    });
    status = poll.data.status;
    attempts++;
  }

  // 6) Final result and save user app
  if (status === 'succeeded') {
    if (!userApps[chatId]) userApps[chatId] = [];
    userApps[chatId].push(appName);
    saveUserApps();
    await bot.sendMessage(chatId,
      `✅ Deployed!\n🌐 https://${appName}.herokuapp.com`
    );
  } else {
    await bot.sendMessage(chatId,
      `❌ Build ${status}. Check your Heroku dashboard.`
    );
  }
  }
