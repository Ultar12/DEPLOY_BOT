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
  assert.match(htmlSource, /deployEmail/);
  assert.match(htmlSource, /OPEN PAYMENT/);
  assert.match(htmlSource, /t\.me\/staries1/);
});

test('mini app client polls job progress instead of hiding the deployment result', () => {
  const htmlSource = fs.readFileSync('./public/index.html', 'utf8');
  assert.match(htmlSource, /pollJob\(data\.jobId\)/);
  assert.match(htmlSource, /deployment-jobs\//);
  assert.match(htmlSource, /progress_message/);
});
