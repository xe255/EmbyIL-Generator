const { createClient } = require('@supabase/supabase-js');

function getSupabaseUrl() {
    return (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
}

/** Prefer service role on the server; publishable/anon may fail if RLS has no write policy. */
function getSupabaseKey() {
    return (
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.SUPABASE_SECRET_KEY ||
        process.env.SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        ''
    ).trim();
}

function getClient() {
    const url = getSupabaseUrl();
    const key = getSupabaseKey();
    if (!url || !key) return null;
    return createClient(url, key);
}

function requiredGroupIdNum() {
    const raw = (process.env.REQUIRED_GROUP_ID || '').trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

/**
 * Pull telegram_users from Supabase into memDb.groupMembers (only keys missing locally).
 * @returns {Promise<number>} number of new members merged
 */
async function mergeSupabaseGroupMembersIntoMemDb(memDb) {
    const client = getClient();
    if (!client) return 0;
    if (!memDb.groupMembers) memDb.groupMembers = {};
    const gm = memDb.groupMembers;

    const { data: rows, error } = await client
        .from('telegram_users')
        .select('telegram_user_id,username,first_name,last_name,is_bot,updated_at')
        .eq('is_bot', false)
        .order('telegram_user_id', { ascending: true });

    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) return 0;

    let added = 0;
    for (const r of rows) {
        const id = String(r.telegram_user_id);
        if (gm[id]) continue;
        gm[id] = {
            username: r.username ?? null,
            firstName: r.first_name ?? null,
            lastName: r.last_name ?? null,
            updatedAt: r.updated_at || new Date().toISOString()
        };
        added++;
    }
    return added;
}

function rowPayload(partial) {
    const gid = requiredGroupIdNum();
    return {
        telegram_user_id: Number(partial.telegram_user_id),
        username: partial.username ?? null,
        first_name: partial.first_name ?? null,
        last_name: partial.last_name ?? null,
        is_bot: !!partial.is_bot,
        source: partial.source || 'bot',
        required_group_id: gid,
        updated_at: new Date().toISOString()
    };
}

async function upsertTelegramUser(partial) {
    const client = getClient();
    if (!client) return;
    const payload = rowPayload(partial);
    const { error } = await client.from('telegram_users').upsert(payload, {
        onConflict: 'telegram_user_id'
    });
    if (error) console.warn('[supabase] upsert:', error.message);
}

function scheduleUpsertTelegramUser(partial) {
    upsertTelegramUser(partial).catch((e) => console.warn('[supabase]', e.message));
}

async function deleteTelegramUser(telegramUserId) {
    const client = getClient();
    if (!client) return;
    const { error } = await client
        .from('telegram_users')
        .delete()
        .eq('telegram_user_id', telegramUserId);
    if (error) console.warn('[supabase] delete:', error.message);
}

function scheduleDeleteTelegramUser(telegramUserId) {
    deleteTelegramUser(telegramUserId).catch((e) => console.warn('[supabase]', e.message));
}

const BULK_CHUNK = 200;

async function bulkUpsertRows(rows) {
    const client = getClient();
    if (!client) {
        throw new Error('Supabase client not configured (check SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
    }
    if (!rows.length) return 0;
    const gid = requiredGroupIdNum();
    const now = new Date().toISOString();
    const payloads = rows.map((r) => ({
        telegram_user_id: Number(r.telegram_user_id),
        username: r.username ?? null,
        first_name: r.first_name ?? null,
        last_name: r.last_name ?? null,
        is_bot: !!r.is_bot,
        source: r.source || 'bulk',
        required_group_id: gid,
        updated_at: now
    }));
    let total = 0;
    for (let i = 0; i < payloads.length; i += BULK_CHUNK) {
        const chunk = payloads.slice(i, i + BULK_CHUNK);
        const { data, error } = await client
            .from('telegram_users')
            .upsert(chunk, { onConflict: 'telegram_user_id' })
            .select('telegram_user_id');
        if (error) {
            const detail = [error.message, error.details, error.hint].filter(Boolean).join(' | ');
            throw new Error(`Supabase upsert failed: ${detail} (code: ${error.code || 'n/a'})`);
        }
        total += data && data.length > 0 ? data.length : chunk.length;
    }
    return total;
}

/** groupMembers: id string -> { username, firstName, lastName, ... } */
function scheduleBulkUpsertFromGroupMembers(groupMembersObj, source) {
    const rows = Object.entries(groupMembersObj || {}).map(([id, v]) => ({
        telegram_user_id: Number(id),
        username: v.username ?? null,
        first_name: v.firstName ?? v.first_name ?? null,
        last_name: v.lastName ?? v.last_name ?? null,
        is_bot: false,
        source: source || 'local_group_members'
    }));
    bulkUpsertRows(rows).catch((e) => console.warn('[supabase]', e.message));
}

async function countTelegramUsers() {
    const client = getClient();
    if (!client) return null;
    const { count, error } = await client
        .from('telegram_users')
        .select('*', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return count;
}

module.exports = {
    getClient,
    countTelegramUsers,
    mergeSupabaseGroupMembersIntoMemDb,
    upsertTelegramUser,
    scheduleUpsertTelegramUser,
    deleteTelegramUser,
    scheduleDeleteTelegramUser,
    bulkUpsertRows,
    scheduleBulkUpsertFromGroupMembers
};
