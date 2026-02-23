// Load environment variables
require('dotenv').config();

const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const { run } = require('./embyil/index');
const { 
    addLog, 
    getLogs, 
    addChatMessage, 
    getAllChats, 
    updateProgress, 
    clearProgress,
    addAccount,
    getUserAccounts,
    getAccountCount,
    canCreateAccount,
    updateUserLimit,
    getExpiringAccounts,
    markNotificationSent,
    getBlacklist,
    addToBlacklist,
    removeFromBlacklist,
    isBlacklisted,
    getStats,
    getAllUsers
} = require('./database');

// --- Configuration ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;

// Validate required environment variables
if (!token) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in .env file');
    process.exit(1);
}

// --- Initialize Bot ---
const bot = new TelegramBot(token, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// Handle polling errors gracefully
bot.on('polling_error', (error) => {
    // Ignore old callback query errors - these happen when bot restarts
    if (error.code === 'ETELEGRAM') {
        if (error.message.includes('query is too old') || 
            error.message.includes('query ID is invalid')) {
            console.log('⚠️  Ignoring stale callback query (bot was restarted)');
            return;
        }
    }
    // Log other errors but don't crash
    console.error('❌ Polling error:', error.message);
});

// Catch unhandled errors to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
    if (reason && reason.code === 'ETELEGRAM' && reason.message.includes('query is too old')) {
        console.log('⚠️  Caught stale callback query');
        return;
    }
    console.error('Unhandled Rejection:', reason);
});

// Store WebSocket clients
let wsClients = [];

// Expiry notification checker - runs every hour
setInterval(async () => {
    try {
        const expiringAccounts = getExpiringAccounts();
        
        for (const item of expiringAccounts) {
            const { chatId, account, hoursRemaining } = item;
            
            const message = `
⚠️ <b>תזכורת: החשבון שלך עומד לפוג!</b>

━━━━━━━━━━━━━━━━━━━━

👤 <b>שם משתמש:</b> <code>${account.embyUsername}</code>
⏰ <b>זמן נותר:</b> ${hoursRemaining} שעות

━━━━━━━━━━━━━━━━━━━━

💡 אם תרצה להמשיך ליהנות מהשירות, צור חשבון חדש לפני שהנוכחי יפוג!
            `;
            
            try {
                await bot.sendMessage(chatId, message, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔄 צור חשבון נוסף', callback_data: 'create_account' }]
                        ]
                    }
                });
                
                markNotificationSent(chatId, account.id);
            } catch (error) {
                console.error(`Failed to send notification to ${chatId}:`, error.message);
            }
        }
    } catch (error) {
        console.error('Error in expiry checker:', error);
    }
}, 60 * 60 * 1000); // Check every hour

// Function to escape HTML special characters
function escapeHTML(str) {
    if (!str) return '';
    return str.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper to broadcast to all WebSocket clients
function broadcastToClients(data) {
    wsClients.forEach(client => {
        try {
            client.send(JSON.stringify(data));
        } catch (e) {
            console.error('Error broadcasting to client:', e);
        }
    });
}

// Admin Chat IDs - Loaded from environment variables. Use ADMIN_CHAT_IDS (comma-separated) for multiple admins, or ADMIN_CHAT_ID for single.
const parseAdminIds = () => {
    if (process.env.ADMIN_CHAT_IDS) {
        return process.env.ADMIN_CHAT_IDS.split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n));
    }
    const single = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID) : null;
    return single !== null ? [single] : [];
};
const ADMIN_CHAT_IDS_ARRAY = parseAdminIds();
const ADMIN_CHAT_ID = ADMIN_CHAT_IDS_ARRAY[0] ?? null; // backward compat for getid message etc.

// Required group: users must be members to use the bot. Bot must be added to the group; get ID with /getgroupid in the group.
const REQUIRED_GROUP_ID = process.env.REQUIRED_GROUP_ID ? process.env.REQUIRED_GROUP_ID.trim() : null;
const REQUIRED_GROUP_INVITE = process.env.REQUIRED_GROUP_INVITE || 'https://t.me/+F7ywFh8iVpVjODBk';

// Admin config (minimal log for Zeabur)
if (ADMIN_CHAT_IDS_ARRAY.length === 0) console.warn('ADMIN_CHAT_ID or ADMIN_CHAT_IDS not set');

// Notify all admins (e.g. new user / new account alerts). Silently skip if no admins or send fails.
async function notifyAdmins(message, options = { parse_mode: 'HTML' }) {
    for (const adminId of ADMIN_CHAT_IDS_ARRAY) {
        try {
            await bot.sendMessage(adminId, message, options);
        } catch (e) {
            console.error(`Failed to notify admin ${adminId}:`, e.message);
        }
    }
}

// Helper: format last activity for display (handles invalid/missing or he-IL locale timestamps)
function formatLastActivity(timestamp) {
    if (timestamp === undefined || timestamp === null || timestamp === '') return 'לא ידוע';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return 'לא ידוע';
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return 'עכשיו';
    if (diffMins < 60) return `לפני ${diffMins} דקות`;
    if (diffHours < 24) return `לפני ${diffHours} שעות`;
    if (diffDays < 7) return `לפני ${diffDays} ימים`;
    try {
        return date.toLocaleString('he-IL');
    } catch (e) {
        return date.toISOString ? date.toISOString().slice(0, 10) : 'לא ידוע';
    }
}

// Help Command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
        return;
    }
    if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
        await sendJoinRequiredMessage(chatId);
        return;
    }
    const isAdminUser = isAdmin(chatId);
    
    let helpMessage = `
ℹ️ <b>עזרה - EmbyIL Bot</b>

━━━━━━━━━━━━━━━━━━━━
📋 <b>פקודות זמינות:</b>

/start - התחל שיחה עם הבוט
/help - הצג הודעת עזרה זו
/getid - הצג את פרטי המשתמש שלך
━━━━━━━━━━━━━━━━━━━━

<b>איך להשתמש בבוט:</b>
1️⃣ לחץ על "צור חשבון" ב-/start
2️⃣ המתן בזמן שהבוט יוצר את החשבון
3️⃣ קבל את פרטי ההתחברות
4️⃣ השתמש בחשבון ב-Emby

<b>מגבלות:</b>
• עד 3 חשבונות פעילים בו-זמנית
• כל חשבון תקף ל-3 ימים
• לאחר תפוגת חשבון, אפשר ליצור חדש

<b>תמיכה טכנית:</b>
אם נתקלת בבעיה, פנה למנהל הבוט.
    `;
    
    if (isAdminUser) {
        helpMessage += `
━━━━━━━━━━━━━━━━━━━━
🔐 <b>פקודות אדמין:</b>

/admin - פאנל אדמין
/stats - סטטיסטיקות מערכת
/users - רשימת משתמשים
/blacklist - רשימה שחורה
/accounts - סטטוס חשבונות
/broadcast - שידור הודעה

<b>פאנל האדמין כולל:</b>
• צפייה בסטטיסטיקות
• ניהול משתמשים
• חסימת משתמשים
• שידור הודעות
• מעקב אחר חשבונות
━━━━━━━━━━━━━━━━━━━━
        `;
    }
    
    helpMessage += `
<b>קישורים שימושיים:</b>
🎬 Emby Player: https://play.embyil.tv/

<i>בוט EmbyIL - יצירת חשבונות Emby אוטומטית</i>
    `;
    
    await bot.sendMessage(chatId, helpMessage, { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
});

