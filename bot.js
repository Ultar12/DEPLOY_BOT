// bot.js

// Global error handlers
process.on('unhandledRejection', err =>
  console.error('🛑 Unhandled Rejection:', err));
process.on('uncaughtException', err =>
  console.error('🛑 Uncaught Exception:', err));

require('dotenv').config();
const fs          = require('fs');
const axios       = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');

// Load defaults from app.json
let defaultEnvVars = {};
try {
  const a = JSON.parse(fs.readFileSync('app.json','utf8'));
  defaultEnvVars = Object.fromEntries(
    Object.entries(a.env).map(([k,v]) => [k, v.value])
  );
} catch {}

// Environment
const {
  TELEGRAM_BOT_TOKEN,
  HEROKU_API_KEY,
  GITHUB_REPO_URL,
  ADMIN_ID,
  DATABASE_URL
} = process.env;
const SUPPORT_USERNAME = '@star_ies1';

// Postgres pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-create table
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bots (
      user_id    TEXT NOT NULL,
      bot_name   TEXT NOT NULL,
      session_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ user_bots table ready');
}
ensureTable().catch(console.error);

// DB helpers
async function addUserBot(u,b,s){ await pool.query(
  'INSERT INTO user_bots(user_id,bot_name,session_id) VALUES($1,$2,$3)',
  [u,b,s]
);}
async function getUserBots(u){ 
  const r=await pool.query(
    'SELECT bot_name FROM user_bots WHERE user_id=$1 ORDER BY created_at',[u]
  ); return r.rows.map(x=>x.bot_name);
}
async function deleteUserBot(u,b){ await pool.query(
  'DELETE FROM user_bots WHERE user_id=$1 AND bot_name=$2',[u,b]
);}
async function updateUserSession(u,b,s){ await pool.query(
  'UPDATE user_bots SET session_id=$1 WHERE user_id=$2 AND bot_name=$3',[s,u,b]
);}

// Init bot
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN,{polling:true});
bot.on('polling_error',console.error);

// State
const userStates      = {}; // cid -> {step,data}
const authorizedUsers = new Set();
const validKeys       = new Set();

// Utils
function generateKey(){
  const c='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({length:8}).map(_=>c[Math.floor(Math.random()*c.length)]).join('');
}
function buildKeyboard(isAdmin){
  return isAdmin
    ? [['🚀 Deploy','📦 Apps'],['🔐 Generate Key','🧾 Get Session'],['🆘 Support']]
    : [['🧾 Get Session','🚀 Deploy'],['📦 My Bots'],['🆘 Support']];
}
function chunk(arr,n){
  const o=[]; for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));
  return o;
}

