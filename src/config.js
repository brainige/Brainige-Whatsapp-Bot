"use strict"
/* src/config.js — env loading, constants, paths, JSON IO (atomic), settings load.
   NOTE: .env is only consumed by dotenv here. Values are never printed. */

require("dotenv").config({ override: false })

const fs = require("fs-extra")
const path = require("path")
const state = require("./state")

const VERSION = "6.5"

const ADMIN       = process.env.ADMIN || ""
const VT_API_KEY  = process.env.VT_API_KEY || ""
const LLM_URL     = process.env.LLM_URL || "http://127.0.0.1:1234/v1/chat/completions"
const LLM_MODEL   = process.env.LLM_MODEL || "Qwen3-1.7B-Instruct"
const LLM_MAX_TOKENS = 150
const LLM_TIMEOUT    = 8000

const CONVO_TTL      = 600000
const TOPIC_SHIFT_TTL = 45000
const LAST_MSG_TTL    = 600000

/* These three are now WIRED into handler.decide() — before, they existed here
   but nothing used them (the handler hard-coded the numbers), so editing them
   silently did nothing. */
const GROUP_CONFIDENCE_THRESHOLD = 0.75
const THRESHOLD_HIGH   = 0.60
const THRESHOLD_MEDIUM = 0.42
const LLM_LEARN_MAX_HYBRID = 0.30
const VT_RATE_LIMIT  = 3
const VT_RATE_WINDOW = 60000
const VT_TIMEOUT_MS  = 8000   // a hung VirusTotal connection can no longer stall a message forever
const HN_SEM_THRESHOLD = 0.72
const DIGEST_HOUR = 21
const DIGEST_MINUTE = 0

/* ── C-batch tunables (2026-10-16) ── */
const LEARN_DIRECT_MIN_COSINE       = 0.60  // owner-reply direct-commit relatedness bar (tunable)
const LEARN_DIRECT_MIN_SHARED_WORDS = 1     // shared meaningful words needed for a direct commit
const EMBED_TEXT_MAX_CHARS          = 1500  // CPU cap only — the model itself cuts at ~256 tokens
const FLUSH_INTERVAL_MS             = 30000 // chat_memory.json dirty-flush cadence
const PROCESSED_ID_MAX_AGE_MS       = 48 * 60 * 60 * 1000 // forget processed IDs older than this
const PROCESSED_ID_HARD_CAP         = 5000  // max number of remembered IDs
const PROCESSED_ID_COMPACT_AT       = 10000 // compact the jsonl once it grows past this many lines
const RECONNECT_MAX_RETRIES         = 3     // C3
const RECONNECT_BASE_DELAY_MS       = 10000 // 10s → 20s → 40s backoff
const DESTROY_TIMEOUT_MS            = 15000 // never let a hung destroy() wedge the reconnect
const READY_WATCHDOG_MS             = 90000 // no 'ready' within this after a reconnect = failed attempt

/* ── D/E-batch tunables (2026-10-21) ── */
const KB_FULL_SCAN_MAX  = 400               // ≤ this many entries → EVERY entry gets the full hybrid scan (the original full-scan behavior)
const KB_CANDIDATE_POOL = 200               // bigger brain → meaning-math runs only on the top N word-index candidates
const MEDIA_MAX_BYTES   = 20 * 1024 * 1024  // media over 20MB is logged but never downloaded/saved
const EMBED_CACHE_MAX   = 25000            // embedding-CACHE cap (~38MB worst case). knowledge.json itself is NEVER capped.
const LLM_DONT_KNOW     = "I don't know. You'll need to contact Utsab."   // the ONLY allowed unsure-fallback reply

/* ── Reply-matching tunables — every number in ONE place ──
   These were previously hard-coded at their usage sites. Pure renames:
   identical math, now tunable here (search weights, fusion weights, decision
   thresholds, and the learning bars). */
