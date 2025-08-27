const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

let botInstance;
let dbPool;
const ADMIN_ID = process.env.ADMIN_ID;

// A simple delay function to replace setInterval
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function init(bot, pool) {
  botInstance = bot;
  dbPool = pool;
  runListener(); // Start the main listener loop
}

async function runListener() {
  console.log('[Mail Listener] Starting listener service...');
  
  // This loop ensures the listener always tries to reconnect and run
  while (true) {
    try {
      const imap = await connectToImap();
      console.log('[Mail Listener] ✅ Connection successful. Starting mail checks.');

      // This inner loop handles the periodic mail checking
      while (imap.state === 'authenticated') {
        await searchForOtp(imap);
        console.log('[Mail Listener] 🕒 Check complete. Waiting 15 seconds...');
        await delay(15000); // Wait 15 seconds before the next check
      }
    } catch (err) {
      console.error('[Mail Listener] ❌ A critical error occurred:', err.message);
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
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          return reject(new Error('Error opening inbox: ' + err.message));
        }
        resolve(imap); // Connection and inbox are ready
      });
    });

    imap.once('error', (err) => {
      reject(new Error('IMAP Connection Error: ' + err.message));
    });

    imap.once('end', () => {
      // This will be caught by the outer loop as a closed connection
      reject(new Error('IMAP connection ended unexpectedly.'));
    });

    imap.connect();
  });
}

function searchForOtp(imap) {
  return new Promise((resolve, reject) => {
    if (imap.state !== 'authenticated') {
      console.warn('[Mail Listener] Not authenticated. Skipping search.');
      return resolve(); // Resolve peacefully if not connected
    }

    imap.search(['UNSEEN', ['FROM', 'whatsapp']], (err, results) => {
      if (err) {
        // Don't reject here, as a search error shouldn't kill the connection
        console.error('[Mail Listener] Search Error:', err);
        return resolve(); 
      }
      if (!results || results.length === 0) {
        return resolve(); // No new mail, which is normal
      }

      console.log(`[Mail Listener] 📬 Found ${results.length} new message(s)!`);
      const f = imap.fetch(results, { bodies: '', markSeen: true });
      
      let processingCompleted = 0;

      f.on('message', (msg, seqno) => {
        msg.on('body', (stream, info) => {
          simpleParser(stream, async (err, parsed) => {
            // NEW: Added try/catch for robust async handling
            try {
              if (err) {
                console.error('[Mail Listener] Email parsing error:', err);
                return;
              }

              const body = parsed.text || '';
              const subject = parsed.subject || '';
              let otp = null;
              let match = null;

              if (body.includes('Go to Settings > Account > Email address')) {
                match = body.match(/Enter this code:\s*(\d{3}-\d{3})/);
                if (match && match[1]) {
                  otp = match[1];
                  console.log(`[Mail Listener] Admin-only code found: ${otp}`);
                  await botInstance.sendMessage(ADMIN_ID, `📧 WhatsApp Email Verification Code Detected:\n\n<code>${otp}</code>`, { parse_mode: 'HTML' });
                  return; // Stop processing this message
                }
              }
              else if (subject.includes('WhatsApp Verification Code')) {
                 match = body.match(/Or copy and paste this code into WhatsApp:\s*(\d{3}-\d{3})/);
                 if (match && match[1]) otp = match[1];
              }
              else {
                match = body.match(/is your WhatsApp code (\d{3}-\d{3})/);
                if (match && match[1]) otp = match[1];
              }

              if (otp) {
                console.log(`[Mail Listener] User OTP code found: ${otp}`);
                const assignedUserResult = await dbPool.query("SELECT user_id FROM temp_numbers WHERE status = 'assigned'");
                
                if (assignedUserResult.rows.length > 0) {
                  const userId = assignedUserResult.rows[0].user_id;
                  await botInstance.sendMessage(userId, `Your WhatsApp verification code is: <code>${otp}</code>`, { parse_mode: 'HTML' });
                  await dbPool.query("DELETE FROM temp_numbers WHERE user_id = $1", [userId]);
                  console.log(`[Mail Listener] OTP sent to user ${userId} and their number has been deleted.`);
                } else {
                  console.warn('[Mail Listener] Found a user OTP but no user has a number assigned.');
                }
              }
            } catch (asyncError) {
              console.error('[Mail Listener] Error processing message or sending OTP:', asyncError);
            }
          });
        });
      });

      f.once('error', (err) => {
        console.error('[Mail Listener] Fetch error:', err);
        // Don't reject, just log and continue
      });

      f.once('end', () => {
        // All messages have been fetched
        resolve();
      });
    });
  });
}

module.exports = { init };
