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
      console.log('[Mail Listener] ✅ Connection successful. Starting mail checks.');

      while (imap.state === 'authenticated') {
        // --- UPDATED: Now checks for both OTPs and other mail ---
        await searchForOtp(imap);
        await searchForAllMail(imap); // New function call
        console.log('[Mail Listener] 🕒 Check complete. Waiting 15 seconds...');
        await delay(15000);
      }
    } catch (err) {
      console.error('[Mail Listener] ❌ A critical error occurred:', err.message);
      if (imap && imap.state !== 'disconnected') {
        imap.end();
      }
      console.log('[Mail Listener] 🔌 Reconnecting in 30 seconds...');
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

function searchForOtp(imap) {
  return new Promise((resolve) => {
    if (imap.state !== 'authenticated') return resolve();

    imap.search(['UNSEEN', ['SUBJECT', 'WhatsApp']], (err, results) => {
      if (err || !results || results.length === 0) {
        return resolve();
      }

      console.log(`[Mail Listener] 📬 Found ${results.length} new WhatsApp message(s)!`);
      const f = imap.fetch(results, { bodies: '', markSeen: true });
      
      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (err, parsed) => {
            try {
              if (err) return console.error('[Mail Listener] Email parsing error:', err);

              const body = parsed.text || '';
              let otp = null;
              let match = null;
              
              const otpPatterns = [
                /is your WhatsApp code (\d{3}-\d{3})/,
                /Or copy and paste this code into WhatsApp:\s*(\d{3}-\d{3})/,
                /(\d{3}-\d{3}) is your WhatsApp code/,
                /Enter this code:\s*(\d{3}-\d{3})/
              ];
              
              for (const pattern of otpPatterns) {
                  match = body.match(pattern);
                  if (match && match[1]) {
                      otp = match[1];
                      break;
                  }
              }

              if (otp) {
                console.log(`[Mail Listener] WhatsApp OTP code found: ${otp}`);
                const assignedUserResult = await dbPool.query("SELECT user_id FROM temp_numbers WHERE status = 'assigned' LIMIT 1");
                
                if (assignedUserResult.rows.length > 0) {
                  const userId = assignedUserResult.rows[0].user_id;
                  await botInstance.sendMessage(userId, `Your WhatsApp verification code is: <code>${otp}</code>`, { parse_mode: 'HTML' });
                  await dbPool.query("DELETE FROM temp_numbers WHERE user_id = $1", [userId]);
                  console.log(`[Mail Listener] OTP sent to user ${userId} and their number has been DELETED.`);
                } else {
                  // --- NEW: Forwards unassigned OTPs to the admin ---
                  console.warn('[Mail Listener] Found a WhatsApp OTP but no user has a number assigned. Forwarding to admin.');
                  await botInstance.sendMessage(ADMIN_ID, `Unassigned WhatsApp OTP Detected:\n\n<code>${otp}</code>`, { parse_mode: 'HTML' });
                }
              }
            } catch (asyncError) {
              console.error('[Mail Listener] Error processing OTP message:', asyncError);
            }
          });
        });
      });
      f.once('error', (fetchErr) => console.error('[Mail Listener] Fetch error:', fetchErr));
      f.once('end', () => resolve());
    });
  });
}

// --- NEW FUNCTION TO FORWARD ALL OTHER MAIL ---
function searchForAllMail(imap) {
    return new Promise((resolve) => {
        if (imap.state !== 'authenticated') return resolve();

        // Search for all unread mail that is NOT from WhatsApp
        imap.search(['UNSEEN', ['NOT', ['SUBJECT', 'WhatsApp']]], (err, results) => {
            if (err || !results || results.length === 0) {
                return resolve();
            }

            console.log(`[Mail Listener] Found ${results.length} new non-WhatsApp message(s)!`);
            const f = imap.fetch(results, { bodies: '', markSeen: true });

            f.on('message', (msg) => {
                msg.on('body', (stream) => {
                    simpleParser(stream, async (err, parsed) => {
                        try {
                            if (err) return console.error('[Mail Listener] General mail parsing error:', err);

                            const from = parsed.from.text;
                            const subject = parsed.subject || '(No Subject)';
                            const snippet = (parsed.text || 'No content').substring(0, 200);

                            const messageToAdmin = `
**New Email Received**

**From:** \`${from}\`
**Subject:** \`${subject}\`

**Content Snippet:**
\`\`\`
${snippet}...
\`\`\`
                            `;

                            await botInstance.sendMessage(ADMIN_ID, messageToAdmin, { parse_mode: 'Markdown' });
                            console.log(`[Mail Listener] Forwarded email from "${from}" to admin.`);
                        } catch (asyncError) {
                            console.error('[Mail Listener] Error processing general message:', asyncError);
                        }
                    });
                });
            });
            f.once('error', (fetchErr) => console.error('[Mail Listener] General fetch error:', fetchErr));
            f.once('end', () => resolve());
        });
    });
}

module.exports = { init };
