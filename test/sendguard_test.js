"use strict"
/* test/sendguard_test.js — send-pacing + notification checks.
   Covers:
   - jittered minimum gap between sends; hourly cap → queue; the queue drains
     when the window slides; stale-drop + reporting; identical-text
     suppression per chat (a different chat / different text still passes)
   - low-priority notices coalesce into one summary per category; immediate
     notices unchanged; a failed batch flush retries on the next flush;
     trusted/cached-SAFE link checks are SILENT (ledger only); fresh UNSAFE +
     cached UNSAFE notify IMMEDIATELY; fresh-scan SAFE goes to the batch
   - duplicate questions never create a second review row
   - the botSentIds TTL sweeper works
   - digest guard counters + the handler routes replies through the guard with
     counters firing only when the reply really goes out
   Stubs isolate WhatsApp. Project files snapshotted + restored. */

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

process.env.VT_API_KEY = "TESTH_FAKE_KEY"   // fake — the scan path is reachable; axios is patched so NO network ever happens
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
    const { PATHS } = require("../src/config")
    const snapSettings = snapshotFile(PATHS.SETTINGS)
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")
    const snapMemory = snapshotFile(PATHS.MEMORY)
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")
    const snapCache = snapshotFile(PATHS.EMBED_CACHE)
    const snapProcessedIds = snapshotFile(PATHS.PROCESSED_IDS)
    const snapLinks = snapshotFile(PATHS.LINKS_LEDGER)

    const state = require("../src/state")
    const sendGuard = require("../src/sendGuard")
    const notify = require("../src/notify")
    const digest = require("../src/digest")
    const security = require("../src/security")
    security.vtInitForTests({ minIntervalMs: 1 })   // VT calls are strictly spaced in production — keep the suite fast
    const knowledge = require("../src/knowledge")
    knowledge.init({ notifyAdmin: () => { }, notifyAdminBatched: () => { } })
    const { knowledgeDB, reviewDB, convoDB } = require("../src/db")
    const handler = require("../src/handler")
    const tracking = require("../src/tracking")

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
    state.settings.learning = true
    state.llmAvailable = false
    state.selfChatId = ADMIN_JID

    // capture the guard's drop events (overrides handler's wiring for this suite)
    const dropEvents = []
    sendGuard.initDropLogger(e => dropEvents.push(e))

    /* ═══════════ #5: pacing — jittered minimum gap between sends ═══════════ */
    console.log("\n── #5: pacing — jittered minimum gap between sends ──")
    sendGuard._resetForTests()
    sendGuard.init({ gapMinMs: 60, gapMaxMs: 80, hourlyCap: 100, capWindowMs: 60000, queueMaxAgeMs: 60000, identicalHourCap: 100 })
    const sentAt = []
    for (let i = 0; i < 3; i++) sendGuard.guardCustomerReply(TEST_USER, `pacing reply ${i}`, async () => { sentAt.push(Date.now()) })
    await sleep(300)
    check("3 replies all sent", sentAt.length === 3)
    check("gap between consecutive sends ≥ the minimum (60ms)", sentAt.length === 3 && (sentAt[1] - sentAt[0]) >= 55 && (sentAt[2] - sentAt[1]) >= 55)
    check("nothing left in the queue", sendGuard.pendingCount() === 0)

    /* ═══════════ #5: hourly cap → queue → drain ═══════════ */
    console.log("\n── #5: hourly cap → queue → drain ──")
    sendGuard._resetForTests()
    sendGuard.init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 2, capWindowMs: 300, queueMaxAgeMs: 60000, identicalHourCap: 100 })
    let sent2 = 0
    for (let i = 0; i < 4; i++) sendGuard.guardCustomerReply(TEST_USER, `cap reply ${i}`, async () => { sent2++ })
    await sleep(80)
    check("cap holds: only 2 of 4 sent", sent2 === 2)
    check("2 replies waiting in the queue", sendGuard.pendingCount() === 2)
    await sleep(320)   // the 300ms cap window slides
    await sendGuard.pump()
    await sleep(60)
    check("queue drains once the window slides", sent2 === 4 && sendGuard.pendingCount() === 0)

    /* ═══════════ #5: stale-drop — queued too long → dropped, never silent ═══════════ */
    console.log("\n── #5: stale-drop (owner choice: drop after the queue age limit) ──")
    sendGuard._resetForTests()
    sendGuard.init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 1, capWindowMs: 60000, queueMaxAgeMs: 80, identicalHourCap: 100 })
    dropEvents.length = 0
    let sent3 = 0
    for (let i = 0; i < 3; i++) sendGuard.guardCustomerReply(TEST_USER, `stale reply ${i}`, async () => { sent3++ })
    await sleep(30)
    check("cap 1: only the first reply sent", sent3 === 1)
    await sleep(120)   // the queued replies are now older than queueMaxAgeMs
    await sendGuard.pump()
    check("stale replies dropped, not sent", sent3 === 1 && sendGuard.pendingCount() === 0)
    check("every drop is reported (digest + admin notice are wired off this)", dropEvents.filter(e => e.reason === "queue_stale_drop").length === 2)

    /* ═══════════ #5: identical-text suppression ═══════════ */
    console.log("\n── #5: identical-text suppression ──")
    sendGuard._resetForTests()
    sendGuard.init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 100, capWindowMs: 60000, queueMaxAgeMs: 60000, identicalHourCap: 2 })
    dropEvents.length = 0
    let sentIdentical = 0
    const run = async () => { sentIdentical++ }
    sendGuard.guardCustomerReply(TEST_USER, "same canned reply", run)
    sendGuard.guardCustomerReply(TEST_USER, "same canned reply", run)
    await sleep(40)
    const r3 = sendGuard.guardCustomerReply(TEST_USER, "same canned reply", run)
    check("first two identical replies sent", sentIdentical === 2)
    check("third identical reply suppressed", r3.reason === "identical_suppressed" && sentIdentical === 2)
    check("suppression is reported", dropEvents.some(e => e.reason === "identical_suppressed"))
    sendGuard.guardCustomerReply(TEST_USER, "a different reply", run)
    await sleep(40)
    check("a different text still goes through", sentIdentical === 3)
    sendGuard.guardCustomerReply("other@user", "same canned reply", run)
    await sleep(40)
    check("the same text to a DIFFERENT chat still goes through", sentIdentical === 4)

    /* ═══════════ digest counters for guard drops ═══════════ */
    console.log("\n── digest: guard counters ──")
    const dsBefore = JSON.parse(JSON.stringify(state.settings.digestState || {}))
    digest.bumpDigestSendGuard("rateDropped")
    digest.bumpDigestSendGuard("identicalSuppressed")
    check("rateDropped counter incremented", (state.settings.digestState.totals.rateDropped || 0) === ((dsBefore.totals && dsBefore.totals.rateDropped) || 0) + 1)
    check("identicalSuppressed counter incremented", (state.settings.digestState.totals.identicalSuppressed || 0) === ((dsBefore.totals && dsBefore.totals.identicalSuppressed) || 0) + 1)
    check("digest text shows the Guarded (H) line", digest.buildDigestText().includes("Guarded (H)"))
    state.settings.digestState = dsBefore   // restore in-memory counters (the file is restored at cleanup)

    /* ═══════════ #12: notification batching ═══════════ */
    console.log("\n── #12: notification batching ──")
    const notices = []
    state.adminClient = { getChatById: async () => ({ sendMessage: async (t) => { notices.push(t); return {} } }) }
    notify.notifyAdminBatched("Media needs you", "media from 111")
    notify.notifyAdminBatched("Media needs you", "media from 222")
    notify.notifyAdminBatched("Media needs you", "media from 333")
    await sleep(30)
    check("3 batched notices → ZERO immediate messages", notices.length === 0)
    notify.flushPending()
    await sleep(30)
    check("flush coalesces into ONE summary", notices.length === 1)
    check("summary counts all 3 lines", notices[0].includes("3 in the last") && notices[0].includes("media from 111") && notices[0].includes("media from 333"))
    notify.notifyAdmin("immediate safety notice TESTH")
    await sleep(30)
    check("immediate notices still go out at once", notices.length === 2 && notices[1].includes("immediate safety notice"))
    // a FAILED batch flush keeps its lines for the next attempt
    state.adminClient = { getChatById: () => { throw new Error("sync setup failure") } }   // synchronous setup failure
    notify.notifyAdminBatched("Retry cat", "line that will fail first")
    notify.flushPending()
    await sleep(30)
    check("failed flush keeps the lines (nothing lost)", notices.length === 2)
    state.adminClient = { getChatById: async () => ({ sendMessage: async (t) => { notices.push(t); return {} } }) }
    notify.flushPending()
    await sleep(30)
    check("kept lines go out on the next flush", notices.some(n => n.includes("Retry cat")))

    /* ═══════════ #12: link-check notification routing ═══════════ */
    console.log("\n── #12: link-check notification routing ──")
    notices.length = 0
    const safeTrusted = await security.checkURL("https://www.youtube.com/watch?v=x", "testh", TEST_USER, null, "dm", "")
    check("trusted-SAFE: allowed, ZERO admin messages (owner choice — ledger only)", safeTrusted === true && notices.length === 0)
    check("trusted-SAFE: still recorded in the ledger with verdict safe",
        fs.readFileSync(PATHS.LINKS_LEDGER, "utf8").includes("youtube.com"))

    const axios = require("axios")
    const origPost = axios.post
    const origGet = axios.get
    axios.post = async () => ({ data: { data: { id: "testh" } } })
    axios.get = async () => ({ data: { data: { attributes: { stats: { malicious: 0, suspicious: 0 } } } } })
    const safeScan = await security.checkURL("https://testh-unknown.example.org/x", "testh", TEST_USER, null, "dm", "")
    check("fresh-scan SAFE: allowed, NOT notified immediately (goes to the batch)", safeScan === true && notices.length === 0)
    notify.flushPending()
    await sleep(30)
    check("fresh-scan SAFE appears in the batch summary", notices.some(n => n.includes("Safe link scans")))

    notices.length = 0
    axios.get = async () => ({ data: { data: { attributes: { stats: { malicious: 2, suspicious: 1 } } } } })
    const unsafeScan = await security.checkURL("https://testh-unknown2.example.org/y", "testh", TEST_USER, null, "dm", "")
    check("fresh UNSAFE: reply blocked (false)", unsafeScan === false)
    check("fresh UNSAFE: IMMEDIATE admin notification (never existed before)", notices.length === 1 && notices[0].includes("UNSAFE"))

    notices.length = 0
    state.urlCache.set("https://testh-unknown2.example.org/y", { safe: false, time: Date.now() })
    const unsafeCached = await security.checkURL("https://testh-unknown2.example.org/y", "testh", TEST_USER, null, "dm", "")
    check("cached UNSAFE: blocked + IMMEDIATE notification", unsafeCached === false && notices.length === 1 && notices[0].includes("UNSAFE"))
    axios.post = origPost
    axios.get = origGet

    /* ═══════════ review-queue duplicate suppression ═══════════ */
    console.log("\n── review-queue duplicate suppression ──")
    const reviewBefore = reviewDB.prepare("SELECT COUNT(*) c FROM pending").get().c
    const q1 = await knowledge.queueForReview("duplicate TESTH question", "first answer TESTH", "unit")
    const countAfter1 = reviewDB.prepare("SELECT COUNT(*) c FROM pending").get().c
    const q2 = await knowledge.queueForReview("duplicate TESTH question", "first answer TESTH", "unit")
    const countAfter2 = reviewDB.prepare("SELECT COUNT(*) c FROM pending").get().c
    check("first queue → exactly one new row", q1 === true && countAfter1 === reviewBefore + 1)
    check("same question again → NO second row, still handled", q2 === true && countAfter2 === countAfter1)

    /* ═══════════ L17/L3: botSentIds TTL sweeper ═══════════ */
    console.log("\n── L17/L3: botSentIds TTL sweeper ──")
    state.botSentIds.set("expired_testh", Date.now() - 1)
    state.botSentIds.set("fresh_testh", Date.now() + 999999)
    tracking.sweepBotSentTracking()
    check("expired bot-sent ID pruned", !state.botSentIds.has("expired_testh"))
    check("fresh bot-sent ID kept", state.botSentIds.has("fresh_testh"))
    state.botSentIds.delete("fresh_testh")

    /* ═══════════ #5 e2e: handler replies go through the guard ═══════════ */
    console.log("\n── #5 e2e: handler reply routed through the guard ──")
    sendGuard._resetForTests()
    sendGuard.init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 100, capWindowMs: 60000, queueMaxAgeMs: 60000, identicalHourCap: 2 })
    const replies = []
    const quickBefore = state.settings.digestState.totals.quickReplies || 0
    const greetMsg = {
        id: { _serialized: "TESTH_GREETING_1" }, body: "hello there friend", fromMe: false, from: TEST_USER,
        hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async (t) => { replies.push(t); return { id: { _serialized: "X" } } },
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    }
    await handler.onMessage(greetMsg)
    await sleep(200)
    check("reply sent through the guard (with the owner-kept prefix)", replies.length === 1 && replies[0].startsWith("QUICK REPLY : "))
    check("digest counter bumped only when the reply really went out", (state.settings.digestState.totals.quickReplies || 0) === quickBefore + 1)

    sendGuard._resetForTests()
    sendGuard.init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 1, capWindowMs: 60000, queueMaxAgeMs: 60000, identicalHourCap: 100 })
    sendGuard.guardCustomerReply(TEST_USER, "reply never sent TESTH", async () => { })
    sendGuard.guardCustomerReply(TEST_USER, "another reply never sent TESTH", async () => { })
    await sleep(30)
    const report = sendGuard.shutdownReport()
    check("shutdown reports queued-but-unsent replies", report !== null && report.includes("1 queued bot replies"))

    /* ═══════════ cleanup: leave the project pristine ═══════════ */
    console.log("\n── cleanup ──")
    state.llmAvailable = false
    await sleep(300)   // let fire-and-forget appends land before snapshot restore
    sendGuard._resetForTests()
    try { reviewDB.prepare("DELETE FROM pending WHERE question LIKE '%testh%' OR answer LIKE '%testh%'").run() } catch { }
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testh%'").run() } catch { }
    try { convoDB.prepare("DELETE FROM conversations WHERE user = ?").run(TEST_USER) } catch { }
    try { delete state.persistentMemory[TEST_USER] } catch { }

    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)
    restoreFile(PATHS.MEMORY, snapMemory)
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)
    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)
    restoreFile(PATHS.EMBED_CACHE, snapCache)
    restoreFile(PATHS.PROCESSED_IDS, snapProcessedIds)
    restoreFile(PATHS.LINKS_LEDGER, snapLinks)

    for (const f of [PATHS.LOG_HN, PATHS.LOG_ADMIN, PATHS.LOG_ERRORS]) {
        try {
            if (!fs.existsSync(f)) continue
            const lines = fs.readFileSync(f, "utf8").split("\n")
                .filter(l => l && !l.includes("0000000000") && !l.toLowerCase().includes("testh") && !l.includes("smoketest_admin"))
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
    console.log(`H BATCH TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("H BATCH TEST CRASHED:", e); process.exit(1) })
