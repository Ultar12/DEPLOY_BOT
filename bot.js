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
const userStates = {}; // chatId -> { step, data }
const authorizedUsers = new Set(); // chatIds who've passed a key

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
      ['Free Trial', 'My Bots'], // "Free Trial" button
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
    const msg = await bot.sendMessage(chatId, `⚙️ ${baseText}...`);
    await new Promise(r => setTimeout(r, 1200)); // Wait for animation
    return msg;
}


// 8) Send Heroku apps list
async function sendAppList(chatId) {
  try {
    const res = await axios.get('https://api.heroku.com/apps', {
      headers: {
        Authorization: `Bearer ${HEROKU_API_KEY}`,
        Accept: 'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a => a.name);
    if (!apps.length) {
      return bot.sendMessage(chatId, 'No apps found.');
    }
    const rows = chunkArray(apps, 3).map(r =>
      r.map(name => ({ text: name, callback_data: `selectapp:${name}` }))
    );
    await bot.sendMessage(chatId,
      `Total apps: ${apps.length}\nSelect an app:`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (e) {
    bot.sendMessage(chatId, `Error fetching apps: ${e.message}`);
  }
}

// 9) Build & deploy helper with animated countdown
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
  delete userStates[cid];
  const { first_name, last_name, username } = msg.from;
  console.log(`User: ${[first_name, last_name].filter(Boolean).join(' ')} (@${username || 'N/A'}) [${cid}]`);
  await bot.sendMessage(cid,
    isAdmin ? 'Welcome, Admin! Here is your menu:' : 'Welcome! Please select an option:', {
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

bot.onText(/^\/apps$/i, msg => {
  const cid = msg.chat.id.toString();
  if (cid === ADMIN_ID) {
    sendAppList(cid);
  }
});

// 12) Message handler for buttons & state machine
bot.on('message', async msg => {
  const cid = msg.chat.id.toString();
  const text = msg.text?.trim();
  if (!text) return;

  const lc = text.toLowerCase();
  const isAdmin = cid === ADMIN_ID;

  // --- Button Handlers ---
  if (text === 'Deploy') {
    if (isAdmin) {
      userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, '🔐 Admin access granted. Please enter your session ID');
    } else {
      userStates[cid] = { step: 'AWAITING_KEY', data: { isFreeTrial: false } };
      return bot.sendMessage(cid, 'Enter your Deploy key');
    }
  }

  if (text === 'Free Trial') {
    const check = await canDeployFreeTrial(cid);
    if (!check.can) {
        return bot.sendMessage(cid, `⏳ You have already used your Free Trial. You can use it again after:\n\n${check.cooldown.toLocaleString()}`);
    }
    userStates[cid] = { step: 'SESSION_ID', data: { isFreeTrial: true } };
    return bot.sendMessage(cid, '✅ Free Trial (30 mins runtime, 14-day cooldown) initiated.\n\nPlease enter your session ID:');
  }

  if (text === 'Apps' && isAdmin) {
    return sendAppList(cid);
  }

  if (text === 'Generate Key' && isAdmin) {
    const buttons = [
      [1, 2, 3, 4, 5].map(n => ({
        text: String(n),
        callback_data: `genkeyuses:${n}`
      }))
    ];
    return bot.sendMessage(cid, 'How many uses for this key?', {
      reply_markup: { inline_keyboard: buttons }
    });
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
    if (!bots.length) return bot.sendMessage(cid, "You haven't deployed any bots yet.");
    const rows = chunkArray(bots, 3).map(r => r.map(n => ({
      text: n,
      callback_data: `selectbot:${n}`
    })));
    return bot.sendMessage(cid, 'Your deployed bots:', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  if (text === 'Support') {
    return bot.sendMessage(cid, `For help, contact the admin: ${SUPPORT_USERNAME}`);
  }

  // --- Stateful flows ---
  const st = userStates[cid];
  if (!st) return;

  if (st.step === 'AWAITING_KEY') {
    const keyAttempt = text.toUpperCase();
    const usesLeft = await useDeployKey(keyAttempt);
    if (usesLeft === null) {
      return bot.sendMessage(cid, `❌ Invalid or expired key.\n\nPlease contact the admin for a valid key: ${SUPPORT_USERNAME}`);
    }
    authorizedUsers.add(cid);
    st.step = 'SESSION_ID'; // Keep data, just change step

    const { first_name, last_name, username } = msg.from;
    const userDetails = [
      `*Name:* ${first_name || ''} ${last_name || ''}`,
      `*Username:* @${username || 'N/A'}`,
      `*Chat ID:* \`${cid}\``
    ].join('\n');

    await bot.sendMessage(ADMIN_ID,
      `🔑 *Key Used By:*\n${userDetails}\n\n*Uses Left:* ${usesLeft}`,
      { parse_mode: 'Markdown' }
    );
    return bot.sendMessage(cid, '✅ Key accepted. Now, please enter your session ID:');
  }

  if (st.step === 'SESSION_ID') {
    if (text.length < 5) {
      return bot.sendMessage(cid, 'Session ID must be at least 5 characters long.');
    }
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
        headers: {
          Authorization: `Bearer ${HEROKU_API_KEY}`,
          Accept: 'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid, `❌ The name "${nm}" is already taken. Please choose another.`);
    } catch (e) {
      if (e.response?.status === 404) {
        st.data.APP_NAME = nm;
        st.step = 'AUTO_STATUS_VIEW';
        return bot.sendMessage(cid, 'Enable automatic status view? (Reply true or false)');
      }
      console.error(`Error checking app name "${nm}":`, e.message);
      return bot.sendMessage(cid, `❌ Could not verify app name. The Heroku API might be down. Please try again later.`);
    }
  }

  if (st.step === 'AUTO_STATUS_VIEW') {
    if (lc !== 'true' && lc !== 'false') {
      return bot.sendMessage(cid, 'Please reply with either "true" or "false".');
    }
    st.data.AUTO_STATUS_VIEW = lc === 'true' ? 'no-dl' : 'false';
    const { APP_NAME, SESSION_ID, isFreeTrial } = st.data;
    if (!APP_NAME || !SESSION_ID) {
      delete userStates[cid];
      return bot.sendMessage(cid, '❌ Critical error: Missing app name or session ID. Please start over.');
    }
    
    const buildSuccessful = await buildWithProgress(cid, st.data, isFreeTrial);

    if (buildSuccessful) {
        await addUserBot(cid, APP_NAME, SESSION_ID);

        if (isFreeTrial) {
            await recordFreeTrialDeploy(cid);
            bot.sendMessage(cid, `🔔 Reminder: This Free Trial app will be automatically deleted in 30 minutes.`);
        }
        
        const { first_name, last_name, username } = msg.from;
        const appUrl = `https://${APP_NAME}.herokuapp.com`;
        const userDetails = [
          `*Name:* ${first_name || ''} ${last_name || ''}`,
          `*Username:* @${username || 'N/A'}`,
          `*Chat ID:* \`${cid}\``
        ].join('\n');
        
        const appDetails = `*App Name:* \`${APP_NAME}\`\n*URL:* ${appUrl}\n*Session ID:* \`${SESSION_ID}\`\n*Type:* ${isFreeTrial ? 'Free Trial' : 'Permanent'}`;

        await bot.sendMessage(ADMIN_ID, 
            `🚀 *New App Deployed*\n\n*App Details:*\n${appDetails}\n\n*Deployed By:*\n${userDetails}`,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
    }
    
    delete userStates[cid];
    return;
  }

  if (st.step === 'SETVAR_ENTER_VALUE') {
    const { APP_NAME, VAR_NAME } = st.data;
    const newVal = text.trim();
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        { [VAR_NAME]: newVal },
        {
          headers: {
            Authorization: `Bearer ${HEROKU_API_KEY}`,
            Accept: 'application/vnd.heroku+json; version=3',
            'Content-Type': 'application/json'
          }
        }
      );
      if (VAR_NAME === 'SESSION_ID') {
        await updateUserSession(cid, APP_NAME, newVal);
      }
      delete userStates[cid];
      return bot.sendMessage(cid, `✅ ${VAR_NAME} updated successfully.`);
    } catch (e) {
      return bot.sendMessage(cid, `Error updating variable: ${e.message}`);
    }
  }
});

// 13) Callback query handler for inline buttons
bot.on('callback_query', async q => {
  const cid = q.message.chat.id.toString();
  const [action, payload, extra, flag] = q.data.split(':');
  await bot.answerCallbackQuery(q.id).catch(() => {});

  if (action === 'genkeyuses') {
    const uses = parseInt(payload, 10);
    const key = generateKey();
    await addDeployKey(key, uses, cid);
    return bot.sendMessage(cid, `Generated key: \`${key}\`\nUses: ${uses}`, { parse_mode: 'Markdown' });
  }

  if (action === 'selectapp' || action === 'selectbot') {
    const isUserBot = action === 'selectbot';
    return bot.sendMessage(cid, `Manage app "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Info', callback_data: `info:${payload}` },
            { text: 'Restart', callback_data: `restart:${payload}` },
            { text: 'Logs', callback_data: `logs:${payload}` }
          ],
          [
            { text: 'Delete', callback_data: `${isUserBot ? 'userdelete' : 'delete'}:${payload}` },
            { text: 'Set Variable', callback_data: `setvar:${payload}` }
          ]
        ]
      }
    });
  }

  if (action === 'info') {
    const animMsg = await sendAnimatedMessage(cid, 'Fetching app info');
    try {
      const appRes = await axios.get(`https://api.heroku.com/apps/${payload}`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });
      const configRes = await axios.get(`https://api.heroku.com/apps/${payload}/config-vars`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });

      const appData = appRes.data;
      const configData = configRes.data;

      const info = `*ℹ️ App Info: ${appData.name}*\n\n` +
                   `*URL:* [${appData.web_url}](${appData.web_url})\n` +
                   `*Last Release:* ${new Date(appData.released_at).toLocaleString()}\n` +
                   `*Stack:* ${appData.stack.name}\n` +
                   `*Region:* ${appData.region.name}\n\n` +
                   `*🔧 Key Config Vars:*\n` +
                   `  \`SESSION_ID\`: ${configData.SESSION_ID ? '✅ Set' : '❌ Not Set'}\n` +
                   `  \`AUTO_STATUS_VIEW\`: \`${configData.AUTO_STATUS_VIEW || 'false'}\`\n`;

      return bot.editMessageText(info, { chat_id: cid, message_id: animMsg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) {
      return bot.editMessageText(`Error fetching info: ${e.message}`, { chat_id: cid, message_id: animMsg.message_id });
    }
  }

  if (action === 'restart') {
    const animMsg = await sendAnimatedMessage(cid, 'Restarting app');
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`, {
        headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
      });
      return bot.editMessageText(`✅ "${payload}" restarted successfully.`, { chat_id: cid, message_id: animMsg.message_id });
    } catch (e) {
      return bot.editMessageText(`Error restarting: ${e.message}`, { chat_id: cid, message_id: animMsg.message_id });
    }
  }

  if (action === 'logs') {
    const animMsg = await sendAnimatedMessage(cid, 'Fetching logs');
    try {
      const sess = await axios.post(`https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: false, lines: 100 },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      const logRes = await axios.get(sess.data.logplex_url);
      const logs = logRes.data.trim().slice(-4000);
      await bot.deleteMessage(cid, animMsg.message_id);
      return bot.sendMessage(cid, `Logs for "${payload}":\n\`\`\`\n${logs || 'No recent logs.'}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (e) {
      return bot.editMessageText(`Error fetching logs: ${e.message}`, { chat_id: cid, message_id: animMsg.message_id });
    }
  }

  if (action === 'delete' || action === 'userdelete') {
      return bot.sendMessage(cid, `Are you sure you want to delete the app "${payload}"? This action cannot be undone.`, {
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Yes, I'm sure", callback_data: `confirmdelete:${payload}:${action}` },
            { text: "❌ No, cancel", callback_data: 'canceldelete' }
          ]]
        }
      });
  }
  
  if (action === 'confirmdelete') {
      const appToDelete = payload;
      const originalAction = extra;
      const animMsg = await sendAnimatedMessage(cid, `Deleting ${appToDelete}`);
      try {
          await axios.delete(`https://api.heroku.com/apps/${appToDelete}`, {
              headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3' }
          });
          if (originalAction === 'userdelete') {
              await deleteUserBot(cid, appToDelete);
          }
          return bot.editMessageText(`✅ App "${appToDelete}" has been permanently deleted.`, { chat_id: cid, message_id: animMsg.message_id });
      } catch (e) {
          return bot.editMessageText(`Error deleting app: ${e.message}`, { chat_id: cid, message_id: animMsg.message_id });
      }
  }

  if (action === 'canceldelete') {
      return bot.editMessageText('Deletion cancelled.', {
          chat_id: q.message.chat.id,
          message_id: q.message.message_id
      });
  }

  if (action === 'setvar') {
    return bot.sendMessage(cid, `Select a variable to set for "${payload}":`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'SESSION_ID', callback_data: `varselect:SESSION_ID:${payload}` }],
          [{ text: 'AUTO_STATUS_VIEW', callback_data: `varselect:AUTO_STATUS_VIEW:${payload}` }],
          [{ text: 'ALWAYS_ONLINE', callback_data: `varselect:ALWAYS_ONLINE:${payload}` }],
          [{ text: 'PREFIX', callback_data: `varselect:PREFIX:${payload}` }],
          [{ text: 'ANTI_DELETE', callback_data: `varselect:ANTI_DELETE:${payload}` }]
        ]
      }
    });
  }

  if (action === 'varselect') {
    const [varKey, appName] = [payload, extra];
    if (['AUTO_STATUS_VIEW', 'ALWAYS_ONLINE', 'ANTI_DELETE'].includes(varKey)) {
      return bot.sendMessage(cid, `Set ${varKey} to:`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'true', callback_data: `setvarbool:${varKey}:${appName}:true` },
            { text: 'false', callback_data: `setvarbool:${varKey}:${appName}:false` }
          ]]
        }
      });
    } else {
      userStates[cid] = { step: 'SETVAR_ENTER_VALUE', data: { APP_NAME: appName, VAR_NAME: varKey } };
      return bot.sendMessage(cid, `Please enter the new value for ${varKey}:`);
    }
  }

  if (action === 'setvarbool') {
    const [varKey, appName, valStr] = [payload, extra, flag];
    const flagVal = valStr === 'true';
    let newVal;
    if (varKey === 'AUTO_STATUS_VIEW') newVal = flagVal ? 'no-dl' : 'false';
    else if (varKey === 'ANTI_DELETE') newVal = flagVal ? 'p' : 'false';
    else newVal = flagVal ? 'true' : 'false';

    try {
      await axios.patch(
        `https://api.heroku.com/apps/${appName}/config-vars`,
        { [varKey]: newVal },
        { headers: { Authorization: `Bearer ${HEROKU_API_KEY}`, Accept: 'application/vnd.heroku+json; version=3', 'Content-Type': 'application/json' } }
      );
      return bot.sendMessage(cid, `✅ ${varKey} updated to ${newVal}`);
    } catch (e) {
      return bot.sendMessage(cid, `Error updating variable: ${e.message}`);
    }
  }
});

console.log('Bot is running...');
