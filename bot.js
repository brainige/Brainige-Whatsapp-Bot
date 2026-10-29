"use strict"
/* ══════════════════════════════════════════════════════
   Brainige WhatsApp Bot (modular)
   bot.js — entry point (thin). All logic in src/ modules.
══════════════════════════════════════════════════════ */

/* 1. Config loads settings + filesystem first (order matters). */
const { VERSION, BRAND_NAME, PATHS, saveJSON, drainStateFileNotices, DASHBOARD_TOKEN, DASHBOARD_PORT } = require("./src/config")
const state = require("./src/state")

/* 2. Databases (knowledge.db is wiped here for the V6.4 full-rebuild strategy). */
const db = require("./src/db")

/* 3. Core modules. */
const { initEmbedder } = require("./src/embeddings")
const {
    buildKnowledgeDB, computeAllMissingEmbeddings, knowledgeJsonChanged,
    learn, commitKnowledge, refreshKnowledgeCache, refreshKnowledgeCacheEmbeddings,
    isGarbage, isFiller, hasMinimumMeaningfulContent, saveKnowledgeJSON,
    init: initKnowledge, drainStartupNotices
} = require("./src/knowledge")
const {
    restoreConvoMemoryFromDisk, wipeAllLLMContextsOnStartup,
    startConvoMemorySweeper, startLLMCtxSweeper, startFlushTimer,
    runRetentionSweepNow, startRetentionSweeper
} = require("./src/memory")
const { startBotTextSweeper, loadProcessedIds, flushProcessedIdsSync } = require("./src/tracking")
const { startDigestTimer, buildDigestText } = require("./src/digest")
const { pingLLMStudio, startLLMWatchdog } = require("./src/llm")
const { notifyAdmin, notifyAdminBatched, flushPending: flushPendingNotices, startNotifyBatchTimer } = require("./src/notify")
const sendGuard = require("./src/sendGuard")
const { logError } = require("./src/logging")
const dashboardModule = require("./src/dashboard")
const { onMessage } = require("./src/handler")
const admin = require("./src/admin")
const reconnect = require("./src/reconnect")

/* 4. Wire cross-module dependencies (avoids circular imports). */

/* Dashboard — local-only web UI (Phase 0). init() RETURNS the server
   instance ({ start, stop, isRunning }) — it is a guest in this
   process: with no DASHBOARD_TOKEN in .env it never opens its port
   (fail-closed, loudly logged), and its stop() runs before the
   databases close. getToken/getPort are injected so the auth path
   stays fully testable offline (test/dashboard_test.js). */
const dashboard = dashboardModule.init({
    getToken: () => DASHBOARD_TOKEN,
    getPort: () => DASHBOARD_PORT,
    logError
})

initKnowledge({ notifyAdmin, notifyAdminBatched })
admin.init({
    knowledgeDB: db.knowledgeDB,
    convoDB: db.convoDB,
    reviewDB: db.reviewDB,
    reviewNext: db.reviewNext,
    reviewQueueCount: db.reviewQueueCount,
    reviewDelete: db.reviewDelete,
    learn, commitKnowledge,
    buildDigestText,
    saveKnowledgeJSON,
    refreshKnowledgeCache, refreshKnowledgeCacheEmbeddings,
    isGarbage, isFiller, hasMinimumMeaningfulContent
})

/* 5. WhatsApp client — created by a FACTORY so every C3 reconnect gets a
      FRESH client with its handlers rebound (reusing a destroyed client is
      flaky in whatsapp-web.js: 'ready' often never fires again). */
const { Client, LocalAuth } = require("whatsapp-web.js")
const qrcode = require("qrcode-terminal")
const { sleep } = require("./src/util")

