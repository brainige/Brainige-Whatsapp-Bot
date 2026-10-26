"use strict"
/* src/digest.js — daily 9 PM IST digest, counters in settings.digestState. */

const { DIGEST_HOUR, PATHS, VERSION, saveSettings } = require("./config")
const state = require("./state")
const { istNow } = require("./util")
const { getNumber } = require("./util")
const { logError } = require("./logging")

function bumpDigest(counter, label) {
    try {
        const ds = state.settings.digestState
        if (label) ds.hnCategories[label] = (ds.hnCategories[label] || 0) + 1
        else ds.totals[counter] = (ds.totals[counter] || 0) + 1
        // persist occasionally (not every message — too many writes)
        if ((ds.totals.messages % 20) === 0) saveSettings()
    } catch (e) { logError("digest.bumpDigest", "digest counter update failed", e) }
}

function bumpDigestMessage() {
    state.settings.digestState.totals.messages = (state.settings.digestState.totals.messages || 0) + 1
}

/* Counts messages whose replies were skipped because of a pause/DND
   window, so the daily digest shows the owner what went unanswered. */
function bumpDigestPausedSkip() {
    try {
        const ds = state.settings.digestState
        ds.totals.pausedSkips = (ds.totals.pausedSkips || 0) + 1
    } catch (e) { logError("digest.bumpDigestPausedSkip", "paused-skip counter failed", e) }
}

/* Counts chats the bot stood down in because the owner answered personally —
   the daily digest shows the owner how often they took over. Bumped only on a
   NEW activation, never on an extension of an already-active handoff. */
function bumpDigestHandoff() {
    try {
        const ds = state.settings.digestState
        ds.totals.handoffs = (ds.totals.handoffs || 0) + 1
    } catch (e) { logError("digest.bumpDigestHandoff", "handoff counter failed", e) }
}

/* Counts bot replies the send guard suppressed (identical-text) or
   dropped (over the hourly cap + too old in the queue) — the daily digest shows
   the owner exactly which customers got silence. */
function bumpDigestSendGuard(kind) {
    try {
        const ds = state.settings.digestState
        ds.totals[kind] = (ds.totals[kind] || 0) + 1
    } catch (e) { logError("digest.bumpDigestSendGuard", "send-guard counter failed", e) }
}

function trackNewContact(jid) {
    try {
        const key = getNumber(jid)
        const ds = state.settings.digestState
        if (!ds.newContacts) ds.newContacts = []
        if (ds.newContacts.includes(key)) return
        if (!state.persistentMemory[jid]) ds.newContacts.push(key)
    } catch (e) { logError("digest.trackNewContact", "new-contact tracking failed", e) }
}

function buildDigestText() {
    const ds = state.settings.digestState
    const t = ds.totals || {}
    const total = (t.kbReplies || 0) + (t.llmReplies || 0) + (t.quickReplies || 0)
    const kbRatio = total > 0 ? Math.round(((t.kbReplies || 0) / total) * 100) : 0
    const llmRatio = total > 0 ? 100 - kbRatio : 0
    const topHN = Object.entries(ds.hnCategories || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([label, n]) => `${label} (${n})`).join(", ") || "none"
    return (
        `📈 Daily digest — UTSAB/AVI v${VERSION}\n` +
        `${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}\n\n` +
        `Messages handled : ${t.messages || 0}\n` +
        `Replies sent    : ${total} (KB ${kbRatio}% / LLM ${llmRatio}%)\n` +
        `  • KB hits     : ${t.kbReplies || 0}\n` +
        `  • LLM         : ${t.llmReplies || 0}\n` +
        `  • Quick       : ${t.quickReplies || 0}\n` +
        `Human-needed    : ${Object.values(ds.hnCategories || {}).reduce((s, n) => s + n, 0)}\n` +
        `Paused/DND skips: ${t.pausedSkips || 0}\n` +
        `Owner handoffs  : ${t.handoffs || 0}\n` +
        `Guarded (H)     : ${t.identicalSuppressed || 0} identical-suppressed / ${t.rateDropped || 0} rate-capped drops\n` +
        `Top HN triggers : ${topHN}\n` +
        `New contacts    : ${(ds.newContacts || []).length}`
    )
}

function pushDigestIfDue() {
    const now = istNow()
    if (now.hour !== DIGEST_HOUR || now.minute >= 5) return  // small 5-min window
    const ds = state.settings.digestState
    const today = new Date().toISOString().substring(0, 10)
    if (ds.lastDigestISO && ds.lastDigestISO.substring(0, 10) === today) return
    notifyAdminForDigest(buildDigestText())
    ds.lastDigestISO = new Date().toISOString()
    ds.totals = { messages: 0, kbReplies: 0, llmReplies: 0, quickReplies: 0, pausedSkips: 0 }
    ds.hnCategories = {}
    ds.newContacts = []
    saveSettings()
}

// local import to avoid circular dependency (digest ← notify)
function notifyAdminForDigest(text) {
    try { require("./notify").notifyAdmin(text) } catch (e) { logError("digest.notifyAdminForDigest", "digest notify failed", e, { quiet: true }) }
}

function startDigestTimer() {
    setInterval(() => { try { pushDigestIfDue() } catch (e) { logError("digest.startDigestTimer", "digest push failed", e, { quiet: true }) } }, 60000)
}

module.exports = { bumpDigest, bumpDigestMessage, bumpDigestPausedSkip, bumpDigestHandoff, bumpDigestSendGuard, trackNewContact, buildDigestText, pushDigestIfDue, startDigestTimer }