// Debug command to get your chat ID
bot.onText(/\/getid/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
        return;
    }
    if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
        await sendJoinRequiredMessage(chatId);
        return;
    }
    const username = msg.from.username || msg.from.first_name || 'Unknown';
    
    const message = `
🆔 <b>Your Telegram Info</b>

━━━━━━━━━━━━━━━━━━━━
👤 <b>Name:</b> ${msg.from.first_name} ${msg.from.last_name || ''}
🆔 <b>Chat ID:</b> <code>${chatId}</code>
📱 <b>Username:</b> @${username}
━━━━━━━━━━━━━━━━━━━━

<b>To set as admin in Zeabur:</b>
1. Go to your Zeabur project
2. Click on Variables/Environment
3. Set: ADMIN_CHAT_ID = <code>${chatId}</code>
4. Redeploy the service

<b>Admin IDs:</b> ${ADMIN_CHAT_IDS_ARRAY.length ? ADMIN_CHAT_IDS_ARRAY.join(', ') : 'Not Set ❌'}
<b>Are you admin?</b> ${isAdmin(chatId) ? '✅ YES' : '❌ NO'}
    `;
    
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Get group ID (admin only, run inside the required group to get REQUIRED_GROUP_ID for .env)
bot.onText(/\/getgroupid/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const type = msg.chat.type;
    if (type !== 'group' && type !== 'supergroup') {
        await bot.sendMessage(chatId, '❌ שלח את הפקודה הזו מתוך הקבוצה שאתה רוצה לחייב הצטרפות אליה.');
        return;
    }
    const groupId = msg.chat.id.toString();
    await bot.sendMessage(chatId, `✅ <b>Group ID:</b> <code>${groupId}</code>\n\nהוסף ל-.env:\nREQUIRED_GROUP_ID=${groupId}\nREQUIRED_GROUP_INVITE=https://t.me/+F7ywFh8iVpVjODBk`, { parse_mode: 'HTML' });
});

// Admin Panel Command
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, '⛔ אין לך הרשאות גישה לפאנל האדמין.');
        return;
    }
    
    const adminMenu = `
🔐 <b>פאנל אדמין - EmbyIL Bot</b>

ברוך הבא לפאנל הניהול!
בחר פעולה מהתפריט למטה:

━━━━━━━━━━━━━━━━━━━━
📊 <b>פקודות זמינות:</b>

/stats - סטטיסטיקות מערכת
/users - רשימת משתמשים
/broadcast - שידור הודעה
/blacklist - רשימה שחורה
/accounts - סטטוס חשבונות
━━━━━━━━━━━━━━━━━━━━
    `;
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '📊 סטטיסטיקות', callback_data: 'admin_stats' },
                { text: '👥 משתמשים', callback_data: 'admin_users' }
            ],
            [
                { text: '📢 שידור הודעה', callback_data: 'admin_broadcast' },
                { text: '💼 חשבונות', callback_data: 'admin_accounts' }
            ],
            [
                { text: '🚫 חסומים', callback_data: 'admin_blacklist' }
            ]
        ]
    };
    
    await bot.sendMessage(chatId, adminMenu, {
        parse_mode: 'HTML',
        reply_markup: keyboard
    });
});

// Stats Command
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, '⛔ אין לך הרשאות.');
        return;
    }
    
    const stats = getStats();
    
    const statsMessage = `
📊 <b>סטטיסטיקות מערכת</b>

━━━━━━━━━━━━━━━━━━━━
📈 <b>נתונים כלליים:</b>
👥 סה"כ משתמשים: <b>${stats.totalUsers}</b>
💼 חשבונות שנוצרו: <b>${stats.totalAccountsCreated}</b>
✅ חשבונות פעילים: <b>${stats.activeAccounts}</b>
📊 אחוז הצלחה: <b>${stats.successRate}%</b>
🚫 משתמשים חסומים: <b>${stats.blacklistedUsers}</b>

━━━━━━━━━━━━━━━━━━━━
📅 <b>24 שעות אחרונות:</b>
👤 משתמשים פעילים: <b>${stats.users24h}</b>
🆕 חשבונות חדשים: <b>${stats.accounts24h}</b>

━━━━━━━━━━━━━━━━━━━━
📅 <b>7 ימים אחרונים:</b>
👤 משתמשים פעילים: <b>${stats.users7d}</b>
🆕 חשבונות חדשים: <b>${stats.accounts7d}</b>

━━━━━━━━━━━━━━━━━━━━
<i>עודכן: ${new Date().toLocaleString('he-IL')}</i>
    `;
    
    await bot.sendMessage(chatId, statsMessage, { parse_mode: 'HTML' });
});