function createAndBindClient() {
    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true,
            protocolTimeout: 180000,   // never let a hung WhatsApp-Web call wedge the automation layer
            args: [
                "--no-sandbox", "--disable-setuid-sandbox",
                "--disable-dev-shm-usage", "--disable-accelerated-2d-canvas",
                "--no-first-run", "--no-zygote", "--disable-gpu",
                // Standard headless-hardening set — cuts Chrome RSS ~30-40%
                // and stops background noise. Each flag is individually
                // revertable if WhatsApp Web ever misbehaves (verify at the
                // first live QR launch).
                "--disable-extensions", "--disable-background-networking",
                "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding", "--disable-default-apps", "--disable-sync",
                "--metrics-recording-only", "--no-default-browser-check", "--mute-audio",
                "--disable-features=Translate,OptimizationHints,MediaRouter"
            ]
        }
    })
    state.adminClient = client

    client.on("qr", qr => {
        console.log("\n📱 Scan QR code to connect:\n")
        qrcode.generate(qr, { small: true })
        if (state.hasEverReady) {
            // A QR during a RECONNECT means the session was revoked — a human
            // must scan. Stop the auto-retry ladder (the process stays alive so
            // the terminal QR can still be scanned).
            notifyAdmin("📱 QR scan needed to reconnect — scan the QR in the bot terminal, or restart the bot.")
            reconnect.qrWaiting()
        }
    })

    client.on("ready", async () => {
        state.hasEverReady = true
        reconnect.onReady()   // clear the in-flight guard, reset retries, disarm the watchdog

        const kCount = state.knowledgeCache.length
        console.log("\n╔════════════════════════════════════════════╗")
        console.log(`║  ✅ ${BRAND_NAME.toUpperCase()} READY — v${VERSION}`)
        console.log(`║  Knowledge entries : ${kCount}`)
        console.log("╚════════════════════════════════════════════╝\n")

        try {
            const info = client.info || {}
            if (info.wid) state.selfChatId = `${info.wid.user}@c.us`
            console.log(`🔑 Self-chat resolved: ${state.selfChatId || "(unresolved — admin JID fallback active)"}`)
        } catch (e) {
            console.log("⚠️  Self-chat resolution failed — admin JID fallback active:", e.message)
        }

        if (db.reviewQueueCount() > 0) {
            notifyAdmin(`📋 ${db.reviewQueueCount()} entr${db.reviewQueueCount() === 1 ? "y" : "ies"} waiting for review — use !review`)
        }

        // Deliver any pre-ready protection notices (e.g. "knowledge.json was corrupt → restored")
        for (const notice of drainStartupNotices()) notifyAdmin(notice)
        // Same delivery for settings.json / chat_memory.json protection notices
        for (const notice of drainStateFileNotices()) notifyAdmin(notice)

        // The model now loads at BOOT (see main) — staggered off the
        // Chrome-spawn moment so the startup CPU stays flat. On 'ready' we
        // only fill missing embeddings once the model is up. On a RECONNECT
        // the model is already loaded.
        state.embedReadyPromise.then(() => {
            computeAllMissingEmbeddings().catch(e => console.warn("⚠️  Embedding issue:", e.message))
        })
    })

    client.on("auth_failure", () => {
        console.error("❌ Auth failed. Delete .wwebjs_auth and retry.")
        notifyAdmin("❌ WhatsApp auth failed — delete the .wwebjs_auth folder and restart the bot.")
        reconnect.giveUp("auth_failure")   // no reconnect ladder on a dead session
    })

    client.on("disconnected", reason => {
        console.log(`🔌 Disconnected: ${reason}`)
        if (!state.hasEverReady) {
            // A disconnect before the first 'ready' is a failed STARTUP, not a
            // reconnect case. Fail loudly and visibly, don't wedge.
            console.error("❌ Disconnected BEFORE the first successful connect — startup failed. Restart the bot (node bot.js).")
            notifyAdmin("❌ Bot disconnected during startup — it will exit. Restart it in the terminal.")
            process.exit(1)
        }
        reconnect.onDisconnected(String(reason))
    })

    client.on("message_create", onMessage)
    return client
}

/* 6. C3 reconnect controller wiring. */
reconnect.init({
    state,
    sleep,
    notifyAdmin,
    logError,
    createAndBindClient,
    rebuildIfChanged: async () => {
        // The knowledge DB is NOT rebuilt on reconnect as a rule; this cheap
        // check keeps mid-run hand-edits of knowledge.json live (the V6.4
        // wipe-and-rebuild strategy stays a startup-only cost).
        if (knowledgeJsonChanged()) {
            console.log("🔁 knowledge.json changed on disk since the last build — rebuilding knowledge.db...")
            await buildKnowledgeDB()
        }
    },
    onFatal: reason => {
        console.error(`❌ ${reason} — exiting. Restart the bot with: node bot.js`)
        process.exit(1)
    }
})

