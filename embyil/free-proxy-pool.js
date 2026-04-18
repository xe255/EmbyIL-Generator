'use strict';

/**
 * Optional free HTTP proxy pool: GitHub list → proxycheck.io reputation → live probe to Emby origin.
 * Refreshes on a fixed timer (default hourly) + once at process start via embyil/index.js.
 * If the pool is empty (cold start), the first Emby request awaits one refresh so we avoid instant direct→Cloudflare.
 * Per-request: pick best untried proxy; evict on TLS errors or Cloudflare HTML (403/503/429); then rotate or direct fallback.
 * High risk: public proxies may inspect TLS traffic. Enable only with FREE_PROXY_POOL=1 and eyes open.
 */

const { fetch: undiciFetch, ProxyAgent } = require('undici');

const LIST_URL =
    process.env.FREE_PROXY_LIST_URL ||
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt';
const PROXYCHECK_KEY = (process.env.PROXYCHECK_API_KEY || '').trim();
const REFRESH_MS = Math.max(60_000, parseInt(process.env.FREE_PROXY_REFRESH_MS || '3600000', 10) || 3_600_000);
const MAX_CAND = Math.min(500, Math.max(30, parseInt(process.env.FREE_PROXY_MAX_CANDIDATES || '200', 10) || 200));
const CHUNK = Math.min(200, Math.max(20, parseInt(process.env.FREE_PROXY_PROXYCHECK_CHUNK || '80', 10) || 80));
const MAX_RISK = Math.min(100, Math.max(0, parseInt(process.env.FREE_PROXY_MAX_RISK || '90', 10) || 90));
const PROBE_CONC = Math.min(8, Math.max(1, parseInt(process.env.FREE_PROXY_PROBE_CONCURRENCY || '4', 10) || 4));
const PROBE_MS = Math.max(2000, parseInt(process.env.FREE_PROXY_PROBE_TIMEOUT_MS || '5000', 10) || 5000);
const POOL_MAX = Math.min(80, Math.max(5, parseInt(process.env.FREE_PROXY_POOL_MAX || '35', 10) || 35));

let canonicalOrigin = (process.env.EMBY_API_ORIGIN || 'https://emby.embyiltv.io').replace(/\/$/, '');
/** @type {{ url: string, latency: number, successes?: number }[]} */
let pool = [];
let loopStarted = false;
/** @type {Promise<void> | null} */
let refreshInFlight = null;
let lastDirectFallbackLog = 0;

function directFallbackWhenEmpty() {
    const raw = String(process.env.FREE_PROXY_FALLBACK_DIRECT ?? '1').trim();
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

function parseProxyList(text) {
    const set = new Set();
    for (const line of String(text).split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        if (!/^https?:\/\//i.test(t)) continue;
        try {
            const u = new URL(t);
            if (!u.hostname) continue;
            set.add(`${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`);
        } catch {
            /* skip */
        }
    }
    return shuffle([...set]).slice(0, MAX_CAND);
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

async function probeOne(proxyUrl) {
    const probeUrl = `${canonicalOrigin}/`;
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
        const listRes = await fetch(LIST_URL, { signal: AbortSignal.timeout(30000) });
        const text = await listRes.text();
        if (!listRes.ok) throw new Error(`list HTTP ${listRes.status}`);
        const urls = parseProxyList(text);
        fetched = urls.length;
        if (urls.length === 0) {
            console.log('[proxy-pool] empty list');
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
        const winners = await probeMany(afterRep);
        alive = winners.length;
        const prevOk = new Map(pool.map((p) => [p.url, p.successes || 0]));
        pool = winners.map((w) => ({
            ...w,
            successes: prevOk.get(w.url) || 0
        }));
        const ms = Date.now() - t0;
        console.log(
            `[proxy-pool] fetched=${fetched} ipsChecked=${checked} afterRep=${probed} alive=${alive} refreshMs=${ms}`
        );
    } catch (e) {
        console.warn('[proxy-pool] refresh failed:', e.message);
    }
}

/**
 * Prefer proxies with more successful Emby round-trips, then lower probe latency.
 * @param {Set<string>} tried
 * @returns {{ url: string, latency: number, successes?: number } | null}
 */
function looksLikeCloudflareChallenge(text) {
    if (typeof text !== 'string' || text.length < 120) return false;
    const h = text.slice(0, 12000).toLowerCase();
    return (
        h.includes('just a moment') ||
        h.includes('_cf_chl_opt') ||
        h.includes('challenge-platform') ||
        h.includes('/cdn-cgi/challenge') ||
        h.includes('cf-browser-verification') ||
        h.includes('cf-chl-bypass') ||
        (h.includes('<!doctype html') && h.includes('cloudflare'))
    );
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
    return candidates[0];
}

/**
 * @param {string} url
 * @param {import('undici').RequestInit} init
 */
async function fetchThroughPool(url, init) {
    if (pool.length === 0) {
        await scheduleRefresh();
    }
    const maxTries = Math.min(16, Math.max(2, pool.length + 6));
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
                if (looksLikeCloudflareChallenge(snippet)) {
                    pool = pool.filter((p) => p.url !== entry.url);
                    continue;
                }
            }
            const i = pool.findIndex((p) => p.url === entry.url);
            if (i >= 0) pool[i].successes = (pool[i].successes || 0) + 1;
            return res;
        } catch {
            pool = pool.filter((p) => p.url !== entry.url);
        }
    }
    if (directFallbackWhenEmpty()) {
        const now = Date.now();
        if (now - lastDirectFallbackLog > 60_000) {
            lastDirectFallbackLog = now;
            const reason = pool.length === 0 ? 'pool empty (hourly refresh in background)' : 'all pooled proxies failed for this request';
            console.warn(`[proxy-pool] ${reason} — using direct fetch (FREE_PROXY_FALLBACK_DIRECT=0 to disable)`);
        }
        return undiciFetch(url, init);
    }
    throw new Error(
        'free-proxy-pool: no usable proxy (wait for scheduled refresh or enable FREE_PROXY_FALLBACK_DIRECT)'
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
    console.log(`[proxy-pool] scheduled refresh every ${iv} → ${LIST_URL.split('/').slice(-2).join('/')}`);
}

module.exports = {
    configure,
    fetchThroughPool,
    startFreeProxyPoolLoop,
    getPoolSize
};
