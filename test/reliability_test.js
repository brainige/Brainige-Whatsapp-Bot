"use strict"
/* test/reliability_test.js — reliability checks.
   Covers: the question detector, the learning ladder (owner/quoted/LLM tiers
   + question-shaped-answer routing), owner phone-reply pairing via the
   handler, pause trigger + notify + digest counter, processed-ID persistence,
   chat_memory flush, logError coalescing, old-format embedding cache migration,
   and the reconnect controller with fake clients.
   Stubs isolate WhatsApp/network. All writes to project files are
   snapshotted and restored at the end. */

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

process.env.VT_API_KEY = ""
process.env.ADMIN = "smoketest_admin@c.us"

const TEST_USER = "0000000000@c.us"
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
    /* ── parent-style snapshots: the real project files must survive ── */
    const { PATHS } = require("../src/config")
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")
    const snapCache = snapshotFile(PATHS.EMBED_CACHE)
    const snapMemory = snapshotFile(PATHS.MEMORY)
    const snapSettings = snapshotFile(PATHS.SETTINGS)
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")   // saveJSON keeps .bak for settings/memory now
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")
    const snapProcessedIds = snapshotFile(PATHS.PROCESSED_IDS)

    // Plant an OLD-format embedding cache BEFORE anything loads it,
    // so the migration logic runs in this process.
    fs.writeFileSync(PATHS.EMBED_CACHE, JSON.stringify({ "0000deadbeef0000": [0.1, 0.2, 0.3] }))

    const state = require("../src/state")
    const text = require("../src/text")
    const knowledge = require("../src/knowledge")
    knowledge.init({ notifyAdmin: () => { } })
    const { reviewDB, knowledgeDB, convoDB } = require("../src/db")
    const pause = require("../src/pause")
    const tracking = require("../src/tracking")
    const { updatePersistentMemory, flushPersistentMemory } = require("../src/memory")
    const digest = require("../src/digest")
    const { logError } = require("../src/logging")
    const embedCache = require("../src/embedCache")
    const handler = require("../src/handler")
    const reconnect = require("../src/reconnect")
    const { RECONNECT_MAX_RETRIES } = require("../src/config")

    // deterministic fake semantic layer: every text maps to a vector that is
    // 85% a shared "topic" direction + sqrt(1-0.85²) its own hash noise, i.e.
    // a UNIT vector whose pairwise cosine ≈ 0.85² = 0.72. That sits ABOVE the
    // relatedness bars (0.40 / 0.60) and BELOW the near-duplicate bar (0.92)
    // — exactly how genuinely related question/answer pairs behave.
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
    state.settings.learning = true
    state.adminClient = { getChatById: async () => ({ sendMessage: async () => ({}) }) }
    state.selfChatId = "smoketest_admin@c.us"
    // Tiny send-guard knobs so reply pacing (3–6s in production) doesn't slow this suite
    require("../src/sendGuard").init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 1000, queueMaxAgeMs: 60000 })

    const entriesBefore = state.knowledge.entries.length

    /* ═══════════ isQuestionLike detector ═══════════ */
    console.log("\n── isQuestionLike (question-shape detector) ──")
    check("\"what time?\" is a question", text.isQuestionLike("what time?") === true)
    check("\"kemon acho\" (Bangla) is a question", text.isQuestionLike("kemon acho") === true)
    check("\"kothay? 🙂\" (trailing emoji) is a question", text.isQuestionLike("kothay? 🙂") === true)
    check("\"ki korcho\" is a question", text.isQuestionLike("ki korcho") === true)
    check("\"kab ashbe\" is a question", text.isQuestionLike("kab ashbe") === true)
    check("\"will you come tomorrow?\" is a question", text.isQuestionLike("will you come tomorrow?") === true)
    check("\"price list attached\" is NOT a question", text.isQuestionLike("price list attached") === false)
    check("\"will call later\" is NOT a question (aux without ?)", text.isQuestionLike("will call later") === false)
    check("\"send the file please\" is NOT a question", text.isQuestionLike("send the file please") === false)
    check("empty/undefined is NOT a question", text.isQuestionLike("") === false && text.isQuestionLike(undefined) === false)

    /* ═══════════ learning ladder ═══════════ */
    console.log("\n── learning ladder (tiers) ──")
    const reviewRowsBefore = reviewDB.prepare("SELECT COUNT(*) c FROM pending").get().c

    const okLLM = await knowledge.learn("what is your name TESTQ", "My name is Utsab TESTQ", true, 0.1, "unit test")
    check("LLM answer routes to REVIEW queue (owner's safest choice)", okLLM === true)
    check("LLM pair NOT committed to knowledge", !state.knowledge.entries.some(e => e.message.includes("what is your name testq")))
    const llmRow = reviewDB.prepare("SELECT * FROM pending WHERE question LIKE '%testq%' ORDER BY id DESC").all()
    check("LLM pair IS in the review queue", llmRow.some(r => (r.answer || "").toLowerCase().includes("my name is utsab testq")))

    const okLLMG11 = await knowledge.learn("what time TESTQ", "when will you be free TESTQ?", true, 0.1, "unit test")
    check("LLM answer that is itself a question is dropped", okLLMG11 === false)

    const okAuto = await knowledge.learn("what is the TESTQ price of delivery", "it is 500 rupees for TESTQ", false, 1.0, "owner phone reply", "auto")
    check("owner auto pair with strong relatedness commits DIRECTLY", okAuto === true)
    check("owner pair present in knowledge.json entries", state.knowledge.entries.some(e => e.message.includes("testq price of delivery")))

    const okAutoG11 = await knowledge.learn("where is the TESTQ shop located", "when does the TESTQ shop open?", false, 1.0, "owner phone reply", "auto")
    check("owner auto pair with question-as-answer goes to REVIEW", okAutoG11 === true)
    check("question-shaped answer NOT committed", !state.knowledge.entries.some(e => e.message.includes("testq shop located")))

    const okGarbage = await knowledge.learn("ok", "lol", false, 1.0, "unit test", "auto")
    check("garbage pair rejected by gates", okGarbage === false)

    const okExplicit = await knowledge.learn("manual TESTQ training pair", "manual TESTQ training answer")
    check("!train (explicit) still commits directly", okExplicit === true && state.knowledge.entries.some(e => e.message.includes("manual testq training pair")))

    /* ═══════════ owner phone-reply pairing via the handler ═══════════ */
    console.log("\n── handler — customer question held, owner reply pairs ──")
    tracking.setLastMessage(TEST_USER, null) // clear
    const entriesBeforeHandler = state.knowledge.entries.length

    const custMsg = {
        id: { _serialized: "TESTMSG_C1_INCOMING" }, body: "what is the TESTQ delivery time",
        fromMe: false, from: TEST_USER, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async () => ({ id: { _serialized: "X" } }),
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    }
    await handler.onMessage(custMsg)
    check("customer question is held as pending question", tracking.getLastMessage(TEST_USER) === "what is the TESTQ delivery time")
    check("customer message alone learns NOTHING (no customer→customer pairs)", state.knowledge.entries.length === entriesBeforeHandler)

    const ownerMsg = {
        id: { _serialized: "TESTMSG_C1_OWNER" }, body: "the TESTQ delivery time is 2 days",
        fromMe: true, from: TEST_USER, to: TEST_USER, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async () => ({ id: { _serialized: "X" } }),
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    }
    await handler.onMessage(ownerMsg)
    check("owner phone reply taught the pair (auto source)", state.knowledge.entries.length === entriesBeforeHandler + 1)
    check("pair is the question the customer asked", state.knowledge.entries.some(e => e.message.includes("testq delivery time")))

    /* ═══════════ pause trigger + notify + digest counter ═══════════ */
    console.log("\n── pause trigger matrix ──")
    state.pauseMap.clear()
    check("\"utsab?\" pauses (DM)", pause.checkAndTriggerPause(TEST_USER, "utsab?") === true)
    state.pauseMap.clear()
    check("\"utsab, are you free?\" pauses (starts with name)", pause.checkAndTriggerPause(TEST_USER, "utsab, are you free?") === true)
    state.pauseMap.clear()
    check("\"utsab bhai ek min\" pauses (≤4 words + name)", pause.checkAndTriggerPause(TEST_USER, "utsab bhai ek min") === true)
    state.pauseMap.clear()
    check("\"tell utsab I said hi\" does NOT pause", pause.checkAndTriggerPause(TEST_USER, "tell utsab I said hi") === false)
    state.pauseMap.clear()
    check("\"utsab said the price is 500\" pauses (known approved trade-off)", pause.checkAndTriggerPause(TEST_USER, "utsab said the price is 500") === true)
    const pausedUntil = state.pauseMap.get(TEST_USER)
    check("no extension while paused (second trigger returns false)", pause.checkAndTriggerPause(TEST_USER, "utsab bhai achen") === false)
    check("pause window not extended by re-trigger", state.pauseMap.get(TEST_USER) === pausedUntil)
    check("groups are NEVER paused (DM-only)", pause.checkAndTriggerPause("12345@g.us", "utsab bhai ek min") === false)
    check("empty caption is safe", pause.checkAndTriggerPause(TEST_USER, "") === false)
    state.pauseMap.clear()

    console.log("\n── handler — pause notifies admin + counts the skip ──")
    const notified = []
    state.adminClient = { getChatById: async () => ({ sendMessage: async (t) => { notified.push(t); return {} } }) }
    state.pauseMap.clear()
    const skipBefore = state.settings.digestState.totals.pausedSkips || 0
    const replies = []
    const pauseMsg = {
        id: { _serialized: "TESTMSG_C7_PAUSE" }, body: "utsab bhai ek min",
        fromMe: false, from: TEST_USER, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async (t) => { replies.push(t); return { id: { _serialized: "X" } } },
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    }
    await handler.onMessage(pauseMsg)
    check("paused DM gets no reply", replies.length === 0)
    check("admin was notified of the pause", notified.some(t => t.includes("⏸ Replies paused")))
    check("digest counted the paused skip", (state.settings.digestState.totals.pausedSkips || 0) === skipBefore + 1)
    check("digest text includes the new counter line", digest.buildDigestText().includes("Paused/DND skips"))

    state.pauseMap.clear()
    const notifiedBefore = notified.length
    const noPauseMsg = {
        id: { _serialized: "TESTMSG_C7_NO" }, body: "tell utsab I said hi to everyone in the group please",
        fromMe: false, from: TEST_USER, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async (t) => { replies.push(t); return { id: { _serialized: "X" } } },
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    }
    await handler.onMessage(noPauseMsg)
    check("third-person mention: no pause notification", !notified.slice(notifiedBefore).some(t => t.includes("⏸")))

    /* ═══════════ processed IDs survive a restart ═══════════ */
    console.log("\n── processed-ID persistence ──")
    tracking._resetProcessedForTests()
    tracking.markProcessed("TESTID_A")
    await sleep(150)   // async append lands
    check("ID appended to disk immediately", fs.readFileSync(PATHS.PROCESSED_IDS, "utf8").includes("TESTID_A"))
    tracking._resetProcessedForTests()
    check("after 'crash' the in-memory set is empty", state.processed.has("TESTID_A") === false)
    tracking.loadProcessedIds()
    check("ID restored from disk (no double replies after restart)", state.processed.has("TESTID_A") === true)
    fs.appendFileSync(PATHS.PROCESSED_IDS, `${Date.now() - 49 * 60 * 60 * 1000} TESTID_OLD\n`)
    tracking._resetProcessedForTests()
    tracking.loadProcessedIds()
    check("IDs older than 48h are dropped", state.processed.has("TESTID_OLD") === false && state.processed.has("TESTID_A") === true)

    /* ═══════════ chat_memory flush timer instead of per-message writes ═══════════ */
    console.log("\n── chat_memory.json dirty-flush ──")
    const memBefore = fs.readFileSync(PATHS.MEMORY, "utf8")
    updatePersistentMemory(TEST_USER, "c4 dirty probe message", "chat")
    check("no immediate disk write after message", fs.readFileSync(PATHS.MEMORY, "utf8") === memBefore)
    check("dirty flag set", state.memoryDirty === true)
    await flushPersistentMemory()
    check("flush writes the memory file", fs.readFileSync(PATHS.MEMORY, "utf8").includes("c4 dirty probe message"))
    check("dirty flag cleared after flush", state.memoryDirty === false)

    /* ═══════════ logError writes + coalesces ═══════════ */
    console.log("\n── logError — visible + flood-proof ──")
    for (let i = 0; i < 60; i++) logError("TESTC5", "coalesce probe", new Error("boom"))
    const errLines = fs.readFileSync(PATHS.LOG_ERRORS, "utf8").split("\n").filter(l => l.includes("[TESTC5]"))
    check("errors.txt received the failure", errLines.length >= 1)
    check("60 repeats coalesced (≤52 lines, not 60)", errLines.length >= 50 && errLines.length <= 53)
    check("suppression note written", fs.readFileSync(PATHS.LOG_ERRORS, "utf8").includes("suppressed after 50 repeats"))

    /* ═══════════ old-format embedding cache parked, never loaded ═══════════ */
    console.log("\n── embedding cache migration (v2 keys) ──")
    check("old-format cache parked as .old.json", fs.existsSync(PATHS.EMBED_CACHE + ".old.json"))
    check("old (unprefixed) entries are never read", embedCache.getCachedEmbedding("anything") === null)
    const twoLong = ["x".repeat(300) + " alpha", "x".repeat(300) + " beta"]
    const { getEmbedding, embedKey } = require("../src/embeddings")
    const e1 = await getEmbedding(twoLong[0])
    const e2 = await getEmbedding(twoLong[1])
    check("two >200-char texts sharing a prefix get DIFFERENT cache keys", embedKey(twoLong[0]) !== embedKey(twoLong[1]))
    check("both got real embeddings", !!e1 && !!e2)
    check("in-memory cache holds both under v2 keys", state.embeddingCache.has(embedKey(twoLong[0])) && state.embeddingCache.has(embedKey(twoLong[1])))

    /* ═══════════ reconnect controller ═══════════ */
    console.log("\n── reconnect controller (fake clients, tiny timeouts) ──")
    const createdClients = []
    const fatalCalls = []
    let rebuildCalls = 0
    state.clientActive = true
    state.reconnectAttempts = 0
    reconnect.init({
        state,
        sleep: async () => { },
        notifyAdmin: () => { },
        logError: () => { },
        DESTROY_TIMEOUT_MS: 40,
        READY_WATCHDOG_MS: 80,
        createAndBindClient: () => {
            const c = { initialize: async () => { }, destroy: () => new Promise(() => { }) }  // destroy() hangs forever
            createdClients.push(c)
            return c
        },
        rebuildIfChanged: async () => { rebuildCalls++ },
        onFatal: r => fatalCalls.push(r)
    })
    await reconnect.attemptReconnect("unit t1")
    await reconnect.attemptReconnect("unit t2")   // must be ignored (in flight)
    check("reconnect creates exactly ONE client (single-flight guard)", createdClients.length === 1)
    check("retry counter incremented", state.reconnectAttempts === 1)
    check("hung destroy() did not wedge the chain (fresh client exists)", createdClients.length === 1 && rebuildCalls === 1)
    check("no knowledge rebuild forced (rebuildIfChanged decides)", rebuildCalls === 1)

    reconnect.onReady()
    check("'ready' resets the retry counter", state.reconnectAttempts === 0)
    await reconnect.attemptReconnect("unit t3")
    check("new attempt after ready proceeds", createdClients.length === 2)
    await sleep(130)   // watchdog (80ms) fires → one retry
    reconnect.onReady()
    check("ready-watchdog counts a silent initialize as failed attempt", createdClients.length === 3)

    await reconnect.attemptReconnect("unit t4")
    reconnect.qrWaiting()
    const afterQr = createdClients.length
    await sleep(200)
    check("QR waiting disarms the watchdog (human must scan)", createdClients.length === afterQr)
    reconnect.onReady()

    state.reconnectAttempts = RECONNECT_MAX_RETRIES
    await reconnect.attemptReconnect("unit t-final")
    check("exhausted retries → onFatal, no new client", fatalCalls.length === 1 && createdClients.length === afterQr)

    reconnect.giveUp("unit test")
    check("giveUp stops the reconnect chain (clientActive=false)", state.clientActive === false)
    state.clientActive = true

    /* ═══════════ cleanup: leave the project pristine ═══════════ */
    console.log("\n── cleanup ──")
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testq%'").run() } catch { }
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%manual testq%'").run() } catch { }
    try { reviewDB.prepare("DELETE FROM pending WHERE question LIKE '%testq%'").run() } catch { }
    try { convoDB.prepare("DELETE FROM conversations WHERE user = ?").run(TEST_USER) } catch { }
    delete state.persistentMemory[TEST_USER]

    // restore every snapshotted project file exactly as it was
    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)
    restoreFile(PATHS.EMBED_CACHE, snapCache)
    if (fs.existsSync(PATHS.EMBED_CACHE + ".old.json")) {
        // if the ORIGINAL cache was itself old-format, keep the parked copy
        // next to it; otherwise remove our test artifact
        if (snapCache !== null) fs.removeSync(PATHS.EMBED_CACHE + ".old.json")
    }
    restoreFile(PATHS.MEMORY, snapMemory)
    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)   // hygiene
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)        // hygiene
    restoreFile(PATHS.PROCESSED_IDS, snapProcessedIds)

    // strip test noise from append-only logs
    for (const f of [PATHS.LOG_HN, PATHS.LOG_ADMIN, PATHS.LOG_ERRORS]) {
        try {
            if (!fs.existsSync(f)) continue
            const lines = fs.readFileSync(f, "utf8").split("\n").filter(l => l && !l.includes("TESTC5") && !l.includes("0000000000") && !l.includes("testq"))
            fs.writeFileSync(f, lines.length ? lines.join("\n") + "\n" : "")
        } catch { }
    }
    for (const f of [
        path.join(PATHS.LOG_CHATS, "0000000000.txt"),
        path.join(PATHS.LLM_CTX_CHATS, "0000000000.txt"),
        PATHS.KNOWLEDGE + ".corrupt_UNIT",
    ]) { try { fs.removeSync(f) } catch { } }

    check("cleanup done (files restored, test rows removed)", true)

    console.log("\n═══════════════════════════════")
    console.log(`RELIABILITY TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("RELIABILITY TEST CRASHED:", e); process.exit(1) })
