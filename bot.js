// Global error handlers
process.on('unhandledRejection', reason => console.error('🛑 Unhandled Rejection:', reason));
process.on('uncaughtException', err   => console.error('🛑 Uncaught Exception:', err));

require('dotenv').config();
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');

// Load default env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch {}

// Config
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEROKU_API_KEY     = process.env.HEROKU_API_KEY;
const GITHUB_REPO_URL    = process.env.GITHUB_REPO_URL;
const ADMIN_ID           = process.env.ADMIN_ID;
const SUPPORT_USERNAME   = '@star_ies1';

// Init bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// In-memory state
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

// Utility functions
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({length:8})
    .map(()=>chars[Math.floor(Math.random()*chars.length)]).join('');
}
function buildKeyboard(isAdmin) {
  if (isAdmin) {
    return [
      ['🚀 Deploy','📦 Apps'],
      ['🔐 Generate Key','🧾 Get Session'],
      ['🆘 Support']
    ];
  } else {
    return [
      ['🧾 Get Session','🚀 Deploy'],
      ['📦 My Bots'],
      ['🆘 Support']
    ];
  }
}
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Polling errors
bot.on('polling_error', console.error);

// /start & /menu
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);
  bot.sendMessage(cid, `👋 Welcome${isAdmin?' Admin':''}!`, {
    reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true }
  });
});
bot.onText(/^\/menu$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup:{ keyboard: buildKeyboard(isAdmin), resize_keyboard:true }
  });
});

// Admin: generate key
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid,'❌ Only admin.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 Key: \`${key}\``,{ parse_mode:'Markdown' });
});

// Admin: /apps (two-step)
bot.onText(/^\/apps$/, async msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return;
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a=>a.name);
    if (!apps.length) return bot.sendMessage(cid,'📭 No apps.');
    const rows = chunkArray(apps,3).map(row =>
      row.map(n=>({ text:n, callback_data:`selectapp:${n}` }))
    );
    bot.sendMessage(cid, '📦 Select an app:', {
      reply_markup:{ inline_keyboard: rows }
    });
  } catch(err) {
    bot.sendMessage(cid, `❌ ${err.message}`);
  }
});

// /deploy fallback
bot.onText(/^\/deploy$/, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  if (!isAdmin && !authorizedUsers.has(cid)) {
    userStates[cid] = { step:'AWAITING_KEY', data:{} };
    return bot.sendMessage(cid,'🔐 Enter your one-time key:');
  }
  userStates[cid] = { step:'SESSION_ID', data:{} };
  bot.sendMessage(cid,'📝 Enter your SESSION_ID:');
});

