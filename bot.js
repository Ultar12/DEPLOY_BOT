// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// 2) Load fallback env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(require('fs').readFileSync('app.json', 'utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(appJson.env).map(([k, v]) => [k, v.value])
  );
} catch (e) {
  console.warn('Could not load fallback env vars from app.json:', e.message);
}

// 3) Environment config
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';
const FREE_TRIAL_COOLDOWN_DAYS = 14;
const BACKUP_DIR = path.join(__dirname, 'backups');

// 4) Postgres setup & ensure tables/directory exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    console.log(`Backup directory is ready at: ${BACKUP_DIR}`);
  } catch (e) {
    console.error("CRITICAL: Could not create backup directory.", e);
    process.exit(1);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id       TEXT NOT NULL,
      bot_name      TEXT PRIMARY KEY,
      session_id    TEXT,
      is_free_trial BOOLEAN DEFAULT false,
      created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deploy_keys (
      key        TEXT PRIMARY KEY,
      uses_left  INTEGER NOT NULL,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
})().catch(console.error);

// 5) DB helper functions
async function addUserBot(userId, botName, sessionId, isFreeTrial = false) {
  await pool.query(
    'INSERT INTO user_bots(user_id, bot_name, session_id, is_free_trial) VALUES($1, $2, $3, $4) ON CONFLICT (bot_name) DO NOTHING',
    [userId, botName, sessionId, isFreeTrial]
  );
}
async function getUserBots(u) {
  const r = await pool.query(
    'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',
    [u]
  );
  return r.rows.map(x => x.bot_name);
}
async function deleteUserBot(u, b) {
  await pool.query(
    'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',
    [u, b]
  );
}
async function updateUserSession(u, b, s) {
  await pool.query(
    'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',
    [s, u, b]
  );
}
async function addDeployKey(key, uses, createdBy) {
  await pool.query(
    'INSERT INTO deploy_keys(key,uses_left,created_by) VALUES($1,$2,$3)',
    [key, uses, createdBy]
  );
}
async function useDeployKey(key) {
  const res = await pool.query(
    `UPDATE deploy_keys
     SET uses_left = uses_left - 1
     WHERE key = $1 AND uses_left > 0
     RETURNING uses_left`,
    [key]
  );
  if (res.rowCount === 0) return null;
  const left = res.rows[0].uses_left;
  if (left === 0) {
    await pool.query('DELETE FROM deploy_keys WHERE key=$1', [key]);
  }
  return left;
}