// Users Command
bot.onText(/\/users/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, '⛔ אין לך הרשאות.');
        return;
    }
    
    const users = getAllUsers();
    
    if (users.length === 0) {
        await bot.sendMessage(chatId, '❌ אין משתמשים במערכת.');
        return;
    }
    
    let message = `👥 <b>רשימת משתמשים (${users.length})</b>\n\n`;
    
    users.forEach((user, index) => {
        const displayName = user.firstName + (user.lastName ? ' ' + user.lastName : '');
        const blacklistIcon = user.isBlacklisted ? '🚫 ' : '✅ ';
        const accountsInfo = `(${user.activeAccounts}/${user.accountCount})`;
        const lastActive = formatLastActivity(user.lastAction);
        
        message += `${index + 1}. ${blacklistIcon}${displayName} ${accountsInfo}\n`;
        message += `   ID: <code>${user.chatId}</code>\n`;
        if (user.telegramUsername) {
            message += `   @${user.telegramUsername}\n`;
        }
        message += `   📅 פעילות אחרונה: ${lastActive}\n\n`;
    });
    
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Blacklist Command
bot.onText(/\/blacklist/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, '⛔ אין לך הרשאות.');
        return;
    }
    
    const blacklist = getBlacklist();
    const allUsers = getAllUsers();
    
    let message = `🚫 <b>רשימה שחורה</b>\n\n`;
    
    if (blacklist.length === 0) {
        message += '✅ אין משתמשים חסומים כרגע.';
    } else {
        message += `סה"כ ${blacklist.length} משתמשים חסומים:\n\n`;
        
        blacklist.forEach((item, index) => {
            const user = allUsers.find(u => u.chatId == item.chatId);
            const displayName = user ? 
                (user.firstName + (user.lastName ? ' ' + user.lastName : '')) : 
                `User ${item.chatId}`;
            
            message += `${index + 1}. ${displayName}\n`;
            message += `   ID: <code>${item.chatId}</code>\n`;
            message += `   סיבה: ${item.reason}\n`;
            message += `   תאריך: ${new Date(item.timestamp).toLocaleString('he-IL')}\n\n`;
        });
    }
    
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Accounts Command
bot.onText(/\/accounts/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, '⛔ אין לך הרשאות.');
        return;
    }
    
    const accountsData = getLogs();
    const allAccounts = accountsData.accounts || {};
    
    let totalAccounts = 0;
    let activeAccounts = 0;
    let expiredAccounts = 0;
    
    Object.values(allAccounts).forEach(userAccounts => {
        totalAccounts += userAccounts.length;
        userAccounts.forEach(acc => {
            if (acc.active) activeAccounts++;
            else expiredAccounts++;
        });
    });
    
    const accountsMessage = `
💼 <b>סטטוס חשבונות</b>

━━━━━━━━━━━━━━━━━━━━
📊 <b>סיכום:</b>
📦 סה"כ חשבונות: <b>${totalAccounts}</b>
✅ חשבונות פעילים: <b>${activeAccounts}</b>
❌ חשבונות שפג תוקפם: <b>${expiredAccounts}</b>
👥 משתמשים עם חשבונות: <b>${Object.keys(allAccounts).length}</b>

━━━━━━━━━━━━━━━━━━━━
📈 <b>ממוצעים:</b>
• ממוצע חשבונות למשתמש: <b>${Object.keys(allAccounts).length > 0 ? (totalAccounts / Object.keys(allAccounts).length).toFixed(1) : 0}</b>
• אחוז חשבונות פעילים: <b>${totalAccounts > 0 ? ((activeAccounts / totalAccounts) * 100).toFixed(1) : 0}%</b>

━━━━━━━━━━━━━━━━━━━━
<i>עודכן: ${new Date().toLocaleString('he-IL')}</i>
    `;
    
    await bot.sendMessage(chatId, accountsMessage, { parse_mode: 'HTML' });
});

// Broadcast Command
bot.onText(/\/broadcast/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, '⛔ אין לך הרשאות.');
        return;
    }
    
    const users = getAllUsers().filter(u => !u.isBlacklisted);
    
    const broadcastMessage = `
📢 <b>שידור הודעה</b>

שלח את ההודעה שברצונך לשדר לכל המשתמשים:

━━━━━━━━━━━━━━━━━━━━
👥 <b>יקבלו:</b> ${users.length} משתמשים
🚫 <b>חסומים:</b> ${getAllUsers().length - users.length}

⚠️ <b>שים לב:</b>
• ההודעה תישלח לכל המשתמשים הפעילים
• משתמשים חסומים לא יקבלו את ההודעה
• התהליך עשוי לקחת זמן

<i>שלח את ההודעה או שלח "ביטול" לביטול</i>
    `;
    
    adminStates.set(chatId, {
        action: 'broadcast'
    });
    
    await bot.sendMessage(chatId, broadcastMessage, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [[{ text: '❌ ביטול', callback_data: 'admin_menu' }]]
        }
    });
});

// Bot Logic
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
        return;
    }
    if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
        await sendJoinRequiredMessage(chatId);
        return;
    }
    const username = msg.from.username || msg.from.first_name || 'Missing';
    const userInfo = {
        id: msg.from.id,
        username: msg.from.username,
        first_name: msg.from.first_name,
        last_name: msg.from.last_name
    };

    const logs = getLogs();
    const isNewUser = !(logs.logs || []).some(l => String(l.chatId) === String(chatId));
    addLog(chatId, username, 'start', 'success', null, userInfo);
    
    // Broadcast new user to dashboard
    broadcastToClients({
        type: 'user_activity',
        chatId: chatId,
        username: username,
        action: 'start',
        timestamp: new Date().toISOString(),
        telegramUsername: msg.from.username
    });

    // Notify admins of new user (first-time /start)
    if (isNewUser && !isAdmin(chatId)) {
        const displayName = (msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '');
        await notifyAdmins(
            `🆕 <b>משתמש חדש</b>\n\n👤 ${escapeHTML(displayName || username)}\n🆔 <code>${chatId}</code>\n📱 @${username || '-'}`
        );
    }

    const accountCount = getAccountCount(chatId);
    const remainingSlots = 3 - accountCount;
    
    const welcomeMessage = `
🎬 <b>ברוכים הבאים ל-embyIL</b> 🎬

━━━━━━━━━━━━━━━━━━━━

🌟 קבל גישה מיידית לנגן Emby
⚡ תהליך הרשמה אוטומטי ומהיר
🎁 תקופת ניסיון של 3 ימים בחינם
📺 צפייה בכל המכשירים
🛡️ עד 3 חשבונות בו-זמנית

━━━━━━━━━━━━━━━━━━━━

📊 <b>הסטטיסטיקה שלך:</b>
• חשבונות פעילים: ${accountCount}/3
${remainingSlots > 0 ? `• נותרו: ${remainingSlots} חשבונות זמינים` : '• הגעת למגבלת החשבונות'}

━━━━━━━━━━━━━━━━━━━━

<i>לחץ על הכפתור למטה כדי להתחיל</i>
    `;

    const keyboard = [];
    if (remainingSlots > 0) {
        keyboard.push([{ text: '🚀 צור חשבון ניסיון ל-3 ימים', callback_data: 'create_account' }]);
    }
    if (accountCount > 0) {
        keyboard.push([{ text: '📋 החשבונות שלי', callback_data: 'my_accounts' }]);
    }
    
    // Add admin panel button only for admin
    if (isAdmin(chatId)) {
        keyboard.push([{ text: '🔐 פאנל אדמין', callback_data: 'admin_menu' }]);
    }

    // Send welcome image first
    try {
        await bot.sendPhoto(chatId, path.join(__dirname, 'welcome_image.jpg'), {
            caption: welcomeMessage,
            parse_mode: 'HTML',
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
        });
    } catch (error) {
        // Fallback if image doesn't exist
        await bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'HTML',
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
        });
    }
});

