const Imap = require('node-imap');
const { simpleParser } = require('mailparser');

let botInstance;
let dbPool;
const ADMIN_ID = process.env.ADMIN_ID;

function init(bot, pool) {
  botInstance = bot;
  dbPool = pool;

  const imapConfig = {
    user: process.env.GMAIL_USER,
    password: process.env.GMAIL_APP_PASSWORD,
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
    setTimeout(() => imap.connect(), 30000);
  });

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
  // Broadened search to catch any email from WhatsApp
  imap.search(['UNSEEN', ['FROM', 'whatsapp']], (err, results) => {
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
          const subject = parsed.subject || '';
          let otp = null;
          let match = null;

          // 1. Check for the ADMIN-ONLY "Email Verification" format
          if (body.includes('Go to Settings > Account > Email address')) {
            match = body.match(/Enter this code:\s*(\d{3}-\d{3})/);
            if (match && match[1]) {
              otp = match[1];
              console.log(`[Mail Listener] Admin-only email verification code found: ${otp}`);
              await botInstance.sendMessage(ADMIN_ID, `📧 WhatsApp Email Verification Code Detected:\n\n<code>${otp}</code>`, { parse_mode: 'HTML' });
              return; // Stop processing this email
            }
          }

          // --- THIS IS THE NEW LOGIC FOR THE SCREENSHOT ---
          // 2. Check for the new USER OTP format (from your screenshot)
          else if (subject.includes('WhatsApp Verification Code')) {
             match = body.match(/Or copy and paste this code into WhatsApp:\s*(\d{3}-\d{3})/);
             if (match && match[1]) {
                otp = match[1];
             }
          }

          // 3. If not the admin or new format, check for the old USER OTP format
          else {
            match = body.match(/is your WhatsApp code (\d{3}-\d{3})/);
            if (match && match[1]) {
                otp = match[1];
            }
          }

          // If any of the user-facing formats found an OTP, process it
          if (otp) {
            console.log(`[Mail Listener] User OTP code found: ${otp}`);
            const assignedUserResult = await dbPool.query(
              "SELECT user_id FROM temp_numbers WHERE status = 'assigned'"
            );
            
            if (assignedUserResult.rows.length > 0) {
              const userId = assignedUserResult.rows[0].user_id;
              await botInstance.sendMessage(userId, `Your WhatsApp verification code is: <code>${otp}</code>`, { parse_mode: 'HTML' });
              await dbPool.query("DELETE FROM temp_numbers WHERE user_id = $1", [userId]);
              console.log(`[Mail Listener] OTP sent to user ${userId} and their temporary number has been deleted.`);
            } else {
              console.warn('[Mail Listener] Found a user OTP but no user has a number assigned.');
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
