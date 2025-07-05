require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

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

// State
const userStates      = {};        // { chatId: { step, data } }
const authorizedUsers = new Set(); // used key
const validKeys       = new Set();
const userAppsPath = 'userApps.json';
let userApps = {};
if (fs.existsSync(userAppsPath)) {
  try { userApps = JSON.parse(fs.readFileSync(userAppsPath, 'utf8')); }
  catch {}
}
function saveUserApps() {
  fs.writeFileSync(userAppsPath, JSON.stringify(userApps, null, 2));
}

// Utils
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 8 })
    .map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function buildKeyboard(isAdmin) {
  return isAdmin
    ? [['🚀 Deploy','📦 Apps'], ['📜 Logs','🗑️ Delete'], ['🔐 Generate Key','🧾 Get Session'], ['🆘 Support']]
    : [['🚀 Deploy','📦 My App'], ['📜 Logs','🧾 Get Session'], ['🆘 Support']];
}

// Error handler
bot.on('polling_error', console.error);

// /start & /menu
bot.onText(/^\/start$/, msg => {
  const cid = msg.chat.id.toString(), isAdmin = cid === ADMIN_ID;
  delete userStates[cid];
  if (isAdmin) authorizedUsers.add(cid);
  bot.sendMessage(cid, `👋 Welcome${isAdmin?' Admin':''}!`, {
    reply_markup:{ keyboard:buildKeyboard(isAdmin), resize_keyboard:true }
  });
});
bot.onText(/^\/menu$/, msg => {
  const cid = msg.chat.id.toString(), isAdmin = cid === ADMIN_ID;
  bot.sendMessage(cid,'📲 Choose:',{
    reply_markup:{ keyboard:buildKeyboard(isAdmin), resize_keyboard:true }
  });
});

// Admin commands
bot.onText(/^\/generate$/, msg => {
  const cid=msg.chat.id.toString();
  if(cid!==ADMIN_ID) return bot.sendMessage(cid,'❌ Admin only');
  const key=generateKey(); validKeys.add(key);
  bot.sendMessage(cid,`🔑 Key: \`${key}\``,{parse_mode:'Markdown'});
});
bot.onText(/^\/apps$/, async msg => {
  const cid=msg.chat.id.toString();
  if(cid!==ADMIN_ID) return bot.sendMessage(cid,'❌ Admin only');
  try {
    const res=await axios.get('https://api.heroku.com/apps',{ headers:{
      Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'
    }});
    if(!res.data.length) return bot.sendMessage(cid,'📭 No apps');
    const list=res.data.map(a=>`• \`${a.name}\``).join('\n');
    bot.sendMessage(cid,`📦 All Apps:\n${list}`,{parse_mode:'Markdown'});
  } catch(e){ bot.sendMessage(cid,`❌ ${e.message}`); }
});

// Session approval & code from admin
bot.onText(/^approve:(\d+)$/, (msg,match) => {
  if(msg.chat.id.toString()!==ADMIN_ID) return;
  const userId=match[1];
  userStates[userId]={ step:'AWAITING_NAME', data:{} };
  bot.sendMessage(userId,'✅ Approved! Please enter your full name:');
});
bot.onText(/^code:(\d+):(.+)$/, (msg,match) => {
  if(msg.chat.id.toString()!==ADMIN_ID) return;
  const userId=match[1], code=match[2];
  bot.sendMessage(userId,
    `🔐 Your session code:\n\`${code}\`\nPaste into your WhatsApp-linked device.`,
    { parse_mode:'Markdown' }
  );
});

// Fallback /deploy
bot.onText(/^\/deploy$/, msg => {
  const cid=msg.chat.id.toString(), isAdmin=cid===ADMIN_ID;
  if(!isAdmin && !authorizedUsers.has(cid)) {
    userStates[cid]={ step:'AWAITING_KEY', data:{} };
    return bot.sendMessage(cid,'🔐 Enter your one-time deploy key:');
  }
  userStates[cid]={ step:'SESSION_ID', data:{} };
  bot.sendMessage(cid,'📝 Enter your SESSION_ID:');
});

