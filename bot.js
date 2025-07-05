// Global error handlers
process.on('unhandledRejection', err => console.error('🛑 Unhandled Rejection:', err));
process.on('uncaughtException', err   => console.error('🛑 Uncaught Exception:', err));

require('dotenv').config();
const fs          = require('fs');
const path        = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const { Pool }    = require('pg');

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
const DATABASE_URL       = process.env.DATABASE_URL;

// Set up PostgreSQL pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Database helper functions
async function addUserBot(userId, botName, sessionId) {
  await pool.query(
    'INSERT INTO user_bots(user_id, bot_name, session_id) VALUES($1,$2,$3)',
    [userId, botName, sessionId]
  );
}

async function getUserBots(userId) {
  const res = await pool.query(
    'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
    [userId]
  );
  return res.rows.map(r => r.bot_name);
}

async function deleteUserBot(userId, botName) {
  await pool.query(
    'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
    [userId, botName]
  );
}

async function updateUserSession(userId, botName, sessionId) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [sessionId, userId, botName]
  );
}

// Initialize Telegram bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// In-memory state for interactive flows
const userStates      = {};        // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds who passed key
const validKeys       = new Set(); // one-time deploy keys

// Utility functions
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['🚀 Deploy','📦 Apps'], ['🔐 Generate Key','🧾 Get Session'], ['🆘 Support']]
    : [['🧾 Get Session','🚀 Deploy'], ['📦 My Bots'], ['🆘 Support']];
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Send Heroku app list for admin
async function sendAppList(cid) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept:     'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) return bot.sendMessage(cid, '📭 No apps found.');
    const rows = chunkArray(apps, 3).map(row =>
      row.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(cid,
      `📦 Total Apps: ${apps.length}\nTap an app to manage:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    bot.sendMessage(cid, `❌ Could not fetch apps: ${err.message}`);
  }
}

// Polling error logger
bot.on('polling_error', console.error);

// /start and /menu handlers
bot.onText(/^\/start$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);
  bot.sendMessage(cid, `👋 Welcome${isAdmin ? ' Admin' : ''}!`, {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});
bot.onText(/^\/menu$/, msg => {
  const cid     = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, '📲 Choose an option:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// Admin: generate one-time key
bot.onText(/^\/generate$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid !== ADMIN_ID) return bot.sendMessage(cid, '❌ Only admin can generate keys.');
  const key = generateKey();
  validKeys.add(key);
  bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode:'Markdown' });
});

// Admin: /apps command
bot.onText(/^\/apps$/, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) sendAppList(cid);
});

// Main message handler
bot.on('message', async msg => {
  const cid     = msg.chat.id.toString();
  const text    = msg.text?.trim();
  const isAdmin = cid === ADMIN_ID;

  // Admin button shortcuts
  if (text === '📦 Apps' && isAdmin) {
    return sendAppList(cid);
  }
  if (text === '🔐 Generate Key' && isAdmin) {
    const key = generateKey();
    validKeys.add(key);
    return bot.sendMessage(cid, `🔑 One-time Key: \`${key}\``, { parse_mode:'Markdown' });
  }

  // 🧾 Get Session flow
  if (text === '🧾 Get Session') {
    userStates[cid] = { step:'SESSION_ID', data:{} };
    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: `🧾 *How to Get Your Session ID:*\n\n` +
                 `1. Tap the link below\n` +
                 `2. Click *Session* on the left\n` +
                 `3. Enter your custom session ID\n\n` +
                 `🔗 https://levanter-delta.vercel.app/`,
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(cid,
        '⚠️ Failed to send image. Visit:\nhttps://levanter-delta.vercel.app/'
      );
    }
    return bot.sendMessage(cid,
      `💡 *Note:*\n` +
      `• On iPhone, use Chrome\n` +
      `• Skip any ad you see\n` +
      `• Use a *custom session ID* to auto-start after rescanning\n\n` +
      `When ready, tap 🚀 Deploy.`,
      { parse_mode: 'Markdown' }
    );
  }

  // 🚀 Deploy flow
  if (text === '🚀 Deploy') {
    if (!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid] = { step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid,
        '🔐 Please enter your one-time deploy key.\n\n🙋‍♂️ Need help? Contact the admin.',
        { parse_mode: 'Markdown' }
      );
    }
    userStates[cid] = { step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid, '📝 Please enter your SESSION_ID:');
  }

  // 📦 My Bots (user)
  if (text === '📦 My Bots' && !isAdmin) {
    const bots = await getUserBots(cid);
    if (!bots.length) return bot.sendMessage(cid, '📭 You haven’t deployed any bots yet.');
    const rows = chunkArray(bots, 3).map(row =>
      row.map(name => ({ text:name, callback_data:`selectbot:${name}` }))
    );
    return bot.sendMessage(cid, '🤖 Select a bot:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  // 🆘 Support
  if (text === '🆘 Support') {
    return bot.sendMessage(cid, `🆘 Support Contact: ${SUPPORT_USERNAME}`);
  }

  // Interactive state machine
  const state = userStates[cid];
  if (!state) return;

  // 1) Awaiting one-time key
  if (state.step === 'AWAITING_KEY') {
    const key = text.toUpperCase();
    if (validKeys.has(key)) {
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid] = { step:'SESSION_ID', data:{} };
      // Notify admin
      const name = `${msg.from.first_name||''} ${msg.from.last_name||''}`.trim();
      const usr  = msg.from.username ? `@${msg.from.username}` : 'No username';
      bot.sendMessage(ADMIN_ID,
        `🔐 Key used by:\n• ID: \`${cid}\`\n• Name: \`${name}\`\n• Username: ${usr}`,
        { parse_mode:'Markdown' }
      );
      return bot.sendMessage(cid, '✅ Key accepted! Please enter your SESSION_ID:');
    }
    return bot.sendMessage(cid,
      '❌ Invalid or expired key.\n\n🙋‍♂️ Need help? Contact the admin.',
      { parse_mode:'Markdown' }
    );
  }

  // 2) Got SESSION_ID → ask APP_NAME
  if (state.step === 'SESSION_ID') {
    if (!text || text.length < 5) {
      return bot.sendMessage(cid, '⚠️ SESSION_ID must be at least 5 characters.');
    }
    state.data.SESSION_ID = text;
    state.step = 'APP_NAME';
    return bot.sendMessage(cid, '📝 What name would you like to give your bot?');
  }

  // 3) Got APP_NAME → ask AUTO_STATUS_VIEW
  if (state.step === 'APP_NAME') {
    const nm = text.trim().toLowerCase().replace(/\s+/g,'-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
      return bot.sendMessage(cid,
        '⚠️ Name must be at least 5 chars: lowercase, numbers, or hyphens.'
      );
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      return bot.sendMessage(cid, `❌ \`${nm}\` is taken. Choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        state.data.APP_NAME = nm;
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

    // Deploy to Heroku
    await bot.sendMessage(cid,'📦 Build queued...');
    await bot.sendMessage(cid,'🛠️ Building in 3 mins...');
    await deployToHeroku(cid, state.data);

    // Record bot in database
    await addUserBot(cid, state.data.APP_NAME, state.data.SESSION_ID);

    delete userStates[cid];
    return;
  }
});

// Inline callback handler
bot.on('callback_query', async query => {
  const cid = query.message.chat.id.toString();
  const parts = query.data.split(':');
  const action  = parts[0];
  const name    = parts[1];
  const varName = parts[2];
  const val     = parts[3];
  await bot.answerCallbackQuery(query.id);

  // User selects a bot
  if (action === 'selectbot') {
    return bot.sendMessage(cid,
      `🔧 What would you like to do with \`${name}\`?`, {
      parse_mode:'Markdown',
      reply_markup:{
        inline_keyboard:[
          [
            { text:'🔄 Restart', callback_data:`restart:${name}` },
            { text:'📜 Logs',    callback_data:`logs:${name}` }
          ],
          [
            { text:'🗑️ Delete', callback_data:`userdelete:${name}` },
            { text:'⚙️ SetVar',  callback_data:`setvar:${name}` }
          ]
        ]
      }
    });
  }

  // Admin selects an app
  if (action === 'selectapp') {
    return bot.sendMessage(cid,
      `🔧 Admin actions for \`${name}\``, {
      parse_mode:'Markdown',
      reply_markup:{
        inline_keyboard:[
          [
            { text:'ℹ️ Info',    callback_data:`info:${name}` },
            { text:'📜 Logs',    callback_data:`logs:${name}` }
          ],
          [
            { text:'🗑️ Delete', callback_data:`delete:${name}` },
            { text:'⚙️ SetVar',  callback_data:`setvar:${name}` }
          ]
        ]
      }
    });
  }

  // Restart
  if (action === 'restart') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${name}/dynos`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      return bot.sendMessage(cid, `🔄 \`${name}\` restarted successfully.`);
    } catch (err) {
      return bot.sendMessage(cid, `❌ Restart failed: ${err.message}`);
    }
  }

  // Logs
  if (action === 'logs') {
    try {
      const sess = await axios.post(
        `https://api.heroku.com/apps/${name}/log-sessions`,
        { dyno:'web', tail:false },
        { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'} }
      );
      const logs = (await axios.get(sess.data.logplex_url)).data;
      if (logs.length < 4000) {
        return bot.sendMessage(cid,
          `📜 Logs for \`${name}\`:\n\n\`\`\`\n${logs}\n\`\`\`\n\n📋 *Tip:* Tap and hold to copy.`,
          { parse_mode:'Markdown' }
        );
      }
      const fp = path.join(process.cwd(), `${name}-logs.txt`);
      fs.writeFileSync(fp, logs);
      await bot.sendDocument(cid, fp);
      fs.unlinkSync(fp);
    } catch (err) {
      return bot.sendMessage(cid, `❌ Logs failed: ${err.message}`);
    }
  }

  // User delete
  if (action === 'userdelete') {
    const bots = await getUserBots(cid);
    if (!bots.includes(name)) {
      return bot.sendMessage(cid, `❌ You don’t have a bot named \`${name}\`.`);
    }
    try {
      await axios.delete(`https://api.heroku.com/apps/${name}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      await deleteUserBot(cid, name);
      return bot.sendMessage(cid, `✅ \`${name}\` deleted.`);
    } catch (err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`);
    }
  }

  // Admin delete
  if (action === 'delete') {
    try {
      await axios.delete(`https://api.heroku.com/apps/${name}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      return bot.sendMessage(cid, `✅ \`${name}\` deleted.`);
    } catch (err) {
      return bot.sendMessage(cid, `❌ Delete failed: ${err.message}`);
    }
  }

  // Info
  if (action === 'info') {
    try {
      const res = await axios.get(`https://api.heroku.com/apps/${name}`, {
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
      });
      const app       = res.data;
      const createdAt = new Date(app.created_at);
      const days      = Math.floor((Date.now() - createdAt)/(1000*60*60*24));
      const ageText   = days===0 ? 'Today' : `${days} day${days>1?'s':''} ago`;
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
      return bot.sendMessage(cid, `❌ Info failed: ${err.message}`);
    }
  }

  // SetVar: show variable buttons
  if (action === 'setvar') {
    return bot.sendMessage(cid, 'Choose a variable to update:', {
      reply_markup:{ inline_keyboard:[
        [
          { text:'SESSION_ID',        callback_data:`varselect:SESSION_ID:${name}` },
          { text:'STATUS_VIEW_EMOJI', callback_data:`varselect:STATUS_VIEW_EMOJI:${name}` }
        ],
        [
          { text:'PREFIX',            callback_data:`varselect:PREFIX:${name}` },
          { text:'AUTO_STATUS_VIEW',  callback_data:`varselect:AUTO_STATUS_VIEW:${name}` },
          { text:'ALWAYS_ONLINE',     callback_data:`varselect:ALWAYS_ONLINE:${name}` }
        ]
      ]}
    });
  }

  // Variable selected
  if (action === 'varselect') {
    if (varName==='AUTO_STATUS_VIEW' || varName==='ALWAYS_ONLINE') {
      return bot.sendMessage(cid, `Set *${varName}* to:`, {
        parse_mode:'Markdown',
        reply_markup:{ inline_keyboard:[[
          { text:'true',  callback_data:`setvarbool:${varName}:${name}:true` },
          { text:'false', callback_data:`setvarbool:${varName}:${name}:false` }
        ]] }
      });
    }
    // Text entry for SESSION_ID or PREFIX
    userStates[cid] = { step:'SETVAR_ENTER_VALUE', data:{ APP_NAME:name, VAR_NAME:varName } };
    return bot.sendMessage(cid,
      `Please send the new value for *${varName}*:`, { parse_mode:'Markdown' }
    );
  }

  // Boolean var update
  if (action === 'setvarbool') {
    let newVal = val;
    if (varName==='AUTO_STATUS_VIEW' && val==='true') newVal = 'no-dl';
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${name}/config-vars`,
        { [varName]: newVal },
        { headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3',
          'Content-Type':'application/json'
        }}
      );
      if (varName === 'SESSION_ID') {
        await updateUserSession(cid, name, newVal);
      }
      return bot.sendMessage(cid,
        `✅ Updated *${varName}* to \`${newVal}\` for *${name}*.`, { parse_mode:'Markdown' }
      );
    } catch (err) {
      return bot.sendMessage(cid, `❌ Failed to update: ${err.message}`);
    }
  }

  // Text var update (fallback)
  if (state.step === 'SETVAR_ENTER_VALUE') {
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
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(cid, APP_NAME, newVal);
      }
      delete userStates[cid];
      return bot.sendMessage(cid,
        `✅ Updated *${VAR_NAME}* to \`${newVal}\` for *${APP_NAME}*.`, { parse_mode:'Markdown' }
      );
    } catch (err) {
      delete userStates[cid];
      return bot.sendMessage(cid, `❌ Failed to update: ${err.message}`);
    }
  }
});

// Deploy helper
async function deployToHeroku(chatId, vars) {
  const appName = vars.APP_NAME;
  // Create app
  await axios.post('https://api.heroku.com/apps',{ name:appName },{
    headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
  });
  // Set buildpacks
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
  // Configure vars
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
  const statusUrl = `https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let attempts = 0;
  while (status === 'pending' && attempts < 20) {
    await new Promise(r => setTimeout(r, 5000));
    const poll = await axios.get(statusUrl,{
      headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'}
    });
    status = poll.data.status; attempts++;
  }
  if (status === 'succeeded') {
    bot.sendMessage(chatId,
      `✅ Deployed! Bot started…\nUse 📜 Logs to troubleshoot.\n🌐 https://${appName}.herokuapp.com`
    );
  } else {
    bot.sendMessage(chatId, `❌ Build ${status}. Check your Heroku dashboard.`);
  }
                             }
