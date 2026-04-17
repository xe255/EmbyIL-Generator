/**
 * One-shot: list ALL members of a supergroup/channel using a normal USER session (MTProto).
 * The Bot API cannot enumerate group members — this uses GramJS with api_id/api_hash from my.telegram.org.
 *
 * Usage (from project root):
 *   npx dotenv -e .env -- node scripts/seed-group-members.js
 *   node scripts/seed-group-members.js --stdout-only
 *
 * Env:
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH (https://my.telegram.org)
 *   TELEGRAM_USER_SESSION — optional; if empty, you will log in once and must save the printed session string
 *   REQUIRED_GROUP_ID or TELEGRAM_GROUP_ID — full supergroup id (-100…) from the bot’s /getgroupid
 *   TELEGRAM_SEED_GROUP — optional: @groupusername or t.me/… if id resolution fails
 *   REQUIRED_GROUP_INVITE or TELEGRAM_GROUP_INVITE — https://t.me/+… link so GramJS can join before scraping
 *   TELEGRAM_INVITE_HASH — optional; only the +hash part if you prefer not to store the full URL
 *
 * If the user account is not in the group yet, set REQUIRED_GROUP_INVITE; the script will ImportChatInvite once.
 *
 * Optional: DB_PATH — merges into db.json groupMembers (unless --stdout-only)
 */
require('dotenv').config();

const readline = require('readline');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { getParticipants } = require('telegram/client/chats');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
    return new Promise((resolve) => rl.question(q, resolve));
}

function parseApiId() {
    const raw = process.env.TELEGRAM_API_ID;
    if (raw == null || String(raw).trim() === '') return NaN;
    return parseInt(String(raw).trim(), 10);
}

function toPlainUser(u) {
    const id = typeof u.id === 'bigint' ? Number(u.id) : Number(u.id);
    return {
        id,
        bot: !!u.bot,
        username: u.username || null,
        firstName: u.firstName || u.first_name || null,
        lastName: u.lastName || u.last_name || null
    };
}

/** t.me/+HASH or legacy joinchat/HASH, or raw hash from TELEGRAM_INVITE_HASH */
function extractInviteHashFromEnv() {
    const direct = (process.env.TELEGRAM_INVITE_HASH || '').trim();
    if (direct) return direct;
    const url = (process.env.REQUIRED_GROUP_INVITE || process.env.TELEGRAM_GROUP_INVITE || '').trim();
    if (!url) return '';
    const plus = url.match(/(?:https?:\/\/)?t\.me\/\+([A-Za-z0-9_-]+)/i);
    if (plus) return plus[1];
    const legacy = url.match(/(?:https?:\/\/)?t\.me\/joinchat\/([A-Za-z0-9_-]+)/i);
    if (legacy) return legacy[1];
    return '';
}

/**
 * Resolve the real Channel/Chat TL object (with access_hash). That is required for getParticipants.
 * client.getEntity(-100…) often uses access_hash 0 → channels.GetChannels → CHANNEL_INVALID.
 */
async function resolveEntityViaInviteHash(client, hash) {
    const { Api } = require('telegram/tl');
    let checked = await client.invoke(new Api.messages.CheckChatInvite({ hash }));

    if (checked instanceof Api.ChatInviteAlready) {
        console.error('[seed] Invite: already in chat — using channel from invite (correct access hash).');
        return checked.chat;
    }

    if (checked instanceof Api.ChatInvite) {
        console.error('[seed] Joining group via invite link…');
        try {
            await client.invoke(new Api.messages.ImportChatInvite({ hash }));
        } catch (e) {
            const msg = [e.errorMessage, e.message].filter(Boolean).join(' ');
            if (/USER_ALREADY_PARTICIPANT|400: USER_ALREADY/i.test(msg)) {
                console.error('[seed] USER_ALREADY_PARTICIPANT — re-checking invite…');
            } else {
                throw e;
            }
        }
        await new Promise((r) => setTimeout(r, 2000));
        checked = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
        if (checked instanceof Api.ChatInviteAlready) {
            console.error('[seed] Joined — using channel from invite.');
            return checked.chat;
        }
        throw new Error(
            'After join, CheckChatInvite did not return ChatInviteAlready. Wait a minute and retry, or check the link.'
        );
    }

    console.warn('[seed] Unexpected CheckChatInvite result:', checked && checked.className);
    return null;
}

