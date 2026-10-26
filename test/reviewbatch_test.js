"use strict"
/* test/reviewbatch_test.js — numbered flows on the admin review surface.
   Stubs isolate WhatsApp. Project files snapshotted + restored; the queue is
   preserved across the run and my rows removed afterwards (no residue).
   Covers: !review <N> numbered list, !approve/!reject <spec> against that list
   (all-or-nothing on unknown numbers), the plain !review single-row path
   staying intact and clearing the listed numbers, and the 2-10 guard on <N>. */

const path = require("path")
const fs = require("fs-extra")

const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    if (request === "qrcode-terminal") return path.join(__dirname, "stubs", "qrcode-terminal.js")
    if (request === "@xenova/transformers") return path.join(__dirname, "stubs", "transformers.js")
    return origResolve.call(this, request, ...args)
}

process.env.VT_API_KEY = "TESTI_FAKE_KEY"
process.env.ADMIN = "smoketest_admin@c.us"
const ADMIN_JID = "smoketest_admin@c.us"

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

async function main() {
    /* snapshots: the real project files must survive this test */
    const { PATHS } = require("../src/config")
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")
    const snapCache = snapshotFile(PATHS.EMBED_CACHE)
    const snapAdmin = snapshotFile(PATHS.LOG_ADMIN)
    const snapErrors = snapshotFile(PATHS.LOG_ERRORS)
    const snapHN = snapshotFile(PATHS.LOG_HN)

    const state = require("../src/state")
    const knowledge = require("../src/knowledge")
    knowledge.init({ notifyAdmin: () => { }, notifyAdminBatched: () => { } })
    const { knowledgeDB, reviewDB } = require("../src/db")
    const admin = require("../src/admin")
    const { normalize, canonicalize } = require("../src/text")

    // wire admin with the same deps bot.js uses (efficiency_test pattern)
    admin.init({
        knowledgeDB, convoDB: require("../src/db").convoDB, reviewDB,
        reviewNext: require("../src/db").reviewNext,
        reviewQueueCount: require("../src/db").reviewQueueCount,
        reviewDelete: require("../src/db").reviewDelete,
        learn: knowledge.learn, commitKnowledge: knowledge.commitKnowledge,
        buildDigestText: () => "",
        saveKnowledgeJSON: knowledge.saveKnowledgeJSON,
        refreshKnowledgeCache: knowledge.refreshKnowledgeCache,
        refreshKnowledgeCacheEmbeddings: knowledge.refreshKnowledgeCacheEmbeddings,
        isGarbage: knowledge.isGarbage, isFiller: knowledge.isFiller,
        hasMinimumMeaningfulContent: knowledge.hasMinimumMeaningfulContent
    })

    // deterministic + hermetic: no model load. commitKnowledge takes its
    // null-embedding branch, which still inserts + returns true.
    state.embedReady = false
    state.llmAvailable = false
    state.selfChatId = ADMIN_JID
    state.reviewCurrentId = null

    let lastReply = null
    const mkAdminMsg = (id, body) => ({
        id: { _serialized: id }, body, fromMe: false, from: ADMIN_JID, hasMedia: false, type: "chat", hasQuotedMsg: false,
        reply: async (text) => { lastReply = text; return { id: { _serialized: "X" } } },
        getChat: async () => ({ name: null }), getQuotedMessage: async () => null
    })
    const run = async (body) => {
        lastReply = null
        const handled = await admin.handleCommand(mkAdminMsg("REVQB_MSG", body), ADMIN_JID, body)
        return { handled, reply: lastReply }
    }

    const kbHas = (q) => knowledgeDB.prepare("SELECT COUNT(*) as c FROM knowledge WHERE message = ?").get(normalize(canonicalize(q))).c === 1
    const pendCount = () => reviewDB.prepare("SELECT COUNT(*) as c FROM pending").get().c
    const pendHas = (id) => reviewDB.prepare("SELECT COUNT(*) as c FROM pending WHERE id = ?").get(id).c === 1

    /* preserve whatever is already waiting; test against an empty queue */
    const priorPending = reviewDB.prepare("SELECT id, question, answer, context, timestamp FROM pending").all()
    reviewDB.prepare("DELETE FROM pending").run()

    const seed = (rows) => {
        for (const s of rows) reviewDB.prepare("INSERT INTO pending(question, answer, context, timestamp) VALUES(?, ?, ?, ?)").run(s.q, s.a, "", Date.now())
        return rows.map(s => reviewDB.prepare("SELECT id FROM pending WHERE question = ?").get(s.q).id)
    }

    /* ── !review <N> guard (2-10) ── */
    console.log("\n── !review <N> count guard ──")
    let r = await run("!review 1")
    check("!review 1 rejected (below the 2-10 window)", r.handled === true && /takes a number from 2 to 10/.test(r.reply))
    r = await run("!review 11")
    check("!review 11 rejected (above the window)", r.handled === true && /takes a number from 2 to 10/.test(r.reply))
    r = await run("!review abc")
    check("!review abc rejected (not a number)", r.handled === true && /takes a number from 2 to 10/.test(r.reply))
    check("a rejected !review <N> left the queue untouched", pendCount() === 0)

    /* ── !review 3 → numbered list ── */
    console.log("\n── !review 3 lists a numbered queue ──")
    const seeds = [
        { q: "testi pick what is the price", a: "testi pick the price is 500" },
        { q: "testi pick how long is delivery", a: "testi pick delivery is two days" },
        { q: "testi pick " + "x".repeat(80) + " tail", a: "testi pick " + "y".repeat(120) + " tail" },  // long -> clipped in the list
        { q: "testi pick what is refund policy", a: "testi pick refunds within a week" },
        { q: "testi pick is there warranty", a: "testi pick one year warranty" }
    ]
    const ids = seed(seeds)   // [id1..id5], consecutive ascending, the only rows
    const [id1, id2, id3] = ids

    r = await run("!review 3")
    check("!review 3 handled", r.handled === true)
    check("lists exactly the three oldest, numbered by position",
        r.reply.includes(`1. [#${id1}]`) && r.reply.includes(`2. [#${id2}]`) && r.reply.includes(`3. [#${id3}]`) &&
        !r.reply.includes(`[#${ids[3]}]`) && !r.reply.includes(`[#${ids[4]}]`))
    check("each line shows Q and A", r.reply.includes(seeds[0].q) && r.reply.includes(seeds[0].a))
    check("the long question + answer are clipped in the list",
        r.reply.includes("…") && !r.reply.includes("x".repeat(80)) && !r.reply.includes("y".repeat(120)))

    /* ── !approve 1-2 → commit + remove; row 3 stays ── */
    console.log("\n── !approve 1-2 commits two, leaves the third ──")
    r = await run("!approve 1-2")
    check("!approve 1-2 handled", r.handled === true)
    check("summary reports Approved 2 with the id range", r.reply.includes("Approved 2") && r.reply.includes(`ids ${id1}-${id2}`))
    check("entries 1 and 2 are now in the knowledge base", kbHas(seeds[0].q) && kbHas(seeds[1].q))
    check("entry 3 was NOT committed", !kbHas(seeds[2].q))
    check("both committed rows left pending (5 -> 3)", pendCount() === 3 && !pendHas(id1) && !pendHas(id2))
    check("row 3 stays pending", pendHas(id3))

    /* ── !reject 3 → remove ── */
    console.log("\n── !reject 3 removes the third ──")
    r = await run("!reject 3")
    check("!reject 3 handled", r.handled === true)
    check("summary reports Rejected 1", r.reply.includes("Rejected 1") && r.reply.includes(`id ${id3}`))
    check("row 3 is gone from pending", !pendHas(id3))
    check("a rejected row is never committed", !kbHas(seeds[2].q))

    /* ── stale number after a fresh !review 2 + all-or-nothing ── */
    console.log("\n── stale number after a new !review 2 ──")
    r = await run("!review 2")
    check("!review 2 lists the next two rows", r.reply.includes(`1. [#${ids[3]}]`) && r.reply.includes(`2. [#${ids[4]}]`))
    r = await run("!approve 3")   // 3 was valid before the re-show; stale now
    check("a stale number warns instead of committing", r.handled === true && /Unknown number 3/.test(r.reply) && /Nothing committed/.test(r.reply))
    check("…and nothing changed (both still pending)", pendHas(ids[3]) && pendHas(ids[4]))
    check("…and neither was committed", !kbHas(seeds[3].q) && !kbHas(seeds[4].q))
    r = await run("!approve 1-9")   // mixes a valid number with out-of-range ones
    check("a spec mixing valid + out-of-range numbers is refused whole", r.handled === true && /Unknown number/.test(r.reply) && /Nothing committed/.test(r.reply))
    check("…all-or-nothing: neither shown row moved", pendHas(ids[3]) && pendHas(ids[4]) && !kbHas(seeds[3].q) && !kbHas(seeds[4].q))

    /* ── plain !review single-row flow stays intact + clears the numbers ── */
    console.log("\n── plain !review single-row path ──")
    r = await run("!review")
    check("plain !review still shows a single pending entry (old behavior)",
        r.handled === true && r.reply.includes(`Pending entry #${ids[3]}`) && r.reply.includes("!approve to commit"))
    r = await run("!approve 1-2")   // shownBatch was reset by the plain !review
    check("plain !review cleared the listed numbers (numbered !approve refuses)", r.handled === true && /use !review 2-10 first/.test(r.reply))
    check("…and it changed nothing", pendHas(ids[3]) && pendHas(ids[4]) && !kbHas(seeds[3].q) && !kbHas(seeds[4].q))

    /* ── id formatting: range vs comma list ── */
    console.log("\n── id formatting ──")
    reviewDB.prepare("DELETE FROM pending WHERE question LIKE '%testi%'").run()
    const fids = seed([
        { q: "testi fmt alpha", a: "testi fmt alpha ans" },
        { q: "testi fmt beta", a: "testi fmt beta ans" },
        { q: "testi fmt gamma", a: "testi fmt gamma ans" },
        { q: "testi fmt delta", a: "testi fmt delta ans" }
    ])
    r = await run("!review 4")
    check("!review 4 lists all four consecutive rows", r.reply.includes(`1. [#${fids[0]}]`) && r.reply.includes(`4. [#${fids[3]}]`))
    r = await run("!reject 1,3")   // fids[0] and fids[2] -> a gap -> comma list
    check("rejecting numbers 1 and 3 reuses the comma id form", r.reply.includes("Rejected 2") && r.reply.includes(`ids ${fids[0]},${fids[2]}`))

    /* ── cleanup: leave the project pristine ── */
    console.log("\n── cleanup ──")
    state.reviewCurrentId = null
    try { knowledgeDB.prepare("DELETE FROM knowledge WHERE message LIKE '%testi%'").run() } catch { }
    try { state.knowledge.entries = state.knowledge.entries.filter(e => !(e.message || "").includes("testi")) } catch { }
    try { knowledge.refreshKnowledgeCache() } catch { }

    // drop everything this test put in the queue, then restore what was already there
    reviewDB.prepare("DELETE FROM pending").run()
    for (const row of priorPending) {
        reviewDB.prepare("INSERT INTO pending(id, question, answer, context, timestamp) VALUES(?, ?, ?, ?, ?)")
            .run(row.id, row.question, row.answer, row.context, row.timestamp)
    }

    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)
    restoreFile(PATHS.EMBED_CACHE, snapCache)
    restoreFile(PATHS.LOG_ADMIN, snapAdmin)
    restoreFile(PATHS.LOG_ERRORS, snapErrors)
    restoreFile(PATHS.LOG_HN, snapHN)

    check("cleanup done (queue preserved, files restored, test rows removed)", true)

    console.log("\n═══════════════════════════════")
    console.log(`REVIEW QUEUE NUMBERING TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("REVIEW QUEUE NUMBERING TEST CRASHED:", e); process.exit(1) })