/* ══════════════════════════════════════════════════════
   SECTION — GRACEFUL SHUTDOWN

   HOW TO SHUT DOWN THE BOT SAFELY:
   1. In the terminal where the bot runs, press Ctrl+C ONCE.
      → The handler below flushes settings + chat_memory + the
        processed-ID list to disk, closes all 3 SQLite databases,
        destroys the WhatsApp client (kills the hidden Chrome),
        then exits.
      → Wait for "👋 Shutdown complete." before closing the
        terminal window.
   2. Closing the terminal window with the X button does NOT
      run this handler (Windows kills the process tree) —
      it is safe (SQLite is crash-safe) but not clean.
      Prefer Ctrl+C.
══════════════════════════════════════════════════════ */
async function shutdown(signal) {
    if (state.shuttingDown) return
    state.shuttingDown = true
    state.clientActive = false
    console.log(`\n👋 ${signal} received — shutting down gracefully...`)

    try { saveJSON(PATHS.SETTINGS, state.settings) } catch (e) { logError("shutdown", "settings flush failed", e, { quiet: true }) }
    try { saveJSON(PATHS.MEMORY, state.persistentMemory) } catch (e) { logError("shutdown", "chat_memory flush failed", e, { quiet: true }) }
    state.memoryDirty = false
    try { flushProcessedIdsSync() } catch (e) { logError("shutdown", "processed-IDs flush failed", e, { quiet: true }) }
    // Deliver any pending batched notifications before the client dies
    try { flushPendingNotices() } catch (e) { logError("shutdown", "notification batch flush failed", e, { quiet: true }) }
    // The embedding cache flush is debounced — write it before exit
    try { require("./src/embedCache").flushEmbedCache() } catch (e) { logError("shutdown", "embedding-cache flush failed", e, { quiet: true }) }
    const unsentReplies = sendGuard.shutdownReport()
    if (unsentReplies) console.log(`⚠️  ${unsentReplies}`)

    try { if (state.adminClient) await state.adminClient.destroy() } catch (e) { logError("shutdown", "client destroy failed", e, { quiet: true }) }
    /* The dashboard stops BEFORE the databases close — its (future) data
       routes read them, and a short grace period lets in-flight requests
       finish before any straggler socket is forced shut. */
    try { await dashboard.stop() } catch (e) { logError("shutdown", "dashboard stop failed", e, { quiet: true }) }
    try { db.closeAllDatabases() } catch (e) { logError("shutdown", "DB close failed", e, { quiet: true }) }

    console.log("👋 Shutdown complete.")
    process.exit(0)
}

process.on("SIGINT", () => shutdown("Ctrl+C"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGHUP", () => shutdown("SIGHUP"))

/* The common crash class (uncaught exception / unhandled rejection) bypasses
   the graceful shutdown — flush what we can, log it, exit loudly. */
function crashFlushAndExit(kind, err) {
    if (state.shuttingDown) process.exit(1)
    logError("process", `${kind} — best-effort flush then exit`, err)
    try { saveJSON(PATHS.SETTINGS, state.settings) } catch (e) { logError("crash", "settings flush failed", e, { quiet: true }) }
    try { saveJSON(PATHS.MEMORY, state.persistentMemory) } catch (e) { logError("crash", "chat_memory flush failed", e, { quiet: true }) }
    try { flushProcessedIdsSync() } catch (e) { logError("crash", "processed-IDs flush failed", e, { quiet: true }) }
    console.error(`❌ ${kind} — bot is exiting. Details in logs/errors.txt. Restart with: node bot.js`)
    process.exit(1)
}
process.on("uncaughtException", err => crashFlushAndExit("Uncaught exception", err))
process.on("unhandledRejection", err => crashFlushAndExit("Unhandled promise rejection", err))

/* ══════════════════════════════════════════════════════
   MAIN STARTUP SEQUENCE
══════════════════════════════════════════════════════ */
async function main() {
    console.log(`🚀 Starting ${BRAND_NAME} WhatsApp Bot v${VERSION} (modular)...`)
    wipeAllLLMContextsOnStartup()      // V6.5 bug #4 lifecycle (was Section 4)
    restoreConvoMemoryFromDisk()       // was Section 15 module-load
    loadProcessedIds()                 // BEFORE the client connects — redelivered messages must not double-reply
    startConvoMemorySweeper()          // was Section 15 interval
    startLLMCtxSweeper()               // was Section 16 interval
    startBotTextSweeper()              // was Section 32 interval
    startDigestTimer()                 // was Section 34 interval
    startLLMWatchdog()                 // auto-recover the LM Studio connection
    startFlushTimer()                  // 30s dirty-flush (chat_memory + processed-ID compaction + embedding cache)
    startNotifyBatchTimer()            // 5-min coalescing of low-priority admin notices
    runRetentionSweepNow()             // media files >60d deleted; inactive chat_memory users pruned
    startRetentionSweeper()            // hourly check, daily run
    // The embedding model load overlaps the network-idle QR-scan wait,
    // staggered 3s after boot so it never stacks onto the Chrome-spawn moment.
    setTimeout(() => {
        initEmbedder().catch(e => console.warn("⚠️  Model load issue:", e.message))
    }, 3000)
    await buildKnowledgeDB()
    await pingLLMStudio()
    dashboard.start()   // comes up beside the QR-scan wait; never the only path to anything
    createAndBindClient().initialize()
}

main().catch(err => {
    console.error("❌ Fatal startup error:", err)
    process.exit(1)
})
