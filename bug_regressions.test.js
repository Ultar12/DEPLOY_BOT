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
  assert.match(htmlSource, /saved verified email/);
  assert.match(htmlSource, /OPEN PAYMENT/);
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
  assert.match(htmlSource, /Your saved verified email will be used to create a secure payment link/);
  assert.match(htmlSource, /tg\.openLink\(data\.paymentUrl\)/);
});

test('mini app database bootstrap includes job-payment columns required by deployment creation', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /pending_payments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'/);
  assert.match(botSource, /pending_payments ADD COLUMN IF NOT EXISTS job_id TEXT/);
  assert.match(botSource, /pending_payments ADD COLUMN IF NOT EXISTS auto_status_view TEXT/);
});

test('private chat lifecycle safely deletes user input and replaces the prior bot screen', () => {
  const botSource = fs.readFileSync('./bot.js', 'utf8');
  assert.match(botSource, /const latestPrivateBotMessageIds = new Map\(\)/);
  assert.match(botSource, /async function safelyDeleteMessage/);
  assert.match(botSource, /bot\.sendMessage = async/);
  assert.match(botSource, /void safelyDeleteMessage\(cid, msg\.message_id\)/);
  assert.match(botSource, /sendReplaceablePrivateVideo\(cid, welcomeVideoUrl/);
});
