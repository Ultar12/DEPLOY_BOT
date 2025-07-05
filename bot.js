// Global error handlers
process.on('unhandledRejection', reason => {
  console.error('🛑 Unhandled Rejection:', reason);
});
process.on('uncaughtException', err => {
  console.error('🛑 Uncaught Exception:', err);
});

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// === Load default env vars from app.json ===
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch {}

// === Config ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEROKU_API_KEY     = process.env.HEROKU_API_KEY;
const GITHUB_REPO_URL    = process.env.GITHUB_REPO_URL;
const ADMIN_ID           = process.env.ADMIN_ID;
const SUPPORT_USERNAME   = '@star_ies1';

// === Init Bot ===
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// === State ===
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds who've used a key
const validKeys       = new Set(); // one-time deploy keys

// persistent user apps
const userAppsPath = 'userApps.json';
let userApps = {};
if (fs.existsSync(userAppsPath)) {
  try { userApps = JSON.parse(fs.readFileSync(userAppsPath, 'utf8')); }
  catch {}
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
    ? [['🚀 Deploy', '📦 Apps'], ['📜 Logs', '🗑️ Delete'], ['🔐 Generate Key', '🧾 Get Session'], ['🆘 Support']]
    : [['🧾 Get Session', '🚀 Deploy'], ['📦 My Bots'], ['🆘 Support']];
}

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

