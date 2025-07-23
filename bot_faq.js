// bot_faq.js

// --- Module-level variables for dependencies passed during init ---
let moduleParams = {};

/**
 * Initializes the FAQ module.
 * @param {object} params - Object containing dependencies from bot.js.
 * @param {object} params.bot - The TelegramBot instance.
 * @param {object} params.userStates - The userStates object for managing bot interactions.
 * @param {function} params.escapeMarkdown - Utility function to escape markdown characters.
 */
function init(params) {
    moduleParams = params;
    console.log('--- bot_faq.js initialized! ---');
}

// --- FAQ Data ---
const FAQ_QUESTIONS = [
    {
        question: "How do I get a session ID?",
        answer: "Tap 'Get Session' and follow the prompts to provide your WhatsApp number for a pairing code. Alternatively, visit our website https://levanter-delta.vercel.app/ to generate one yourself."
    },
    {
        question: "What is a 'Deploy Key'?",
        answer: "A Deploy Key is a special code that authorizes you to use our service to deploy a bot. You might receive it from the admin."
    },
    {
        question: "How do I deploy my bot after getting a session ID and/or deploy key?",
        answer: "Tap 'Deploy', enter your Deploy Key (if required), then paste your session ID, and finally choose a unique name for your bot."
    },
    {
        question: "What is the 'Free Trial' option?",
        answer: "The Free Trial allows you to deploy a bot for 1 hour to test the service. You can use it once every 14 days."
    },
    {
        question: "My bot failed to deploy, what should I do?",
        answer: "Check the error message provided by the bot. Common issues are incorrect session IDs, app names already taken, or Heroku API issues. Try again, or contact support if the issue persists."
    },
    {
        question: "How can I see my deployed bots?",
        answer: "Tap the 'My Bots' button to see a list of all bots you have deployed through this service."
    },
    {
        question: "My bot is offline/logged out. How do I fix it?",
        answer: "This usually means your session ID is invalid. Go to 'My Bots', select your bot, then choose 'Set Variable' and update the SESSION_ID with a new one from https://levanter-delta.vercel.app/."
    },
    {
        question: "What do 'Restart', 'Logs', 'Redeploy' do?",
        answer: "Restart: Restarts your bot application on Heroku.\nLogs: Shows the recent activity and error logs of your bot, useful for debugging.\nRedeploy: Rebuilds and deploys your bot from the latest code on GitHub, useful for updates or fresh installs."
    },
    {
        question: "How do I change my bot's settings/variables like AUTO_STATUS_VIEW or PREFIX?",
        answer: "Go to 'My Bots', select your bot, then choose 'Set Variable'. You can then select common variables or 'Add/Set Other Variable' for any custom environment variables."
    },
    {
        question: "What is SUDO variable and how do I manage it?",
        answer: "SUDO lists the WhatsApp numbers that have administrative control over your bot. You can add or remove numbers using the 'Set Variable' -> 'SUDO' options."
    },
    {
        question: "How do I delete my bot?",
        answer: "Go to 'My Bots', select the bot, then tap 'Delete'. Be careful, this action is permanent!"
    },
    {
        question: "I have a question not covered here. How do I get help?",
        answer: "You can 'Ask Admin a Question' directly through the bot, or 'Contact Admin Directly' via Telegram using the button in the 'Support' menu."
    },
    {
        question: "What is the 'Contact Admin to Get Key Dashboard' button for?",
        answer: "This is for administrators or users looking to manage deploy keys or access admin-specific dashboards, usually for service providers."
    },
    {
        question: "Who is the admin?",
        answer: "The primary support contact is @star_ies1."
    },
    {
        question: "When will my bot expire?",
        answer: "This depends on your subscription plan. Please contact the admin for clarification regarding your specific bot's expiration."
    }
];

const FAQ_ITEMS_PER_PAGE = 5;

// Function to send a specific page of FAQs
async function sendFaqPage(chatId, messageId, page) {
    const { bot, userStates, escapeMarkdown } = moduleParams; // Destructure parameters from moduleParams

    const startIndex = (page - 1) * FAQ_ITEMS_PER_PAGE;
    const endIndex = startIndex + FAQ_ITEMS_PER_PAGE;
    const currentQuestions = FAQ_QUESTIONS.slice(startIndex, endIndex);

    let faqText = "";
    currentQuestions.forEach((faq, index) => {
        faqText += `*${startIndex + index + 1}. ${escapeMarkdown(faq.question)}*\n`;
        faqText += `${escapeMarkdown(faq.answer)}\n\n`;
    });

    const totalPages = Math.ceil(FAQ_QUESTIONS.length / FAQ_ITEMS_PER_PAGE);

    const keyboard = [];
    const navigationRow = [];

    if (page > 1) {
        navigationRow.push({ text: 'Back', callback_data: `faq_page:${page - 1}` });
    }
    if (page < totalPages) {
        navigationRow.push({ text: 'Next', callback_data: `faq_page:${page + 1}` });
    }
    if (navigationRow.length > 0) {
        keyboard.push(navigationRow);
    }

    keyboard.push([{ text: 'Back to Main Menu', callback_data: 'back_to_main_menu' }]);


    const options = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: keyboard
        }
    };

    // Initialize userStates for chatId if it doesn't exist
    if (!userStates[chatId]) {
        userStates[chatId] = {};
    }

    userStates[chatId].step = 'VIEWING_FAQ';
    userStates[chatId].faqPage = page;

    if (messageId && userStates[chatId].faqMessageId === messageId) {
        // Attempt to edit the existing message if ID matches the last sent FAQ message
        await bot.editMessageText(faqText, {
            chat_id: chatId,
            message_id: messageId,
            ...options
        }).catch(err => {
            console.error(`Error editing FAQ message ${messageId}: ${err.message}. Sending new message instead.`);
            // If message edit fails (e.g., message not found or too old), send new message
            bot.sendMessage(chatId, faqText, options).then(sentMsg => {
                userStates[chatId].faqMessageId = sentMsg.message_id; // Update to new message ID
            }).catch(sendErr => console.error(`Error sending new FAQ message after edit failure: ${sendErr.message}`));
        });
    } else {
        // Send a new message if no messageId is provided, or if the stored one doesn't match, or if it's the first time
        const sentMsg = await bot.sendMessage(chatId, faqText, options);
        userStates[chatId].faqMessageId = sentMsg.message_id;
    }
}

// Export the init function and the sendFaqPage for use in bot.js
module.exports = { init, sendFaqPage };
