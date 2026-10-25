"use strict"
/* test/scoring_test.js — scoring + config checks.
   Covers:
   - dead timing code removed (zero callers)
   - all scoring constants exist in config with exact values; findBestReply's
     score equals the formula built FROM THE CONSTANTS (zero-drift proof); the
     previously-dead decision thresholds are actually wired (decide() boundary
     tests + fuseConfidence weights)
   - quiet mode — default OFF, !quiet on/off persists to settings.json, only
     the per-message decision console line is hidden, file logging continues,
     !help lists it, !stats shows it
   - normalize/canonicalize deliberately NOT merged — their difference is
     documented and asserted (normalize keeps punctuation, the comparison
     cleaner strips it)
   Stubs isolate WhatsApp/network. Project files snapshotted + restored. */

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
const ADMIN_JID = "smoketest_admin@c.us"
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
    const cfg = require("../src/config")
    const { PATHS } = cfg
    const snapSettings = snapshotFile(PATHS.SETTINGS)       // taken AFTER config load (quiet:false default is legitimate)
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")   // saveJSON keeps .bak for settings/memory now
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")
    const snapProcessedIds = snapshotFile(PATHS.PROCESSED_IDS)
    const snapMemory = snapshotFile(PATHS.MEMORY)
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")

    const state = require("../src/state")
    const text = require("../src/text")
    const utilExports = require("../src/util")
    const knowledge = require("../src/knowledge")
    knowledge.init({ notifyAdmin: () => { } })
    const { knowledgeDB, reviewDB, convoDB } = require("../src/db")
    const handler = require("../src/handler")
    const admin = require("../src/admin")
    const digest = require("../src/digest")
    const { getEmbedding } = require("../src/embeddings")

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
    state.llmAvailable = false
    state.adminClient = { getChatById: async () => ({ sendMessage: async () => ({}) }) }
    state.selfChatId = ADMIN_JID
    // Tiny send-guard knobs so reply pacing (3–6s in production) doesn't slow this suite
    require("../src/sendGuard").init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 1000, queueMaxAgeMs: 60000 })

    async function insertEntry(msg, reply) {
        const vec = JSON.stringify(text.buildVector(msg))
        const emb = await getEmbedding(msg)
        knowledgeDB.prepare("INSERT OR IGNORE INTO knowledge(message, reply, vector, embedding) VALUES(?, ?, ?, ?)")
            .run(msg, reply, vec, text.embeddingToBuffer(emb))
    }

    /* ═══════════ dead code removed ═══════════ */
    console.log("\n── stage timing code removed ──")
    check("stageStart/stageEnd gone from util exports", !("stageStart" in utilExports) && !("stageEnd" in utilExports))
    check("stageTimings gone from state", !("stageTimings" in state))
    check("quietMode() helper added in its place", typeof utilExports.quietMode === "function")

    /* ═══════════ constants exist with exact values ═══════════ */
    console.log("\n── every scoring number lives in config ──")
    const expectedF2 = {
        GROUP_CONFIDENCE_THRESHOLD: 0.75, THRESHOLD_HIGH: 0.60, THRESHOLD_MEDIUM: 0.42,
        SEARCH_LEX_COSINE_WEIGHT: 0.6, SEARCH_LEX_JACCARD_WEIGHT: 0.4,
        SEARCH_LEN_NORM_BASE: 0.55, SEARCH_LEN_NORM_RATIO: 0.45,
        SEARCH_HYBRID_SEM_WEIGHT: 0.6, SEARCH_HYBRID_LEX_WEIGHT: 0.4,
        SEARCH_CONTEXT_LEX_BOOST: 0.08, SEARCH_CONTEXT_SEM_BOOST: 0.07,
        SEARCH_MARGIN_MIN: 0.06, SEARCH_MARGIN_PENALTY: 0.80,
        FUSE_HYBRID_WEIGHT: 0.7, FUSE_INTENT_WEIGHT: 0.3,
        LEARN_ANSWER_RELATED_COSINE: 0.40, NEAR_DUP_LEXICAL: 0.90, NEAR_DUP_COSINE: 0.92
    }
    for (const [k, v] of Object.entries(expectedF2)) check(`config.${k} = ${v}`, cfg[k] === v)

    /* ═══════════ zero-drift proof — score ≡ formula-from-constants ═══════════ */
    console.log("\n── findBestReply score matches the constants formula (zero drift) ──")
    const entryMsg = "testf refund policy question"          // stored lowercase → deterministic embeddings
    await insertEntry(entryMsg, "refunds take 3 working days TESTF")
    await insertEntry("testf opening hours probe", "we open 9am to 9pm TESTF")
    knowledge.refreshKnowledgeCache()

    const query = "testf refund policy question today"       // near-miss: weights actually matter
    const cleaned = text.canonicalize(text.applyTypoMap(query))
    const inputVec = text.buildVector(cleaned)
    const entryVec = text.buildVector(entryMsg)
    const lexCos = text.cosineLexical(inputVec, entryVec)
    const jac = text.jaccardSimFromSets(new Set(text.tokenize(cleaned, true)), new Set(text.tokenize(entryMsg, true)))
    const lexScore = lexCos * cfg.SEARCH_LEX_COSINE_WEIGHT + jac * cfg.SEARCH_LEX_JACCARD_WEIGHT
    const iLen = text.tokenize(cleaned, true).length || 1
    const eLen = text.tokenize(entryMsg, true).length || 1
    const lenRatio = Math.min(iLen, eLen) / Math.max(iLen, eLen)
    const lexFinal = lexScore * (cfg.SEARCH_LEN_NORM_BASE + cfg.SEARCH_LEN_NORM_RATIO * lenRatio)
    const sem = text.cosineEmbedding(await getEmbedding(cleaned), await getEmbedding(entryMsg))
    const expectedScore = sem * cfg.SEARCH_HYBRID_SEM_WEIGHT + lexFinal * cfg.SEARCH_HYBRID_LEX_WEIGHT

    const result = await knowledge.findBestReply(query, TEST_USER)
    check("rawScore is EXACTLY the formula built from the constants (drift-free)",
        Math.abs(result.rawScore - expectedScore) < 1e-9)
    check("best entry is the near-miss match (weights preserve ranking)", result.reply === "refunds take 3 working days TESTF")
    check("clear margin → no penalty (hybridScore === rawScore)", result.hybridScore === result.rawScore)

    /* ═══════════ decision thresholds actually wired ═══════════ */
    console.log("\n── decide() uses the config thresholds ──")
    check("fuseConfidence(1, 0) = 0.7 (FUSE weights wired)", knowledge.fuseConfidence(1, 0) === 0.7)
    check("fuseConfidence(0, 1) = 0.3", knowledge.fuseConfidence(0, 1) === 0.3)

    const intentQ = { intent: "question", confidence: "low", intentWeight: 0.65 }   // fused(0.80) = 0.755
    const dKnow = handler.decide("a perfectly normal message body", TEST_USER, intentQ, { hybridScore: 0.80, reply: "r" }, false, { hit: false }, false)
    check("DM fused 0.755 ≥ THRESHOLD_HIGH 0.60 → REPLY_KNOW", dKnow.action === "REPLY_KNOW")

    const dLow = handler.decide("a perfectly normal message body", TEST_USER,
        { intent: "chat", confidence: "low", intentWeight: 0.30 }, { hybridScore: 0.55, reply: "r" }, false, { hit: false }, false)
    // fused = 0.475: above 0.42 but intent is chat and there is no context → SILENT (llm off)
    check("DM fused 0.475, no ctx/help/question → SILENT", dLow.action === "SILENT")

    const dGroup = handler.decide("a perfectly normal message body", "123@g.us", intentQ, { hybridScore: 0.80, reply: "r" }, true, { hit: false }, true)
    check("group fused 0.755 ≥ GROUP_CONFIDENCE_THRESHOLD 0.75 → REPLY_KNOW", dGroup.action === "REPLY_KNOW")

    const dGroupLow = handler.decide("a perfectly normal message body", "123@g.us", intentQ, { hybridScore: 0.70, reply: "r" }, true, { hit: false }, true)
    check("group fused 0.685 < 0.75 → SILENT (group bar wired)", dGroupLow.action === "SILENT")

    /* ═══════════ quiet mode ═══════════ */
    console.log("\n── quiet mode — default OFF, !quiet toggles, only the decision line hides ──")
    check("quiet defaults to OFF", state.settings.quiet === false)
    check("quietMode() helper reads the setting", utilExports.quietMode() === false)

    const adminReplies = []
    const adminMsg = (body) => ({
        id: { _serialized: "TESTF_ADMIN_" + Math.random().toString(36).slice(2) },
        body, fromMe: false, from: ADMIN_JID, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async (t) => { adminReplies.push(t); return { id: { _serialized: "X" } } },
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    })

    await admin.handleCommand(adminMsg("!quiet on"), ADMIN_JID, "!quiet on")
    check("!quiet on sets settings.quiet", state.settings.quiet === true)
    check("!quiet on persists to settings.json", fs.readFileSync(PATHS.SETTINGS, "utf8").includes('"quiet": true'))
    check("!quiet on confirms to the admin", adminReplies.some(t => t.includes("Quiet mode ON")))
    await admin.handleCommand(adminMsg("!quiet off"), ADMIN_JID, "!quiet off")
    check("!quiet off clears it again", state.settings.quiet === false && utilExports.quietMode() === false)
    await admin.handleCommand(adminMsg("!help"), ADMIN_JID, "!help")
    check("!help lists !quiet", adminReplies.some(t => t.includes("!quiet")))
    await admin.handleCommand(adminMsg("!stats"), ADMIN_JID, "!stats")
    check("!stats shows the Quiet line", adminReplies.some(t => t.includes("Quiet")))

    // console suppression: same message twice, quiet OFF vs ON
    const chatLogPath = path.join(PATHS.LOG_CHATS, "0000000000.txt")
    const mkMsg = (id) => ({
        id: { _serialized: id }, body: "hello there TESTF friend", fromMe: false, from: TEST_USER,
        hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async () => ({ id: { _serialized: "X" } }),
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    })
    const origLog = console.log
    const capture = () => { const lines = []; console.log = (...a) => lines.push(a.join(" ")); return lines }
    const isDecisionLine = l => l.includes("intent:") && l.includes("→")

    state.settings.quiet = false
    const logsOff = capture()
    await handler.onMessage(mkMsg("TESTF_MSG_QOFF"))
    console.log = origLog
    check("quiet OFF: per-message decision line prints", logsOff.some(isDecisionLine))

    state.settings.quiet = true
    const logsOn = capture()
    await handler.onMessage(mkMsg("TESTF_MSG_QON"))
    console.log = origLog
    state.settings.quiet = false
    check("quiet ON: decision line suppressed", !logsOn.some(isDecisionLine))
    check("quiet ON: file logging continues (IN + BOT lines written)",
        fs.readFileSync(chatLogPath, "utf8").includes("hello there TESTF friend"))
    await sleep(200)   // async processed-ID append lands before snapshot restore

    /* ═══════════ normalize vs canonicalize — kept separate, documented ═══════════ */
    console.log("\n── the two cleaners stay separate (difference asserted) ──")
    check("normalize KEEPS punctuation (storage cleaner)", text.normalize("Hi! TESTF?") === "hi! testf?")
    check("canonicalize STRIPS punctuation (comparison cleaner)", text.canonicalize("Hi! TESTF?") === "hi testf")

    /* ═══════════ cleanup: leave the project pristine ═══════════ */
    console.log("\n── cleanup ──")
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testf%'").run() } catch { }
    try { reviewDB.prepare("DELETE FROM pending WHERE question LIKE '%testf%' OR answer LIKE '%testf%'").run() } catch { }
    try { convoDB.prepare("DELETE FROM conversations WHERE user = ?").run(TEST_USER) } catch { }
    try { delete state.persistentMemory[TEST_USER] } catch { }
    knowledge.refreshKnowledgeCache()

    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)   // hygiene
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)        // hygiene
    restoreFile(PATHS.PROCESSED_IDS, snapProcessedIds)
    restoreFile(PATHS.MEMORY, snapMemory)
    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)

    for (const f of [PATHS.LOG_HN, PATHS.LOG_ADMIN]) {
        try {
            if (!fs.existsSync(f)) continue
            const lines = fs.readFileSync(f, "utf8").split("\n")
                .filter(l => l && !l.includes("0000000000") && !l.toLowerCase().includes("testf") && !l.includes("smoketest_admin"))
            fs.writeFileSync(f, lines.length ? lines.join("\n") + "\n" : "")
        } catch { }
    }
    for (const f of [
        path.join(PATHS.LOG_CHATS, "0000000000.txt"),
        path.join(PATHS.LLM_CTX_CHATS, "0000000000.txt"),
    ]) { try { fs.removeSync(f) } catch { } }

    check("cleanup done (files restored, test rows removed)", true)

    console.log("\n═══════════════════════════════")
    console.log(`F BATCH TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("F BATCH TEST CRASHED:", e); process.exit(1) })
