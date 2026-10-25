"use strict"
/* src/tracking.js — dedup set (persisted to disk so restarts don't
   double-reply), last-message map, bot-sent text/ID tracking.

   Every processed message ID is appended IMMEDIATELY to
   memory/processed_ids.jsonl (a ~40-byte async append — nothing like the
   full-file rewrites C4 removed), so even a hard crash loses nothing.
   On boot the file is loaded (IDs older than 48h are dropped); the file
   is compacted back to the hard cap once it grows too big. */

const fs = require("fs-extra")
const path = require("path")

const state = require("./state")
const { LAST_MSG_TTL, PATHS, PROCESSED_ID_MAX_AGE_MS, PROCESSED_ID_HARD_CAP, PROCESSED_ID_COMPACT_AT, BOT_SENT_ID_TTL_MS } = require("./config")
const { logError } = require("./logging")

let processedOrder = []   // [{id, ts}] in insertion order (mirrors the jsonl file)
let compactPending = false

function markProcessed(id) {
    if (!id) return
    if (!state.processed.has(id)) {
        state.processed.add(id)
        processedOrder.push({ id, ts: Date.now() })
        // Crash-safe — the ID reaches the disk the moment it's processed.
        fs.promises.appendFile(PATHS.PROCESSED_IDS, `${Date.now()} ${id}\n`)
            .catch(e => logError("tracking.markProcessed", "processed-id append failed", e))
        if (processedOrder.length >= PROCESSED_ID_COMPACT_AT) compactPending = true
    }
    if (state.processed.size > PROCESSED_ID_HARD_CAP) {
        const oldest = state.processed.values().next().value
        state.processed.delete(oldest)
    }
}

function loadProcessedIds() {
    try {
        if (!fs.existsSync(PATHS.PROCESSED_IDS)) {
            console.log("🧠 No processed-ID file yet — starting fresh.")
            return
        }
        const cutoff = Date.now() - PROCESSED_ID_MAX_AGE_MS
        const raw = fs.readFileSync(PATHS.PROCESSED_IDS, "utf8")
        const keep = []
        for (const line of raw.split("\n")) {
            const m = line.match(/^(\d+)\s+(\S+)$/)
            if (!m) continue
            const ts = Number(m[1])
            if (!Number.isFinite(ts) || ts < cutoff) continue
            keep.push({ id: m[2], ts })
        }
        const trimmed = keep.slice(-PROCESSED_ID_HARD_CAP)
        state.processed = new Set(trimmed.map(e => e.id))
        processedOrder = trimmed
        if (processedOrder.length >= PROCESSED_ID_COMPACT_AT) compactPending = true
        console.log(`🧠 Processed-ID memory restored — ${trimmed.length} IDs (<48h old).`)
    } catch (e) {
        logError("tracking.loadProcessedIds", "processed-ID file unreadable — starting empty", e)
    }
}

/* Rewrites the jsonl from the in-memory list: prunes >48h, caps at the hard
   limit, keeps file and memory in sync. No-op unless a compaction is due,
   so the 30s timer costs nothing on a quiet bot. On failure the pending
   flag stays set and the next timer tick retries. */
async function compactProcessedIds() {
    if (!compactPending) return
    try {
        const cutoff = Date.now() - PROCESSED_ID_MAX_AGE_MS
        const keep = processedOrder.filter(e => e.ts >= cutoff).slice(-PROCESSED_ID_HARD_CAP)
        const tmp = PATHS.PROCESSED_IDS + ".tmp"
        fs.ensureDirSync(path.dirname(PATHS.PROCESSED_IDS))
        await fs.promises.writeFile(tmp, keep.map(e => `${e.ts} ${e.id}`).join("\n") + (keep.length ? "\n" : ""))
        await fs.promises.rename(tmp, PATHS.PROCESSED_IDS)
        processedOrder = keep
        state.processed = new Set(keep.map(e => e.id))
        compactPending = false
    } catch (e) {
        logError("tracking.compactProcessedIds", "processed-ID compaction failed (will retry next tick)", e)
    }
}

/* Shutdown / crash-hook path: always writes the current list synchronously. */
function flushProcessedIdsSync() {
    try {
        const cutoff = Date.now() - PROCESSED_ID_MAX_AGE_MS
        const keep = processedOrder.filter(e => e.ts >= cutoff).slice(-PROCESSED_ID_HARD_CAP)
        fs.ensureDirSync(path.dirname(PATHS.PROCESSED_IDS))
        const tmp = PATHS.PROCESSED_IDS + ".tmp"
        fs.writeFileSync(tmp, keep.map(e => `${e.ts} ${e.id}`).join("\n") + (keep.length ? "\n" : ""))
        fs.moveSync(tmp, PATHS.PROCESSED_IDS, { overwrite: true })
        processedOrder = keep
        state.processed = new Set(keep.map(e => e.id))
        compactPending = false
    } catch (e) {
        logError("tracking.flushProcessedIdsSync", "sync processed-ID flush failed", e)
    }
}

// test hook: simulate a fresh process
function _resetProcessedForTests() {
    state.processed = new Set()
    processedOrder = []
    compactPending = false
}

function preRegisterBotText(replyText) {
    if (!replyText) return
    state.botSentTexts.set(replyText.trim(), Date.now() + 10000)
}

function trackBotReply(sentMsg, replyText) {
    if (sentMsg && sentMsg.id) state.botSentIds.set(sentMsg.id._serialized, Date.now() + BOT_SENT_ID_TTL_MS)   // Map id→expiry (was an unswept Set)
    if (replyText) {
        state.botSentTexts.set(replyText.trim(), Date.now() + 10000)
    }
}

function isBotSentText(text) {
    if (!text) return false
    const t = text.trim()
    const exp = state.botSentTexts.get(t)
    if (exp === undefined) return false
    if (Date.now() > exp) { state.botSentTexts.delete(t); return false }
    return true
}

function sweepBotSentTracking() {
    const now = Date.now()
    for (const [t, exp] of state.botSentTexts) if (now > exp) state.botSentTexts.delete(t)
    for (const [id, exp] of state.botSentIds) if (now > exp) state.botSentIds.delete(id)   // the Set never shrank before
}

function startBotTextSweeper() { setInterval(sweepBotSentTracking, 30000) }

function getLastMessage(jid) {
    const entry = state.lastMessageMap.get(jid)
    if (!entry) return null
    if (Date.now() - entry.ts > LAST_MSG_TTL) { state.lastMessageMap.delete(jid); return null }
    return entry.msg
}

function setLastMessage(jid, msg) {
    state.lastMessageMap.set(jid, { msg, ts: Date.now() })
}

module.exports = {
    markProcessed, loadProcessedIds, compactProcessedIds, flushProcessedIdsSync, _resetProcessedForTests,
    preRegisterBotText, trackBotReply, isBotSentText, startBotTextSweeper, sweepBotSentTracking,
    getLastMessage, setLastMessage
}
