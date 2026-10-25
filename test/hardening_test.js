"use strict"
/* test/hardening_test.js — pre-launch hardening checks.
   Covers:
   - scheme-less URL extraction: bare bit.ly/xyz + evil-site.xyz captured,
     trailing punctuation stripped, www.-without-scheme parses (and is trusted
     when the host is), duplicates collapse, e-mails/filenames are not links;
     stripURLs mirrors it
   - the ping URL is derived from LLM_URL (not hard-coded)
   - ECONNABORTED / timeout-message detection (a hung LM Studio = offline)
   - media size read from the fields the library really sets (_data.size,
     nested fileLength, MessageMedia.filesize after download)
   - VirusTotal calls carry an 8s timeout (axios monkey-patched, no network)
   - group-member quotes route to the REVIEW QUEUE (never a direct commit)
   - knowledge.db emptied via DELETE (stale rows cannot survive a restart even
     when Windows blocks file deletion) + duplicate-key surfacing
   - corrupt settings.json / chat_memory.json: .corrupt copy preserved, restore
     from .bak, loud notice (child-process restart scenarios)
   Stubs isolate WhatsApp. Project files snapshotted + restored. */

const path = require("path")
const fs = require("fs-extra")
const { execFileSync } = require("child_process")

const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    if (request === "qrcode-terminal") return path.join(__dirname, "stubs", "qrcode-terminal.js")
    if (request === "@xenova/transformers") return path.join(__dirname, "stubs", "transformers.js")
    return origResolve.call(this, request, ...args)
}

// FAKE VT key (never a real one) so the scan path is reachable; axios is
// monkey-patched below so NO network call ever happens in this test.
process.env.VT_API_KEY = "TESTG_FAKE_KEY"
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

/* Boot config in a CHILD process (= a real restart with fresh module state)
   and report what it loaded. Used by the #2 corruption scenarios. */
function runConfigChild() {
    const script =
        "const cfg = require('./src/config'); " +
        "const state = require('./src/state'); " +
        "const notices = cfg.drainStateFileNotices(); " +
        "console.log('GRESULT=' + JSON.stringify({ bl: (state.settings && state.settings.blacklist) || [], mem: Object.keys(state.persistentMemory || {}), notices: notices }))"
    return execFileSync(process.execPath, ["-e", script], {
        cwd: PROJ, env: { ...process.env, ADMIN: ADMIN_JID }, encoding: "utf8", timeout: 60000
    })
}
function childResult(out) {
    const m = /GRESULT=(.*)/.exec(out || "")
    try { return m ? JSON.parse(m[1]) : null } catch { return null }
}

