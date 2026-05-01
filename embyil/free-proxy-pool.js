'use strict';

/**
 * Optional free HTTP proxy pool: public list(s) → proxycheck.io reputation → live probes to Emby origin ( / and /api ).
 * Default: merges HTTP + HTTPS proxy lists from proxifly; if that yields no candidates, fetches TheSpeedX
 * http.txt (host:port lines). Override with FREE_PROXY_LIST_URL / FREE_PROXY_FALLBACK_LIST_URL.
 * Refreshes on a fixed timer (default hourly) + once at process start via embyil/index.js.
 * If the pool is empty (cold start), the first Emby request awaits one refresh so we avoid instant direct→Cloudflare.
 * Per-request: rotate proxies; evict on TLS errors or Cloudflare block pages (403/503/429 + headers/body).
 * Direct origin fetch is opt-in (FREE_PROXY_FALLBACK_DIRECT=1); default off when this pool is on so traffic stays on proxies.
 * Signup gate (see canCreateEmbyAccountNow): block only until the first full refresh finishes; then allow
 * signup attempts even if zero proxies passed probes (otherwise the bot dead-locks when lists are empty
 * and direct fallback is off). Traffic still uses the pool only; failed attempts surface as fetch errors.
 * High risk: public proxies may inspect TLS traffic. Enable only with FREE_PROXY_POOL=1 and eyes open.
 */

const { fetch: undiciFetch, ProxyAgent } = require('undici');

const DEFAULT_PRIMARY_LIST_URLS = [
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt'
];

/** Fetched only when primary list(s) produce zero parsed proxy lines (or primary fetches fail). */
const DEFAULT_FALLBACK_LIST_URL =
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt';

