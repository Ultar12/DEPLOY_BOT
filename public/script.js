// public/script.js

// --- Configuration ---
// IMPORTANT: This will now point to your main Heroku/Render app URL
// (e.g., https://your-heroku-app.herokuapp.com or https://your-render-app.onrender.com)
let BACKEND_BASE_URL = localStorage.getItem('backendUrl') || '';
// --- End Configuration ---

let currentUserId = localStorage.getItem('telegramUserId');
let currentManagedBotName = ''; // To store the bot name when managing a single bot

document.addEventListener('DOMContentLoaded', () => {
    const backendUrlInput = document.getElementById('backendUrl');
    backendUrlInput.value = BACKEND_BASE_URL;

    const userIdInput = document.getElementById('telegramUserId');
    if (currentUserId) {
        userIdInput.value = currentUserId;
        showMainMenu();
    } else {
        userIdInput.focus();
    }

    // Add event listeners for forms
    document.getElementById('deploy-form').addEventListener('submit', handleDeployFormSubmit);
    document.getElementById('free-trial-form').addEventListener('submit', handleFreeTrialFormSubmit);
});

function saveBackendUrl() {
    const backendUrlInput = document.getElementById('backendUrl');
    const newUrl = backendUrlInput.value.trim();
    if (newUrl && (newUrl.startsWith('http://') || newUrl.startsWith('https://'))) {
        BACKEND_BASE_URL = newUrl;
        localStorage.setItem('backendUrl', newUrl);
        showAlert('Backend URL saved!', 'success');
        // If URL saved, and user ID exists, show main menu
        if (currentUserId) {
            showMainMenu();
        }
    } else {
        showAlert('Please enter a valid backend URL starting with http:// or https://', 'error');
    }
}

function saveUserId() {
    const userIdInput = document.getElementById('telegramUserId');
    const newUserId = userIdInput.value.trim();
    if (newUserId) {
        currentUserId = newUserId;
        localStorage.setItem('telegramUserId', newUserId);
        showAlert('Telegram User ID saved!', 'success');
        // If user ID saved, and backend URL exists, show main menu
        if (BACKEND_BASE_URL) {
            showMainMenu();
        }
    } else {
        showAlert('Please enter your Telegram User ID.', 'error');
    }
}

function showSection(sectionId) {
    // Hide all content sections first
    document.querySelectorAll('.content-section').forEach(section => {
        section.style.display = 'none';
    });

    // Show the requested section
    document.getElementById(sectionId).style.display = 'block';

    // Perform specific actions for sections
    if (sectionId === 'my-bots-section') {
        fetchMyBots();
    } else if (sectionId === 'free-trial-section') {
        checkFreeTrialStatus();
    }
}

function showMainMenu() {
    // Hide ID input and backend URL setting
    document.getElementById('user-id-section').style.display = 'none';
    document.getElementById('backend-url-setting').style.display = 'none';
    document.getElementById('main-menu').style.display = 'block'; // Show main menu
    showSection('deploy-section'); // Default to deploy section or welcome
}

function backToMenu() {
    showSection('deploy-section'); // Go back to default deploy section
}

function backToMyBots() {
    showSection('my-bots-section');
}

function showAlert(message, type) {
    const alertContainer = document.getElementById('alert-container');
    alertContainer.innerHTML = `<div class="alert-message alert-${type}">${message}</div>`;
    setTimeout(() => {
        alertContainer.innerHTML = '';
    }, 7000); // Remove alert after 7 seconds
}

async function makeApiRequest(endpoint, method = 'GET', data = null) {
    if (!BACKEND_BASE_URL) {
        showAlert('Backend URL is not set. Please configure it.', 'error');
        throw new Error('Backend URL not set');
    }
    const url = `${BACKEND_BASE_URL}${endpoint}`;
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
    };
    if (data) {
        options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    const json = await response.json();

    if (!response.ok) {
        throw new Error(json.error || 'Something went wrong');
    }
    return json;
}