// Main handler
bot.on('message', async msg => {
  const cid=msg.chat.id.toString(), text=msg.text?.trim(), isAdmin=cid===ADMIN_ID;
  // reset on button
  const btns=['🚀 Deploy','📦 My App','📦 Apps','📜 Logs','🗑️ Delete','🔐 Generate Key','🧾 Get Session','🆘 Support'];
  if(btns.includes(text)) delete userStates[cid];

  // Deploy button
  if(text==='🚀 Deploy') {
    if(!isAdmin && !authorizedUsers.has(cid)) {
      userStates[cid]={ step:'AWAITING_KEY', data:{} };
      return bot.sendMessage(cid,'🔐 Enter your one-time deploy key:');
    }
    userStates[cid]={ step:'SESSION_ID', data:{} };
    return bot.sendMessage(cid,'📝 Enter your SESSION_ID:');
  }

  // My App
  if(text==='📦 My App' && !isAdmin) {
    const apps=userApps[cid]||[];
    if(!apps.length) return bot.sendMessage(cid,'📭 No deployed apps');
    const list=apps.map(a=>`• \`${a}\``).join('\n');
    return bot.sendMessage(cid,`📦 Your Apps:\n${list}`,{parse_mode:'Markdown'});
  }

  // Apps
  if(text==='📦 Apps' && isAdmin) {
    return bot.emit('text',{ chat:{ id:cid }, text:'/apps' });
  }

  // Logs inline
  if(text==='📜 Logs') {
    let appsList=[];
    if(isAdmin){
      try{
        const res=await axios.get('https://api.heroku.com/apps',{ headers:{
          Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'
        }});
        appsList=res.data.map(a=>a.name);
      }catch(e){ return bot.sendMessage(cid,`❌ ${e.message}`); }
    } else appsList=userApps[cid]||[];
    if(!appsList.length) return bot.sendMessage(cid,'📭 No apps');
    const kb=appsList.map(n=>[{ text:`📜 ${n}`, callback_data:`logs:${n}` }]);
    return bot.sendMessage(cid,'📜 Choose app for logs',{ reply_markup:{ inline_keyboard:kb } });
  }

  // Delete inline
  if(text==='🗑️ Delete' && isAdmin) {
    try{
      const res=await axios.get('https://api.heroku.com/apps',{ headers:{
        Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'
      }});
      const appsList=res.data.map(a=>a.name);
      if(!appsList.length) return bot.sendMessage(cid,'📭 No apps');
      const kb=appsList.map(n=>[{ text:`🗑️ ${n}`, callback_data:`delete:${n}` }]);
      return bot.sendMessage(cid,'🗑️ Choose app to delete',{ reply_markup:{ inline_keyboard:kb } });
    }catch(e){ return bot.sendMessage(cid,`❌ ${e.message}`); }
  }

  // Generate Key
  if(text==='🔐 Generate Key' && isAdmin) {
    const key=generateKey(); validKeys.add(key);
    return bot.sendMessage(cid,`🔑 Key: \`${key}\``,{parse_mode:'Markdown'});
  }

  // Get Session
  if(text==='🧾 Get Session') {
    userStates[cid]={ step:'AWAITING_SESSION_APPROVAL', data:{} };
    bot.sendMessage(cid,'📨 Request sent to admin. Please wait.');
    const name=`${msg.from.first_name||''} ${msg.from.last_name||''}`.trim();
    const username=msg.from.username?`@${msg.from.username}`:'No username';
    bot.sendMessage(ADMIN_ID,
      `📥 Session request from:\nID: ${cid}\nName: ${name}\nUsername: ${username}\n\nReply with: approve:${cid}`
    );
    return;
  }

  // Support
  if(text==='🆘 Support') {
    return bot.sendMessage(cid,`🆘 Support Contact: ${SUPPORT_USERNAME}`);
  }

  // Stateful flows
  const state=userStates[cid];
  if(!state) return;

  // One-time key
  if(state.step==='AWAITING_KEY') {
    const key=text.toUpperCase();
    if(validKeys.has(key)){
      validKeys.delete(key); authorizedUsers.add(cid); delete userStates[cid];
      const name=`${msg.from.first_name||''} ${msg.from.last_name||''}`.trim();
      const un=msg.from.username?`@${msg.from.username}`:'No username';
      bot.sendMessage(ADMIN_ID,`🔔 Key used by:\nName: ${name}\nUsername: ${un}\nID: ${cid}`);
      return bot.sendMessage(cid,'✅ Key accepted! Now tap 🚀 Deploy.');
    }
    return bot.sendMessage(cid,'❌ Invalid or expired key.');
  }

  // Session approval placeholder
  if(state.step==='AWAITING_SESSION_APPROVAL') return;

  // Name
  if(state.step==='AWAITING_NAME') {
    state.data.name=text; state.step='AWAITING_PHONE';
    bot.sendMessage(cid,'📞 Enter your phone number (e.g. +23491...):');
    bot.sendMessage(ADMIN_ID,`👤 Name from ${cid}: ${text}`);
    return;
  }

  // Phone
  if(state.step==='AWAITING_PHONE') {
    state.data.phone=text; state.step='AWAITING_CODE';
    bot.sendMessage(cid,'⏳ Waiting for admin to send your session code...');
    bot.sendMessage(ADMIN_ID,
      `📱 Phone from ${cid}: ${text}\n\nReply with: code:${cid}:<your_code>`
    );
    return;
  }

  // Deploy flow
  try {
    switch(state.step) {
      case 'SESSION_ID':
        if(!text||text.length<5) return bot.sendMessage(cid,'⚠️ SESSION_ID at least 5 chars.');
        state.data.SESSION_ID=text; state.step='APP_NAME';
        return bot.sendMessage(cid,'📝 Enter APP_NAME:');
      case 'APP_NAME':
        const nm=text.toLowerCase().replace(/\s+/g,'-');
        if(!/^[a-z0-9-]+$/.test(nm)) return bot.sendMessage(cid,'⚠️ Invalid APP_NAME.');
        try{
          await axios.get(`https://api.heroku.com/apps/${nm}`,{ headers:{
            Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3'
          }});
          return bot.sendMessage(cid,`❌ \`${nm}\` exists.`);
        }catch(e){
          if(e.response?.status===404){
            state.data.APP_NAME=nm; state.step='AUTO_STATUS_VIEW';
            return bot.sendMessage(cid,'📝 Enter AUTO_STATUS_VIEW ("true" or "false"):');
          }
          throw e;
        }
      case 'AUTO_STATUS_VIEW':
        if(!['true','false'].includes(text.toLowerCase())){
          return bot.sendMessage(cid,'⚠️ Type "true" or "false":');
        }
        state.data.AUTO_STATUS_VIEW=text.toLowerCase()==='true'?'no-dl':'false';
        state.step='STATUS_VIEW_EMOJI';
        return bot.sendMessage(cid,'📝 Enter STATUS_VIEW_EMOJI (or "skip"):');
      case 'STATUS_VIEW_EMOJI':
        state.data.STATUS_VIEW_EMOJI=text.toLowerCase()==='skip'?'':text;
        await bot.sendMessage(cid,'🕓 Build queued...');
        await deployToHeroku(cid,state.data);
        delete userStates[cid]; authorizedUsers.delete(cid);
        return;
    }
  } catch(e){
    delete userStates[cid];
    bot.sendMessage(cid,`❌ Error: ${e.message}`);
  }
});

