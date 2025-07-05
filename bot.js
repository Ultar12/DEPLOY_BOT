// Global error handlers
process.on('unhandledRejection', r => console.error('🛑 Unhandled Rejection:', r));
process.on('uncaughtException', e => console.error('🛑 Uncaught Exception:', e));

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
    Object.entries(appJson.env).map(([k,v]) => [k, v.value])
  );
} catch {}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HEROKU_API_KEY     = process.env.HEROKU_API_KEY;
const GITHUB_REPO_URL    = process.env.GITHUB_REPO_URL;
const ADMIN_ID           = process.env.ADMIN_ID;
const SUPPORT_USERNAME   = '@star_ies1';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// In-memory state
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds who've used a key
const validKeys       = new Set(); // one-time deploy keys

// Persist user apps
const userAppsPath = 'userApps.json';
let userApps = {};
if (fs.existsSync(userAppsPath)) {
  try { userApps = JSON.parse(fs.readFileSync(userAppsPath, 'utf8')); }
  catch {}
}
function saveUserApps() {
  fs.writeFileSync(userAppsPath, JSON.stringify(userApps, null, 2));
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length:8 })
    .map(() => chars[Math.floor(Math.random()*chars.length)])
    .join('');
}

function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['🚀 Deploy','📦 Apps'], ['🔐 Generate Key','🧾 Get Session'], ['🆘 Support']]
    : [['🧾 Get Session','🚀 Deploy'], ['📦 My Bots'], ['🆘 Support']];
}

function chunkArray(arr, size) {
  const out = [];
  for (let i=0; i<arr.length; i+=size) out.push(arr.slice(i, i+size));
  return out;
}

bot.on('polling_error', console.error);

// /start & /menu
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