const SEARCH_LEX_COSINE_WEIGHT    = 0.6   // lexical blend: word-vector cosine share
const SEARCH_LEX_JACCARD_WEIGHT   = 0.4   // lexical blend: word-overlap share
const SEARCH_LEN_NORM_BASE        = 0.55  // length factor: floor when message lengths mismatch
const SEARCH_LEN_NORM_RATIO      = 0.45  // length factor: how much a matching length helps
const SEARCH_HYBRID_SEM_WEIGHT   = 0.6   // hybrid blend: meaning-math share
const SEARCH_HYBRID_LEX_WEIGHT   = 0.4   // hybrid blend: word-match share
const SEARCH_CONTEXT_LEX_BOOST   = 0.08  // recent-context word bonus (score capped at 1.0)
const SEARCH_CONTEXT_SEM_BOOST   = 0.07  // recent-context meaning bonus (score capped at 1.0)
const SEARCH_MARGIN_MIN          = 0.06  // best must beat 2nd-best by at least this…
const SEARCH_MARGIN_PENALTY      = 0.80  // …or the winning score is multiplied by this
const FUSE_HYBRID_WEIGHT         = 0.7   // fused score: hybrid share (drives REPLY decisions)
const FUSE_INTENT_WEIGHT         = 0.3   // fused score: intent share (drives REPLY decisions)
const LEARN_ANSWER_RELATED_COSINE = 0.40 // learn gate: answer must relate to its question at least this
const NEAR_DUP_LEXICAL           = 0.90  // learn gate: word-level near-duplicate bar
const NEAR_DUP_COSINE            = 0.92  // learn gate: meaning-level near-duplicate bar

/* ── Send-guard + admin-notice batching tunables ──
   Replies stay INSTANT, the QUICK REPLY prefix stays, no read receipts —
   the guard bounds VOLUME only. Admin/self-chat sends bypass the guard
   entirely (the control channel must never be throttled). */
const SEND_MIN_GAP_MS_MIN     = 3000     // minimum pause between two bot sends (jittered within this range)
const SEND_MIN_GAP_MS_MAX     = 6000     // top of the jitter range
const SEND_HOURLY_CAP         = 25       // bot replies per rolling window (WhatsApp flags >30/hour)
const SEND_CAP_WINDOW_MS      = 3600000  // the rolling window for the hourly cap
const SEND_QUEUE_MAX_AGE_MS   = 600000   // a queued reply older than this is dropped + logged (owner choice 2026-10-23)
const IDENTICAL_TEXT_HOUR_CAP = 4        // same text to the same chat per window (WhatsApp flags >5-15 identical/hour)
const NOTIFY_BATCH_MS         = 300000   // low-priority admin notices coalesce into one summary
const NOTIFY_BATCH_MAX_LINES  = 8        // max lines per summary before "+N more"
const BOT_SENT_ID_TTL_MS      = 600000   // bot-sent ID memory (mirrors the 10-min text TTL; was an unswept Set)

/* ── Retention + performance tunables (behavior-identical by design) ──
   knowledge.json is NEVER capped; chat logs grow forever (no size cap);
   conversations.db keeps everything forever; media files are kept 60 days;
   inactive chat_memory users are pruned after 60 days; VirusTotal free-tier
   limits are respected. */
const CONTACT_NAME_TTL_MS        = 24 * 60 * 60 * 1000  // JID → display-name cache lifetime
const MEDIA_RETENTION_DAYS       = 60                    // media files older than this are deleted; the chat-log line keeps the record forever
const CHAT_MEMORY_USER_TTL_DAYS = 60                    // chat_memory users inactive longer than this are pruned

/* ── Human handoff ──
   When the owner replies to a customer from their own phone the bot stands
   down for that chat — no auto-replies while the owner is handling it. The
   window slides: each new owner reply pushes the expiry out, and auto-replies
   resume on their own once it lapses. */
const HANDOFF_WINDOW_MS = 30 * 60 * 1000   // 30 minutes of owner-handled silence

