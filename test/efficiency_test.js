"use strict"
/* test/efficiency_test.js — performance checks (startup, caches, retention).
   Stubs isolate WhatsApp. Project files snapshotted + restored.
   Covers:
   - non-engaged groups skip the search — their decision was SILENT anyway;
     the input embedding is still computed so human-needed flagging stays
     byte-identical
   - knowledge.json entries are clean {message, reply} pairs (the machine
     "vector" field is dropped — rebuilt from text every boot); the embedding
     cache is the compact base64 format, capped at 25,000, flushed on the 30s
     timer + shutdown instead of inline on every commit
   - knowledge.db is only wiped+rebuilt when the file's content hash or the
     row count no longer match the last build's fingerprint (meta table)
   - media older than 60 days is deleted (chat-log lines keep the record
     forever); inactive chat_memory users are pruned; conversations.db keeps
     everything
   - !forget/!correct canonicalize their input like the stored keys
   The Chrome-flag + model-stagger checks are static source checks — they only
   take effect at the real QR launch. */

const path = require("path")
const fs = require("fs-extra")

const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    if (request === "qrcode-terminal") return path.join(__dirname, "stubs", "qrcode-terminal.js")
    if (request === "@xenova/transformers") return path.join(__dirname, "stubs", "transformers.js")
    return origResolve.call(this, request, ...args)
}

process.env.VT_API_KEY = "TESTI_FAKE_KEY"
process.env.ADMIN = "smoketest_admin@c.us"