// --- Handle /myaccounts Command ---
bot.onText(/\/myaccounts/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
        return;
    }
    if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
        await sendJoinRequiredMessage(chatId);
        return;
    }
    const accounts = getUserAccounts(chatId);
    
    if (accounts.length === 0) {
        await bot.sendMessage(chatId, '❌ לא נמצאו חשבונות. צור חשבון ראשון שלך!', { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🚀 צור חשבון', callback_data: 'create_account' }]
                ]
            }
        });
        return;
    }
    
    let message = `📋 <b>החשבונות שלך</b>\n\n`;
    
    accounts.forEach((acc, idx) => {
        const expiresAt = new Date(acc.expiresAt);
        const now = new Date();
        const hoursRemaining = Math.max(0, Math.floor((expiresAt - now) / (1000 * 60 * 60)));
        const daysRemaining = Math.floor(hoursRemaining / 24);
        const hours = hoursRemaining % 24;
        
        const statusIcon = acc.active ? '✅' : '❌';
        const statusText = acc.active 
            ? `⏰ ${daysRemaining}ד ${hours}ש נותרו`
            : '❌ פג תוקף';
        
        message += `${statusIcon} <b>חשבון ${idx + 1}</b>\n`;
        message += `👤 שם משתמש: <code>${acc.embyUsername}</code>\n`;
        message += `📧 אימייל: <code>${acc.accountEmail}</code>\n`;
        message += `${statusText}\n`;
        message += `📅 נוצר: ${new Date(acc.createdAt).toLocaleDateString('he-IL')}\n\n`;
    });
    
    const activeCount = accounts.filter(a => a.active).length;
    const remainingSlots = 3 - activeCount;
    
    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📊 סה"כ חשבונות פעילים: ${activeCount}/3\n`;
    if (remainingSlots > 0) {
        message += `✅ ניתן ליצור עוד ${remainingSlots} חשבונות`;
    } else {
        message += `⚠️ הגעת למגבלת החשבונות`;
    }
    
    const keyboard = [];
    if (remainingSlots > 0) {
        keyboard.push([{ text: '🔄 צור חשבון נוסף', callback_data: 'create_account' }]);
    }
    
    await bot.sendMessage(chatId, message, { 
        parse_mode: 'HTML',
        reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
    });
});

// Check if user is admin
function isAdmin(chatId) {
    return ADMIN_CHAT_IDS_ARRAY.some(id => id == chatId);
}

// Check if user is a member of the required group (creator, administrator, member, restricted). Bot must be in the group.
async function hasJoinedGroup(userId) {
    if (!REQUIRED_GROUP_ID) return true;
    try {
        const member = await bot.getChatMember(REQUIRED_GROUP_ID, userId);
        const status = (member && member.status) ? member.status.toLowerCase() : '';
        return ['creator', 'administrator', 'member', 'restricted'].includes(status);
    } catch (e) {
        return false;
    }
}

async function sendJoinRequiredMessage(chatId) {
    const message = `
🔒 <b>נדרשת הצטרפות לקבוצה</b>

כדי להשתמש בבוט עליך להצטרף לקבוצה שלנו.

👇 <b>הצטרף כאן:</b>
${REQUIRED_GROUP_INVITE}

לאחר ההצטרפה שלח /start שוב.

⚠️ אם עזבת את הקבוצה – הבוט יפסיק לעבוד עד שתצטרף מחדש.
    `;
    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: false
    });
}

// Store admin conversation states
const adminStates = new Map();