// Main message handler
bot.on('message', async msg => {
  const cid    = msg.chat.id.toString();
  const text   = msg.text?.trim();
  const isAdmin= cid === ADMIN_ID;

  // reset on main menu presses
  const mains = ['🧾 Get Session','🚀 Deploy','📦 My Bots','📦 Apps','🔐 Generate Key','🆘 Support'];
  if (mains.includes(text)) delete userStates[cid];

  // Get Session
  if (text === '🧾 Get Session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    try {
      await bot.sendPhoto(cid,'https://files.catbox.moe/an2cc1.jpeg',{
        caption:`🧾 *How to Get Your Session ID:*\n\n`+
                `1. Tap the link\n2. Click *Session*\n3. Enter your custom session ID\n\n`+
                `🔗 https://levanter-delta.vercel.app/`,
        parse_mode:'Markdown'
      });
    } catch {
      await bot.sendMessage(cid,
        '⚠️ Could not send image. Visit:\nhttps://levanter-delta.vercel.app/'
      );
    }
    await bot.sendMessage(cid,
      `💡 *Note:*\n`+
      `• On iPhone, use Chrome browser\n`+
      `• You may see an ad — skip it\n`+
      `• Use a *custom session ID* to auto-start after rescanning\n\n`+
      `Once you have it, tap *🚀 Deploy*.`,{ parse_mode:'Markdown' }
    );
    return;
  }

  // Deploy
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid,'🔐 Enter your one-time key:');
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid,'📝 Enter your SESSION_ID:');
  }

  // My Bots (two-step)
  if (text === '📦 My Bots' && !isAdmin) {
    const apps = userApps[cid]||[];
    if (!apps.length) return bot.sendMessage(cid,'📭 No bots.');
    const rows = chunkArray(apps,3).map(row =>
      row.map(n=>({ text:n, callback_data:`selectbot:${n}` }))
    );
    return bot.sendMessage(cid,'🤖 Select a bot:', {
      reply_markup:{ inline_keyboard: rows }
    });
  }

  // Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `🆘 ${SUPPORT_USERNAME}`);
  }

  // Stateful flows
  const state = userStates[cid];
  if (!state) return;

  // 1) key check
  if (state.step==='AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step:'SESSION_ID', data:{} };
      return bot.sendMessage(cid,'✅ Key accepted! Now please enter your SESSION_ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid or expired key.');
  }

  // 2) SESSION_ID → APP_NAME
  if (state.step==='SESSION_ID') {
    if (!text||text.length<5) {
      return bot.sendMessage(cid,'⚠️ SESSION_ID must have ≥5 chars.');
    }
    state.data.SESSION_ID = text;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid,'📝 What name for your bot?');
  }

  // 3) APP_NAME → AUTO_STATUS_VIEW
  if (state.step==='APP_NAME') {
    const nm = text.trim().toLowerCase().replace(/\s+/g,'-');
    if (nm.length<5||!/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid,'⚠️ Use ≥5 chars: lowercase, numbers, hyphens.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `❌ ${nm} is taken. Choose another.`);
    } catch(e) {
      if (e.response?.status===404) {
        state.data.APP_NAME = nm;
        state.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW → deploy
  if (state.step==='AUTO_STATUS_VIEW') {
    const v = text.toLowerCase();
    if (!['true','false'].includes(v)) {
      return bot.sendMessage(cid,'⚠️ Type "true" or "false".');
    }
    state.data.AUTO_STATUS_VIEW = v==='true'?'no-dl':'false';
    await bot.sendMessage(cid,'📦 Build queued...');
    await bot.sendMessage(cid,'🛠️ Building in 3 mins...');
    await deployToHeroku(cid, state.data);
    delete userStates[cid];
    return;
  }

  // 5) SETVAR_CHOOSE_VAR
  if (state.step==='SETVAR_CHOOSE_VAR') {
    const varName = text.trim().toUpperCase();
    const allowed = ['SESSION_ID','STATUS_VIEW_EMOJI','PREFIX'];
    if (!allowed.includes(varName)) {
      return bot.sendMessage(cid, '⚠️ Choose one: SESSION_ID, STATUS_VIEW_EMOJI, PREFIX');
    }
    state.data.VAR_NAME = varName;
    state.step = 'SETVAR_ENTER_VALUE';
    return bot.sendMessage(cid, `Send new value for *${varName}*:`,{ parse_mode:'Markdown' });
  }

  // 6) SETVAR_ENTER_VALUE
  if (state.step==='SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = state.data;
    const newVal = text;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: newVal },
        { headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3',
          'Content-Type':'application/json'
        }}
      );
      delete userStates[cid];
      return bot.sendMessage(cid, `✅ Updated *${VAR_NAME}* for *${APP_NAME}*.`,{ parse_mode:'Markdown' });
    } catch(err) {
      delete userStates[cid];
      return bot.sendMessage(cid, `❌ Failed to update *${VAR_NAME}*: ${err.message}`,{ parse_mode:'Markdown' });
    }
  }
});

