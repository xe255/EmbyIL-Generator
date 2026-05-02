'use strict';

/**
 * Small rotating pool from env or local file (e.g. Webshare datacenter list).
 * Format per line: host:port:username:password
 * Protocol: HTTP (undici) default, or SOCKS5 via EMBY_TRUSTED_PROXY_PROTOCOL=socks5 (node-fetch — Webshare-friendly).
 * No external list fetch / origin probes — saves bandwidth vs FREE_PROXY_POOL.
 * Sticky “prefer last good proxy” with short failover ring per request.
 */

const fs = require('fs');
const path = require('path');
const { fetch: undiciFetch, ProxyAgent } = require('undici');

const FILE = (process.env.EMBY_PROXY_LIST_FILE || '').trim();
const INLINE = (process.env.EMBY_PROXY_LIST_INLINE || process.env.EMBY_PROXY_LIST || '').trim();
const TRUSTED_PROTO = (process.env.EMBY_TRUSTED_PROXY_PROTOCOL || 'http').trim().toLowerCase();
const USE_SOCKS = TRUSTED_PROTO === 'socks5' || TRUSTED_PROTO === 'socks';
const MAX_TRIES = Math.min(20, Math.max(1, parseInt(process.env.EMBY_PROXY_LIST_MAX_TRIES || '5', 10) || 5));
const REQUEST_TIMEOUT_MS = Math.max(
    5_000,
    parseInt(process.env.EMBY_PROXY_REQUEST_TIMEOUT_MS || '30000', 10) || 30_000
);

/** @type {string[]} */
let pool = [];
let preferIndex = 0;
let loaded = false;

function parseLine(line) {
    const t = String(line).trim();
    if (!t || t.startsWith('#')) return null;
    const first = t.indexOf(':');
    if (first < 0) return null;
    const host = t.slice(0, first).trim();
    const rest1 = t.slice(first + 1);
    const second = rest1.indexOf(':');
    if (second < 0) return null;
    const port = rest1.slice(0, second).trim();
    const rest2 = rest1.slice(second + 1);
    const third = rest2.indexOf(':');
    if (third < 0) return null;
    const user = rest2.slice(0, third).trim();
    const password = rest2.slice(third + 1).trim();
    if (!host || !/^\d+$/.test(port) || !user) return null;
    const u = encodeURIComponent(user);
    const p = encodeURIComponent(password);
    if (USE_SOCKS) {
        return `socks5://${u}:${p}@${host}:${port}`;
    }
    return `http://${u}:${p}@${host}:${port}`;
}

function loadFromText(txt) {
    const next = [];
    for (const line of String(txt).split(/[\r\n,;]+/)) {
        const url = parseLine(line);
        if (url) next.push(url);
    }
    pool = next;
    preferIndex = 0;
    loaded = true;
    return pool.length;
}

function loadFromDisk() {
    if (loaded) return pool.length;
    if (INLINE) return loadFromText(INLINE);
    if (!FILE) return pool.length;
    const abs = path.isAbsolute(FILE) ? FILE : path.join(process.cwd(), FILE);
    const txt = fs.readFileSync(abs, 'utf8');
    return loadFromText(txt);
}

function poolSize() {
    if (!loaded && (INLINE || FILE)) loadFromDisk();
    return pool.length;
}

function responseLooksCfBlocked(res, bodyText) {
    const h = (typeof bodyText === 'string' ? bodyText : '').slice(0, 12000).toLowerCase();
    if (
        h.includes('just a moment') ||
        h.includes('_cf_chl_opt') ||
        h.includes('challenge-platform') ||
        h.includes('/cdn-cgi/challenge') ||
        h.includes('cf-browser-verification') ||
        (h.includes('<!doctype html') && h.includes('cloudflare')) ||
        h.includes('sorry, you have been blocked')
    ) {
        return true;
    }
    try {
        const get = res.headers && (res.headers.get ? res.headers.get.bind(res.headers) : null);
        if (get && get('cf-ray')) return true;
    } catch {
        /* ignore */
    }
    return false;
}

