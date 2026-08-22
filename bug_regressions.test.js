const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function escapeLegacyMarkdown(value) {
  return String(value).replace(/([_*[\]()~`>#+=|{}!.])/g, '\\$1');
}

function expiryLabel(expirationDate, now = new Date()) {
  if (!expirationDate) return 'N/A';
  const days = Math.ceil((new Date(expirationDate).getTime() - now.getTime()) / 86400000);
  return days > 0 ? `${days} days left` : 'Expired';
}

test('expiry alert keeps ordinary hyphens unescaped', () => {
  const appName = escapeLegacyMarkdown('marcubot1-7c28');
  const message = `URGENT: Your bot *${appName}* expires in *2 day(s)* only! Renew now or it will be suspended.`;
  assert.equal(message.includes('marcubot1-7c28'), true);
  assert.equal(message.includes('marcubot1\\-7c28'), false);
});

test('restoreall uses the shared buildWithProgress restore contract', () => {
  const source = fs.readFileSync('./bot.js', 'utf8');
  assert.match(source, /const buildResult = await dbServices\.buildWithProgress\(originalOwnerId, combinedVarsForRestore, false, true, botTypeToRestore\)/);
  assert.match(source, /APP_NAME: originalAppName/);
  assert.match(source, /SESSION_ID: deployment\.session_id/);
  assert.match(fs.readFileSync('./bot_services.js', 'utf8'), /ud\.bot_type, ud\.expiration_date/);
});

test('admin expiry label falls back to deployment date instead of N/A', () => {
  const now = new Date('2026-08-21T00:00:00.000Z');
  const deployDate = new Date('2026-08-01T00:00:00.000Z');
  const fallback = new Date(deployDate.getTime() + 30 * 86400000);
  assert.equal(expiryLabel(fallback, now), '10 days left');
  assert.notEqual(expiryLabel(fallback, now), 'N/A');
});

test('stopping logs persists a stopped state when returning to the bot menu', () => {
  const source = fs.readFileSync('./bot.js', 'utf8');
  assert.match(source, /previousState\?\.data\?\.logStreaming === false \|\| wasLogStreamRunning \? false : undefined/);
  assert.match(source, /action === 'logs' \|\| action === 'start_logs'/);
  assert.match(source, /const shouldStream = st\.data\.logStreaming !== false/);
  assert.match(source, /callback_data: st\.data\.logStreaming === false \? `start_logs:\$\{payload\}` : `selectapp:\$\{payload\}`/);
});

test('mini app exposes durable job status and payment-or-key deployment flow', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  const servicesSource = fs.readFileSync('./bot_services.js', 'utf8');
  assert.match(botSource, /deployment_jobs/);
  assert.match(botSource, /validateMiniAppDeploymentInput/);
  assert.match(botSource, /paymentRequired: true/);
  assert.match(botSource, /paymentRequired: false/);
  assert.match(botSource, /app\.get\('\/api\/deployment-jobs\/:jobId'/);
  assert.match(botSource, /app\.get\('\/miniapp'/);
  assert.match(servicesSource, /CREATE TABLE IF NOT EXISTS deployment_jobs/);
  assert.doesNotMatch(htmlSource, /saved verified email/);
  assert.match(htmlSource, /PAY AND DEPLOY/);
  assert.match(htmlSource, /t\.me\/staries1/);
});

test('mini app client polls job progress instead of hiding the deployment result', () => {
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(htmlSource, /pollJob\(data\.jobId\)/);
  assert.match(htmlSource, /deployment-jobs\//);
  assert.match(htmlSource, /progress_message/);
});

test('mini app uses a validation-first deployment wizard', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(botSource, /app\.get\('\/api\/validate-session'/);
  assert.match(botSource, /getMiniAppUserEmail/);
  assert.match(botSource, /EMAIL_REQUIRED/);
  assert.match(htmlSource, /SAVE AND NEXT/);
  assert.match(htmlSource, /\.validation-state\.good/);
  assert.match(htmlSource, /\.validation-state\.bad/);
  assert.match(htmlSource, /DEPLOY WITH KEY/);
  assert.match(htmlSource, /PAY AND DEPLOY/);
  assert.match(htmlSource, /if \(fields\.key\.value\.trim\(\) && !keyOk\) return/);
  assert.match(htmlSource, /addEventListener\('input', debounce\(checkName\)\)/);
  assert.match(htmlSource, /addEventListener\('input', debounce\(checkSession\)\)/);
  assert.match(htmlSource, /addEventListener\('input', debounce\(checkKey\)\)/);
});

test('mini app dashboard exposes neutral bot menus and remaining days', () => {
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(htmlSource, /Create a new bot/);
  assert.match(htmlSource, /data-action="bot-menu"/);
  assert.match(htmlSource, /Subscription Active · \$\{daysRemaining\}/);
  assert.doesNotMatch(htmlSource, /Create a managed Heroku instance/);
});

test('mini app payment checkout uses only the verified database email', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(botSource, /VERIFIED_EMAIL_REQUIRED/);
  assert.match(botSource, /String\(await getMiniAppUserEmail\(userId\) \|\| ''\)/);
  assert.doesNotMatch(htmlSource, /id="deployEmail"/);
  assert.doesNotMatch(htmlSource, /saved verified email/);
  assert.match(htmlSource, /tg\.openLink\(data\.paymentUrl\)/);
});

test('mini app creates Flutterwave checkout and resumes the durable job in the verified Flutterwave webhook', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /https:\/\/api\.flutterwave\.com\/v3\/payments/);
  assert.match(botSource, /payment_method, payment_reference, plan_id, plan_days\) VALUES[\s\S]*'flutterwave'/);
  assert.match(botSource, /SELECT user_id, bot_type, app_name, session_id, email, job_id FROM pending_payments/);
  assert.match(botSource, /if \(jobId\) \{[\s\S]*startMiniAppDeploymentJob\(jobId\)/);
});

test('mini app requires a selected payment plan and returns to its job tracker after payment', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(botSource, /MINIAPP_PAYMENT_PLANS/);
  assert.match(botSource, /app\.get\('\/api\/deployment-plans'/);
  assert.match(botSource, /Select a payment plan before continuing/);
  assert.match(botSource, /\/miniapp\?job=\$\{encodeURIComponent\(jobId\)\}/);
  assert.match(botSource, /plan_id, plan_days/);
  assert.match(botSource, /DAYS: job\.plan_days \|\| 30/);
  assert.match(htmlSource, /id="planOptions"/);
  assert.match(htmlSource, /selectedPlan = \{/);
  assert.match(htmlSource, /button\.style\.borderColor = '#22c55e'/);
  assert.match(htmlSource, /returnedJobId/);
  assert.match(htmlSource, /getDeploymentJobHTML/);
});

test('mini app uses the requested app-name-unavailable message for all name conflicts', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const messageMatches = botSource.match(/Name already exists, use another name\./g) || [];
  assert.ok(messageMatches.length >= 4);
});

test('offline bots support validated session recovery and safe restart from the mini app', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(botSource, /app\.post\('\/api\/bots\/set-session'/);
  assert.match(botSource, /Session replacement is available only while this bot is offline/);
  assert.match(botSource, /validateMiniAppDeploymentInput\(botType, 'valid-session-name', normalizedSession\)/);
  assert.match(botSource, /UPDATE user_deployments SET session_id/);
  assert.match(botSource, /Session updated and bot restart initiated/);
  assert.match(htmlSource, /CHANGE SESSION/);
  assert.match(htmlSource, /data-action="change-session"/);
});

test('mini app exposes configuration and supports redeploy and turn-off controls', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(botSource, /app\.post\('\/api\/bots\/turn-off'/);
  assert.match(botSource, /formation\/web/);
  assert.match(htmlSource, /View and Edit Variables/);
  assert.match(htmlSource, /Redeploy Bot/);
  assert.match(htmlSource, /Turn Off Bot/);
  assert.doesNotMatch(htmlSource, /Values are masked in the mini app/);
  assert.match(htmlSource, /escapeValue\(value\)/);
});

test('mini app displays Deploy ID and staged progress after deployment begins', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(botSource, /Provisioning deployment resources/);
  assert.match(botSource, /Configuring bot environment/);
  assert.match(botSource, /Building bot source/);
  assert.match(botSource, /Finalizing deployment/);
  assert.match(botSource, /setInterval\(\(\) =>/);
  assert.match(htmlSource, /Deploy ID:/);
  assert.match(htmlSource, /Processing deployment\.\.\./);
  assert.match(htmlSource, /deploy-cta/);
});

test('mini app deploy-key use sends user and administrator notifications', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /Deploy key used:/);
  assert.match(botSource, /\*Key Used By:\*/);
  assert.match(botSource, /\*Deploy ID:\*/);
});

test('private interaction flow no longer installs destructive keyboard-anchor cleanup', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.doesNotMatch(botSource, /persistentReplyKeyboardMessageIds/);
  assert.doesNotMatch(botSource, /withPersistentReplyKeyboard/);
  assert.doesNotMatch(botSource, /Menu is ready below/);
});

test('dashboard keeps the deployment action above the bot list with static styling and a concise session prompt', () => {
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  const ctaPosition = htmlSource.indexOf('mgmt-option deploy-cta');
  const botListPosition = htmlSource.indexOf('id="botList"');
  assert.ok(ctaPosition > -1 && ctaPosition < botListPosition);
  assert.match(htmlSource, /box-shadow: 0 0 18px rgba\(59, 130, 246, \.72\)/);
  assert.doesNotMatch(htmlSource, /@keyframes orbit-blue-glow/);
  assert.match(htmlSource, /window\.prompt\('Paste the new session ID\.'\)/);
  assert.doesNotMatch(htmlSource, /It will be checked against this bot type before saving/);
});

test('My Bots sync uses bounded checks and requested copy instead of waiting indefinitely', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /Syncing your bots\.\.\./);
  assert.match(botSource, /timeout: 8000/);
  assert.match(botSource, /Promise\.race\(\[formationCheck, fallback\]\)/);
  assert.match(botSource, /sync_unknown: true/);
});

test('primary Deploy, Get Session ID, and My Bots flows no longer add extra keyboard messages', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.doesNotMatch(botSource, /async function restorePersistentReplyKeyboard/);
  assert.doesNotMatch(botSource, /Menu is ready below/);
});

test('deployment CTA is restored to the earlier static glow', () => {
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.doesNotMatch(htmlSource, /\.deploy-cta::after/);
  assert.doesNotMatch(htmlSource, /translateX\(155px\)/);
  assert.match(htmlSource, /box-shadow: 0 0 18px rgba\(59, 130, 246, \.72\)/);
});

test('mini app database bootstrap includes job-payment columns required by deployment creation', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /pending_payments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'/);
  assert.match(botSource, /pending_payments ADD COLUMN IF NOT EXISTS job_id TEXT/);
  assert.match(botSource, /pending_payments ADD COLUMN IF NOT EXISTS auto_status_view TEXT/);
});

test('private chat lifecycle preserves messages and replaces uneditable bot screens safely', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.doesNotMatch(botSource, /void safelyDeleteMessage\(cid, msg\.message_id\)/);
  assert.doesNotMatch(botSource, /sendReplaceablePrivateVideo\(cid, welcomeVideoUrl/);
  assert.match(botSource, /const nativeEditMessageText = bot\.editMessageText\.bind\(bot\)/);
  assert.match(botSource, /Message could not be edited; sending a replacement message instead/);
  assert.match(botSource, /message can't be edited\|message to edit not found/);
});

test('mini app uses concise invalid-session feedback and automatically updates live logs', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  const sessionRoute = botSource.slice(botSource.indexOf("app.post('/api/bots/set-session'"), botSource.indexOf("app.post('/api/bots/turn-off'"));
  assert.match(sessionRoute, /message: 'Invalid session\.'/);
  assert.doesNotMatch(sessionRoute, /message: validationError/);
  assert.match(htmlSource, /Live logs/);
  assert.match(htmlSource, /setInterval\(refreshLogs, 4000\)/);
  assert.match(htmlSource, /panel\.scrollTop = panel\.scrollHeight/);
  assert.doesNotMatch(htmlSource, /Refresh the page to fetch the latest activity\./);
});

test('invalid provider credentials trigger bounded automatic TLS and mass recovery', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /invalidCredential = status === 401/);
  assert.match(botSource, /handleInvalidHerokuKeyWorkflow\(HEROKU_API_KEY\)/);
  assert.match(botSource, /updateRenderVar\('HEROKU_API_KEY', newKey, false\)/);
  assert.match(botSource, /const tlsResult = await deployTlsStack\(ADMIN_ID, \{ restartRender: false \}\)/);
  assert.match(botSource, /TLS deployment failed:/);
  assert.match(botSource, /existingRecovery/);
  assert.match(botSource, /void runScheduledRecoveryCheck\(\)/);
  assert.match(botSource, /async function deployTlsStack\(adminId, \{ restartRender = true \} = \{\}\)/);
});

test('automatic recovery keeps owner rebuilds silent and gives the administrator a replacement-key action', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /Enter New Key/);
  assert.match(botSource, /callback_data: 'recovery_enter_new_key'/);
  assert.match(botSource, /AWAITING_RECOVERY_API_KEY/);
  assert.match(botSource, /Replacement API key verified and stored/);
  assert.match(botSource, /performSilentMassRestoreForType/);
  assert.match(botSource, /dbServices\.silentRestoreBuild/);
  assert.match(botSource, /Owners will not receive build messages/);
  assert.doesNotMatch(botSource.slice(botSource.indexOf('async function performMassRestoreSequence'), botSource.indexOf('async function redeployBot')), /handleRestoreAllConfirm/);
});

test('TLS support apps remain non-expiring and the administrator bypasses email verification', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /if \(String\(userId\) === String\(ADMIN_ID\)\) return true/);
  const tlsSection = botSource.slice(botSource.indexOf('async function deployTlsStack'), botSource.indexOf("bot.onText(/^\\/deploytls/"));
  assert.match(tlsSection, /EXPIRATION_DATE: null/);
  assert.match(tlsSection, /email-tls-/);
  assert.match(tlsSection, /scr-tls-/);
  assert.match(tlsSection, /msg-tls-/);
});

test('Telegram name feedback and mini-app session generation use requested user-safe channels', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(botSource, /This name already exists, try a different name\./);
  assert.match(botSource, /app\.post\('\/api\/session-requests', validateWebAppInitData/);
  assert.match(botSource, /app\.get\('\/api\/session-requests\/:requestId', validateWebAppInitData/);
  assert.match(botSource, /miniAppSessionRequests/);
  assert.match(botSource, /Mini-app session generated/);
  assert.match(botSource, /if \(miniRequest\)/);
  assert.doesNotMatch(botSource.slice(botSource.indexOf("app.post('/api/raganork-callback'"), botSource.indexOf("app.post('/flutterwave/webhook'")), /presentSessionApplyOptions\(miniRequest/);
  assert.match(htmlSource, /Get Session/);
  assert.match(htmlSource, /sessionRequestForm/);
  assert.match(htmlSource, /session-requests/);
  assert.match(htmlSource, /COPY SESSION ID/);
  assert.match(htmlSource, /copy-session/);
});

test('mini-app pairing keeps Processing limited to pending states and provides a compact pairing-code copy action', () => {
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  const renderRequest = htmlSource.slice(htmlSource.indexOf('const renderRequest = request =>'), htmlSource.indexOf('const pollSessionRequest = async requestId =>'));
  assert.match(renderRequest, /request\.status === 'pairing_code'/);
  assert.match(renderRequest, /data-action="copy-pairing"/);
  assert.match(renderRequest, /data-code=""/);
  assert.match(renderRequest, /dataset\.code = request\.pairingCode \|\| ''/);
  assert.match(renderRequest, /request\.status === 'completed'/);
  assert.match(renderRequest, /request\.status === 'failed'/);
  assert.match(renderRequest, /result\.textContent = 'Processing\.\.\.'/);
  assert.doesNotMatch(renderRequest, /Failed to generate session/);
  assert.match(htmlSource, /act === 'copy-session' \|\| act === 'copy-pairing'/);
});

test('Raganork mini-app callback reports pairing-service failures as a safe retry state', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const callback = botSource.slice(botSource.indexOf("app.post('/api/raganork-callback'"), botSource.indexOf('// THE FIX: Strip all non-digits'));
  assert.match(callback, /miniRequest\.status = 'failed'/);
  assert.match(callback, /Session generation could not be completed\. Please retry\./);
  assert.match(callback, /Mini-app Raganork session generation failed/);
  assert.doesNotMatch(callback, /presentSessionApplyOptions\(miniRequest/);
});

test('YT-DLP media extraction is fully removed without removing other process utilities', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const requirements = fs.readFileSync('./requirements.txt', 'utf8');
  assert.doesNotMatch(botSource, /extractMediaInfo|yt-dlp/);
  assert.doesNotMatch(requirements, /yt-dlp/);
  assert.match(botSource, /const execPromise = util\.promisify\(exec\)/);
});

test('expired bots receive a confirmed 24-hour stopped-dyno suspension before deletion', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  const servicesSource = fs.readFileSync('./bot_services.js', 'utf8');
  const expiredQuery = servicesSource.slice(servicesSource.indexOf('async function getExpiredBackups'), servicesSource.indexOf('async function getUserIdByBotName'));
  assert.equal((botSource.match(/GRACE_PERIOD_MS = 24 \* 60 \* 60 \* 1000/g) || []).length, 3);
  assert.doesNotMatch(botSource, /GRACE_PERIOD_MS = 48 \* 60 \* 60 \* 1000/);
  assert.match(expiredQuery, /SELECT user_id, app_name, expiration_date, paused_at/);
  assert.doesNotMatch(expiredQuery, /AND paused_at IS NULL/);
  const worker = botSource.slice(botSource.indexOf('async function checkAndManageExpirations'), botSource.indexOf('// Run the check once every day'));
  assert.match(worker, /formation\/web/);
  assert.match(worker, /\{ quantity: 0 \}/);
  assert.match(worker, /Unable to stop dyno/);
  assert.match(worker, /SET paused_at = NOW\(\)/);
  assert.match(worker, /timeSinceSuspension < GRACE_PERIOD_MS/);
  assert.match(worker, /You have 24 hours to renew/);
});

test('mini app uses semantic action colors for primary, success, warning, danger, and neutral controls', () => {
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  for (const actionClass of ['action-primary', 'action-success', 'action-warning', 'action-danger', 'action-neutral']) {
    assert.match(htmlSource, new RegExp(`\\.${actionClass} \\{`));
  }
  assert.match(htmlSource, /data-action="restart-bot"[\s\S]*action-success|action-success[\s\S]*data-action="restart-bot"/);
  assert.match(htmlSource, /data-action="redeploy-bot"[\s\S]*action-primary|action-primary[\s\S]*data-action="redeploy-bot"/);
  assert.match(htmlSource, /data-action="turn-off-bot"[\s\S]*action-warning|action-warning[\s\S]*data-action="turn-off-bot"/);
  assert.match(htmlSource, /data-action="delete-bot"[\s\S]*action-danger|action-danger[\s\S]*data-action="delete-bot"/);
  assert.match(htmlSource, /24\*60\*60\*1000/);
});

test('AI fallback validates model decisions, uses trusted user context, and limits executable intents', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /const AI_BRAIN_POLICY/);
  assert.match(botSource, /function parseAndValidateAiResponse\(rawContent\)/);
  assert.match(botSource, /function buildAiUserContext\(userBots, deployments, userMessage\)/);
  assert.match(botSource, /USER DATA \(trusted JSON\)/);
  assert.match(botSource, /temperature: 0\.25/);
  assert.match(botSource, /max_tokens: 450/);
  assert.match(botSource, /AI_EXECUTABLE_INTENTS\.has\(aiResponse\.intent\)/);
  assert.match(botSource, /userBots\.some\(botInfo => botInfo\.bot_name === targetBot\)/);
  assert.doesNotMatch(botSource, /return bot\.sendMessage\(chatId, rawContent\)/);
});
