// public/script.js

// --- Configuration ---
let BACKEND_BASE_URL = localStorage.getItem('backendUrl') || '';
// --- End Configuration ---

let currentUserId = localStorage.getItem('telegramUserId');
let currentManagedBotName = '';

document.addEventListener('DOMContentLoaded', () => {
    const backendUrlInput = document.getElementById('backendUrl');
    backendUrlInput.value = BACKEND_BASE_URL;

    const userIdInput = document.getElementById('telegramUserId');
    userIdInput.value = currentUserId; // Set input value if already saved

    // Check if both are present to decide initial view
    if (BACKEND_BASE_URL && currentUserId) {
        showMainMenu();
    } else {
        // Ensure initial setup fields are visible if data is missing
        document.getElementById('initial-setup-fields').style.display = 'block';
        document.getElementById('main-menu').style.display = 'none';
        document.getElementById('content-sections').style.display = 'none'; // Hide content sections initially

        if (!BACKEND_BASE_URL) {
            backendUrlInput.focus();
        } else {
            userIdInput.focus();
        }
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
        checkAndShowMainMenu(); // Check if user ID is also present
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
        checkAndShowMainMenu(); // Check if backend URL is also present
    } else {
        showAlert('Please enter your Telegram User ID.', 'error');
    }
}

// New function to check both fields and show main menu
function checkAndShowMainMenu() {
    if (BACKEND_BASE_URL && currentUserId) {
        showMainMenu();
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
    document.getElementById('initial-setup-fields').style.display = 'none'; // Hide setup fields
    document.getElementById('main-menu').style.display = 'block'; // Show main menu
    document.getElementById('content-sections').style.display = 'block'; // Show content container
    showSection('deploy-section'); // Default to deploy section when main menu appears
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
    if (!deployKey && !document.getElementById('deployKey').disabled) {
        showAlert('Deploy Key is required for this deployment type.', 'error');
        return;
    }


    showAlert('Initiating deployment...', 'info');

    try {
        const data = await makeApiRequest('/api/deployBot', 'POST', {
            userId: currentUserId, sessionId, appName, deployKey, isFreeTrial: false, autoStatusView
        });
        showAlert(data.message || 'Bot deployment initiated! Check your Telegram for updates.', 'success');
        document.getElementById('deploy-form').reset();
        fetchMyBots();
        showSection('my-bots-section');
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
// public/script.js

// --- Configuration ---
let BACKEND_BASE_URL = localStorage.getItem('backendUrl') || '';
// --- End Configuration ---

let currentUserId = localStorage.getItem('telegramUserId');
let currentManagedBotName = '';

document.addEventListener('DOMContentLoaded', () => {
    const backendUrlInput = document.getElementById('backendUrl');
    backendUrlInput.value = BACKEND_BASE_URL;

    const userIdInput = document.getElementById('telegramUserId');
    userIdInput.value = currentUserId;

    // Get references to the main sections
    const initialSetupFields = document.getElementById('initial-setup-fields');
    const mainMenu = document.getElementById('main-menu');
    const contentSections = document.getElementById('content-sections');

    // On page load, determine which view to show
    if (BACKEND_BASE_URL && currentUserId) {
        // If both are present, show the main menu and hide setup fields
        initialSetupFields.style.display = 'none';
        mainMenu.style.display = 'block';
        contentSections.style.display = 'block';
        showSection('deploy-section'); // Default to deploy section
    } else {
        // If either is missing, show the setup fields and hide main menu/content
        initialSetupFields.style.display = 'block';
        mainMenu.style.display = 'none';
        contentSections.style.display = 'none';

        if (!BACKEND_BASE_URL) {
            backendUrlInput.focus();
        } else {
            userIdInput.focus();
        }
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
        checkAndShowMainMenu();
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
        checkAndShowMainMenu();
    } else {
        showAlert('Please enter your Telegram User ID.', 'error');
    }
}

function checkAndShowMainMenu() {
    const initialSetupFields = document.getElementById('initial-setup-fields');
    const mainMenu = document.getElementById('main-menu');
    const contentSections = document.getElementById('content-sections');

    if (BACKEND_BASE_URL && currentUserId) {
        initialSetupFields.style.display = 'none';
        mainMenu.style.display = 'block';
        contentSections.style.display = 'block';
        showSection('deploy-section'); // Default to deploy section when main menu appears
    }
}

function showSection(sectionId) {
    document.querySelectorAll('.content-section').forEach(section => {
        section.style.display = 'none';
    });

    document.getElementById(sectionId).style.display = 'block';

    if (sectionId === 'my-bots-section') {
        fetchMyBots();
    } else if (sectionId === 'free-trial-section') {
        checkFreeTrialStatus();
    }
}

function showMainMenu() {
    // This function is now mostly handled by checkAndShowMainMenu, but keeps existing UI logic if called directly
    document.getElementById('initial-setup-fields').style.display = 'none';
    document.getElementById('main-menu').style.display = 'block';
    document.getElementById('content-sections').style.display = 'block';
    showSection('deploy-section');
}

function backToMenu() {
    showSection('deploy-section');
}

function backToMyBots() {
    showSection('my-bots-section');
}

function showAlert(message, type) {
    const alertContainer = document.getElementById('alert-container');
    alertContainer.innerHTML = `<div class="alert-message alert-${type}">${message}</div>`;
    setTimeout(() => {
        alertContainer.innerHTML = '';
    }, 7000);
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

    if (!sessionId || sessionId.length < 10) {
        showAlert('Session ID must be at least 10 characters long.', 'error');
        return;
    }
    if (!appName || appName.length < 5 || !/^[a-z0-9-]+$/.test(appName)) {
        showAlert('App Name must be at least 5 lowercase letters, numbers, and hyphens only.', 'error');
        return;
    }
    if (!deployKey && !document.getElementById('deployKey').disabled) {
        showAlert('Deploy Key is required for this deployment type.', 'error');
        return;
    }

    showAlert('Initiating deployment...', 'info');

    try {
        const data = await makeApiRequest('/api/deployBot', 'POST', {
            userId: currentUserId, sessionId, appName, deployKey, isFreeTrial: false, autoStatusView
        });
        showAlert(data.message || 'Bot deployment initiated! Check your Telegram for updates.', 'success');
        document.getElementById('deploy-form').reset();
        fetchMyBots();
        showSection('my-bots-section');
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
        setTimeout(() => showBotManagement(currentManagedBotName), 5000); // Refresh info after 5 sec
    } catch (error) {
        console.error('Error restarting bot:', error);
        showAlert(`❌ Error: ${error.message}`, 'error');
    }
}