// Handle ALL callback queries in one place
bot.on('callback_query', async (callbackQuery) => {
    try {
        const chatId = callbackQuery.message.chat.id;
        const username = callbackQuery.from.username || callbackQuery.from.first_name || 'Missing';
        const data = callbackQuery.data;
        const userInfo = {
            id: callbackQuery.from.id,
            username: callbackQuery.from.username,
            first_name: callbackQuery.from.first_name,
            last_name: callbackQuery.from.last_name
        };
        
        // Block blacklisted users from any bot interaction (except they never reach admin callbacks)
        if (!isAdmin(chatId) && isBlacklisted(chatId)) {
            bot.answerCallbackQuery(callbackQuery.id);
            await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
            return;
        }
        // Require group membership for non-admins
        const userId = callbackQuery.from.id;
        if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
            bot.answerCallbackQuery(callbackQuery.id);
            await sendJoinRequiredMessage(chatId);
            return;
        }
        
    // === USER CALLBACKS ===
    if (data === 'create_account') {
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Check if user is blacklisted
        if (isBlacklisted(chatId)) {
            await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
            return;
        }
        
        // Check if user can create account
        const limitCheck = canCreateAccount(chatId);
        if (!limitCheck.allowed) {
            const accountCount = getAccountCount(chatId);
            const userAccounts = getUserAccounts(chatId);
            
            let limitMessage = `⚠️ <b>${limitCheck.message}</b>\n\n`;
            limitMessage += `📊 <b>סטטיסטיקה שלך:</b>\n`;
            limitMessage += `• חשבונות פעילים: ${accountCount}/3\n\n`;
            
            if (userAccounts.length > 0) {
                limitMessage += `📋 <b>החשבונות שלך:</b>\n\n`;
                userAccounts.forEach((acc, idx) => {
                    const expiresAt = new Date(acc.expiresAt);
                    const now = new Date();
                    const hoursRemaining = Math.max(0, Math.floor((expiresAt - now) / (1000 * 60 * 60)));
                    const status = acc.active ? `⏰ ${hoursRemaining} שעות נותרו` : '❌ פג תוקף';
                    
                    limitMessage += `${idx + 1}. 👤 ${acc.embyUsername}\n`;
                    limitMessage += `   ${status}\n\n`;
                });
            }
            
            await bot.sendMessage(chatId, limitMessage, { parse_mode: 'HTML' });
            return;
        }
        
        addLog(chatId, username, 'create_account', 'pending', null, userInfo);
        
        // Broadcast activity to dashboard
        broadcastToClients({
            type: 'user_activity',
            chatId: chatId,
            username: username,
            action: 'create_account',
            timestamp: new Date().toISOString(),
            telegramUsername: callbackQuery.from.username
        });

        const statusMsg = await bot.sendMessage(chatId, '⏳ מתחיל תהליך הרשמה...\n\n▱▱▱▱▱▱▱▱▱▱ 0%', { parse_mode: 'HTML' });

        const createProgressBar = (percentage) => {
            const totalBlocks = 10;
            const filledBlocks = Math.floor((percentage / 100) * totalBlocks);
            const emptyBlocks = totalBlocks - filledBlocks;
            
            const filled = '▰'.repeat(filledBlocks);
            const empty = '▱'.repeat(emptyBlocks);
            
            return filled + empty;
        };

        const updateStatus = async (text) => {
            try {
                // Extract progress percentage
                const progressMatch = text.match(/\[(\d+)%\]/);
                const progress = progressMatch ? parseInt(progressMatch[1]) : 0;
                
                // Remove percentage from text
                const cleanText = text.replace(/\[\d+%\]\s*/, '');
                
                // Create visual progress bar
                const progressBar = createProgressBar(progress);
                const statusText = `${cleanText}\n\n${progressBar} ${progress}%`;
                
                // Update database progress
                updateProgress(chatId, progress, text);
                
                // Broadcast progress to dashboard
                broadcastToClients({
                    type: 'progress_update',
                    chatId: chatId,
                    username: username,
                    progress: progress,
                    message: text
                });
                
                // Update Telegram message
                await bot.editMessageText(statusText, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    parse_mode: 'HTML'
                });
            } catch (e) {
                // Fallback - message might be too similar
            }
        };

        const maxAttempts = 3;
        const retryDelayMs = 2500;
        let result = null;
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                result = await run(updateStatus);
                break;
            } catch (e) {
                lastError = e;
                if (attempt < maxAttempts) {
                    await new Promise(r => setTimeout(r, retryDelayMs));
                }
            }
        }
        if (lastError && !result) {
            addLog(chatId, username, 'create_account', 'failed', lastError.message, userInfo);
            clearProgress(chatId);
            await bot.sendMessage(chatId, `❌ <b>ההרשמה נכשלה:</b> ${escapeHTML(lastError.message)}`, { parse_mode: 'HTML' });
            broadcastToClients({
                type: 'account_failed',
                chatId: chatId,
                username: username,
                error: lastError.message
            });
        } else if (result) {
            addLog(chatId, username, 'create_account', 'success', result, userInfo);
            clearProgress(chatId);
            
            // Add account to tracking system
            const account = addAccount(chatId, username, result);
            updateUserLimit(chatId);
            
            const accountCount = getAccountCount(chatId);
            const remainingAccounts = 3 - accountCount;

            const finalMessage = `
<b>✅ ההרשמה הושלמה בהצלחה!</b>

<b>פרטי החשבון במערכת:</b>
📧 אימייל: <code>${escapeHTML(result.accountEmail)}</code>
🔑 סיסמה: <code>${escapeHTML(result.accountPassword)}</code>

<b>פרטי התחברות לנגן Emby:</b>
👤 שם משתמש: <code>${escapeHTML(result.embyUsername)}</code>
🔑 סיסמה: <code>${escapeHTML(result.embyPassword)}</code>

<b>כתובת הנגן:</b> https://play.embyil.tv/

━━━━━━━━━━━━━━━━━━━━
⏰ <b>תוקף החשבון:</b> 3 ימים
📊 <b>חשבונות פעילים:</b> ${accountCount}/3
${remainingAccounts > 0 ? `✅ <b>נותרו:</b> ${remainingAccounts} חשבונות` : '⚠️ הגעת למגבלת החשבונות'}
━━━━━━━━━━━━━━━━━━━━
      `;

            const keyboard = [];
            if (remainingAccounts > 0) {
                keyboard.push([{ text: '🔄 צור חשבון נוסף', callback_data: 'create_account' }]);
            }
            keyboard.push([{ text: '📋 הצג את כל החשבונות שלי', callback_data: 'my_accounts' }]);

            await bot.sendMessage(chatId, finalMessage, { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
            
            // Broadcast completion
            broadcastToClients({
                type: 'account_created',
                chatId: chatId,
                username: username
            });
            // Notify admins of new account
            await notifyAdmins(
                `✅ <b>חשבון חדש נוצר</b>\n\n👤 ${escapeHTML(username)}\n🆔 <code>${chatId}</code>\n📧 ${escapeHTML(result.embyUsername)}`
            );
        }
    }
    
    // === MY ACCOUNTS CALLBACK ===
    else if (data === 'my_accounts') {
        bot.answerCallbackQuery(callbackQuery.id);
        
        const accounts = getUserAccounts(chatId);
        
        if (accounts.length === 0) {
            await bot.sendMessage(chatId, '❌ לא נמצאו חשבונות.', { parse_mode: 'HTML' });
            return;
        }
        
        let message = `📋 <b>החשבונות שלך</b>\n\n`;
        
        accounts.forEach((acc, idx) => {
            const expiresAt = new Date(acc.expiresAt);
            const now = new Date();
            const hoursRemaining = Math.max(0, Math.floor((expiresAt - now) / (1000 * 60 * 60)));
            const daysRemaining = Math.floor(hoursRemaining / 24);
            const hours = hoursRemaining % 24;
            
            const statusIcon = acc.active ? '✅' : '❌';
            const statusText = acc.active 
                ? `⏰ ${daysRemaining}ד ${hours}ש נותרו`
                : '❌ פג תוקף';
            
            message += `${statusIcon} <b>חשבון ${idx + 1}</b>\n`;
            message += `👤 שם משתמש: <code>${acc.embyUsername}</code>\n`;
            message += `📧 אימייל: <code>${acc.accountEmail}</code>\n`;
            message += `${statusText}\n`;
            message += `📅 נוצר: ${new Date(acc.createdAt).toLocaleDateString('he-IL')}\n\n`;
        });
        
        const activeCount = accounts.filter(a => a.active).length;
        message += `━━━━━━━━━━━━━━━━━━━━\n`;
        message += `📊 סה"כ חשבונות פעילים: ${activeCount}/${accounts.length}`;
        
        await bot.sendMessage(chatId, message, { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 צור חשבון נוסף', callback_data: 'create_account' }]
                ]
            }
        });
    }
    
    // === ADMIN CALLBACKS ===
        else if (data.startsWith('admin_')) {
        if (!isAdmin(chatId)) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ אין לך הרשאות' });
            return;
        }
        
        if (data === 'admin_stats') {
            await bot.answerCallbackQuery(callbackQuery.id);
            const stats = getStats();
        
        const statsMessage = `
📊 <b>סטטיסטיקות מערכת</b>

━━━━━━━━━━━━━━━━━━━━
📈 <b>נתונים כלליים:</b>
👥 סה"כ משתמשים: <b>${stats.totalUsers}</b>
💼 חשבונות שנוצרו: <b>${stats.totalAccountsCreated}</b>
✅ חשבונות פעילים: <b>${stats.activeAccounts}</b>
📊 אחוז הצלחה: <b>${stats.successRate}%</b>
🚫 משתמשים חסומים: <b>${stats.blacklistedUsers}</b>

━━━━━━━━━━━━━━━━━━━━
📅 <b>24 שעות אחרונות:</b>
👤 משתמשים פעילים: <b>${stats.users24h}</b>
🆕 חשבונות חדשים: <b>${stats.accounts24h}</b>

━━━━━━━━━━━━━━━━━━━━
📅 <b>7 ימים אחרונים:</b>
👤 משתמשים פעילים: <b>${stats.users7d}</b>
🆕 חשבונות חדשים: <b>${stats.accounts7d}</b>

━━━━━━━━━━━━━━━━━━━━
<i>עודכן: ${new Date().toLocaleString('he-IL')}</i>
        `;
        
            await bot.sendMessage(chatId, statsMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]]
                }
            });
        }
        
        else if (data === 'admin_users' || data.startsWith('admin_users_page_')) {
        await bot.answerCallbackQuery(callbackQuery.id);
        const users = getAllUsers();
        
        if (users.length === 0) {
            await bot.sendMessage(chatId, '❌ אין משתמשים במערכת.', {
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]]
                }
            });
            return;
        }
        
        const pageSize = 8;
        const page = data === 'admin_users' ? 0 : parseInt(data.replace('admin_users_page_', ''), 10) || 0;
        const totalPages = Math.ceil(users.length / pageSize);
        const pageIndex = Math.max(0, Math.min(page, totalPages - 1));
        const pageUsers = users.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize);
        
        let message = `👥 <b>רשימת משתמשים (${users.length})</b>\n\n`;
        message += `<i>לחץ על משתמש לצפייה בפרטים ופעולות</i>\n`;
        message += `\n<i>עמוד ${pageIndex + 1}/${totalPages} • פעילות אחרונה מצוינת ליד כל משתמש</i>\n`;
        
        const keyboard = [];
        pageUsers.forEach((user) => {
            const displayName = user.firstName + (user.lastName ? ' ' + user.lastName : '');
            const blacklistIcon = user.isBlacklisted ? '🚫 ' : '';
            const accountsInfo = ` (${user.activeAccounts}/${user.accountCount})`;
            const lastActive = formatLastActivity(user.lastAction);
            
            keyboard.push([{
                text: `${blacklistIcon}${displayName}${accountsInfo} • ${lastActive}`,
                callback_data: `admin_user_${user.chatId}`
            }]);
        });
        
        const navRow = [];
        if (pageIndex > 0) {
            navRow.push({ text: '◀️ הקודם', callback_data: `admin_users_page_${pageIndex - 1}` });
        }
        if (pageIndex < totalPages - 1) {
            navRow.push({ text: 'הבא ▶️', callback_data: `admin_users_page_${pageIndex + 1}` });
        }
        if (navRow.length > 0) {
            keyboard.push(navRow);
        }
        keyboard.push([{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]);
        
            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        
        else if (data.startsWith('admin_user_')) {
        await bot.answerCallbackQuery(callbackQuery.id);
        const targetUserId = data.replace('admin_user_', '');
        const users = getAllUsers();
        const user = users.find(u => u.chatId == targetUserId);
        
        if (!user) {
            await bot.sendMessage(chatId, '❌ משתמש לא נמצא.');
            return;
        }
        
        const displayName = user.firstName + (user.lastName ? ' ' + user.lastName : '');
        const usernameTag = user.telegramUsername ? `@${user.telegramUsername}` : 'אין';
        const accounts = getUserAccounts(targetUserId);
        
        let userMessage = `
👤 <b>פרטי משתמש</b>

━━━━━━━━━━━━━━━━━━━━
📝 <b>שם:</b> <a href="tg://user?id=${user.chatId}">${escapeHTML(displayName)}</a>
🆔 <b>ID:</b> <code>${user.chatId}</code>
👤 <b>Username:</b> ${usernameTag}
${user.isBlacklisted ? '🚫 <b>סטטוס:</b> חסום\n' : '✅ <b>סטטוס:</b> פעיל\n'}
━━━━━━━━━━━━━━━━━━━━

💼 <b>חשבונות (${accounts.length}):</b>
`;
        
        if (accounts.length === 0) {
            userMessage += `\n<i>אין חשבונות</i>\n`;
        } else {
            accounts.forEach((acc, idx) => {
                const status = acc.active ? '✅' : '❌';
                const expiresAt = new Date(acc.expiresAt);
                const timeLeft = acc.active ? 
                    Math.max(0, Math.floor((expiresAt - new Date()) / (1000 * 60 * 60))) + ' שעות' : 
                    'פג תוקף';
                const embyUser = escapeHTML(acc.embyUsername || '—');
                const embyPass = (acc.embyPassword != null && acc.embyPassword !== '') ? escapeHTML(acc.embyPassword) : '—';
                
                userMessage += `\n${idx + 1}. ${status} <b>${embyUser}</b>`;
                userMessage += `\n   🔑 סיסמה: <code>${embyPass}</code>`;
                userMessage += `\n   ⏰ ${timeLeft}\n`;
            });
        }
        
        const lastActionDate = user.lastAction ? new Date(user.lastAction) : null;
        const lastActionStr = (lastActionDate && !isNaN(lastActionDate.getTime())) ? lastActionDate.toLocaleString('he-IL') : 'לא ידוע';
        userMessage += `\n📅 <b>פעילות אחרונה:</b> ${formatLastActivity(user.lastAction)} (${lastActionStr})`;
        
        const keyboard = [];
        
        if (user.isBlacklisted) {
            keyboard.push([{ text: '✅ הסר חסימה', callback_data: `admin_unban_${targetUserId}` }]);
        } else {
            keyboard.push([{ text: '🚫 חסום משתמש', callback_data: `admin_ban_${targetUserId}` }]);
        }
        
        keyboard.push(
            [{ text: '💬 שלח הודעה', callback_data: `admin_message_${targetUserId}` }],
            [{ text: '🔙 חזרה לרשימה', callback_data: 'admin_users' }]
        );
        
            await bot.sendMessage(chatId, userMessage, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        
        else if (data.startsWith('admin_ban_')) {
        await bot.answerCallbackQuery(callbackQuery.id);
        const targetUserId = data.replace('admin_ban_', '');
        
        const banMessage = `
🚫 <b>חסימת משתמש</b>

שלח את הסיבה לחסימה (או שלח "ביטול" לביטול):
        `;
        
        adminStates.set(chatId, {
            action: 'ban',
            targetUserId: targetUserId,
            messageId: callbackQuery.message.message_id
        });
        
            await bot.sendMessage(chatId, banMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ ביטול', callback_data: `admin_user_${targetUserId}` }]]
                }
            });
        }
        
        else if (data.startsWith('admin_unban_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מסיר חסימה...' });
            const targetUserId = data.replace('admin_unban_', '');
            
            const success = removeFromBlacklist(targetUserId);
            
            if (success) {
                await bot.sendMessage(chatId, `✅ משתמש ${targetUserId} הוסר מהרשימה השחורה.`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetUserId}` }]]
                    }
                });
            } else {
                await bot.sendMessage(chatId, `⚠️ שגיאה בהסרת החסימה.`);
            }
        }
        
        else if (data.startsWith('admin_message_')) {
        await bot.answerCallbackQuery(callbackQuery.id);
        const targetUserId = data.replace('admin_message_', '');
        
        const messagePrompt = `
💬 <b>שליחת הודעה למשתמש</b>

שלח את ההודעה שברצונך לשלוח (או שלח "ביטול" לביטול):
        `;
        
        adminStates.set(chatId, {
            action: 'message',
            targetUserId: targetUserId,
            messageId: callbackQuery.message.message_id
        });
        
            await bot.sendMessage(chatId, messagePrompt, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ ביטול', callback_data: `admin_user_${targetUserId}` }]]
                }
            });
        }
        
        else if (data === 'admin_broadcast') {
            await bot.answerCallbackQuery(callbackQuery.id);
            const users = getAllUsers().filter(u => !u.isBlacklisted);
            
            const broadcastMessage = `
📢 <b>שידור הודעה</b>

שלח את ההודעה שברצונך לשדר לכל המשתמשים:

━━━━━━━━━━━━━━━━━━━━
👥 <b>יקבלו:</b> ${users.length} משתמשים
🚫 <b>חסומים:</b> ${getAllUsers().length - users.length}

⚠️ <b>שים לב:</b>
• ההודעה תישלח לכל המשתמשים הפעילים
• משתמשים חסומים לא יקבלו את ההודעה
• התהליך עשוי לקחת זמן

<i>שלח את ההודעה או לחץ ביטול</i>
            `;
            
            adminStates.set(chatId, {
                action: 'broadcast',
                messageId: callbackQuery.message.message_id
            });
            
            await bot.sendMessage(chatId, broadcastMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ ביטול', callback_data: 'admin_menu' }]]
                }
            });
        }
        
        else if (data === 'admin_blacklist') {
        await bot.answerCallbackQuery(callbackQuery.id);
        const blacklist = getBlacklist();
        const allUsers = getAllUsers();
        
        let message = `🚫 <b>רשימה שחורה</b>\n\n`;
        
        if (blacklist.length === 0) {
            message += '✅ אין משתמשים חסומים כרגע.\n\n';
            message += `<i>לחסימת משתמש, עבור לרשימת המשתמשים</i>`;
        } else {
            message += `סה"כ ${blacklist.length} משתמשים חסומים\n`;
            message += `<i>לחץ על משתמש להסרת חסימה</i>\n`;
        }
        
        const keyboard = [];
        
        blacklist.forEach((item) => {
            const user = allUsers.find(u => u.chatId == item.chatId);
            const displayName = user ? 
                (user.firstName + (user.lastName ? ' ' + user.lastName : '')) : 
                `User ${item.chatId}`;
            
            keyboard.push([{
                text: `🚫 ${displayName} (${item.reason})`,
                callback_data: `admin_user_${item.chatId}`
            }]);
        });
        
        keyboard.push([{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]);
        
            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        
        else if (data === 'admin_accounts') {
            await bot.answerCallbackQuery(callbackQuery.id);
            const accountsData = getLogs();
            const allAccounts = accountsData.accounts || {};
            
            let totalAccounts = 0;
            let activeAccounts = 0;
            let expiredAccounts = 0;
            
            Object.values(allAccounts).forEach(userAccounts => {
                totalAccounts += userAccounts.length;
                userAccounts.forEach(acc => {
                    if (acc.active) activeAccounts++;
                    else expiredAccounts++;
                });
            });
            
            const accountsMessage = `
💼 <b>סטטוס חשבונות</b>

━━━━━━━━━━━━━━━━━━━━
📊 <b>סיכום:</b>
📦 סה"כ חשבונות: <b>${totalAccounts}</b>
✅ חשבונות פעילים: <b>${activeAccounts}</b>
❌ חשבונות שפג תוקפם: <b>${expiredAccounts}</b>
👥 משתמשים עם חשבונות: <b>${Object.keys(allAccounts).length}</b>

━━━━━━━━━━━━━━━━━━━━
📈 <b>ממוצעים:</b>
• ממוצע חשבונות למשתמש: <b>${Object.keys(allAccounts).length > 0 ? (totalAccounts / Object.keys(allAccounts).length).toFixed(1) : 0}</b>
• אחוז חשבונות פעילים: <b>${totalAccounts > 0 ? ((activeAccounts / totalAccounts) * 100).toFixed(1) : 0}%</b>

━━━━━━━━━━━━━━━━━━━━
<i>עודכן: ${new Date().toLocaleString('he-IL')}</i>
            `;
            
            await bot.sendMessage(chatId, accountsMessage, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]]
                }
            });
        }
        
        else if (data === 'admin_menu') {
            
            try {
                await bot.answerCallbackQuery(callbackQuery.id);
                
                const adminMenu = `
🔐 <b>פאנל אדמין - EmbyIL Bot</b>

ברוך הבא לפאנל הניהול!
בחר פעולה מהתפריט למטה:

━━━━━━━━━━━━━━━━━━━━
📊 <b>סטטיסטיקות</b> - צפייה בנתונים
👥 <b>משתמשים</b> - רשימת כל המשתמשים
📢 <b>שידור</b> - שלח הודעה לכל המשתמשים
🚫 <b>חסומים</b> - ניהול רשימה שחורה
💼 <b>חשבונות</b> - סטטוס כל החשבונות
━━━━━━━━━━━━━━━━━━━━
                `;
                
                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '📊 סטטיסטיקות', callback_data: 'admin_stats' },
                            { text: '👥 משתמשים', callback_data: 'admin_users' }
                        ],
                        [
                            { text: '📢 שידור הודעה', callback_data: 'admin_broadcast' },
                            { text: '💼 חשבונות', callback_data: 'admin_accounts' }
                        ],
                        [
                            { text: '🚫 חסומים', callback_data: 'admin_blacklist' }
                        ]
                    ]
                };
                
                await bot.sendMessage(chatId, adminMenu, {
                    parse_mode: 'HTML',
                    reply_markup: keyboard
                });
                
            } catch (error) {
                console.error('Admin menu error:', error.message);
                await bot.sendMessage(chatId, `❌ שגיאה בפתיחת תפריט האדמין: ${error.message}`);
            }
        }
    }
    
    // Catch unhandled callbacks
    else {
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'פעולה לא זוהתה' });
    }
    
    } catch (error) {
        console.error(`❌ Error in callback handler:`, error);
        try {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'שגיאה' });
        } catch (e) {
            console.error('Failed to answer callback query:', e);
        }
    }
});