function listUrlsFromEnv() {
    const raw = (process.env.FREE_PROXY_LIST_URL || '').trim();
    if (!raw) return DEFAULT_PRIMARY_LIST_URLS.slice();
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** @returns {string | null} URL to fetch, or null to skip secondary list */
function fallbackProxyListUrl() {
    const raw = String(process.env.FREE_PROXY_FALLBACK_LIST_URL ?? '').trim();
    if (/^0|false|no|off$/i.test(raw)) return null;
    if (raw) return raw;
    return DEFAULT_FALLBACK_LIST_URL;
}

const PROXYCHECK_KEY = (process.env.PROXYCHECK_API_KEY || '').trim();
const REFRESH_MS = Math.max(60_000, parseInt(process.env.FREE_PROXY_REFRESH_MS || '3600000', 10) || 3_600_000);
const MAX_CAND = Math.min(500, Math.max(30, parseInt(process.env.FREE_PROXY_MAX_CANDIDATES || '200', 10) || 200));
const CHUNK = Math.min(200, Math.max(20, parseInt(process.env.FREE_PROXY_PROXYCHECK_CHUNK || '80', 10) || 80));
const MAX_RISK = Math.min(100, Math.max(0, parseInt(process.env.FREE_PROXY_MAX_RISK || '90', 10) || 90));
const PROBE_CONC = Math.min(8, Math.max(1, parseInt(process.env.FREE_PROXY_PROBE_CONCURRENCY || '4', 10) || 4));
const PROBE_MS = Math.max(2000, parseInt(process.env.FREE_PROXY_PROBE_TIMEOUT_MS || '5000', 10) || 5000);
const POOL_MAX = Math.min(80, Math.max(5, parseInt(process.env.FREE_PROXY_POOL_MAX || '35', 10) || 35));
const EMPTY_RETRY_MS = Math.max(60_000, parseInt(process.env.FREE_PROXY_EMPTY_RETRY_MS || '120000', 10) || 120_000);

let canonicalOrigin = (process.env.EMBY_API_ORIGIN || 'https://emby.embyiltv.io').replace(/\/$/, '');
/** @type {{ url: string, latency: number, successes?: number, stale?: boolean }[]} */
let pool = [];
let loopStarted = false;
/** @type {Promise<void> | null} */
let refreshInFlight = null;
let lastDirectFallbackLog = 0;
let nextPickCursor = 0;
/** At least one refreshPool() run has finished (success or error). */
let initialRefreshCompleted = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let emptyRetryTimer = null;

function staticEmbyProxyEnv() {
    return !!(
        (process.env.EMBY_SOCKS_PROXY || '').trim() ||
        (process.env.EMBY_HTTPS_PROXY || '').trim() ||
        (process.env.HTTPS_PROXY || '').trim() ||
        (process.env.EMBY_PROXY_LIST_FILE || '').trim()
    );
}

function embyProxyPoolGateActive() {
    if (staticEmbyProxyEnv()) return false;
    return /^1|true|yes|on$/i.test(String(process.env.FREE_PROXY_POOL || '').trim());
}

function signupBypassProxyGate() {
    return /^1|true|yes|on$/i.test(String(process.env.FREE_PROXY_SIGNUP_WITHOUT_POOL || '').trim());
}

function canCreateEmbyAccountNow() {
    if (signupBypassProxyGate()) return true;
    if (!embyProxyPoolGateActive()) return true;
    return initialRefreshCompleted;
}

function getProxySignupGateStatus() {
    return {
        gateActive: embyProxyPoolGateActive(),
        initialRefreshCompleted,
        poolSize: pool.length,
        directFallbackEnabled: directFallbackWhenEmpty(),
        signupAllowed: canCreateEmbyAccountNow()
    };
}

function scheduleEmptyPoolRetry() {
    if (!embyProxyPoolGateActive()) return;
    if (pool.length > 0) return;
    if (emptyRetryTimer) return;
    emptyRetryTimer = setTimeout(() => {
        emptyRetryTimer = null;
        console.log('[proxy-pool] scheduling extra refresh (pool empty after last run)');
        scheduleRefresh();
    }, EMPTY_RETRY_MS);
}

function directFallbackWhenEmpty() {
    const raw = String(process.env.FREE_PROXY_FALLBACK_DIRECT ?? '').trim();
    if (raw === '') {
        // Pool mode + direct egress usually hits Cloudflare from the host IP — default off.
        return !embyProxyPoolGateActive();
    }
    return !/^0|false|no|off$/i.test(raw);
}

function scheduleRefresh() {
    if (!refreshInFlight) {
        refreshInFlight = refreshPool()
            .catch(() => {})
            .finally(() => {
                refreshInFlight = null;
            });
    }
    return refreshInFlight;
}

function configure(opts) {
    if (opts && opts.canonicalOrigin) {
        canonicalOrigin = String(opts.canonicalOrigin).replace(/\/$/, '');
    }
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function addProxyLinesToSet(text, set) {
    for (const line of String(text).split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        if (/^https?:\/\//i.test(t)) {
            try {
                const u = new URL(t);
                if (!u.hostname) continue;
                set.add(`${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`);
            } catch {
                /* skip */
            }
            continue;
        }
        const plain = t.match(/^([a-z0-9][a-z0-9.-]*|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i);
        if (plain) {
            set.add(`http://${plain[1]}:${plain[2]}`);
        }
    }
}

function extractRisk(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    const r = entry.risk;
    if (typeof r === 'number') return r;
    if (typeof r === 'string' && r.trim() !== '') return parseInt(r, 10) || 0;
    if (r && typeof r === 'object') {
        if (typeof r.score === 'number') return r.score;
        if (typeof r.score === 'string') return parseInt(r.score, 10) || 0;
    }
    const d = entry.detections;
    if (d && typeof d === 'object') {
        if (typeof d.risk === 'number') return d.risk;
        if (typeof d.risk === 'string') return parseInt(d.risk, 10) || 0;
        if (d.risk && typeof d.risk.score === 'number') return d.risk.score;
    }
    return 0;
}

/**
 * @param {string[]} hosts hostnames from proxy URLs (IPv4 or DNS)
 * @returns {Promise<Set<string>>} hostnames allowed after reputation filter
 */
async function proxycheckFilterIps(hosts) {
    const allowed = new Set();
    if (!PROXYCHECK_KEY || hosts.length === 0) {
        hosts.forEach((h) => allowed.add(h));
        return allowed;
    }
    for (let i = 0; i < hosts.length; i += CHUNK) {
        const chunk = hosts.slice(i, i + CHUNK);
        const pathHosts = chunk.join(',');
        const url = `https://proxycheck.io/v3/${pathHosts}?key=${encodeURIComponent(PROXYCHECK_KEY)}&risk=1`;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
            const j = await res.json().catch(() => ({}));
            if (!res.ok) {
                console.warn('[proxy-pool] proxycheck HTTP', res.status);
                chunk.forEach((h) => allowed.add(h));
                continue;
            }
            for (const [k, v] of Object.entries(j)) {
                if (k === 'status' || k === 'message' || k === 'query_time' || k === 'error') continue;
                if (typeof v !== 'object' || v === null) continue;
                const risk = extractRisk(v);
                if (risk <= MAX_RISK) allowed.add(k);
            }
            if (chunk.every((h) => !allowed.has(h)) && chunk.length > 0) {
                chunk.forEach((h) => allowed.add(h));
            }
        } catch (e) {
            console.warn('[proxy-pool] proxycheck chunk:', e.message);
            chunk.forEach((h) => allowed.add(h));
        }
    }
    if (allowed.size === 0 && hosts.length > 0) {
        hosts.forEach((h) => allowed.add(h));
    }
    return allowed;
}

async function probeEndpoint(proxyUrl, probeUrl) {
    const dispatcher = new ProxyAgent(proxyUrl);
    const t0 = Date.now();
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), PROBE_MS);
    try {
        const res = await undiciFetch(probeUrl, {
            method: 'GET',
            signal: ac.signal,
            dispatcher,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; embyil-proxy-probe/1.0)',
                Accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
            }
        });
        clearTimeout(to);
        const ms = Date.now() - t0;
        if (res.status >= 200 && res.status <= 499) return { ok: true, latency: ms, url: proxyUrl };
        return { ok: false };
    } catch {
        clearTimeout(to);
        return { ok: false };
    }
}

