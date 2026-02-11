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
    markNotificationSent
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
const bot = new TelegramBot(token, { polling: true });
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

// Admin command: List all users
bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const data = getLogs();
        
        // Get unique users from logs
        const usersMap = new Map();
        data.logs.forEach(log => {
            if (log.chatId && log.username && log.username !== 'ADMIN') {
                if (!usersMap.has(log.chatId)) {
                    usersMap.set(log.chatId, {
                        chatId: log.chatId,
                        username: log.username,
                        firstName: log.userInfo?.first_name || log.username,
                        lastName: log.userInfo?.last_name || '',
                        telegramUsername: log.userInfo?.username || null,
                        lastAction: log.timestamp
                    });
                }
            }
        });
        
        const users = Array.from(usersMap.values());
        
        if (users.length === 0) {
            await bot.sendMessage(chatId, '❌ אין משתמשים רשומים במערכת.');
            return;
        }
        
        // Sort by most recent activity
        users.sort((a, b) => new Date(b.lastAction) - new Date(a.lastAction));
        
        // Create message with clickable user links
        let message = `👥 <b>רשימת משתמשים (${users.length})</b>\n\n`;
        
        users.forEach((user, index) => {
            const displayName = user.firstName + (user.lastName ? ' ' + user.lastName : '');
            const usernameTag = user.telegramUsername ? `@${user.telegramUsername}` : '';
            
            // Create a clickable mention link using user ID
            message += `${index + 1}. <a href="tg://user?id=${user.chatId}">${escapeHTML(displayName)}</a>`;
            
            if (usernameTag) {
                message += ` (${usernameTag})`;
            }
            
            message += `\nID: <code>${user.chatId}</code>\n\n`;
        });
        
        message += '\n💡 <i>לחץ על שם המשתמש כדי לפתוח צ\'אט איתו</i>';
        
        await bot.sendMessage(chatId, message, { 
            parse_mode: 'HTML',
            disable_web_page_preview: true 
        });
        
    } catch (error) {
        console.error('Error in /list command:', error);
        await bot.sendMessage(chatId, '❌ שגיאה בטעינת רשימת המשתמשים.');
    }
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const username = callbackQuery.from.username || callbackQuery.from.first_name || 'Missing';
    const action = callbackQuery.data;
    const userInfo = {
        id: callbackQuery.from.id,
        username: callbackQuery.from.username,
        first_name: callbackQuery.from.first_name,
        last_name: callbackQuery.from.last_name
    };

    if (action === 'create_account') {
        bot.answerCallbackQuery(callbackQuery.id);
        
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
});

// Handle "My Accounts" callback
bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data === 'my_accounts') {
        const chatId = callbackQuery.message.chat.id;
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
});

// Handle all text messages (for chat)
bot.on('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
        const chatId = msg.chat.id;
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