// Admin commands
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid,'❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode:'Markdown' });
});
bot.onText(/^\/apps$/, async msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return;
  try {
    const res  = await axios.get('https://api.heroku.com/apps', {
      headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a=>a.name);
    if (!apps.length) return bot.sendMessage(cid,'📭 No apps found.');
    const rows = chunkArray(apps,3).map(row =>
      row.map(name => ({ text: name, callback_data:`selectapp:${name}` }))
    );
    bot.sendMessage(cid,
      `📦 Total Apps: ${apps.length}\nTap an app to manage:`,
      { reply_markup:{ inline_keyboard: rows } }
    );
  } catch(err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
});

// text-button aliases
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  const isAdmin = cid === ADMIN_ID;

  // alias for buttons
  if (text === '📦 Apps' && isAdmin) {
    return bot.emit('text', { chat:{ id:cid }, text:'/apps' });
  }
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode:'Markdown' });
  }

  // 🧾 Get Session
  if (text === '🧾 Get Session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg',{
        caption:`🧾 *How to Get Your Session ID:*\n\n`+
                `1. Tap the link below\n`+
                `2. Click *Session* on the left\n`+
                `3. Enter your custom session ID\n\n`+
                `🔗 https://levanter-delta.vercel.app/`,
        parse_mode:'Markdown'
      });
    } catch {
      await bot.sendMessage(cid,
        '⚠️ Failed to send image. Please visit:\nhttps://levanter-delta.vercel.app/'
      );
    }
    await bot.sendMessage(cid,
      `💡 *Note:*\n`+
      `• On iPhone, please use Chrome browser\n`+
      `• You may skip any ad you see\n`+
      `• Use a *custom session ID* so your bot auto-starts when you rescan\n\n`+
      `Once you have it, tap 🚀 Deploy.`, { parse_mode:'Markdown' }
    );
    return;
  }

  // 🚀 Deploy
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid, '🔐 Please enter your one-time deploy key:');
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid, '📝 Please enter your SESSION_ID:');
  }

  // 📦 My Bots
  if (text === '📦 My Bots' && !isAdmin) {
    const apps = userApps[cid]||[];
    if (!apps.length) return bot.sendMessage(cid,'📭 You haven’t deployed any bots yet.');
    const rows = chunkArray(apps,3).map(row =>
      row.map(name => ({ text: name, callback_data:`selectbot:${name}` }))
    );
    return bot.sendMessage(cid,'🤖 Select a bot:', {
      reply_markup:{ inline_keyboard: rows }
    });
  }

  // 🆘 Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `🆘 Support Contact: ${SUPPORT_USERNAME}`);
  }

  // Stateful flows
  const state = userStates[cid];
  if (!state) return;

  // 1) One-time key
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step:'SESSION_ID', data:{} };
      return bot.sendMessage(cid,'✅ Key accepted! Please enter your SESSION_ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid or expired key.');
  }

  // 2) SESSION_ID → ask APP_NAME
  if (state.step === 'SESSION_ID') {
    if (!text || text.length<5) {
      return bot.sendMessage(cid,'⚠️ SESSION_ID must be at least 5 characters.');
    }
    state.data.SESSION_ID = text;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid,'📝 What name would you like to give your bot?');
  }

  // 3) APP_NAME → ask AUTO_STATUS_VIEW
  if (state.step === 'APP_NAME') {
    const appName = text.trim().toLowerCase().replace(/\s+/g,'-');
    if (appName.length<5 || !/^[a-z0-9-]+$/.test(appName)) {
      return bot.sendMessage(cid,
        '⚠️ Name must be at least 5 characters: lowercase, numbers, or hyphens only.'
      );
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${appName}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `❌ \`${appName}\` is already taken. Choose another.`);
    } catch(e) {
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
    state.data.AUTO_STATUS_VIEW = v==='true' ? 'no-dl' : 'false';
    await bot.sendMessage(cid,'📦 Build queued...');
    await bot.sendMessage(cid,'🛠️ Building in 3 mins...');
    await deployToHeroku(cid, state.data);
    delete userStates[cid];
    return;
  }

  // 5) SETVAR_CHOOSE_VAR
  if (state.step === 'SETVAR_CHOOSE_VAR') {
    const varName = text.trim().toUpperCase();
    const allowed = ['SESSION_ID','STATUS_VIEW_EMOJI','PREFIX'];
    if (!allowed.includes(varName)) {
      return bot.sendMessage(cid,
        '⚠️ Please choose one: SESSION_ID, STATUS_VIEW_EMOJI, PREFIX'
      );
    }
    state.data.VAR_NAME = varName;
    state.step = 'SETVAR_ENTER_VALUE';
    return bot.sendMessage(cid,
      `Please send the new value for *${varName}*:`, { parse_mode:'Markdown' }
    );
  }

  // 6) SETVAR_ENTER_VALUE
  if (state.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = state.data;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: text },
        { headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3',
          'Content-Type':'application/json'
        }}
      );
      delete userStates[cid];
      return bot.sendMessage(cid,
        `✅ Updated *${VAR_NAME}* for *${APP_NAME}*.`,{ parse_mode:'Markdown' }
      );
    } catch(err) {
      delete userStates[cid];
      return bot.sendMessage(cid,
        `❌ Failed to update *${VAR_NAME}*: ${err.message}`,{ parse_mode:'Markdown' }
      );
    }
  }
});

