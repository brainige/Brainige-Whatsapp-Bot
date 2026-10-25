"use strict"
/* test/handler_test.js — link-safety + LLM-ping checks.
   An UNSAFE link must produce NO contact-facing reply; admin-side logging
   only (human_needed log + digest). Also verifies the links.jsonl ledger
   writer. pingLLMStudio logs state changes only (no spam).
   All writes to project files are cleaned up at the end. No network:
   checkURL is monkey-patched (no VirusTotal call), LM Studio is pinged
   only if reachable locally (127.0.0.1 — harmless GET /v1/models). */

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

// Empty-string env vars are NOT overridden by dotenv (override: false),
// so VirusTotal stays disabled — no API calls from this test.
process.env.VT_API_KEY = ""
process.env.ADMIN = "smoketest_admin@c.us"

const TEST_USER = "0000000000@c.us"

let pass = 0, fail = 0
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✅ ${name}`) }
    else { fail++; console.log(`  ❌ ${name}`) }
}

function stripUserLines(file, user) {
    try {
        if (!fs.existsSync(file)) return
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(l => !l.includes(user))
        fs.writeFileSync(file, lines.join("\n"))
    } catch { }
}

/* F-batch hygiene: same snapshot/restore helpers the other suites use. */
function snapshotFile(p) { try { return fs.readFileSync(p, "utf8") } catch { return null } }
function restoreFile(p, content) {
    try {
        if (content === null) { if (fs.existsSync(p)) fs.removeSync(p) }
        else fs.writeFileSync(p, content)
    } catch { }
}

async function main() {
    // snapshot digest state so we can restore it
    const { saveJSON, PATHS } = require("../src/config")
    const state = require("../src/state")
    const digestBefore = JSON.parse(JSON.stringify(state.settings.digestState || {}))
    // F-batch hygiene: snapshot processed_ids.jsonl too — markProcessed() appends
    // to it on every handled message and a restore-less test leaves stale lines.
    const snapProcessedIds = snapshotFile(PATHS.PROCESSED_IDS)
    // Hygiene: saveJSON now keeps a .bak for settings/chat_memory —
    // snapshot those too so this test leaves nothing new behind.
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")

    // ── patch checkURL to simulate a MALICIOUS verdict ──
    const security = require("../src/security")
    security.checkURL = async () => false   // malicious verdict, no network

    const handler = require("../src/handler")

    const replies = []
    const fakeMessage = {
        id: { _serialized: "TEST_MSG_1" },
        body: "check this https://youtube.com.evil.xyz/watch now",
        fromMe: false,
        from: TEST_USER,
        hasMedia: false,
        type: "chat",
        hasQuotedMsg: false,
        reply: async (text) => { replies.push(text); return { id: { _serialized: "TEST_SENT" } } },
        getChat: async () => ({ name: null }),
        getQuotedMessage: async () => null
    }

    state.adminClient = { getChatById: async () => ({ sendMessage: async () => ({}) }) }
    state.selfChatId = "smoketest_admin@c.us"

    console.log("── unsafe link → contact sees NOTHING ──")
    await handler.onMessage(fakeMessage)
    check("contact received ZERO replies", replies.length === 0)
    const hnLog = fs.readFileSync(PATHS.LOG_HN, "utf8")
    check("human_needed log has unsafe_link entry", hnLog.includes("unsafe_link"))
    check("digest counted unsafe_link", (state.settings.digestState.hnCategories || {}).unsafe_link >= 1)

    // ── ledger writer (real functions, no patch) ──
    console.log("── links.jsonl ledger writer ──")
    security.appendLinkLedger(security.buildLinkEntry(
        "https://example.com/x", TEST_USER, "Test Contact", "dm", "", "malicious"
    ))
    const ledgerLines = fs.readFileSync(PATHS.LINKS_LEDGER, "utf8").trim().split("\n")
    const lastEntry = JSON.parse(ledgerLines[ledgerLines.length - 1])
    check("ledger line is valid JSON", lastEntry.url === "https://example.com/x")
    check("ledger has sender name", lastEntry.name === "Test Contact")
    check("ledger has verdict", lastEntry.verdict === "malicious")

    // ── state-change-only logging ──
    console.log("── LM Studio ping logs state changes only ──")
    const { pingLLMStudio } = require("../src/llm")
    const logs = []
    const origLog = console.log
    console.log = (...a) => logs.push(a.join(" "))
    state.llmAvailable = false
    await pingLLMStudio()          // first ping: may or may not log (depends on local LM Studio)
    const afterFirst = logs.length
    await pingLLMStudio()          // second ping: state unchanged → NO new log
    const afterSecond = logs.length
    console.log = origLog
    check("repeat pings don't spam the log (state-change only)", afterSecond === afterFirst)

    // ── cleanup: restore project files ──
    console.log("── cleanup ──")
    state.settings.digestState = digestBefore
    saveJSON(PATHS.SETTINGS, state.settings)
    stripUserLines(PATHS.LOG_HN, "0000000000")
    stripUserLines(PATHS.LOG_ADMIN, "0000000000")
    stripUserLines(path.join(PATHS.LOG_CHATS, "0000000000.txt"), "x") // whole file is test-only
    for (const f of [
        path.join(PATHS.LOG_CHATS, "0000000000.txt"),
        path.join(PATHS.LLM_CTX_CHATS, "0000000000.txt"),
    ]) { try { fs.removeSync(f) } catch { } }
    try {
        const { convoDB } = require("../src/db")
        convoDB.prepare("DELETE FROM conversations WHERE user = ?").run(TEST_USER)
    } catch { }
    delete state.persistentMemory[TEST_USER]
    saveJSON(PATHS.MEMORY, state.persistentMemory)
    // remove the last ledger line (ours)
    try {
        const lines = fs.readFileSync(PATHS.LINKS_LEDGER, "utf8").trim().split("\n")
        lines.pop()
        fs.writeFileSync(PATHS.LINKS_LEDGER, lines.length ? lines.join("\n") + "\n" : "")
    } catch { }
    restoreFile(PATHS.PROCESSED_IDS, snapProcessedIds)   // F-batch hygiene: no stale test IDs
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)   // hygiene
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)        // hygiene
    check("cleanup done", true)

    console.log("\n═══════════════════════════════")
    console.log(`HANDLER TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("HANDLER TEST CRASHED:", e); process.exit(1) })
