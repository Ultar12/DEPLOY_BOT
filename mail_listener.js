const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

let botInstance;
let dbPool;
const ADMIN_ID = process.env.ADMIN_ID;

// A simple delay function
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
      if (err.message.includes('IMAP connection ended')) {
          // No need for a long delay if the connection just ended, try to reconnect sooner.
          console.log('[Mail Listener] 🔌 Reconnecting in 5 seconds...');
          await delay(5000);
      } else {
          console.log('[Mail Listener] 🔌 Reconnecting in 30 seconds...');
          await delay(30000);
      }
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
    if (imap.state !== 'authenticated') {
      console.warn('[Mail Listener] Not authenticated. Skipping search.');
      return resolve();
    }

    // FIX: Search by SUBJECT for better reliability
    imap.search(['UNSEEN', ['SUBJECT', 'WhatsApp']], (err, results) => {
      if (err) {
        console.error('[Mail Listener] Search Error:', err);
        return resolve(); 
      }
      if (!results || results.length === 0) {
        return resolve();
      }

      console.log(`[Mail Listener] 📬 Found ${results.length} new message(s) with 'WhatsApp' in the subject!`);
      const f = imap.fetch(results, { bodies: '', markSeen: true });
      
      f.on('message', (msg) => {
        msg.on('body', (stream) => {
          simpleParser(stream, async (err, parsed) => {
            try {
              if (err) return console.error('[Mail Listener] Email parsing error:', err);

              const body = parsed.text || '';
              let otp = null;
              let match = null;

              // Pattern for admin-only email verification
              if (body.includes('Go to Settings > Account > Email address')) {
                match = body.match(/Enter this code:\s*(\d{3}-\d{3})/);
                if (match && match[1]) {
                  otp = match[1];
                  console.log(`[Mail Listener] Admin-only code found: ${otp}`);
                  await botInstance.sendMessage(ADMIN_ID, `📧 WhatsApp Email Verification Code Detected:\n\n<code>${otp}</code>`, { parse_mode: 'HTML' });
                  return; // Stop processing this specific email
                }
              }

              // Array of patterns for standard user OTPs
              const otpPatterns = [
                /is your WhatsApp code (\d{3}-\d{3})/,
                /Or copy and paste this code into WhatsApp:\s*(\d{3}-\d{3})/,
                /(\d{3}-\d{3}) is your WhatsApp code/,
              ];
              
              for (const pattern of otpPatterns) {
                  match = body.match(pattern);
                  if (match && match[1]) {
                      otp = match[1];
                      break; // Stop after the first successful match
                  }
              }

              if (otp) {
                console.log(`[Mail Listener] User OTP code found: ${otp}`);
                
                // FIX: Query specifically for ONE assigned user to be safe
                const assignedUserResult = await dbPool.query("SELECT user_id FROM temp_numbers WHERE status = 'assigned' LIMIT 1");
                
                if (assignedUserResult.rows.length > 0) {
                  const userId = assignedUserResult.rows[0].user_id;
                  await botInstance.sendMessage(userId, `Your WhatsApp verification code is: <code>${otp}</code>`, { parse_mode: 'HTML' });
                  
                  // FIX: As requested, permanently DELETE the number after use.
                  await dbPool.query("DELETE FROM temp_numbers WHERE user_id = $1", [userId]);
                  console.log(`[Mail Listener] OTP sent to user ${userId} and their number has been DELETED.`);
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
      });

      f.once('end', () => {
        resolve();
      });
    });
  });
}

module.exports = { init };
