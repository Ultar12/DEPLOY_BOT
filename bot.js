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
const ADMIN_ID           = process.env.ADMIN_ID;     // Admin’s Telegram ID
const SUPPORT_USERNAME   = '@star_ies1';             // Support contact

// === Init bot ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === In-memory & persistent state ===
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
  if (isAdmin) {
    return [
      ['🚀 Deploy', '📦 Apps'],
      ['📜 Logs', '🗑️ Delete'],
      ['🔐 Generate Key', '🆘 Support']
    ];
  } else {
    return [
      ['🚀 Deploy', '📦 My App'],
      ['📜 Logs', '🆘 Support']
    ];
  }
}

// === Error handler ===
bot.on('polling_error', err => console.error('Poll error', err));

// === /start & /menu ===
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

// === Admin commands ===
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  }
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 Key: \`${key}\`\nShare it for one deploy.`,
    { parse_mode: 'Markdown' }
  );
});
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
    if (!res.data.length) {
      return bot.sendMessage(cid, '📭 No apps found.');
    }
    const list = res.data.map(a => `• \`${a.name}\``).join('\n');
    bot.sendMessage(cid, `📦 All Apps:\n${list}`, { parse_mode: 'Markdown' });
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});
bot.onText(/^\/delete$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can delete apps.');
  }
  userStates[cid] = { step: 'AWAITING_DELETE_APP' };
  bot.sendMessage(cid, '🗑️ Enter Heroku app name to delete:');
});

// === Fallback /deploy ===
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