// === Admin: list apps & show info buttons ===
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
    const rows = chunkArray(apps, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `info:${name}` }))
    );
    bot.sendMessage(cid,
      `📦 Total Apps: ${apps.length}\nTap to view info:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// === /deploy fallback ===
bot.onText(/^\/deploy$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    userStates[cid] = { step: 'AWAITING_KEY', data: {} };
    return bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
  }
  userStates[cid] = { step: 'SESSION_ID', data: {} };
  bot.sendMessage(cid, '📝 Please enter your SESSION_ID:');
});

// === Main message handler ===
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  const isAdmin = cid === ADMIN_ID;

  // Admin reply-to-code
  if (isAdmin && msg.reply_to_message && msg.reply_to_message.text.includes('📱 Phone request for chat')) {
    const m = msg.reply_to_message.text.match(/chat `(\d+)`/);
    if (m) {
      const userId = m[1], code = text;
      try {
        await bot.sendMessage(userId,
          `🔐 Here’s your pairing code:\n\`${code}\`\nPaste into your WhatsApp-linked device.`,
          { parse_mode: 'Markdown' }
        );
        delete userStates[userId];
        return bot.sendMessage(ADMIN_ID, `✅ Code sent to \`${userId}\`.`);
      } catch (err) {
        return bot.sendMessage(ADMIN_ID, `❌ Failed to send: ${err.message}`);
      }
    }
  }

  // reset state on main buttons
  const mainBtns = ['🧾 Get Session','🚀 Deploy','📦 My Bots','🆘 Support','📦 Apps','📜 Logs','🗑️ Delete','🔐 Generate Key'];
  if (mainBtns.includes(text)) delete userStates[cid];

  // 🧾 Get Session
  if (text === '🧾 Get Session') {
    userStates[cid] = { step: 'AWAITING_SESSION_APPROVAL', data: {} };

    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: `🧾 *How to Get Your Session ID:*\n\n1. Tap the link below\n2. Click *Session* on the left\n3. Enter your name and tap *Submit*\n4. Copy the *pairing-code* and paste it into your WhatsApp Linked device\n5. The bot will send your SESSION_ID to this chat once you're done\n\n🔗 [Open Session Tool](https://levanter-delta.vercel.app/)\n\n📱 *iPhone users:* Use Chrome browser.`,
        parse_mode: 'Markdown'
      });
    } catch (err) {
      console.error('❌ Failed to send session image:', err.message);
      await bot.sendMessage(cid,
        '⚠️ Failed to send image. Please visit:\nhttps://levanter-delta.vercel.app/');
    }

    const name = `${msg.from.first_name||''} ${msg.from.last_name||''}`.trim();
    const username = msg.from.username ? `@${msg.from.username}` : 'No username';

    await bot.sendMessage(ADMIN_ID,
      `📥 Session request from:\nID: \`${cid}\`\nName: \`${name}\`\nUsername: \`${username}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${cid}` },
            { text: '❌ Reject',  callback_data: `reject:${cid}` }
          ]]
        }
      }
    );
    return;
  }

  // 🚀 Deploy
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step: 'AWAITING_KEY', data: {} };
      return bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
    }
    userStates[cid] = { step: 'SESSION_ID', data: {} };
    return bot.sendMessage(cid, '📝 Please enter your SESSION_ID:');
  }

  // 📦 My Bots (user)
  if (text === '📦 My Bots' && !isAdmin) {
    const apps = userApps[cid] || [];
    if (!apps.length) return bot.sendMessage(cid,'📭 You haven’t deployed any bots yet.');
    const rows = apps.map(name => ([
      { text: '🔄 Restart', callback_data: `restart:${name}` },
      { text: '📜 Logs',    callback_data: `logs:${name}` },
      { text: '🗑️ Delete', callback_data: `userdelete:${name}` }
    ]));
    return bot.sendMessage(cid, '🤖 Your Bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // 📦 Apps (admin)
  if (text === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat:{ id: cid }, text: '/apps' });
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
      userStates[cid] = { step: 'SESSION_ID', data: {} };
      return bot.sendMessage(cid,'✅ Key accepted! Please enter your SESSION_ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid or expired key. Get one from admin.');
  }

  // 2) SESSION_ID → ask BOT name
  if (state.step === 'SESSION_ID') {
    if (!text || text.length < 5) {
      return bot.sendMessage(cid,'⚠️ SESSION_ID must be at least 5 characters.');
    }
    state.data.SESSION_ID = text;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid,'📝 What name would you like to give your bot?');
  }

  // 3) APP_NAME → ask AUTO_STATUS_VIEW
  if (state.step === 'APP_NAME') {
    const name = text.trim();
    if (name.length < 5) {
      return bot.sendMessage(cid,'⚠️ Name must be at least 5 characters.');
    }
    const appName = name.toLowerCase().replace(/\s+/g,'-');
    if (!/^[a-z0-9-]+$/.test(appName)) {
      return bot.sendMessage(cid,'⚠️ Use lowercase letters, numbers, or hyphens only.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${appName}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `❌ \`${appName}\` is taken. Choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = appName;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW → deploy
  if (state.step === 'AUTO_STATUS_VIEW') {
    const v = text.toLowerCase();
    if (!['true','false'].includes(v)) {
      return bot.sendMessage(cid,'⚠️ Please type "true" or "false".');
    }
    state.data.AUTO_STATUS_VIEW = v === 'true' ? 'no-dl' : 'false';
    await bot.sendMessage(cid,'📦 Build queued...');
    await bot.sendMessage(cid,'🛠️ Building in 3 mins...');
    await deployToHeroku(cid, state.data);
    delete userStates[cid];
    authorizedUsers.delete(cid);
    return;
  }
});

// === Inline callback handler ===
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const [action, target] = query.data.split(':');
  await bot.answerCallbackQuery(query.id);

  // Session approval
  if (action === 'approve') {
    userStates[target] = { step:'AWAITING_NAME', data:{} };
    return bot.sendMessage(target,'What is your name?');
  }
  if (action === 'reject') {
    delete userStates[target];
    return bot.sendMessage(target,'❌ Your session request was rejected.');
  }

  // Restart bot (user)
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}/dynos`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `🔄 Bot \`${target}\` restarted successfully.`, { parse_mode:'Markdown' });
    } catch (err) {
      return bot.sendMessage(cid, `❌ Failed to restart \`${target}\`: ${err.message}`);
    }
  }

  // User delete
  if (action === 'userdelete') {
    if (!userApps[cid] || !userApps[cid].includes(target)) {
      return bot.sendMessage(cid, `❌ You don’t have a bot named \`${target}\`.`);
    }
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      userApps[cid] = userApps[cid].filter(a => a !== target);
      saveUserApps();
      return bot.sendMessage(cid, `✅ Bot \`${target}\` deleted.`, { parse_mode:'Markdown' });
    } catch (err) {
      return bot.sendMessage(cid, `❌ Failed to delete \`${target}\`: ${err.message}`);
    }
  }

  // App info (admin & user)
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${target}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      const app = res.data;
      const createdAt = new Date(app.created_at);
      const ageDays = Math.floor((Date.now()-createdAt)/(1000*60*60*24));
      const ageText = ageDays === 0 ? 'Today' : `${ageDays} day${ageDays>1?'s':''} ago`;
      const info = `
📦 *App Info:*
• Name: \`${app.name}\`
• Region: ${app.region.name}
• Stack: ${app.stack.name}
• Created: ${createdAt.toLocaleString()} (${ageText})
• Web URL: ${app.web_url}
• Git URL: ${app.git_url}
• Owner: ${app.owner.email}
      `.trim();
      return bot.sendMessage(cid, info, { parse_mode:'Markdown' });
    } catch (err) {
      return bot.sendMessage(cid, `❌ Could not fetch info: ${err.message}`);
    }
  }

  // Logs (admin & user)
  if (action === 'logs') {
    try {
      const session = await axios.post(
        `https://api.heroku.com/apps/${target}/log-sessions`,
        { dyno:'web', tail:false },
        { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' } }
      );
      const logs = (await axios.get(session.data.logplex_url)).data;
      if (logs.length < 4000) {
        return bot.sendMessage(cid, `📜 Logs for \`${target}\`:\n\`\`\`\n${logs}\n\`\`\``, { parse_mode:'Markdown' });
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

  // Delete (admin)
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `✅ App \`${target}\` deleted.`, { parse_mode:'Markdown' });
    } catch (err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`, { parse_mode:'Markdown' });
    }
  }
});

// === Deploy helper ===
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;

  // Create app
  await axios.post('https://api.heroku.com/apps', { name: appName }, {
    headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
  });

  // Buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    { updates:[
      { buildpack:'https://github.com/heroku/heroku-buildpack-apt' },
      { buildpack:'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
      { buildpack:'heroku/nodejs' }
    ]},
    { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3', 'Content-Type':'application/json' }}
  );

  // Config vars
  const configVars = {
    ...defaultEnvVars,
    SESSION_ID: vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    configVars,
    { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3', 'Content-Type':'application/json' }}
  );

  // Trigger build
  const buildRes = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` } },
    { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3', 'Content-Type':'application/json' }}
  );

  // Poll status
  let status = buildRes.data.status;
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${buildRes.data.id}`;
  let attempts = 0;
  while (status === 'pending' && attempts < 20) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(statusUrl, {
      headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
    });
    status = poll.data.status;
    attempts++;
  }

  // Final result
  if (status === 'succeeded') {
    userApps[chatId] = userApps[chatId] || [];
    userApps[chatId].push(appName);
    saveUserApps();
    bot.sendMessage(chatId,
      `✅ Deployed! Bot started...\nUse 📜 Logs to check for errors.\n🌐 https://${appName}.herokuapp.com`
    );
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}. Check your Heroku dashboard.`);
  }
  }