const PATHS = {
    MEMORY:    "./memory/chat_memory.json",
    KNOWLEDGE: "./memory/knowledge.json",
    SETTINGS:  "./memory/settings.json",
    KNOW_DB:   "./memory/knowledge.db",
    CONVO_DB:  "./memory/conversations.db",
    REVIEW_DB: "./memory/review.db",
    TYPO:      "./memory/typo.json",
    HN_JSON:   "./memory/HumanInterference.json",
    LINKS_LEDGER: "./memory/links.jsonl",
    EMBED_CACHE: "./memory/embeddings_cache.json",
    PROCESSED_IDS: "./memory/processed_ids.jsonl",   // survives restarts
    LOG_ERRORS:    "./logs/errors.txt",              // nothing fails silently anymore
    MEDIA_CHATS:  "./media/chats",
    MEDIA_GROUPS: "./media/groups",
    LOG_CHATS:    "./logs/chats",
    LOG_GROUPS:   "./logs/groups",
    LOG_HN:       "./logs/human_needed.txt",
    LOG_ADMIN:    "./logs/admin.txt",
    LOG_BACKUPS:  "./logs/backups",
    LLM_CTX_CHATS:  "./llm_context/chats",
    LLM_CTX_GROUPS: "./llm_context/groups"
}

const TRUSTED_DOMAINS = [
    "youtube.com", "youtu.be", "google.com", "play.google.com", "github.com",
    "whatsapp.com", "instagram.com", "facebook.com", "twitter.com", "x.com",
    "wikipedia.org", "amazon.in", "amazon.com", "stackoverflow.com"
]

const INTENT_WEIGHTS = {
    greeting: 0.95, apology: 0.90, angry: 0.90,
    emotional: 0.90, thanks: 0.95, bye: 0.92,
    help: 0.70, question: 0.65, short: 0.20, chat: 0.30
}

/* ── JSON IO ───────────────────────────────────────────
   A3 fix: writes are ATOMIC — data goes to <file>.tmp first,
   then is renamed over the real file (rename never leaves a
   half-written file). knowledge.json additionally keeps the
   previous copy as knowledge.json.bak before being replaced. */

// Tracks which files failed JSON.parse after existing on disk.
// (Renamed from knowledgeLoadFailures — settings.json and chat_memory.json
// failures land here too now, and startup protection consumes them below.)
// Declared before loadJSON, which writes to it.
const jsonLoadFailures = new Set()

// Protection notices for settings.json / chat_memory.json, drained by
// bot.js after 'ready'. Declared HERE (above startupProtectStateFiles' call
// site) — a const declared later in the file is not initialized yet when the
// load-state section runs.
const stateFileNotices = []
function drainStateFileNotices() { return stateFileNotices.splice(0) }

/* config.js sits BELOW logging.js in the import graph (logging requires
   config), so it can only reach logError lazily and guarded. Before config
   has fully loaded we degrade to console.warn — never silence, never crash. */
let _configFullyLoaded = false
function logErrorSafe(location, context, err, opts) {
    if (!_configFullyLoaded) {
        try { console.warn(`⚠️  [${location}] ${context}${err ? " — " + (err.message || err) : ""}`) } catch { }
        return
    }
    try { require("./logging").logError(location, context, err, opts) } catch { }
}

function atomicWrite(filePath, text) {
    const tmp = filePath + ".tmp"
    fs.writeFileSync(tmp, text)
    fs.moveSync(tmp, filePath, { overwrite: true })
}

function loadJSON(filePath, defaultVal) {
    if (!fs.existsSync(filePath)) {
        atomicWrite(filePath, JSON.stringify(defaultVal, null, 2))
        return defaultVal
    }
    try { return JSON.parse(fs.readFileSync(filePath, "utf8")) }
    catch (e) {
        // A parse failure on an EXISTING file is never normal — record it so
        // startup protection can restore-from-backup instead of rebuilding
        // the knowledge DB from an empty default (silent data destruction).
        jsonLoadFailures.add(filePath)
        console.error(`⚠️  Failed to parse ${filePath}:`, e.message)
        return defaultVal
    }
}

/* State files keep a rotating .bak — the restore source if a file ever
   arrives corrupt (settings.json holds the blacklist, group lists, learnBlock
   and the DND schedule; chat_memory.json holds every contact's history).
   knowledge.json already had one. */
