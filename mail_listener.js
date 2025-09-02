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
        // --- FIX: Now calls a single, unified function ---
        await processUnreadMail(imap);
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

// --- NEW UNIFIED FUNCTION ---
function processUnreadMail(imap) {
  return new Promise((resolve) => {
    if (imap.state !== 'authenticated') return resolve();

    // Step 1: Fetch ALL unread emails at once
    imap.search(['UNSEEN'], (err, results) => {
      if (err || !results || results.length === 0) {
        return resolve();
      }

      console.log(`[Mail Listener] 📬 Found ${results.length} new message(s).`);
      const f = imap.fetch(results, { bodies: '', markSeen: true });
      
      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (err, parsed) => {
            try {
              if (err) return console.error('[Mail Listener] Email parsing error:', err);

              const subject = parsed.subject || '';
              const from = parsed.from.text;
              const body = parsed.text || '';

              // Step 2: Decide what to do based on the subject
              if (subject.includes('WhatsApp')) {
                // --- This is the OTP logic ---
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
                        otp = match[1].replace('-', ''); // Also remove hyphen for user convenience
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
                    await botInstance.sendMessage(ADMIN_ID, `📧 Unassigned WhatsApp OTP Detected:\n\n<code>${otp}</code>`, { parse_mode: 'HTML' });
                  }
                }
              } else {
                // --- This is the "forward all other mail" logic ---
                console.log(`[Mail Listener] 📩 Forwarding non-WhatsApp message from "${from}"`);
                const snippet = body.substring(0, 200);
                const messageToAdmin = `
📧 **New Email Received**

**From:** \`${from}\`
**Subject:** \`${subject}\`

**Content Snippet:**
\`\`\`
${snippet}...
\`\`\`
                `;
                await botInstance.sendMessage(ADMIN_ID, messageToAdmin, { parse_mode: 'Markdown' });
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
