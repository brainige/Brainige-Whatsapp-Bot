"use strict"
/* test/handoff_test.js — human handoff: when the owner answers a customer
   from their own phone the bot stands down for that chat, and auto-replies
   resume once the (sliding) window lapses. Covers:
   - a chat is inactive by default
   - activate → active; the first activation reports "newly activated"
   - re-activating an active chat EXTENDS the window (it slides from now, it
     never accumulates) and reports "not a new activation"
   - expiry → inactive again, with lazy cleanup of the map entry
   - remaining-ms counts down
   - the digest counter bumps only on a NEW activation, never on an extension
   Stubs isolate WhatsApp. Project files snapshotted + restored, the in-memory
   counter map and digest counters restored, nothing left in memory/ or logs/. */

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

process.env.ADMIN = "handofftest_admin@c.us"

const ACT_USER = "0000000001@c.us"   // activation / extension
const EXT_USER = "0000000002@c.us"   // sliding window
const EXP_USER = "0000000003@c.us"   // expiry + lazy cleanup (isHandoffActive path)
const EXP_USER2 = "0000000004@c.us"  // lazy cleanup (handoffRemainingMs path)
const REM_USER = "0000000005@c.us"   // remaining-ms countdown
const DG_USER  = "0000000006@c.us"   // digest counter wiring
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

    const state = require("../src/state")
    const handoff = require("../src/handoff")
    const digest = require("../src/digest")

    /* ── 1. inactive by default ── */
    console.log("\n── 1. inactive by default ──")
    check("a fresh chat is not handed off", handoff.isHandoffActive(ACT_USER) === false)
    check("remaining ms is 0 when inactive", handoff.handoffRemainingMs(ACT_USER) === 0)
    check("no handoff map entry exists for a fresh chat", state.handoffUntil.has(ACT_USER) === false)

    /* ── 2. activate → active ── */
    console.log("\n── 2. activate → active ──")
    handoff.setHandoffWindowForTests(1000)
    check("the first activation reports it as newly activated", handoff.activateHandoff(ACT_USER) === true)
    check("the chat is now active", handoff.isHandoffActive(ACT_USER) === true)
    check("remaining ms is within the window", (() => {
        const r = handoff.handoffRemainingMs(ACT_USER)
        return r > 0 && r <= 1000
    })())

    /* ── 3. re-activate EXTENDS (sliding window) ── */
    console.log("\n── 3. re-activate extends the window (sliding) ──")
    handoff.setHandoffWindowForTests(10000)
    handoff.activateHandoff(EXT_USER)          // fresh activation
    await sleep(150)                           // let a little time pass
    const decayed = handoff.handoffRemainingMs(EXT_USER)   // remaining BEFORE the extension
    const second = handoff.activateHandoff(EXT_USER)       // owner replies again → slide
    const extended = handoff.handoffRemainingMs(EXT_USER)  // remaining AFTER the extension
    check("re-activating an active chat reports NOT a new activation", second === false)
    check("the extension pushes the expiry back out (remaining ms goes UP)", extended > decayed)

    // Sliding means "now + window" — never "old expiry + window" (which would
    // accumulate). Shrink the window and re-activate: the remaining time tracks
    // the NEW window, proving the deadline is re-anchored to now.
    handoff.setHandoffWindowForTests(5000)
    handoff.activateHandoff(EXT_USER)                 // remaining ≈ 5000
    handoff.setHandoffWindowForTests(1000)            // shrink the window
    handoff.activateHandoff(EXT_USER)                 // slide: now + 1000
    const slid = handoff.handoffRemainingMs(EXT_USER) // ≈ 1000, never 5000 (frozen) or 6000 (accumulated)
    check("re-activating re-anchors to now (sliding, not accumulating the old window)", slid > 500 && slid <= 1000)

    /* ── 4. expiry → inactive again + lazy cleanup ── */
    console.log("\n── 4. expiry → inactive again + lazy cleanup ──")
    handoff.setHandoffWindowForTests(30)              // 30ms window (tiny — no real 30-min wait)
    handoff.activateHandoff(EXP_USER)
    await sleep(60)                                   // past the expiry
    check("an expired entry lingers in the map until something reads it (lazy, no timer)", state.handoffUntil.has(EXP_USER) === true)
    check("isHandoffActive returns false once expired", handoff.isHandoffActive(EXP_USER) === false)
    check("isHandoffActive lazily deleted the expired entry", state.handoffUntil.has(EXP_USER) === false)

    handoff.setHandoffWindowForTests(30)
    handoff.activateHandoff(EXP_USER2)
    await sleep(60)
    check("handoffRemainingMs returns 0 once expired", handoff.handoffRemainingMs(EXP_USER2) === 0)
    check("handoffRemainingMs lazily deleted the expired entry", state.handoffUntil.has(EXP_USER2) === false)

    /* ── 5. remaining-ms decreases ── */
    console.log("\n── 5. remaining-ms decreases ──")
    handoff.setHandoffWindowForTests(200)
    handoff.activateHandoff(REM_USER)
    const r1 = handoff.handoffRemainingMs(REM_USER)
    await sleep(60)
    const r2 = handoff.handoffRemainingMs(REM_USER)
    check("remaining ms counts down over time", r2 < r1)

    /* ── 6. digest counter bumps only on new activation, not on extension ── */
    console.log("\n── 6. digest counter: new activation only ──")
    const dsBefore = JSON.parse(JSON.stringify(state.settings.digestState || {}))
    const base = (dsBefore.totals && dsBefore.totals.handoffs) || 0
    handoff.setHandoffWindowForTests(1000)
    // The handler wires it exactly like this: bump only when activateHandoff
    // reports a NEW activation.
    if (handoff.activateHandoff(DG_USER)) digest.bumpDigestHandoff()
    check("a new activation bumps the handoff digest counter", (state.settings.digestState.totals.handoffs || 0) === base + 1)
    if (handoff.activateHandoff(DG_USER)) digest.bumpDigestHandoff()   // extension → returns false → no bump
    check("an extension does NOT bump the digest counter", (state.settings.digestState.totals.handoffs || 0) === base + 1)
    check("the digest text shows the owner-handoff line", digest.buildDigestText().includes("Owner handoffs"))
    state.settings.digestState = dsBefore   // restore in-memory counters (the file is restored at cleanup)

    /* ── cleanup: leave the project pristine ── */
    console.log("\n── cleanup ──")
    state.handoffUntil.clear()
    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)
    check("cleanup done (map cleared, files restored)", state.handoffUntil.size === 0)

    console.log("\n═══════════════════════════════")
    console.log(`HANDOFF TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("HANDOFF TEST CRASHED:", e); process.exit(1) })