async function main() {
    const stdoutOnly = process.argv.includes('--stdout-only');
    const apiId = parseApiId();
    const apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
    const sessionStr = (process.env.TELEGRAM_USER_SESSION || '').trim();
    const groupRaw = (
        process.env.TELEGRAM_SEED_GROUP ||
        process.env.REQUIRED_GROUP_ID ||
        process.env.TELEGRAM_GROUP_ID ||
        ''
    ).trim();
    const inviteHashEarly = extractInviteHashFromEnv();

    if (!apiId || Number.isNaN(apiId) || !apiHash) {
        console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH (https://my.telegram.org).');
        process.exit(1);
    }
    if (!groupRaw && !inviteHashEarly) {
        console.error(
            'Set REQUIRED_GROUP_INVITE (https://t.me/+…) and/or REQUIRED_GROUP_ID (-100…). For private groups, the invite link is required.'
        );
        process.exit(1);
    }

    if (!stdoutOnly) {
        const database = require('../database');
        await database.ready();
    }

    const stringSession = new StringSession(sessionStr);
    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5
    });

    await client.connect();

    if (!(await client.checkAuthorization())) {
        console.error('First-time login: enter phone (+country…), code from Telegram, and 2FA if asked.');
        await client.start({
            phoneNumber: async () => (await ask('Phone number: ')).trim(),
            phoneCode: async () => (await ask('Login code: ')).trim(),
            password: async () => (await ask('2FA password (empty if none): ')).trim(),
            onError: (err) => console.error(err.message || err)
        });
        const saved = stringSession.save();
        if (saved) {
            console.error('\n--- Save this in .env for next runs (keep secret!) ---');
            console.error(`TELEGRAM_USER_SESSION=${saved}`);
            console.error('---\n');
        }
    }

    const inviteHash = extractInviteHashFromEnv();
    let entity = null;

    if (inviteHash) {
        try {
            entity = await resolveEntityViaInviteHash(client, inviteHash);
        } catch (e) {
            console.error('[seed] Invite resolution failed:', e.message || e);
            console.error('Check REQUIRED_GROUP_INVITE / TELEGRAM_INVITE_HASH and that this user may join.');
            throw e;
        }
    } else {
        console.error(
            '[seed] No REQUIRED_GROUP_INVITE — private supergroups usually need https://t.me/+… in .env (see .env.example).'
        );
    }

    if (!entity && groupRaw) {
        console.error('[seed] Optional: loading dialogs (ignored if it errors — some accounts have stale channels)…');
        await client.getDialogs({ limit: 200 }).catch((err) => {
            console.warn('[seed] getDialogs:', err.message || err);
        });
        try {
            entity = await client.getEntity(groupRaw);
        } catch (e) {
            console.error('\n[getEntity -100… failed]', e.message || e);
            console.error(
                'Add REQUIRED_GROUP_INVITE=https://t.me/+YourHash — resolving by id alone often returns CHANNEL_INVALID.'
            );
            throw e;
        }
    }

    if (!entity) {
        console.error('[seed] Could not resolve the group. Set REQUIRED_GROUP_INVITE in .env and run again.');
        process.exit(1);
    }

    if (groupRaw && /^-100\d+$/.test(groupRaw)) {
        const want = groupRaw.slice(4);
        const got =
            entity && entity.id != null
                ? typeof entity.id === 'bigint'
                    ? entity.id.toString()
                    : String(entity.id)
                : '';
        if (got && got !== want) {
            console.warn(
                `[seed] Invite channel id ${got} does not match REQUIRED_GROUP_ID suffix ${want} — wrong invite link?`
            );
        }
    }

    console.error('Fetching participants (may take a while for large groups)…');
    const users = await getParticipants(client, entity, {
        limit: Number.MAX_SAFE_INTEGER,
        search: ''
    });

    const byId = new Map();
    for (const u of users) {
        const row = toPlainUser(u);
        if (!row.bot && row.id) byId.set(row.id, row);
    }
    const plain = Array.from(byId.values());

    console.error(`Found ${plain.length} unique non-bot members (deduped by id).`);

    if (stdoutOnly) {
        console.log(JSON.stringify({ groupMembers: plain }, null, 2));
    } else {
        const { mergeGroupMembersFromExport } = require('../database');
        const { inserted, updated, processed, totalKeys } = mergeGroupMembersFromExport(plain);
        console.error(
            `Merged into groupMembers: ${processed} from scrape (${inserted} new, ${updated} updated), ${totalKeys} total keys. Supabase sync queued.`
        );
    }

    await client.disconnect();
    rl.close();
}

main().catch((e) => {
    console.error(e);
    rl.close();
    process.exit(1);
});
