#!/usr/bin/env node
/**
 * Free Cloudflare bypass (HTTP only): run this where egress IP is NOT blocked (home PC, Raspberry Pi, Oracle Free VM).
 *
 * 1) Here:   EMBY_RELAY_UPSTREAM=https://emby.embyiltv.io  (optional secret: EMBY_RELAY_SECRET)
 * 2) Expose:  npx cloudflared tunnel --url http://127.0.0.1:8787   (copy the https://*.trycloudflare.com URL)
 * 3) Render: EMBY_API_FETCH_BASE=https://THAT-URL/api
 *            EMBY_API_ORIGIN=https://emby.embyiltv.io
 *            EMBY_RELAY_SECRET=same-as-here-if-set
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/
 */
require('dotenv').config();
const http = require('http');
const { request } = require('undici');

const UPSTREAM = (process.env.EMBY_RELAY_UPSTREAM || 'https://emby.embyiltv.io').replace(/\/$/, '');
const SECRET = (process.env.EMBY_RELAY_SECRET || '').trim();
const PORT = parseInt(process.env.RELAY_PORT || '8787', 10) || 8787;
const UPSTREAM_HOST = new URL(UPSTREAM).host;

const HOP = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

const server = http.createServer(async (req, res) => {
    if (SECRET && req.headers['x-emby-relay-secret'] !== SECRET) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
    }

    if (!req.url || !req.url.startsWith('/api')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('relay: use /api/*');
        return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyBuf = Buffer.concat(chunks);
    const hasBody = bodyBuf.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';

    const outHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const low = k.toLowerCase();
        if (HOP.has(low) || low === 'x-emby-relay-secret') continue;
        if (v !== undefined) outHeaders[k] = v;
    }
    outHeaders.host = UPSTREAM_HOST;

    const target = UPSTREAM + req.url;
    try {
        const r = await request(target, {
            method: req.method,
            headers: outHeaders,
            body: hasBody ? bodyBuf : null
        });

        const out = {};
        for (const [k, v] of Object.entries(r.headers)) {
            if (v === undefined) continue;
            const low = k.toLowerCase();
            if (low === 'transfer-encoding' || low === 'connection') continue;
            out[k] = v;
        }
        res.writeHead(r.statusCode, out);
        res.end(Buffer.from(await r.body.arrayBuffer()));
    } catch (e) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`relay upstream error: ${e.message}`);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`emby-api-relay 127.0.0.1:${PORT} → ${UPSTREAM}/api/*`);
    if (SECRET) console.log('relay: X-Emby-Relay-Secret required');
    else console.warn('relay: no EMBY_RELAY_SECRET — tunnel URL is public; set a shared secret');
});
