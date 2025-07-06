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

// --- NEW --- Menu Definitions
const getMainMenu = (isAdmin) => {
    const text = "👋 *Welcome!* I'm your Heroku deployment assistant.\n\nSelect an option below to get started.";
    let keyboard = [
        [{ text: '🚀 Deploy New Bot', callback_data: 'deploy' }],
        [{ text: '🤖 My Bots', callback_data: 'navigate:my_bots' }],
        [{ text: '🎁 Free Trial', callback_data: 'deploy_trial' }],
        [{ text: 'ℹ️ Get Session', callback_data: 'get_session' }, { text: '📞 Support', callback_data: 'support' }]
    ];
    if (isAdmin) {
        keyboard = [
            [{ text: '🚀 Deploy New Bot', callback_data: 'deploy' }],
            [{ text: '⚙️ Admin: All Apps', callback_data: 'admin:apps' }, { text: '🔑 Admin: Generate Key', callback_data: 'admin:genkey' }],
            [{ text: '📞 Support', callback_data: 'support' }]
        ];
    }
    return { text, keyboard };
};

const getMyBotsMenu = async (userId) => {
    const userBots = await getUserBots(userId);
    const text = userBots.length > 0 ? '🤖 Here are your deployed bots. Select one to manage it.' : "You haven't deployed any bots yet.";
    const botButtons = userBots.map(botName => ([{ text: botName, callback_data: `app_menu:${botName}` }]));
    const keyboard = [
        ...botButtons,
        [{ text: '« Back to Main Menu', callback_data: 'navigate:main' }]
    ];
    return { text, keyboard };
};

const getAppMenu = (appName, isUserBot) => {
    const text = `🛠️ *Managing App: \`${appName}\`*\n\nWhat would you like to do?`;
    let backButton;
    if (isUserBot) {
        backButton = { text: '« Back to My Bots', callback_data: 'navigate:my_bots' };
    } else {
        backButton = { text: '« Back to All Apps', callback_data: 'admin:apps' };
    }

    const keyboard = [
        [
            { text: 'ℹ️ Info', callback_data: `info:${appName}` },
            { text: '🔄 Restart', callback_data: `restart:${appName}` },
            { text: '📋 Logs', callback_data: `logs:${appName}` }
        ],
        [
            { text: '✏️ Set Variable', callback_data: `setvar:${appName}` },
            { text: '❌ Delete', callback_data: `delete:${appName}:${isUserBot ? 'user' : 'admin'}` }
        ],
        [backButton]
    ];
    return { text, keyboard };
};


function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function sendAnimatedMessage(chatId, baseText) {
    const msg = await bot.sendMessage(chatId, `⚙️ ${baseText}...`);
    await new Promise(r => setTimeout(r, 1200)); // Wait for animation
    return msg;
}


// 8) Send Heroku apps list (for Admin)
async function sendAppList(chatId, messageId) {
    try {
        const res = await axios.get('https://api.heroku.com/apps', {
            headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
        });
        const apps = res.data.map(a => a.name);
        const text = apps.length ? `Found ${apps.length} apps. Select one to manage:` : 'No apps found on your Heroku account.';
        const appButtons = apps.map(name => ([{ text: name, callback_data: `app_menu:${name}:admin` }]));
        const keyboard = [
            ...appButtons,
            [{ text: '« Back to Main Menu', callback_data: 'navigate:main' }]
        ];
        
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (e) {
        await bot.editMessageText(`Error fetching apps: ${e.message}`, { chatId, message_id: messageId });
    }
}

// ... (buildWithProgress function remains the same)
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
        // Schedule deletion after 30 minutes
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
        }, 30 * 60 * 1000); // 30 minutes in milliseconds
      }
      return true; // Indicate success
    } else {
      await bot.editMessageText(
        `❌ Build status: ${status}. Check your Heroku dashboard for logs.`,
        { chat_id: chatId, message_id: progMsg.message_id }
      );
      return false; // Indicate failure
    }

  } catch (error) {
    const errorMsg = error.response?.data?.message || error.message;
    bot.sendMessage(chatId, `An error occurred during deployment: ${errorMsg}\n\nPlease check the Heroku dashboard or try again.`);
    return false; // Indicate failure
  }
}

// 10) Polling error handler
bot.on('polling_error', console.error);

// 11) Command handlers
bot.onText(/^\/start$/, async msg => {
  const cid = msg.chat.id.toString();
  const isAdmin = cid === ADMIN_ID;
  const { text, keyboard } = getMainMenu(isAdmin);

  await bot.sendMessage(cid, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
  });
});

