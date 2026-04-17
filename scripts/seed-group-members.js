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
 *   REQUIRED_GROUP_ID or TELEGRAM_GROUP_ID — same -100… id as the bot uses
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

async function main() {
    const stdoutOnly = process.argv.includes('--stdout-only');
    const apiId = parseApiId();
    const apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
    const sessionStr = (process.env.TELEGRAM_USER_SESSION || '').trim();
    const groupRaw =
        (process.env.REQUIRED_GROUP_ID || process.env.TELEGRAM_GROUP_ID || '').trim();

    if (!apiId || Number.isNaN(apiId) || !apiHash) {
        console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH (https://my.telegram.org).');
        process.exit(1);
    }
    if (!groupRaw) {
        console.error('Set REQUIRED_GROUP_ID or TELEGRAM_GROUP_ID to your supergroup id (e.g. -100…).');
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

    const entity =
        /^-?\d+$/.test(groupRaw) ? groupRaw : (await client.getEntity(groupRaw));

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