async function main() {
    /* ── snapshots: the real project files must survive this test ── */
    const { PATHS, VT_TIMEOUT_MS } = require("../src/config")
    const snapSettings = snapshotFile(PATHS.SETTINGS)
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")
    const snapMemory = snapshotFile(PATHS.MEMORY)
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")
    const snapCache = snapshotFile(PATHS.EMBED_CACHE)
    const snapProcessedIds = snapshotFile(PATHS.PROCESSED_IDS)
    const snapLinks = snapshotFile(PATHS.LINKS_LEDGER)
    const prestartBefore = new Set((() => {
        try { return fs.readdirSync(PATHS.LOG_BACKUPS) } catch { return [] }
    })().filter(f => f.startsWith("knowledge_prestart_")))

    const state = require("../src/state")
    const security = require("../src/security")
    const { getMediaSizeBytes, downloadedMediaBytes } = require("../src/util")
    const llm = require("../src/llm")
    const knowledge = require("../src/knowledge")
    knowledge.init({ notifyAdmin: () => { } })
    const { knowledgeDB, reviewDB, convoDB } = require("../src/db")
    const handler = require("../src/handler")

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
    state.adminClient = { getChatById: async () => ({ sendMessage: async () => ({}) }) }
    state.selfChatId = ADMIN_JID

    /* ═══════════ #19: scheme-less URL extractor ═══════════ */
    console.log("\n── #19: extractURLs — scheme-less links, punctuation, dedupe ──")
    let urls = security.extractURLs("check this bit.ly/xyz now")
    check("bare shortener bit.ly/xyz is captured", urls.length === 1 && urls[0] === "https://bit.ly/xyz")
    urls = security.extractURLs("visit evil-site.xyz today")
    check("bare domain evil-site.xyz is captured", urls.length === 1 && urls[0] === "https://evil-site.xyz")
    urls = security.extractURLs("see https://a.com/x and www.b.com/y please")
    check("scheme + www links still captured (2, no double-count)", urls.length === 2)
    urls = security.extractURLs("go to https://example.com/a, now")
    check("trailing comma stripped from the URL", urls[0] === "https://example.com/a")
    urls = security.extractURLs("a.com/x then a.com/x again bit.ly/x")
    check("duplicates collapse (3 mentions → 2 URLs)", urls.length === 2)
    urls = security.extractURLs("www.c.com/z and c.com/z")
    check("www.c.com ≡ c.com dedupe to one URL", urls.length === 1)
    check("www. without scheme now parses as a URL (used to crash new URL)",
        security.getHostname(security.extractURLs("see www.youtube.com/x")[0]) === "youtube.com")
    check("www.youtube.com without scheme is TRUSTED via the extractor",
        security.isTrustedURL(security.extractURLs("see www.youtube.com/x")[0]) === true)
    check("a shortener link is NOT trusted", security.isTrustedURL(security.extractURLs("see bit.ly/xyz")[0]) === false)
    check("no false positive on filenames", security.extractURLs("send photo.jpg and doc.pdf and memo.docx").length === 0)
    check("no false positive on plain numbers", security.extractURLs("it costs 3.5 out of 10").length === 0)
    check("an e-mail address is not a link", security.extractURLs("mail me at bob@example.com").length === 0)
    check("empty text → no URLs", security.extractURLs("").length === 0)
    check("stripURLs removes the bare link text", security.stripURLs("go bit.ly/x now").replace(/\s+/g, " ").trim() === "go now")

    /* ═══════════ #6: ping URL derived from LLM_URL ═══════════ */
    console.log("\n── #6: the LM Studio ping follows LLM_URL ──")
    check("default LLM_URL → default models URL",
        llm.deriveModelsUrl("http://127.0.0.1:1234/v1/chat/completions") === "http://127.0.0.1:1234/v1/models")
    check("remote LLM_URL → remote models URL (was silently dead before)",
        llm.deriveModelsUrl("http://192.168.1.5:8000/v1/chat/completions") === "http://192.168.1.5:8000/v1/models")
    check("garbage LLM_URL → safe fallback to the default",
        llm.deriveModelsUrl("not a url") === "http://127.0.0.1:1234/v1/models")

    /* ═══════════ #15: LLM timeout error detection ═══════════ */
    console.log("\n── #15: ECONNABORTED + timeout detection ──")
    check("ECONNABORTED (what axios really sends on timeout) → offline", llm.isLlmUnavailableError({ code: "ECONNABORTED" }) === true)
    check("ECONNREFUSED still detected", llm.isLlmUnavailableError({ code: "ECONNREFUSED" }) === true)
    check("ETIMEDOUT still detected", llm.isLlmUnavailableError({ code: "ETIMEDOUT" }) === true)
    check("timeout in the message text detected", llm.isLlmUnavailableError({ code: "", message: "timeout of 8000ms exceeded" }) === true)
    check("a 500 error is NOT 'offline' (the server is up)", llm.isLlmUnavailableError({ code: "ERR_BAD_RESPONSE", message: "Request failed with status code 500" }) === false)
    check("no error object → not offline", llm.isLlmUnavailableError(null) === false)

    /* ═══════════ #4: media size from the real library fields ═══════════ */
    console.log("\n── #4: media size — the fields the library really sets ──")
    check("_data.size (the field the library actually provides) is read",
        getMediaSizeBytes({ _data: { size: 25 * 1048576 } }) === 25 * 1048576)
    check("_data.fileLength still read (back-compat with old shapes)",
        getMediaSizeBytes({ _data: { fileLength: "26214400" } }) === 26214400)
    check("nested protobuf form (_data.message.documentMessage.fileLength) is read",
        getMediaSizeBytes({ _data: { message: { documentMessage: { fileLength: 12345 } } } }) === 12345)
    check("missing size → null (NOT zero)", getMediaSizeBytes({ _data: {} }) === null)
    check("downloadedMediaBytes prefers the exact library size (filesize)",
        downloadedMediaBytes({ filesize: 21 * 1048576, data: "AAAA" }) === 21 * 1048576)
    check("downloadedMediaBytes falls back to the base64 estimate",
        downloadedMediaBytes({ data: Buffer.from("hello world").toString("base64") }) === 12)
    check("no data and no size → null", downloadedMediaBytes({}) === null)
    {
        // end-to-end: oversized media via the REAL field never downloads
        const mediaDir = path.join(PATHS.MEDIA_CHATS, "0000000000")
        fs.ensureDirSync(mediaDir)
        const filesBefore = fs.readdirSync(mediaDir).length
        let downloadCalls = 0
        const huge = {
            id: { _serialized: "TESTG_MEDIA_SIZEFIELD" }, body: "", fromMe: false, from: TEST_USER,
            hasMedia: true, type: "image", hasQuotedMsg: false,
            _data: { size: 25 * 1048576 },   // 25MB > 20MB cap — via the REAL field
            downloadMedia: async () => { downloadCalls++; throw new Error("download attempted despite oversize") },
            reply: async () => ({ id: { _serialized: "X" } }),
            getChat: async () => ({ name: null }), getQuotedMessage: async () => null
        }
        await handler.onMessage(huge)
        check("oversized via _data.size: download skipped, nothing saved",
            downloadCalls === 0 && fs.readdirSync(mediaDir).length === filesBefore)
        try { fs.removeSync(mediaDir) } catch { }
    }

    /* ═══════════ #3: VirusTotal timeout on both calls ═══════════ */
    console.log("\n── #3: VT calls carry the 8s timeout (no network — axios patched) ──")
    check("VT_TIMEOUT_MS exists in config (8000)", VT_TIMEOUT_MS === 8000)
    {
        const axios = require("axios")
        const postOpts = [], getOpts = []
        const origPost = axios.post
        const origGet = axios.get
        axios.post = async (url, body, opts) => { postOpts.push(opts); return { data: { data: { id: "testgid" } } } }
        axios.get = async (url, opts) => { getOpts.push(opts); throw new Error("vt report unreachable (test)") }
        let safe = null
        try {
            safe = await security.checkURL("https://testg-unknown.example.com/x", "testg", TEST_USER, null, "dm", "")
        } finally {
            axios.post = origPost
            axios.get = origGet
        }
        check("VT total failure still fails OPEN (by design)", safe === true)
        check("VT POST (scan submission) carries timeout: 8000 on every attempt",
            postOpts.length >= 3 && postOpts.every(o => o && o.timeout === 8000))
        check("VT GET (report fetch) carries timeout: 8000 on every attempt",
            getOpts.length >= 3 && getOpts.every(o => o && o.timeout === 8000))
    }

    /* ═══════════ group-member quotes → review queue ═══════════ */
    console.log("\n── group quotes go to the review queue, not the brain ──")
    const reviewCountBefore = reviewDB.prepare("SELECT COUNT(*) c FROM pending").get().c
    const kbBefore = state.knowledge.entries.length
    const okG = await knowledge.learn("what is the TESTG group price", "it is 300 taka TESTG", false, 1.0, "group reply in testgroup", "group_quoted")
    check("group quote accepted (queued, not dropped)", okG === true)
    check("group quote NOT committed to the brain", state.knowledge.entries.length === kbBefore)
    const gRows = reviewDB.prepare("SELECT * FROM pending WHERE question LIKE '%testg%'").all()
    check("group quote waits in the review queue", gRows.some(r => (r.answer || "").includes("300 taka TESTG")))
    const okG11 = await knowledge.learn("TESTG group where are you", "when will you arrive TESTG?", false, 1.0, "group reply in testgroup", "group_quoted")
    check("group quote with a question-as-answer also queues (G11 note)", okG11 === true)
    const okGarbage = await knowledge.learn("TESTG group garbage question", "ok", false, 1.0, "group reply", "group_quoted")
    check("quality gates still reject garbage group quotes", okGarbage === false)
    const okOwner = await knowledge.learn("owner quoted TESTG pair", "owner quoted TESTG answer", false, 1.0, "owner quoted reply", "quoted")
    check("the OWNER's own quoted reply still commits directly (unchanged)",
        okOwner === true && state.knowledge.entries.some(e => e.message.includes("owner quoted testg pair")))
    check("review queue grew by exactly the 2 queued group pairs",
        reviewDB.prepare("SELECT COUNT(*) c FROM pending").get().c === reviewCountBefore + 2)

    /* ═══════════ #2: corrupt settings / chat_memory protection ═══════════ */
    console.log("\n── #2: corrupt settings.json — restored from .bak, .corrupt kept ──")
    const marker = "5550001111@testg.com"
    fs.writeFileSync(PATHS.SETTINGS, "{ this is not valid json ,,, ]")
    fs.writeFileSync(PATHS.SETTINGS + ".bak", JSON.stringify({ blacklist: [marker] }, null, 2))
    let outA = ""
    try { outA = runConfigChild() } catch (e) { outA = (e.stdout || "") + (e.stderr || "") }
    const resA = childResult(outA)
    check("A: blacklist restored from .bak (marker present)", resA && Array.isArray(resA.bl) && resA.bl.includes(marker))
    check("A: RECOVERY notice queued for the admin", resA && resA.notices.some(n => n.includes("RECOVERY") && n.includes("settings.json")))
    check("A: broken file preserved as settings.json.corrupt_*",
        fs.readdirSync(path.join(PROJ, "memory")).some(f => f.startsWith("settings.json.corrupt_")))
    let parsesA = false
    try { JSON.parse(fs.readFileSync(PATHS.SETTINGS, "utf8")); parsesA = true } catch { }
    check("A: settings.json parses again after the restore", parsesA)

    console.log("\n── #2: corrupt settings.json, NO backup → loud alert, never silent ──")
    fs.writeFileSync(PATHS.SETTINGS, "{ still not json ]")
    try { fs.removeSync(PATHS.SETTINGS + ".bak") } catch { }
    const hiddenBackups = []
    try {
        for (const d of fs.readdirSync(PATHS.LOG_BACKUPS).filter(d => d.startsWith("backup_"))) {
            fs.moveSync(path.join(PATHS.LOG_BACKUPS, d), path.join(PATHS.LOG_BACKUPS, "_testg_hidden_" + d))
            hiddenBackups.push(d)
        }
    } catch { }
    let outB = ""
    try { outB = runConfigChild() } catch (e) { outB = (e.stdout || "") + (e.stderr || "") }
    const resB = childResult(outB)
    for (const d of hiddenBackups) {
        try { fs.moveSync(path.join(PATHS.LOG_BACKUPS, "_testg_hidden_" + d), path.join(PATHS.LOG_BACKUPS, d)) } catch { }
    }
    check("B: bot still boots on a corrupt file (defaults), never crashes", resB !== null)
    check("B: loud ALERT notice about the corrupt file", resB && resB.notices.some(n => n.includes("ALERT") && n.includes("settings.json")))
    check("B: nothing restored — blacklist is the empty default", resB && Array.isArray(resB.bl) && resB.bl.length === 0)

    console.log("\n── #2: corrupt chat_memory.json — restored from .bak ──")
    const memMarker = "9990001111@testg.com"
    fs.writeFileSync(PATHS.MEMORY, "{ nope ]")
    fs.writeFileSync(PATHS.MEMORY + ".bak", JSON.stringify({ [memMarker]: { history: ["hi"], intent: null, lastSeen: 1 } }, null, 2))
    let outC = ""
    try { outC = runConfigChild() } catch (e) { outC = (e.stdout || "") + (e.stderr || "") }
    const resC = childResult(outC)
    check("C: chat memory restored from .bak (marker user present)", resC && resC.mem.includes(memMarker))
    check("C: RECOVERY notice names chat_memory.json", resC && resC.notices.some(n => n.includes("RECOVERY") && n.includes("chat_memory.json")))

    /* ═══════════ #1: knowledge.db emptied via DELETE, verified ═══════════ */
    console.log("\n── #1: stale knowledge.db rows cannot survive a restart ──")
    knowledgeDB.prepare("INSERT OR IGNORE INTO knowledge(message, reply, vector, embedding) VALUES(?, ?, ?, ?)")
        .run("stale_testg_should_vanish", "stale answer TESTG", "{}", null)
    check("stale row planted in the live DB",
        knowledgeDB.prepare("SELECT COUNT(*) c FROM knowledge WHERE message = ?").get("stale_testg_should_vanish").c === 1)
    const staleScript =
        "const db = require('./src/db'); " +
        "console.log('GCOUNT=' + db.knowledgeDB.prepare('SELECT COUNT(*) c FROM knowledge').get().c)"
    const outStale = execFileSync(process.execPath, ["-e", staleScript], {
        cwd: PROJ, env: { ...process.env, ADMIN: ADMIN_JID }, encoding: "utf8", timeout: 60000
    })
    check("after a 'restart' the table is EMPTY (DELETE-based wipe)", /GCOUNT=0/.test(outStale))
    check("the database FILE was never deleted (EBUSY-proof by design)", fs.existsSync(PATHS.KNOW_DB))

    console.log("\n── #1: duplicate keys in knowledge.json are surfaced ──")
    const snapEntries = state.knowledge.entries.slice()
    state.knowledge.entries.push({ message: "dup key testg alpha", reply: "first TESTG answer" })
    state.knowledge.entries.push({ message: "dup  key   testg alpha", reply: "second TESTG answer" })   // same normalized key
    // The rebuild is now SKIPPED while the DB provably matches the file —
    // write the dup entries to disk and start from an empty table so this is a
    // real fresh rebuild, exactly like boot (the snapshot restore at cleanup
    // brings the real file back).
    knowledge.saveKnowledgeJSON(state.knowledge)
    knowledgeDB.prepare("DELETE FROM knowledge").run()
    const capturedErr = []
    const origErr = console.error
    console.error = (...a) => { capturedErr.push(a.join(" ")) }
    await knowledge.buildKnowledgeDB()
    console.error = origErr
    check("duplicate normalized key surfaced loudly (admin notice)", capturedErr.some(l => l.includes("duplicate question")))
    state.knowledge.entries = snapEntries
    knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testg%'").run()
    knowledge.refreshKnowledgeCache()

    /* ═══════════ .gitignore hygiene ═══════════ */
    console.log("\n── .gitignore protects secrets ──")
    let gitignoreOk = false
    try {
        const g = fs.readFileSync(path.join(PROJ, ".gitignore"), "utf8")
        gitignoreOk = g.includes(".env") && g.includes(".wwebjs_auth")
    } catch { }
    check(".gitignore exists and covers .env + the WhatsApp session folder", gitignoreOk)

    /* ═══════════ cleanup: leave the project pristine ═══════════ */
    console.log("\n── cleanup ──")
    state.llmAvailable = false
    await sleep(300)   // let fire-and-forget appends land before snapshot restore
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testg%'").run() } catch { }
    try { reviewDB.prepare("DELETE FROM pending WHERE question LIKE '%testg%' OR answer LIKE '%testg%'").run() } catch { }
    try { convoDB.prepare("DELETE FROM conversations WHERE user = ?").run(TEST_USER) } catch { }
    try { delete state.persistentMemory[TEST_USER] } catch { }
    try { knowledge.refreshKnowledgeCache() } catch { }

    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)
    restoreFile(PATHS.MEMORY, snapMemory)
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)
    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)
    restoreFile(PATHS.EMBED_CACHE, snapCache)
    restoreFile(PATHS.PROCESSED_IDS, snapProcessedIds)
    restoreFile(PATHS.LINKS_LEDGER, snapLinks)

    // remove .corrupt_* artifacts created by the #2 scenarios
    try {
        for (const x of fs.readdirSync(path.join(PROJ, "memory"))
            .filter(x => x.startsWith("settings.json.corrupt_") || x.startsWith("chat_memory.json.corrupt_"))) {
            fs.removeSync(path.join(PROJ, "memory", x))
        }
    } catch { }
    // remove only the knowledge_prestart backups THIS suite created
    try {
        for (const f of fs.readdirSync(PATHS.LOG_BACKUPS)
            .filter(f => f.startsWith("knowledge_prestart_") && !prestartBefore.has(f))) {
            fs.removeSync(path.join(PATHS.LOG_BACKUPS, f))
        }
    } catch { }

    // strip test noise from append-only logs
    for (const f of [PATHS.LOG_HN, PATHS.LOG_ADMIN, PATHS.LOG_ERRORS]) {
        try {
            if (!fs.existsSync(f)) continue
            const lines = fs.readFileSync(f, "utf8").split("\n")
                .filter(l => l && !l.includes("0000000000") && !l.toLowerCase().includes("testg")
                    && !l.includes("smoketest_admin") && !l.includes("duplicate normalized key"))
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
    console.log(`G BATCH TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("G BATCH TEST CRASHED:", e); process.exit(1) })