// Inline callback handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action,target] = q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // user: select a bot
  if (action === 'selectbot') {
    return bot.sendMessage(cid,
      `🔧 What would you like to do with \`${target}\`?`, {
      parse_mode:'Markdown',
      reply_markup:{
        inline_keyboard:[
          [
            { text:'🔄 Restart', callback_data:`restart:${target}` },
            { text:'📜 Logs',    callback_data:`logs:${target}` }
          ],
          [
            { text:'🗑️ Delete', callback_data:`userdelete:${target}` },
            { text:'⚙️ SetVar',  callback_data:`setvar:${target}` }
          ]
        ]
      }
    });
  }

  // admin: select an app
  if (action === 'selectapp') {
    return bot.sendMessage(cid,
      `🔧 Admin actions for \`${target}\``, {
      parse_mode:'Markdown',
      reply_markup:{
        inline_keyboard:[
          [
            { text:'ℹ️ Info',    callback_data:`info:${target}` },
            { text:'📜 Logs',    callback_data:`logs:${target}` }
          ],
          [
            { text:'🗑️ Delete', callback_data:`delete:${target}` },
            { text:'⚙️ SetVar',  callback_data:`setvar:${target}` }
          ]
        ]
      }
    });
  }

  // restart
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}/dynos`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `🔄 \`${target}\` restarted successfully.`);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Restart failed: ${err.message}`);
    }
  }

  // user delete
  if (action === 'userdelete') {
    if (!userApps[cid]?.includes(target)) {
      return bot.sendMessage(cid, `❌ You don’t have a bot named \`${target}\`.`);
    }
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      userApps[cid] = userApps[cid].filter(a=>a!==target);
      saveUserApps();
      return bot.sendMessage(cid, `✅ \`${target}\` deleted.`);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`);
    }
  }

  // info
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${target}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      const app = res.data;
      const createdAt = new Date(app.created_at);
      const days = Math.floor((Date.now()-createdAt)/(1000*60*60*24));
      const ageText = days===0 ? 'Today' : `${days} day${days>1?'s':''} ago`;
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
    } catch(err) {
      return bot.sendMessage(cid, `❌ Info failed: ${err.message}`);
    }
  }

  // logs
  if (action === 'logs') {
    try {
      const sess = await axios.post(
        `https://api.heroku.com/apps/${target}/log-sessions`,
        { dyno:'web', tail:false },
        { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' } }
      );
      const logs = (await axios.get(sess.data.logplex_url)).data;
      if (logs.length < 4000) {
        return bot.sendMessage(cid,
          `📜 Logs for \`${target}\`:\n\n\`\`\`\n${logs}\n\`\`\`\n\n📋 *Tip:* Tap and hold to copy.`,
          { parse_mode:'Markdown' }
        );
      }
      const fp = path.join(os.tmpdir(),`${target}-logs.txt`);
      fs.writeFileSync(fp, logs);
      await bot.sendDocument(cid, fp);
      fs.unlinkSync(fp);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Logs failed: ${err.message}`);
    }
  }

  // delete (admin)
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${target}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `✅ \`${target}\` deleted.`);
    } catch(err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`);
    }
  }

  // setvar
  if (action === 'setvar') {
    userStates[cid] = { step:'SETVAR_CHOOSE_VAR', data:{ APP_NAME: target } };
    return bot.sendMessage(cid,
      'Which variable would you like to update? (SESSION_ID, STATUS_VIEW_EMOJI, PREFIX)'
    );
  }
});

// Deploy helper
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  // Create app
  await axios.post('https://api.heroku.com/apps',{ name:appName },{
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
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  // Config vars
  const cfg = {
    ...defaultEnvVars,
    SESSION_ID:       vars.SESSION_ID,
    AUTO_STATUS_VIEW: vars.AUTO_STATUS_VIEW
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,
    cfg,
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  // Build
  const bres = await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` }},
    { headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  let status = bres.data.status;
  const stUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let at = 0;
  while (status==='pending' && at<20) {
    await new Promise(r=>setTimeout(r,5000));
    const poll = await axios.get(stUrl,{ headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3'
    }});
    status = poll.data.status; at++;
  }
  if (status==='succeeded') {
    userApps[chatId] = (userApps[chatId]||[]).concat(appName);
    saveUserApps();
    bot.sendMessage(chatId,
      `✅ Deployed! Bot started…\nUse 📜 Logs to troubleshoot.\n🌐 https://${appName}.herokuapp.com`
    );
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}. Check your Heroku dashboard.`);
  }
  }
