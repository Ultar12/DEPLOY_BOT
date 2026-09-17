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
    notifications: () => wrap('Account','Notifications','<div id="notificationCenterList" class="plugin-list">Loading…</div>'),
    deployments: () => wrap('Account','Deployments','<div id="deploymentHistoryList" class="plugin-list">Loading…</div>'),
    reconciliation: () => wrap('Admin','Reconciliation','<div id="reconciliationList" class="plugin-list">Loading…</div>'),
    management: () => manageHTML(data), 'bot-tab': () => workHTML(data),
    variables: () => '<div class="page"><div class="news-card"><div class="news-title">Configuration</div></div><div id="varsList" class="management-grid">Loading…</div></div>',
    logs: () => '<div class="page"><div class="news-card"><div class="news-title">Live logs</div></div><pre id="logsPanel" class="logs-container">Loading…</pre></div>',
    job: () => jobHTML(data), payment: () => payHTML() };
  $('view-container').innerHTML = (pages[view] || dashHTML)();
  bind();
  if (view==='dashboard') loadDash();
  if (view==='plugins') loadPlugins();
  if (view==='notifications') fillList('notificationCenterList','/notifications', d=>d.notifications||[], n=>`<div class="workspace-panel"><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.message)}</p></div>`,'No notifications.');
  if (view==='deployments') fillList('deploymentHistoryList','/deployment-history', d=>d.jobs||[], j=>`<div class="workspace-panel"><strong>${escapeHtml(j.app_name)}</strong><p>${escapeHtml(j.status)}</p></div>`,'No deployments.');
  if (view==='reconciliation') fillList('reconciliationList','/admin/reconciliation', d=>d.issues||[], i=>`<div class="workspace-panel"><strong>${escapeHtml(i.issue)}</strong><p>${escapeHtml(i.app_name)}</p></div>`,'No issues.');
  if (view==='variables') loadVars(data);
  if (view==='logs') loadLogs(data);
  if (view==='job') pollJob(data.jobId);
  if (view==='payment') loadPay();
  if (view==='session') bindSession();
  if (view==='deploy') bindDeploy();
}
function wrap(k,t,b){ return `<div class="page"><div class="page-head"><div><p class="kicker">${k}</p><h1>${t}</h1></div></div>${b}</div>`; }
function dashHTML(){ return `<div class="page"><div class="page-head"><div><p class="kicker">Workspace</p><h1>Dashboard</h1></div><a class="support-btn" href="/apps/create">New app</a></div><p class="dashboard-subtitle">Running bots, status, and renewals.</p><div class="stats-grid"><div class="stat-card"><div class="stat-value" id="totalBots">0</div><div class="stat-label">Apps</div></div><div class="stat-card"><div class="stat-value" id="onlineBots">0</div><div class="stat-label">Live</div></div></div><div id="myBotsSection"><div class="section-title">Apps</div><div class="bot-list" id="botList">Loading…</div></div></div>`; }
function settingsHTML(){ return wrap('Account','Settings','<div class="settings-card"><a class="support-btn" href="https://t.me/ultarswbdbot" target="_blank" rel="noopener">Contact support</a><a class="settings-logout" href="/telegram-logout">Log out</a></div>'); }
function pluginsHTML(){ return wrap('Library','Plugins','<div class="plugin-filters"><button class="plugin-filter active" data-action="filter-plugins" data-plugin-type="all">All</button><button class="plugin-filter" data-action="filter-plugins" data-plugin-type="levanter">Levanter</button><button class="plugin-filter" data-action="filter-plugins" data-plugin-type="raganork">Raganork</button></div><div id="pluginList" class="plugin-list">Loading…</div>'); }