const BAKED_STATE_FILES = new Set([PATHS.KNOWLEDGE, PATHS.SETTINGS, PATHS.MEMORY])

function saveJSON(filePath, data) {
    try {
        if (BAKED_STATE_FILES.has(filePath) && fs.existsSync(filePath)) {
            try { fs.copySync(filePath, filePath + ".bak") } catch (e) { logErrorSafe("config.saveJSON", `${path.basename(filePath)} .bak copy failed`, e, { quiet: true }) }
        }
        atomicWrite(filePath, JSON.stringify(data, null, 2))
    } catch (e) { console.error(`⚠️  Failed to save ${filePath}:`, e.message) }
}

function saveSettings() { saveJSON(PATHS.SETTINGS, state.settings) }

/* Async atomic write for the 30s flush timer — never blocks the event
   loop while a message is being answered. Same tmp+rename safety as saveJSON. */
async function saveJSONAsync(filePath, data) {
    if (BAKED_STATE_FILES.has(filePath) && fs.existsSync(filePath)) {
        try { await fs.promises.copyFile(filePath, filePath + ".bak") } catch (e) { logErrorSafe("config.saveJSONAsync", `${path.basename(filePath)} .bak copy failed`, e, { quiet: true }) }
    }
    const tmp = filePath + ".tmp"
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2))
    await fs.promises.rename(tmp, filePath)
}

/* ── filesystem setup ── */
for (const dir of [
    "./memory", "./memory/models",
    PATHS.MEDIA_CHATS, PATHS.MEDIA_GROUPS,
    PATHS.LOG_CHATS, PATHS.LOG_GROUPS, PATHS.LOG_BACKUPS,
    PATHS.LLM_CTX_CHATS, PATHS.LLM_CTX_GROUPS
]) fs.ensureDirSync(dir)

/* ── human-needed config (Layer-1 regex + Layer-2 exemplars) ── */
const HN_CONFIG = loadJSON(PATHS.HN_JSON, { categories: [], exemplars: {} })

const HUMAN_NEEDED_PATTERNS = []
for (const cat of (HN_CONFIG.categories || [])) {
    try {
        HUMAN_NEEDED_PATTERNS.push({ label: cat.label || "unknown", regex: new RegExp(cat.pattern, "i") })
    } catch (e) {
        console.error(`⚠️  Bad regex in HumanInterference.json category "${cat.label}":`, e.message)
    }
}

/* ── load core state ── */
state.persistentMemory = loadJSON(PATHS.MEMORY, {})
state.knowledge = loadJSON(PATHS.KNOWLEDGE, { entries: [] })
state.settings = loadJSON(PATHS.SETTINGS, {
    learning: true, blacklist: [], whitelist: [],
    groupWhitelist: [], groupBlacklist: [], globalPauseUntil: 0
})

// settings.json / chat_memory.json get the SAME startup protection
// knowledge.json has — BEFORE the defaults are applied and BEFORE
// saveSettings() could overwrite a broken file with defaults.
startupProtectStateFiles()

// backward-compatible settings defaults (preserved from V6.4/V6.5)
const settings = state.settings
if (!Array.isArray(settings.blacklist)) settings.blacklist = []
if (!Array.isArray(settings.whitelist)) settings.whitelist = []
if (!Array.isArray(settings.groupWhitelist)) settings.groupWhitelist = []
if (!Array.isArray(settings.groupBlacklist)) settings.groupBlacklist = []
if (!Array.isArray(settings.learnBlock)) settings.learnBlock = []
if (settings.learning === undefined) settings.learning = true
if (!settings.globalPauseUntil) settings.globalPauseUntil = 0
if (!settings.customPauseDurations || typeof settings.customPauseDurations !== "object") settings.customPauseDurations = {}
if (!settings.globalPauseDuration) settings.globalPauseDuration = 600
if (!settings.dndSchedule || typeof settings.dndSchedule !== "object") settings.dndSchedule = { enabled: false, start: "23:00", end: "07:00" }
if (!settings.groupNames || typeof settings.groupNames !== "object") settings.groupNames = {}
if (settings.debug === undefined) settings.debug = false
if (settings.dryRun === undefined) settings.dryRun = false
if (settings.quiet === undefined) settings.quiet = false   // hides only the per-message decision console line
if (!settings.digestState || typeof settings.digestState !== "object") {
    settings.digestState = {
        totals: { messages: 0, kbReplies: 0, llmReplies: 0, quickReplies: 0 },
        hnCategories: {}, newContacts: [], lastDigestISO: null
    }
}
saveSettings()

