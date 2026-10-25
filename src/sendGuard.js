"use strict"
/* src/sendGuard.js — outbound send guard.
   Bounds the bot's outbound VOLUME: a jittered minimum gap between sends, an
   hourly cap with a queue (queued replies older than
   SEND_QUEUE_MAX_AGE_MS are dropped + logged, never silently), and identical-
   text suppression per chat.
   The owner DELIBERATELY kept instant replies, the QUICK REPLY prefix and no
   read receipts (decision 2026-10-23) — this module changes nothing about the
   reply CONTENT or the normal-case speed (the first reply in an idle window
   still goes out immediately). Admin/self-chat sends bypass the guard
   entirely: the control channel must never be throttled.
   */

const { sleep } = require("./util")
const { logError } = require("./logging")
const {
    SEND_MIN_GAP_MS_MIN, SEND_MIN_GAP_MS_MAX, SEND_HOURLY_CAP, SEND_CAP_WINDOW_MS,
    SEND_QUEUE_MAX_AGE_MS, IDENTICAL_TEXT_HOUR_CAP
} = require("./config")

/* Test-injectable knobs (same pattern as reconnect.js init): tests pass tiny
   values so pacing/caps are testable in milliseconds. Production reads the
   config tunables above. */
let knobs = {
    gapMinMs: SEND_MIN_GAP_MS_MIN,
    gapMaxMs: SEND_MIN_GAP_MS_MAX,
    hourlyCap: SEND_HOURLY_CAP,
    capWindowMs: SEND_CAP_WINDOW_MS,
    queueMaxAgeMs: SEND_QUEUE_MAX_AGE_MS,
    identicalHourCap: IDENTICAL_TEXT_HOUR_CAP,
}
function init(overrides) { if (overrides) Object.assign(knobs, overrides) }

let sendTimes = []          // timestamps of actual sends inside the cap window
let lastSendAt = 0
let identicalLog = new Map()   // `${chat}|${text}` -> [sent timestamps]
const pending = []            // [{ chatId, text, enqueueAt, run }]
let pumping = false
const PUMP_RETRY_MS = 5000

/* Drop events are reported through an injected logger (wired by handler.js to
   the digest counters + a batched admin notice) — a customer getting silence
   is always visible to the owner, never silent. */
let dropLogger = null
function initDropLogger(fn) { dropLogger = fn }
function reportDrop(evt) { if (dropLogger) { try { dropLogger(evt) } catch (e) { logError("sendGuard.reportDrop", "drop-event reporting failed", e) } } }

function pruneSends() {
    const cutoff = Date.now() - knobs.capWindowMs
    while (sendTimes.length > 0 && sendTimes[0] < cutoff) sendTimes.shift()
}
function hourCount() { pruneSends(); return sendTimes.length }

function identKey(chatId, text) { return `${chatId}|${String(text || "").trim().toLowerCase()}` }
function identicalSentCount(chatId, text) {
    const k = identKey(chatId, text)
    const arr = identicalLog.get(k) || []
    const cutoff = Date.now() - knobs.capWindowMs
    const live = arr.filter(ts => ts >= cutoff)
    if (live.length === 0) identicalLog.delete(k)
    else identicalLog.set(k, live)
    return live.length
}
function identicalQueuedCount(chatId, text) {
    const k = identKey(chatId, text)
    return pending.filter(t => identKey(t.chatId, t.text) === k).length
}
function recordIdentical(chatId, text) {
    const k = identKey(chatId, text)
    const arr = identicalLog.get(k) || []
    arr.push(Date.now())
    identicalLog.set(k, arr)
}

/* The single entry point for customer replies. `run` performs the ACTUAL send
   plus ALL post-send bookkeeping (log rows, DB writes, digest counters) so a
   queued or dropped reply leaves the conversation record and counters
   truthful — nothing is logged as sent until it really is. */
function guardCustomerReply(chatId, text, run) {
    if (identicalSentCount(chatId, text) + identicalQueuedCount(chatId, text) >= knobs.identicalHourCap) {
        reportDrop({ chatId, text, reason: "identical_suppressed" })
        return { sent: false, reason: "identical_suppressed", queued: false }
    }
    pending.push({ chatId, text, enqueueAt: Date.now(), run })
    pump()
    return { sent: false, reason: "queued_or_sending", queued: true }
}

/* One runner: sends what fits (cap + gap), drops what expired, and re-arms a
   short retry timer for whatever must wait for cap capacity. */
async function pump() {
    if (pumping) return
    pumping = true
    try {
        while (pending.length > 0) {
            const task = pending[0]
            if (Date.now() - task.enqueueAt > knobs.queueMaxAgeMs) {
                pending.shift()
                reportDrop({ chatId: task.chatId, text: task.text, reason: "queue_stale_drop" })
                continue
            }
            if (hourCount() >= knobs.hourlyCap) break   // wait for capacity (retry timer below)
            const gap = knobs.gapMinMs + Math.random() * Math.max(0, knobs.gapMaxMs - knobs.gapMinMs)
            const wait = Math.max(0, lastSendAt + gap - Date.now())
            if (wait > 0) await sleep(wait)
            if (hourCount() >= knobs.hourlyCap) break   // re-check after the sleep
            pending.shift()
            lastSendAt = Date.now()
            sendTimes.push(lastSendAt)
            recordIdentical(task.chatId, task.text)
            try { await task.run() } catch (e) { logError("sendGuard.pump", "one queued reply failed to send", e) }
        }
    } finally {
        pumping = false
    }
    if (pending.length > 0) setTimeout(() => { pump().catch(() => { }) }, PUMP_RETRY_MS)
}

/* Shutdown: report queued-but-unsent replies so the owner knows. */
function shutdownReport() {
    if (pending.length === 0) return null
    return `${pending.length} queued bot replies were discarded on shutdown (they had not been sent yet).`
}

function pendingCount() { return pending.length }
function sentCount() { return hourCount() }
function _resetForTests() {
    sendTimes = []
    lastSendAt = 0
    identicalLog = new Map()
    pending.length = 0
    pumping = false
}

module.exports = {
    init, initDropLogger, guardCustomerReply, pump,
    pendingCount, sentCount, shutdownReport, _resetForTests
}
