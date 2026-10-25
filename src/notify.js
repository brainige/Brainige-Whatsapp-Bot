"use strict"
/* src/notify.js — admin console: self-chat channel, notifications, admin checks.
   LOW-priority notifications now coalesce into one summary per category,
   flushed every NOTIFY_BATCH_MS (and on shutdown) — each notification is
   itself an outbound WhatsApp message, and the old
   one-message-per-link-check / per-media-message / per-review-entry flow
   flooded the only control channel.
   Safety-critical messages (unsafe links, auth failures, corruption alerts,
   QR needed, pause triggers, digest) stay on notifyAdmin = immediate. */

const state = require("./state")
const { ADMIN, NOTIFY_BATCH_MS, NOTIFY_BATCH_MAX_LINES } = require("./config")
const { logAdminActivity, logError } = require("./logging")
const { preRegisterBotText, trackBotReply } = require("./tracking")

function isAdminChannel(user, message) {
    if (message && message.fromMe) {
        const chat = message.to || message.from
        if (state.selfChatId && chat === state.selfChatId) return true
    }
    if (ADMIN && user === ADMIN) return true
    return false
}

function sendNow(text) {
    logAdminActivity(`[NOTIFY] ${text}`)
    if (!(state.adminClient && state.selfChatId)) return true   // no client yet → treated as delivered
    try {
        preRegisterBotText(text)
        state.adminClient.getChatById(state.selfChatId)
            .then(chat => chat.sendMessage(text))
            .then(sent => trackBotReply(sent, text))
            .catch(e => logError("notify.sendNow", "admin message send failed", e, { quiet: true }))
        return true
    } catch (e) {
        logError("notify.sendNow", "admin send setup failed", e, { quiet: true })
        return false
    }
}

function notifyAdmin(text) { sendNow(text) }

/* Coalesced low-priority notification — merged into ONE message per
   category by the batch timer / shutdown. The full line still reaches the
   admin log immediately (audit trail), only the WhatsApp send waits. */
const batched = new Map()      // category label -> [text lines]
const BATCH_KEEP_MAX = 50      // never let a category grow unbounded

function notifyAdminBatched(category, text) {
    logAdminActivity(`[NOTIFY-QUEUED ${category}] ${text}`)
    if (!batched.has(category)) batched.set(category, [])
    const lines = batched.get(category)
    if (lines.length < BATCH_KEEP_MAX) lines.push(String(text).substring(0, 200))
}

function flushPending() {
    for (const [category, lines] of batched) {
        if (lines.length === 0) continue
        const shown = lines.slice(0, NOTIFY_BATCH_MAX_LINES)
        const more = lines.length - shown.length
        const summary =
            `📬 ${category} — ${lines.length} in the last ${Math.round(NOTIFY_BATCH_MS / 60000)} min:\n` +
            shown.join("\n") + (more > 0 ? `\n… +${more} more` : "")
        if (sendNow(summary)) batched.set(category, [])   // sent (or no client) → clear; a FAILED send keeps the lines for the next flush
    }
}

function startNotifyBatchTimer() {
    setInterval(() => {
        try { flushPending() } catch (e) { logError("notify.startNotifyBatchTimer", "batch flush failed", e, { quiet: true }) }
    }, NOTIFY_BATCH_MS)
}

module.exports = { isAdminChannel, notifyAdmin, notifyAdminBatched, flushPending, startNotifyBatchTimer }