// 12) Message handler for TEXT INPUT (for deployment flow)
bot.on('message', async msg => {
    const cid = msg.chat.id.toString();
    const text = msg.text?.trim();

    // This handler is now ONLY for the stateful deployment flow
    const st = userStates[cid];
    if (!st || !text) return;

    if (st.step === 'AWAITING_KEY') {
        const keyAttempt = text.toUpperCase();
        const usesLeft = await useDeployKey(keyAttempt);
        if (usesLeft === null) {
            return bot.sendMessage(cid, `❌ Invalid or expired key.\n\nPlease contact the admin for a valid key: ${SUPPORT_USERNAME}`);
        }
        authorizedUsers.add(cid);
        st.step = 'SESSION_ID';
        await bot.sendMessage(ADMIN_ID, `🔑 Key Used By: @${msg.from.username || cid}. Uses Left: ${usesLeft}`, { parse_mode: 'Markdown' });
        return bot.sendMessage(cid, '✅ Key accepted. Now, please enter your session ID:');
    }

    if (st.step === 'SESSION_ID') {
        if (text.length < 5) return bot.sendMessage(cid, 'Session ID must be at least 5 characters long.');
        st.data.SESSION_ID = text.trim();
        st.step = 'APP_NAME';
        return bot.sendMessage(cid, 'Great. Now enter a name for your bot (e.g., my-awesome-bot):');
    }

    if (st.step === 'APP_NAME') {
        const nm = text.toLowerCase().replace(/\s+/g, '-');
        if (nm.length < 5 || !/^[a-z0-9-]+$/.test(nm)) {
            return bot.sendMessage(cid, 'Invalid name. Use at least 5 lowercase letters, numbers, or hyphens.');
        }
        try {
            await axios.get(`https://api.heroku.com/apps/${nm}`, {
                headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
            });
            return bot.sendMessage(cid, `❌ The name "${nm}" is already taken. Please choose another.`);
        } catch (e) {
            if (e.response?.status === 404) {
                st.data.APP_NAME = nm;
                st.data.AUTO_STATUS_VIEW = 'no-dl'; // Default value, can be changed if needed
                delete userStates[cid];
                const buildSuccessful = await buildWithProgress(cid, st.data, st.data.isFreeTrial);
                if (buildSuccessful) {
                    await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
                    if (st.data.isFreeTrial) await recordFreeTrialDeploy(cid);
                }
            } else {
                return bot.sendMessage(cid, '❌ Could not verify app name. The Heroku API might be down.');
            }
        }
    }
    
    if (st.step === 'SETVAR_ENTER_VALUE') {
        // ... (this part remains the same)
    }
});


// 13) Callback query handler for INLINE BUTTONS
bot.on('callback_query', async q => {
    const cid = q.message.chat.id.toString();
    const messageId = q.message.message_id;
    const [action, payload, extra] = q.data.split(':');
    const isAdmin = cid === ADMIN_ID;

    await bot.answerCallbackQuery(q.id); // Acknowledge the button press

    // --- Navigation ---
    if (action === 'navigate') {
        if (payload === 'main') {
            const { text, keyboard } = getMainMenu(isAdmin);
            await bot.editMessageText(text, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        }
        if (payload === 'my_bots') {
            const { text, keyboard } = await getMyBotsMenu(cid);
            await bot.editMessageText(text, { chat_id: cid, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
        }
    }
    
    // --- App Menu ---
    if (action === 'app_menu') {
        const isUserBot = extra !== 'admin';
        const { text, keyboard } = getAppMenu(payload, isUserBot);
        await bot.editMessageText(text, { chat_id: cid, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    }

    // --- Admin Actions ---
    if (action === 'admin') {
        if (payload === 'apps') {
            await sendAppList(cid, messageId);
        }
        if (payload === 'genkey') {
            // Logic to generate key (can send a new message or edit)
            const key = generateKey();
            const uses = 5; // Default uses
            await addDeployKey(key, uses, cid);
            await bot.sendMessage(cid, `🔑 New key generated:\n\`${key}\`\n\nThis key has ${uses} uses.`);
        }
    }
    
    // --- Deployment Triggers ---
    if (action === 'deploy' || action === 'deploy_trial') {
        const isFreeTrial = action === 'deploy_trial';
        if (isFreeTrial) {
            const check = await canDeployFreeTrial(cid);
            if (!check.can) {
                return bot.sendMessage(cid, `⏳ You have already used your Free Trial. You can use it again after:\n\n${check.cooldown.toLocaleString()}`);
            }
            userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: true } };
            return bot.sendMessage(cid, '✅ Free Trial initiated. Please enter your session ID to continue:');
        } else if(isAdmin) {
            userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
            return bot.sendMessage(cid, '🔐 Admin access. Please enter your session ID to continue:');
        } else {
            userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
            return bot.sendMessage(cid, 'Please enter your Deploy Key to continue:');
        }
    }
    
    // --- Standalone Actions ---
    if (action === 'get_session' || action === 'support') {
        // These send new messages, so they don't need to edit the menu.
        if (action === 'get_session') {
            const guideCaption = "To get your session ID, follow these steps:\n\n..."; // Your detailed guide text
            try {
                await bot.sendPhoto(cid, 'https://files.catbox.moe/an2cc1.jpeg', { caption: guideCaption, parse_mode: 'Markdown' });
            } catch {
                await bot.sendMessage(cid, guideCaption, { parse_mode: 'Markdown' });
            }
        }
        if (action === 'support') {
            await bot.sendMessage(cid, `For help, contact the admin: ${SUPPORT_USERNAME}`);
        }
    }
    
    // --- App Management Actions ---
    if (['info', 'restart', 'logs', 'delete', 'setvar'].includes(action)) {
        // These can remain largely the same, but they might send new messages
        // or you could have them edit the menu message with the result.
        // For simplicity, we'll keep their current behavior.
        if (action === 'info') {
            // ... your info logic
        }
        if (action === 'restart') {
            // ... your restart logic
        }
        // etc...
    }
});


console.log('Bot is running...');