// Send Heroku apps list
async function sendAppList(cid){
  try {
    const res = await axios.get('https://api.heroku.com/apps',{
      headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`,
        Accept:'application/vnd.heroku+json; version=3'
      }
    });
    const apps = res.data.map(a=>a.name);
    if(!apps.length) return bot.sendMessage(cid,'📭 No apps found.');
    const rows = chunk(apps,3).map(r=>r.map(n=>({
      text:n, callback_data:`selectapp:${n}`
    })));
    await bot.sendMessage(cid,'📦 Your Heroku Apps:',{
      reply_markup:{inline_keyboard:rows}
    });
  } catch(e){
    bot.sendMessage(cid,`❌ Could not fetch apps: ${e.message}`);
  }
}

// /start
bot.onText(/^\/start$/, async msg=>{
  const cid = msg.chat.id.toString();
  const isAdmin = cid===ADMIN_ID;
  delete userStates[cid];
  if(isAdmin) authorizedUsers.add(cid);
  const text = isAdmin
    ? '👑 Welcome back, Admin!\nYou manage deployments & users.'
    : '🌟 Welcome to 𝖀𝖑𝖙-𝕬𝕽 BOT Deploy! 🌟\nEffortlessly deploy & manage your WhatsApp bot 💀';
  await bot.sendMessage(cid,text,{
    reply_markup:{keyboard:buildKeyboard(isAdmin),resize_keyboard:true}
  });
});

// /menu alias
bot.onText(/^\/menu$/i,msg=>{
  const cid=msg.chat.id.toString(), isAdmin=cid===ADMIN_ID;
  bot.sendMessage(cid,'📲 Choose:',{
    reply_markup:{keyboard:buildKeyboard(isAdmin),resize_keyboard:true}
  });
});

// /generate key
bot.onText(/^\/generate$/i,msg=>{
  const cid=msg.chat.id.toString();
  if(cid!==ADMIN_ID) return bot.sendMessage(cid,'❌ Only admin.');
  const key=generateKey(); validKeys.add(key);
  bot.sendMessage(cid,`🔑 One-time Key: \`${key}\``,{parse_mode:'Markdown'});
});

// /apps
bot.onText(/^\/apps$/i,msg=>{
  const cid=msg.chat.id.toString();
  if(cid!==ADMIN_ID) return;
  sendAppList(cid);
});

// message handler
bot.on('message',async msg=>{
  const cid=msg.chat.id.toString();
  const raw=msg.text?.trim()||'', lc=raw.toLowerCase();
  const isAdmin=cid===ADMIN_ID;

  // Admin: Apps button
  if(raw==='📦 Apps'&&isAdmin){
    return sendAppList(cid);
  }

  // Admin: Generate Key button
  if(raw==='🔐 Generate Key'&&isAdmin){
    const key=generateKey(); validKeys.add(key);
    return bot.sendMessage(cid,`🔑 One-time Key: \`${key}\``,{parse_mode:'Markdown'});
  }

  // Support
  if(raw==='🆘 Support'||lc==='support'){
    return bot.sendMessage(cid,`🆘 Contact Admin: ${SUPPORT_USERNAME}`);
  }

  // Get Session
  if(raw==='🧾 Get Session'||lc==='get session'){
    userStates[cid]={step:'SESSION_ID',data:{}};
    try {
      await bot.sendPhoto(cid,'https://files.catbox.moe/an2cc1.jpeg',{
        caption:`🧾 *How to get your Session ID:*\n`+
                `1. Tap the link\n2. Click *Session*\n3. Enter custom ID\n\n`+
                `🔗 https://levanter-delta.vercel.app/`,
        parse_mode:'Markdown'
      });
    } catch {
      bot.sendMessage(cid,'⚠️ Visit:\nhttps://levanter-delta.vercel.app/');
    }
    return bot.sendMessage(cid,
      `💡 *Note:*\n• iPhone use Chrome\n• Skip ads\n• Custom ID auto-starts\n\n`+
      `When ready, tap 🚀 Deploy.`,{parse_mode:'Markdown'});
  }

  // Deploy
  if(raw==='🚀 Deploy'||lc==='deploy'){
    if(!isAdmin && !authorizedUsers.has(cid)){
      userStates[cid]={step:'AWAITING_KEY',data:{}};
      return bot.sendMessage(cid,'🔐 Enter your one-time deploy key.');
    }
    userStates[cid]={step:'SESSION_ID',data:{}};
    return bot.sendMessage(cid,'📝 Send your SESSION_ID:');
  }

  // My Bots
  if(raw==='📦 My Bots'||lc==='my bots'){
    const bots=await getUserBots(cid);
    if(!bots.length) return bot.sendMessage(cid,'📭 No bots deployed.');
    const rows=chunk(bots,3).map(r=>r.map(n=>({
      text:n, callback_data:`selectbot:${n}`
    })));
    return bot.sendMessage(cid,'🤖 Your bots:',{
      reply_markup:{inline_keyboard:rows}
    });
  }

  // State machine
  const st=userStates[cid];
  if(!st) return;

  // 1) Await key
  if(st.step==='AWAITING_KEY'){
    const key=raw.toUpperCase();
    if(validKeys.has(key)){
      validKeys.delete(key);
      authorizedUsers.add(cid);
      userStates[cid]={step:'SESSION_ID',data:{}};
      bot.sendMessage(ADMIN_ID,`🔐 Key used by: ${cid}`);
      return bot.sendMessage(cid,'✅ Key accepted! Send SESSION_ID:');
    }
    return bot.sendMessage(cid,'❌ Invalid key.');
  }

  // 2) Got SESSION_ID
  if(st.step==='SESSION_ID'){
    if(raw.length<5) return bot.sendMessage(cid,'⚠️ SESSION_ID ≥5 chars.');
    st.data.SESSION_ID=raw; st.step='APP_NAME';
    return bot.sendMessage(cid,'📝 What name for your bot?');
  }

  // 3) Got APP_NAME
  if(st.step==='APP_NAME'){
    const nm=raw.toLowerCase().replace(/\s+/g,'-');
    if(nm.length<5||!/^[a-z0-9-]+$/.test(nm)){
      return bot.sendMessage(cid,'⚠️ Invalid name.');
    }
    try {
      await axios.get(`https://api.heroku.com/apps/${nm}`,{
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid,`❌ "${nm}" taken.`);
    } catch(e){
      if(e.response?.status===404){
        st.data.APP_NAME=nm; st.step='AUTO_STATUS_VIEW';
        return bot.sendMessage(cid,'🟢 Enable AUTO_STATUS_VIEW? (true/false)');
      }
      throw e;
    }
  }

  // 4) AUTO_STATUS_VIEW
  if(st.step==='AUTO_STATUS_VIEW'){
    if(lc!=='true'&&lc!=='false'){
      return bot.sendMessage(cid,'⚠️ Reply true or false.');
    }
    st.data.AUTO_STATUS_VIEW= lc==='true'?'no-dl':'false';
    await bot.sendMessage(cid,'📦 Build queued...');
    await deployToHeroku(cid, st.data);
    await addUserBot(cid, st.data.APP_NAME, st.data.SESSION_ID);
    delete userStates[cid];
    return;
  }

  // 5) SETVAR text fallback
  if(st.step==='SETVAR_ENTER_VALUE'){
    const {APP_NAME,VAR_NAME}=st.data;
    try {
      await axios.patch(
        `https://api.heroku.com/apps/${APP_NAME}/config-vars`,
        {[VAR_NAME]:raw},{headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3',
          'Content-Type':'application/json'
        }}
      );
      if(VAR_NAME==='SESSION_ID'){
        await updateUserSession(cid,APP_NAME,raw);
      }
      bot.sendMessage(cid,`✅ Updated ${VAR_NAME} to \`${raw}\``,{parse_mode:'Markdown'});
    } catch(e){
      bot.sendMessage(cid,`❌ Update failed: ${e.message}`);
    }
    delete userStates[cid];
    return;
  }
});

// Callback handlers
bot.on('callback_query', async q=>{
  const cid=q.message.chat.id.toString();
  const [action,payload,appName,val]=q.data.split(':');
  await bot.answerCallbackQuery(q.id);

  // Admin: manage app
  if(action==='selectapp'){
    return bot.sendMessage(cid,
      `🔧 Admin actions for "${payload}":`,{
      reply_markup:{inline_keyboard:[
        [
          {text:'🔄 Restart',callback_data:`restart:${payload}`},
          {text:'📜 Logs',   callback_data:`logs:${payload}`}
        ],
        [
          {text:'🗑️ Delete',callback_data:`delete:${payload}`},
          {text:'⚙️ SetVar', callback_data:`setvar:${payload}`}
        ]
      ]}
    });
  }

  // User: manage bot
  if(action==='selectbot'){
    return bot.sendMessage(cid,
      `🔧 What to do with "${payload}"?`,{
      reply_markup:{inline_keyboard:[
        [
          {text:'🔄 Restart',callback_data:`restart:${payload}`},
          {text:'📜 Logs',   callback_data:`logs:${payload}`}
        ],
        [
          {text:'🗑️ Delete',callback_data:`userdelete:${payload}`},
          {text:'⚙️ SetVar', callback_data:`setvar:${payload}`}
        ]
      ]}
    });
  }

  // Restart dynos
  if(action==='restart'){
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}/dynos`,{
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid,`✅ "${payload}" restarted.`);
    } catch(e){
      return bot.sendMessage(cid,`❌ Restart failed: ${e.message}`);
    }
  }

  // Logs
  if(action==='logs'){
    try {
      const lr=await axios.post(
        `https://api.heroku.com/apps/${payload}/log-sessions`,
        { tail: true, lines: 100 },
        { headers:{
            Authorization:`Bearer ${HEROKU_API_KEY}`,
            Accept:'application/vnd.heroku+json; version=3',
            'Content-Type':'application/json'
          }}
      );
      return bot.sendMessage(cid,`📜 Logs:\n${lr.data.logplex_url}`);
    } catch(e){
      return bot.sendMessage(cid,`❌ Logs failed: ${e.message}`);
    }
  }

  // Delete app (admin)
  if(action==='delete'){
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`,{
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      return bot.sendMessage(cid,`🗑️ "${payload}" deleted.`);
    } catch(e){
      return bot.sendMessage(cid,`❌ Delete failed: ${e.message}`);
    }
  }

  // Delete user bot
  if(action==='userdelete'){
    try {
      await axios.delete(`https://api.heroku.com/apps/${payload}`,{
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      await deleteUserBot(cid,payload);
      return bot.sendMessage(cid,`🗑️ Your bot "${payload}" deleted.`);
    } catch(e){
      return bot.sendMessage(cid,`❌ Delete failed: ${e.message}`);
    }
  }

  // SetVar menu
  if(action==='setvar'){
    return bot.sendMessage(cid,
      `⚙️ Choose variable for "${payload}":`,{
      reply_markup:{inline_keyboard:[
        [
          {text:'SESSION_ID', callback_data:`varselect:SESSION_ID:${payload}`},
          {text:'AUTO_STATUS_VIEW', callback_data:`varselect:AUTO_STATUS_VIEW:${payload}`}
        ],
        [
          {text:'ALWAYS_ONLINE', callback_data:`varselect:ALWAYS_ONLINE:${payload}`},
          {text:'PREFIX', callback_data:`varselect:PREFIX:${payload}`}
        ]
      ]}
    });
  }

  // varselect & setvarbool handled above...
});

