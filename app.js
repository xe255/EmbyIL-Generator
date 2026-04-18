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
    getAllUsers,
    getDbAdmins,
    addDbAdmin,
    removeDbAdmin,
    isUnlimitedUser,
    addUnlimitedUser,
    removeUnlimitedUser,
    isCreationEnabled,
    setCreationEnabled,
    // Whitelist
    isWhitelistEnabled,
    setWhitelistEnabled,
    getWhitelist,
    isWhitelisted,
    addToWhitelist,
    removeFromWhitelist,
    // Broadcast Analytics
    addBroadcast,
    updateBroadcastStats,
    logBroadcastClick,
    getBroadcasts,
    // Broadcast Exclusion
    isBroadcastExcluded,
    addToBroadcastExclusion,
    removeFromBroadcastExclusion,
    upsertGroupMember,
    removeGroupMember,
    getBroadcastRecipients,
    pullSupabaseGroupMembersIntoMemDb
} = require('./database');

// --- Configuration ---
const token = process.env.TELEGRAM_BOT_TOKEN;
const port = process.env.PORT || 3000;
// Render sets RENDER_EXTERNAL_URL; use as fallback so keep-alive + /r/ links work without extra env.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
/** When unset: on if PUBLIC_URL is set (Render/Zeabur need inbound hits before ~15m idle). Explicit false disables. */
function envBool(name, defaultTrue) {
    const v = process.env[name];
    if (v === undefined || String(v).trim() === '') return defaultTrue;
    if (/^0|false|no|off$/i.test(String(v).trim())) return false;
    if (/^1|true|yes|on$/i.test(String(v).trim())) return true;
    return defaultTrue;
}
const KEEP_ALIVE_SELF_PING = envBool('KEEP_ALIVE_SELF_PING', !!PUBLIC_URL);
const KEEP_ALIVE_INTERVAL_MS = Math.max(
    60_000,
    parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || '300000', 10) || 300_000
);

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
            timeout: 10,
            // Telegram omits chat_member from default updates; needed to track group roster for broadcasts
            allowed_updates: ['message', 'callback_query', 'chat_member']
        }
    }
});

// Track joins/leaves in the required group for broadcast targeting (ChatMemberUpdated)
bot.on('chat_member', (cm) => {
    try {
        if (!requiredGroupChatIdMatches(cm.chat && cm.chat.id)) return;
        const newM = cm.new_chat_member;
        const user = newM && newM.user;
        if (!user || user.is_bot) return;
        const st = String(newM.status || '').toLowerCase();
        if (st === 'left' || st === 'kicked') {
            removeGroupMember(user.id);
            return;
        }
        if (['creator', 'administrator', 'member', 'restricted'].includes(st)) {
            upsertGroupMember(user.id, user);
        }
    } catch (e) {
        console.error('chat_member handler:', e.message);
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

/* Expiry notification checker - disabled by user request
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
*/

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

/** Telegram hard limit 4096; keep headroom for wrappers and HTML expansion after escape. */
function clipForTelegram(str, maxLen = 3500) {
    const s = str == null ? '' : String(str);
    if (s.length <= maxLen) return s;
    return s.slice(0, Math.max(0, maxLen - 1)) + '…';
}

/** Persist rich error for dashboard (same info you see in server console). */
function serializeErrorForLog(err) {
    if (err == null) {
        return { type: 'ErrorLog', name: 'Error', message: 'Unknown error', consoleText: 'Unknown error' };
    }
    if (typeof err === 'string') {
        return { type: 'ErrorLog', name: 'Error', message: err, consoleText: err };
    }
    const name = err.name || 'Error';
    const message = String(err.message != null ? err.message : err);
    let bodySnippet = '';
    if (err.body !== undefined) {
        if (typeof err.body === 'string') bodySnippet = err.body;
        else {
            try {
                bodySnippet = JSON.stringify(err.body, null, 2);
            } catch {
                bodySnippet = String(err.body);
            }
        }
    }
    const MAX_BODY = 12000;
    if (bodySnippet.length > MAX_BODY) {
        bodySnippet = bodySnippet.slice(0, MAX_BODY) + '\n… [truncated for db size]';
    }
    const stack = err.stack ? String(err.stack) : '';
    const parts = [];
    if (err.status != null) parts.push(`HTTP ${err.status}`);
    parts.push(`${name}: ${message}`);
    if (bodySnippet) parts.push(`--- response body ---\n${bodySnippet}`);
    if (stack) parts.push(`--- stack ---\n${stack}`);
    const consoleText = parts.join('\n\n');
    return {
        type: 'ErrorLog',
        name,
        message,
        status: err.status,
        body: bodySnippet || undefined,
        stack: stack || undefined,
        consoleText
    };
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

// Access code for whitelist self-entry. Set ACCESS_CODE in env to change it.
const ACCESS_CODE = (process.env.ACCESS_CODE || 'david').trim();

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

// Required group: users MUST be members to use the bot. Bot must be in the group.
// Set REQUIRED_GROUP_ID in .env - run /getgroupid inside your group to get the ID.
// IMPORTANT: In Zeabur, add REQUIRED_GROUP_ID to Environment Variables in the dashboard!
const _groupIdRaw = process.env.REQUIRED_GROUP_ID;
const _groupId = (typeof _groupIdRaw === 'string' && _groupIdRaw.trim()) ? _groupIdRaw.trim() : null;
const REQUIRED_GROUP_ID = _groupId;
const REQUIRED_GROUP_INVITE = process.env.REQUIRED_GROUP_INVITE || 'https://t.me/+F7ywFh8iVpVjODBk';

// Admin config (minimal log for Zeabur)
if (ADMIN_CHAT_IDS_ARRAY.length === 0) console.warn('ADMIN_CHAT_ID or ADMIN_CHAT_IDS not set');
if (!REQUIRED_GROUP_ID) {
    console.warn('⚠️ REQUIRED_GROUP_ID not set - group gate is OFF (anyone can use the bot)!');
    console.warn('   To enable: add bot to your group, run /getgroupid there, then set REQUIRED_GROUP_ID in Zeabur env vars.');
}

// Validate group access at startup when REQUIRED_GROUP_ID is set
if (REQUIRED_GROUP_ID) {
    (async () => {
        try {
            await bot.getChat(REQUIRED_GROUP_ID);
            console.log('✅ Group gate ON: bot can access required group', REQUIRED_GROUP_ID);
        } catch (e) {
            console.error('❌ Group gate FAILED: bot cannot access group', REQUIRED_GROUP_ID);
            console.error('   Error:', e.message);
            console.error('   → Add the bot to your group and ensure REQUIRED_GROUP_ID is correct.');
        }
    })();
}

// --- Initialize Bot Commands ---
const defaultUserCommands = [
    { command: 'start', description: 'תפריט ראשי — צור חשבון' },
    { command: 'help', description: 'עזרה וקבלת מידע' },
    { command: 'myaccounts', description: 'צפייה בחשבונות שלי' },
    { command: 'getid', description: 'קבלת ה-ID שלך' }
];
bot.setMyCommands(defaultUserCommands, { scope: { type: 'default' } });

// For Admins: scoped chat commands replace the default list — include /start and user commands too
ADMIN_CHAT_IDS_ARRAY.forEach(adminId => {
    bot.setMyCommands(
        [
            ...defaultUserCommands,
            { command: 'admin', description: 'פאנל ניהול' },
            { command: 'stats', description: 'סטטיסטיקות' },
            { command: 'users', description: 'ניהול משתמשים' },
            { command: 'broadcast', description: 'שידור הודעה' },
            { command: 'blacklist', description: 'רשימה שחורה' }
        ],
        { scope: { type: 'chat', chat_id: adminId } }
    );
});

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
    if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
        await sendJoinRequiredMessage(chatId);
        return;
    }
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
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
• כל חשבון תקף ליום אחד
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
    if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
        await sendJoinRequiredMessage(chatId);
        return;
    }
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
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
<b>Group gate:</b> ${REQUIRED_GROUP_ID ? '✅ ON (group ' + REQUIRED_GROUP_ID + ')' : '❌ OFF - anyone can use bot!'}
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
    
    const creationOn = isCreationEnabled();
    const wlOn = isWhitelistEnabled();
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
                { text: '🔍 חיפוש משתמש', callback_data: 'admin_search_user' },
                { text: '🚫 חסומים', callback_data: 'admin_blacklist' }
            ],
            [
                { text: creationOn ? '🟢 יצירה: פעיל' : '🔴 יצירה: כבוי', callback_data: 'admin_toggle_creation' },
                { text: '📋 רשימה לבנה', callback_data: 'admin_whitelist' }
            ],
            [
                { text: wlOn ? '🟢 רשימה לבנה: פעיל' : '⚪ רשימה לבנה: כבוי', callback_data: 'admin_toggle_whitelist' }
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
        await bot.sendMessage(chatId, '❌ אין משתמשים במערכת.', {
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 פאנל אדמין', callback_data: 'admin_menu' }]]
            }
        });
        return;
    }
    
    const pageSize = 8;
    const pageIndex = 0;
    const totalPages = Math.ceil(users.length / pageSize);
    const pageUsers = users.slice(0, pageSize);
    
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
    
    const navRow1 = [];
    const navRow2 = [];
        
    navRow1.push({ text: `📄 ${pageIndex + 1}/${totalPages}`, callback_data: `admin_users_page_${pageIndex}` });
    
    if (pageIndex < totalPages - 1) {
        navRow1.push({ text: '▶️', callback_data: `admin_users_page_${pageIndex + 1}` });
    }

    if (totalPages > 2) {
        if (pageIndex < totalPages - 5) navRow2.push({ text: '+5 ⏩', callback_data: `admin_users_page_${Math.min(totalPages - 1, pageIndex + 5)}` });
        if (pageIndex < totalPages - 1) navRow2.push({ text: 'סוף ⏭️', callback_data: `admin_users_page_${totalPages - 1}` });
    }
    
    if (navRow1.length > 0) keyboard.push(navRow1);
    if (navRow2.length > 0) keyboard.push(navRow2);
    keyboard.push([{ text: '🔙 פאנל אדמין', callback_data: 'admin_menu' }]);
    
    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
    });
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
    
    const recipients = getBroadcastRecipients(!!REQUIRED_GROUP_ID);
    
    const broadcastMessage = `
📢 <b>שידור הודעה</b>

שלח את ההודעה שברצונך לשדר לכל המשתמשים:

━━━━━━━━━━━━━━━━━━━━
👥 <b>יקבלו:</b> ${recipients.length} משתמשים
${REQUIRED_GROUP_ID ? `<i>כולל חברי הקבוצה שנרשמו במעקב (הצטרפות / שימוש בבוט).</i>\n` : ''}
⚠️ <b>שים לב:</b>
• חסומים או מוחרגים משידור לא יקבלו גם אם הם בקבוצה
• התהליך עשוי לקחת זמן

<i>שלח את ההודעה או שלח "ביטול" לביטול</i>
    `;
    
    adminStates.set(chatId, {
        action: 'broadcast_awaiting_message'
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
    // Group gate first: non-admin must be in group or we only show join message
    if (REQUIRED_GROUP_ID && !isAdmin(chatId)) {
        if (!(await hasJoinedGroup(userId))) {
            await sendJoinRequiredMessage(chatId);
            return;
        }
        trackUserIfInRequiredGroup(msg.from);
    }
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
        return;
    }
    if (isWhitelistBlocked(chatId)) {
        await sendWhitelistBlockedMessage(chatId);
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

    await sendMainMenu(chatId);
});

