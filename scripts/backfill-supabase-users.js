/**
 * Rebuild telegram_users in Supabase from local JSON exports (logs + userLimits + optional groupMembers).
 *
 * Usage (from repo root):
 *   npx dotenv -e .env -- node scripts/backfill-supabase-users.js
 *   node scripts/backfill-supabase-users.js --files=db.json,"db (2).json"
 *
 * Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY (recommended)
 *      or publishable/anon key if your RLS policies allow writes.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { bulkUpsertRows, countTelegramUsers, getClient } = require('../supabaseSync');

function requireSupabaseEnv() {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key =
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_SECRET_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
        console.error(
            'Missing Supabase env. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.'
        );
        process.exit(1);
    }
    let host = url;
    try {
        host = new URL(url).host;
    } catch (_) { /* ignore */ }
    console.error('Supabase target:', host, '| client:', getClient() ? 'ok' : 'null');
}

function parseArgsFiles() {
    const a = process.argv.find((x) => x.startsWith('--files='));
    if (!a) return [path.join(__dirname, '..', 'db.json'), path.join(__dirname, '..', 'db (2).json')];
    return a
        .slice('--files='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((f) => path.isAbsolute(f) ? f : path.join(__dirname, '..', f));
}

function blacklistSet(data) {
    const s = new Set();
    for (const e of data.blacklist || []) {
        if (e && e.chatId != null) s.add(String(e.chatId));
    }
    return s;
}

function ingestDbSnapshot(data, map, bl, label) {
    for (const log of data.logs || []) {
        const cid = log.chatId ?? log.userInfo?.id;
        if (cid == null || bl.has(String(cid))) continue;
        const id = String(cid);
        const ui = log.userInfo || {};
        const prev = map.get(id) || {};
        map.set(id, {
            telegram_user_id: Number(id),
            username: ui.username ?? log.username ?? prev.username ?? null,
            first_name: ui.first_name ?? prev.first_name ?? null,
            last_name: ui.last_name ?? prev.last_name ?? null,
            is_bot: !!ui.is_bot,
            source: 'logs_backfill'
        });
    }
    for (const k of Object.keys(data.userLimits || {})) {
        if (!/^\d+$/.test(k) || bl.has(k)) continue;
        if (!map.has(k)) {
            map.set(k, {
                telegram_user_id: Number(k),
                username: null,
                first_name: null,
                last_name: null,
                is_bot: false,
                source: 'userLimits'
            });
        }
    }
    const gm = data.groupMembers || {};
    for (const [id, v] of Object.entries(gm)) {
        if (!/^\d+$/.test(id) || bl.has(id)) continue;
        const prev = map.get(id) || {};
        map.set(id, {
            telegram_user_id: Number(id),
            username: v.username ?? prev.username ?? null,
            first_name: v.firstName ?? v.first_name ?? prev.first_name ?? null,
            last_name: v.lastName ?? v.last_name ?? prev.last_name ?? null,
            is_bot: false,
            source: 'groupMembers_snapshot'
        });
    }
    console.error('Ingested', label, '— cumulative unique ids:', map.size);
}

async function main() {
    requireSupabaseEnv();
    const files = parseArgsFiles();
    const map = new Map();
    for (const f of files) {
        if (!fs.existsSync(f)) {
            console.warn('Skip missing:', f);
            continue;
        }
        let data;
        try {
            data = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch (e) {
            console.error('Invalid JSON:', f, e.message);
            continue;
        }
        const bl = blacklistSet(data);
        ingestDbSnapshot(data, map, bl, f);
    }
    const rows = [...map.values()].filter((r) => !r.is_bot && Number.isFinite(r.telegram_user_id));
    console.error('Total rows to upsert (non-bot):', rows.length);
    if (rows.length === 0) {
        console.error('Nothing to upload. Add --files= paths or restore db exports.');
        process.exit(1);
    }
    const n = await bulkUpsertRows(rows);
    console.error('Upsert batches finished; rows reported:', n);
    const cnt = await countTelegramUsers();
    console.error('telegram_users row count (exact):', cnt);
    if (cnt === 0) {
        console.error(
            'Still 0 rows — confirm you ran supabase/migrations/001_telegram_users.sql in THIS project, and SUPABASE_URL matches the dashboard.'
        );
        process.exit(2);
    }
    console.error('Done. Table Editor → public → telegram_users');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
