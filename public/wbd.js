const API = location.origin + '/api';
const tg = window.Telegram?.WebApp || { initData: '', ready() {}, expand() {}, showAlert: (m) => alert(m), showConfirm: (m, cb) => cb(confirm(m)), openLink: (u) => window.open(u, '_blank') };
tg.ready(); tg.expand();
const $ = (id) => document.getElementById(id);
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&','<':'<','>':'>','"':'"',"'":'&#39;' }[c]));
const escapeAttr = escapeHtml;
const hdr = () => ({ 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg.initData });
const api = (path, opts={}) => fetch(API + path, { ...opts, headers: { ...hdr(), ...(opts.headers||{}) } }).then(r => r.json());
const alertApp = (m) => new Promise((res) => { if (tg.initData && tg.showAlert) tg.showAlert(m, res); else { alert(m); res(); } });
const confirmApp = (m, cb) => { if (tg.initData && tg.showConfirm) tg.showConfirm(m, cb); else cb(confirm(m)); };
const state = { view: 'dashboard', bot: null };
window.__plugins = [];
$('avatarBtn')?.addEventListener('click', (e) => { e.stopPropagation(); $('accountMenu')?.classList.toggle('open'); });
document.addEventListener('click', () => $('accountMenu')?.classList.remove('open'));
$('newAppBtn')?.addEventListener('click', (e) => { e.preventDefault(); if (window.__maintenanceMode) return alertApp('The service is under maintenance.'); go('deploy'); });
$('notificationsLink')?.addEventListener('click', (e) => { e.preventDefault(); location.href = '/apps/notifications'; });
$('backBtn').onclick = () => { if (state.view === 'variables' || state.view === 'logs') return go('bot-tab', { bot: state.bot }); location.href = '/apps/dashboard'; };