state.knowledge.entries = state.knowledge.entries.filter(e =>
    e &&
    typeof e.message === "string" && e.message.trim().length > 0 &&
    typeof e.reply === "string" && e.reply.trim().length > 0
).map(e => ({ message: e.message, reply: e.reply }))   // the machine "vector" field is dropped at load; it is fully rebuilt from the question text on every boot

state.globalPauseUntil = settings.globalPauseUntil && settings.globalPauseUntil > Date.now()
    ? settings.globalPauseUntil
    : 0

/* ── knowledge startup protection ─────────────
   Every (re)start, copy knowledge.json → logs/backups/
   knowledge_prestart_<stamp>.json BEFORE knowledge.db is
   rebuilt. Hands you a "last known good" brain snapshot.
   If knowledge.json exists but fails JSON.parse, DON'T
   silently rebuild from an empty default. Restore from the
   newest valid backup, notify admin via startup notice,
   and keep the corrupt file on disk as *.corrupt for
   manual salvage. */

   const KNOWLEDGE_BACKUP_KEEP = 5      // keep the latest N backups, delete older

function pruneOldKnowledgeBackups() {
    try {
        const files = fs.readdirSync(PATHS.LOG_BACKUPS)
            .filter(f => f.startsWith("knowledge_prestart_") && f.endsWith(".json"))
            .sort()   // name contains ISO stamp → lexical order == time order
        while (files.length > KNOWLEDGE_BACKUP_KEEP) {
            const oldest = files.shift()
            try { fs.removeSync(path.join(PATHS.LOG_BACKUPS, oldest)) } catch (e) { logErrorSafe("config.pruneOldKnowledgeBackups", "old backup delete failed", e, { quiet: true }) }
        }
    } catch (e) { logErrorSafe("config.pruneOldKnowledgeBackups", "backup folder unreadable", e, { quiet: true }) }
}

function backupKnowledgeNow(source) {
    try {
        if (!fs.existsSync(PATHS.KNOWLEDGE)) return null
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const dest = path.join(PATHS.LOG_BACKUPS, `knowledge_prestart_${stamp}.json`)
        fs.copySync(PATHS.KNOWLEDGE, dest)
        pruneOldKnowledgeBackups()
        console.log(`💾 Knowledge backup (${source}): ${path.basename(dest)}`)
        return dest
    } catch (e) {
        console.error("⚠️  Knowledge backup failed:", e.message)
        return null
    }
}

function newestValidKnowledgeBackup() {
    try {
        const files = fs.readdirSync(PATHS.LOG_BACKUPS)
            .filter(f => f.startsWith("knowledge_prestart_") && f.endsWith(".json"))
            .sort()
            .reverse()   // newest first
        for (const f of files) {
            const full = path.join(PATHS.LOG_BACKUPS, f)
            try {
                const data = JSON.parse(fs.readFileSync(full, "utf8"))
                if (data && Array.isArray(data.entries)) return { path: full, data }
            } catch (e) { logErrorSafe("config.newestValidKnowledgeBackup", "unreadable backup candidate skipped", e, { quiet: true }) }
        }
    } catch (e) { logErrorSafe("config.newestValidKnowledgeBackup", "backup folder unreadable", e, { quiet: true }) }
    return null
}