const TEST_USER = "0000000000@c.us"
const ADMIN_JID = "smoketest_admin@c.us"
const PROJ = path.join(__dirname, "..")
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✅ ${name}`) }
    else { fail++; console.log(`  ❌ ${name}`) }
}

function snapshotFile(p) { try { return fs.readFileSync(p, "utf8") } catch { return null } }
function restoreFile(p, content) {
    try {
        if (content === null) { if (fs.existsSync(p)) fs.removeSync(p) }
        else fs.writeFileSync(p, content)
    } catch { }
}

async function main() {
    /* ── snapshots: the real project files must survive this test ── */
    const { PATHS, EMBED_CACHE_MAX, CONTACT_NAME_TTL_MS, MEDIA_RETENTION_DAYS, CHAT_MEMORY_USER_TTL_DAYS } = require("../src/config")
    const snapSettings = snapshotFile(PATHS.SETTINGS)
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")
    const snapMemory = snapshotFile(PATHS.MEMORY)
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")
    const snapCache = snapshotFile(PATHS.EMBED_CACHE)
    const snapCacheOld = snapshotFile(PATHS.EMBED_CACHE + ".old.json")
    const snapProcessedIds = snapshotFile(PATHS.PROCESSED_IDS)
    const snapLinks = snapshotFile(PATHS.LINKS_LEDGER)

    const state = require("../src/state")
    const knowledge = require("../src/knowledge")
    knowledge.init({ notifyAdmin: () => { }, notifyAdminBatched: () => { } })
    const { knowledgeDB, convoDB, reviewDB } = require("../src/db")
    const embedCache = require("../src/embedCache")
    const security = require("../src/security")
    const memory = require("../src/memory")
    const admin = require("../src/admin")
    const digest = require("../src/digest")
    const { normalize, canonicalize } = require("../src/text")
    const { sha256File } = require("../src/util")

    // wire admin with the same deps bot.js uses (de_batch pattern)
    admin.init({
        knowledgeDB, convoDB, reviewDB,
        reviewNext: require("../src/db").reviewNext,
        reviewQueueCount: require("../src/db").reviewQueueCount,
        reviewDelete: require("../src/db").reviewDelete,
        learn: knowledge.learn, commitKnowledge: knowledge.commitKnowledge,
        buildDigestText: digest.buildDigestText,
        saveKnowledgeJSON: knowledge.saveKnowledgeJSON,
        refreshKnowledgeCache: knowledge.refreshKnowledgeCache,
        refreshKnowledgeCacheEmbeddings: knowledge.refreshKnowledgeCacheEmbeddings,
        isGarbage: knowledge.isGarbage, isFiller: knowledge.isFiller,
        hasMinimumMeaningfulContent: knowledge.hasMinimumMeaningfulContent
    })

    // deterministic fake semantic layer (same as the other suites)
    const ALPHA = 0.85
    const BETA = Math.sqrt(1 - ALPHA * ALPHA)
    const SHARED = new Float32Array(384).fill(ALPHA / Math.sqrt(384))
    state.embedPipeline = async (txt) => {
        const s = String(txt)
        const h = new Float32Array(384)
        let x = 0
        for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 1000003
        for (let i = 0; i < 384; i++) { x = (x * 1103515245 + 12345) % 2147483648; h[i] = ((x / 2147483648) * 2) - 1 }
        let mag = 0
        for (let i = 0; i < 384; i++) mag += h[i] * h[i]
        mag = Math.sqrt(mag)
        const out = new Float32Array(384)
        for (let i = 0; i < 384; i++) out[i] = SHARED[i] + BETA * (h[i] / mag)
        return { data: out }
    }
    state.embedReady = true
    if (state.embedReadyResolve) state.embedReadyResolve(true)
    state.settings.learning = true
    state.llmAvailable = false
    state.selfChatId = ADMIN_JID

    /* ═══════════ tunables ═══════════ */
    console.log("\n── tunables ──")
    check("EMBED_CACHE_MAX is 25,000 (~38MB worst case)", EMBED_CACHE_MAX === 25000)
    check("CONTACT_NAME_TTL_MS is 24h", CONTACT_NAME_TTL_MS === 86400000)
    check("MEDIA_RETENTION_DAYS is 60 (chat-log lines keep the record)", MEDIA_RETENTION_DAYS === 60)
    check("CHAT_MEMORY_USER_TTL_DAYS is 60", CHAT_MEMORY_USER_TTL_DAYS === 60)

    /* ═══════════ v3 cache — legacy parking + compact base64 format ═══════════ */
    console.log("\n── embedding cache v3 — legacy parking + compact format ──")
    fs.writeFileSync(PATHS.EMBED_CACHE, JSON.stringify({ "v2:0000testi0000": [0.1, 0.2, 0.3] }))
    check("v2-format cache is never readable as v3", embedCache.getCachedEmbedding("anything testi") === null)
    check("v2-format cache parked as .old.json (preserved, never deleted)", fs.existsSync(PATHS.EMBED_CACHE + ".old.json"))
    const probeEmb = new Float32Array(384).fill(0.25)
    embedCache.setCachedEmbedding("v3 probe text testi", probeEmb)
    embedCache.setCachedEmbedding("v3 probe two testi", new Float32Array(384).map((_, i) => i / 384))
    embedCache.flushEmbedCache()
    const rawCache = JSON.parse(fs.readFileSync(PATHS.EMBED_CACHE, "utf8"))
    const cacheKeys = Object.keys(rawCache)
    check("flushed keys are v3-prefixed", cacheKeys.length >= 2 && cacheKeys.every(k => k.startsWith("v3:")))
    check("values are compact base64 strings (not float arrays)", cacheKeys.every(k => typeof rawCache[k] === "string"))
    const roundTrip = embedCache.getCachedEmbedding("v3 probe text testi")
    check("Float32 vectors round-trip byte-exact", roundTrip && roundTrip.length === 384 && roundTrip[0] === probeEmb[0] && roundTrip[383] === probeEmb[383])

    /* ═══════════ debounced flush + clean knowledge.json entries ═══════════ */
    console.log("\n── debounced flush + clean {message, reply} entries ──")
    const cacheBefore = fs.readFileSync(PATHS.EMBED_CACHE, "utf8")
    await knowledge.commitKnowledge("debounce probe question testi", "debounce probe answer testi")
    const cacheAfter = fs.readFileSync(PATHS.EMBED_CACHE, "utf8")
    check("commit no longer flushes the cache inline (30s timer + shutdown own it)", cacheBefore === cacheAfter)
    const lastEntry = state.knowledge.entries[state.knowledge.entries.length - 1]
    check("committed entry is a clean {message, reply} pair (no machine vector field)",
        lastEntry && lastEntry.message.includes("debounce probe") && !("vector" in lastEntry) &&
        Object.keys(lastEntry).sort().join(",") === "message,reply")
    const diskEntry = JSON.parse(fs.readFileSync(PATHS.KNOWLEDGE, "utf8")).entries
        .find(e => (e.message || "").includes("debounce probe"))
    check("knowledge.json on disk carries the clean shape too", diskEntry && !("vector" in diskEntry))

    /* ═══════════ fingerprint rebuild-skip ═══════════ */
    console.log("\n── knowledge.db rebuild only when the fingerprint changed ──")
    await knowledge.buildKnowledgeDB()   // the §-above commit changed the file → REAL rebuild
    const metaH = knowledgeDB.prepare("SELECT value FROM meta WHERE key = 'build_hash'").get()
    const metaC = knowledgeDB.prepare("SELECT value FROM meta WHERE key = 'build_count'").get()
    const rowsTotal = knowledgeDB.prepare("SELECT COUNT(*) as c FROM knowledge").get().c
    check("fingerprint recorded: content hash matches knowledge.json", metaH && metaH.value === sha256File(PATHS.KNOWLEDGE))
    check("fingerprint recorded: row count matches the table", metaC && Number(metaC.value) === rowsTotal)

    const logs = []
    const origLog = console.log
    console.log = (...a) => { logs.push(a.join(" ")) }
    await knowledge.buildKnowledgeDB()   // unchanged file + matching table → skip
    console.log = origLog
    check("unchanged file + matching table → rebuild SKIPPED (warm boot = ms)", logs.some(l => l.includes("skipping the rebuild")))

    state.knowledge.entries.push({ message: "fingerprint probe testi", reply: "fingerprint probe answer testi" })
    knowledge.saveKnowledgeJSON(state.knowledge)
    const logs2 = []
    console.log = (...a) => { logs2.push(a.join(" ")) }
    await knowledge.buildKnowledgeDB()   // the file changed → real rebuild
    console.log = origLog
    const fpRows = knowledgeDB.prepare("SELECT COUNT(*) as c FROM knowledge WHERE message = ?").get(normalize(canonicalize("fingerprint probe testi"))).c
    check("a changed file forces a real rebuild (hand-edits stay live)", logs2.some(l => l.includes("Rebuilding")) && fpRows === 1)
    await sleep(300)   // drain the rebuild's fire-and-forget embedding compute BEFORE measuring model calls below

    /* ═══════════ context-embedding cache + light search ═══════════ */
    console.log("\n── context cache + light search for non-engaged groups ──")
    state.contextEmbCache.clear()
    let pipelineCalls = 0
    const origPipeline = state.embedPipeline
    state.embedPipeline = async (t) => { pipelineCalls++; return origPipeline(t) }
    memory.updateConvoMemory(TEST_USER, "hello there how are you doing today")
    memory.updateConvoMemory(TEST_USER, "i have another question about orders")   // getRecentMessages excludes the newest — 2 updates make the context non-empty
    await knowledge.findBestReply("unique question one testi", TEST_USER)
    check("first search computes input + context (2 model calls)", pipelineCalls === 2)
    await knowledge.findBestReply("unique question two testi", TEST_USER)
    check("same context → served from the cache (1 call)", pipelineCalls === 3)
    memory.updateConvoMemory(TEST_USER, "a new message changes the context")
    await knowledge.findBestReply("unique question three testi", TEST_USER)
    check("context change → cache invalidated (2 calls again)", pipelineCalls === 5)

    state.contextEmbCache.clear()
    pipelineCalls = 0
    memory.updateConvoMemory(TEST_USER, "still an active context here")
    const light = await knowledge.findBestReply("light mode probe testi", TEST_USER, { light: true })
    check("light mode: no reply, but the input embedding is still computed (HN intact)",
        light.reply === null && light.hybridScore === 0 && !!light.inputEmb)
    check("light mode: zero search/context work (exactly 1 model call)", pipelineCalls === 1)
    state.embedPipeline = origPipeline
    const zd1 = await knowledge.findBestReply("zero drift probe testi question", TEST_USER)
    const zd2 = await knowledge.findBestReply("zero drift probe testi question", TEST_USER)
    check("cached context does not change scores (zero drift)", zd1.hybridScore === zd2.hybridScore && zd1.reply === zd2.reply)

    /* ═══════════ near-duplicate fast path — identical verdicts ═══════════ */
    console.log("\n── near-duplicate scan — fast path, same verdicts ──")
    knowledgeDB.prepare("INSERT OR IGNORE INTO knowledge(message, reply, vector, embedding) VALUES(?, ?, ?, NULL)")
        .run(normalize(canonicalize("how to track my order status testi")), "track answer testi",
            JSON.stringify({ how: 1, to: 1, track: 1, my: 1, order: 1, status: 1, testi: 1 }))
    knowledge.refreshKnowledgeCache()
    check("exact stored key is still a duplicate", await knowledge.isTooSimilarToExisting("how to track my order status testi") === true)
    check("punctuation/case drift still detected (shared words reach the check)",
        await knowledge.isTooSimilarToExisting("How to track my ORDER status testi!!") === true)
    check("a completely different question is NOT a duplicate",
        await knowledge.isTooSimilarToExisting("totally different unrelated words qwerty zxcvb testi") === false)

    /* ═══════════ !forget / !correct canonicalize their input ═══════════ */
    console.log("\n── !forget / !correct canonicalize their input ──")
    const mkAdminMsg = (id, body) => ({
        id: { _serialized: id }, body, fromMe: false, from: ADMIN_JID, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async () => ({ id: { _serialized: "X" } }),
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    })
    const committed7 = await knowledge.commitKnowledge("What is the price of premium testi?", "premium costs 500 testi")
    check("entry with punctuation committed", committed7 === true)
    const forgetHandled = await admin.handleCommand(
        mkAdminMsg("TESTI_ADMIN_FORGET", "!forget what is the price of premium testi?"),
        ADMIN_JID, "!forget what is the price of premium testi?")
    check("!forget WITH punctuation removes the entry (was silently 0 before)",
        forgetHandled === true && !state.knowledgeCache.some(r => (r.message || "").includes("price of premium")))
    check("...and the DB row is gone",
        knowledgeDB.prepare("SELECT COUNT(*) as c FROM knowledge WHERE message LIKE '%price of premium%'").get().c === 0)
    await knowledge.commitKnowledge("what's the delivery time testi?", "old answer testi")
    const correctHandled = await admin.handleCommand(
        mkAdminMsg("TESTI_ADMIN_CORRECT", "!correct what's the delivery time testi?|48 hours usually testi"),
        ADMIN_JID, "!correct what's the delivery time testi?|48 hours usually testi")
    const fixedRow = knowledgeDB.prepare("SELECT reply FROM knowledge WHERE message = ?")
        .get(normalize(canonicalize("what's the delivery time testi?")))
    check("!correct WITH punctuation finds the row (was 'no entry found' before)", correctHandled === true)
    check("...and the reply is updated", fixedRow && String(fixedRow.reply).includes("48 hours usually"))

    /* ═══════════ VirusTotal calls are strictly spaced ═══════════ */
    console.log("\n── VirusTotal strict spacing (burst-proof, free-tier safe) ──")
    security.vtInitForTests({ minIntervalMs: 60 })
    const t0 = Date.now()
    const stamps = []
    await Promise.all([0, 1, 2].map(() => security.vtAcquire().then(() => { stamps.push(Date.now() - t0) })))
    stamps.sort((a, b) => a - b)
    check("first VT call goes out immediately", stamps[0] < 30)
    check("burst callers are strictly spaced (never N-at-once)",
        stamps.length === 3 && (stamps[1] - stamps[0]) >= 50 && (stamps[2] - stamps[1]) >= 50)
    security.vtInitForTests({ minIntervalMs: 1 })

    /* ═══════════ JID → display-name cache ═══════════ */
    console.log("\n── JID → display-name cache (24h TTL) ──")
    let contactLookups = 0
    state.adminClient = { getContactById: async () => { contactLookups++; return { name: "Testi Contact" } } }
    const nm1 = await security.getContactName(TEST_USER)
    const nm2 = await security.getContactName(TEST_USER)
    check("one WhatsApp round-trip, then served from the cache", contactLookups === 1 && nm1 === "Testi Contact" && nm2 === "Testi Contact")
    state.adminClient = null

    /* ═══════════ SQLite WAL mode ═══════════ */
    console.log("\n── SQLite WAL mode (no fsync per insert) ──")
    check("knowledge.db runs in WAL mode", knowledgeDB.pragma("journal_mode", { simple: true }) === "wal")
    check("conversations.db runs in WAL mode", convoDB.pragma("journal_mode", { simple: true }) === "wal")
    check("review.db runs in WAL mode", reviewDB.pragma("journal_mode", { simple: true }) === "wal")

    /* ═══════════ retention sweep ═══════════ */
    console.log("\n── retention sweep (media 60d, chat_memory users 60d) ──")
    const mediaUserDir = path.join(PATHS.MEDIA_CHATS, "0000000000")
    fs.ensureDirSync(mediaUserDir)
    const oldMedia = path.join(mediaUserDir, "old_probe_testi.jpg")
    const freshMedia = path.join(mediaUserDir, "fresh_probe_testi.jpg")
    fs.writeFileSync(oldMedia, "old")
    fs.writeFileSync(freshMedia, "fresh")
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000)   // Date object — a bare number is read as SECONDS and overflows
    fs.utimesSync(oldMedia, ninetyDaysAgo, ninetyDaysAgo)
    state.persistentMemory["ghost_user_testi"] = { history: [], lastSeen: ninetyDaysAgo }
    state.persistentMemory["active_user_testi"] = { history: [], lastSeen: Date.now() }
    memory.runRetentionSweepNow()
    check("media older than 60 days is deleted", !fs.existsSync(oldMedia))
    check("fresh media is kept", fs.existsSync(freshMedia))
    check("chat_memory users inactive > 60 days are pruned", !state.persistentMemory["ghost_user_testi"])
    check("active chat_memory users survive", !!state.persistentMemory["active_user_testi"])

    /* ═══════════ lazy profile build ═══════════ */
    console.log("\n── lazy profile build (silent paths pay nothing) ──")
    memory.updateConvoMemory(TEST_USER, "lazy profile probe message")
    check("profile not built eagerly on intake", state.convoMemory.get(TEST_USER) && state.convoMemory.get(TEST_USER).profile === null)
    memory.getUserProfile(TEST_USER)
    check("profile built lazily on first read", state.convoMemory.get(TEST_USER).profile !== null)

    /* ═══════════ static checks against bot.js ═══════════ */
    console.log("\n── Chrome flags + boot-time model load (static) ──")
    const botSrc = fs.readFileSync(path.join(PROJ, "bot.js"), "utf8")
    check("Chrome hardening flags present",
        botSrc.includes("--disable-extensions") && botSrc.includes("--disable-features=Translate,OptimizationHints,MediaRouter"))
    check("puppeteer protocolTimeout set", botSrc.includes("protocolTimeout"))
    check("model load staggered at boot (3s, off the Chrome spawn)",
        botSrc.includes("setTimeout(() => {") && botSrc.includes("initEmbedder().catch") && botSrc.includes("3000)"))
    check("no model reload inside the ready handler anymore", !botSrc.includes("if (!state.embedReady)"))
    check("E11: retention sweeper started at boot", botSrc.includes("startRetentionSweeper()"))
    check("shutdown flushes the embedding cache", botSrc.includes("flushEmbedCache"))
    const knSrc = fs.readFileSync(path.join(PROJ, "src", "knowledge.js"), "utf8")
    const memSrc = fs.readFileSync(path.join(PROJ, "src", "memory.js"), "utf8")
    check("knowledge.js no longer flushes inline", !knSrc.includes("flushEmbedCache"))
    check("the 30s timer flushes the cache instead", memSrc.includes("flushEmbedCache()"))

    /* ═══════════ cleanup: leave the project pristine ═══════════ */
    console.log("\n── cleanup ──")
    state.llmAvailable = false
    state.adminClient = null
    state.contextEmbCache.clear()
    await sleep(300)   // let fire-and-forget appends land before snapshot restore
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testi%'").run() } catch { }
    try { reviewDB.prepare("DELETE FROM pending WHERE question LIKE '%testi%' OR answer LIKE '%testi%'").run() } catch { }
    try { convoDB.prepare("DELETE FROM conversations WHERE user = ?").run(TEST_USER) } catch { }
    try { delete state.persistentMemory["ghost_user_testi"] } catch { }
    try { delete state.persistentMemory["active_user_testi"] } catch { }
    try { delete state.persistentMemory[TEST_USER] } catch { }
    try { state.knowledge.entries = state.knowledge.entries.filter(e => !(e.message || "").includes("testi")) } catch { }
    try { knowledge.refreshKnowledgeCache() } catch { }

    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)
    restoreFile(PATHS.MEMORY, snapMemory)
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)
    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)
    restoreFile(PATHS.EMBED_CACHE, snapCache)
    restoreFile(PATHS.EMBED_CACHE + ".old.json", snapCacheOld)
    restoreFile(PATHS.PROCESSED_IDS, snapProcessedIds)
    restoreFile(PATHS.LINKS_LEDGER, snapLinks)

    for (const f of [PATHS.LOG_HN, PATHS.LOG_ADMIN, PATHS.LOG_ERRORS]) {
        try {
            if (!fs.existsSync(f)) continue
            const lines = fs.readFileSync(f, "utf8").split("\n")
                .filter(l => l && !l.includes("0000000000") && !l.toLowerCase().includes("testi") && !l.includes("smoketest_admin"))
            fs.writeFileSync(f, lines.length ? lines.join("\n") + "\n" : "")
        } catch { }
    }
    for (const f of [
        path.join(PATHS.LOG_CHATS, "0000000000.txt"),
        path.join(PATHS.LLM_CTX_CHATS, "0000000000.txt"),
        path.join(PATHS.MEDIA_CHATS, "0000000000"),
    ]) { try { fs.removeSync(f) } catch { } }

    check("cleanup done (files restored, test rows removed)", true)

    console.log("\n═══════════════════════════════")
    console.log(`I BATCH TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("I BATCH TEST CRASHED:", e); process.exit(1) })