// Inline callback handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, target] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // BOT SELECTION (user)
  if (action==='selectbot') {
    return bot.sendMessage(cid,
      `🔧 What to do with \`${target}\`?`, {
      parse_mode:'Markdown',
      reply_markup:{ inline_keyboard:[[
        { text:'🔄 Restart', callback_data:`restart:${target}` },
        { text:'📜 Logs',    callback_data:`logs:${target}` },
        { text:'🗑️ Delete', callback_data:`userdelete:${target}` },
        { text:'⚙️ SetVar',  callback_data:`setvar:${target}` }
      ]] }
    });
  }

  // APP SELECTION (admin)
  if (action==='selectapp') {
    return bot.sendMessage(cid,
      `🔧 Admin actions for \`${target}\`:`, {
      parse_mode:'Markdown',
      reply_markup:{ inline_keyboard:[[
        { text:'ℹ️ Info',      callback_data:`info:${target}` },
        { text:'📜 Logs',      callback_data:`logs:${target}` },
        { text:'🗑️ Delete',   callback_data:`delete:${target}` },
        { text:'⚙️ SetVar',    callback_data:`setvar:${target}` }
      ]] }
    });
  }

  // RESTART
  if (action==='restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}/dynos`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      return bot.sendMessage(cid, `🔄 \`${target}\` restarted.`);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Restart failed: ${err.message}`);
    }
  }

  // USER DELETE
  if (action==='userdelete') {
    if (!userApps[cid]?.includes(target)) {
      return bot.sendMessage(cid, `❌ You don’t have \`${target}\`.`);
    }
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      userApps[cid] = userApps[cid].filter(a=>a!==target);
      saveUserApps();
      return bot.sendMessage(cid, `✅ \`${target}\` deleted.`);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`);
    }
  }

  // INFO
  if (action==='info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${target}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      const app = res.data;
      const createdAt = new Date(app.created_at);
      const days = Math.floor((Date.now()-createdAt)/(1000*60*60*24));
      const age = days? `${days} day${days>1?'s':''} ago` : 'Today';
      const info = `
📦 *App Info:*
• Name: \`${app.name}\`
• Region: ${app.region.name}
• Stack: ${app.stack.name}
• Created: ${createdAt.toLocaleString()} (${age})
• Web URL: ${app.web_url}
• Git URL: ${app.git_url}
• Owner: ${app.owner.email}
      `.trim();
      return bot.sendMessage(cid, info, { parse_mode:'Markdown' });
    } catch(err) {
      return bot.sendMessage(cid, `❌ Info failed: ${err.message}`);
    }
  }

  // LOGS
  if (action==='logs') {
    try {
      const sess = await axios.post(
        `https://api.heroku.com/apps/${target}/log-sessions`,
        { dyno:'web', tail:false },
        { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'} }
      );
      const logs = (await axios.get(sess.data.logplex_url)).data;
      if (logs.length < 4000) {
        return bot.sendMessage(cid, `📜 Logs for \`${target}\`:\n\`\`\`\n${logs}\n\`\`\``);
      }
      const fp = path.join(os.tmpdir(),`${target}-logs.txt`);
      fs.writeFileSync(fp,logs);
      await bot.sendDocument(cid,fp);
      fs.unlinkSync(fp);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Logs failed: ${err.message}`);
    }
  }

  // DELETE (admin)
  if (action==='delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      return bot.sendMessage(cid, `✅ \`${target}\` deleted.`);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`);
    }
  }

  // SETVAR
  if (action==='setvar') {
    userStates[cid] = {
      step:'SETVAR_CHOOSE_VAR',
      data:{ APP_NAME: target }
    };
    return bot.sendMessage(cid,
      'Which variable to update? (SESSION_ID, STATUS_VIEW_EMOJI, PREFIX)'
    );
  }
});

// Deploy helper
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  await axios.post('https://api.heroku.com/apps',{ name:appName },{
    headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
  });
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    { updates:[
      { buildpack:'https://github.com/heroku/heroku-buildpack-apt' },
      { buildpack:'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
      { buildpack:'heroku/nodejs' }
    ]},
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  const configVars = {
    ...defaultEnvVars,
    SESSION_ID:       vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    configVars,
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` }},
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  let status = bres.data.status;
  const stUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let at=0;
  while(status==='pending' && at<20){
    await new Promise(r=>setTimeout(r,5000));
    const poll = await axios.get(stUrl,{ headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'
    }});
    status = poll.data.status; at++;
  }
  if(status==='succeeded'){
    userApps[chatId] = userApps[chatId]||[];
    userApps[chatId].push(appName);
    saveUserApps();
    bot.sendMessage(chatId,
      `✅ Deployed! 🌐 https://${appName}.herokuapp.com\nUse 📜 Logs to troubleshoot.`
    );
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}. Check Heroku dashboard.`);
  }
}