// Handle admin conversation states
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    
    // Handle admin conversations
    if (isAdmin(chatId) && adminStates.has(chatId)) {
        const state = adminStates.get(chatId);
        const text = msg.text;
        
        if (text === 'ביטול' || text === '/start') {
            adminStates.delete(chatId);
            await bot.sendMessage(chatId, '❌ הפעולה בוטלה.', {
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]]
                }
            });
            return;
        }
        
        if (state.action === 'ban') {
            const reason = text;
            const success = addToBlacklist(state.targetUserId, reason, chatId);
            
            adminStates.delete(chatId);
            
            if (success) {
                await bot.sendMessage(chatId, `✅ משתמש ${state.targetUserId} נחסם בהצלחה.\n📝 סיבה: ${reason}`, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${state.targetUserId}` }]]
                    }
                });
            } else {
                await bot.sendMessage(chatId, `⚠️ משתמש ${state.targetUserId} כבר חסום.`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${state.targetUserId}` }]]
                    }
                });
            }
            return;
        }
        
        else if (state.action === 'message') {
            const message = text;
            
            adminStates.delete(chatId);
            
            try {
                await bot.sendMessage(state.targetUserId, `📢 <b>הודעה מהאדמין:</b>\n\n${message}`, {
                    parse_mode: 'HTML'
                });
                
                await bot.sendMessage(chatId, `✅ ההודעה נשלחה בהצלחה!`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${state.targetUserId}` }]]
                    }
                });
            } catch (error) {
                await bot.sendMessage(chatId, `❌ שגיאה בשליחת ההודעה: ${error.message}`);
            }
            return;
        }
        
        else if (state.action === 'broadcast') {
            const message = text;
            const users = getAllUsers();
            
            adminStates.delete(chatId);
            
            const statusMsg = await bot.sendMessage(chatId, `📢 מתחיל שידור ל-${users.length} משתמשים...`);
            
            let sent = 0;
            let failed = 0;
            let blocked = 0;
            
            for (const user of users) {
                if (user.isBlacklisted) {
                    blocked++;
                    continue;
                }
                
                try {
                    await bot.sendMessage(user.chatId, `📢 <b>הודעה מהאדמין:</b>\n\n${message}`, {
                        parse_mode: 'HTML'
                    });
                    sent++;
                    
                    // Add delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    failed++;
                    console.error(`Failed to send to ${user.chatId}:`, error.message);
                }
            }
            
            await bot.editMessageText(
                `✅ שידור הושלם!\n\n` +
                `📤 נשלח: ${sent}\n` +
                `❌ נכשל: ${failed}\n` +
                `🚫 חסומים: ${blocked}\n` +
                `📊 סה"כ: ${users.length}`,
                {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]]
                    }
                }
            );
            return;
        }
    }
    
    // Regular message handling for non-admins or admins not in conversation
    if (msg.text && !msg.text.startsWith('/')) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // Block blacklisted users
        if (isBlacklisted(chatId)) {
            await bot.sendMessage(chatId, '🚫 אינך יכול להשתמש בבוט זה.');
            return;
        }
        // Require group membership for non-admins
        if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
            await sendJoinRequiredMessage(chatId);
            return;
        }
        
        const username = msg.from.username || msg.from.first_name || 'Unknown';
        
        addChatMessage(chatId, username, false, msg.text);
        
        // Broadcast new message to admin dashboard
        broadcastToClients({
            type: 'new_message',
            chatId: chatId,
            username: username,
            message: msg.text,
            timestamp: new Date().toISOString(),
            telegramUsername: msg.from.username
        });
    }
});