function startupProtectKnowledge() {
    // Case 1: knowledge.json parsed fine → take the B1 backup, done.
    if (!jsonLoadFailures.has(PATHS.KNOWLEDGE)) {
        backupKnowledgeNow("startup")
        return { corrupted: false, restored: false }
    }

    // Case 2: knowledge.json was present but unparseable.
    console.error("🛑 knowledge.json failed to parse — NOT rebuilding from empty default.")

    // 1. Preserve the broken file for manual salvage (never delete).
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        fs.copySync(PATHS.KNOWLEDGE, PATHS.KNOWLEDGE + `.corrupt_${stamp}`)
    } catch (e) { logErrorSafe("config.startupProtectKnowledge", "corrupt-file salvage copy FAILED — the broken file was not preserved", e) }

    // 2. Restore from the newest VALID backup.
    const backup = newestValidKnowledgeBackup()
    if (backup) {
        try {
            fs.copySync(backup.path, PATHS.KNOWLEDGE)
            // reload into live state (we caught it at startup, before DB build)
            state.knowledge = backup.data
            jsonLoadFailures.delete(PATHS.KNOWLEDGE)
            const msg =
                `🛡️ RECOVERY: knowledge.json was corrupt on startup.\n` +
                `Restored from backup: ${path.basename(backup.path)}\n` +
                `Entries restored: ${backup.data.entries.length}\n` +
                `A .corrupt_<timestamp> copy of the broken file is kept in memory/ for manual salvage.`
            console.error(msg)
            return { corrupted: true, restored: true, from: path.basename(backup.path), notice: msg }
        } catch (e) {
            console.error("❌ Restore failed:", e.message)
        }
    }

    // 3. No usable backup — keep the (empty) default, but make it LOUD.
    const msg =
        `🚨 B3 ALERT: knowledge.json was corrupt AND no valid backup exists.\n` +
        `Bot is running with an EMPTY knowledge base — admin must act.\n` +
        `Fix memory/knowledge.json by hand (the .corrupt file is preserved) and restart.`
    console.error(msg)
    return { corrupted: true, restored: false, notice: msg }
}

/* ── Startup protection for the OTHER state files ──
   A corrupt settings.json used to silently load defaults, and the next save
   OVERWROTE the file — blacklist, group lists, learnBlock and the DND schedule
   wiped with a single console line. Now: preserve the broken file as
   *.corrupt_<ts>, restore from the newest valid backup (.bak next to the
   file, or a logs/backups/backup_<stamp> artifact from !backup), and deliver
   a LOUD admin notice. With no usable backup the bot runs with defaults for
   that file — loudly, never silently (B3 precedent). */
function stateFileBackupCandidates(filePath) {
    const out = [filePath + ".bak"]
    try {
        const base = path.basename(filePath)
        const dirs = fs.readdirSync(PATHS.LOG_BACKUPS)
            .filter(d => d.startsWith("backup_"))
            .sort().reverse()   // newest first (ISO stamp is in the name)
        for (const d of dirs) out.push(path.join(PATHS.LOG_BACKUPS, d, base))
    } catch { }
    return out
}

function newestValidStateBackup(filePath) {
    for (const cand of stateFileBackupCandidates(filePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(cand, "utf8"))
            if (data && typeof data === "object" && !Array.isArray(data)) return { path: cand, data }
        } catch { }
    }
    return null
}

function startupProtectStateFiles() {
    const targets = [
        [PATHS.SETTINGS, "settings.json", d => { state.settings = d }],
        [PATHS.MEMORY, "chat_memory.json", d => { state.persistentMemory = d }],
    ]
    for (const [filePath, label, apply] of targets) {
        if (!jsonLoadFailures.has(filePath)) continue
        console.error(`🛑 ${label} failed to parse — NOT silently resetting to defaults.`)
        // 1. Preserve the broken file for manual salvage (never delete it).
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-")
            fs.copySync(filePath, `${filePath}.corrupt_${stamp}`)
        } catch (e) { logErrorSafe("config.startupProtectStateFiles", `${label} corrupt-file salvage copy FAILED — the broken file was not preserved`, e) }
        // 2. Restore from the newest VALID backup.
        const backup = newestValidStateBackup(filePath)
        if (backup) {
            try {
                fs.copySync(backup.path, filePath)
                apply(backup.data)
                jsonLoadFailures.delete(filePath)
                const msg =
                    `🛡️ RECOVERY: ${label} was corrupt on startup.\n` +
                    `Restored from: ${backup.path}\n` +
                    `A .corrupt_<timestamp> copy of the broken file is kept in memory/ for manual salvage.`
                console.error(msg)
                stateFileNotices.push(msg)
                continue
            } catch (e) { console.error(`❌ Restore of ${label} from ${backup.path} failed:`, e.message) }
        }
        // 3. No usable backup — run with defaults, LOUDLY (B3 precedent).
        const msg =
            `🚨 ALERT: ${label} was corrupt AND no valid backup exists.\n` +
            `Bot runs with empty defaults for this file — check memory/, fix by hand\n` +
            `(the .corrupt_<timestamp> copy is preserved) and re-add your lists if needed.`
        console.error(msg)
        stateFileNotices.push(msg)
    }
}

