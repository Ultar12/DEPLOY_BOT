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

// === Init bot ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === In-memory & persistent state ===
const userStates      = {};        // { chatId: { step, data } }
const authorizedUsers = new Set(); // chatIds that used a valid key
const validKeys       = new Set(); // one-time deploy keys

// persistent user apps
const userAppsPath = 'userApps.json';
let userApps = {};
if (fs.existsSync(userAppsPath)) {
  try {
    userApps = JSON.parse(fs.readFileSync(userAppsPath, 'utf8'));
  } catch {}
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
    ? [['🚀 Deploy','📦 Apps'], ['📜 Logs','🗑️ Delete'], ['🔐 Generate Key','🧾 Get Session'], ['🆘 Support']]
    : [['🚀 Deploy','📦 My App'], ['📜 Logs','🧾 Get Session'], ['🆘 Support']];
}
// chunk array into rows of given size
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// === Global error handler ===
bot.on('polling_error', console.error);

// === /start & /menu ===
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);
  bot.sendMessage(cid, `👋 Welcome${isAdmin ? ' Admin' : ''}!`, {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});
bot.onText(/^\/menu$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// === Admin: generate one-time key ===
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
});

// === Admin: list Heroku apps ===
bot.onText(/^\/apps$/, async msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can list apps.');
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    const total = apps.length;
    // inline buttons, 5 per row
    const rows = chunkArray(apps, 5).map(row =>
      row.map(name => ({ text: name, callback_data: `logs:${name}` }))
    );
    bot.sendMessage(cid,
      `📦 Total Apps: ${total}\nChoose one to view logs:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// === Fallback /deploy command ===
bot.onText(/^\/deploy$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    userStates[cid] = { step: 'AWAITING_KEY', data: {} };
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

  // reset any flow on button press
  const btns = ['🚀 Deploy','📦 My App','📦 Apps','📜 Logs','🗑️ Delete','🔐 Generate Key','🧾 Get Session','🆘 Support'];
  if (btns.includes(text)) delete userStates[cid];

  // 🚀 Deploy button
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid, '🔐 Enter your one-time deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '📝 Enter your SESSION_ID:');
  }

  // 📦 My App (user)
  if (text === '📦 My App' && !isAdmin) {
    const apps = userApps[cid] || [];
    if (!apps.length) return bot.sendMessage(cid, '📭 You haven’t deployed any apps yet.');
    const list = apps.map(a => `• \`${a}\``).join('\n');
    return bot.sendMessage(cid, `📦 Your Apps:\n${list}`, { parse_mode: 'Markdown' });
  }

  // 📦 Apps (admin, button)
  if (text === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat: { id: cid }, text: '/apps' });
  }

  // 📜 Logs button
  if (text === '📜 Logs') {
    let appsList = isAdmin
      ? (await axios.get('https://api.heroku.com/apps', {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
          }
        })).data.map(a => a.name)
      : userApps[cid] || [];

    if (!appsList.length) return bot.sendMessage(cid, '📭 No apps found.');
    const total = appsList.length;
    const rows = chunkArray(appsList, 5).map(row =>
      row.map(name => ({ text: name, callback_data: `logs:${name}` }))
    );
    return bot.sendMessage(cid,
      `📜 Total Apps: ${total}\nChoose one:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  }

  // 🗑️ Delete button (admin)
  if (text === '🗑️ Delete' && isAdmin) {
    try {
      const res = await axios.get('https://api.heroku.com/apps', {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      const appsList = res.data.map(a => a.name);
      if (!appsList.length) return bot.sendMessage(cid, '📭 No apps found.');
      const rows = chunkArray(appsList, 5).map(row =>
        row.map(name => ({ text: name, callback_data: `delete:${name}` }))
      );
      return bot.sendMessage(cid,
        `🗑️ Total Apps: ${appsList.length}\nChoose one to delete:`,
        { reply_markup: { inline_keyboard: rows } }
      );
    } catch (err) {
      return bot.sendMessage(cid, `❌ ${err.message}`);
    }
  }

  // 🔐 Generate Key
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode: 'Markdown' });
  }

  // 🧾 Get Session button
  if (text === '🧾 Get Session') {
    userStates[cid] = { step: 'AWAITING_SESSION_APPROVAL', data: {} };
    bot.sendMessage(cid, '⏳ Loading server...');
    const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
    const username = msg.from.username ? `@${msg.from.username}` : 'No username';
    const inlineKeyboard = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${cid}` },
        { text: '❌ Reject',  callback_data: `reject:${cid}` }
      ]]
    };
    bot.sendMessage(ADMIN_ID,
      `📥 Session request from:\nID: ${cid}\nName: ${name}\nUsername: ${username}`,
      { reply_markup: inlineKeyboard }
    );
    return;
  }

  // 🆘 Support button
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `🆘 Support Contact: ${SUPPORT_USERNAME}`);
  }

  // === Stateful flows ===
  const state = userStates[cid];
  if (!state) return;

  // 1) One-time key entry
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      delete userStates[cid];
      const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
      const un   = msg.from.username ? `@${msg.from.username}` : 'No username';
      bot.sendMessage(ADMIN_ID,
        `🔔 Key used by:\nName: ${name}\nUsername: ${un}\nID: ${cid}`
      );
      return bot.sendMessage(cid, '✅ Key accepted! Now tap 🚀 Deploy.');
    }
    return bot.sendMessage(cid,
      '❌ Invalid or expired key. Get key from admin if you don\'t have one.');
  }

  // 2) Session approval & details
  if (state.step === 'AWAITING_SESSION_APPROVAL') {
    return; // waiting for admin
  }
  if (state.step === 'AWAITING_NAME') {
    state.data.name = text;
    state.step = 'AWAITING_PHONE';
    bot.sendMessage(cid, '📞 Enter your phone number (e.g. +2349012345678):');
    bot.sendMessage(ADMIN_ID, `👤 Name from ${cid}: ${text}`);
    return;
  }
  if (state.step === 'AWAITING_PHONE') {
    // validate Nigerian phone
    if (!/^\+234\d{10}$/.test(text)) {
      return bot.sendMessage(cid,
        '⚠️ Invalid number. Enter a valid Nigerian number (e.g. +2349012345678)'
      );
    }
    state.data.phone = text;
    state.step = 'AWAITING_CODE';
    bot.sendMessage(cid, '⏳ Wait for your pairing code...');
    bot.sendMessage(ADMIN_ID,
      `📱 Phone from ${cid}: ${text}\n\nReply with: code:${cid}:<your_code>`
    );
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
        const nm = text.toLowerCase().replace(/\s+/g, '-');
        if (!/^[a-z0-9-]+$/.test(nm)) {
          return bot.sendMessage(cid, '⚠️ Invalid APP_NAME format.');
        }
        try {
          await axios.get(`https://api.heroku.com/apps/${nm}`, {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          return bot.sendMessage(cid, `❌ \`${nm}\` already exists.`);
        } catch (e) {
          if (e.response?.status === 404) {
            state.data.APP_NAME = nm;
            state.step = 'AUTO_STATUS_VIEW';
            return bot.sendMessage(cid, '📝 Enter AUTO_STATUS_VIEW ("true" or "false"):');
          }
          throw e;
        }
      case 'AUTO_STATUS_VIEW':
        if (!['true','false'].includes(text.toLowerCase())) {
          return bot.sendMessage(cid, '⚠️ Type "true" or "false" to continue:');
        }
        state.data.AUTO_STATUS_VIEW = text.toLowerCase()==='true'?'no-dl':'false';
        state.step = 'STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid, '📝 Enter STATUS_VIEW_EMOJI (or type "skip"):');
      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI = text.toLowerCase()==='skip'?'':text;
        await bot.sendMessage(cid, '🛠️ Building in 3 mins...');
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

// === Inline callback handler (approve/reject, logs & delete) ===
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const [action, target] = query.data.split(':');
  await bot.answerCallbackQuery(query.id);

  if (action === 'approve') {
    userStates[target] = { step: 'AWAITING_NAME', data: {} };
    return bot.sendMessage(target, '✅ Approved! Please enter your full name:');
  }
  if (action === 'reject') {
    delete userStates[target];
    return bot.sendMessage(target, '❌ Your session request was rejected by the admin.');
  }
  if (action === 'logs') {
    try {
      const session = await axios.post(
        `https://api.heroku.com/apps/${target}/log-sessions`,
        { dyno: 'web', tail: false },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
      );
      const logs = (await axios.get(session.data.logplex_url)).data;
      if (logs.length < 4000) {
        return bot.sendMessage(cid,
          `📜 Logs for \`${target}\`:\n\`\`\`\n${logs}\n\`\`\``,
          { parse_mode: 'Markdown' }
        );
      }
      const fp = path.join(os.tmpdir(), `${target}-logs.txt`);
      fs.writeFileSync(fp, logs);
      await bot.sendDocument(cid, fp);
      fs.unlinkSync(fp);
    } catch (err) {
      bot.sendMessage(cid, `❌ Could not fetch logs: ${err.message}`);
    }
    return;
  }
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `✅ App \`${target}\` deleted.`, { parse_mode: 'Markdown' });
    } catch (err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`, { parse_mode: 'Markdown' });
    }
  }
});

// === Deploy helper with status updates ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  // 1) Create app
  await axios.post('https://api.heroku.com/apps',
    { name: appName },
    { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } }
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
    { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
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
    { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
  );
  // 4) Trigger build
  const buildRes = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
    { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
  );
  // 5) Poll status
  let status = buildRes.data.status;
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${buildRes.data.id}`;
  let attempts = 0;
  while (status === 'pending' && attempts < 20) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(statusUrl, {
      headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
    });
    status = poll.data.status;
    attempts++;
  }
  // 6) Final result
  if (status === 'succeeded') {
    userApps[chatId] = userApps[chatId] || [];
    userApps[chatId].push(appName);
    saveUserApps();
    bot.sendMessage(chatId,
      `✅ Deployed! Bot started...\nUse 📜 Logs button to check your bot if any error.\n🌐 https://${appName}.herokuapp.com`
    );
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}. Check your Heroku dashboard.`);
  }
      }