// --- Handle /myaccounts Command ---
bot.onText(/\/myaccounts/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
        await sendJoinRequiredMessage(chatId);
        return;
    }
    if (!isAdmin(chatId) && isBlacklisted(chatId)) {
        await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
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

// /promote <id> — quickly promote a user to admin
bot.onText(/\/promote(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const targetId = match[1];
    if (!targetId) {
        await bot.sendMessage(chatId, '⚠️ שימוש: /promote <chat_id>\n\nדוגמה: /promote 123456789\n\nאת ה-ID ניתן למצוא ב-/admin → 👥 משתמשים → לחץ על משתמש');
        return;
    }
    if (ADMIN_CHAT_IDS_ARRAY.some(id => id == targetId)) {
        await bot.sendMessage(chatId, `ℹ️ משתמש <code>${targetId}</code> כבר אדמין (מוגדר ב-env).`, { parse_mode: 'HTML' });
        return;
    }
    const success = addDbAdmin(targetId);
    if (success) {
        await bot.sendMessage(chatId, `✅ משתמש <code>${targetId}</code> קודם לאדמין בהצלחה.`, { parse_mode: 'HTML' });
        try { await bot.sendMessage(parseInt(targetId), '🎉 <b>קודמת לאדמין!</b>\n\nכעת יש לך גישה לפאנל האדמין. השתמש ב-/admin.', { parse_mode: 'HTML' }); } catch (e) {}
    } else {
        await bot.sendMessage(chatId, `ℹ️ משתמש <code>${targetId}</code> כבר אדמין.`, { parse_mode: 'HTML' });
    }
});

// /demote <id> — remove admin from a dynamically promoted user
bot.onText(/\/demote(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) return;
    const targetId = match[1];
    if (!targetId) {
        await bot.sendMessage(chatId, '⚠️ שימוש: /demote <chat_id>');
        return;
    }
    if (ADMIN_CHAT_IDS_ARRAY.some(id => id == targetId)) {
        await bot.sendMessage(chatId, `❌ לא ניתן להסיר אדמין שמוגדר ב-env. שנה את ADMIN_CHAT_IDS.`, { parse_mode: 'HTML' });
        return;
    }
    const success = removeDbAdmin(targetId);
    if (success) {
        await bot.sendMessage(chatId, `✅ הרשאות האדמין של <code>${targetId}</code> הוסרו.`, { parse_mode: 'HTML' });
        try { await bot.sendMessage(parseInt(targetId), '⚠️ הרשאות האדמין שלך הוסרו.'); } catch (e) {}
    } else {
        await bot.sendMessage(chatId, `ℹ️ משתמש <code>${targetId}</code> אינו אדמין שניתן להסיר.`, { parse_mode: 'HTML' });
    }
});

