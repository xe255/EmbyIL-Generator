const TempMailAPI = require('./tinyhost');
const { generateNumericString, generateUsername5, generateStrongPassword } = require('../utils');

// Canonical site (Origin / Referer). Keep the real public site even when TCP goes through a relay.
const EMBY_CANONICAL_ORIGIN = (process.env.EMBY_API_ORIGIN || 'https://emby.embyiltv.io').replace(/\/$/, '');
// Where HTTP actually connects (default: same host + /api). Use relay URL for free residential egress — see scripts/emby-api-relay.js
const API_BASE = (process.env.EMBY_API_FETCH_BASE || `${EMBY_CANONICAL_ORIGIN}/api`).replace(/\/$/, '');
/** Explicit fetch base (usually trycloudflare / home relay). When set, proxies must not wrap this hop — see createEmbyFetch. */
const EMBY_API_FETCH_BASE_SET = Boolean((process.env.EMBY_API_FETCH_BASE || '').trim());
const EMBY_RELAY_SECRET = (process.env.EMBY_RELAY_SECRET || '').trim();
if (process.env.EMBY_API_FETCH_BASE) {
    console.log(`[embyil] API fetch base: ${API_BASE} (canonical Origin: ${EMBY_CANONICAL_ORIGIN})`);
}

/**
 * Proxied fetch for Emby API. HTTP proxies use undici; SOCKS5/4 must use socks-proxy-agent (HTTP CONNECT is different).
 * If EMBY_API_FETCH_BASE is set (relay / alternate API host), uses direct fetch only — proxies are not applied to that hop.
 * Optional EMBY_PROXY_LIST_INLINE / EMBY_PROXY_LIST_FILE (Webshare-style host:port:user:pass lines)
 * bypasses the free pool gate like a static proxy.
 */
function createEmbyFetch() {
    const forceProxyWithRelay = /^1|true|yes|on$/i.test(
        String(process.env.EMBY_FORCE_PROXY_WITH_RELAY || '').trim()
    );
    if (EMBY_API_FETCH_BASE_SET && !forceProxyWithRelay) {
        console.log(
            '[embyil] Emby API client: direct HTTPS to EMBY_API_FETCH_BASE (relay / alternate API host — ZenRows & trusted list & FREE_PROXY_POOL skipped). Remove EMBY_API_FETCH_BASE to use ZENROWS_API_KEY or EMBY_PROXY_LIST_* again.'
        );
        return globalThis.fetch.bind(globalThis);
    }

    const proxy = (
        process.env.EMBY_SOCKS_PROXY ||
        process.env.EMBY_HTTPS_PROXY ||
        process.env.HTTPS_PROXY ||
        ''
    ).trim();

    const trustedList = (process.env.EMBY_PROXY_LIST_INLINE || process.env.EMBY_PROXY_LIST || process.env.EMBY_PROXY_LIST_FILE || '').trim();

    // Egress priority: explicit proxy → trusted list → public pool → ZenRows (paid API; 402 = credits/billing) → direct
    if (proxy) {
        const isSocks = /^socks5?:\/\//i.test(proxy) || /^socks4a?:\/\//i.test(proxy) || /^socks4:\/\//i.test(proxy);
        if (isSocks) {
            try {
                const nodeFetch = require('node-fetch');
                const { SocksProxyAgent } = require('socks-proxy-agent');
                const agent = new SocksProxyAgent(proxy);
                console.log('[embyil] Emby API client: SOCKS proxy → node-fetch');
                return (url, init) =>
                    nodeFetch(url, {
                        method: init.method || 'GET',
                        headers: init.headers,
                        body: init.body,
                        agent,
                        compress: true
                    });
            } catch (e) {
                console.warn('[embyil] SOCKS proxy failed to init:', e.message);
                console.warn('[embyil] falling back to direct fetch (may be blocked by Cloudflare)');
                return globalThis.fetch.bind(globalThis);
            }
        }

        try {
            const { fetch: undiciFetch, ProxyAgent } = require('undici');
            const dispatcher = new ProxyAgent(proxy);
            console.log('[embyil] Emby API client: HTTP proxy → undici');
            return (url, init) => undiciFetch(url, { ...init, dispatcher });
        } catch (e) {
            console.warn('[embyil] HTTP proxy (undici) failed:', e.message);
            console.warn('[embyil] falling back to direct fetch (may be blocked by Cloudflare)');
            return globalThis.fetch.bind(globalThis);
        }
    }

    if (trustedList) {
        try {
            const trusted = require('./trusted-proxy-list');
            const count = trusted.loadFromDisk();
            const mt = (process.env.EMBY_PROXY_LIST_MAX_TRIES || '5').trim();
            const proto = (process.env.EMBY_TRUSTED_PROXY_PROTOCOL || 'http').trim();
            console.log(
                `[embyil] Emby API client: trusted proxy list (${count} endpoints, ${proto}, max ${mt} tries/request — low bandwidth vs FREE_PROXY_POOL)`
            );
            return (reqUrl, init) => trusted.fetchThrough(reqUrl, init);
        } catch (e) {
            console.warn('[embyil] trusted proxy list failed:', e.message);
        }
    }

    const poolOn = /^1|true|yes|on$/i.test(String(process.env.FREE_PROXY_POOL || '').trim());
    if (poolOn) {
        try {
            const pool = require('./free-proxy-pool');
            pool.configure({ canonicalOrigin: EMBY_CANONICAL_ORIGIN });
            pool.startFreeProxyPoolLoop();
            console.log('[embyil] Emby API client: FREE_PROXY_POOL (GitHub + proxycheck + probes)');
            return (url, init) => pool.fetchThroughPool(url, init);
        } catch (e) {
            console.warn('[embyil] free-proxy-pool failed to load:', e.message);
        }
    }

    const zenKey = (process.env.ZENROWS_API_KEY || '').trim();
    if (zenKey) {
        try {
            const zr = require('./zenrows-fetch');
            const pv = process.env.ZENROWS_PREMIUM_PROXY;
            const prem =
                pv === undefined || String(pv).trim() === ''
                    ? true
                    : /^1|true|yes|on$/i.test(String(pv).trim());
            const jr =
                process.env.ZENROWS_JS_RENDER === undefined || String(process.env.ZENROWS_JS_RENDER).trim() === ''
                    ? true
                    : /^1|true|yes|on$/i.test(String(process.env.ZENROWS_JS_RENDER).trim());
            console.log(
                `[embyil] Emby API client: ZenRows Universal API (residential: ${prem ? 'on' : 'off'}, js_render: ${jr ? 'on' : 'off'})`
            );
            return (reqUrl, init) => zr.fetchThrough(reqUrl, init);
        } catch (e) {
            console.warn('[embyil] zenrows-fetch failed to load:', e.message);
        }
    }

    console.warn(
        '[embyil] Emby API client: direct fetch (set FREE_PROXY_POOL=1, ZENROWS_API_KEY, or EMBY_HTTPS_PROXY if Cloudflare blocks this host)'
    );
    return globalThis.fetch.bind(globalThis);
}