async function canDeployFreeTrial(userId) {
    const res = await pool.query(
        'SELECT created_at FROM user_bots WHERE user_id = $1 AND is_free_trial = true ORDER BY created_at DESC LIMIT 1',
        [userId]
    );

    if (res.rows.length === 0) {
        return { can: true };
    }

    const lastDeployDate = new Date(res.rows[0].created_at);
    const cooldownEndDate = new Date(lastDeployDate.getTime() + FREE_TRIAL_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    if (new Date() < cooldownEndDate) {
        return { can: false, cooldown: cooldownEndDate };
    }

    return { can: true };
}

// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {};

// 7) Utilities
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

function buildKeyboard(isAdmin) {
    const baseMenu = [
        ['Get Session', 'Deploy'],
        ['Free Trial', 'My Bots'],
        ['Restore', 'Support']
    ];
    if (isAdmin) {
        return [
            ['Deploy', 'Apps'],
            ['Generate Key', 'Get Session'],
            ['Restore', 'Support']
        ];
    }
    return baseMenu;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function sendAnimatedMessage(chatId, baseText) {
    const msg = await bot.sendMessage(chatId, `⚙️ ${baseText}...`);
    await new Promise(r => setTimeout(r, 1200));
    return msg;
}

async function turnOffDyno(appName) {
    try {
        await axios.patch(`https://api.heroku.com/apps/${appName}/formation/web`,
            { quantity: 0 },
            { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
        );
        console.log(`Successfully scaled down dyno for ${appName}.`);
        return true;
    } catch (error) {
        console.error(`Failed to scale down dyno for ${appName}:`, error.response?.data?.message || error.message);
        return false;
    }
}

// 8) Build & deploy helper
async function buildWithProgress(chatId, vars, isFreeTrial = false) {
  const name = vars.APP_NAME;
  try {
    const createMsg = await bot.sendMessage(chatId, '🚀 Creating application...');
    await axios.post('https://api.heroku.com/apps', { name }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
    await bot.editMessageText('⚙️ Configuring resources...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.post(`https://api.heroku.com/apps/${name}/addons`, { plan: 'heroku-postgresql' }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } });
    await axios.put(`https://api.heroku.com/apps/${name}/buildpack-installations`, { updates: [{ buildpack: 'https://github.com/heroku/heroku-buildpack-apt' }, { buildpack: 'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' }, { buildpack: 'heroku/nodejs' }] }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } });
    await bot.editMessageText('🔧 Setting environment variables...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.patch(`https://api.heroku.com/apps/${name}/config-vars`, { ...defaultEnvVars, ...vars }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } });
    await bot.editMessageText('🛠️ Starting build process...', { chat_id: chatId, message_id: createMsg.message_id });
    const bres = await axios.post(`https://api.heroku.com/apps/${name}/builds`, { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } }, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } });
    const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
    let status = 'pending';
    const progMsg = await bot.editMessageText('Building... 0%', { chat_id: chatId, message_id: createMsg.message_id });
    for (let i = 1; i <= 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const poll = await axios.get(statusUrl, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
        status = poll.data.status;
      } catch { status = 'error'; break; }
      await bot.editMessageText(`Building... ${Math.min(100, i * 5)}%`, { chat_id: chatId, message_id: progMsg.message_id }).catch(() => {});
      if (status !== 'pending') break;
    }
    if (status === 'succeeded') {
      await bot.editMessageText('✅ Build complete!', { chat_id: chatId, message_id: progMsg.message_id });
      for (let i = 1; i <= 12; i++) {
        await new Promise(r => setTimeout(r, 5000));
        await bot.editMessageText(`[${'■'.repeat(i)}${'□'.repeat(12 - i)}] Wait for your bot to start ... (${60 - i * 5}s left)`, { chat_id: chatId, message_id: progMsg.message_id }).catch(() => {});
      }
      
      const liveMessage = await bot.editMessageText(`✅ Your bot is now live at:\nhttps://${name}.herokuapp.com`, { chat_id: chatId, message_id: progMsg.message_id });
      
      if (isFreeTrial) {
          let minutesLeft = 60;
          const countdownInterval = setInterval(async () => {
              minutesLeft -= 5;
              if (minutesLeft > 0) {
                  const countdownMessage = `✅ Your bot is live!\nhttps://${name}.herokuapp.com\n\n⏳ *Trial time left: ${minutesLeft} minutes*`;
                  bot.editMessageText(countdownMessage, { chat_id: chatId, message_id: liveMessage.message_id, parse_mode: 'Markdown' }).catch(() => {
                      clearInterval(countdownInterval);
                  });
              } else {
                  clearInterval(countdownInterval);
                  await bot.editMessageText(`⌛️ Trial period for *${name}* has ended. The app is now offline.`, { chat_id: chatId, message_id: liveMessage.message_id, parse_mode: 'Markdown' }).catch(()=>{});
                  
                  await turnOffDyno(name);

                  const adminMessage = `*Trial Expired & Dyno Off*\n\nApp Name: \`${name}\`\nUser ID: \`${chatId}\`\n\nThe app has been turned off. Please delete it.`;
                  bot.sendMessage(ADMIN_ID, adminMessage, {
                      parse_mode: 'Markdown',
                      reply_markup: {
                          inline_keyboard: [[{ text: "🗑️ Delete Now", callback_data: `admindelete:${name}:${chatId}` }]]
                      }
                  }).catch(err => console.error("Failed to send deletion request to admin:", err));
              }
          }, 5 * 60 * 1000);
      }
      return true;
    } else {
      await bot.editMessageText(`❌ Build status: ${status}. Check your Heroku dashboard for logs.`, { chat_id: chatId, message_id: progMsg.message_id });
      return false;
    }
  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    return false;
  }
}

// 9) Polling error handler
bot.on('polling_error', console.error);

// 10) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  await bot.sendMessage(cid, isAdmin ? 'Welcome, Admin! Here is your menu:' : 'Welcome! Please select an option:', { reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true } });
});

bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, 'Menu:', { reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true } });
});

bot.onText(/^\/apps$/i, msg => {
  if (msg.chat.id.toString() === ADMIN_ID) {
    // This is a placeholder for the sendAppList function you might have
    // sendAppList(msg.chat.id.toString());
    bot.sendMessage(msg.chat.id.toString(), "App list functionality is handled via 'My Bots' button for users, and other means for admin.");
  }
});

// 11) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  // --- Button Handlers ---
  if (text === 'Deploy') {
    userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
    bot.sendMessage(cid, 'Enter your Deploy key');
    return;
  }
  
  if (text === 'Free Trial') {
    try {
        const check = await canDeployFreeTrial(cid);
        if (check.can) {
            userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: true } };
            bot.sendMessage(cid, `✅ Free Trial (1 hour runtime, ${FREE_TRIAL_COOLDOWN_DAYS}-day cooldown) initiated.\n\nPlease enter your session ID:`);
        } else {
            bot.sendMessage(cid, `⏳ You have a cooldown. You can use the free trial again after:\n\n${check.cooldown.toLocaleString()}`);
        }
    } catch (e) {
        console.error("Error in Free Trial check:", e);
        bot.sendMessage(cid, "❌ An error occurred while checking your trial status. Please contact support.");
    }
    return;
  }

  if (text === 'Restore') {
      try {
          const allFiles = await fs.readdir(BACKUP_DIR);
          const userBackups = allFiles.filter(file => file.startsWith(`${cid}-`) && file.endsWith('.json'));
          if (userBackups.length === 0) return bot.sendMessage(cid, "❌ No backups found for your user ID.");
          const buttons = userBackups.map(file => ([{ text: file.replace(`${cid}-`, '').replace('.json', ''), callback_data: `dorestore:${file}` }]));
          return bot.sendMessage(cid, "Please select a backup to restore:", { reply_markup: { inline_keyboard: buttons } });
      } catch (e) {
          console.error("Error listing backups:", e);
          return bot.sendMessage(cid, "❌ Could not read backup directory.");
      }
  }

  if (text === 'Get Session') {
    const guideCaption = 
        "To get your session ID, please follow these steps carefully:\n\n" +
        "1️⃣ *Open the Link*\n" +
        "Visit: https://levanter-delta.vercel.app/\n\n" +
        "2️⃣ *Important for iPhone Users*\n" +
        "If you are on an iPhone, please open the link using the **Google Chrome** browser for best results.\n\n" +
        "3️⃣ *Skip Advertisements*\n" +
        "The website may show ads. Please close or skip any popups or advertisements to proceed.\n\n" +
        "4️⃣ *Use a CUSTOM ID*\n" +
        "You **must** enter your own unique ID in the 'Custom Session' field. Do not use the default one. A good ID could be your name or username (e.g., `johnsmith`).\n\n" +
        "Once you have copied your session ID, tap the 'Deploy' button here to continue.";

    try {
      await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', {
        caption: guideCaption,
        parse_mode: 'Markdown'
      });
    } catch {
      await bot.sendMessage(cid, guideCaption, { parse_mode: 'Markdown' });
    }
    return;
  }
  if (text === 'My Bots') {
    const bots = await getUserBots(cid);
    if (!bots.length) {
        bot.sendMessage(cid, "You haven't deployed any bots yet.");
    } else {
        const rows = chunkArray(bots, 3).map(r => r.map(n => ({ text: n, callback_data: `selectbot:${n}` })));
        bot.sendMessage(cid, 'Your deployed bots:', { reply_markup: { inline_keyboard: rows } });
    }
    return;
  }
  if (text === 'Support') {
    bot.sendMessage(cid, `For help, contact the admin: ${SUPPORT_USERNAME}`);
    return;
  }
  
  // --- Stateful flows ---
  const st = userStates[cid];
  if (!st) return;

  if (st.step === 'AWAITING_KEY') {
    const usesLeft = await useDeployKey(text.toUpperCase());
    if (usesLeft === null) return bot.sendMessage(cid, `❌ Invalid or expired key. Contact admin: ${SUPPORT_USERNAME}`);
    st.step = 'SESSION_ID';
    return bot.sendMessage(cid, `✅ Key accepted. Now, please enter your session ID:`);
  }
  if (st.step === 'SESSION_ID') {
    if (text.length < 5) return bot.sendMessage(cid, 'Session ID must be at least 5 characters long.');
    st.data.SESSION_ID = text.trim();
    st.step = 'APP_NAME';
    return bot.sendMessage(cid, 'Great. Now enter a name for your bot (e.g., my-awesome-bot):');
  }
  if (st.step === 'APP_NAME') {
    const nm = text.toLowerCase().replace(/\s+/g, '-');
    if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) return bot.sendMessage(cid, 'Invalid name. Use at least 5 lowercase letters, numbers, or hyphens.');
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
      return bot.sendMessage(cid, `❌ The name "${nm}" is already taken. Please choose another.`);
    } catch (e) {
      if (e.response?.status !== 404) return bot.sendMessage(cid, `❌ Could not verify app name. Please try again later.`);
      st.data.APP_NAME = nm;
      st.step = 'AUTO_STATUS_VIEW';
      return bot.sendMessage(cid, 'Enable automatic status view? (Reply true or false)');
    }
  }
  if (st.step === 'AUTO_STATUS_VIEW') {
    const lc = text.toLowerCase();
    if (lc !== 'true' && lc !== 'false') return bot.sendMessage(cid, 'Please reply with either "true" or "false".');
    st.data.AUTO_STATUS_VIEW = lc === 'true' ? 'no-dl' : 'false';
    const { APP_NAME, SESSION_ID, isFreeTrial } = st.data;
    const buildSuccessful = await buildWithProgress(cid, st.data, isFreeTrial);
    if (buildSuccessful) {
      await addUserBot(cid, APP_NAME, SESSION_ID, isFreeTrial);
    }
    delete userStates[cid];
  }
  
  if (st.step === 'RESTORE_SESSION_ID') {
      if (text.length < 5) return bot.sendMessage(cid, 'Session ID must be at least 5 characters long.');
      
      const newSessionId = text.trim();
      const { backupFile, appName } = st.data;
      
      bot.sendMessage(cid, `🚀 Restoring *${appName}*... This will create a new app with your backed up settings.`, { parse_mode: 'Markdown' });

      try {
          const backupPath = path.join(BACKUP_DIR, backupFile);
          const backupData = JSON.parse(await fs.readFile(backupPath, 'utf8'));
          
          const newConfigVars = backupData.configVars;
          newConfigVars.SESSION_ID = newSessionId;
          newConfigVars.APP_NAME = appName;

          const buildSuccessful = await buildWithProgress(cid, newConfigVars, false);
          if (buildSuccessful) {
              await addUserBot(cid, appName, newSessionId, false);
          }
      } catch (buildError) {
          console.error("Restore build error:", buildError);
          bot.sendMessage(cid, `❌ A critical error occurred during the restoration build process.`);
      } finally {
          delete userStates[cid];
      }
  }
});