// Deploy helper with progress
async function deployToHeroku(chatId,vars){
  const appName=vars.APP_NAME;
  // create
  await axios.post('https://api.heroku.com/apps',{name:appName},{
    headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3'
    }
  });
  // buildpacks
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    {updates:[
      {buildpack:'https://github.com/heroku/heroku-buildpack-apt'},
      {buildpack:'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest'},
      {buildpack:'heroku/nodejs'}
    ]},
    {headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  // config
  const cfg={...defaultEnvVars,
    SESSION_ID:vars.SESSION_ID,
    AUTO_STATUS_VIEW:vars.AUTO_STATUS_VIEW
  };
  await axios.patch(
    `https://api.heroku.com/apps/${appName}/config-vars`,cfg,
    {headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  // build
  const bres=await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    {source_blob:{url:`${GITHUB_REPO_URL}/tarball/main`}},
    {headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`,
      Accept:'application/vnd.heroku+json; version=3',
      'Content-Type':'application/json'
    }}
  );
  const statusUrl=`https://api.heroku.com/apps/${appName}/builds/${bres.data.id}`;
  let status='pending';
  const msg=await bot.sendMessage(chatId,'⏳ Building... 0%');
  for(let i=1;i<=20;i++){
    await new Promise(r=>setTimeout(r,5000));
    try{
      const p=await axios.get(statusUrl,{
        headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`,
          Accept:'application/vnd.heroku+json; version=3'
        }
      });
      status=p.data.status;
    }catch{break;}
    const pct=Math.min(100,i*5);
    await bot.editMessageText(`⏳ Building... ${pct}%`,{
      chat_id:chatId,
      message_id:msg.message_id
    });
    if(status!=='pending')break;
  }
  if(status==='succeeded'){
    await bot.editMessageText(`✅ Build complete!\nhttps://${appName}.herokuapp.com`,{
      chat_id:chatId,message_id:msg.message_id
    });
  } else {
    await bot.editMessageText(`❌ Build ${status}.`,{
      chat_id:chatId,message_id:msg.message_id
    });
  }
}