const embyFetch = createEmbyFetch();

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
    Origin: EMBY_CANONICAL_ORIGIN,
    Referer: `${EMBY_CANONICAL_ORIGIN}/`,
    'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
};

function clarifyFetchError(err) {
    const msg = err && err.message ? String(err.message) : '';
    if (/trusted-proxy-list:/i.test(msg)) {
        if (/socks5 authentication failed|authentication failed|proxy auth rejected|407/i.test(msg)) {
            return new Error(
                'אימות פרוקסי נכשל (SOCKS/HTTP): עדכן את הרשימה מ-Webshare או בדוק שורות host:port:user:pass. נסה EMBY_TRUSTED_PROXY_PROTOCOL=http אם הפרוקסי הוא HTTP ולא SOCKS. אם גם אז יש רק 403 — Cloudflare חוסם יציאת דאטאסנטר; אז relay ביתי + EMBY_API_FETCH_BASE.'
            );
        }
        if (/timed out|abort|cancel/i.test(msg)) {
            return new Error(
                'פרוקסי SOCKS איטי או נתקע — הבקשה בוטלה אחרי timeout. הגדל ב-Render את EMBY_PROXY_REQUEST_TIMEOUT_MS (ברירת מחדל 30000) או הסר מהרשימה את הכתובת הבעייתית. אם רוב השורות מקבלות 403 מ-Cloudflare, relay ביתי + EMBY_API_FETCH_BASE עדיין נדרש.'
            );
        }
        return new Error(
            'פרוקסי מקובץ (Webshare וכד׳) נכשלו בכל הניסיונות לבקשה זו. אם Cloudflare חוסם את כל כתובות היציאה — השתמש ב-relay ביתי: הרץ scripts/emby-api-relay.js + מנהרת trycloudflare, הגדר ב-Render את EMBY_API_FETCH_BASE והסר את רשימת הפרוקסי (אחרת המנהרה לא תופעל). אפשר גם להגדיל EMBY_PROXY_LIST_MAX_TRIES אם חלק מהכתובות עובדות.'
        );
    }
    if (/free-proxy-pool:/i.test(msg)) {
        return new Error(
            'כל פרוקסי ה־HTTP במאגר נכשלו או שהמאגר ריק. רשימות פרוקסי ציבוריות בדרך כלל לא מספיקות לאתרים מאובטחים. מומלץ: relay ביתי + EMBY_API_FETCH_BASE (ראה scripts/emby-api-relay.js), או EMBY_HTTPS_PROXY/ SOCKS בתשלום. אפשר גם להרחיב FREE_PROXY_LIST_URL (כמה כתובות מופרדות בפסיק) ולנסות שוב בעוד מספר דקות.'
        );
    }
    if (/NotAllowed/i.test(msg)) {
        return new Error(
            'הפרוקסי (SOCKS) דחה את החיבור — NotAllowed. אצל ספק ה-proxy: הרשאת יעד לדומיין emby.embyiltv.io (פורט 443), או רשימת IP מקור מורשים (ייתכן ש-Render חסום). נסה HTTP-proxy אחר או relay ביתי.'
        );
    }
    if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|certificate|SSL/i.test(msg)) {
        return new Error(`רשת / TLS: ${msg}`);
    }
    return err;
}

async function apiJson(method, path, { body, token } = {}) {
    const headers = { ...DEFAULT_HEADERS };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (EMBY_RELAY_SECRET) headers['X-Emby-Relay-Secret'] = EMBY_RELAY_SECRET;
    let res;
    try {
        res = await embyFetch(`${API_BASE}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch (e) {
        throw clarifyFetchError(e);
    }
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

        statusCallback('[92%] 📋 יוצר חשבון (API)...');
        await apiJson('POST', `/subscriptions/users/${userUuid}/trial`, {
            body: {
                login: embyLogin,
                password: embyPassword,
                confirmPassword: embyPassword
            },
            token: accessToken
        });

        statusCallback('[97%] ✨ מאמת יצירת חשבון...');
        const searchData = await searchSubscriptions(accessToken);
        if (!responseContainsLogin(searchData, embyLogin)) {
            throw new Error('החשבון לא נוצר — שם המשתמש לא נמצא בתוצאות החיפוש');
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