async function getWhatsAppSession() {
    if (!currentUserId) {
        showAlert('Please save your Telegram User ID first.', 'error');
        return;
    }
    try {
        const data = await makeApiRequest('/api/getSession', 'POST', { userId: currentUserId });
        showAlert(data.message, 'success');
    } catch (error) {
        console.error('Error fetching session:', error);
        showAlert(`Error: ${error.message}`, 'error');
    }
}

async function handleDeployFormSubmit(event) {
    event.preventDefault();
    if (!currentUserId) {
        showAlert('Please save your Telegram User ID first.', 'error');
        return;
    }

    const sessionId = document.getElementById('deploySessionId').value.trim();
    const appName = document.getElementById('deployAppName').value.trim();
    const deployKey = document.getElementById('deployKey').value.trim();
    const autoStatusView = document.getElementById('autoStatusView').value === 'true';

    // Basic client-side validation
    if (!sessionId || sessionId.length < 10) {
        showAlert('Session ID must be at least 10 characters long.', 'error');
        return;
    }
    if (!appName || appName.length < 5 || !/^[a-z0-9-]+$/.test(appName)) {
        showAlert('App Name must be at least 5 lowercase letters, numbers, and hyphens only.', 'error');
        return;
    }
    if (!deployKey && !document.getElementById('deployKey').disabled) { // Ensure deployKey is required unless disabled (e.g. for free trial)
        showAlert('Deploy Key is required for this deployment type.', 'error');
        return;
    }


    showAlert('Initiating deployment...', 'info');

    try {
        const data = await makeApiRequest('/api/deployBot', 'POST', {
            userId: currentUserId, sessionId, appName, deployKey, isFreeTrial: false, autoStatusView
        });
        showAlert(data.message || 'Bot deployment initiated! Check your Telegram for updates.', 'success');
        document.getElementById('deploy-form').reset(); // Clear form
        fetchMyBots(); // Refresh bot list
        showSection('my-bots-section'); // Show my bots list
    } catch (error) {
        console.error('Error deploying bot:', error);
        showAlert(`Error: ${error.message}`, 'error');
    }
}

async function checkFreeTrialStatus() {
    if (!currentUserId) {
        document.getElementById('free-trial-status-text').innerText = 'Please save your Telegram User ID first.';
        return;
    }
    try {
        const data = await makeApiRequest(`/api/freeTrialStatus/${currentUserId}`);
        const statusText = document.getElementById('free-trial-status-text');
        const freeTrialForm = document.getElementById('free-trial-form');

        if (data.can) {
            statusText.innerText = 'You are eligible for a Free Trial! (1 Hour Runtime, 14-day cooldown)';
            freeTrialForm.style.display = 'block';
        } else {
            const cooldownDate = new Date(data.cooldown);
            const formattedCooldown = cooldownDate.toLocaleString('en-US', {
                year: 'numeric', month: 'short', day: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                timeZoneName: 'short'
            });
            statusText.innerText = `You have used your Free Trial. You can use it again after: ${formattedCooldown}.`;
            freeTrialForm.style.display = 'none';
        }
    } catch (error) {
        console.error('Error checking free trial status:', error);
        showAlert('Failed to check Free Trial status.', 'error');
        document.getElementById('free-trial-status-text').innerText = 'Error checking Free Trial status.';
    }
}

async function handleFreeTrialFormSubmit(event) {
    event.preventDefault();
    if (!currentUserId) {
        showAlert('Please save your Telegram User ID first.', 'error');
        return;
    }

    const sessionId = document.getElementById('freeTrialSessionId').value.trim();
    const appName = document.getElementById('freeTrialAppName').value.trim();
    const autoStatusView = document.getElementById('freeTrialAutoStatusView').value === 'true';

    // Basic client-side validation
    if (!sessionId || sessionId.length < 10) {
        showAlert('Session ID must be at least 10 characters long.', 'error');
        return;
    }
    if (!appName || appName.length < 5 || !/^[a-z0-9-]+$/.test(appName)) {
        showAlert('App Name must be at least 5 lowercase letters, numbers, and hyphens only.', 'error');
        return;
    }

    showAlert('Initiating Free Trial deployment...', 'info');

    try {
        const data = await makeApiRequest('/api/deployBot', 'POST', {
            userId: currentUserId, sessionId, appName, isFreeTrial: true, autoStatusView
        });
        showAlert(data.message || 'Free Trial bot deployment initiated! Check your Telegram for updates.', 'success');
        document.getElementById('free-trial-form').reset();
        fetchMyBots();
        showSection('my-bots-section');
    } catch (error) {
        console.error('Error deploying free trial bot:', error);
        showAlert(`Error: ${error.message}`, 'error');
    }
}

