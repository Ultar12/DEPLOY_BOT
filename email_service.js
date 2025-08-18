const nodemailer = require('nodemailer');
const { escapeMarkdown } = require('./bot_services'); // Assuming bot_services is where escapeMarkdown lives

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
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('Email service is not configured. Skipping sending email.');
    return;
  }
  
  const formattedBotType = botType.toUpperCase();
  const escapedAppName = escapeMarkdown(appName);
  const escapedSessionId = escapeMarkdown(sessionId);

  const mailOptions = {
    from: `"Raganork Bot Team" <${GMAIL_USER}>`,
    to: toEmail,
    subject: 'Your Raganork Bot Deployment is Confirmed!',
    html: `
      <p>Hello ${userName},</p>
      <p>Welcome! We are thrilled to confirm that your payment has been received for the deployment of your new bot.</p>
      <p>Your order details are as follows:</p>
      <ul>
        <li><strong>Reference ID:</strong> ${referenceId}</li>
        <li><strong>App Name:</strong> ${escapedAppName}</li>
        <li><strong>Bot Type:</strong> ${formattedBotType}</li>
      </ul>
      <p>Your bot is now in the final stages of deployment. This process usually takes a few minutes. We have recorded your unique Session ID for you:</p>
      <p><strong>${escapedSessionId}</strong></p>
      <p>You will receive a notification in our Telegram bot as soon as your bot, ${escapedAppName}, is fully online and ready to go. You can also monitor its status at any time using the My Bots menu in the bot.</p>
      <p>If you require any assistance, our support team is always here to help.</p>
      <p>Sincerely,</p>
      <p><strong>The Raganork Bot Team</strong></p>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email successfully sent to ${toEmail}`);
  } catch (error) {
    console.error(`Error sending email to ${toEmail}:`, error);
  }
}

module.exports = {
  sendPaymentConfirmation,
};
