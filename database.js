const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');

function createDefaultDb() {
    return {
        logs: [],
        stats: { totalCreated: 0, activeUsers: 0 },
        chats: {},
        progress: {},
        accounts: {},
        userLimits: {},
        notifications: {},
        admins: [],
        unlimitedUsers: [],
        creationEnabled: true,
        whitelist: [],
        whitelistEnabled: false,
        broadcasts: [],
        broadcastExclusion: [],
        groupMembers: {}
    };
}

/** Ensure required keys exist (migrations). Returns true if db should be persisted. */
function ensureDbShape(data) {
    let changed = false;
    if (!Array.isArray(data.logs)) { data.logs = []; changed = true; }
    if (!data.stats || typeof data.stats !== 'object') {
        data.stats = { totalCreated: 0, activeUsers: 0 };
        changed = true;
    }
    if (!data.chats || typeof data.chats !== 'object') { data.chats = {}; changed = true; }
    if (!data.progress || typeof data.progress !== 'object') { data.progress = {}; changed = true; }
    if (!data.accounts || typeof data.accounts !== 'object') { data.accounts = {}; changed = true; }
    if (!data.userLimits || typeof data.userLimits !== 'object') { data.userLimits = {}; changed = true; }
    if (!data.notifications || typeof data.notifications !== 'object') { data.notifications = {}; changed = true; }
    if (!data.admins) { data.admins = []; changed = true; }
    if (!data.unlimitedUsers) { data.unlimitedUsers = []; changed = true; }
    if (data.creationEnabled === undefined) { data.creationEnabled = true; changed = true; }
    if (!data.whitelist) { data.whitelist = []; changed = true; }
    if (data.whitelistEnabled === undefined) { data.whitelistEnabled = false; changed = true; }
    if (!data.broadcasts) { data.broadcasts = []; changed = true; }
    if (!data.broadcastExclusion) { data.broadcastExclusion = []; changed = true; }
    if (!data.groupMembers || typeof data.groupMembers !== 'object' || Array.isArray(data.groupMembers)) {
        data.groupMembers = {};
        changed = true;
    }
    return changed;
}

/** In-memory DB (single object mutated by callers). Filled by ready() or lazy file load. */
let memDb = null;

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/, '');
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const UPSTASH_KEY = (process.env.UPSTASH_REDIS_DB_KEY || 'embyil-db').trim();
const USE_UPSTASH = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

let upstashFlushTimer = null;
let upstashFlushPending = false;
let readyPromise = null;

async function upstashExec(cmd) {
    const res = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: JSON.stringify(cmd)
    });
    const j = await res.json().catch(() => ({}));
    if (j.error) {
        throw new Error(String(j.error));
    }
    if (!res.ok) {
        throw new Error(`Upstash HTTP ${res.status}`);
    }
    return j;
}

async function upstashGetDbJson() {
    const j = await upstashExec(['GET', UPSTASH_KEY]);
    if (j.result == null || j.result === '') return null;
    const str = typeof j.result === 'string' ? j.result : String(j.result);
    const trimmed = str.trim();
    if (!trimmed) return null;
    const data = JSON.parse(trimmed);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new SyntaxError('remote db root must be an object');
    }
    return data;
}

async function upstashSetDbJson(compactJson) {
    await upstashExec(['SET', UPSTASH_KEY, compactJson]);
}

