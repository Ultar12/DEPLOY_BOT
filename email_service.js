const axios = require('axios');

// Get the URL and secret key from your bot's environment variables
const EMAIL_SERVICE_URL = process.env.EMAIL_SERVICE_URL;
const EMAIL_SERVICE_API_KEY = process.env.EMAIL_SERVICE_API_KEY;

/**
 * A helper function to communicate with the external email service.
 * @param {string} type - The type of email to send (e.g., 'verification').
 * @param {object} payload - The data needed to construct the email.
 */
async function sendEmailViaService(type, payload) {
  if (!EMAIL_SERVICE_URL || !EMAIL_SERVICE_API_KEY) {
    console.error('[Email Service] URL or API Key is not configured. Cannot send email.');
    return false;
  }

  try {
    await axios.post(`${EMAIL_SERVICE_URL}/send-email`, 
      {
        type: type,
        payload: payload,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': EMAIL_SERVICE_API_KEY, // The secret key for security
        },
      }
    );
    console.log(`[Email Service] Successfully requested '${type}' email for ${payload.toEmail}`);
    return true;
  } catch (error) {
    console.error(`[Email Service] Error calling external email service for '${type}':`, error.response?.data || error.message);
    return false;
  }
}

// Your old functions now just prepare data and call the helper.
async function sendVerificationEmail(toEmail, verificationCode) {
  return sendEmailViaService('verification', { 
    toEmail, 
    verificationCode 
  });
}

async function sendLoggedOutReminder(toEmail, appName, botUsername, daysUntilDeletion) {
   return sendEmailViaService('logout_reminder', {
    toEmail,
    appName,
    botUsername,
    daysUntilDeletion,
  });
}

// In email_service.js of your main bot...

async function sendPaymentConfirmation(toEmail, userName, referenceId, appName, botType, sessionId) {
  return sendEmailViaService('payment_confirmation', {
    toEmail,
    userName,
    referenceId,
    appName,
    botType,
    sessionId,
  });
}


module.exports = {
  sendPaymentConfirmation,
  sendVerificationEmail,
  sendLoggedOutReminder,
};
