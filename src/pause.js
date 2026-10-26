"use strict"
/* src/pause.js — per-chat pause, global pause, DND quiet hours (Asia/Kolkata). */

const { CONVO_TTL, TOPIC_SHIFT_TTL, PAUSE_NAMES } = require("./config") // CONVO_TTL/TOPIC_SHIFT_TTL re-exported for compatibility
const { saveSettings } = require("./config")
const state = require("./state")
const { getNumber, istNow, parseHHMM } = require("./util")

/* The address-by-name trigger words come from config (PAUSE_NAMES in .env,
   default: utsab,avi). Each name is escaped so nothing regex-special in a
   custom name can break the pattern. An empty PAUSE_NAMES disables the
   trigger entirely. */
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
let pauseNameStartRe = null
let pauseNameAnyRe = null
function rebuildPauseNames(names) {
    const list = (names === null || names === undefined ? PAUSE_NAMES : names)
        .map(s => String(s).trim().toLowerCase()).filter(Boolean)
    if (list.length === 0) { pauseNameStartRe = null; pauseNameAnyRe = null; return }
    const alts = list.map(escapeRe).join("|")
    pauseNameStartRe = new RegExp(`^(${alts})\\b`, "i")
    pauseNameAnyRe = new RegExp(`\\b(${alts})\\b`, "i")
}
function setPauseNamesForTests(names) { rebuildPauseNames(names) }
rebuildPauseNames()

function getPauseDuration(jid) {
    if (jid && state.settings.customPauseDurations && state.settings.customPauseDurations[jid]) {
        return Number(state.settings.customPauseDurations[jid]) * 1000
    }
    return 60000
}

/* Pause fires only when the message is genuinely ADDRESSED to the
   bot/human: it starts with the name, or is a very short message (≤4 words)
   containing it. Known trade-off: a third-person sentence that
   merely STARTS with the name ("utsab said the price is 500") still pauses
   — every pause is visible to the admin via notification, so real traffic
   can guide later tightening. Groups are NEVER muted by this rule (one
   member's sentence must not silence a whole group); the group
   mention-engagement rule in the handler is a separate, unchanged feature.
   While a pause is active it can NOT be re-triggered or extended — the old
   behavior let a contact hold a chat muted forever by prefixing every
   message with the name. */
function checkAndTriggerPause(jid, msg) {
    if (!jid || jid.endsWith("@g.us")) return false          // DM-only
    if (isUserPaused(jid)) return false                       // active pause: no extension, no re-notify
    const text = String(msg || "").trim()                     // media captions can be absent
    if (!text) return false
    if (!pauseNameStartRe) return false               // no trigger names configured
    const startsWithName = pauseNameStartRe.test(text)
    const words = text.split(/\s+/).filter(Boolean)
    const shortWithName = words.length <= 4 && pauseNameAnyRe.test(text)
    if (!startsWithName && !shortWithName) return false
    const dur = getPauseDuration(jid)
    state.pauseMap.set(jid, Date.now() + dur)
    console.log(`⏸  Replies paused for ${getNumber(jid)} (${Math.round(dur / 1000)}s) — logging & learning continue`)
    return true
}

function isUserPaused(jid) {
    const until = state.pauseMap.get(jid)
    if (!until) return false
    if (Date.now() > until) { state.pauseMap.delete(jid); return false }
    return true
}

function isGloballyPaused() { return Date.now() < state.globalPauseUntil }

function setGlobalPause(until) {
    state.globalPauseUntil = until
    state.settings.globalPauseUntil = until
    saveSettings()
}

function isInDND() {
    if (!state.settings.dndSchedule || !state.settings.dndSchedule.enabled) return false
    const start = parseHHMM(state.settings.dndSchedule.start)
    const end = parseHHMM(state.settings.dndSchedule.end)
    if (start === null || end === null) return false
    const now = istNow()
    const cur = now.hour * 60 + now.minute
    if (start === end) return false
    if (start < end) return cur >= start && cur < end          // same-day window
    return cur >= start || cur < end                            // overnight window
}

module.exports = { getPauseDuration, checkAndTriggerPause, isUserPaused, isGloballyPaused, setGlobalPause, isInDND, setPauseNamesForTests }
