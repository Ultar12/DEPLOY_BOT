require('dotenv').config();
const fs          = require('fs');
const os          = require('os');
const path        = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');

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
const ADMIN_ID           = process.env.ADMIN_ID;       // Admin chat ID for notifications
const SUPPORT_USERNAME   = '@star_ies1';               // Support contact username

// === Init bot ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === In-memory state ===
const userStates      = {};        // { chatId: { step, data } }
const authorizedUsers = new Set(); // chatIds that used a valid key
const validKeys       = new Set(); // one-time deploy keys
const userApps        = {};        // { chatId: [appName...] }

// === Utility: generate one-time key ===
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars.charAt(Math.floor(Math.random() * chars.length)))
    .join('');
}

// === Utility: build keyboard layout ===
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

// === Global polling error handler ===
bot.on('polling_error', err => console.error('Poll error', err));

// === /start — reset and show keyboard ===
bot.onText(/^\/start$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);

  bot.sendMessage(cid,
    `👋 Welcome${isAdmin ? ' Admin' : ''}!`,
    {
      reply_markup: {
        keyboard: buildKeyboard(isAdmin),
        resize_keyboard: true,
        one_time_keyboard: false
      }
    }
  );
});

// === /menu — show keyboard on demand ===
bot.onText(/^\/menu$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: {
      keyboard: buildKeyboard(isAdmin),
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
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
    `🔑 Key generated: \`${key}\`\nShare this with a user for one deploy.`,
    { parse_mode: 'Markdown' }
  );
});

// === /apps — Admin only: list Heroku apps ===
bot.onText(/^\/apps$/, async msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can list all apps.');
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

// === /delete — Admin only: start delete flow ===
bot.onText(/^\/delete$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can delete apps.');
  }
  userStates[cid] = { step: 'AWAITING_DELETE_APP' };
  bot.sendMessage(cid, '🗑️ Enter the Heroku app name to delete:');
});

// === /log — Admin only: fetch logs ===
bot.onText(/^\/log (.+)$/, async (msg, match) => {
  const cid     = msg.chat.id.toString();
  const appName = match[1].trim();
  if (cid !== ADMIN_ID) {
    return bot.sendMessage(cid, '❌ Only admin can fetch logs.');
  }
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
    await bot.sendDocument(cid, fp, {}, {
      filename: `${appName}-logs.txt`,
      contentType: 'text/plain'
    });
    fs.unlinkSync(fp);
  } catch (err) {
    bot.sendMessage(cid,
      `❌ Failed to fetch logs for \`${appName}\`: ${err.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// === /deploy — fallback in case someone types it ===
bot.onText(/^\/deploy$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    userStates[cid] = { step: 'AWAITING_KEY' };
    return bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
  }
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Enter your SESSION_ID:');
});

// === Main message handler: buttons and flows ===
bot.on('message', async msg => {
  const cid     = msg.chat.id.toString();
  const text    = msg.text?.trim();
  const isAdmin = cid === ADMIN_ID;

  // --- Button handling (always first) ---
  // Reset any in-progress flow on new button press
  if (
    text === '🚀 Deploy' ||
    text === '📦 My App' ||
    text === '📦 Apps' ||
    text === '📜 Logs' ||
    text === '🗑️ Delete' ||
    text === '🔐 Generate Key' ||
    text === '🆘 Support'
  ) {
    delete userStates[cid];
  }

  // 🚀 Deploy button
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY' };
      return bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '📝 Enter your SESSION_ID:');
  }

  // 📦 My App (user)
  if (text === '📦 My App' && !isAdmin) {
    const apps = userApps[cid] || [];
    if (!apps.length) {
      return bot.sendMessage(cid, '📭 You haven’t deployed any apps yet.');
    }
    const list = apps.map(a => `• \`${a}\``).join('\n');
    return bot.sendMessage(cid, `📦 Your Apps:\n${list}`, { parse_mode: 'Markdown' });
  }

  // 📦 Apps (admin)
  if (text === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat: { id: cid }, text: '/apps' });
  }

  // 📜 Logs
  if (text === '📜 Logs') {
    return bot.sendMessage(cid,
      isAdmin
        ? '📥 Please type: /log [app-name]'
        : '📥 Please type: /log [your-app-name]'
    );
  }

  // 🗑️ Delete (admin)
  if (text === '🗑️ Delete' && isAdmin) {
    userStates[cid] = { step: 'AWAITING_DELETE_APP' };
    return bot.sendMessage(cid, '🗑️ Enter the Heroku app name to delete:');
  }

  // 🔐 Generate Key (admin)
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 Key generated: \`${key}\``, { parse_mode: 'Markdown' });
  }

  // 🆘 Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid,
      `🆘 Support Contact: ${SUPPORT_USERNAME}`
    );
  }

  // --- Continue with stateful flows ---
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
      const username = msg.from.username ? `@${msg.from.username}` : 'No username';
      const info = `🔔 Key used by user:\nName: ${name}\nUsername: ${username}\nID: ${cid}`;
      bot.sendMessage(ADMIN_ID, info);

      return bot.sendMessage(cid, '✅ Key accepted! Now tap 🚀 Deploy.');
    }
    return bot.sendMessage(cid, '❌ Invalid or expired key. Try again:');
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
      bot.sendMessage(cid, `✅ App \`${toDelete}\` deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      bot.sendMessage(cid, `❌ Could not delete \`${toDelete}\`: ${err.message}`, { parse_mode: 'Markdown' });
    }
    delete userStates[cid];
    return;
  }

  // 3) Deploy flow
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
        if (!/^[a-z0-9-]+$/.test(appName)) {
          return bot.sendMessage(cid, '⚠️ APP_NAME may only contain lowercase letters, numbers, and dashes.');
        }
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
            return bot.sendMessage(cid, '📝 Enter AUTO_STATUS_VIEW (type "true" to enable):');
          }
          throw e;
        }

      case 'AUTO_STATUS_VIEW':
        if (text.toLowerCase() !== 'true') {
          return bot.sendMessage(cid, '⚠️ Please type "true" to enable AUTO_STATUS_VIEW.');
        }
        state.data.AUTO_STATUS_VIEW = 'no-dl';
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI (e.g. 👁️):');

      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text;
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

// === Helper: Deploy to Heroku ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // 1) Create new Heroku app
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

  // 3) Configure environment variables
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

  // 4) Trigger build from GitHub tarball
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

  // 5) Poll build status
  let status = buildRes.data.status;
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${buildRes.data.id}`;
  let attempts = 0;
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

  // 6) Save user app and notify
  if (status === 'succeeded') {
    if (!userApps[chatId]) userApps[chatId] = [];
    userApps[chatId].push(appName);
    bot.sendMessage(chatId,
      `✅ App deployed and live!\n🌐 https://${appName}.herokuapp.com`
    );
  } else {
    bot.sendMessage(chatId,
      `❌ Build ${status}. Check your Heroku dashboard for details.`
    );
  }
                      }