function go(view, data=null) {
  state.view = view; state.bot = data;
  $('headerTitle').textContent = view;
  $('backBtn').classList.toggle('show', view !== 'dashboard');
  const pages = { dashboard: dashHTML, deploy: () => deployHTML(data||{}), session: sessionHTML, plugins: pluginsHTML, settings: settingsHTML,
    notifications: () => wrap('Account','Notifications','<div id="notificationCenterList" class="plugin-list">Loading</div>'),
    deployments: () => wrap('Account','Deployments','<div id="deploymentHistoryList" class="plugin-list">Loading</div>'),
    reconciliation: () => wrap('Admin','Reconciliation','<div id="reconciliationList" class="plugin-list">Loading</div>'),
    management: () => manageHTML(data), 'bot-tab': () => workHTML(data),
    variables: () => '<div class="page"><div class="news-card"><div class="news-title">Configuration</div></div><div id="varsList" class="management-grid">Loading</div></div>',
    logs: () => '<div class="page"><div class="news-card"><div class="news-title">Live logs</div></div><pre id="logsPanel" class="logs-container">Loading</pre></div>',
    job: () => jobHTML(data), payment: () => payHTML() };
  $('view-container').innerHTML = (pages[view] || dashHTML)();
  bind();
  if (view==='dashboard') loadDash();
  if (view==='plugins') loadPlugins();
  if (view==='notifications') fillList('notificationCenterList','/notifications', d=>d.notifications||[], n=>'<div class="workspace-panel"><strong>'+escapeHtml(n.title)+'</strong><p>'+escapeHtml(n.message)+'</p></div>','No notifications.');
  if (view==='deployments') fillList('deploymentHistoryList','/deployment-history', d=>d.jobs||[], j=>'<div class="workspace-panel"><strong>'+escapeHtml(j.app_name)+'</strong><p>'+escapeHtml(j.status)+'</p></div>','No deployments.');
  if (view==='reconciliation') fillList('reconciliationList','/admin/reconciliation', d=>d.issues||[], i=>'<div class="workspace-panel"><strong>'+escapeHtml(i.issue)+'</strong><p>'+escapeHtml(i.app_name)+'</p></div>','No issues.');
  if (view==='variables') loadVars(data);
  if (view==='logs') loadLogs(data);
  if (view==='job') pollJob(data.jobId);
  if (view==='payment') loadPay();
  if (view==='session') bindSession();
  if (view==='deploy') bindDeploy();
}
function wrap(k,t,b){ return '<div class="page"><div class="page-head"><div><p class="kicker">'+k+'</p><h1>'+t+'</h1></div></div>'+b+'</div>'; }
function dashHTML(){ return '<div class="page"><div class="page-head"><div><p class="kicker">Workspace</p><h1>Dashboard</h1></div><a class="support-btn" href="/apps/create">New app</a></div><p class="dashboard-subtitle">Running bots, status, and renewals.</p><div class="stats-grid"><div class="stat-card"><div class="stat-value" id="totalBots">0</div><div class="stat-label">Apps</div></div><div class="stat-card"><div class="stat-value" id="onlineBots">0</div><div class="stat-label">Live</div></div></div><div id="myBotsSection"><div class="section-title">Apps</div><div class="bot-list" id="botList">Loading</div></div></div>'; }
function settingsHTML(){ return wrap('Account','Settings','<div class="settings-card"><a class="support-btn" href="https://t.me/ultarswbdbot" target="_blank" rel="noopener">Contact support</a><a class="settings-logout" href="/telegram-logout">Log out</a></div>'); }
function pluginsHTML(){ return wrap('Library','Plugins','<div class="plugin-filters"><button class="plugin-filter active" data-action="filter-plugins" data-plugin-type="all">All</button><button class="plugin-filter" data-action="filter-plugins" data-plugin-type="levanter">Levanter</button><button class="plugin-filter" data-action="filter-plugins" data-plugin-type="raganork">Raganork</button></div><div id="pluginList" class="plugin-list">Loading</div>'); }
function sessionHTML(){ return '<form id="sessionRequestForm" class="management-grid page"><div class="news-card"><div class="news-title">Session</div><div class="news-content">Pair WhatsApp, then copy the session ID.</div></div><label class="section-title">Bot type<select id="sessionBotType"><option value="levanter">Levanter</option><option value="raganork">Raganork</option></select></label><label class="section-title">Number<input id="sessionPhoneNumber" required placeholder="2349160000000"></label><button class="support-btn" type="submit">Request session</button><div id="sessionRequestResult"></div></form>'; }
function deployHTML(d){ return '<form id="deployForm" class="management-grid page"><div class="news-card"><div class="news-title">Deploy an app</div></div><label class="section-title">Name<input id="deployAppName" required value="'+escapeAttr(d.appName||'')+'"><span id="appNameState"></span></label><label class="section-title">Type<select id="deployBotType"><option value="raganork">raganork</option><option value="levanter">levanter</option></select></label><label class="section-title">Session ID<input id="deploySessionId" required value="'+escapeAttr(d.sessionId||'')+'"><span id="sessionState"></span></label><label class="section-title">Auto status<select id="autoStatusView"><option value="yes">Yes</option><option value="no" selected>No</option></select></label><button class="support-btn" id="saveNextBtn" type="button">Continue</button><div id="deployOptions" style="display:none"><button class="support-btn" id="keyDeployBtn" type="button">Deploy with key</button><button class="support-btn" id="payDeployBtn" type="button">Pay</button></div><div id="deployResult"></div></form>'; }
function manageHTML(bot){
  if (!bot) return '<div class="workspace-panel">Select an app.</div>';
  const exp = bot.expirationDate && new Date(bot.expirationDate)-Date.now()<=0;
  if (exp) return '<div class="management-grid"><div class="mgmt-option" data-action="renew-bot" data-app-name="'+escapeAttr(bot.appName)+'"><div class="mgmt-option-label">Renew</div></div><div class="mgmt-option danger-option" data-action="delete-bot" data-app-name="'+escapeAttr(bot.appName)+'"><div class="mgmt-option-label">Delete</div></div></div>';
  return '<div class="management-grid"><div class="mgmt-option" data-action="restart-bot" data-app-name="'+escapeAttr(bot.appName)+'"><div class="mgmt-option-label">Restart</div></div><div class="mgmt-option" data-action="redeploy-bot" data-app-name="'+escapeAttr(bot.appName)+'"><div class="mgmt-option-label">Redeploy</div></div><div class="mgmt-option" data-action="navigate" data-view="variables" data-bot-json="'+escapeAttr(JSON.stringify(bot))+'"><div class="mgmt-option-label">Variables</div></div><div class="mgmt-option" data-action="navigate" data-view="logs" data-bot-json="'+escapeAttr(JSON.stringify(bot))+'"><div class="mgmt-option-label">Logs</div></div><div class="mgmt-option danger-option" data-action="turn-off-bot" data-app-name="'+escapeAttr(bot.appName)+'"><div class="mgmt-option-label">Turn off</div></div><div class="mgmt-option danger-option" data-action="delete-bot" data-app-name="'+escapeAttr(bot.appName)+'"><div class="mgmt-option-label">Delete</div></div></div>';
}
function workHTML(d){ const bot=d&&d.bot||d; if(!bot||!bot.appName) return '<div class="workspace-panel">Unavailable. <a href="/apps">Back</a></div>'; return '<div class="page"><div class="page-head"><div><p class="kicker">App</p><h1>'+escapeHtml(bot.appName)+'</h1><p>'+escapeHtml(bot.botType||'')+' \xB7 '+escapeHtml(bot.status||'')+'</p></div></div>'+manageHTML(bot)+'</div>'; }
function jobHTML(d){ return '<div class="page"><div class="page-head"><div><p class="kicker">Deploy</p><h1>'+escapeHtml((d&&d.appName)||'App')+'</h1></div></div><div class="news-card" id="jobStatus">Processing</div><a id="openBotDashboard" class="support-btn" href="#" style="display:none">Open app</a></div>'; }
function payHTML(){ return '<div class="page"><div class="news-card"><div class="news-title">Choose a plan</div></div><div id="paymentPlans">Loading</div><button id="continuePaymentBtn" class="support-btn" type="button" disabled>Pay</button><div id="paymentResult"></div></div>'; }
async function loadDash(){
  try {
    const data = await api('/bots'); const bots=data.bots||[];
    window.__maintenanceMode=data.maintenanceMode===true; window.__isAdmin=data.isAdmin===true; window.__dashboardBots=bots;
    const a=$('adminReconciliationLink'); if(a) a.style.display=window.__isAdmin?'block':'none';
    $('totalBots').textContent=bots.length; $('onlineBots').textContent=bots.filter(b=>b.status==='Online').length;
    const list=$('botList');
    if(!bots.length){ list.innerHTML='<div class="empty-state"><h2>No apps yet</h2><p>Get a session, then deploy.</p><a class="support-btn" href="/apps/session">Get session</a> <a class="support-btn" href="/apps/create">New app</a></div>'; return; }
    list.innerHTML=bots.map(bot=>{
      const left=bot.expirationDate?new Date(bot.expirationDate)-Date.now():Infinity;
      const expired=Number.isFinite(left)&&left<=0; const days=Number.isFinite(left)?Math.max(0,Math.ceil(left/86400000)):null;
      const st=bot.status==='Building'?'building':expired?'suspended':bot.status==='Online'?'online':'offline';
      const act=(expired||(days!==null&&days<=3))?'<a class="support-btn" href="https://t.me/ultarswbdbot?start=renew_'+encodeURIComponent(bot.appName)+'" target="_blank" rel="noopener">Renew</a>':'<button class="support-btn" data-action="navigate" data-app-route="/apps/bots/'+encodeURIComponent(bot.appName)+'" data-bot-json="'+escapeAttr(JSON.stringify(bot))+'">Manage</button>';
      return '<div class="bot-card" data-action="navigate" data-app-route="/apps/bots/'+encodeURIComponent(bot.appName)+'" data-bot-json="'+escapeAttr(JSON.stringify(bot))+'"><div class="bot-status-indicator '+st+'"></div><div class="bot-info"><div class="bot-name">'+escapeHtml(bot.appName)+'</div><div class="bot-meta"><span class="bot-badge">'+escapeHtml(bot.botType)+'</span><span class="bot-badge">'+escapeHtml(expired?'Suspended':bot.status)+'</span></div></div><div class="bot-actions">'+act+'</div></div>';
    }).join('');
    const m=location.pathname.match(/^\/apps\/bots\/([^/]+)/); if(m){ const bot=bots.find(b=>b.appName===decodeURIComponent(m[1])); if(bot) go('bot-tab',{bot}); }
  } catch(e){ $('botList').innerHTML='<div class="workspace-panel">'+(escapeHtml(e.message||'Could not load apps.'))+'</div>'; }
}
async function loadPlugins(){ try{ const d=await api('/plugins'); window.__plugins=d.plugins||[]; drawPlugins('all'); }catch(e){ $('pluginList').innerHTML='<div class="workspace-panel">'+escapeHtml(e.message)+'</div>'; } }
function drawPlugins(f){ document.querySelectorAll('.plugin-filter').forEach(b=>b.classList.toggle('active', b.dataset.pluginType===f)); const items=(window.__plugins||[]).filter(p=>f==='all'||String(p.bot_type).toLowerCase()===f); $('pluginList').innerHTML=items.length?items.map(p=>'<div class="plugin-row"><div class="plugin-info"><strong>'+escapeHtml(p.plugin_name)+'</strong><span>'+escapeHtml(p.description||'')+'</span></div><button class="support-btn" data-action="copy-plugin" data-url="'+encodeURIComponent(p.plugin_url)+'">Copy</button></div>').join(''):'<div class="workspace-panel">No plugins yet.</div>'; }
async function fillList(id,path,pick,row,empty){ const el=$(id); if(!el) return; try{ const d=await api(path); const items=pick(d); el.innerHTML=items.length?items.map(row).join(''):'<div class="workspace-panel">'+empty+'</div>'; }catch(e){ el.innerHTML='<div class="workspace-panel">'+escapeHtml(e.message)+'</div>'; } }
async function loadVars(bot){ try{ const d=await api('/bots/config-vars/'+encodeURIComponent(bot.appName)); $('varsList').innerHTML=Object.entries(d.configVars||{}).map(([k,v])=>'<div class="mgmt-option"><div><div class="mgmt-option-label">'+escapeHtml(k)+'</div><div class="mgmt-option-hint">'+escapeHtml(v)+'</div></div><button class="support-btn" data-action="set-var" data-app-name="'+escapeAttr(bot.appName)+'" data-var-name="'+escapeAttr(k)+'">Edit</button></div>').join('')||'<div class="workspace-panel">No variables.</div>'; }catch(e){ alertApp(e.message); } }
async function loadLogs(bot){ const tick=async()=>{ if(state.view!=='logs') return; try{ const d=await api('/bots/logs/'+encodeURIComponent(bot.appName)); const p=$('logsPanel'); if(p) p.textContent=d.logs||'No logs.'; }catch(e){} }; await tick(); clearInterval(window.__logTimer); window.__logTimer=setInterval(tick,4000); }
function runAct(act,name){ const ep={'restart-bot':'bots/restart','redeploy-bot':'bots/redeploy','turn-off-bot':'bots/turn-off','delete-bot':'bots/delete'}[act]; confirmApp('Confirm '+act.replace('-bot','')+'?', async ok=>{ if(!ok) return; const d=await api('/'+ep,{method:'POST',body:JSON.stringify({appName:name})}); await alertApp(d.message||(d.success?'Done.':'Failed.')); if(d.success&&act==='delete-bot') location.href='/apps/dashboard'; }); }
function bind(){ document.onclick=(e)=>{ const btn=e.target.closest('[data-action]'); if(!btn) return; const act=btn.dataset.action;
  if(act==='navigate'){ if(btn.dataset.appRoute){ location.href=btn.dataset.appRoute; return; } go(btn.dataset.view, btn.dataset.botJson?JSON.parse(btn.dataset.botJson):null); }
  if(act==='filter-plugins') drawPlugins(btn.dataset.pluginType||'all');
  if(act==='copy-plugin'){ navigator.clipboard&&navigator.clipboard.writeText(decodeURIComponent(btn.dataset.url||'')); alertApp('Plugin URL copied.'); }
  if(act==='copy-session'||act==='copy-pairing'){ navigator.clipboard&&navigator.clipboard.writeText(btn.dataset.session||btn.dataset.code||''); alertApp('Copied.'); }
  if(act==='set-var'){ const v=prompt('New value for '+btn.dataset.varName); if(v===null) return; api('/bots/set-var',{method:'POST',body:JSON.stringify({appName:btn.dataset.appName,varName:btn.dataset.varName,varValue:v})}).then(d=>alertApp(d.message||'Saved.')); }
  if(act==='change-session'){ const s=prompt('Paste the new session ID.'); if(!s) return; api('/bots/set-session',{method:'POST',body:JSON.stringify({appName:btn.dataset.appName,sessionId:s})}).then(d=>alertApp(d.message||'Updated.')); }
  if(act==='renew-bot'){ const bot=(window.__dashboardBots||[]).find(b=>b.appName===btn.dataset.appName); if(bot) go('payment',Object.assign({},bot,{isRenewal:true})); }
  if(['restart-bot','redeploy-bot','turn-off-bot','delete-bot'].includes(act)) runAct(act,btn.dataset.appName);
}; }
function bindDeploy(){ $('saveNextBtn').onclick=async()=>{ const n=await api('/check-app-name/'+encodeURIComponent($('deployAppName').value.trim().toLowerCase())); const s=await api('/validate-session?botType='+encodeURIComponent($('deployBotType').value)+'&sessionId='+encodeURIComponent($('deploySessionId').value.trim())); $('appNameState').textContent=n.available?'Available':(n.message||'Taken'); $('sessionState').textContent=s.valid?'Valid':(s.message||'Invalid'); if(n.available&&s.valid) $('deployOptions').style.display='block'; };
  $('keyDeployBtn').onclick=()=>{ const k=prompt('Enter your deploy key.'); if(k) submitDeploy(k.trim()); };
  $('payDeployBtn').onclick=()=>go('payment',{botType:$('deployBotType').value,appName:$('deployAppName').value.trim().toLowerCase(),sessionId:$('deploySessionId').value.trim(),autoStatusView:$('autoStatusView').value});
}
async function submitDeploy(key){ const payload={botType:$('deployBotType').value,appName:$('deployAppName').value.trim().toLowerCase(),sessionId:$('deploySessionId').value.trim(),autoStatusView:$('autoStatusView').value,deployKey:key,idempotencyKey:String(Date.now())}; $('deployResult').textContent='Processing'; const d=await api('/deploy',{method:'POST',body:JSON.stringify(payload)}); if(!d.success){ $('deployResult').textContent=d.message||'Failed.'; return; } if(d.paymentUrl) tg.openLink(d.paymentUrl); go('job',{jobId:d.jobId,appName:payload.appName}); }
function loadPay(){ api('/deployment-plans').then(d=>{ $('paymentPlans').innerHTML=(d.plans||[]).map(p=>'<button type="button" class="mgmt-option" data-plan-id="'+escapeAttr(p.id)+'"><div class="mgmt-option-label">'+escapeHtml(p.name)+'</div><div class="mgmt-option-hint">NGN '+Number(p.amountNgn).toLocaleString()+' / '+p.days+' days</div></button>').join(''); document.querySelectorAll('[data-plan-id]').forEach(b=>b.onclick=()=>{ state.planId=b.dataset.planId; $('continuePaymentBtn').disabled=false; }); });
  $('continuePaymentBtn').onclick=async()=>{ const renewal=state.bot&&state.bot.isRenewal; const d=await api(renewal?'/renew':'/deploy',{method:'POST',body:JSON.stringify(renewal?{appName:state.bot.appName,planId:state.planId}:Object.assign({},state.bot,{planId:state.planId,idempotencyKey:String(Date.now())}))}); if(!d.success){ $('paymentResult').textContent=d.message||'Failed.'; return; } if(d.paymentUrl) tg.openLink(d.paymentUrl); if(d.jobId) go('job',{jobId:d.jobId,appName:state.bot&&state.bot.appName}); };
}
function bindSession(){ const form=$('sessionRequestForm'), out=$('sessionRequestResult'); form.onsubmit=async e=>{ e.preventDefault(); out.textContent='Starting pairing'; const d=await api('/session-requests',{method:'POST',body:JSON.stringify({botType:$('sessionBotType').value,number:$('sessionPhoneNumber').value.trim()})}); if(!d.success){ out.textContent=d.message||'Failed.'; return; } const tick=async()=>{ const cur=await api('/session-requests/'+encodeURIComponent(d.requestId)); const r=cur.request||{}; if(r.status==='pairing_code') out.innerHTML='<div class="news-card"><div class="news-title">Pairing code</div><div>'+escapeHtml(r.pairingCode||'')+'</div><button class="support-btn" data-action="copy-pairing" data-code="'+escapeAttr(r.pairingCode||'')+'">Copy</button></div>'; else if(r.status==='completed'){ out.innerHTML='<div class="news-card"><div class="news-title">Session ready</div><textarea id="generatedSessionId" readonly></textarea><button class="support-btn" data-action="copy-session" data-session="'+escapeAttr(r.sessionId||'')+'">Copy session ID</button></div>'; $('generatedSessionId').value=r.sessionId||''; } else if(r.status==='failed') out.textContent=r.error||'Failed.'; else out.textContent='Waiting'; if(!['completed','failed'].includes(r.status)) setTimeout(tick,2500); }; tick(); };
}
async function pollJob(id){ const el=$('jobStatus'); if(!el) return; try{ const d=await api('/deployment-jobs/'+encodeURIComponent(id)); const j=d.job||{}; el.textContent=j.status==='running'?('Building '+(j.progress||0)+'%'):(j.progress_message||j.status||'Processing'); if(j.status==='completed'){ el.textContent='Live: '+j.app_name; const o=$('openBotDashboard'); if(o){ o.href='/apps/bots/'+encodeURIComponent(j.app_name)+'/settings'; o.style.display='inline-flex'; } } else if(j.status==='failed') el.textContent=j.error_message||'Failed.'; else setTimeout(function(){ pollJob(id); },2500); }catch(e){ el.textContent=e.message||'Unavailable'; } }
const path=location.pathname;
const view=['/apps/new','/apps/create'].includes(path)?'deploy':path==='/apps/session'?'session':path==='/apps/plugins'?'plugins':path==='/apps/settings'?'settings':path==='/apps/notifications'?'notifications':path==='/apps/deployments'?'deployments':path==='/apps/reconciliation'?'reconciliation':'dashboard';
const q=new URLSearchParams(location.search);
if(q.get('job')) go('job',{jobId:q.get('job')}); else go(view, q.get('payment')==='cancelled'?{paymentCancelled:true}:null);