/** Write full db object to local path (ephemeral on Render free). */
function writeDbToDisk(data) {
    const json = JSON.stringify(data, null, 2);
    const dir = path.dirname(DB_PATH);
    if (process.platform === 'win32') {
        fs.writeFileSync(DB_PATH, json, 'utf8');
        return;
    }
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    } catch (_) { /* ignore */ }
    const tmp = path.join(dir, `.${path.basename(DB_PATH)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, DB_PATH);
}

function scheduleUpstashPersist() {
    if (!USE_UPSTASH || !memDb) return;
    upstashFlushPending = true;
    clearTimeout(upstashFlushTimer);
    upstashFlushTimer = setTimeout(flushUpstashDebounced, 2000);
}

async function flushUpstashDebounced() {
    upstashFlushTimer = null;
    if (!USE_UPSTASH || !memDb || !upstashFlushPending) return;
    upstashFlushPending = false;
    try {
        await upstashSetDbJson(JSON.stringify(memDb));
    } catch (e) {
        console.error('[database] Upstash SET failed:', e.message);
        upstashFlushPending = true;
    }
}

async function flushUpstashFinal() {
    clearTimeout(upstashFlushTimer);
    upstashFlushTimer = null;
    if (!USE_UPSTASH || !memDb) return;
    try {
        await upstashSetDbJson(JSON.stringify(memDb));
    } catch (e) {
        console.error('[database] Upstash final SET failed:', e.message);
    }
}

function loadFromFileSyncOrDefault() {
    let raw;
    try {
        raw = fs.readFileSync(DB_PATH, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            const fresh = createDefaultDb();
            try {
                writeDbToDisk(fresh);
            } catch (_) { /* ignore */ }
            return fresh;
        }
        throw e;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        const d = createDefaultDb();
        try {
            writeDbToDisk(d);
        } catch (_) { /* ignore */ }
        return d;
    }
    try {
        const data = JSON.parse(trimmed);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
            throw new SyntaxError('db root must be an object');
        }
        ensureDbShape(data);
        return data;
    } catch (e) {
        console.error('[database] db.json unreadable (empty or corrupt), reinitializing:', e.message);
        const d = createDefaultDb();
        try {
            writeDbToDisk(d);
        } catch (_) { /* ignore */ }
        return d;
    }
}

/**
 * Call once before using the DB when UPSTASH_* is set (npm start → start.js).
 * Loads from Upstash if present, else from db.json.
 */
async function ready() {
    if (memDb !== null) return;
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
        if (USE_UPSTASH) {
            try {
                const remote = await upstashGetDbJson();
                if (remote) {
                    memDb = remote;
                    ensureDbShape(memDb);
                    writeDbToDisk(memDb);
                    console.log('[database] loaded from Upstash (', UPSTASH_KEY, ')');
                }
            } catch (e) {
                console.warn('[database] Upstash GET failed, using local file:', e.message);
            }
        }
        if (memDb === null) {
            memDb = loadFromFileSyncOrDefault();
            if (ensureDbShape(memDb)) {
                writeDbToDisk(memDb);
            }
            console.log('[database] using', path.resolve(DB_PATH));
        }
        try {
            const { mergeSupabaseGroupMembersIntoMemDb } = require('./supabaseSync');
            const n = await mergeSupabaseGroupMembersIntoMemDb(memDb);
            if (n > 0) {
                ensureDbShape(memDb);
                writeDbToDisk(memDb);
                scheduleUpstashPersist();
                console.log('[database] merged', n, 'users from Supabase into groupMembers');
            }
        } catch (e) {
            console.warn('[database] Supabase merge skipped:', e.message);
        }
    })();
    await readyPromise;
}

/** Write full db object to disk and queue remote backup. */
function persistDb(data) {
    memDb = data;
    writeDbToDisk(data);
    scheduleUpstashPersist();
}

function readDbSafe() {
    if (memDb === null) {
        if (USE_UPSTASH) {
            console.error(
                '[database] UPSTASH_* is set but database.ready() was not called. Use `npm start` (node start.js).'
            );
            process.exit(1);
        }
        memDb = loadFromFileSyncOrDefault();
    }
    if (ensureDbShape(memDb)) {
        persistDb(memDb);
    }
    return memDb;
}

if (process.env.NODE_ENV === 'production' && !process.env.DB_PATH && !USE_UPSTASH) {
    console.warn(
        '[database] No DB_PATH and no Upstash — data is lost on redeploy/spin-down. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (free tier) or mount a volume (see .env.example).'
    );
}

if (USE_UPSTASH) {
    process.once('SIGINT', () => {
        flushUpstashFinal().finally(() => process.exit(0));
    });
    process.once('SIGTERM', () => {
        flushUpstashFinal().finally(() => process.exit(0));
    });
}

function getLogs() {
    return readDbSafe();
}

function addLog(chatId, username, action, status, result = null, userInfo = null) {
    const data = getLogs();
    const newLog = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        chatId,
        username,
        action,
        status,
        result,
        userInfo: userInfo // Store full user info for Telegram links
    };
    data.logs.unshift(newLog); // Newest first

    // Update stats
    if (action === 'create_account' && status === 'success') {
        data.stats.totalCreated++;
    }

    // Simple active user count (unique chatIds)
    const uniqueUsers = new Set(data.logs.map(l => l.chatId));
    data.stats.activeUsers = uniqueUsers.size;

    persistDb(data);
}

function addChatMessage(chatId, username, fromAdmin, message) {
    const data = getLogs();
    if (!data.chats) data.chats = {};
    if (!data.chats[chatId]) {
        data.chats[chatId] = {
            username: username,
            messages: []
        };
    }
    
    data.chats[chatId].messages.push({
        id: Date.now(),
        timestamp: new Date().toISOString(),
        fromAdmin: fromAdmin,
        message: message
    });
    
    persistDb(data);
}

function getChatMessages(chatId) {
    const data = getLogs();
    if (!data.chats || !data.chats[chatId]) return [];
    return data.chats[chatId].messages;
}

function getAllChats() {
    const data = getLogs();
    if (!data.chats) data.chats = {};
    
    // Get all unique users from logs
    const userMap = new Map();
    data.logs.forEach(log => {
        if (!log.chatId) return;
        
        // Track last action for everyone regardless of identity
        if (!userMap.has(log.chatId)) {
            userMap.set(log.chatId, {
                username: 'Unknown',
                lastAction: log.timestamp,
                action: log.action,
                userInfo: null,
                telegramUsername: null
            });
        } else {
            // Newest logs are first in array, so we only update if this log is "newer" 
            // than what we have (though normally unshift ensures newest is visit first)
            const existingTime = new Date(userMap.get(log.chatId).lastAction).getTime();
            const logTime = new Date(log.timestamp).getTime();
            if (logTime > existingTime) {
                userMap.get(log.chatId).lastAction = log.timestamp;
                userMap.get(log.chatId).action = log.action;
            }
        }

        // Only update identity from non-ADMIN logs
        if (log.username && log.username !== 'ADMIN') {
            const userData = userMap.get(log.chatId);
            
            // If we don't have a good username yet, or this log has userInfo, update it
            if (userData.username === 'Unknown' || log.userInfo) {
                if (log.username !== 'Missing') {
                    userData.username = log.username;
                }
                
                if (log.userInfo) {
                    userData.userInfo = log.userInfo;
                    userData.telegramUsername = log.userInfo.username || null;
                }
                
                // Fallback username if needed
                if (!userData.telegramUsername && log.username && 
                    log.username !== 'Missing' && 
                    log.username !== 'Unknown' &&
                    !log.username.includes(' ') &&
                    log.username.length >= 5) {
                    userData.telegramUsername = log.username;
                }
            }
        }
    });
    
    // Merge with existing chats
    userMap.forEach((userData, chatId) => {
        if (!data.chats[chatId]) {
            data.chats[chatId] = {
                username: userData.username,
                messages: [],
                lastAction: userData.lastAction,
                action: userData.action,
                userInfo: userData.userInfo,
                telegramUsername: userData.telegramUsername
            };
        } else {
            // Update username if it was unknown/missing
            if (data.chats[chatId].username === 'Unknown' || data.chats[chatId].username === 'Missing') {
                data.chats[chatId].username = userData.username;
            }
            
            // Always update last action
            data.chats[chatId].lastAction = userData.lastAction;
            
            // Update other info if we found better data in logs
            if (userData.telegramUsername) {
                data.chats[chatId].telegramUsername = userData.telegramUsername;
            }
            if (userData.userInfo) {
                data.chats[chatId].userInfo = userData.userInfo;
            }
        }
    });
    
    return data.chats;
}

function updateProgress(chatId, progress, message) {
    const data = getLogs();
    if (!data.progress) data.progress = {};
    
    data.progress[chatId] = {
        progress: progress,
        message: message,
        timestamp: new Date().toISOString()
    };
    
    persistDb(data);
}

function getProgress(chatId) {
    const data = getLogs();
    if (!data.progress || !data.progress[chatId]) return null;
    return data.progress[chatId];
}

function clearProgress(chatId) {
    const data = getLogs();
    if (data.progress && data.progress[chatId]) {
        delete data.progress[chatId];
        persistDb(data);
    }
}

function addAccount(chatId, username, accountData) {
    const data = getLogs();
    if (!data.accounts) data.accounts = {};
    if (!data.accounts[chatId]) data.accounts[chatId] = [];
    
    const account = {
        id: Date.now(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day
        accountEmail: accountData.accountEmail,
        accountPassword: accountData.accountPassword || null,
        embyUsername: accountData.embyUsername,
        embyPassword: accountData.embyPassword || null,
        active: true,
        notificationSent: false
    };
    
    data.accounts[chatId].push(account);
    persistDb(data);
    
    return account;
}

function getUserAccounts(chatId) {
    const data = getLogs();
    if (!data.accounts || !data.accounts[chatId]) return [];
    return data.accounts[chatId];
}

function getAccountCount(chatId) {
    const accounts = getUserAccounts(chatId);
    return accounts.filter(acc => acc.active).length;
}

function canCreateAccount(chatId, { skipLimits = false } = {}) {
    const MAX_ACCOUNTS = 3;
    const COOLDOWN_MINUTES = 5;

    // Admins and unlimited users bypass all restrictions
    if (skipLimits || isUnlimitedUser(chatId)) {
        return { allowed: true };
    }
    
    const data = getLogs();
    if (!data.userLimits) data.userLimits = {};
    
    const userLimit = data.userLimits[chatId];
    const accountCount = getAccountCount(chatId);
    
    // Check max accounts limit
    if (accountCount >= MAX_ACCOUNTS) {
        return { 
            allowed: false, 
            reason: 'max_accounts',
            message: `הגעת למגבלת ${MAX_ACCOUNTS} חשבונות. אנא המתן שחשבון קיים יפוג.`
        };
    }
    
    // Check cooldown
    if (userLimit && userLimit.lastCreated) {
        const lastCreated = new Date(userLimit.lastCreated);
        const now = new Date();
        const diffMinutes = (now - lastCreated) / (1000 * 60);
        
        if (diffMinutes < COOLDOWN_MINUTES) {
            const remainingMinutes = Math.ceil(COOLDOWN_MINUTES - diffMinutes);
            return {
                allowed: false,
                reason: 'cooldown',
                message: `אנא המתן ${remainingMinutes} דקות לפני יצירת חשבון נוסף.`
            };
        }
    }
    
    return { allowed: true };
}

function updateUserLimit(chatId) {
    const data = getLogs();
    if (!data.userLimits) data.userLimits = {};
    
    data.userLimits[chatId] = {
        lastCreated: new Date().toISOString()
    };
    
    persistDb(data);
}

function getExpiringAccounts() {
    const data = getLogs();
    if (!data.accounts) return [];
    
    const now = new Date();
    const expiringAccounts = [];
    
    Object.keys(data.accounts).forEach(chatId => {
        data.accounts[chatId].forEach(account => {
            if (!account.active) return;
            
            const expiresAt = new Date(account.expiresAt);
            const hoursUntilExpiry = (expiresAt - now) / (1000 * 60 * 60);
            
            // Notify 24 hours before expiry
            if (hoursUntilExpiry <= 24 && hoursUntilExpiry > 0 && !account.notificationSent) {
                expiringAccounts.push({
                    chatId: chatId,
                    account: account,
                    hoursRemaining: Math.floor(hoursUntilExpiry)
                });
            }
            
            // Mark as inactive if expired
            if (hoursUntilExpiry <= 0) {
                account.active = false;
            }
        });
    });
    
    if (expiringAccounts.length > 0 || Object.keys(data.accounts).some(chatId => 
        data.accounts[chatId].some(acc => !acc.active && acc.active !== false))) {
        persistDb(data);
    }
    
    return expiringAccounts;
}

function markNotificationSent(chatId, accountId) {
    const data = getLogs();
    if (!data.accounts || !data.accounts[chatId]) return;
    
    const account = data.accounts[chatId].find(acc => acc.id === accountId);
    if (account) {
        account.notificationSent = true;
        persistDb(data);
    }
}

// Admin Functions
function getBlacklist() {
    const data = getLogs();
    return data.blacklist || [];
}

function addToBlacklist(chatId, reason, adminId) {
    const data = getLogs();
    if (!data.blacklist) data.blacklist = [];
    const id = String(chatId);
    const existing = data.blacklist.find(b => String(b.chatId) === id);
    if (!existing) {
        data.blacklist.push({
            chatId: id,
            reason,
            addedBy: adminId,
            addedAt: new Date().toISOString()
        });
        persistDb(data);
        return true;
    }
    return false;
}

function removeFromBlacklist(chatId) {
    const data = getLogs();
    if (!data.blacklist) return false;
    const id = String(chatId);
    const index = data.blacklist.findIndex(b => String(b.chatId) === id);
    if (index !== -1) {
        data.blacklist.splice(index, 1);
        persistDb(data);
        return true;
    }
    return false;
}

function isBlacklisted(chatId) {
    const data = getLogs();
    if (!data.blacklist) return false;
    const id = String(chatId);
    return data.blacklist.some(b => String(b.chatId) === id);
}

function getStats() {
    const data = getLogs();
    const now = new Date();
    const last24h = new Date(now - 24 * 60 * 60 * 1000);
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
    
    const recentLogs = data.logs.filter(log => {
        const logDate = new Date(log.timestamp);
        return !isNaN(logDate.getTime());
    });
    
    const logs24h = recentLogs.filter(log => new Date(log.timestamp) >= last24h);
    const logs7d = recentLogs.filter(log => new Date(log.timestamp) >= last7d);
    
    const successfulCreations = data.logs.filter(l => 
        l.action === 'create_account' && l.status === 'success'
    );
    
    const failedCreations = data.logs.filter(l => 
        l.action === 'create_account' && l.status === 'failed'
    );
    
    const totalAccounts = Object.values(data.accounts || {}).reduce((sum, userAccounts) => 
        sum + userAccounts.filter(a => a.active).length, 0
    );
    
    return {
        totalUsers: data.stats.activeUsers || 0,
        totalAccountsCreated: data.stats.totalCreated || 0,
        activeAccounts: totalAccounts,
        successRate: successfulCreations.length > 0 ? 
            ((successfulCreations.length / (successfulCreations.length + failedCreations.length)) * 100).toFixed(1) : 0,
        users24h: new Set(logs24h.map(l => l.chatId)).size,
        accounts24h: logs24h.filter(l => l.action === 'create_account' && l.status === 'success').length,
        users7d: new Set(logs7d.map(l => l.chatId)).size,
        accounts7d: logs7d.filter(l => l.action === 'create_account' && l.status === 'success').length,
        blacklistedUsers: (data.blacklist || []).length
    };
}

function getAllUsers() {
    const data = getLogs();
    const usersMap = new Map();

    /** Align keys with groupMembers (numeric Telegram user ids). */
    function normalizeChatId(raw) {
        if (raw == null) return null;
        if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
        return raw;
    }

    // First pass: collect lastAction and identify all users (from bot logs)
    data.logs.forEach((log) => {
        const cid = normalizeChatId(log.chatId);
        if (cid == null) return;

        if (!usersMap.has(cid)) {
            const accounts = getUserAccounts(cid);
            usersMap.set(cid, {
                chatId: cid,
                username: 'Unknown',
                firstName: 'Unknown',
                lastName: '',
                telegramUsername: null,
                lastAction: log.timestamp,
                accountCount: accounts.length,
                activeAccounts: accounts.filter((a) => a.active).length,
                isBlacklisted: isBlacklisted(cid),
                isBroadcastExcluded: isBroadcastExcluded(cid)
            });
        } else {
            const existingTime = new Date(usersMap.get(cid).lastAction).getTime();
            const logTime = new Date(log.timestamp).getTime();
            if (logTime > existingTime) {
                usersMap.get(cid).lastAction = log.timestamp;
            }
        }

        if (log.username && log.username !== 'ADMIN') {
            const user = usersMap.get(cid);
            if (user.username === 'Unknown' || log.userInfo) {
                if (log.username !== 'Missing') user.username = log.username;
                user.firstName = log.userInfo?.first_name || user.username;
                user.lastName = log.userInfo?.last_name || '';
                user.telegramUsername = log.userInfo?.username || user.telegramUsername;
            }
        }
    });

    usersMap.forEach((user) => {
        if (user.firstName === 'Unknown' && user.username !== 'Unknown') {
            user.firstName = user.username;
        }
    });

    // Roster from group / Supabase merge: users who never hit the bot still appear in /users
    const gm = data.groupMembers || {};
    const rosterOnlyTs = '1970-01-01T00:00:00.000Z';
    for (const idStr of Object.keys(gm)) {
        if (!/^\d+$/.test(idStr)) continue;
        const chatId = Number(idStr);
        const v = gm[idStr];
        let user = usersMap.get(chatId);
        if (user === undefined) {
            const accounts = getUserAccounts(chatId);
            usersMap.set(chatId, {
                chatId,
                username: v.username != null ? String(v.username) : 'Unknown',
                firstName:
                    v.firstName != null
                        ? String(v.firstName)
                        : v.username != null
                          ? String(v.username)
                          : 'Unknown',
                lastName: v.lastName != null ? String(v.lastName) : '',
                telegramUsername: v.username ?? null,
                lastAction: v.updatedAt || rosterOnlyTs,
                accountCount: accounts.length,
                activeAccounts: accounts.filter((a) => a.active).length,
                isBlacklisted: isBlacklisted(chatId),
                isBroadcastExcluded: isBroadcastExcluded(chatId)
            });
        } else {
            if (user.firstName === 'Unknown' || user.firstName === '') {
                if (v.firstName) user.firstName = String(v.firstName);
                else if (v.username) user.firstName = String(v.username);
            }
            if ((!user.lastName || user.lastName === '') && v.lastName) {
                user.lastName = String(v.lastName);
            }
            if (user.username === 'Unknown' && v.username) user.username = String(v.username);
            if (!user.telegramUsername && v.username) user.telegramUsername = v.username;
        }
    }

    return Array.from(usersMap.values()).sort(
        (a, b) => new Date(b.lastAction) - new Date(a.lastAction)
    );
}

// Unlimited users (no account cap, no cooldown)
function isUnlimitedUser(chatId) {
    const data = getLogs();
    if (!data.unlimitedUsers) return false;
    return data.unlimitedUsers.some(id => String(id) === String(chatId));
}

function addUnlimitedUser(chatId) {
    const data = getLogs();
    if (!data.unlimitedUsers) data.unlimitedUsers = [];
    const id = String(chatId);
    if (!data.unlimitedUsers.includes(id)) {
        data.unlimitedUsers.push(id);
        persistDb(data);
        return true;
    }
    return false;
}

function removeUnlimitedUser(chatId) {
    const data = getLogs();
    if (!data.unlimitedUsers) return false;
    const id = String(chatId);
    const index = data.unlimitedUsers.indexOf(id);
    if (index !== -1) {
        data.unlimitedUsers.splice(index, 1);
        persistDb(data);
        return true;
    }
    return false;
}

// Global account creation on/off switch
function isCreationEnabled() {
    const data = getLogs();
    return data.creationEnabled !== false; // default true
}

function setCreationEnabled(enabled) {
    const data = getLogs();
    data.creationEnabled = enabled;
    persistDb(data);
}

// Whitelist
function isWhitelistEnabled() {
    const data = getLogs();
    return data.whitelistEnabled === true;
}

function setWhitelistEnabled(enabled) {
    const data = getLogs();
    data.whitelistEnabled = enabled;
    persistDb(data);
}

function getWhitelist() {
    const data = getLogs();
    return data.whitelist || [];
}

function isWhitelisted(chatId) {
    const data = getLogs();
    if (!data.whitelist) return false;
    return data.whitelist.some(entry => String(entry.chatId) === String(chatId));
}

function addToWhitelist(chatId, addedBy, note = '') {
    const data = getLogs();
    if (!data.whitelist) data.whitelist = [];
    const id = String(chatId);
    if (!data.whitelist.some(e => String(e.chatId) === id)) {
        data.whitelist.push({ chatId: id, addedBy: String(addedBy), note, addedAt: new Date().toISOString() });
        persistDb(data);
        return true;
    }
    return false;
}

function removeFromWhitelist(chatId) {
    const data = getLogs();
    if (!data.whitelist) return false;
    const id = String(chatId);
    const index = data.whitelist.findIndex(e => String(e.chatId) === id);
    if (index !== -1) {
        data.whitelist.splice(index, 1);
        persistDb(data);
        return true;
    }
    return false;
}

// Dynamic admin management (stored in db.json, in addition to env-var admins)
function getDbAdmins() {
    const data = getLogs();
    return data.admins || [];
}

function addDbAdmin(chatId) {
    const data = getLogs();
    if (!data.admins) data.admins = [];
    const id = String(chatId);
    if (!data.admins.includes(id)) {
        data.admins.push(id);
        persistDb(data);
        return true;
    }
    return false;
}

function removeDbAdmin(chatId) {
    const data = getLogs();
    if (!data.admins) return false;
    const id = String(chatId);
    const index = data.admins.indexOf(id);
    if (index !== -1) {
        data.admins.splice(index, 1);
        persistDb(data);
        return true;
    }
    return false;
}

// Broadcast Analytics
function addBroadcast(broadcastData) {
    const data = getLogs();
    if (!data.broadcasts) data.broadcasts = [];
    
    const newBroadcast = {
        id: Date.now().toString(),
        timestamp: new Date().toISOString(),
        messagePreview: broadcastData.messagePreview,
        targetUrl: broadcastData.targetUrl || null,
        buttonLabel: broadcastData.buttonLabel || null,
        sentCount: 0,
        failedCount: 0,
        clickCount: 0,
        clicks: []
    };
    
    data.broadcasts.unshift(newBroadcast);
    persistDb(data);
    return newBroadcast;
}

function updateBroadcastStats(id, stats) {
    const data = getLogs();
    if (!data.broadcasts) return;
    
    const broadcast = data.broadcasts.find(b => b.id === id);
    if (broadcast) {
        if (stats.sentCount !== undefined) broadcast.sentCount = stats.sentCount;
        if (stats.failedCount !== undefined) broadcast.failedCount = stats.failedCount;
        persistDb(data);
    }
}

function logBroadcastClick(id, userInfo = null) {
    const data = getLogs();
    if (!data.broadcasts) return;
    
    const broadcast = data.broadcasts.find(b => b.id === id);
    if (broadcast) {
        broadcast.clickCount++;
        if (userInfo) {
            broadcast.clicks.push({
                timestamp: new Date().toISOString(),
                ...userInfo
            });
        }
        persistDb(data);
        return broadcast.targetUrl;
    }
    return null;
}

function getBroadcasts() {
    const data = getLogs();
    return data.broadcasts || [];
}

// Broadcast Exclusion functions
function isBroadcastExcluded(chatId) {
    const data = getLogs();
    if (!data.broadcastExclusion) return false;
    return data.broadcastExclusion.some(id => String(id) === String(chatId));
}

function addToBroadcastExclusion(chatId) {
    const data = getLogs();
    if (!data.broadcastExclusion) data.broadcastExclusion = [];
    const id = String(chatId);
    if (!data.broadcastExclusion.includes(id)) {
        data.broadcastExclusion.push(id);
        persistDb(data);
        return true;
    }
    return false;
}

function removeFromBroadcastExclusion(chatId) {
    const data = getLogs();
    if (!data.broadcastExclusion) return false;
    const id = String(chatId);
    const index = data.broadcastExclusion.indexOf(id);
    if (index !== -1) {
        data.broadcastExclusion.splice(index, 1);
        persistDb(data);
        return true;
    }
    return false;
}

/** Remember a user as currently in the required group (for broadcast list). Telegram has no "list all members" API. */
function upsertGroupMember(chatId, telegramUser) {
    const data = getLogs();
    if (!data.groupMembers) data.groupMembers = {};
    if (telegramUser && telegramUser.is_bot) return;
    const id = String(chatId);
    const prev = data.groupMembers[id] || {};
    data.groupMembers[id] = {
        username: telegramUser?.username ?? prev.username ?? null,
        firstName: telegramUser?.first_name ?? telegramUser?.firstName ?? prev.firstName ?? null,
        lastName: telegramUser?.last_name ?? telegramUser?.lastName ?? prev.lastName ?? null,
        updatedAt: new Date().toISOString()
    };
    persistDb(data);
    try {
        const { scheduleUpsertTelegramUser } = require('./supabaseSync');
        scheduleUpsertTelegramUser({
            telegram_user_id: Number(id),
            username: data.groupMembers[id].username,
            first_name: data.groupMembers[id].firstName,
            last_name: data.groupMembers[id].lastName,
            is_bot: false,
            source: 'chat_member'
        });
    } catch (_) { /* optional */ }
}

function removeGroupMember(chatId) {
    const data = getLogs();
    if (!data.groupMembers) return;
    const id = String(chatId);
    if (data.groupMembers[id]) {
        delete data.groupMembers[id];
        persistDb(data);
        try {
            const { scheduleDeleteTelegramUser } = require('./supabaseSync');
            scheduleDeleteTelegramUser(Number(id));
        } catch (_) { /* optional */ }
    }
}

/** Bulk seed groupMembers (e.g. from scripts/seed-group-members.js). Skips bots, dedupes by id, upserts without duplicate keys. */
function mergeGroupMembersFromExport(userList) {
    const data = readDbSafe();
    ensureDbShape(data);
    if (!data.groupMembers) data.groupMembers = {};
    const now = new Date().toISOString();
    let inserted = 0;
    let updated = 0;
    const seen = new Set();

    for (const u of userList) {
        if (!u || u.bot || u.id == null) continue;
        const id = String(typeof u.id === 'bigint' ? Number(u.id) : u.id);
        if (!/^\d+$/.test(id) || seen.has(id)) continue;
        seen.add(id);

        const prev = data.groupMembers[id] || {};
        const hadKey = Object.prototype.hasOwnProperty.call(data.groupMembers, id);
        data.groupMembers[id] = {
            username: u.username != null ? u.username : prev.username ?? null,
            firstName: u.firstName != null ? u.firstName : prev.firstName ?? null,
            lastName: u.lastName != null ? u.lastName : prev.lastName ?? null,
            updatedAt: now
        };
        if (hadKey) updated++;
        else inserted++;
    }

    persistDb(data);
    try {
        const { scheduleBulkUpsertFromGroupMembers } = require('./supabaseSync');
        scheduleBulkUpsertFromGroupMembers(data.groupMembers, 'seed_export');
    } catch (_) { /* optional */ }
    return {
        inserted,
        updated,
        processed: seen.size,
        totalKeys: Object.keys(data.groupMembers).length
    };
}

/**
 * Users who should receive admin broadcasts: everyone in logs (not blocked / not broadcast-excluded)
 * plus group members we are tracking when mergeGroupMembers is true.
 */
function getBroadcastRecipients(mergeGroupMembers) {
    const eligibleFromLogs = getAllUsers().filter(u => !u.isBlacklisted && !u.isBroadcastExcluded);
    if (!mergeGroupMembers) return eligibleFromLogs;

    const data = getLogs();
    const map = new Map();
    for (const u of eligibleFromLogs) {
        map.set(String(u.chatId), u);
    }
    const gm = data.groupMembers;
    if (!gm || typeof gm !== 'object') return Array.from(map.values());

    for (const idStr of Object.keys(gm)) {
        if (isBlacklisted(idStr) || isBroadcastExcluded(idStr)) continue;
        if (!map.has(idStr)) {
            const chatId = /^\d+$/.test(idStr) ? Number(idStr) : idStr;
            map.set(idStr, { chatId });
        }
    }
    return Array.from(map.values());
}

module.exports = {
    ready,
    getLogs,
    addLog,
    addChatMessage, 
    getChatMessages, 
    getAllChats,
    updateProgress,
    getProgress,
    clearProgress,
    addAccount,
    getUserAccounts,
    getAccountCount,
    canCreateAccount,
    updateUserLimit,
    getExpiringAccounts,
    markNotificationSent,
    // Admin functions
    getBlacklist,
    addToBlacklist,
    removeFromBlacklist,
    isBlacklisted,
    getStats,
    getAllUsers,
    // Dynamic admin promotion
    getDbAdmins,
    addDbAdmin,
    removeDbAdmin,
    // Unlimited users
    isUnlimitedUser,
    addUnlimitedUser,
    removeUnlimitedUser,
    // Global creation switch
    isCreationEnabled,
    setCreationEnabled,
    // Whitelist
    isWhitelistEnabled,
    setWhitelistEnabled,
    getWhitelist,
    isWhitelisted,
    addToWhitelist,
    removeFromWhitelist,
    // Broadcast Analytics
    addBroadcast,
    updateBroadcastStats,
    logBroadcastClick,
    getBroadcasts,
    // Broadcast Exclusion
    isBroadcastExcluded,
    addToBroadcastExclusion,
    removeFromBroadcastExclusion,
    upsertGroupMember,
    removeGroupMember,
    getBroadcastRecipients,
    mergeGroupMembersFromExport
};