/** Hit both site root and /api — some proxies only pass one path to the origin. */
async function probeOne(proxyUrl) {
    const paths = [`${canonicalOrigin}/`, `${canonicalOrigin}/api`];
    const results = await Promise.all(paths.map((p) => probeEndpoint(proxyUrl, p)));
    const ok = results.filter((r) => r.ok);
    if (ok.length === 0) return { ok: false };
    ok.sort((a, b) => a.latency - b.latency);
    return { ok: true, latency: ok[0].latency, url: proxyUrl };
}

async function probeMany(proxyUrls) {
    const winners = [];
    for (let i = 0; i < proxyUrls.length && winners.length < POOL_MAX; i += PROBE_CONC) {
        const batch = proxyUrls.slice(i, i + PROBE_CONC);
        const results = await Promise.all(batch.map((u) => probeOne(u)));
        for (const r of results) {
            if (r && r.ok && r.url) winners.push({ url: r.url, latency: r.latency, successes: 0 });
        }
    }
    winners.sort((a, b) => a.latency - b.latency);
    return winners.slice(0, POOL_MAX);
}

async function refreshPool() {
    const t0 = Date.now();
    let fetched = 0;
    let checked = 0;
    let probed = 0;
    let alive = 0;
    try {
        const merged = new Set();
        const sources = listUrlsFromEnv();
        let anyListOk = false;
        for (const listUrl of sources) {
            try {
                const listRes = await fetch(listUrl, { signal: AbortSignal.timeout(30000) });
                const text = await listRes.text();
                if (!listRes.ok) {
                    console.warn('[proxy-pool] list HTTP', listRes.status, listUrl.split('/').slice(-3).join('/'));
                    continue;
                }
                anyListOk = true;
                addProxyLinesToSet(text, merged);
            } catch (e) {
                console.warn('[proxy-pool] list fetch failed:', e.message, listUrl.split('/').slice(-3).join('/'));
            }
        }

        const fbUrl = fallbackProxyListUrl();
        if (merged.size === 0 && fbUrl) {
            console.warn('[proxy-pool] primary lists yielded no candidates; trying fallback list');
            try {
                const listRes = await fetch(fbUrl, { signal: AbortSignal.timeout(30000) });
                const text = await listRes.text();
                if (!listRes.ok) {
                    console.warn('[proxy-pool] fallback list HTTP', listRes.status);
                } else {
                    anyListOk = true;
                    addProxyLinesToSet(text, merged);
                }
            } catch (e) {
                console.warn('[proxy-pool] fallback list fetch failed:', e.message);
            }
        }

        if (!anyListOk && merged.size === 0) {
            console.warn('[proxy-pool] no proxy list sources responded');
            return;
        }
        const urls = shuffle([...merged]).slice(0, MAX_CAND);
        fetched = urls.length;
        if (urls.length === 0) {
            console.log('[proxy-pool] empty merged list');
            return;
        }
        const ipToUrls = new Map();
        for (const u of urls) {
            let host;
            try {
                host = new URL(u).hostname;
            } catch {
                continue;
            }
            if (!ipToUrls.has(host)) ipToUrls.set(host, []);
            ipToUrls.get(host).push(u);
        }
        const uniqueHosts = [...ipToUrls.keys()];
        checked = uniqueHosts.length;
        const allowedHosts = await proxycheckFilterIps(uniqueHosts);
        const afterRep = urls.filter((u) => {
            try {
                const h = new URL(u).hostname;
                return allowedHosts.has(h);
            } catch {
                return false;
            }
        });
        probed = afterRep.length;
        const prevOk = new Map(pool.map((p) => [p.url, p.successes || 0]));
        const winners = await probeMany(afterRep);
        alive = winners.length;
        if (winners.length > 0) {
            const freshUrls = new Set(winners.map((w) => w.url));
            const fresh = winners.map((w) => ({
                ...w,
                successes: prevOk.get(w.url) || 0,
                stale: false
            }));
            const stillUsable = pool
                .filter((p) => p && p.url && !freshUrls.has(p.url))
                .map((p) => ({ ...p, stale: true }));
            pool = [...fresh, ...stillUsable].slice(0, POOL_MAX);
            nextPickCursor = nextPickCursor % Math.max(pool.length, 1);
        } else if (pool.length > 0) {
            pool = pool.map((p) => ({ ...p, stale: true }));
            console.warn('[proxy-pool] refresh found no live replacements; keeping last-known proxies while retrying');
        } else {
            pool = [];
        }
        const ms = Date.now() - t0;
        console.log(
            `[proxy-pool] fetched=${fetched} ipsChecked=${checked} afterRep=${probed} alive=${alive} refreshMs=${ms}`
        );
    } catch (e) {
        console.warn('[proxy-pool] refresh failed:', e.message);
    } finally {
        initialRefreshCompleted = true;
        if (embyProxyPoolGateActive() && pool.length === 0) {
            scheduleEmptyPoolRetry();
        }
    }
}

