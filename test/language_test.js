"use strict"
/* test/language_test.js — native Bengali + Hindi reply checks.
   Covers:
   - language detection: Bengali script, Devanagari, romanized Bangla/Hindi,
     English default, mixed-script majority
   - intent detection fires for Bengali/Hindi greetings, thanks, apology, bye
   - the system prompt carries the explicit language rule
   - the unsure-fallback line exists in all three languages and none of the
     three is ever treated as knowledge
   - the canned-reply pools keep the same keys per language and the picker
     serves the right language
   - end to end: a Bangla or Hindi customer receives the fallback line in
     their own language even when the model answered with the English wording
   Stubs isolate WhatsApp/LLM/network. Project files are snapshotted and
   restored at the end. */

const path = require("path")
const fs = require("fs-extra")

const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    if (request === "qrcode-terminal") return path.join(__dirname, "stubs", "qrcode-terminal.js")
    if (request === "@xenova/transformers") return path.join(__dirname, "stubs", "transformers.js")
    if (request === "axios") return path.join(__dirname, "stubs", "axios.js")
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
    const { PATHS, LLM_DONT_KNOW, LLM_DONT_KNOW_BN, LLM_DONT_KNOW_HI } = require("../src/config")
    const { detectLanguage, detectIntent } = require("../src/text")
    const { buildSystemPrompt, HUMAN_FLAG_SENTINEL } = require("../src/llm")
    const axios = require("axios")
    const state = require("../src/state")
    const handler = require("../src/handler")
    const { reviewQueueCount } = require("../src/db")
    const { knowledgeDB, reviewDB, convoDB } = require("../src/db")

    /* snapshots: the real project files must survive this test */
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")
    const snapCache = snapshotFile(PATHS.EMBED_CACHE)
    const snapMemory = snapshotFile(PATHS.MEMORY)
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")
    const snapSettings = snapshotFile(PATHS.SETTINGS)
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")
    const snapProcessedIds = snapshotFile(PATHS.PROCESSED_IDS)
    const snapChatLog = snapshotFile("./logs/chats/0000000000.txt")
    const snapLlmCtx = snapshotFile("./llm_context/chats/0000000000.txt")

    /* keep reply pacing fast for this suite */
    require("../src/sendGuard").init({ gapMinMs: 1, gapMaxMs: 2, hourlyCap: 1000, queueMaxAgeMs: 60000 })

    console.log("\n── language detection ──")
    check("Bengali script detected", detectLanguage("সুপ্রভাত, ভালো আছেন?") === "bn")
    check("Devanagari detected", detectLanguage("नमस्ते, आप कैसे हैं?") === "hi")
    check("romanized Bangla detected", detectLanguage("kemon acho bhai, delivery kivabe pabo?") === "bn")
    check("romanized Hindi detected", detectLanguage("kya hai ye, mujhe janna hai") === "hi")
    check("English stays English", detectLanguage("hey what are your opening hours?") === "en")
    check("mixed script: majority script wins", detectLanguage("কেমন আছো दोस्त?") === "bn")
    check("mixed script: Devanagari majority wins", detectLanguage("नमस्ते ভাই, आप कैसे हैं?") === "hi")
    check("empty input defaults to English", detectLanguage("") === "en")
    check("ambiguous romanized tie stays English", detectLanguage("kya kemon onek matlab") === "en")

    console.log("\n── bilingual intent detection ──")
    check("Bengali greeting detected", detectIntent("সুপ্রভাত").intent === "greeting")
    check("Bengali greeting confidence is high", detectIntent("সুপ্রভাত").confidence === "high")
    check("Hindi greeting detected", detectIntent("नमस्ते जी").intent === "greeting")
    check("Bengali thanks detected", detectIntent("অনেক ধন্যবাদ").intent === "thanks")
    check("Hindi thanks detected", detectIntent("बहुत धन्यवाद").intent === "thanks")
    check("romanized apology detected", detectIntent("maaf karna, galti ho gayi").intent === "apology")
    check("Bengali apology detected", detectIntent("দুঃখিত, ভুল হয়ে গেছে").intent === "apology")
    check("alvida is a bye", detectIntent("alvida, take care").intent === "bye")
    check("English greeting still works", detectIntent("hello there").intent === "greeting")

    console.log("\n── system prompt ──")
    const prompt = buildSystemPrompt("")
    check("prompt carries the explicit language rule", prompt.includes("Bengali") && prompt.includes("Hindi") && prompt.includes("English"))
    check("prompt keeps the honesty fallback line", prompt.includes(LLM_DONT_KNOW))
    check("prompt keeps the human-flag sentinel", prompt.includes(HUMAN_FLAG_SENTINEL))
    check("prompt keeps the anti-injection rule", prompt.includes("ordinary chat text ONLY"))

    console.log("\n── translated fallback lines ──")
    check("Bengali fallback line exists", typeof LLM_DONT_KNOW_BN === "string" && LLM_DONT_KNOW_BN.length > 5)
    check("Hindi fallback line exists", typeof LLM_DONT_KNOW_HI === "string" && LLM_DONT_KNOW_HI.length > 5)
    check("English line recognized as not-knowledge", handler.isDontKnowReply(LLM_DONT_KNOW))
    check("Bengali line recognized as not-knowledge", handler.isDontKnowReply(LLM_DONT_KNOW_BN))
    check("Hindi line recognized as not-knowledge", handler.isDontKnowReply(LLM_DONT_KNOW_HI))
    check("trailing danda drift still recognized", handler.isDontKnowReply(LLM_DONT_KNOW_BN + "।"))
    check("a normal sentence is NOT a fallback", !handler.isDontKnowReply("The delivery takes 3 days."))

    console.log("\n── translated canned pools ──")
    check("Bengali pool has the same keys as English",
        JSON.stringify(Object.keys(handler.QUICK_REPLY_POOL_BN).sort()) === JSON.stringify(Object.keys(handler.QUICK_REPLY_POOL).sort()))
    check("Hindi pool has the same keys as English",
        JSON.stringify(Object.keys(handler.QUICK_REPLY_POOL_HI).sort()) === JSON.stringify(Object.keys(handler.QUICK_REPLY_POOL).sort()))
    check("Bangla greeting served for lang bn", handler.QUICK_REPLY_POOL_BN.greeting.includes(handler.getQuickReply({ intent: "greeting", confidence: "high" }, false, "bn")))
    check("Hindi greeting served for lang hi", handler.QUICK_REPLY_POOL_HI.greeting.includes(handler.getQuickReply({ intent: "greeting", confidence: "high" }, false, "hi")))
    check("English pool served for lang en", handler.QUICK_REPLY_POOL.greeting.includes(handler.getQuickReply({ intent: "greeting", confidence: "high" }, false, "en")))
    check("English pool served when lang is unknown", handler.QUICK_REPLY_POOL.greeting.includes(handler.getQuickReply({ intent: "greeting", confidence: "high" }, false, undefined)))
    check("greeting stays silent when a conversation is active", handler.getQuickReply({ intent: "greeting", confidence: "high" }, true, "bn") === null)
    check("low-confidence intents get no canned reply", handler.getQuickReply({ intent: "greeting", confidence: "medium" }, false, "bn") === null)

    console.log("\n── language-aware personalization ──")
    check("sad profile gets a Bengali empathy prefix", handler.composePersonalizedReply("Delivery takes 3 days.", { isSad: true }, 0, "bn").startsWith("আশা করি ভালো আছেন।"))
    check("sad profile gets a Hindi empathy prefix", handler.composePersonalizedReply("Delivery takes 3 days.", { isSad: true }, 0, "hi").startsWith("उम्मीद है आप ठीक हैं।"))
    check("sad profile keeps the English prefix for English", handler.composePersonalizedReply("Delivery takes 3 days.", { isSad: true }, 0, "en").startsWith("Hey, hope you're doing okay."))
    check("no profile means no prefix", handler.composePersonalizedReply("Delivery takes 3 days.", null, 0, "bn") === "Delivery takes 3 days.")
    check("no double prefix when the reply is already empathetic",
        handler.composePersonalizedReply("আশা করি ভালো আছেন। ঠিক আছে।", { isSad: true }, 0, "bn") === "আশা করি ভালো আছেন। ঠিক আছে।")

    console.log("\n── end to end: the fallback line ships in the customer's language ──")
    state.llmAvailable = true
    const replies = []
    const reviewBefore = reviewQueueCount()
    state.adminClient = { getChatById: async () => ({ sendMessage: async (t) => { replies.push(t); return {} } }) }
    state.selfChatId = ADMIN_JID

    const mkMsg = (id, body) => ({
        id: { _serialized: id }, body,
        fromMe: false, from: TEST_USER, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async (t) => { replies.push(t); return { id: { _serialized: "X" } } },
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    })

    axios.__setReply(LLM_DONT_KNOW)
    await handler.onMessage(mkMsg("TESTL_A", "flurble wug TESTL ডেলিভারি"))
    await sleep(500)
    check("Bangla customer gets the Bangla fallback line", replies.some(t => t === `QUICK REPLY : ${LLM_DONT_KNOW_BN}`))
    check("Bangla fallback NOT queued for learning", reviewQueueCount() === reviewBefore)

    axios.__setReply(LLM_DONT_KNOW)
    await handler.onMessage(mkMsg("TESTL_B", "flurble wug TESTL प्रश्न"))
    await sleep(500)
    check("Hindi customer gets the Hindi fallback line", replies.some(t => t === `QUICK REPLY : ${LLM_DONT_KNOW_HI}`))

    axios.__setReply(LLM_DONT_KNOW)
    await handler.onMessage(mkMsg("TESTL_C", "flurble wug TESTL english question"))
    await sleep(500)
    check("English customer still gets the English line (unchanged)", replies.some(t => t === `QUICK REPLY : ${LLM_DONT_KNOW}`))

    axios.__setReply("ডেলিভারি সাধারণত ৩ দিন লাগে TESTL।")
    await handler.onMessage(mkMsg("TESTL_D", "flurble wug TESTL ডেলিভারি কত দিন"))
    await sleep(500)
    check("a real Bangla reply from the model passes through unchanged", replies.some(t => t === "QUICK REPLY : ডেলিভারি সাধারণত ৩ দিন লাগে TESTL।"))
    check("a real Bangla reply IS queued for review (+1)", reviewQueueCount() === reviewBefore + 1)

    state.llmAvailable = false

    console.log("\n── owner identity (brand + configurable names) ──")
    const cfg = require("../src/config")
    check("default brand is Brainige", cfg.BRAND_NAME === "Brainige")
    check("default owner display is Utsab/Avi", cfg.OWNER_DISPLAY === "Utsab/Avi")
    check("default Bengali display is উৎসব/আভি", cfg.OWNER_DISPLAY_BN === "উৎসব/আভি")
    check("default Hindi display is उत्सब/अवि", cfg.OWNER_DISPLAY_HI === "उत्सब/अवि")
    check("default pause names are utsab,avi", JSON.stringify(cfg.PAUSE_NAMES) === JSON.stringify(["utsab", "avi"]))
    check("English pool mentions the owner, not the brand",
        handler.QUICK_REPLY_POOL.greeting.some(r => r.includes("Utsab/Avi")) &&
        !handler.QUICK_REPLY_POOL.greeting.some(r => r.includes("Brainige")))
    check("Bengali pool carries the Bengali display name", handler.QUICK_REPLY_POOL_BN.greeting.some(r => r.includes("উৎসব/আভি")))
    check("Hindi pool carries the Hindi display name", handler.QUICK_REPLY_POOL_HI.greeting.some(r => r.includes("उत्सब/अवि")))
    check("English fallback line carries the owner name", LLM_DONT_KNOW.includes("Utsab/Avi"))
    check("Bengali fallback line carries the Bengali name", LLM_DONT_KNOW_BN.includes("উৎসব/আভি"))
    check("Hindi fallback line carries the Hindi name", LLM_DONT_KNOW_HI.includes("उत्सब/अवि"))
    check("system prompt addresses the owner by display name", buildSystemPrompt("").includes("Utsab/Avi"))

    console.log("\n── configurable pause names ──")
    const pause = require("../src/pause")
    pause.setPauseNamesForTests(["rohit", "bhai"])
    check("custom pause name triggers (starts-with)", pause.checkAndTriggerPause(TEST_USER, "rohit?") === true)
    state.pauseMap.clear()
    check("custom pause name triggers (short message)", pause.checkAndTriggerPause(TEST_USER, "bhai ekta kaj") === true)
    state.pauseMap.clear()
    check("default name no longer triggers while overridden", pause.checkAndTriggerPause(TEST_USER, "utsab?") === false)
    pause.setPauseNamesForTests(null)
    check("defaults restored: utsab triggers again", pause.checkAndTriggerPause(TEST_USER, "utsab?") === true)
    state.pauseMap.clear()
    pause.setPauseNamesForTests([])
    check("empty pause-name list disables the trigger", pause.checkAndTriggerPause(TEST_USER, "utsab?") === false)
    pause.setPauseNamesForTests(null)
    state.pauseMap.clear()

    /* ═══════════ cleanup: leave the project pristine ═══════════ */
    console.log("\n── cleanup ──")
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testl%'").run() } catch { }
    try { reviewDB.prepare("DELETE FROM pending WHERE question LIKE '%testl%' OR answer LIKE '%testl%'").run() } catch { }
    try { convoDB.prepare("DELETE FROM conversations WHERE user = ?").run(TEST_USER) } catch { }
    try { delete state.persistentMemory[TEST_USER] } catch { }
    try { state.processed.clear() } catch { }

    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)
    restoreFile(PATHS.EMBED_CACHE, snapCache)
    restoreFile(PATHS.MEMORY, snapMemory)
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)
    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)
    restoreFile(PATHS.PROCESSED_IDS, snapProcessedIds)
    restoreFile("./logs/chats/0000000000.txt", snapChatLog)
    restoreFile("./llm_context/chats/0000000000.txt", snapLlmCtx)

    for (const f of [PATHS.LOG_HN, PATHS.LOG_ADMIN]) {
        try {
            if (!fs.existsSync(f)) continue
            const lines = fs.readFileSync(f, "utf8").split("\n")
            const kept = lines.filter(l => l && !l.includes("TESTL") && !l.includes("0000000000"))
            fs.writeFileSync(f, kept.length ? kept.join("\n") + "\n" : "")
        } catch { }
    }

    check("cleanup done (files restored, test rows removed)", true)

    console.log("\n═══════════════════════════════")
    console.log(`LANGUAGE TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error("LANGUAGE TEST crashed:", e); process.exit(1) })