async function fetchMyBots() {
    if (!currentUserId) {
        document.getElementById('my-bots-list').innerHTML = '<li><p>Please save your Telegram User ID first.</p></li>';
        return;
    }
    try {
        const bots = await makeApiRequest(`/api/myBots/${currentUserId}`);
        const botList = document.getElementById('my-bots-list');
        botList.innerHTML = ''; // Clear existing list

        if (bots.length === 0) {
            botList.innerHTML = '<li><p>You have not deployed any bots yet.</p></li>';
            return;
        }

        bots.forEach(botName => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span><strong>${botName}</strong></span>
                <button onclick="showBotManagement('${botName}')">Manage</button>
            `;
            botList.appendChild(li);
        });
    } catch (error) {
        console.error('Error fetching my bots:', error);
        showAlert('Error loading your bots.', 'error');
        document.getElementById('my-bots-list').innerHTML = '<li><p>Error loading your bots.</p></li>';
    }
}

async function showBotManagement(botName) {
    currentManagedBotName = botName;
    document.getElementById('single-bot-name').innerText = `Manage Bot: ${botName}`;
    document.getElementById('single-bot-info').innerHTML = 'Loading info...';
    showSection('single-bot-management-section');

    try {
        const data = await makeApiRequest(`/api/appInfo/${botName}`);
        let dynoStatusEmoji = '⚪️';
        if (data.dynoStatus === 'up') dynoStatusEmoji = '🟢';
        else if (data.dynoStatus === 'crashed') dynoStatusEmoji = '🔴';
        else if (data.dynoStatus === 'idle') dynoStatusEmoji = '🟡';
        else if (data.dynoStatus === 'starting' || data.dynoStatus === 'restarting') dynoStatusEmoji = '⏳';

        const createdAt = new Date(data.createdAt).toLocaleString();
        const releasedAt = new Date(data.releasedAt).toLocaleString();

        document.getElementById('single-bot-info').innerHTML = `
            <strong>Dyno Status:</strong> ${dynoStatusEmoji} ${data.dynoStatus}<br>
            <strong>Created:</strong> ${createdAt}<br>
            <strong>Last Release:</strong> ${releasedAt}<br>
            <strong>Stack:</strong> ${data.stack}<br>
            <strong>SESSION_ID Set:</strong> ${data.sessionIdSet ? '✅ Yes' : '❌ No'}<br>
            <strong>AUTO_STATUS_VIEW:</strong> ${data.autoStatusView}<br>
        `;
    } catch (error) {
        console.error('Error fetching single bot info:', error);
        document.getElementById('single-bot-info').innerText = `Failed to load bot information: ${error.message}`;
        showAlert(`Failed to load bot info: ${error.message}`, 'error');
    }
}

async function restartBotFromWeb() {
    if (!currentManagedBotName) {
        showAlert('No bot selected for restart.', 'error');
        return;
    }
    if (!confirm(`Are you sure you want to restart ${currentManagedBotName}?`)) {
        return;
    }
    showAlert(`Requesting restart for ${currentManagedBotName}...`, 'info');
    try {
        const data = await makeApiRequest('/api/restart-bot', 'POST', { botName: currentManagedBotName });
        showAlert(`✅ ${data.message}`, 'success');
        // Optionally refresh info after a delay to see new status
        setTimeout(() => showBotManagement(currentManagedBotName), 5000);
    } catch (error) {
        console.error('Error restarting bot:', error);
        showAlert(`❌ Error: ${error.message}`, 'error');
    }
}
