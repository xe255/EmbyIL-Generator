const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

// Initialize DB if not exists
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ 
        logs: [], 
        stats: { totalCreated: 0, activeUsers: 0 },
        chats: {},
        progress: {},
        accounts: {},
        userLimits: {},
        notifications: {}
    }, null, 2));
}

function getLogs() {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return data;
}

function addLog(chatId, username, action, status, result = null, userInfo = null) {
    const data = getLogs();
    const newLog = {
        id: Date.now(),
        timestamp: new Date().toLocaleString('he-IL'),
        chatId,
        username,
        action,
        status,
        result,
        userInfo: userInfo // Store full user info for Telegram links
    };
    data.logs.unshift(newLog); // Newest first

    // Update stats
    if (action === 'create_account' && status === 'success') {
        data.stats.totalCreated++;
    }

    // Simple active user count (unique chatIds)
    const uniqueUsers = new Set(data.logs.map(l => l.chatId));
    data.stats.activeUsers = uniqueUsers.size;

    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function addChatMessage(chatId, username, fromAdmin, message) {
    const data = getLogs();
    if (!data.chats) data.chats = {};
    if (!data.chats[chatId]) {
        data.chats[chatId] = {
            username: username,
            messages: []
        };
    }
    
    data.chats[chatId].messages.push({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        fromAdmin: fromAdmin,
        message: message
    });
    
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getChatMessages(chatId) {
    const data = getLogs();
    if (!data.chats || !data.chats[chatId]) return [];
    return data.chats[chatId].messages;
}

function getAllChats() {
    const data = getLogs();
    if (!data.chats) data.chats = {};
    
    // Get all unique users from logs
    const userMap = new Map();
    data.logs.forEach(log => {
        if (log.chatId && log.username && log.username !== 'ADMIN') {
            if (!userMap.has(log.chatId)) {
                // Use userInfo.username if available, otherwise use the username field (which is often the Telegram username)
                let telegramUsername = log.userInfo?.username || null;
                
                // If no userInfo but username exists and looks like a valid Telegram username
                // (lowercase, no spaces, not "Missing" or generic names)
                if (!telegramUsername && log.username && 
                    log.username !== 'Missing' && 
                    log.username !== 'Unknown' &&
                    !log.username.includes(' ') &&
                    log.username.length >= 5) {
                    telegramUsername = log.username;
                }
                
                userMap.set(log.chatId, {
                    username: log.username,
                    lastAction: log.timestamp,
                    action: log.action,
                    userInfo: log.userInfo || null,
                    telegramUsername: telegramUsername
                });
            }
        }
    });
    
    // Merge with existing chats
    userMap.forEach((userData, chatId) => {
        if (!data.chats[chatId]) {
            data.chats[chatId] = {
                username: userData.username,
                messages: [],
                lastAction: userData.lastAction,
                action: userData.action,
                userInfo: userData.userInfo,
                telegramUsername: userData.telegramUsername
            };
        } else {
            // Update username if needed
            data.chats[chatId].username = userData.username;
            data.chats[chatId].lastAction = userData.lastAction;
            if (userData.telegramUsername) {
                data.chats[chatId].telegramUsername = userData.telegramUsername;
            }
            if (userData.userInfo) {
                data.chats[chatId].userInfo = userData.userInfo;
            }
        }
    });
    
    return data.chats;
}

function updateProgress(chatId, progress, message) {
    const data = getLogs();
    if (!data.progress) data.progress = {};
    
    data.progress[chatId] = {
        progress: progress,
        message: message,
        timestamp: new Date().toISOString()
    };
    
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getProgress(chatId) {
    const data = getLogs();
    if (!data.progress || !data.progress[chatId]) return null;
    return data.progress[chatId];
}

function clearProgress(chatId) {
    const data = getLogs();
    if (data.progress && data.progress[chatId]) {
        delete data.progress[chatId];
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
}

function addAccount(chatId, username, accountData) {
    const data = getLogs();
    if (!data.accounts) data.accounts = {};
    if (!data.accounts[chatId]) data.accounts[chatId] = [];
    
    const account = {
        id: Date.now(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
        accountEmail: accountData.accountEmail,
        embyUsername: accountData.embyUsername,
        active: true,
        notificationSent: false
    };
    
    data.accounts[chatId].push(account);
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    
    return account;
}

function getUserAccounts(chatId) {
    const data = getLogs();
    if (!data.accounts || !data.accounts[chatId]) return [];
    return data.accounts[chatId];
}

function getAccountCount(chatId) {
    const accounts = getUserAccounts(chatId);
    return accounts.filter(acc => acc.active).length;
}

function canCreateAccount(chatId) {
    const MAX_ACCOUNTS = 3; // Maximum accounts per user
    const COOLDOWN_MINUTES = 5; // Cooldown between creations
    
    const data = getLogs();
    if (!data.userLimits) data.userLimits = {};
    
    const userLimit = data.userLimits[chatId];
    const accountCount = getAccountCount(chatId);
    
    // Check max accounts limit
    if (accountCount >= MAX_ACCOUNTS) {
        return { 
            allowed: false, 
            reason: 'max_accounts',
            message: `הגעת למגבלת ${MAX_ACCOUNTS} חשבונות. אנא המתן שחשבון קיים יפוג.`
        };
    }
    
    // Check cooldown
    if (userLimit && userLimit.lastCreated) {
        const lastCreated = new Date(userLimit.lastCreated);
        const now = new Date();
        const diffMinutes = (now - lastCreated) / (1000 * 60);
        
        if (diffMinutes < COOLDOWN_MINUTES) {
            const remainingMinutes = Math.ceil(COOLDOWN_MINUTES - diffMinutes);
            return {
                allowed: false,
                reason: 'cooldown',
                message: `אנא המתן ${remainingMinutes} דקות לפני יצירת חשבון נוסף.`
            };
        }
    }
    
    return { allowed: true };
}

function updateUserLimit(chatId) {
    const data = getLogs();
    if (!data.userLimits) data.userLimits = {};
    
    data.userLimits[chatId] = {
        lastCreated: new Date().toISOString()
    };
    
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function getExpiringAccounts() {
    const data = getLogs();
    if (!data.accounts) return [];
    
    const now = new Date();
    const expiringAccounts = [];
    
    Object.keys(data.accounts).forEach(chatId => {
        data.accounts[chatId].forEach(account => {
            if (!account.active) return;
            
            const expiresAt = new Date(account.expiresAt);
            const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
            
            // Notify 24 hours before expiry
            if (hoursUntilExpiry <= 24 && hoursUntilExpiry > 0 && !account.notificationSent) {
                expiringAccounts.push({
                    chatId: chatId,
                    account: account,
                    hoursRemaining: Math.floor(hoursUntilExpiry)
                });
            }
            
            // Mark as inactive if expired
            if (hoursUntilExpiry <= 0) {
                account.active = false;
            }
        });
    });
    
    if (expiringAccounts.length > 0 || Object.keys(data.accounts).some(chatId => 
        data.accounts[chatId].some(acc => !acc.active && acc.active !== false))) {
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
    
    return expiringAccounts;
}

function markNotificationSent(chatId, accountId) {
    const data = getLogs();
    if (!data.accounts || !data.accounts[chatId]) return;
    
    const account = data.accounts[chatId].find(acc => acc.id === accountId);
    if (account) {
        account.notificationSent = true;
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
}

module.exports = { 
    getLogs, 
    addLog, 
    addChatMessage, 
    getChatMessages, 
    getAllChats,
    updateProgress,
    getProgress,
    clearProgress,
    addAccount,
    getUserAccounts,
    getAccountCount,
    canCreateAccount,
    updateUserLimit,
    getExpiringAccounts,
    markNotificationSent
};
