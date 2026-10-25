"use strict"
/* src/util.js — tiny generic helpers. No project imports (leaf). */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function getNumber(jid) {
    return (jid || "").replace(/@.+/, "")
}

function sanitizeFolderName(name) {
    return (name || "").toString()
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 60) || "unnamed_group"
}

function istNow() {
    const parts = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata", hour12: false,
        hour: "2-digit", minute: "2-digit"
    }).formatToParts(new Date())
    const get = t => Number(parts.find(p => p.type === t).value)
    return { hour: get("hour") % 24, minute: get("minute") }
}

function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim())
    if (!m) return null
    const h = Number(m[1]), min = Number(m[2])
    if (h > 23 || min > 59) return null
    return h * 60 + min
}

/* Content fingerprint of a file — used to decide whether knowledge.db needs a
   rebuild at all (mtime+size was too weak: two saves in the same millisecond
   with identical size looked unchanged). */
function sha256File(p) {
    const crypto = require("crypto")
    const fs = require("fs")
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
}

function debugMode() { return !!(require("./state").settings || {}).debug }
function dryRunMode() { return !!(require("./state").settings || {}).dryRun }

/* F4-note: stageStart/stageEnd (stage timing stopwatch) were REMOVED in the F
   batch — they were never wired into the modular code (zero callers). */
function quietMode() { return !!(require("./state").settings || {}).quiet }   // hides only the per-message decision console line

/* The old check read ONLY `_data.fileLength`
   — a field whatsapp-web.js never sets at that spot (verified against the
   installed library: the public size surfaces as MessageMedia.filesize, and
   protobuf sizes live nested in _data.message.<type>Message.fileLength). So
   the pre-download 20MB cap was dead code and oversized media was fully
   downloaded into RAM before being rejected. Now we read, in order:
   _data.size, _data.fileLength (kept for back-compat), then the nested
   per-type field. Returns null when unknown — callers must treat that as
   "size unknown", never as zero. */
function coerceSizeBytes(v) {
    if (v == null) return null
    if (typeof v === "number") return (isFinite(v) && v >= 0) ? v : null
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim())
    if (typeof v === "object") {
        if (typeof v.toNumber === "function") {
            const n = v.toNumber()
            if (isFinite(n) && n >= 0) return n
        }
        const s = String(v)
        if (/^\d+$/.test(s)) return Number(s)
    }
    return null
}

function getMediaSizeBytes(message) {
    try {
        const d = message && message._data
        if (!d) return null
        let v = (d.size != null) ? d.size : d.fileLength
        if (v == null && d.message && typeof d.message === "object") {
            // protobuf shape: _data.message.documentMessage.fileLength etc.
            for (const inner of Object.values(d.message)) {
                if (inner && typeof inner === "object" && inner.fileLength != null) { v = inner.fileLength; break }
            }
        }
        return coerceSizeBytes(v)
    } catch { }
    return null
}

/* After downloadMedia(): the library returns the EXACT size alongside the
   data (MessageMedia.filesize). Prefer it; fall back to the old base64-length
   estimate only when the library provided nothing. */
function downloadedMediaBytes(media) {
    const exact = coerceSizeBytes(media && media.filesize)
    if (exact != null) return exact
    if (media && typeof media.data === "string") return Math.floor(media.data.length * 0.75)
    return null
}

module.exports = {
    sleep, getNumber, sanitizeFolderName, istNow, parseHHMM, sha256File,
    debugMode, dryRunMode, quietMode, getMediaSizeBytes, downloadedMediaBytes
}