// 12) Callback query handler
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra] = q.data.split(':');
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    return bot.sendMessage(cid, `Manage app "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Info', callback_data: `info:${payload}` }, { text: 'Restart', callback_data: `restart:${payload}` }],
          [{ text: 'Backup', callback_data: `backup:${payload}` }, { text: 'Logs', callback_data: `logs:${payload}` }],
          [{ text: 'Delete', callback_data: `${isUserBot ? 'userdelete' : 'delete'}:${payload}` }, { text: 'Set Variable', callback_data: `setvar:${payload}` }]
        ]
      }
    });
  }

  if (action === 'backup') {
      const appName = payload;
      const backupPath = path.join(BACKUP_DIR, `${cid}-${appName}.json`);
      const loadingMsg = await bot.sendMessage(cid, `Creating backup for ${appName}...`);

      try {
          const configRes = await axios.get(`https://api.heroku.com/apps/${appName}/config-vars`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
          const dbRes = await pool.query('SELECT session_id FROM user_bots WHERE bot_name = $1', [appName]);

          const backupData = {
              appName: appName,
              backedUpAt: new Date().toISOString(),
              userId: cid,
              sessionId: dbRes.rows[0]?.session_id || null,
              configVars: configRes.data
          };

          await fs.writeFile(backupPath, JSON.stringify(backupData, null, 2));
          return bot.editMessageText(`✅ Backup for *${appName}* created successfully!`, {
              chat_id: cid, message_id: loadingMsg.message_id, parse_mode: 'Markdown'
          });

      } catch (e) {
          console.error("Backup failed:", e);
          return bot.editMessageText(`❌ Failed to create backup. Error: ${e.message}`, {
              chat_id: cid, message_id: loadingMsg.message_id
          });
      }
  }

  if (action === 'dorestore') {
      const backupFile = payload;
      const appName = backupFile.replace(`${cid}-`, '').replace('.json', '');
      
      await bot.editMessageText(`Checking availability for *${appName}*...`, { chat_id: cid, message_id: q.message.message_id, parse_mode: 'Markdown' });

      try {
          await axios.get(`https://api.heroku.com/apps/${appName}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}` } });
          return bot.sendMessage(cid, `❌ The app name *${appName}* is already deployed on Heroku. Please delete the existing app before restoring this backup.`, { parse_mode: 'Markdown' });
      } catch (error) {
          if (error.response?.status === 404) {
              userStates[cid] = {
                  step: 'RESTORE_SESSION_ID',
                  data: { backupFile: backupFile, appName: appName }
              };
              return bot.sendMessage(cid, `✅ The name *${appName}* is available.\n\nPlease enter the *new* session ID to use for this restored bot:`, { parse_mode: 'Markdown' });
          } else {
              console.error("Restore check failed:", error);
              return bot.sendMessage(cid, "❌ An error occurred while checking the app's status on Heroku.");
          }
      }
  }

  if (action === 'admindelete') {
      if (cid !== ADMIN_ID) return;
      const appToDelete = payload;
      const originalUserId = extra;
      const animMsg = await bot.editMessageText(`Deleting expired trial app: ${appToDelete}...`, { chat_id: cid, message_id: q.message.message_id, reply_markup: null });
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' } });
          await pool.query('DELETE FROM user_bots WHERE bot_name = $1', [appToDelete]);
          await bot.editMessageText(`✅ Expired trial app *${appToDelete}* has been permanently deleted.`, { chat_id: cid, message_id: animMsg.message_id, parse_mode: 'Markdown' });
          if (originalUserId) {
              bot.sendMessage(originalUserId, `🔔 Your free trial app, "${appToDelete}", has expired and has been deleted by the admin.`).catch(err => console.log(`Failed to notify user ${originalUserId}:`, err.message));
          }
      } catch (error) {
          if (error.response?.status === 404) {
              await pool.query('DELETE FROM user_bots WHERE bot_name = $1', [appToDelete]);
              await bot.editMessageText(`⚠️ App *${appToDelete}* was already deleted on Heroku. Removed it from the database.`, { chat_id: cid, message_id: animMsg.message_id, parse_mode: 'Markdown' });
          } else {
              await bot.editMessageText(`❌ Error deleting app *${appToDelete}*: ${error.response?.data?.message || error.message}`, { chat_id: cid, message_id: animMsg.message_id, parse_mode: 'Markdown' });
          }
      }
      return;
  }
  
  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    return bot.sendMessage(cid, `Generated key: \`${key}\`\nUses: ${uses}`, { parse_mode: 'Markdown' });
  }

  // Add other callback query handlers here (info, restart, logs, etc.) if you have them.
});

console.log('Bot is running...');