_configFullyLoaded = true

module.exports = {
    VERSION, ADMIN, VT_API_KEY, LLM_URL, LLM_MODEL, LLM_MAX_TOKENS, LLM_TIMEOUT,
    CONVO_TTL, TOPIC_SHIFT_TTL, LAST_MSG_TTL,
    GROUP_CONFIDENCE_THRESHOLD, THRESHOLD_HIGH, THRESHOLD_MEDIUM,
    LLM_LEARN_MAX_HYBRID, VT_RATE_LIMIT, VT_RATE_WINDOW, VT_TIMEOUT_MS, HN_SEM_THRESHOLD,
    DIGEST_HOUR, DIGEST_MINUTE,
    LEARN_DIRECT_MIN_COSINE, LEARN_DIRECT_MIN_SHARED_WORDS, EMBED_TEXT_MAX_CHARS,
    FLUSH_INTERVAL_MS, PROCESSED_ID_MAX_AGE_MS, PROCESSED_ID_HARD_CAP, PROCESSED_ID_COMPACT_AT,
    RECONNECT_MAX_RETRIES, RECONNECT_BASE_DELAY_MS, DESTROY_TIMEOUT_MS, READY_WATCHDOG_MS,
    KB_FULL_SCAN_MAX, KB_CANDIDATE_POOL, MEDIA_MAX_BYTES, EMBED_CACHE_MAX, LLM_DONT_KNOW,
    SEARCH_LEX_COSINE_WEIGHT, SEARCH_LEX_JACCARD_WEIGHT, SEARCH_LEN_NORM_BASE, SEARCH_LEN_NORM_RATIO,
    SEARCH_HYBRID_SEM_WEIGHT, SEARCH_HYBRID_LEX_WEIGHT, SEARCH_CONTEXT_LEX_BOOST, SEARCH_CONTEXT_SEM_BOOST,
    SEARCH_MARGIN_MIN, SEARCH_MARGIN_PENALTY, FUSE_HYBRID_WEIGHT, FUSE_INTENT_WEIGHT,
    LEARN_ANSWER_RELATED_COSINE, NEAR_DUP_LEXICAL, NEAR_DUP_COSINE,
    SEND_MIN_GAP_MS_MIN, SEND_MIN_GAP_MS_MAX, SEND_HOURLY_CAP, SEND_CAP_WINDOW_MS,
    SEND_QUEUE_MAX_AGE_MS, IDENTICAL_TEXT_HOUR_CAP,
    NOTIFY_BATCH_MS, NOTIFY_BATCH_MAX_LINES, BOT_SENT_ID_TTL_MS,
    CONTACT_NAME_TTL_MS, MEDIA_RETENTION_DAYS, CHAT_MEMORY_USER_TTL_DAYS, HANDOFF_WINDOW_MS,
    PATHS, TRUSTED_DOMAINS, INTENT_WEIGHTS,
    HN_CONFIG, HUMAN_NEEDED_PATTERNS,
    loadJSON, saveJSON, saveJSONAsync, saveSettings,
    drainStateFileNotices,
    backupKnowledgeNow, startupProtectKnowledge
}
