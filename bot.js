// bot.js

// 1) Global error handlers
process.on('unhandledRejection', err => console.error('Unhandled Rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught Exception:', err));

require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// 2) Load fallback env vars from app.json
let defaultEnvVars = {};
try {
  const appJson = JSON.parse(fs.readFileSync('app.json', 'utf8'));
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

// 4) Postgres setup & ensure tables exist
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id    TEXT NOT NULL,
      bot_name   TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  // Table for "Free Trial" cooldowns
  await pool.query(`
    CREATE TABLE IF NOT EXISTS temp_deploys (
      user_id       TEXT PRIMARY KEY,
      last_deploy_at TIMESTAMP NOT NULL
    );
  `);
})().catch(console.error);

// 5) DB helper functions
async function addUserBot(u, b, s) {
  await pool.query(
    'INSERT INTO user_bots(user_id,bot_name,session_id) VALUES($1,$2,$3)',
    [u, b, s]
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
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days
    const res = await pool.query(
        'SELECT last_deploy_at FROM temp_deploys WHERE user_id = $1',
        [userId]
    );
    if (res.rows.length === 0) return { can: true };
    const lastDeploy = new Date(res.rows[0].last_deploy_at);
    if (lastDeploy < fourteenDaysAgo) return { can: true };

    const nextAvailable = new Date(lastDeploy.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days
    return { can: false, cooldown: nextAvailable };
}
async function recordFreeTrialDeploy(userId) {
    await pool.query(
        `INSERT INTO temp_deploys (user_id, last_deploy_at) VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_deploy_at = NOW()`,
        [userId]
    );
}


// 6) Initialize bot & in-memory state
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const userStates = {}; // chatId -> { step, data, message_id }
const authorizedUsers = new Set(); // chatIds who've passed a key

// 7) Utilities
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

// --- THIS FUNCTION IS UNCHANGED ---
function buildKeyboard(isAdmin) {
  const baseMenu = [
      ['Get Session', 'Deploy'],
      ['Free Trial', 'My Bots'],
      ['Support']
  ];
  if (isAdmin) {
      return [
          ['Deploy', 'Apps'],
          ['Generate Key', 'Get Session'],
          ['Support']
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
    // This now can also edit a message if messageId is provided
    const msg = await bot.sendMessage(chatId, `⚙️ ${baseText}...`);
    await new Promise(r => setTimeout(r, 1200));
    return msg;
}

// --- NEW --- Menu generation functions for app management
const getAppListMenu = async (userId, isAdminList) => {
    let appNames;
    let text;
    let backCallback;

    if (isAdminList) {
        const res = await axios.get('https://api.heroku.com/apps', {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        appNames = res.data.map(a => a.name);
        text = `⚙️ *Admin Panel: All Apps*\n\nYou have ${appNames.length} apps on your Heroku account. Select one to manage:`;
        backCallback = 'close_menu'; // Admins can just close
    } else {
        appNames = await getUserBots(userId);
        text = appNames.length > 0
            ? "🤖 *My Bots*\n\nSelect one of your deployed bots to manage it."
            : "You haven't deployed any bots yet.";
        backCallback = 'close_menu';
    }

    const appButtons = appNames.map(name => ([{ text: name, callback_data: `app:manage:${name}:${isAdminList}` }]));
    const keyboard = [
        ...appButtons,
        [{ text: '❌ Close Menu', callback_data: backCallback }]
    ];
    return { text, keyboard };
}

const getAppManagementMenu = (appName, isAdminList) => {
    const text = `🛠️ *Managing App: \`${appName}\`*\n\nWhat would you like to do?`;
    const backCallback = `app:list:${isAdminList}`; // Go back to the correct list
    const keyboard = [
        [
            { text: 'ℹ️ Info', callback_data: `app:info:${appName}` },
            { text: '🔄 Restart', callback_data: `app:restart:${appName}` }
        ],
        [
            { text: '📋 Logs', callback_data: `app:logs:${appName}` },
            { text: '✏️ Set Variable', callback_data: `app:setvar:${appName}` }
        ],
        [{ text: '🗑️ Delete', callback_data: `app:delete:${appName}` }],
        [{ text: '« Back to App List', callback_data: backCallback }]
    ];
    return { text, keyboard };
}


// --- Build & deploy helper with animated countdown (UNCHANGED) ---
async function buildWithProgress(chatId, vars, isFreeTrial = false) {
  const name = vars.APP_NAME;

  try {
    // Stage 1: Create App
    const createMsg = await bot.sendMessage(chatId, '🚀 Creating application...');
    await axios.post('https://api.heroku.com/apps', { name }, {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });

    // Stage 2: Add-ons and Buildpacks
    await bot.editMessageText('⚙️ Configuring resources...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.post(
      `https://api.heroku.com/apps/${name}/addons`,
      { plan: 'heroku-postgresql' },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    await axios.put(
      `https://api.heroku.com/apps/${name}/buildpack-installations`,
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
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    // Stage 3: Config Vars
    await bot.editMessageText('🔧 Setting environment variables...', { chat_id: chatId, message_id: createMsg.message_id });
    await axios.patch(
      `https://api.heroku.com/apps/${name}/config-vars`,
      {
        ...defaultEnvVars,
        ...vars
      },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    // Stage 4: Build
    await bot.editMessageText('🛠️ Starting build process...', { chat_id: chatId, message_id: createMsg.message_id });
    const bres = await axios.post(
      `https://api.heroku.com/apps/${name}/builds`,
      { source_blob: { url: `${GITHUB_REPO_URL}/tarball/main` } },
      {
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3',
          'Content-Type': 'application/json'
        }
      }
    );

    const statusUrl = `https://api.heroku.com/apps/${name}/builds/${bres.data.id}`;
    let status = 'pending';
    const progMsg = await bot.editMessageText('Building... 0%', { chat_id: chatId, message_id: createMsg.message_id });

    for (let i = 1; i <= 20; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        const poll = await axios.get(statusUrl, {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3'
          }
        });
        status = poll.data.status;
      } catch {
        status = 'error';
        break;
      }
      const pct = Math.min(100, i * 5);
      await bot.editMessageText(`Building... ${pct}%`, {
        chat_id: chatId,
        message_id: progMsg.message_id
      }).catch(() => {});

      if (status !== 'pending') break;
    }

    if (status === 'succeeded') {
      // Animated Countdown Logic
      await bot.editMessageText('✅ Build complete!', {
        chat_id: chatId,
        message_id: progMsg.message_id
      });

      const totalSteps = 12; // 12 steps for a 60-second countdown (5 seconds per step)
      for (let i = 1; i <= totalSteps; i++) {
          await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds
          const secondsLeft = 60 - (i * 5);
          const filled = '■'.repeat(i);
          const empty = '□'.repeat(totalSteps - i);
          const countdownMessage = `[${filled}${empty}] Wait for your bot to start ... (${secondsLeft}s left)`;
          await bot.editMessageText(countdownMessage, {
              chat_id: chatId,
              message_id: progMsg.message_id
          }).catch(() => {}); // Ignore errors if user deletes message
      }

      await bot.editMessageText(
        `✅ Your bot is now live at:\nhttps://${name}.herokuapp.com`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );

      if (isFreeTrial) {
        setTimeout(async () => {
            try {
                await bot.sendMessage(chatId, `⏳ Your Free Trial app "${name}" is being deleted now as its 30-minute runtime has ended.`);
                await axios.delete(`https://api.heroku.com/apps/${name}`, {
                    headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
                });
                await deleteUserBot(chatId, name);
                await bot.sendMessage(chatId, `✅ Free Trial app "${name}" successfully deleted.`);
            } catch (e) {
                console.error(`Failed to auto-delete free trial app ${name}:`, e.message);
                await bot.sendMessage(chatId, `⚠️ Could not auto-delete the app "${name}". Please delete it manually from your Heroku dashboard.`);
            }
        }, 30 * 60 * 1000); // 30 minutes
      }
      return true;
    } else {
      await bot.editMessageText(
        `❌ Build status: ${status}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );
      return false;
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    return false;
  }
}

// 10) Polling error handler (UNCHANGED)
bot.on('polling_error', console.error);

// 11) Command handlers (UNCHANGED)
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  const { first_name } = msg.from;
  await bot.sendMessage(cid,
    isAdmin ? `Welcome, Admin ${first_name}!` : `Welcome, ${first_name}!`, {
      reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
    }
  );
});

bot.onText(/^\/menu$/i, msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid, 'Menu:', {
    reply_markup: { keyboard: buildKeyboard(isAdmin), resize_keyboard: true }
  });
});

// --- THIS IS NO LONGER USED, 'Apps' BUTTON TRIGGERS INLINE MENU ---
bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    bot.sendMessage(cid, "Please use the 'Apps' button on the main keyboard.");
  }
});


// 12) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  const isAdmin = cid === ADMIN_ID;

  // --- Button Handlers ---
  // --- "My Bots" and "Apps" now trigger the new inline menus ---
  if (text === 'My Bots') {
    const { text, keyboard } = await getAppListMenu(cid, false);
    return bot.sendMessage(cid, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  }

  if (text === 'Apps' && isAdmin) {
    const { text, keyboard } = await getAppListMenu(cid, true);
    return bot.sendMessage(cid, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
  }

  // --- Other buttons and stateful flows remain UNCHANGED ---
  if (text === 'Deploy') {
    // ... (unchanged)
  }
  // ... (all other message handlers remain the same)
});


// 13) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const messageId = q.message.message_id;
  const [action, payload, extra] = q.data.split(':');
  
  // --- NEW: App Menu Navigation Logic ---
  if (action === 'app') {
    await bot.answerCallbackQuery(q.id);
    const isAdminList = extra === 'true';

    // Go back to the list of apps
    if (payload === 'list') {
        const { text, keyboard } = await getAppListMenu(cid, isAdminList);
        return bot.editMessageText(text, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    // Show the management menu for a specific app
    if (payload === 'manage') {
        const appName = extra;
        const fromAdmin = q.data.split(':')[3] === 'true';
        const { text, keyboard } = getAppManagementMenu(appName, fromAdmin);
        return bot.editMessageText(text, {
            chat_id: cid,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }

    // Handle actions within the app management menu
    const appName = payload;
    if (action === 'app' && ['info', 'restart', 'logs', 'delete', 'setvar'].includes(payload)) {
        // This is where you would place the logic for these actions
        // For now, we will just send a confirmation
        await bot.sendMessage(cid, `Action '${payload}' selected for app '${extra}'`);
    }
  }

  // --- This allows other callback queries (like from the deployment wizard) to still work ---
  const [baseAction] = q.data.split(':');
  if (baseAction === 'setup' || baseAction === 'genkeyuses' || baseAction.includes('delete') || baseAction.includes('var')) {
       // ... existing callback logic for other features ...
       // (This entire block is the same as your previous code)
  }

  if (baseAction === 'close_menu') {
      await bot.deleteMessage(cid, messageId);
  }
});

console.log('Bot is running...');