// --- Initialize Server ---
const app = express();
const server = http.createServer(app);

// Simple WebSocket implementation
server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws') {
        socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    '\r\n');

        wsClients.push(socket);
        
        socket.on('close', () => {
            wsClients = wsClients.filter(client => client !== socket);
        });
        
        socket.on('error', (err) => {
            console.error('WebSocket error:', err);
        });

        // Send initial data
        try {
            const data = getLogs();
            socket.write(JSON.stringify({
                type: 'initial_data',
                chats: getAllChats(),
                progress: data.progress || {}
            }) + '\n');
        } catch (e) {
            console.error('Error sending initial data:', e);
        }
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.get('/api/logs', (req, res) => {
    res.json(getLogs());
});

app.get('/api/chats', (req, res) => {
    res.json(getAllChats());
});

app.get('/api/chats/:chatId', (req, res) => {
    const chats = getAllChats();
    const chat = chats[req.params.chatId];
    if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
    }
    res.json(chat);
});

app.get('/api/accounts/:chatId', (req, res) => {
    const accounts = getUserAccounts(req.params.chatId);
    const accountCount = getAccountCount(req.params.chatId);
    res.json({
        accounts: accounts,
        activeCount: accountCount,
        limit: 3,
        remainingSlots: 3 - accountCount
    });
});

