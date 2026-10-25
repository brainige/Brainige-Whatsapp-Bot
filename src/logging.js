"use strict"
/* src/logging.js — chat/group log files, HN log, admin log, 6-month cap. */

const fs = require("fs-extra")
const path = require("path")

const { PATHS } = require("./config")
const { getNumber } = require("./util")

const LOG_AGE_CAP_MS = 6 * 30 * 24 * 60 * 60 * 1000 // ~6 months

function logDirFor(jid) {
    return jid.endsWith("@g.us") ? PATHS.LOG_GROUPS : PATHS.LOG_CHATS
}

function getLogFilePath(jid, folderName) {
    const base = folderName || getNumber(jid)
    return path.join(logDirFor(jid), `${base}.txt`)
}

function writeToLog(jid, direction, msg, mediaNote, folderName, replyTo) {
    const file = getLogFilePath(jid, folderName)
    const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    let label
    if (direction === "IN") label = `[THEM → YOU ]`
    else if (direction === "BOT") label = `[BOT  → THEM]`
    else label = `[YOU  → THEM]`
    let line = `${ts}  ${label}  ${msg}`
    if (replyTo) line += `   [↩ replying to: ${replyTo}]`
    if (mediaNote) line += `   [MEDIA: ${mediaNote}]`
    try { fs.appendFileSync(file, line + "\n") } catch (e) { logError("logging.writeToLog", "chat log append failed", e) }
    trimLogIfOld(file)
}

function logIncoming(jid, msg, mediaNote, folderName, replyTo) { writeToLog(jid, "IN", msg, mediaNote, folderName, replyTo) }
function logBotReply(jid, reply, folderName) { writeToLog(jid, "BOT", reply, null, folderName) }
function logOutgoing(jid, msg, folderName) { writeToLog(jid, "OUT", msg, null, folderName) }

/* The age check result is cached per file for 5 minutes — writeToLog used to
   stat the file on EVERY logged line (2-3 lines per message). The existing
   6-month age archive is unchanged; chat logs otherwise grow forever (no
   size cap). */
const MTIME_RECHECK_MS = 5 * 60 * 1000
const logCheckedAt = new Map()   // file -> last check time

function trimLogIfOld(file) {
    try {
        const now = Date.now()
        const last = logCheckedAt.get(file) || 0
        if (now - last < MTIME_RECHECK_MS) return
        logCheckedAt.set(file, now)
        if (!fs.existsSync(file)) return
        const stat = fs.statSync(file)
        if (Date.now() - stat.mtimeMs < LOG_AGE_CAP_MS) return
        const archive = file.replace(/\.txt$/, `_archived_${Date.now()}.txt`)
        fs.moveSync(file, archive)
        logCheckedAt.delete(file)   // the file moved — the next call re-stats
    } catch (e) { logError("logging.trimLogIfOld", "log archive failed", e, { quiet: true }) }
}

function logHumanNeeded(jid, rawMsg, reason) {
    const ts = new Date().toISOString()
    const num = getNumber(jid)
    const line = `${ts}  |  FROM: ${num}  |  REASON: ${reason}  |  MSG: ${rawMsg}`
    try { fs.appendFileSync(PATHS.LOG_HN, line + "\n") } catch (e) { logError("logging.logHumanNeeded", "human-needed log append failed", e) }
    console.log(`⚠️  HUMAN NEEDED [${num}]: ${rawMsg.substring(0, 80)}`)
}

function logAdminActivity(text) {
    const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
    try { fs.appendFileSync(PATHS.LOG_ADMIN, `${ts}  ${text}\n`) } catch (e) { logError("logging.logAdminActivity", "admin log append failed", e) }
}

/* ── logError — no failure is ever silent ─────────────────────
   One line per failure in logs/errors.txt (+ console on first occurrence).
   Repeats of the same location+context within an hour are coalesced (after
   50 identical lines one "suppressed" note is written), so a hot path can't
   flood the file. Rotation at ~1MB keeps one generation (errors.old.txt).
   logError itself can NEVER throw — worst case it degrades to console.warn. */

const ERR_COALESCE_LIMIT = 50
const ERR_WINDOW_MS = 60 * 60 * 1000
const ERR_ROTATE_BYTES = 1024 * 1024
const errorSeen = new Map()   // "location :: context" -> { windowStart, count, muted }

function writeErrorLine(line) {
    try {
        fs.ensureDirSync(path.dirname(PATHS.LOG_ERRORS))
        if (fs.existsSync(PATHS.LOG_ERRORS) && fs.statSync(PATHS.LOG_ERRORS).size > ERR_ROTATE_BYTES) {
            fs.moveSync(PATHS.LOG_ERRORS, PATHS.LOG_ERRORS.replace(/\.txt$/, ".old.txt"), { overwrite: true })
        }
        fs.appendFileSync(PATHS.LOG_ERRORS, line + "\n")
    } catch (e) {
        try { console.warn("error-log write failed:", e && e.message) } catch { }
    }
}

function logError(location, context, err, opts) {
    try {
        if (errorSeen.size > 1000) errorSeen.clear()   // call sites must keep contexts stable (no per-message text)
        const key = `${location} :: ${context}`
        const now = Date.now()
        let rec = errorSeen.get(key)
        if (!rec || now - rec.windowStart > ERR_WINDOW_MS) {
            rec = { windowStart: now, count: 0, muted: false }
            errorSeen.set(key, rec)
        }
        rec.count++
        const msg = err ? (err.message || String(err)) : ""
        if (rec.muted) return
        if (rec.count > ERR_COALESCE_LIMIT) {
            rec.muted = true
            writeErrorLine(`${new Date().toISOString()}  [${location}]  ${context} — suppressed after ${ERR_COALESCE_LIMIT} repeats this hour`)
            return
        }
        writeErrorLine(`${new Date().toISOString()}  [${location}]  ${context}${msg ? " — " + msg : ""}`)
        if (!(opts && opts.quiet) && rec.count === 1) console.warn(`⚠️  [${location}] ${context}${msg ? " — " + msg : ""}`)
    } catch (e) {
        try { console.warn("logError failed:", e && e.message) } catch { }
    }
}

module.exports = {
    LOG_AGE_CAP_MS, logDirFor, getLogFilePath, writeToLog,
    logIncoming, logBotReply, logOutgoing, trimLogIfOld,
    logHumanNeeded, logAdminActivity, logError
}
