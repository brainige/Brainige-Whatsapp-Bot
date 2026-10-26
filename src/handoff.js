"use strict"
/* src/handoff.js — human handoff: when the owner replies to a customer from
   their own phone, the bot stands down for that chat — it stops auto-replying
   while the owner handles the conversation. The window slides: every new owner
   reply re-anchors the expiry to "now + window" (it never accumulates), and
   once it lapses the bot resumes auto-replying on its own.

   Nothing here is persisted — a restart forgets any active handoffs. That is
   the safe default: the bot goes back to answering rather than staying quiet
   for a conversation a human already left.
   The window is read from config on every call (not cached at load) so the
   test knob can shrink it. */

const config = require("./config")
const state = require("./state")

/* Test knob, same shape as vtInitForTests in security.js. Production always
   uses config.HANDOFF_WINDOW_MS; an explicit override (tests only) wins.
   Read dynamically by currentWindowMs() so a live change takes effect. */
let windowOverrideMs = null
function setHandoffWindowForTests(ms) { windowOverrideMs = ms }

function currentWindowMs() {
    return typeof windowOverrideMs === "number" ? windowOverrideMs : config.HANDOFF_WINDOW_MS
}

/* Truthy while the stand-down expiry is still in the future. An expired entry
   is deleted on the way out, so the map can never grow without bound. */
function isHandoffActive(chatId) {
    const until = state.handoffUntil.get(chatId)
    if (!until) return false
    if (Date.now() >= until) { state.handoffUntil.delete(chatId); return false }
    return true
}

/* Re-anchors the stand-down to now + the current window (sliding). Returns
   true only when this call NEWLY activated the chat (it was inactive or had
   already expired); an extension of an already-active handoff returns false.
   The caller keys the digest counter off that signal. */
function activateHandoff(chatId) {
    const wasActive = isHandoffActive(chatId)   // also prunes a stale expired entry
    state.handoffUntil.set(chatId, Date.now() + currentWindowMs())
    return !wasActive
}

/* Milliseconds left on the stand-down, 0 when inactive. Lazily deletes an
   expired entry it steps over. */
function handoffRemainingMs(chatId) {
    const until = state.handoffUntil.get(chatId)
    if (!until) return 0
    const left = until - Date.now()
    if (left <= 0) { state.handoffUntil.delete(chatId); return 0 }
    return left
}

module.exports = { activateHandoff, isHandoffActive, handoffRemainingMs, setHandoffWindowForTests }