app.get('/api/all-accounts', (req, res) => {
    const data = getLogs();
    if (!data.accounts) {
        return res.json({});
    }
    
    const allAccountsData = {};
    Object.keys(data.accounts).forEach(chatId => {
        const accounts = data.accounts[chatId];
        const activeCount = accounts.filter(a => a.active).length;
        allAccountsData[chatId] = {
            accounts: accounts,
            activeCount: activeCount,
            limit: 3,
            remainingSlots: 3 - activeCount
        };
    });
    
    res.json(allAccountsData);
});

app.post('/api/send-message', async (req, res) => {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
        return res.status(400).json({ error: 'Missing chatId or message' });
    }

    try {
        await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        
        const chats = getAllChats();
        const username = chats[chatId] ? chats[chatId].username : 'Unknown';
        
        addChatMessage(chatId, 'ADMIN', true, message);
        addLog(chatId, 'ADMIN', 'admin_message', 'success', message);
        
        // Broadcast to all dashboard clients
        broadcastToClients({
            type: 'admin_message_sent',
            chatId: chatId,
            message: message,
            timestamp: new Date().toISOString()
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error sending admin message:', error);
        res.status(500).json({ error: error.message });
    }
});

server.listen(port, () => {
    console.log(`Listening on port ${port}`);
});