/**
 * Prefer proxies with more successful Emby round-trips, then lower probe latency.
 * @param {Set<string>} tried
 * @returns {{ url: string, latency: number, successes?: number } | null}
 */
function looksLikeCloudflareChallenge(text) {
    if (typeof text !== 'string' || text.length < 80) return false;
    const h = text.slice(0, 12000).toLowerCase();
    return (
        h.includes('just a moment') ||
        h.includes('_cf_chl_opt') ||
        h.includes('challenge-platform') ||
        h.includes('/cdn-cgi/challenge') ||
        h.includes('cf-browser-verification') ||
        h.includes('cf-chl-bypass') ||
        (h.includes('<!doctype html') && h.includes('cloudflare')) ||
        (h.includes('cloudflare') && h.includes('error code'))
    );
}

/**
 * True when the response looks like a Cloudflare edge block/challenge (not a JSON API error).
 * @param {import('undici').Response} res
 * @param {string} bodyText
 */
function responseLooksCfBlocked(res, bodyText) {
    if (looksLikeCloudflareChallenge(bodyText)) return true;
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/application\/json/i.test(ct)) return false;
    try {
        if (res.headers.get('cf-ray')) return true;
        if (/cloudflare/i.test(res.headers.get('server') || '')) return true;
    } catch {
        /* ignore */
    }
    if (/text\/html/i.test(ct) && typeof bodyText === 'string' && /cloudflare/i.test(bodyText.toLowerCase())) {
        return true;
    }
    return false;
}