// Check if user is admin (env-var admins + dynamically promoted admins in db.json)
function isAdmin(chatId) {
    if (ADMIN_CHAT_IDS_ARRAY.some(id => id == chatId)) return true;
    const dbAdmins = getDbAdmins();
    return dbAdmins.some(id => String(id) === String(chatId));
}

// Returns true if the user is blocked by the whitelist (whitelist ON and user not in it)
function isWhitelistBlocked(chatId) {
    if (isAdmin(chatId)) return false;
    if (!isWhitelistEnabled()) return false;
    return !isWhitelisted(chatId);
}

async function sendWhitelistBlockedMessage(chatId) {
    await bot.sendMessage(chatId,
        '🔒 <b>גישה מוגבלת</b>\n\nהבוט פועל במצב רשימה לבנה.\nאם יש לך קוד גישה, לחץ על הכפתור למטה.',
        {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '🔑 קוד-גישה', callback_data: 'access_code_prompt' }]]
            }
        }
    );
}

// /whitelist command — add user by chat ID or @username
bot.onText(/\/whitelist(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isAdmin(chatId)) {
        await bot.sendMessage(chatId, '⛔ אין לך הרשאות.');
        return;
    }

    const arg = (match[1] || '').trim();
    if (!arg) {
        const wl = getWhitelist();
        const enabled = isWhitelistEnabled();
        let text = `📋 <b>רשימה לבנה</b>\n\n`;
        text += `סטטוס: ${enabled ? '🟢 פעיל' : '🔴 כבוי'}\n`;
        text += `משתמשים: <b>${wl.length}</b>\n\n`;
        if (wl.length > 0) {
            const allUsers = getAllUsers();
            wl.forEach((e, i) => {
                const u = allUsers.find(u => String(u.chatId) === String(e.chatId));
                const name = u ? (u.firstName + (u.lastName ? ' ' + u.lastName : '')) : `ID ${e.chatId}`;
                text += `${i + 1}. ${escapeHTML(name)} — <code>${e.chatId}</code>\n`;
            });
        }
        text += `\n<i>שימוש: /whitelist &lt;ID או @username&gt; להוספה/הסרה</i>`;
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        return;
    }

    // Resolve argument to a chatId
    let targetId = null;
    let targetName = arg;

    if (/^\d+$/.test(arg)) {
        targetId = arg;
    } else {
        const handle = arg.replace(/^@/, '').toLowerCase();
        const allUsers = getAllUsers();
        const found = allUsers.find(u => u.telegramUsername && u.telegramUsername.toLowerCase() === handle);
        if (found) {
            targetId = String(found.chatId);
            targetName = found.firstName + (found.lastName ? ' ' + found.lastName : '');
        } else {
            await bot.sendMessage(chatId, `❌ לא נמצא משתמש עם username <b>${escapeHTML(arg)}</b> במערכת.\n\nהשתמש ב-ID ישירות במקום.`, { parse_mode: 'HTML' });
            return;
        }
    }

    if (isWhitelisted(targetId)) {
        removeFromWhitelist(targetId);
        await bot.sendMessage(chatId, `🗑 <b>${escapeHTML(targetName)}</b> (<code>${targetId}</code>) הוסר מהרשימה הלבנה.`, { parse_mode: 'HTML' });
        try { await bot.sendMessage(parseInt(targetId), '🔒 הוסרת מהרשימה הלבנה של הבוט.'); } catch (e) {}
    } else {
        addToWhitelist(targetId, chatId);
        await bot.sendMessage(chatId, `✅ <b>${escapeHTML(targetName)}</b> (<code>${targetId}</code>) נוסף לרשימה הלבנה.`, { parse_mode: 'HTML' });
        try { await bot.sendMessage(parseInt(targetId), '✅ נוספת לרשימה הלבנה — כעת יש לך גישה לבוט.'); } catch (e) {}
    }
});

// Check if user is a member of the required group. Bot must be in the group. Returns false on any error so we block access.
async function hasJoinedGroup(userId) {
    if (!REQUIRED_GROUP_ID) return true; // Gate off - allow all (with warning at startup)
    try {
        const groupId = /^-?\d+$/.test(REQUIRED_GROUP_ID) ? parseInt(REQUIRED_GROUP_ID, 10) : REQUIRED_GROUP_ID;
        const member = await bot.getChatMember(groupId, String(userId));
        const status = (member && member.status) ? String(member.status).toLowerCase() : '';
        return ['creator', 'administrator', 'member', 'restricted'].includes(status);
    } catch (e) {
        console.error('hasJoinedGroup failed for user', userId, ':', e.message);
        return false; // Block on any error (e.g. user not in group, bot not in group)
    }
}

function requiredGroupChatIdMatches(chatId) {
    return !!(REQUIRED_GROUP_ID && chatId != null && String(chatId) === String(REQUIRED_GROUP_ID));
}

/** Persist user for broadcast list (Telegram has no API to export full member list). */
function trackUserIfInRequiredGroup(telegramUser) {
    if (!REQUIRED_GROUP_ID || !telegramUser || telegramUser.is_bot) return;
    upsertGroupMember(telegramUser.id, telegramUser);
}

async function sendJoinRequiredMessage(chatId) {
    const message = `
🔒 <b>נדרשת הצטרפות לקבוצה</b>

כדי להשתמש בבוט עליך להצטרף לקבוצה שלנו.

👇 <b>הצטרף כאן:</b>
${REQUIRED_GROUP_INVITE}

לאחר ההצטרפה לחץ על הכפתור למטה: <b>הצטרפתי</b>.

⚠️ אם תעזוב את הקבוצה – הבוט יפסיק לעבוד עד שתצטרף מחדש.
    `;
    await bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: {
            inline_keyboard: [[{ text: '✅ הצטרפתי', callback_data: 'check_joined_group' }]]
        }
    });
}

// Send main menu (welcome + keyboard). Used by /start and after "I joined" verification.
async function sendMainMenu(chatId) {
    const accountCount = getAccountCount(chatId);
    const unlimited = isAdmin(chatId) || isUnlimitedUser(chatId);
    const remainingSlots = unlimited ? Infinity : 3 - accountCount;
    const slotsDisplay = unlimited ? '∞' : `${3 - accountCount}`;
    const welcomeMessage = `
🎬 <b>ברוכים הבאים ל-embyIL</b> 🎬

━━━━━━━━━━━━━━━━━━━━

🌟 <b>צור חשבון</b> — גישה מיידית לנגן Emby
⚡ תהליך הרשמה אוטומטי ומהיר
🎁 תקופת ניסיון של יום אחד בחינם
📺 צפייה בכל המכשירים
🛡️ ${unlimited ? 'חשבונות ללא הגבלה' : 'עד 3 חשבונות בו-זמנית'}

━━━━━━━━━━━━━━━━━━━━

📊 <b>הסטטיסטיקה שלך:</b>
• חשבונות פעילים: ${accountCount}${unlimited ? '' : '/3'}
${remainingSlots > 0 ? `• נותרו: ${slotsDisplay} חשבונות זמינים` : '• הגעת למגבלת החשבונות'}

━━━━━━━━━━━━━━━━━━━━

<i>לחץ על <b>צור חשבון</b> למטה — או שלח /start בכל עת</i>
    `;
    const keyboard = [];
    if (remainingSlots > 0) {
        keyboard.push([{ text: '🚀 צור חשבון', callback_data: 'create_account' }]);
    }
    if (accountCount > 0) {
        keyboard.push([{ text: '📋 החשבונות שלי', callback_data: 'my_accounts' }]);
    }
    if (isAdmin(chatId)) {
        keyboard.push([{ text: '🔐 פאנל אדמין', callback_data: 'admin_menu' }]);
    }
    try {
        await bot.sendPhoto(chatId, path.join(__dirname, 'welcome_image.jpg'), {
            caption: welcomeMessage,
            parse_mode: 'HTML',
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
        });
    } catch (e) {
        await bot.sendMessage(chatId, welcomeMessage, {
            parse_mode: 'HTML',
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
        });
    }
}

