"use strict"
/* src/misses.js — the "what should the bot be taught next" analysis.
   Reads logs/misses.txt (written by logMiss in src/logging.js), groups the
   missed questions by their canonicalized text and reports the ones that
   keep coming back — the owner's shortlist for new knowledge.json answers.
   Read-only except clearMisses(); nothing here can ever throw. */

const fs = require("fs-extra")
const { canonicalize } = require("./text")
const { MISSES_LOG } = require("./logging")

/* One miss line, exactly as logMiss wrote it:
     2026-10-26T09:15:00.000Z  |  FROM: 919999999999  |  REASON: no_kb_match  |  MSG: what are your business hours
   REASON is matched lazily and MSG takes the REST of the line, so a
   question containing "  |  " of its own cannot corrupt the parse. jid
   comes back as the phone NUMBER that was logged (FROM: holds the number,
   not the full JID). Returns null for any line that isn't a miss record. */
function parseMissLine(line) {
    if (!line || typeof line !== "string") return null
    const m = line.match(/^\s*(.*?)\s+\|\s+FROM:\s+(\S+)\s+\|\s+REASON:\s+(.*?)\s+\|\s+MSG:\s+([\s\S]*)$/)
    if (!m) return null
    const text = m[4].trim()
    if (!text) return null
    return { jid: m[2], text, reason: m[3].trim() }
}

/* Every parseable miss record in the file, oldest first. A missing or
   unreadable file reads as no misses — the analysis stays quiet, not loud. */
function readMisses() {
    try {
        if (!fs.existsSync(MISSES_LOG)) return []
        return fs.readFileSync(MISSES_LOG, "utf8")
            .split("\n")
            .map(l => parseMissLine(l))
            .filter(Boolean)
    } catch { return [] }
}

/* The questions people keep asking that the bot can't answer, most-missed
   first. The same question at different casing or punctuation counts as
   ONE entry (grouped on canonicalize), so "What are your hours?" and
   "what are your hours!!" roll up together instead of splitting the tally.
   Equal counts keep first-seen order (stable sort). */
function topMisses(n) {
    const groups = new Map()   // canonical question -> { q, count }
    for (const rec of readMisses()) {
        const key = canonicalize(rec.text)
        if (!key) continue   // nothing but emoji/punctuation has nothing to teach
        const hit = groups.get(key)
        if (hit) hit.count++
        else groups.set(key, { q: key, count: 1 })
    }
    const ranked = [...groups.values()].sort((a, b) => b.count - a.count)
    if (Number.isFinite(n)) return ranked.slice(0, Math.max(0, Math.floor(n)))
    return ranked
}

/* Wipe the ledger — the owner's "taught the bot these, clear the list". */
function clearMisses() {
    try { if (fs.existsSync(MISSES_LOG)) fs.removeSync(MISSES_LOG) } catch { }
}

module.exports = { MISSES_LOG, parseMissLine, readMisses, topMisses, clearMisses }