function pickNextProxy(tried) {
    const candidates = pool.filter((p) => p && p.url && !tried.has(p.url));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
        const sa = a.successes || 0;
        const sb = b.successes || 0;
        if (sb !== sa) return sb - sa;
        return (a.latency || 1e9) - (b.latency || 1e9);
    });
    const pick = candidates[nextPickCursor % candidates.length];
    nextPickCursor = (nextPickCursor + 1) % Math.max(pool.length, 1);
    return pick;
}

/**
 * @param {string} url
 * @param {import('undici').RequestInit} init
 */
async function fetchThroughPool(url, init) {
    for (let cycle = 0; cycle < 2; cycle++) {
        if (pool.length === 0) {
            await scheduleRefresh();
        }
        const maxTries = Math.min(24, Math.max(4, pool.length + 8));
        const tried = new Set();
        for (let t = 0; t < maxTries; t++) {
            if (pool.length === 0) break;
            const entry = pickNextProxy(tried);
            if (!entry) break;
            tried.add(entry.url);
            try {
                const dispatcher = new ProxyAgent(entry.url);
                const res = await undiciFetch(url, { ...init, dispatcher });
                if (res.status === 403 || res.status === 503 || res.status === 429) {
                    const snippet = await res.clone().text();
                    if (responseLooksCfBlocked(res, snippet)) {
                        pool = pool.filter((p) => p.url !== entry.url);
                        nextPickCursor = nextPickCursor % Math.max(pool.length, 1);
                        continue;
                    }
                }
                const i = pool.findIndex((p) => p.url === entry.url);
                if (i >= 0) pool[i].successes = (pool[i].successes || 0) + 1;
                return res;
            } catch {
                pool = pool.filter((p) => p.url !== entry.url);
                nextPickCursor = nextPickCursor % Math.max(pool.length, 1);
            }
        }
        if (directFallbackWhenEmpty()) {
            break;
        }
        if (cycle === 0 && embyProxyPoolGateActive()) {
            console.warn('[proxy-pool] pool exhausted for this request; forcing full refresh and one retry');
            await refreshPool();
            continue;
        }
        break;
    }
    if (embyProxyPoolGateActive() && pool.length === 0) {
        scheduleEmptyPoolRetry();
    }
    if (directFallbackWhenEmpty()) {
        const now = Date.now();
        if (now - lastDirectFallbackLog > 60_000) {
            lastDirectFallbackLog = now;
            const reason = pool.length === 0 ? 'pool empty (refresh/retry in background)' : 'all pooled proxies failed for this request';
            console.warn(
                `[proxy-pool] ${reason} — using direct fetch (FREE_PROXY_FALLBACK_DIRECT=1; without it, pool mode avoids server-IP requests)`
            );
        }
        return undiciFetch(url, init);
    }
    throw new Error(
        'free-proxy-pool: no usable proxy — wait for refresh or set FREE_PROXY_FALLBACK_DIRECT=1 to allow direct (often blocked by Cloudflare)'
    );
}

function getPoolSize() {
    return pool.length;
}

function startFreeProxyPoolLoop() {
    if (loopStarted) return;
    loopStarted = true;
    scheduleRefresh();
    setInterval(() => {
        scheduleRefresh();
    }, REFRESH_MS);
    const iv = REFRESH_MS >= 3600000 ? `${REFRESH_MS / 3600000}h` : `${REFRESH_MS / 1000}s`;
    const nPri = listUrlsFromEnv().length;
    const fb = fallbackProxyListUrl();
    console.log(`[proxy-pool] scheduled refresh every ${iv} (${nPri} primary list(s)${fb ? ' + fallback' : ''})`);
}

module.exports = {
    configure,
    fetchThroughPool,
    startFreeProxyPoolLoop,
    getPoolSize,
    embyProxyPoolGateActive,
    canCreateEmbyAccountNow,
    getProxySignupGateStatus
};
