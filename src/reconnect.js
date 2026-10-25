"use strict"
/* src/reconnect.js — safe reconnect controller.

   Old behavior: on 'disconnected' → rebuild the whole
   knowledge DB + client.initialize() on the SAME (possibly zombie) client,
   with no guard, retries reset before 'ready' fired, and the model reloaded
   on every ready. That could double the hidden browser (ban risk), wipe the
   DB mid-message, and wedge the bot dead.

   New behavior:
   - ONE reconnect chain at a time (single-flight guard).
   - client.destroy() raced against a timeout — a hung destroy never wedges
     the chain; on timeout we log it and continue anyway.
   - A FRESH Client is created for every reconnect (rebinding all handlers)
     — reusing a destroyed instance is flaky in whatsapp-web.js ('ready'
     often never fires again).
   - knowledge.db is NOT rebuilt on reconnect unless knowledge.json actually
     changed on disk (hand-edits stay live; see knowledge.knowledgeJsonChanged).
   - The retry counter resets only inside 'ready'; a 90s watchdog counts a
     silent initialize as a failed attempt; a QR during reconnect means a
     human must scan — the ladder stops and the watchdog is disarmed.
   - Disconnects BEFORE the first 'ready' are startup failures (handled in
     bot.js), not reconnect cases. */

const { RECONNECT_MAX_RETRIES, RECONNECT_BASE_DELAY_MS, DESTROY_TIMEOUT_MS, READY_WATCHDOG_MS } = require("./config")

let deps = null
let inFlight = false
let awaitingReady = false
let pendingDisconnect = false
let expectDestroyDisconnect = false
let watchdogTimer = null

function init(d) { deps = d }

async function destroyWithTimeout(client) {
    if (!client || typeof client.destroy !== "function") return
    const timeoutMs = (deps && deps.DESTROY_TIMEOUT_MS) || DESTROY_TIMEOUT_MS
    expectDestroyDisconnect = true
    try {
        await Promise.race([
            client.destroy(),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`destroy() timed out after ${timeoutMs}ms (zombie browser?)`)),
                timeoutMs
            ))
        ])
    } catch (e) {
        if (deps) deps.logError("reconnect.destroy", "old client destroy failed/timed out — continuing with a fresh client", e)
    }
}

async function attemptReconnect(reason) {
    if (!deps) return
    const st = deps.state
    if (!st.clientActive || inFlight) return

    if (st.reconnectAttempts >= RECONNECT_MAX_RETRIES) {
        try { deps.notifyAdmin(`❌ Reconnect failed after ${RECONNECT_MAX_RETRIES} attempts (${reason}). The bot will exit — restart it with: node bot.js`) } catch (e) { deps.logError("reconnect.attemptReconnect", "exhaustion notify failed", e, { quiet: true }) }
        deps.onFatal(`Reconnect attempts exhausted (${reason})`)
        return
    }

    inFlight = true
    st.reconnectAttempts++
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, st.reconnectAttempts - 1)
    console.log(`🔁 Disconnect (${reason}). Reconnect attempt ${st.reconnectAttempts}/${RECONNECT_MAX_RETRIES} in ${delay / 1000}s...`)
    try {
        await deps.sleep(delay)
        await destroyWithTimeout(st.adminClient)
        await deps.rebuildIfChanged()
        console.log("🚀 Creating a FRESH WhatsApp client (never reuse a destroyed one)...")
        const fresh = deps.createAndBindClient()
        awaitingReady = true
        await fresh.initialize()
        armReadyWatchdog()
        // inFlight stays held until 'ready' (onReady) or the watchdog fires.
    } catch (e) {
        deps.logError("reconnect.attempt", `reconnect attempt failed: ${e.message}`, e)
        awaitingReady = false
        inFlight = false
        attemptReconnect("previous attempt errored")
    }
}

function armReadyWatchdog() {
    disarmReadyWatchdog()
    const ms = (deps && deps.READY_WATCHDOG_MS) || READY_WATCHDOG_MS
    watchdogTimer = setTimeout(() => {
        if (awaitingReady) {
            console.warn(`⚠️  No 'ready' event within ${ms / 1000}s of the reconnect — treating as a failed attempt.`)
            awaitingReady = false
            inFlight = false
            attemptReconnect("ready-watchdog timeout")
        }
    }, ms)
}

function disarmReadyWatchdog() {
    if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
}

function onReady() {
    if (!deps) return
    const st = deps.state
    st.clientActive = true
    if (st.reconnectAttempts > 0 || inFlight) console.log("✅ Reconnected successfully — retry counter reset.")
    inFlight = false
    awaitingReady = false
    pendingDisconnect = false
    disarmReadyWatchdog()
    st.reconnectAttempts = 0
}

function onDisconnected(reason) {
    if (expectDestroyDisconnect) { expectDestroyDisconnect = false; return }   // our own destroy() fired it
    if (inFlight) {
        pendingDisconnect = true
        console.log(`🔌 Disconnect seen during a reconnect (${reason}) — noted; 'ready' will clear it.`)
        return
    }
    attemptReconnect(reason)
}

/* A QR appeared during a reconnect: the session needs a human scan. Stop the
   auto-retry ladder and disarm the watchdog so it doesn't tear down the QR
   the user is about to scan. If they scan, 'ready' (onReady) resets everything. */
function qrWaiting() {
    console.log("⏸ Reconnect paused: waiting for a human to scan the QR code (watchdog disarmed).")
    disarmReadyWatchdog()
    awaitingReady = false
    inFlight = false
}

/* Permanently stop reconnecting (auth failure etc.). */
function giveUp(reason) {
    inFlight = false
    awaitingReady = false
    pendingDisconnect = false
    disarmReadyWatchdog()
    if (deps) deps.state.clientActive = false
    console.error(`🛑 Reconnect chain stopped (${reason}).`)
}

module.exports = { init, attemptReconnect, onReady, onDisconnected, qrWaiting, giveUp }