// Store admin conversation states
const adminStates = new Map();

// Handle ALL callback queries in one place
bot.on('callback_query', async (callbackQuery) => {
    try {
        const chatId = callbackQuery.message.chat.id;
        const userId = callbackQuery.from.id;
        const data = callbackQuery.data;
        const username = callbackQuery.from.username || callbackQuery.from.first_name || 'Missing';
        const userInfo = {
            id: callbackQuery.from.id,
            username: callbackQuery.from.username,
            first_name: callbackQuery.from.first_name,
            last_name: callbackQuery.from.last_name
        };
        
        // 1) Group gate FIRST: non-admin must be in group. Only "I joined" button is allowed through to verify.
        if (REQUIRED_GROUP_ID && !isAdmin(chatId)) {
            if (data === 'check_joined_group') {
                const joined = await hasJoinedGroup(userId);
                if (joined) {
                    trackUserIfInRequiredGroup(callbackQuery.from);
                    bot.answerCallbackQuery(callbackQuery.id, { text: 'מאומת! ברוך הבא' });
                    await sendMainMenu(chatId);
                    return;
                }
                bot.answerCallbackQuery(callbackQuery.id, { text: 'עדיין לא רואים אותך בקבוצה' });
                await sendJoinRequiredMessage(chatId);
                return;
            }
            if (!(await hasJoinedGroup(userId))) {
                bot.answerCallbackQuery(callbackQuery.id);
                await sendJoinRequiredMessage(chatId);
                return;
            }
        } else if (data === 'check_joined_group' && isAdmin(chatId)) {
            bot.answerCallbackQuery(callbackQuery.id);
            await sendMainMenu(chatId);
            return;
        }
        
        // 2) Block blacklisted users
        if (!isAdmin(chatId) && isBlacklisted(chatId)) {
            bot.answerCallbackQuery(callbackQuery.id);
            await bot.sendMessage(chatId, '🚫 אינך מורשה להשתמש בבוט זה.');
            return;
        }

        // 3) Block users not on whitelist (when whitelist is enabled)
        if (isWhitelistBlocked(chatId)) {
            bot.answerCallbackQuery(callbackQuery.id);
            // Allow the access-code prompt button through even when blocked
            if (data !== 'access_code_prompt') {
                await sendWhitelistBlockedMessage(chatId);
                return;
            }
        }
        
    // === ACCESS CODE ===
    if (data === 'access_code_prompt') {
        bot.answerCallbackQuery(callbackQuery.id);
        adminStates.set(chatId, { action: 'access_code' });
        await bot.sendMessage(chatId,
            '🔑 <b>הזן קוד גישה:</b>',
            {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ ביטול', callback_data: 'access_code_cancel' }]]
                }
            }
        );
        return;
    }

    if (data === 'access_code_cancel') {
        bot.answerCallbackQuery(callbackQuery.id);
        adminStates.delete(chatId);
        await sendWhitelistBlockedMessage(chatId);
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

        // Check global creation switch (admins bypass this)
        if (!isAdmin(chatId) && !isCreationEnabled()) {
            await bot.sendMessage(chatId, '🔒 <b>יצירת חשבונות מושבתת כרגע.</b>\n\nאנא נסה שוב מאוחר יותר.', { parse_mode: 'HTML' });
            return;
        }
        
        // Check limits — admins are fully exempt
        const limitCheck = canCreateAccount(chatId, { skipLimits: isAdmin(chatId) });
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
                let statusText = `${cleanText}\n\n${progressBar} ${progress}%`;
                if (statusText.length > 3900) {
                    statusText = clipForTelegram(statusText, 3900);
                }
                
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
            const failPayload = serializeErrorForLog(lastError);
            addLog(chatId, username, 'create_account', 'failed', failPayload, userInfo);
            console.error('[create_account failed]', lastError);
            clearProgress(chatId);
            const userLine = escapeHTML(clipForTelegram(lastError.message, 3500));
            try {
                await bot.sendMessage(chatId, `❌ <b>ההרשמה נכשלה:</b> ${userLine}`, { parse_mode: 'HTML' });
            } catch (sendErr) {
                console.error('sendMessage (registration failed):', sendErr.message || sendErr);
                await bot.sendMessage(chatId, '❌ <b>ההרשמה נכשלה.</b> פרטי השגיאה ארוכים מדי או השליחה נכשלה — נסה שוב.', { parse_mode: 'HTML' });
            }
            broadcastToClients({
                type: 'account_failed',
                chatId: chatId,
                username: username,
                error: failPayload.message
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
⏰ <b>תוקף החשבון:</b> יום אחד
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
            // Notify admins of new account with full details
            const displayName = (callbackQuery.from.first_name || '') + (callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : '');
            await notifyAdmins(
`✅ <b>חשבון חדש נוצר!</b>

━━━━━━━━━━━━━━━━━━━━
👤 <b>משתמש טלגרם:</b> ${escapeHTML(displayName || username)}
📱 <b>Username:</b> @${escapeHTML(username)}
🆔 <b>Chat ID:</b> <code>${chatId}</code>

━━━━━━━━━━━━━━━━━━━━
📧 <b>אימייל אתר:</b> <code>${escapeHTML(result.accountEmail)}</code>
🔑 <b>סיסמת אתר:</b> <code>${escapeHTML(result.accountPassword)}</code>

🎮 <b>שם משתמש Emby:</b> <code>${escapeHTML(result.embyUsername)}</code>
🔐 <b>סיסמת Emby:</b> <code>${escapeHTML(result.embyPassword)}</code>
━━━━━━━━━━━━━━━━━━━━`
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
        
        const navRow1 = [];
        const navRow2 = [];
        
        if (pageIndex > 0) {
            navRow1.push({ text: '◀️', callback_data: `admin_users_page_${pageIndex - 1}` });
        }
        
        navRow1.push({ text: `📄 ${pageIndex + 1}/${totalPages}`, callback_data: `admin_users_page_${pageIndex}` });
        
        if (pageIndex < totalPages - 1) {
            navRow1.push({ text: '▶️', callback_data: `admin_users_page_${pageIndex + 1}` });
        }

        if (totalPages > 2) {
            if (pageIndex > 0) navRow2.push({ text: '⏮️ התחלה', callback_data: `admin_users_page_0` });
            if (pageIndex > 4) navRow2.push({ text: '⏪ -5', callback_data: `admin_users_page_${Math.max(0, pageIndex - 5)}` });
            if (pageIndex < totalPages - 5) navRow2.push({ text: '+5 ⏩', callback_data: `admin_users_page_${Math.min(totalPages - 1, pageIndex + 5)}` });
            if (pageIndex < totalPages - 1) navRow2.push({ text: 'סוף ⏭️', callback_data: `admin_users_page_${totalPages - 1}` });
        }
        
        if (navRow1.length > 0) keyboard.push(navRow1);
        if (navRow2.length > 0) keyboard.push(navRow2);
        keyboard.push([{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]);
        
            // Update the message instead of sending new one if possible
            try {
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } catch (e) {
                // If text hasn't changed or other error, fallback
                if (!e.message.includes('message is not modified')) {
                    await bot.sendMessage(chatId, message, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: keyboard }
                    });
                }
            }
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

        const isTargetAdmin = isAdmin(targetUserId);
        const isEnvAdmin = ADMIN_CHAT_IDS_ARRAY.some(id => id == targetUserId);
        if (!isEnvAdmin) {
            if (isTargetAdmin) {
                keyboard.push([{ text: '👑 הסר הרשאות אדמין', callback_data: `admin_demote_${targetUserId}` }]);
            } else {
                keyboard.push([{ text: '⭐ קדם לאדמין', callback_data: `admin_promote_${targetUserId}` }]);
            }
        }

        if (isUnlimitedUser(targetUserId)) {
            keyboard.push([{ text: '🔒 הסר הרשאת ללא הגבלה', callback_data: `admin_unulimited_${targetUserId}` }]);
        } else {
            keyboard.push([{ text: '♾️ הפוך למשתמש ללא הגבלה', callback_data: `admin_unlimited_${targetUserId}` }]);
        }

        if (isWhitelisted(targetUserId)) {
            keyboard.push([{ text: '🗑 הסר מרשימה לבנה', callback_data: `admin_wl_remove_${targetUserId}` }]);
        } else {
            keyboard.push([{ text: '📋 הוסף לרשימה לבנה', callback_data: `admin_wl_add_${targetUserId}` }]);
        }

        if (isBroadcastExcluded(targetUserId)) {
            keyboard.push([{ text: '📢 הכלל בשידורים', callback_data: `admin_bex_remove_${targetUserId}` }]);
        } else {
            keyboard.push([{ text: '🔇 החרג משידורים', callback_data: `admin_bex_add_${targetUserId}` }]);
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
        
        else if (data.startsWith('admin_promote_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מקדם לאדמין...' });
            const targetUserId = data.replace('admin_promote_', '');
            const success = addDbAdmin(targetUserId);
            if (success) {
                await bot.sendMessage(chatId, `✅ משתמש ${targetUserId} קודם לאדמין בהצלחה.`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetUserId}` }]]
                    }
                });
                try {
                    await bot.sendMessage(parseInt(targetUserId), '🎉 <b>קודמת לאדמין!</b>\n\nכעת יש לך גישה לפאנל האדמין. השתמש ב-/admin כדי לגשת אליו.', { parse_mode: 'HTML' });
                } catch (e) { /* user may have blocked bot */ }
            } else {
                await bot.sendMessage(chatId, `⚠️ משתמש ${targetUserId} כבר אדמין.`);
            }
        }

        else if (data.startsWith('admin_demote_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מסיר הרשאות אדמין...' });
            const targetUserId = data.replace('admin_demote_', '');
            const success = removeDbAdmin(targetUserId);
            if (success) {
                await bot.sendMessage(chatId, `✅ הרשאות האדמין של משתמש ${targetUserId} הוסרו.`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetUserId}` }]]
                    }
                });
                try {
                    await bot.sendMessage(parseInt(targetUserId), '⚠️ הרשאות האדמין שלך הוסרו.', { parse_mode: 'HTML' });
                } catch (e) { /* user may have blocked bot */ }
            } else {
                await bot.sendMessage(chatId, `⚠️ משתמש ${targetUserId} אינו אדמין שניתן להסיר.`);
            }
        }

        else if (data.startsWith('admin_unlimited_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מגדיר כמשתמש ללא הגבלה...' });
            const targetUserId = data.replace('admin_unlimited_', '');
            const success = addUnlimitedUser(targetUserId);
            if (success) {
                await bot.sendMessage(chatId, `♾️ משתמש ${targetUserId} הוגדר כמשתמש ללא הגבלה.`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetUserId}` }]]
                    }
                });
                try {
                    await bot.sendMessage(parseInt(targetUserId), '♾️ <b>קיבלת הרשאת ללא הגבלה!</b>\n\nכעת אין לך מגבלה על מספר החשבונות או זמן ההמתנה.', { parse_mode: 'HTML' });
                } catch (e) { }
            } else {
                await bot.sendMessage(chatId, `⚠️ משתמש ${targetUserId} כבר ללא הגבלה.`);
            }
        }

        else if (data.startsWith('admin_unulimited_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מסיר הרשאת ללא הגבלה...' });
            const targetUserId = data.replace('admin_unulimited_', '');
            const success = removeUnlimitedUser(targetUserId);
            if (success) {
                await bot.sendMessage(chatId, `🔒 הרשאת ללא הגבלה של משתמש ${targetUserId} הוסרה.`, {
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetUserId}` }]]
                    }
                });
                try {
                    await bot.sendMessage(parseInt(targetUserId), '🔒 הרשאת ללא ההגבלה שלך הוסרה.', { parse_mode: 'HTML' });
                } catch (e) { }
            } else {
                await bot.sendMessage(chatId, `⚠️ משתמש ${targetUserId} אינו משתמש ללא הגבלה.`);
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
        
        else if (data === 'admin_search_user') {
            await bot.answerCallbackQuery(callbackQuery.id);
            adminStates.set(chatId, { action: 'admin_search_awaiting_query' });
            await bot.sendMessage(chatId, '🔍 <b>חיפוש משתמש</b>\n\nהזן שם משתמש, ID או שם פרטי לחיפוש:', { parse_mode: 'HTML' });
        }

        else if (data.startsWith('admin_bex_add_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מחריג משידורים...' });
            const targetId = data.replace('admin_bex_add_', '');
            addToBroadcastExclusion(targetId);
            await bot.sendMessage(chatId, `🔇 משתמש <code>${targetId}</code> הוחרג משידורים.`, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetId}` }]] }
            });
        }

        else if (data.startsWith('admin_bex_remove_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מבטל החרגה משידורים...' });
            const targetId = data.replace('admin_bex_remove_', '');
            removeFromBroadcastExclusion(targetId);
            await bot.sendMessage(chatId, `📢 משתמש <code>${targetId}</code> נכלל שוב בשידורים.`, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetId}` }]] }
            });
        }
        
        else if (data === 'admin_broadcast') {
            await bot.answerCallbackQuery(callbackQuery.id);
            const recipients = getBroadcastRecipients(!!REQUIRED_GROUP_ID);
            
            const broadcastMessage = `
📢 <b>שידור הודעה</b>

שלח את ההודעה שברצונך לשדר לכל המשתמשים:

━━━━━━━━━━━━━━━━━━━━
👥 <b>יקבלו:</b> ${recipients.length} משתמשים
${REQUIRED_GROUP_ID ? `<i>כולל חברי הקבוצה במעקב (הצטרפות / שימוש בבוט).</i>\n` : ''}
⚠️ <b>שים לב:</b>
• חסומים או מוחרגים משידור לא יקבלו גם אם הם בקבוצה
• התהליך עשוי לקחת זמן

<i>שלח את ההודעה או לחץ ביטול</i>
            `;
            
            adminStates.set(chatId, {
                action: 'broadcast_awaiting_message',
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
        
        else if (data.startsWith('admin_confirm_broadcast_')) {
            const broadcastMsgId = data.replace('admin_confirm_broadcast_', '');
            const users = getBroadcastRecipients(!!REQUIRED_GROUP_ID);
            const state = adminStates.get(chatId);
            
            // Log broadcast to database
            let broadcastId = null;
            if (state) {
                const broadcast = addBroadcast({
                    messagePreview: 'הודעת שידור', // Could be more descriptive if we saved the text
                    targetUrl: state.buttonUrl,
                    buttonLabel: state.buttonLabel
                });
                broadcastId = broadcast.id;
            }

            adminStates.delete(chatId);
            
            const statusMsg = await bot.sendMessage(chatId, `📢 מתחיל שידור ל-${users.length} משתמשים...`);
            
            let sent = 0;
            let failed = 0;
            
            for (const user of users) {
                try {
                    let replyMarkup = undefined;
                    if (state && state.buttonLabel && state.buttonUrl) {
                        let finalUrl = state.buttonUrl;
                        // Use tracking URL if PUBLIC_URL is set
                        if (PUBLIC_URL && broadcastId) {
                            finalUrl = `${PUBLIC_URL.replace(/\/$/, '')}/r/${broadcastId}`;
                        }
                        
                        replyMarkup = {
                            inline_keyboard: [[{ text: state.buttonLabel, url: finalUrl }]]
                        };
                    }

                    await bot.copyMessage(user.chatId, chatId, broadcastMsgId, {
                        reply_markup: replyMarkup
                    });
                    sent++;
                    // Rate limiting protection
                    await new Promise(resolve => setTimeout(resolve, 50));
                } catch (error) {
                    failed++;
                }
            }
            
            // Update stats in database
            if (broadcastId) {
                updateBroadcastStats(broadcastId, { sentCount: sent, failedCount: failed });
            }

            await bot.editMessageText(
                `✅ שידור הושלם!\n\n📤 נשלח: ${sent}\n❌ נכשל: ${failed}\n📊 סה"כ: ${users.length}`,
                {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]]
                    }
                }
            );
        }
        
        else if (data.startsWith('admin_add_button_')) {
            const broadcastMsgId = data.replace('admin_add_button_', '');
            bot.answerCallbackQuery(callbackQuery.id);
            
            adminStates.set(chatId, {
                action: 'broadcast_awaiting_button_label',
                broadcastMessageId: broadcastMsgId
            });
            
            await bot.sendMessage(chatId, '📝 <b>הזן את הטקסט של הכפתור:</b>\n(לדוגמה: "הצטרף לערוץ 👀")', { parse_mode: 'HTML' });
        }
        
        else if (data === 'admin_whitelist') {
            await bot.answerCallbackQuery(callbackQuery.id);
            const wl = getWhitelist();
            const enabled = isWhitelistEnabled();
            const allUsers = getAllUsers();

            let message = `📋 <b>רשימה לבנה</b>\n\n`;
            message += `סטטוס: ${enabled ? '🟢 פעיל — רק משתמשים ברשימה יכולים להשתמש' : '⚪ כבוי — כל המשתמשים יכולים להשתמש'}\n`;
            message += `סה"כ: <b>${wl.length}</b> משתמשים\n\n`;

            const keyboard = [];
            if (wl.length === 0) {
                message += `<i>הרשימה ריקה. הוסף משתמשים דרך כפתור "הוסף לרשימה לבנה" בפרטי משתמש, או בפקודה /whitelist @username</i>`;
            } else {
                wl.forEach(e => {
                    const u = allUsers.find(u => String(u.chatId) === String(e.chatId));
                    const name = u ? (u.firstName + (u.lastName ? ' ' + u.lastName : '')) : `ID ${e.chatId}`;
                    keyboard.push([{
                        text: `🗑 הסר: ${name}`,
                        callback_data: `admin_wl_remove_${e.chatId}`
                    }]);
                });
            }

            keyboard.push([{ text: enabled ? '🔴 כבה רשימה לבנה' : '🟢 הפעל רשימה לבנה', callback_data: 'admin_toggle_whitelist' }]);
            keyboard.push([{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]);

            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

        else if (data.startsWith('admin_wl_remove_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מסיר מהרשימה הלבנה...' });
            const targetId = data.replace('admin_wl_remove_', '');
            const success = removeFromWhitelist(targetId);
            if (success) {
                await bot.sendMessage(chatId, `🗑 משתמש <code>${targetId}</code> הוסר מהרשימה הלבנה.`, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetId}` }]] }
                });
                try { await bot.sendMessage(parseInt(targetId), '🔒 הוסרת מהרשימה הלבנה של הבוט.'); } catch (e) {}
            } else {
                await bot.sendMessage(chatId, `⚠️ משתמש לא נמצא ברשימה הלבנה.`);
            }
        }

        else if (data.startsWith('admin_wl_add_')) {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'מוסיף לרשימה הלבנה...' });
            const targetId = data.replace('admin_wl_add_', '');
            const success = addToWhitelist(targetId, chatId);
            if (success) {
                await bot.sendMessage(chatId, `✅ משתמש <code>${targetId}</code> נוסף לרשימה הלבנה.`, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 חזרה לפרטי משתמש', callback_data: `admin_user_${targetId}` }]] }
                });
                try { await bot.sendMessage(parseInt(targetId), '✅ נוספת לרשימה הלבנה — כעת יש לך גישה לבוט.'); } catch (e) {}
            } else {
                await bot.sendMessage(chatId, `⚠️ משתמש <code>${targetId}</code> כבר ברשימה הלבנה.`, { parse_mode: 'HTML' });
            }
        }

        else if (data === 'admin_toggle_whitelist') {
            const current = isWhitelistEnabled();
            setWhitelistEnabled(!current);
            const nowEnabled = !current;
            await bot.answerCallbackQuery(callbackQuery.id, { text: nowEnabled ? '🟢 רשימה לבנה הופעלה' : '⚪ רשימה לבנה כובתה' });
            await bot.sendMessage(chatId,
                nowEnabled
                    ? '🟢 <b>רשימה לבנה הופעלה.</b>\n\nרק משתמשים ברשימה הלבנה יוכלו להשתמש בבוט.'
                    : '⚪ <b>רשימה לבנה כובתה.</b>\n\nכל המשתמשים (שאינם חסומים) יוכלו להשתמש בבוט.',
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]] }
                }
            );
        }

        else if (data === 'admin_toggle_creation') {
            const current = isCreationEnabled();
            setCreationEnabled(!current);
            const nowEnabled = !current;
            await bot.answerCallbackQuery(callbackQuery.id, { text: nowEnabled ? '✅ יצירת חשבונות הופעלה' : '🔴 יצירת חשבונות הושבתה' });
            await bot.sendMessage(chatId,
                nowEnabled
                    ? '🟢 <b>יצירת חשבונות הופעלה.</b>\n\nמשתמשים יכולים כעת ליצור חשבונות.'
                    : '🔴 <b>יצירת חשבונות הושבתה.</b>\n\nמשתמשים לא יוכלו ליצור חשבונות עד שתפעיל מחדש.',
                {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]] }
                }
            );
        }

        else if (data === 'admin_menu') {
            
            try {
                await bot.answerCallbackQuery(callbackQuery.id);
                
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
                
                const creationOnCb = isCreationEnabled();
                const wlOnCb = isWhitelistEnabled();
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
                            { text: '🔍 חיפוש משתמש', callback_data: 'admin_search_user' },
                            { text: '🚫 חסומים', callback_data: 'admin_blacklist' }
                        ],
                        [
                            { text: creationOnCb ? '🟢 יצירה: פעיל' : '🔴 יצירה: כבוי', callback_data: 'admin_toggle_creation' },
                            { text: '📋 רשימה לבנה', callback_data: 'admin_whitelist' }
                        ],
                        [
                            { text: wlOnCb ? '🟢 רשימה לבנה: פעיל' : '⚪ רשימה לבנה: כבוי', callback_data: 'admin_toggle_whitelist' }
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

    if (requiredGroupChatIdMatches(chatId)) {
        if (msg.new_chat_members && msg.new_chat_members.length) {
            for (const u of msg.new_chat_members) {
                if (!u.is_bot) upsertGroupMember(u.id, u);
            }
        }
        if (msg.left_chat_member && !msg.left_chat_member.is_bot) {
            removeGroupMember(msg.left_chat_member.id);
        }
    }

    // Handle access code input (works for any user, not just admins)
    if (adminStates.has(chatId) && adminStates.get(chatId).action === 'access_code') {
        const text = (msg.text || '').trim();
        adminStates.delete(chatId);

        if (text.toLowerCase() === ACCESS_CODE.toLowerCase()) {
            addToWhitelist(chatId, 'access_code');
            const userInfo = {
                id: msg.from.id,
                username: msg.from.username,
                first_name: msg.from.first_name,
                last_name: msg.from.last_name
            };
            const username = msg.from.username || msg.from.first_name || 'Missing';
            addLog(chatId, username, 'start', 'success', null, userInfo);
            await bot.sendMessage(chatId, '✅ <b>קוד נכון! קיבלת גישה לבוט.</b>', { parse_mode: 'HTML' });
            await sendMainMenu(chatId);
            // Notify admins
            const displayName = (msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '');
            await notifyAdmins(`🔑 <b>משתמש חדש הצטרף עם קוד גישה</b>\n\n👤 ${escapeHTML(displayName || username)}\n🆔 <code>${chatId}</code>\n📱 @${escapeHTML(username)}`);
        } else {
            await bot.sendMessage(chatId, '❌ <b>קוד שגוי.</b> נסה שוב.', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔑 נסה שוב', callback_data: 'access_code_prompt' }]]
                }
            });
        }
        return;
    }

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

        else if (state.action === 'admin_search_awaiting_query') {
            const query = (text || '').toLowerCase().replace(/^@/, '').trim();
            adminStates.delete(chatId);
            
            const users = getAllUsers();
            const results = users.filter(u => {
                const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim().toLowerCase();
                return String(u.chatId).includes(query) || 
                       (u.username && u.username.toLowerCase().includes(query)) ||
                       fullName.includes(query) ||
                       (u.telegramUsername && u.telegramUsername.toLowerCase().includes(query));
            });

            if (results.length === 0) {
                await bot.sendMessage(chatId, '❌ <b>לא נמצאו משתמשים מתאימים.</b>', { 
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: '🔍 נסה שוב', callback_data: 'admin_search_user' }, { text: '🔙 תפריט', callback_data: 'admin_menu' }]] }
                });
                return;
            }

            let message = `🔍 <b>תוצאות חיפוש עבור "${text}":</b>\n\n`;
            const keyboard = [];
            
            // Show top 10 results
            results.slice(0, 10).forEach(u => {
                const displayName = (u.firstName || '') + (u.lastName ? ' ' + u.lastName : '');
                const accountsInfo = ` (${u.activeAccounts}/${u.accountCount})`;
                keyboard.push([{
                    text: `${displayName}${accountsInfo} • ${formatLastActivity(u.lastAction)}`,
                    callback_data: `admin_user_${u.chatId}`
                }]);
            });

            if (results.length > 10) {
                message += `<i>מציג 10 מתוך ${results.length} תוצאות...</i>\n`;
            }

            keyboard.push([{ text: '🔙 חזרה לתפריט', callback_data: 'admin_menu' }]);

            await bot.sendMessage(chatId, message, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        }
        
        else if (state.action === 'ban') {
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
                await bot.sendMessage(state.targetUserId, message, {
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
        
        else if (state.action === 'broadcast_awaiting_message' || state.action === 'broadcast_confirm_with_button') {
            const isUpdate = state.action === 'broadcast_confirm_with_button';
            const msgId = isUpdate ? state.broadcastMessageId : msg.message_id;
            
            const keyboard = [
                [
                    { text: '✅ שלח לכולם', callback_data: `admin_confirm_broadcast_${msgId}` },
                    { text: '➕ הוסף כפתור', callback_data: `admin_add_button_${msgId}` }
                ],
                [{ text: '❌ ביטול', callback_data: 'admin_menu' }]
            ];

            const replyMarkup = { inline_keyboard: keyboard };
            
            // If we have a button already, show it in the preview
            let broadcastReplyMarkup = undefined;
            if (state.buttonLabel && state.buttonUrl) {
                broadcastReplyMarkup = {
                    inline_keyboard: [[{ text: state.buttonLabel, url: state.buttonUrl }]]
                };
            }

            const previewMsg = await bot.copyMessage(chatId, chatId, msgId, {
                reply_markup: broadcastReplyMarkup || replyMarkup
            });
            
            adminStates.set(chatId, {
                ...state,
                action: 'broadcast_ready',
                broadcastMessageId: msgId,
                previewMessageId: previewMsg.message_id
            });
            
            const helpText = state.buttonLabel ? '✅ <b>הכפתור נוסף בהצלחה!</b>\n\nבדוק את התצוגה המקדימה למעלה.' : '☝️ <b>זהו קדימון להודעה שלך.</b>\n\nניתן להוסיף כפתור קישור או לשלוח מיד.';
            await bot.sendMessage(chatId, helpText, { 
                parse_mode: 'HTML',
                reply_markup: broadcastReplyMarkup ? { inline_keyboard: keyboard } : undefined
            });
            return;
        }

        else if (state.action === 'broadcast_awaiting_button_label') {
            const label = (msg.text || '').trim();
            if (!label) {
                await bot.sendMessage(chatId, '❌ טקסט הכפתור אינו יכול להיות ריק. נסה שוב:');
                return;
            }
            
            adminStates.set(chatId, {
                ...state,
                action: 'broadcast_awaiting_button_url',
                buttonLabel: label
            });
            
            await bot.sendMessage(chatId, `✅ הטקסט נשמר: <b>${label}</b>\n\n🌐 כעת הזן את הקישור (URL) של הכפתור:`, { parse_mode: 'HTML' });
            return;
        }

        else if (state.action === 'broadcast_awaiting_button_url') {
            const url = (msg.text || '').trim();
            if (!url.startsWith('http')) {
                await bot.sendMessage(chatId, '❌ קישור לא תקין. עליו להתחיל ב-http:// או https://. נסה שוב:');
                return;
            }
            
            adminStates.set(chatId, {
                ...state,
                action: 'broadcast_confirm_with_button',
                buttonUrl: url
            });
            
            // Trigger the preview again but with the button
            await bot.sendMessage(chatId, '🔄 מעדכן תצוגה מקדימה...');
            // We simulate a message to trigger the preview logic (or we can just call it)
            // But it's easier to just redirect manually here or trigger a handler.
            // Let's just run the code for broadcast_confirm_with_button manually.
            const keyboard = [
                [
                    { text: '✅ שלח לכולם', callback_data: `admin_confirm_broadcast_${state.broadcastMessageId}` },
                    { text: '🔄 שנה כפתור', callback_data: `admin_add_button_${state.broadcastMessageId}` }
                ],
                [{ text: '❌ ביטול', callback_data: 'admin_menu' }]
            ];

            const broadcastReplyMarkup = {
                inline_keyboard: [[{ text: state.buttonLabel, url: url }]]
            };

            const previewMsg = await bot.copyMessage(chatId, chatId, state.broadcastMessageId, {
                reply_markup: broadcastReplyMarkup
            });

            adminStates.set(chatId, {
                ...state,
                action: 'broadcast_ready',
                buttonUrl: url,
                previewMessageId: previewMsg.message_id
            });

            await bot.sendMessage(chatId, '✅ <b>הכפתור נוסף!</b>\n\nהאם לשלוח את ההודעה לכולם?', { 
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        }
    }
    
    // Regular message handling for non-admins or admins not in conversation
    if (msg.text && !msg.text.startsWith('/')) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        // Group gate first
        if (REQUIRED_GROUP_ID && !isAdmin(chatId) && !(await hasJoinedGroup(userId))) {
            await sendJoinRequiredMessage(chatId);
            return;
        }
        if (isBlacklisted(chatId)) {
            await bot.sendMessage(chatId, '🚫 אינך יכול להשתמש בבוט זה.');
            return;
        }
        if (isWhitelistBlocked(chatId)) {
            await bot.sendMessage(chatId, '🔒 גישה מוגבלת. פנה למנהל הבוט לקבלת גישה.');
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

// Lightweight endpoint for uptime monitors and Render keep-alive (self-ping via PUBLIC_URL)
app.get('/health', (req, res) => {
    res.type('text/plain').send('ok');
});

// Analytics Redirect Route
app.get('/r/:id', (req, res) => {
    const id = req.params.id;
    const targetUrl = logBroadcastClick(id, {
        ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
        userAgent: req.headers['user-agent']
    });
    
    if (targetUrl) {
        res.redirect(targetUrl);
    } else {
        res.status(404).send('Link not found');
    }
});

// API Endpoints — lightweight stats for dashboard polling
app.get('/api/stats', (req, res) => {
    const data = getLogs();
    const logs = Array.isArray(data.logs) ? data.logs : [];
    res.json({
        stats: data.stats || { totalCreated: 0, activeUsers: 0 },
        logsTotal: logs.length
    });
});

// Logs slice only (avoid sending full db.json over the wire)
app.get('/api/logs', (req, res) => {
    const data = getLogs();
    const stats = data.stats || { totalCreated: 0, activeUsers: 0 };
    const allLogs = Array.isArray(data.logs) ? data.logs : [];
    const raw = parseInt(req.query.limit, 10);
    const limit = Math.min(2000, Math.max(50, Number.isFinite(raw) ? raw : 300));
    res.json({
        stats,
        logs: allLogs.slice(0, limit),
        logsTotal: allLogs.length,
        logsReturned: Math.min(limit, allLogs.length)
    });
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

app.get('/api/broadcasts', (req, res) => {
    res.json(getBroadcasts());
});

app.post('/api/toggle-broadcast-exclusion', (req, res) => {
    const { chatId, excluded } = req.body;
    if (!chatId) return res.status(400).json({ error: 'Missing chatId' });

    if (excluded) {
        addToBroadcastExclusion(chatId);
    } else {
        removeFromBroadcastExclusion(chatId);
    }
    res.json({ success: true, isBroadcastExcluded: isBroadcastExcluded(chatId) });
});

function startKeepAliveSelfPing() {
    if (!KEEP_ALIVE_SELF_PING) {
        if (!PUBLIC_URL) {
            console.log('Keep-alive: off (set PUBLIC_URL to your public https origin to auto-enable self-ping)');
        } else {
            console.log('Keep-alive: off (KEEP_ALIVE_SELF_PING=false)');
        }
        return;
    }
    const base = PUBLIC_URL.replace(/\/$/, '');
    if (!base) {
        console.warn('KEEP_ALIVE_SELF_PING wanted but PUBLIC_URL is empty; add PUBLIC_URL=https://your-host');
        return;
    }
    const url = `${base}/health`;
    const ping = () => {
        fetch(url, { method: 'GET', headers: { Accept: 'text/plain' } })
            .then((r) => {
                if (!r.ok) console.warn(`Keep-alive ping: HTTP ${r.status} ${url}`);
            })
            .catch((e) => console.warn('Keep-alive ping failed:', e.message));
    };
    ping();
    setInterval(ping, KEEP_ALIVE_INTERVAL_MS);
    console.log(
        `Keep-alive: GET ${url} every ${KEEP_ALIVE_INTERVAL_MS / 1000}s (stays under typical 15m free-tier idle limit)`
    );
}

server.listen(port, () => {
    console.log(`Listening on port ${port}`);
    startKeepAliveSelfPing();

    const supabaseMergeMs = parseInt(process.env.SUPABASE_MERGE_INTERVAL_MS || '3600000', 10);
    if (supabaseMergeMs > 0) {
        setInterval(() => {
            pullSupabaseGroupMembersIntoMemDb().catch((e) =>
                console.warn('[database] Supabase roster pull:', e.message)
            );
        }, supabaseMergeMs);
        console.log(
            `Supabase roster: pull missing members every ${Math.round(supabaseMergeMs / 1000)}s (set SUPABASE_MERGE_INTERVAL_MS=0 to disable)`
        );
    }
});
