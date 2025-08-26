// imap.js
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const { Pool } = require('pg');

// === DATABASE CONFIGURATION ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// === TELEGRAM BOT CONFIGURATION ===
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID; // Your user ID for admin alerts
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// === GMAIL IMAP CONFIGURATION ===
const imapConfig = {
  user: process.env.GMAIL_IMAP_USER,
  password: process.env.GMAIL_IMAP_PASSWORD,
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
  authTimeout: 30000
};

// === UTILITY FUNCTIONS ===

// Sends a message to a Telegram chat
async function sendTelegramMessage(chatId, text) {
    if (!TELEGRAM_BOT_TOKEN) return console.error('TELEGRAM_BOT_TOKEN not set.');
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const payload = { chat_id: chatId, text: text, parse_mode: 'Markdown' };
    try {
        await axios.post(url, payload);
    } catch (err) {
        console.error(`Failed to send message to ${chatId}:`, err.message);
    }
}

// === IMAP LISTENER LOGIC ===
async function startImapListener() {
  const imap = new Imap(imapConfig);

  imap.once('ready', () => {
    console.log('IMAP listener is ready and connected to Gmail.');
    imap.openBox('INBOX', false, (err, box) => { // 'false' to allow marking as seen
      if (err) {
        console.error('Failed to open INBOX:', err);
        return;
      }
      
      const checkMail = () => {
        imap.search(['UNSEEN', 'FROM', 'noreply@whatsapp.com'], (err, results) => {
          if (err || !results || results.length === 0) {
            return;
          }

          const f = imap.fetch(results, { bodies: '' });

          f.on('message', (msg, seqno) => {
            msg.on('body', (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (err) {
                  console.error('Failed to parse email:', err);
                  return;
                }

                // We are specifically looking for WhatsApp OTPs
                if (parsed.text.includes('is your WhatsApp code')) {
                  const otpCode = parsed.text.match(/\d{3}-\d{3}/)?.[0] || 'Code not found.';
                  
                  // Find the user who was assigned a temporary number
                  try {
                    const assignedNumberResult = await pool.query(
                      "SELECT user_id, number FROM temp_numbers WHERE status = 'assigned' AND assigned_at > NOW() - INTERVAL '30 minutes' ORDER BY assigned_at DESC LIMIT 1"
                    );
                    
                    if (assignedNumberResult.rows.length > 0) {
                      const user = assignedNumberResult.rows[0];
                      await sendTelegramMessage(user.user_id, `Your WhatsApp OTP is: \`${otpCode}\``);
                      console.log(`Successfully forwarded OTP to user ${user.user_id} for number ${user.number}`);
                      
                      // Mark the number as expired
                      await pool.query("UPDATE temp_numbers SET status = 'expired' WHERE number = $1", [user.number]);

                      // Mark the email as read
                      imap.addFlags(msg.uid, ['\\Seen'], (err) => {
                        if (err) console.error('Failed to mark email as read:', err);
                      });
                    }
                  } catch (dbError) {
                    console.error('Database error during OTP forwarding:', dbError);
                  }
                }
              });
            });
          });
        });
      };

      // Check for new mail every 10 seconds
      setInterval(checkMail, 10000);
    });
  });

  imap.once('error', (err) => {
    console.error('IMAP error:', err);
    // Attempt to reconnect after a delay
    setTimeout(startImapListener, 60000); // 1-minute delay
  });

  imap.once('end', () => {
    console.log('IMAP connection ended.');
    // Attempt to reconnect after a delay
    setTimeout(startImapListener, 60000);
  });
  
  imap.connect();
}

// Start the listener
startImapListener();
