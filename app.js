// Load environment variables
require('dotenv').config();

const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
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

console.log('הבוט פועל...');

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
                console.log(`Expiry notification sent to ${chatId}`);
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

// Admin Chat ID - Loaded from environment variables
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? parseInt(process.env.ADMIN_CHAT_ID) : null;

// Bot Logic
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name || 'Missing';
    const userInfo = {
        id: msg.from.id,
        username: msg.from.username,
        first_name: msg.from.first_name,
        last_name: msg.from.last_name
    };

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
    return chatId == ADMIN_CHAT_ID;
}

// Store admin conversation states
const adminStates = new Map();

// Handle ALL callback queries in one place
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const username = callbackQuery.from.username || callbackQuery.from.first_name || 'Missing';
    const data = callbackQuery.data;
    const userInfo = {
        id: callbackQuery.from.id,
        username: callbackQuery.from.username,
        first_name: callbackQuery.from.first_name,
        last_name: callbackQuery.from.last_name
    };

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

        try {
            const result = await run(updateStatus);
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
        } catch (error) {
            addLog(chatId, username, 'create_account', 'failed', error.message, userInfo);
            clearProgress(chatId);
            await bot.sendMessage(chatId, `❌ <b>ההרשמה נכשלה:</b> ${escapeHTML(error.message)}`, { parse_mode: 'HTML' });
            
            // Broadcast failure
            broadcastToClients({
                type: 'account_failed',
                chatId: chatId,
                username: username,
                error: error.message
            });
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
        // Check admin permission for all admin actions
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
        
        else if (data === 'admin_users') {
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
        
        // Show users with buttons to view details
        const pageSize = 8;
        let message = `👥 <b>רשימת משתמשים (${users.length})</b>\n\n`;
        message += `<i>לחץ על משתמש לצפייה בפרטים ופעולות</i>\n`;
        
        const keyboard = [];
        users.slice(0, pageSize).forEach((user) => {
            const displayName = user.firstName + (user.lastName ? ' ' + user.lastName : '');
            const blacklistIcon = user.isBlacklisted ? '🚫 ' : '';
            const accountsInfo = ` (${user.activeAccounts}/${user.accountCount})`;
            
            keyboard.push([{
                text: `${blacklistIcon}${displayName}${accountsInfo}`,
                callback_data: `admin_user_${user.chatId}`
            }]);
        });
        
        if (users.length > pageSize) {
            message += `\n<i>מציג ${pageSize} מתוך ${users.length} ראשונים</i>`;
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
                
                userMessage += `\n${idx + 1}. ${status} ${acc.embyUsername}`;
                userMessage += `\n   ⏰ ${timeLeft}\n`;
            });
        }
        
        userMessage += `\n📅 <b>פעילות אחרונה:</b> ${user.lastAction}`;
        
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
                        { text: '🚫 חסומים', callback_data: 'admin_blacklist' },
                        { text: '🌐 Dashboard', url: `http://localhost:${port}` }
                    ]
                ]
            };
            
            await bot.editMessageText(adminMenu, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id,
                parse_mode: 'HTML',
                reply_markup: keyboard
            });
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
        
        // Block blacklisted users
        if (isBlacklisted(chatId)) {
            bot.sendMessage(chatId, '🚫 אינך יכול להשתמש בבוט זה.');
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

app.use(bodyParser.json());
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
    console.log(`Admin Dashboard running at http://localhost:${port}`);
});
