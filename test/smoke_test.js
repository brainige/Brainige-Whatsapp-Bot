"use strict"
/* smoke_test.js — sandboxed startup test. Stubs whatsapp-web.js so NOTHING
   connects to WhatsApp or downloads Puppeteer. Tests the modular pipeline:
   config → DBs → knowledge rebuild → admin wiring → decision engine → security. */

process.env.ADMIN = "smoketest_admin@c.us"   // only ADMIN var; no key material

const path = require("path")
const fs = require("fs-extra")

// 1. Stub whatsapp-web.js BEFORE requiring bot modules
const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    if (request === "qrcode-terminal") return path.join(__dirname, "stubs", "qrcode-terminal.js")
    if (request === "@xenova/transformers") return path.join(__dirname, "stubs", "transformers.js")
    return origResolve.call(this, request, ...args)
}

// 2. Boot the real modules (config, db, knowledge, memory, security...)
require("../src/config")
const state = require("../src/state")
const { buildKnowledgeDB, learn, findBestReply, fuseConfidence } = require("../src/knowledge")
const { reviewAdd, reviewQueueCount } = require("../src/db")
const { onMessage } = require("../src/handler")
const { isTrustedURL, getHostname, extractURLs } = require("../src/security")

let pass = 0, fail = 0
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✅ ${name}`) }
    else { fail++; console.log(`  ❌ ${name}`) }
}

const snapKnowledgeBak = (() => { try { return fs.readFileSync("./memory/knowledge.json.bak", "utf8") } catch { return null } })()

async function main() {
    console.log("\n── 1. Config & settings ──")
    check("settings loaded", state.settings && typeof state.settings.learning === "boolean")
    check("knowledge object loaded", Array.isArray(state.knowledge.entries))
    check("globalPauseUntil default", state.settings.globalPauseUntil === 0 || typeof state.settings.globalPauseUntil === "number")

    console.log("\n── 2. knowledge.db rebuild from knowledge.json ──")
    await buildKnowledgeDB()
    const db = require("../src/db")
    check("knowledge.db exists + rebuild ran", fs.existsSync("./memory/knowledge.db"))

    console.log("\n── 3. Learning pipeline + review queue ──")
    const ok = await learn("smoke test question about project deadlines", "smoke test answer about project deadlines", true, 0.1, "test")
    check("LLM-source learn goes to review queue (not auto-commit)", ok === true)
    check("review queue count is 1", reviewQueueCount() === 1)

    console.log("\n── 4. Decision engine + knowledge search ──")
    await learn("smoke test question about project deadlines", "smoke test answer about project deadlines", false)
    const match = await findBestReply("smoke test question about project deadlines", "test_user@c.us")
    check("knowledge search finds the entry", match.reply && match.reply.includes("smoke test answer"))
    check("fuseConfidence sane", fuseConfidence(0.5, 0.5) === 0.5)

    console.log("\n── 5. trusted-domain hostname check ──")
    check("youtube.com is trusted", isTrustedURL("https://youtube.com/watch?v=x") === true)
    check("www.youtube.com is trusted", isTrustedURL("https://www.youtube.com/watch?v=x") === true)
    check("m.youtube.com is trusted", isTrustedURL("https://m.youtube.com/watch?v=x") === true)
    check("youtube.com.evil.xyz NOT trusted (the A1 bug)", isTrustedURL("https://youtube.com.evil.xyz/watch") === false)
    check("evil.xyz/amazon.in NOT trusted", isTrustedURL("https://evil.xyz/amazon.in/path") === false)
    check("malformed URL NOT trusted", isTrustedURL("not a url") === false)
    check("extractURLs finds 2 links", extractURLs("see https://a.com/x and www.b.com/y please").length === 2)

    console.log("\n── 6. atomic write leaves no .tmp files ──")
    const tmpFiles = fs.readdirSync("./memory").filter(f => f.endsWith(".tmp"))
    check("no .tmp files in memory/", tmpFiles.length === 0)

    console.log("\n── 7. handler imports resolve (message_create path) ──")
    check("onMessage is a function", typeof onMessage === "function")

    console.log("\n── 8. Cleanup (leave project files pristine) ──")
    const dbm = require("../src/db")
    dbm.knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE 'smoke test%'").run()
    dbm.reviewDB.prepare("DELETE FROM pending WHERE question LIKE 'smoke test%'").run()
    state.knowledge.entries = state.knowledge.entries.filter(e => !(e.message || "").startsWith("smoke test"))
    const { saveKnowledgeJSON } = require("../src/knowledge")
    saveKnowledgeJSON(state.knowledge)
    const left = dbm.knowledgeDB.prepare("SELECT COUNT(*) c FROM knowledge WHERE message LIKE 'smoke test%'").get().c
    const leftRev = dbm.reviewDB.prepare("SELECT COUNT(*) c FROM pending WHERE question LIKE 'smoke test%'").get().c
    check("test entries removed from knowledge", left === 0)
    check("test entries removed from review queue", leftRev === 0)
    // Test hygiene: saveKnowledgeJSON
    // rotates .bak DURING the run — every chain run used to leave the smoke
    // entry inside it, i.e. test data in a B3 restore source. Restore the
    // pre-run .bak (remove it if it did not exist before this run).
    try {
        if (snapKnowledgeBak === null) { if (fs.existsSync("./memory/knowledge.json.bak")) fs.removeSync("./memory/knowledge.json.bak") }
        else fs.writeFileSync("./memory/knowledge.json.bak", snapKnowledgeBak)
    } catch { }

    console.log("\n═══════════════════════════════")
    console.log(`SMOKE TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("SMOKE TEST CRASHED:", e); process.exit(1) })