// === Main message handler ===
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  const isAdmin = cid === ADMIN_ID;

  // --- Button presses reset any flow ---
  const buttonTexts = [
    '🚀 Deploy','📦 My App','📦 Apps',
    '📜 Logs','🗑️ Delete','🔐 Generate Key','🆘 Support'
  ];
  if (buttonTexts.includes(text)) {
    delete userStates[cid];
  }

  // 🚀 Deploy
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY' };
      return bot.sendMessage(cid, '🔐 Enter your one-time deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '📝 Enter your SESSION_ID:');
  }

  // 📦 My App
  if (text === '📦 My App' && !isAdmin) {
    const apps = userApps[cid] || [];
    if (!apps.length) {
      return bot.sendMessage(cid, '📭 No deployed apps.');
    }
    const list = apps.map(a => `• \`${a}\``).join('\n');
    return bot.sendMessage(cid, `📦 Your Apps:\n${list}`, { parse_mode: 'Markdown' });
  }

  // 📦 Apps (admin)
  if (text === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat: { id: cid }, text: '/apps' });
  }

  // 📜 Logs → inline buttons
  if (text === '📜 Logs') {
    if (isAdmin) {
      // admin: fetch all apps
      try {
        const res = await axios.get('https://api.heroku.com/apps', {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept:        'application/vnd.heroku+json; version=3'
          }
        });
        const apps = res.data.map(a => a.name);
        if (!apps.length) return bot.sendMessage(cid, '📭 No apps found.');
        const kb = apps.map(name => [{ text: name, callback_data: `logs:${name}` }]);
        return bot.sendMessage(cid, '📜 Choose app for logs:', {
          reply_markup: { inline_keyboard: kb }
        });
      } catch (err) {
        return bot.sendMessage(cid, `❌ Error fetching apps: ${err.message}`);
      }
    } else {
      // user: use their apps
      const apps = userApps[cid] || [];
      if (!apps.length) {
        return bot.sendMessage(cid, '📭 No deployed apps.');
      }
      const kb = apps.map(name => [{ text: name, callback_data: `logs:${name}` }]);
      return bot.sendMessage(cid, '📜 Choose app for logs:', {
        reply_markup: { inline_keyboard: kb }
      });
    }
  }

  // 🗑️ Delete
  if (text === '🗑️ Delete' && isAdmin) {
    userStates[cid] = { step: 'AWAITING_DELETE_APP' };
    return bot.sendMessage(cid, '🗑️ Enter Heroku app name to delete:');
  }

  // 🔐 Generate Key
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 Key: \`${key}\``, { parse_mode: 'Markdown' });
  }

  // 🆘 Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `🆘 Support Contact: ${SUPPORT_USERNAME}`);
  }

  // --- Stateful flows ---
  const state = userStates[cid];
  if (!state) return;

  // 1) One-time key entry
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      delete userStates[cid];
      // notify admin
      const name = `${msg.from.first_name||''} ${msg.from.last_name||''}`.trim();
      const un = msg.from.username ? `@${msg.from.username}` : 'No username';
      bot.sendMessage(ADMIN_ID,
        `🔔 Key used by:\nName: ${name}\nUsername: ${un}\nID: ${cid}`
      );
      return bot.sendMessage(cid, '✅ Key accepted! Tap 🚀 Deploy.');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key.');
  }

  // 2) Delete flow
  if (state.step === 'AWAITING_DELETE_APP') {
    const toDelete = text;
    try {
      await axios.delete(`https://api.heroku.com/apps/${toDelete}`, {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept:        'application/vnd.heroku+json; version=3'
        }
      });
      bot.sendMessage(cid, `✅ Deleted \`${toDelete}\`.`, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(cid, `❌ Delete failed: ${err.message}`);
    }
    delete userStates[cid];
    return;
  }

  // 3) Deploy flow
  try {
    switch (state.step) {
      case 'SESSION_ID':
        if (!text || text.length < 5) {
          return bot.sendMessage(cid, '⚠️ SESSION_ID at least 5 chars.');
        }
        state.data.SESSION_ID = text;
        state.step = 'APP_NAME';
        return bot.sendMessage(cid, '📝 Enter APP_NAME:');

      case 'APP_NAME':
        const name = text.toLowerCase().replace(/\s+/g,'-');
        if (!/^[a-z0-9-]+$/.test(name)) {
          return bot.sendMessage(cid, '⚠️ Invalid APP_NAME format.');
        }
        try {
          await axios.get(`https://api.heroku.com/apps/${name}`, {
            headers: {
              Authorization: `Bearer ${HEROKU_API_KEY}`,
              Accept:        'application/vnd.heroku+json; version=3'
            }
          });
          return bot.sendMessage(cid, `❌ \`${name}\` exists.`);
        } catch (e) {
          if (e.response?.status === 404) {
            state.data.APP_NAME = name;
            state.step = 'AUTO_STATUS_VIEW';
            return bot.sendMessage(cid,
              '📝 Enter AUTO_STATUS_VIEW (type "true"):'
            );
          }
          throw e;
        }

      case 'AUTO_STATUS_VIEW':
        if (text.toLowerCase() !== 'true') {
          return bot.sendMessage(cid, '⚠️ Type "true" to enable.');
        }
        state.data.AUTO_STATUS_VIEW = 'no-dl';
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI:');

      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text;
        bot.sendMessage(cid, '🕓 Build queued...');
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

// === Inline logs handler ===
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const data = query.data;
  if (!data.startsWith('logs:')) {
    return bot.answerCallbackQuery(query.id);
  }
  const appName = data.split(':')[1];
  await bot.answerCallbackQuery(query.id);
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
    const fp = path.join(os.tmpdir(), `${appName}-logs.txt`);
    fs.writeFileSync(fp, logs);
    await bot.sendDocument(cid, fp);
    fs.unlinkSync(fp);
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch logs: ${err.message}`);
  }
});

// === Deploy helper with status updates ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // Create app
  await axios.post('https://api.heroku.com/apps',
    { name: appName },
    { headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:        'application/vnd.heroku+json; version=3'
      }
    }
  );

  // Buildpacks
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

  // Config vars
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

  // Trigger build
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

  // Poll status
  const buildId = buildRes.data.id;
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${buildId}`;
  let status = buildRes.data.status;
  let attempts = 0;

  // Notify build start
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

  // Final result
  if (status === 'succeeded') {
    // persist user app
    if (!userApps[chatId]) userApps[chatId] = [];
    userApps[chatId].push(appName);
    saveUserApps();
    await bot.sendMessage(chatId,
      `✅ Deployed!\n🌐 https://${appName}.herokuapp.com`
    );
  } else {
    await bot.sendMessage(chatId,
      `❌ Build ${status}. Check dashboard.`
    );
  }
       }
