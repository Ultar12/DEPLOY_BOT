const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.warn('GMAIL_USER or GMAIL_APP_PASSWORD is not set. Email functionality will be disabled.');
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

async function sendPaymentConfirmation(toEmail, userName, referenceId, appName, botType, sessionId) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || !toEmail) {
    console.error('Email service is not fully configured or recipient email is missing. Skipping sending email.');
    return;
  }
  
  const formattedBotType = botType.toUpperCase();

  const mailOptions = {
    from: `"ULTAR'S WBD" <${GMAIL_USER}>`,
    to: toEmail,
    subject: `Payment Confirmed: Your Bot Deployment (${referenceId})`,
    html: `
      <div style="background-color: #000; padding: 20px; font-family: sans-serif; color: #fff; text-align: center; border-radius: 10px;">
        <img src="https://files.catbox.moe/k1n5p2.jpeg" alt="ULTAR'S WBD" style="max-width: 100%; border-radius: 10px; margin-bottom: 20px;">
        
        <h1 style="font-size: 24px; font-weight: bold;">Hello Dear,</h1>
        
        <p style="font-size: 16px;">We are thrilled to confirm your payment has been received for the deployment of your new bot.</p>
        
        <div style="background-color: #121212; border-radius: 8px; padding: 15px; margin: 20px 0;">
          <h2 style="font-size: 18px; color: #69F0AE; margin-top: 0;">Order Details</h2>
          <ul style="list-style-type: none; padding: 0; text-align: left; font-size: 14px;">
            <li style="margin-bottom: 5px;"><strong>Reference ID:</strong> ${referenceId}</li>
            <li style="margin-bottom: 5px;"><strong>App Name:</strong> ${appName}</li>
            <li style="margin-bottom: 5px;"><strong>Bot Type:</strong> ${formattedBotType}</li>
            <li style="margin-bottom: 5px;"><strong>Session ID:</strong> <code>${sessionId}</code></li>
          </ul>
        </div>
        
        <p style="font-size: 16px;">Your bot is now in the final stages of deployment. You will receive a notification in Telegram as soon as it is fully online and ready to go.</p>
        
        <a href="https://t.me/ultarbotdeploybot" style="display: inline-block; padding: 12px 24px; margin-top: 20px; background-color: #69F0AE; color: #121212; text-decoration: none; border-radius: 50px; font-weight: bold;">GO TO YOUR BOT</a>
        
        <p style="font-size: 14px; margin-top: 20px;">Sincerely,<br><strong>ULTAR'S WBD</strong></p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email successfully sent to ${toEmail}`);
  } catch (error) {
    console.error(`Error sending email to ${toEmail}:`, error);
  }
}

// --- NEW FUNCTION FOR LOGGED-OUT REMINDERS ---
async function sendLoggedOutReminder(toEmail, appName, botUsername) {
  if (!toEmail || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.warn(`[Email] Skipping logged-out reminder. Email service not configured or recipient is missing.`);
    return;
  }
  
  const mailOptions = {
    from: `"ULTAR'S WBD" <${GMAIL_USER}>`,
    to: toEmail,
    subject: `Action Required: Your Bot (${appName}) is Offline`,
    html: `
      <div style="background-color: #000; padding: 20px; font-family: sans-serif; color: #fff; text-align: center; border-radius: 10px;">
        <img src="https://files.catbox.moe/k1n5p2.jpeg" alt="ULTAR'S WBD" style="max-width: 100%; border-radius: 10px; margin-bottom: 20px;">
        <h1 style="font-size: 24px; font-weight: bold;">Your Bot is Offline</h1>
        <p style="font-size: 16px;">Hello there,</p>
        <p style="font-size: 16px;">This is an automated notification to inform you that your bot, <strong>${appName}</strong>, has been logged out and is currently offline. This may be due to an issue with your session ID.</p>
        <p style="font-size: 16px;">To get your bot back online, please update your session ID. You can do this directly from our Telegram bot.</p>
        <a href="https://t.me/${botUsername}" style="display: inline-block; padding: 12px 24px; margin-top: 20px; background-color: #69F0AE; color: #121212; text-decoration: none; border-radius: 50px; font-weight: bold;">GO TO YOUR BOT</a>
        <p style="font-size: 12px; color: #aaa; margin-top: 20px;">If you have questions, please reach out to support. Your bot will remain in your 'My Bots' list, but it will not be online until you update the session.</p>
        <p style="font-size: 14px; margin-top: 20px;">Sincerely,<br><strong>ULTAR'S WBD</strong></p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Sent logged-out reminder email to ${toEmail} for bot ${appName}`);
  } catch (error) {
    console.error(`Error sending logged-out reminder email to ${toEmail}:`, error);
  }
}

module.exports = {
  sendPaymentConfirmation,
  sendLoggedOutReminder,
};
