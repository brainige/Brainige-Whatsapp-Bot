"use strict"
/* test/misses_test.js — the unanswered-question miss log.
   Covers: logMiss's line shape, parseMissLine's round trip, topMisses
   grouping (case/punctuation variants roll up), ordering by count,
   clearMisses, the missing-file case, and junk-line tolerance.
   Fully offline — no WhatsApp, no network, no LLM. logs/misses.txt itself
   is snapshotted before the run and restored after, exactly like the other
   suites do for their files. */

const fs = require("fs-extra")

// Requiring logging loads config (which ensures ./logs exists) and the writer.
const { MISSES_LOG, logMiss } = require("../src/logging")
const { topMisses, clearMisses, parseMissLine } = require("../src/misses")

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

function readLines() { return fs.readFileSync(MISSES_LOG, "utf8").trimEnd().split("\n") }

function main() {
    const snap = snapshotFile(MISSES_LOG)   // a real miss log must survive this run

    console.log("\n── 1. logMiss appends one line ──")
    clearMisses()
    logMiss("919999999999@c.us", "What are your business hours?", "no_kb_match")
    check("misses.txt created by the first miss", fs.existsSync(MISSES_LOG))
    const lines = readLines()
    check("exactly one line written", lines.length === 1)
    check("line starts with an ISO timestamp", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(lines[0]))
    check("line carries the phone number", lines[0].includes("FROM: 919999999999"))
    check("line carries the reason", lines[0].includes("REASON: no_kb_match"))
    check("line carries the question text", lines[0].includes("MSG: What are your business hours?"))

    console.log("\n── 2. parseMissLine round trip ──")
    const parsed = parseMissLine(lines[0])
    check("parser returns the object", !!parsed)
    check("jid parsed back", parsed && parsed.jid === "919999999999")
    check("text parsed back", parsed && parsed.text === "What are your business hours?")
    check("reason parsed back", parsed && parsed.reason === "no_kb_match")
    logMiss("919999999999@c.us", "do you deliver\nto howrah?", "no_kb_match")
    check("a multi-line question stays ONE record", readLines().length === 2)
    check("newlines flattened inside the record", readLines()[1].includes("MSG: do you deliver to howrah?"))
    check("parseMissLine rejects junk", parseMissLine("not a miss record") === null)
    check("parseMissLine rejects null", parseMissLine(null) === null)

    console.log("\n── 3. topMisses groups case/punctuation variants ──")
    clearMisses()
    logMiss("919999999999@c.us", "What are your business hours?", "no_kb_match")
    logMiss("918888888888@c.us", "what are your business hours!!", "low_score")
    const grouped = topMisses(10)
    check("same question → one entry", grouped.length === 1)
    check("grouped count is 2", grouped[0].count === 2)
    check("q is the canonicalized question", grouped[0].q === "what are your business hours")

    console.log("\n── 4. different questions stay separate + ordering ──")
    logMiss("917777777777@c.us", "Do you deliver?", "no_kb_match")
    check("different question → its own entry", topMisses(10).length === 2)
    logMiss("917777777777@c.us", "What is your pricing?", "low_score")
    logMiss("917777777777@c.us", "What is your pricing?", "low_score")
    logMiss("917777777777@c.us", "What is your pricing?", "low_score")
    const ranked = topMisses(10)
    check("sorted by count desc", ranked[0].count === 3 && ranked[1].count === 2 && ranked[2].count === 1)
    check("most-missed question ranks first", ranked[0].q === "what is your pricing")
    const top1 = topMisses(1)
    check("topMisses(1) returns only the top miss", top1.length === 1 && top1[0].count === 3)
    const top2 = topMisses(2)
    check("topMisses(2) returns the two most-missed", top2.length === 2 && top2[0].count === 3 && top2[1].count === 2)

    console.log("\n── 5. clearMisses + missing file ──")
    clearMisses()
    check("file gone after clearMisses", !fs.existsSync(MISSES_LOG))
    check("topMisses on a missing file is []", Array.isArray(topMisses(10)) && topMisses(10).length === 0)

    console.log("\n── 6. junk lines are ignored, real ones still count ──")
    fs.appendFileSync(MISSES_LOG, "garbage line with no fields\n")
    logMiss("919999999999@c.us", "What are your business hours?", "no_kb_match")
    const afterJunk = topMisses(10)
    check("junk line skipped, real miss still counted", afterJunk.length === 1 && afterJunk[0].count === 1)

    console.log("\n── 7. restore ──")
    restoreFile(MISSES_LOG, snap)
    check("misses.txt restored to its pre-run state", snapshotFile(MISSES_LOG) === snap)

    console.log("\n═══════════════════════════════")
    console.log(`MISS LOG TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main()
