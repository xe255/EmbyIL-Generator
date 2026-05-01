'use strict';

/**
 * Small rotating pool from a local file (e.g. Webshare datacenter list).
 * Format per line: host:port:username:password (HTTP proxy → http://user:pass@host:port)
 * No external list fetch / origin probes — saves bandwidth vs FREE_PROXY_POOL.
 * Sticky “prefer last good proxy” with short failover ring per request.
 */

const fs = require('fs');
const path = require('path');
const { fetch: undiciFetch, ProxyAgent } = require('undici');

const FILE = (process.env.EMBY_PROXY_LIST_FILE || '').trim();
const MAX_TRIES = Math.min(20, Math.max(1, parseInt(process.env.EMBY_PROXY_LIST_MAX_TRIES || '5', 10) || 5));

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
    return `http://${u}:${p}@${host}:${port}`;
}

function loadFromDisk() {
    if (!FILE || loaded) return pool.length;
    const abs = path.isAbsolute(FILE) ? FILE : path.join(process.cwd(), FILE);
    const txt = fs.readFileSync(abs, 'utf8');
    const next = [];
    for (const line of txt.split(/\r?\n/)) {
        const url = parseLine(line);
        if (url) next.push(url);
    }
    pool = next;
    preferIndex = 0;
    loaded = true;
    return pool.length;
}

function poolSize() {
    if (!loaded && FILE) loadFromDisk();
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
        if (res.headers && res.headers.get && res.headers.get('cf-ray')) return true;
    } catch {
        /* ignore */
    }
    return false;
}

/**
 * @param {string} url
 * @param {import('undici').RequestInit} init
 */
async function fetchThrough(url, init) {
    const n = poolSize();
    if (n < 1) {
        throw new Error('trusted-proxy-list: file empty or EMBY_PROXY_LIST_FILE not set');
    }
    const cap = Math.min(MAX_TRIES, n);
    let idx = preferIndex % n;
    for (let attempt = 0; attempt < cap; attempt++) {
        const proxyUrl = pool[idx];
        try {
            const dispatcher = new ProxyAgent(proxyUrl);
            const res = await undiciFetch(url, { ...init, dispatcher });
            if (res.status === 403 || res.status === 503 || res.status === 429) {
                const snippet = await res.clone().text();
                if (responseLooksCfBlocked(res, snippet)) {
                    idx = (idx + 1) % n;
                    preferIndex = idx;
                    continue;
                }
            }
            preferIndex = idx;
            return res;
        } catch {
            idx = (idx + 1) % n;
            preferIndex = idx;
        }
    }
    throw new Error('trusted-proxy-list: all attempts failed for this request');
}

module.exports = {
    loadFromDisk,
    poolSize,
    fetchThrough
};
