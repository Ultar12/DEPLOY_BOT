const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

let botInstance;
let dbPool;
const ADMIN_ID = process.env.ADMIN_ID;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function init(bot, pool) {
  botInstance = bot;
  dbPool = pool;
  runListener();
}

async function runListener() {
  console.log('[Mail Listener] Starting listener service...');

  while (true) {
    let imap;
    try {
      imap = await connectToImap();
      console.log('[Mail Listener] Connection successful. Starting mail checks.');

      while (imap.state === 'authenticated') {
        await processUnreadMail(imap);
        console.log('[Mail Listener] Check complete. Waiting 15 seconds...');
        await delay(15000);
      }
    } catch (err) {
      console.error('[Mail Listener] A critical error occurred:', err.message);
      if (imap && imap.state !== 'disconnected') {
        imap.end();
      }
      console.log('[Mail Listener] Reconnecting in 30 seconds...');
      await delay(30000);
    }
  }
}

function connectToImap() {
  const imapConfig = {
    user: process.env.GMAIL_USER,
    password: process.env.GMAIL_APP_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  };

  const imap = new Imap(imapConfig);

  return new Promise((resolve, reject) => {
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) return reject(new Error('Error opening inbox: ' + err.message));
        resolve(imap);
      });
    });
    imap.once('error', (err) => reject(new Error('IMAP Connection Error: ' + err.message)));
    imap.once('end', () => reject(new Error('IMAP connection ended unexpectedly.')));
    imap.connect();
  });
}

function isAutomatedMail(parsed, subject, body) {
  const headers = parsed.headers;

  const getHeader = (name) => {
    const val = headers.get(name);
    return val ? String(val).toLowerCase() : '';
  };

  const autoSubmitted = getHeader('auto-submitted');
  const precedence = getHeader('precedence');
  const contentType = getHeader('content-type');
  const xAutoReply = getHeader('x-autoreply') || getHeader('x-autorespond');

  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (['bulk', 'auto_reply', 'junk'].includes(precedence)) return true;
  if (contentType.includes('report-type=delivery-status')) return true;
  if (xAutoReply) return true;

  const s = subject.toLowerCase();
  const b = body.toLowerCase();
  const bounceKeywords = [
    'delivery status notification',
    'undelivered mail',
    'failure notice',
    'mail delivery failed',
    "wasn't delivered",
    'message not delivered',
    'address not found',
    'delivery has failed',
  ];
  return bounceKeywords.some(k => s.includes(k) || b.includes(k));
}

// Best-effort code/OTP detection in arbitrary email bodies. Heuristic —
// can miss unusual formats or occasionally match an unrelated number.
function extractCode(body) {
  const patterns = [
    /(?:code|otp|pin|passcode|password|verification code|security code|confirmation code|bestätigungscode|sicherheitscode)[^\d]{0,20}(\d[\d\s-]{3,10}\d)/i,
    /(\d[\d\s-]{3,10}\d)[^\d]{0,20}(?:is your code|is your otp|is your pin|ist ihr code)/i,
    /\b(\d{3}-\d{3})\b/,
    /\b(\d{6})\b/,
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match && match[1]) {
      return match[1].replace(/[\s-]/g, '');
    }
  }
  return null;
}

function processUnreadMail(imap) {
  return new Promise((resolve) => {
    if (imap.state !== 'authenticated') return resolve();

    imap.search(['UNSEEN'], (err, results) => {
      if (err || !results || results.length === 0) {
        return resolve();
      }

      console.log(`[Mail Listener] Found ${results.length} new message(s).`);
      const f = imap.fetch(results, { bodies: '', markSeen: true });

      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (err, parsed) => {
            try {
              if (err) return console.error('[Mail Listener] Email parsing error:', err);

              const subject = parsed.subject || '';
              const from = parsed.from.text;
              const body = parsed.text || '';

              if (subject.toLowerCase().includes('whatsapp')) {
                let otp = null;
                let match = null;

                const otpPatterns = [
                  /Enter this code:\s+(\d{3}-\d{3})/,
                  /Or copy and paste this code into WhatsApp: (\d{3}-\d{3})/,
                  /Or copy and paste this code into WhatsApp Business: (\d{3}-\d{3})/,
                  /is your WhatsApp code (\d{3}-\d{3})/,
                  /(\d{3}-\d{3}) is your WhatsApp code/,
                  /your WhatsApp code is (\d{6})/,
                ];

                for (const pattern of otpPatterns) {
                    match = body.match(pattern);
                    if (match && match[1]) {
                        otp = match[1].replace('-', '');
                        break;
                    }
                }

                if (otp) {
                  console.log(`[Mail Listener] WhatsApp OTP found: ${otp}`);
                  const assignedUserResult = await dbPool.query("SELECT user_id FROM temp_numbers WHERE status = 'assigned' LIMIT 1");

                  if (assignedUserResult.rows.length > 0) {
                    const userId = assignedUserResult.rows[0].user_id;
                    await botInstance.sendMessage(userId, `Your WhatsApp verification code is: <code>${otp}</code>`, { parse_mode: 'HTML' });
                    await dbPool.query("DELETE FROM temp_numbers WHERE user_id = $1", [userId]);
                    console.log(`[Mail Listener] OTP sent to user ${userId} and their number has been DELETED.`);
                  } else {
                    await botInstance.sendMessage(ADMIN_ID, `Unassigned WhatsApp OTP Detected: ${otp}`, {
                      reply_markup: {
                        inline_keyboard: [[
                          { text: `Copy ${otp}`, copy_text: { text: otp } }
                        ]]
                      }
                    });
                  }
                } else {
                    console.warn(`[Mail Listener] Found WhatsApp email from "${from}" but no OTP pattern matched.`);
                }
              } else {
                if (isAutomatedMail(parsed, subject, body)) {
                  console.log(`[Mail Listener] Skipping automated/bounce email: "${subject}"`);
                  return;
                }

                console.log(`[Mail Listener] Forwarding non-WhatsApp message from "${from}"`);

                const code = extractCode(body);

                const MAX_LEN = 3800;
                const trimmedBody = body.length > MAX_LEN
                  ? body.slice(0, MAX_LEN) + '\n\n[message truncated - too long for Telegram]'
                  : body;

                const messageToAdmin =
                  `New Email Received\n\n` +
                  `From: ${from}\n` +
                  `Subject: ${subject}\n\n` +
                  `${trimmedBody}`;

                const sendOptions = {};
                if (code) {
                  sendOptions.reply_markup = {
                    inline_keyboard: [[
                      { text: `Copy code: ${code}`, copy_text: { text: code } }
                    ]]
                  };
                }

                await botInstance.sendMessage(ADMIN_ID, messageToAdmin, sendOptions);
              }
            } catch (asyncError) {
              console.error('[Mail Listener] Error processing message:', asyncError);
            }
          });
        });
      });
      f.once('error', (fetchErr) => console.error('[Mail Listener] Fetch error:', fetchErr));
      f.once('end', () => resolve());
    });
  });
}

module.exports = { init };