function proxyLabel(proxyUrl) {
    try {
        const u = new URL(proxyUrl);
        return `${u.hostname}:${u.port || '80'}`;
    } catch {
        return 'unknown-proxy';
    }
}

function shortFetchError(e) {
    const cause = e && e.cause;
    const code = (cause && cause.code) || e.code || '';
    const msg = (cause && cause.message) || e.message || String(e);
    return code ? `${code}: ${msg}` : msg;
}

/**
 * @param {string} proxyUrl socks5://…
 * @param {string} url target https URL
 * @param {import('undici').RequestInit} init
 */
async function fetchViaSocksProxy(proxyUrl, url, init) {
    const nodeFetch = require('node-fetch');
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const agent = new SocksProxyAgent(proxyUrl);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await nodeFetch(url, {
            method: init.method || 'GET',
            headers: init.headers,
            body: init.body,
            agent,
            compress: true,
            signal: init.signal || ac.signal
        });
        clearTimeout(to);
        return res;
    } catch (e) {
        clearTimeout(to);
        throw e;
    }
}

/**
 * @param {string} url
 * @param {import('undici').RequestInit} init
 */
async function fetchThrough(url, init) {
    const n = poolSize();
    if (n < 1) {
        throw new Error('trusted-proxy-list: proxy list empty or EMBY_PROXY_LIST_INLINE / EMBY_PROXY_LIST_FILE not set');
    }
    const cap = Math.min(MAX_TRIES, n);
    let idx = preferIndex % n;
    let lastErr = '';
    for (let attempt = 0; attempt < cap; attempt++) {
        const proxyUrl = pool[idx];
        try {
            let res;
            if (USE_SOCKS) {
                res = await fetchViaSocksProxy(proxyUrl, url, init);
            } else {
                const dispatcher = new ProxyAgent(proxyUrl);
                res = await undiciFetch(url, {
                    ...init,
                    dispatcher,
                    signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
            }
            if (!USE_SOCKS && res.status === 407) {
                lastErr = `HTTP 407 proxy auth ${proxyLabel(proxyUrl)}`;
                console.warn(`[trusted-proxy-list] proxy auth rejected ${proxyLabel(proxyUrl)} (HTTP 407)`);
                idx = (idx + 1) % n;
                preferIndex = idx;
                continue;
            }
            if (res.status === 403 || res.status === 503 || res.status === 429) {
                const snippet = await res.clone().text();
                if (responseLooksCfBlocked(res, snippet)) {
                    lastErr = `Cloudflare blocked ${proxyLabel(proxyUrl)} (HTTP ${res.status})`;
                    console.warn(`[trusted-proxy-list] Cloudflare blocked ${proxyLabel(proxyUrl)} (HTTP ${res.status})`);
                    idx = (idx + 1) % n;
                    preferIndex = idx;
                    continue;
                }
            }
            preferIndex = idx;
            return res;
        } catch (e) {
            lastErr = shortFetchError(e);
            console.warn(`[trusted-proxy-list] fetch failed via ${proxyLabel(proxyUrl)}: ${lastErr}`);
            if (/authentication failed|not authorized|invalid credentials/i.test(lastErr)) {
                console.warn(
                    '[trusted-proxy-list] hint: SOCKS/HTTP auth rejected — refresh proxy list in Webshare, check user:pass lines, or try EMBY_TRUSTED_PROXY_PROTOCOL=http'
                );
            }
            idx = (idx + 1) % n;
            preferIndex = idx;
        }
    }
    throw new Error(
        `trusted-proxy-list: all attempts failed for this request${lastErr ? ` | last: ${lastErr}` : ''}`
    );
}

module.exports = {
    loadFromDisk,
    poolSize,
    fetchThrough
};