// Inline handler: logs & delete
bot.on('callback_query', async q => {
  const cid=q.message.chat.id.toString();
  const [act,name]=q.data.split(':');
  await bot.answerCallbackQuery(q.id);
  if(act==='logs'){
    try{
      const sess=await axios.post(
        `https://api.heroku.com/apps/${name}/log-sessions`,{ dyno:'web', tail:false },{
          headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
        });
      const logs=(await axios.get(sess.data.logplex_url)).data;
      if(logs.length<4000){
        return bot.sendMessage(cid,`📜 Logs for \`${name}\`:\n\`\`\`\n${logs}\n\`\`\``,{parse_mode:'Markdown'});
      }
      const fp=path.join(os.tmpdir(),`${name}-logs.txt`);
      fs.writeFileSync(fp,logs);
      await bot.sendDocument(cid,fp);
      fs.unlinkSync(fp);
    }catch(e){ bot.sendMessage(cid,`❌ Could not fetch logs: ${e.message}`); }
  }
  if(act==='delete'){
    try{
      await axios.delete(`https://api.heroku.com/apps/${name}`,{
        headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
      });
      bot.sendMessage(cid,`✅ Deleted \`${name}\`.`,{parse_mode:'Markdown'});
    }catch(e){ bot.sendMessage(cid,`❌ Delete failed: ${e.message}`); }
  }
});

// Deploy helper
async function deployToHeroku(chatId, vars){
  const appName=vars.APP_NAME;
  await axios.post('https://api.heroku.com/apps',{ name:appName },{
    headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }
  });
  await axios.put(
    `https://api.heroku.com/apps/${appName}/buildpack-installations`,
    { updates:[
        { buildpack:'https://github.com/heroku/heroku-buildpack-apt' },
        { buildpack:'https://github.com/jonathanong/heroku-buildpack-ffmpeg-latest' },
        { buildpack:'heroku/nodejs' }
      ]
    },
    { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3', 'Content-Type':'application/json' } }
  );
  const configVars={ ...defaultEnvVars, SESSION_ID:vars.SESSION_ID, AUTO_STATUS_VIEW:vars.AUTO_STATUS_VIEW, STATUS_VIEW_EMOJI:vars.STATUS_VIEW_EMOJI };
  await axios.patch(`https://api.heroku.com/apps/${appName}/config-vars`,configVars,{
    headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3', 'Content-Type':'application/json' }
  });
  const buildRes=await axios.post(
    `https://api.heroku.com/apps/${appName}/builds`,
    { source_blob:{ url:`${GITHUB_REPO_URL}/tarball/main` } },
    { headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3', 'Content-Type':'application/json' } }
  );
  const buildId=buildRes.data.id;
  const statusUrl=`https://api.heroku.com/apps/${appName}/builds/${buildId}`;
  let status=buildRes.data.status, attempts=0;
  await bot.sendMessage(chatId,'🛠️ Building...');
  while(status==='pending'&&attempts<20){
    await new Promise(r=>setTimeout(r,5000));
    const poll=await axios.get(statusUrl,{ headers:{ Authorization:`Bearer ${HEROKU_API_KEY}`, Accept:'application/vnd.heroku+json; version=3' }});
    status=poll.data.status; attempts++;
  }
  if(status==='succeeded'){
    userApps[chatId]=userApps[chatId]||[];
    userApps[chatId].push(appName);
    saveUserApps();
    bot.sendMessage(chatId,`✅ Deployed!\n🌐 https://${appName}.herokuapp.com`);
  } else {
    bot.sendMessage(chatId,`❌ Build ${status}. Check dashboard.`);
  }
  }
