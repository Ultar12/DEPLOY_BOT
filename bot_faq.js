// --- Module-level variables for dependencies passed during init ---
let moduleParams = {};

/**
 * Initializes the FAQ module.
 * @param {object} params - Object containing dependencies from bot.js.
 */
function init(params) {
    moduleParams = params;
    console.log('--- bot_faq.js initialized! ---');
}

// --- NEW FAQ Data ---
const FAQ_QUESTIONS = [
    // --- Section: Getting Started ---
    {
        question: "What does this bot do?",
        answer: "This service allows you to deploy, manage, and host your own personal WhatsApp bots directly from Telegram with just a few taps."
    },
    {
        question: "What's the difference between Levanter and Raganork?",
        answer: "They are two different types of WhatsApp bots with unique features.\n\n• *Levanter* is known for its stability and essential features.\n• *Raganork* often includes more advanced or experimental features.\n\nChoose the one that best fits your needs!"
    },
    {
        question: "How do I get a Session ID?",
        answer: "A Session ID is required to link the Bot to your WhatsApp account. In the main menu, tap 'Get Session ID' and select your bot type (Levanter or Raganork) to visit the correct website to generate your code. The ID format will start with `levanter_` or `RGNK~`."
    },
    {
        question: "What is a 'Deploy Key' and why do I need one?",
        answer: "A Deploy Key is a one-time code used to authorize a paid deployment. You can get a key by making a payment through the bot's menu. This allows us to provide a stable and reliable hosting service."
    },
    {
        question: "What is the 'Free Trial'?",
        answer: "The Free Trial lets you test our service by deploying a bot for a limited time. To access it, you must first join our support channel. You can only use the free trial once per cooldown period."
    },
    // --- Section: Managing Your Bot ---
    {
        question: "How can I see and manage my bots?",
        answer: "Tap the 'My Bots' button on the main menu or use our Mini App. This will show you a list of all your active bots, their status, and their expiration dates."
    },
    {
        question: "How do I change my bot's settings (Variables)?",
        answer: "Navigate to 'My Bots', select the bot you want to configure, and tap 'Set Variable'. This menu allows you to change your `SESSION_ID`, `PREFIX`, `SUDO` numbers, and other important settings."
    },
    {
        question: "What do 'Restart', 'Redeploy', and 'Delete' do?",
        answer: "• *Restart:* Turns your bot off and on again. This is the first thing to try if your bot is unresponsive.\n• *Redeploy:* Updates your bot with the latest source code, giving you new features or bug fixes without losing your settings.\n• *Delete:* Permanently removes your bot and all its data from our servers. This action cannot be undone."
    },
    {
        question: "What happens when my bot expires?",
        answer: "Your bot will be automatically stopped. You will have a grace period to renew it. After the grace period, if the bot is not renewed, it will be permanently deleted from our servers to free up resources."
    },
    // --- Section: Troubleshooting ---
    {
        question: "My bot is 'Logged Out' or 'Offline'. How do I fix it?",
        answer: "This is the most common issue and means your Session ID has expired. You must generate a new one.\n\n*Solution:* Go to 'My Bots' -> Select your bot -> 'Set Variable' -> 'SESSION_ID', and paste your new, valid Session ID.\n\n⚠️ *IMPORTANT:* A bot left in the 'Logged Out' state for more than **7 days** will be automatically deleted."
    },
    {
        question: "My bot failed to deploy. What should I do?",
        answer: "First, check the error message. Common reasons for failure are:\n1.  An app name that is already taken (it must be unique).\n2.  An invalid or expired Session ID.\n\nTry deploying again with a different name and a fresh Session ID."
    },
    {
        question: "Why does my bot sometimes go offline at the start of the month?",
        answer: "Our service performs routine maintenance at the beginning of each month to ensure everything runs smoothly. This can cause a brief, temporary downtime for some bots. They typically come back online automatically shortly after."
    },
    // --- Section: General ---
    {
        question: "How do Referrals work?",
        answer: "Tap the 'Referrals' button to get your unique invite link. When a friend uses your link to deploy their first paid bot, you will receive an extension on your own bot's subscription as a thank you!"
    },
    {
        question: "Is my data and Session ID safe?",
        answer: "Yes. Your configuration, including your Session ID, is stored securely. We do not share your data or have access to your WhatsApp messages."
    },
    {
        question: "I need more help. How do I contact support?",
        answer: "For any questions not covered here, please use the 'Support' button on the main menu. You can ask a question directly through the bot, and the admin will be notified. The admin's direct contact is @staries1."
    }
];

const FAQ_ITEMS_PER_PAGE = 5;

// Function to send a specific page of FAQs
async function sendFaqPage(chatId, messageId, page) {
    const { bot, userStates, escapeMarkdown } = moduleParams;

    const startIndex = (page - 1) * FAQ_ITEMS_PER_PAGE;
    const endIndex = startIndex + FAQ_ITEMS_PER_PAGE;
    const currentQuestions = FAQ_QUESTIONS.slice(startIndex, endIndex);

    let faqText = "*Frequently Asked Questions*\n\n";
    currentQuestions.forEach((faq, index) => {
        faqText += `*${startIndex + index + 1}. ${escapeMarkdown(faq.question)}*\n`;
        faqText += `_${escapeMarkdown(faq.answer)}_\n\n`;
    });

    const totalPages = Math.ceil(FAQ_QUESTIONS.length / FAQ_ITEMS_PER_PAGE);
    const keyboard = [];
    const navigationRow = [];

    if (page > 1) {
        navigationRow.push({ text: '« Previous', callback_data: `faq_page:${page - 1}` });
    }
    if (page < totalPages) {
        navigationRow.push({ text: 'Next »', callback_data: `faq_page:${page + 1}` });
    }
    if (navigationRow.length > 0) {
        keyboard.push(navigationRow);
    }
    keyboard.push([{ text: '« Back to Main Menu', callback_data: 'back_to_main_menu' }]);

    const options = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard }
    };

    if (!userStates[chatId]) {
        userStates[chatId] = {};
    }
    userStates[chatId].step = 'VIEWING_FAQ';
    userStates[chatId].faqPage = page;

    if (messageId && userStates[chatId].faqMessageId === messageId) {
        try {
            await bot.editMessageText(faqText, { chat_id: chatId, message_id: messageId, ...options });
        } catch (err) {
            console.error(`Error editing FAQ message ${messageId}: ${err.message}. Sending new message.`);
            const sentMsg = await bot.sendMessage(chatId, faqText, options);
            userStates[chatId].faqMessageId = sentMsg.message_id;
        }
    } else {
        const sentMsg = await bot.sendMessage(chatId, faqText, options);
        userStates[chatId].faqMessageId = sentMsg.message_id;
    }
}

// Export the init function and the sendFaqPage for use in bot.js
module.exports = { init, sendFaqPage };
