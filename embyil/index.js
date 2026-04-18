const TempMailAPI = require('./tinyhost');
const { generateNumericString, generateUsername5, generateStrongPassword } = require('../utils');

// Public site origin for signup API. Override if Cloudflare blocks your bot host: use a direct origin
// (e.g. DNS-only hostname) or leave default and fix WAF / Bot Fight Mode for /api on this host.
const API_ORIGIN = (process.env.EMBY_API_ORIGIN || 'https://emby.embyiltv.io').replace(/\/$/, '');
const API_BASE = `${API_ORIGIN}/api`;

/** Avoid multi‑MB HTML (e.g. Cloudflare challenge) becoming Error.message and breaking Telegram (4096 cap). */
function summarizeHttpErrorText(text, status) {
    if (typeof text !== 'string') return String(text || '');
    const head = text.slice(0, 2800).toLowerCase();
    if (
        head.includes('<!doctype html') ||
        head.includes('just a moment') ||
        head.includes('_cf_chl_opt') ||
        head.includes('challenge-platform') ||
        head.includes('/cdn-cgi/challenge') ||
        head.includes('cf-browser-verification')
    ) {
        return `השרת חסם את הבקשה (דף אבטחה / Cloudflare). HTTP ${status}. נסה שוב מאוחר יותר או פנה לתמיכה.`;
    }
    if (text.length > 900) return text.slice(0, 880) + '…';
    return text;
}

const DEFAULT_HEADERS = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Origin: API_ORIGIN,
    Referer: `${API_ORIGIN}/`,
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
};

async function apiJson(method, path, { body, token } = {}) {
    const headers = { ...DEFAULT_HEADERS };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = text;
        }
    }
    if (!res.ok) {
        let errMsg =
            (data && typeof data === 'object' && data.error) ||
            (typeof data === 'string' ? data : null) ||
            res.statusText;
        if (typeof errMsg === 'string') errMsg = summarizeHttpErrorText(errMsg, res.status);
        const err = new Error(errMsg || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = data;
        throw err;
    }
    return data;
}

function extractConfirmationToken(verifyLink) {
    const u = new URL(verifyLink.replace(/&amp;/g, '&'));
    const q = u.searchParams.get('token');
    if (q) return q;
    const m = u.pathname.match(/\/confirmation-token\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
    throw new Error('קישור אימות ללא token');
}

/** Try common search body shapes until one succeeds (API is not documented publicly). */
async function searchSubscriptions(accessToken) {
    const attempts = [
        { page: 0, size: 10, sorts: [] },
        { page: 0, sorts: [] },
        { pagination: { page: 0, size: 20 }, sorts: [] }
    ];
    let lastErr;
    for (const body of attempts) {
        try {
            return await apiJson('POST', '/subscriptions/search', { body, token: accessToken });
        } catch (e) {
            lastErr = e;
            if (e.status !== 400 && e.status !== 422) throw e;
        }
    }
    throw lastErr;
}

function responseContainsLogin(searchData, login) {
    const s = typeof searchData === 'string' ? searchData : JSON.stringify(searchData);
    return s.includes(login);
}

async function run(statusCallback = () => {}) {
    const tempMail = new TempMailAPI();

    try {
        statusCallback('[5%] ⚙️ מכין את פרטי החשבון החדש...');

        const domainData = await tempMail.getRandomDomains(1);
        const domain = domainData.domains[0];
        const username = generateUsername5();
        const email = `${username}@${domain}`;
        const password = generateStrongPassword();

        statusCallback(`[12%] 📧 אימייל זמני: <code>${email}</code>`);

        statusCallback('[20%] 📝 שולח הרשמה (API)...');
        await apiJson('POST', '/auth/signup', {
            body: {
                firstName: 'John',
                lastName: 'Doe',
                email,
                password
            }
        });

        statusCallback('[42%] ✅ בקשת הרשמה נשלחה.');
        statusCallback('[50%] ⏳ ממתין לאימייל אימות...');

        const emailDetail = await tempMail.pollForEmail(
            domain,
            username,
            { senderKeyword: 'noreply@embyiltv.io' },
            300000,
            2000
        );

        statusCallback('[65%] ✅ אימייל האימות התקבל!');

        const linkRegex = /https?:\/\/[^\s"'<>]+/g;
        const links = (emailDetail.html_body || '').match(linkRegex) || [];
        const verifyLink = links.find(
            (l) =>
                l.includes('verify') ||
                l.includes('confirm') ||
                l.includes('sign-up') ||
                l.includes('email-confirmation') ||
                l.includes('activation') ||
                l.includes('confirm-email') ||
                l.includes('token') ||
                l.includes('confirmation-token')
        );

        if (!verifyLink) {
            console.error('Links in email:', links);
            throw new Error('קישור אימות לא נמצא באימייל');
        }

        statusCallback('[75%] 🔗 מאמת חשבון (API)...');
        const token = extractConfirmationToken(verifyLink);
        await apiJson('GET', `/confirmation-token?token=${encodeURIComponent(token)}`);

        statusCallback('[82%] 🔓 מתחבר (API)...');
        const auth = await apiJson('POST', '/auth/signin', {
            body: { login: email, password }
        });
        const accessToken = auth.accessToken;
        const userUuid = auth.userUuid;
        if (!accessToken || !userUuid) {
            throw new Error('תגובת התחברות חסרה accessToken או userUuid');
        }

        const embyLogin = generateNumericString(6);
        const embyPassword = '1111';

        statusCallback('[92%] 📋 יוצר מנוי ניסיון (API)...');
        await apiJson('POST', `/subscriptions/users/${userUuid}/trial`, {
            body: {
                login: embyLogin,
                password: embyPassword,
                confirmPassword: embyPassword
            },
            token: accessToken
        });

        statusCallback('[97%] ✨ מאמת יצירת מנוי...');
        const searchData = await searchSubscriptions(accessToken);
        if (!responseContainsLogin(searchData, embyLogin)) {
            throw new Error('המנוי לא נוצר — שם המשתמש לא נמצא בתוצאות החיפוש');
        }

        statusCallback('[100%] 🎊 הכל מוכן!');
        return {
            accountEmail: email,
            accountPassword: password,
            embyUsername: embyLogin,
            embyPassword: embyPassword
        };
    } catch (error) {
        const short = typeof error.message === 'string' ? summarizeHttpErrorText(error.message, error.status || 0) : error.message;
        statusCallback(`שגיאה: ${short}`);
        throw error;
    }
}

module.exports = { run };

if (require.main === module) {
    run((msg) => console.log(msg))
        .then((acc) => {
            console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Account / חשבון
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Website email:    ${acc.accountEmail}
Website password: ${acc.accountPassword}

Emby username:    ${acc.embyUsername}
Emby password:    ${acc.embyPassword}
Player:           https://play.embyil.tv/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
JSON (copy):
${JSON.stringify(acc, null, 2)}
`);
        })
        .catch((err) => {
            console.error('שגיאה סופית:', err);
            process.exitCode = 1;
        });
}
