"use strict"
/* test/workflow_test.js — startup-backup checks, crash-proof.

   Parent takes its OWN snapshots of knowledge.json + knowledge.json.bak
   BEFORE any child runs, and restores them AFTER — so even a crashing
   child can never pollute the real project files.

   - plain child run leaves a knowledge_prestart_*.json backup.
   - seeded child computes+caches an embedding; a fresh child restarted MUST
     hit the cache (log "reused from embedding cache") — zero model work.
   - corrupting knowledge.json triggers restore-from-backup and the alert
     notice, and .corrupt_<ts> preserves the broken file. */

const path = require("path")
const fs = require("fs-extra")
const { execFileSync } = require("child_process")

process.env.ADMIN = "smoketest_admin@c.us"
process.env.VT_API_KEY = ""

const PROJ = path.join(__dirname, "..")
const MEM = path.join(PROJ, "memory")
const BAK = path.join(PROJ, "logs", "backups")

let pass = 0, fail = 0
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✅ ${name}`) }
    else { fail++; console.log(`  ❌ ${name}`) }
}

function runChild(extraEnv) {
    const out = execFileSync(process.execPath, [path.join(__dirname, "workflow_child.js")], {
        cwd: PROJ, env: { ...process.env, ...extraEnv }, encoding: "utf8", timeout: 120000
    })
    return out
}

function snapshotFile(p) { try { return fs.readFileSync(p, "utf8") } catch { return null } }
function restoreSnapshot(p, content) { if (content !== null) fs.writeFileSync(p, content) }

function main() {
    // ── parent-level snapshots (the real safety) ──
    const snapKnowledge   = snapshotFile(path.join(MEM, "knowledge.json"))
    const snapKnowledgeBk = snapshotFile(path.join(MEM, "knowledge.json.bak"))
    const snapCache       = snapshotFile(path.join(MEM, "embeddings_cache.json"))

    // clean slate for observable side-effects
    for (const f of fs.readdirSync(BAK).filter(f => f.startsWith("knowledge_prestart_"))) fs.removeSync(path.join(BAK, f))
    try { fs.removeSync(path.join(MEM, "embeddings_cache.json")) } catch { }

    try {
        console.log("── backup created on startup ──")
        runChild()
        const backups = fs.readdirSync(BAK).filter(f => f.startsWith("knowledge_prestart_"))
        check("knowledge_prestart_*.json backup exists", backups.length > 0)
        check("backup is valid JSON with entries array", (() => {
            try { const d = JSON.parse(fs.readFileSync(path.join(BAK, backups[backups.length - 1]), "utf8")); return Array.isArray(d.entries) } catch { return false }
        })())

        console.log("── embedding cache roundtrip across processes ──")
        const out2 = runChild({ B2_SEED: "1" })
        check("seed run leaves no CHILD_FAIL", !out2.includes("CHILD_FAIL"))
        const cacheFile = path.join(MEM, "embeddings_cache.json")
        check("embeddings_cache.json exists on disk", fs.existsSync(cacheFile))
        const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"))
        check("cache holds the seeded entry", Object.keys(cache).length >= 1)
        const out3 = runChild()   // fresh process: must reuse cache, not recompute
        check("restart run leaves no CHILD_FAIL", !out3.includes("CHILD_FAIL"))
        check("cache reused on restart (model skipped)", /reused from embedding cache/.test(out3))

        console.log("── corrupt knowledge.json → restore from backup ──")
        const out4 = runChild({ B3_CORRUPT: "1" })   // exits rc 3 on failure → execFileSync throws
        check("corrupt-file child reports success", !out4.includes("CHILD_FAIL"))
        check("corruption notice present", out4.includes("RECOVERY"))
        const corruptKept = fs.readdirSync(MEM).filter(x => x.includes("knowledge.json.corrupt_"))
        check("corrupt file preserved for salvage", corruptKept.length > 0)
        check("knowledge.json parses again after restore", (() => { try { JSON.parse(fs.readFileSync(path.join(MEM, "knowledge.json"), "utf8")); return true } catch { return false } })())
    } catch (e) {
        fail++
        console.error("  ❌ child run threw:", (e.stderr || e.message).toString().slice(0, 400))
    } finally {
        // ── parent-level restore (children may pollute nothing) ──
        restoreSnapshot(path.join(MEM, "knowledge.json"), snapKnowledge)
        restoreSnapshot(path.join(MEM, "knowledge.json.bak"), snapKnowledgeBk)
        restoreSnapshot(path.join(MEM, "embeddings_cache.json"), snapCache)
        if (snapCache === null) { try { fs.removeSync(path.join(MEM, "embeddings_cache.json")) } catch { } }
        for (const f of fs.readdirSync(BAK).filter(f => f.startsWith("knowledge_prestart_"))) fs.removeSync(path.join(BAK, f))
        for (const f of fs.readdirSync(MEM).filter(f => f.includes("knowledge.json.corrupt_"))) fs.removeSync(path.join(MEM, f))
    }

    console.log("\n═══════════════════════════════")
    console.log(`WORKFLOW TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

try { main() } catch (e) { console.error("WORKFLOW TEST CRASHED:", e); process.exit(2) }
