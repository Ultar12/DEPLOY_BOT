const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

let botInstance;
let dbPool;
// --- ADD THIS LINE ---
const ADMIN_ID = process.env.ADMIN_ID; // Make sure ADMIN_ID is in your .env file

// Function to initialize the mail listener
function init(bot, pool) {
  botInstance = bot;
  dbPool = pool;

  const imapConfig = {
    user: process.env.GMAIL_USER,
    password: process.env.GMAIL_APP_PASSWORD, // Use the App Password here
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
  };

  const imap = new Imap(imapConfig);

  imap.on('ready', () => {
    console.log('[Mail Listener] ✅ Connection to Gmail successful. Listening for OTPs...');
    openInbox(imap);
  });

  imap.on('error', (err) => {
    console.error('[Mail Listener] ❌ IMAP Connection Error:', err);
  });

  imap.on('end', () => {
    console.log('[Mail Listener] 🔌 Connection ended. Reconnecting in 30 seconds...');
    setTimeout(() => imap.connect(), 30000); // Attempt to reconnect after 30 seconds
  });

  // Start the connection
  imap.connect();
}

function openInbox(imap) {
  imap.openBox('INBOX', false, (err, box) => { 
    if (err) throw err;
    console.log(`[Mail Listener] Inbox opened. Waiting for new messages...`);
    
    imap.on('mail', () => {
      console.log('[Mail Listener] 📬 New mail received! Searching for OTP...');
      searchForOtp(imap);
    });
  });
}

function searchForOtp(imap) {
  // Search for unseen emails from WhatsApp, specifically for verification
  imap.search(['UNSEEN', ['FROM', 'whatsapp'], ['SUBJECT', 'verify']], (err, results) => {
    if (err || !results || results.length === 0) {
      if (err) console.error('[Mail Listener] Search Error:', err);
      return;
    }

    const f = imap.fetch(results, { bodies: '', markSeen: true }); 

    f.on('message', (msg, seqno) => {
      msg.on('body', (stream, info) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) {
            console.error('[Mail Listener] Email parsing error:', err);
            return;
          }

          const body = parsed.text || '';
          
          // --- THIS IS THE UPDATED LOGIC ---
          // New regex to find the code specifically after "Enter this code:"
          const match = body.match(/Enter this code:\s*(\d{3}-\d{3})/);
          
          if (match && match[1]) {
            const otp = match[1];
            console.log(`[Mail Listener] WhatsApp Email Verification Code Found: ${otp}`);

            // --- SEND THE CODE TO THE ADMIN ---
            await botInstance.sendMessage(ADMIN_ID, `📧 New WhatsApp Email Code Detected:\n\n<code>${otp}</code>`, { parse_mode: 'HTML' });

            const assignedUserResult = await dbPool.query(
              "SELECT user_id FROM temp_numbers WHERE status = 'assigned'"
            );

            if (assignedUserResult.rows.length > 0) {
              const userId = assignedUserResult.rows[0].user_id;
              
              await botInstance.sendMessage(
                userId,
                `Your WhatsApp verification code is: <code>${otp}</code>`,
                { parse_mode: 'HTML' }
              );

              await dbPool.query("DELETE FROM temp_numbers WHERE user_id = $1", [userId]);
              console.log(`[Mail Listener] OTP sent to user ${userId} and their temporary number has been deleted.`);
              
            } else {
              console.warn('[Mail Listener] Found an OTP but no user has a number assigned.');
            }
          }
        });
      });
    });

    f.once('error', (err) => {
      console.log('[Mail Listener] Fetch error: ' + err);
    });
  });
}

module.exports = { init };
