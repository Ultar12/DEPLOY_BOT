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

  function connectAndListen() {
    const imap = new Imap(imapConfig);

    imap.once('ready', () => {
      console.log('[Mail Listener] ✅ Connection successful. Starting mail check interval.');
      imap.openBox('INBOX', false, (err, box) => {
        if (err) {
          console.error('[Mail Listener] Error opening inbox:', err);
          return;
        }
        // Check for mail immediately on connection, then start the timer
        searchForOtp(imap);
        setInterval(() => {
          console.log('[Mail Listener] 🕒 Checking for new mail...');
          searchForOtp(imap);
        }, 15000); // Check every 15 seconds
      });
    });

    imap.once('error', (err) => {
      console.error('[Mail Listener] ❌ IMAP Connection Error:', err);
      // Don't reconnect immediately to avoid loops
    });

    imap.once('end', () => {
      console.log('[Mail Listener] 🔌 Connection ended. Reconnecting in 30 seconds...');
      setTimeout(connectAndListen, 30000);
    });

    imap.connect();
  }

  // Initial connection
  connectAndListen();
}

function searchForOtp(imap) {
  if (imap.state !== 'authenticated') {
      console.warn('[Mail Listener] Not authenticated. Skipping search.');
      return;
  }
  
  imap.search(['UNSEEN', ['FROM', 'whatsapp']], (err, results) => {
    if (err) {
      console.error('[Mail Listener] Search Error:', err);
      return;
    }
    if (!results || results.length === 0) {
      // This is normal, just means no new mail
      return;
    }

    console.log(`[Mail Listener] 📬 Found ${results.length} new message(s)!`);
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

          if (body.includes('Go to Settings > Account > Email address')) {
            match = body.match(/Enter this code:\s*(\d{3}-\d{3})/);
            if (match && match[1]) {
              otp = match[1];
              console.log(`[Mail Listener] Admin-only code found: ${otp}`);
              await botInstance.sendMessage(ADMIN_ID, `📧 WhatsApp Email Verification Code Detected:\n\n<code>${otp}</code>`, { parse_mode: 'HTML' });
              return;
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
        });
      });
    });

    f.once('error', (err) => {
      console.log('[Mail Listener] Fetch error: ' + err);
    });
  });
}

module.exports = { init };
