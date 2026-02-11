// Load environment variables
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { run } = require('./index');
const { addLog } = require('./database');

const token = process.env.TELEGRAM_BOT_TOKEN;

// Validate token
if (!token) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in .env file');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

console.log('הבוט פועל...');

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

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name || 'Unknown';

    addLog(chatId, username, 'start', 'success');

    bot.sendMessage(chatId, 'ברוכים הבאים לבוט ההרשמה האוטומטי של embyIL! לחץ על הכפתור למטה כדי ליצור חשבון.', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🚀 צור חשבון ניסיון ל-3 ימים', callback_data: 'create_account' }]
            ]
        }
    });
});

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const username = callbackQuery.from.username || callbackQuery.from.first_name || 'Unknown';
    const action = callbackQuery.data;

    if (action === 'create_account') {
        bot.answerCallbackQuery(callbackQuery.id);
        addLog(chatId, username, 'create_account', 'pending');

        const statusMsg = await bot.sendMessage(chatId, '⏳ מתחיל תהליך הרשמה...');

        const updateStatus = async (text) => {
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: statusMsg.message_id
                });
            } catch (e) {
                // Fallback
            }
        };

        try {
            const result = await run(updateStatus);

            addLog(chatId, username, 'create_account', 'success', result);

            const finalMessage = `
<b>✅ ההרשמה הושלמה בהצלחה!</b>

<b>פרטי החשבון במערכת:</b>
📧 אימייל: <code>${escapeHTML(result.accountEmail)}</code>
🔑 סיסמה: <code>${escapeHTML(result.accountPassword)}</code>

<b>פרטי התחברות לנגן Emby:</b>
👤 שם משתמש: <code>${escapeHTML(result.embyUsername)}</code>
🔑 סיסמה: <code>${escapeHTML(result.embyPassword)}</code>

<b>כתובת הנגן:</b> https://play.embyil.tv/
      `;

            await bot.sendMessage(chatId, finalMessage, { parse_mode: 'HTML' });
        } catch (error) {
            addLog(chatId, username, 'create_account', 'failed', error.message);
            await bot.sendMessage(chatId, `❌ <b>ההרשמה נכשלה:</b> ${escapeHTML(error.message)}`, { parse_mode: 'HTML' });
        }
    }
});
