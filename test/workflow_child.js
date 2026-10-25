"use strict"
/* test/workflow_child.js — child process for workflow_test.js.

   Runs the ACTUAL startup path (config → db → knowledge modules). Modes:
     plain        : config load → B1 backup → buildKnowledgeDB → stub embedder
                    → computeAllMissingEmbeddings (exercises B2 cache reuse)
     B2_SEED=1    : + commitKnowledge one entry so an embedding is computed+cached
     B3_CORRUPT=1 : trash knowledge.json FIRST, run startupProtectKnowledge(),
                    print the notice line, exit rc = restored ? 0 : 3

   Process state is OWNED BY THE PARENT (it snapshots/restores real files
   before/after all children). The child restores nothing — keeps it
   crash-safe and simple. */

const path = require("path")

const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    if (request === "qrcode-terminal") return path.join(__dirname, "stubs", "qrcode-terminal.js")
    if (request === "@xenova/transformers") return path.join(__dirname, "stubs", "transformers.js")
    return origResolve.call(this, request, ...args)
}

process.env.ADMIN = "smoketest_admin@c.us"
process.env.VT_API_KEY = ""

const fs = require("fs-extra")
const { pipeline } = require("./stubs/transformers.js")
const { sleep } = require("../src/util")

async function main() {
    if (process.env.B3_CORRUPT === "1") {
        fs.writeFileSync("./memory/knowledge.json", "{ this is not valid json ,,, ]")
    }

    const cfg = require("../src/config")
    const state = require("../src/state")
    require("../src/db")
    const knowledge = require("../src/knowledge")
    knowledge.init({ notifyAdmin: () => { } })

    if (process.env.B3_CORRUPT === "1") {
        const res = cfg.startupProtectKnowledge()
        if (res.notice) console.log(res.notice.split("\n")[0])
        process.exit(res.restored === true ? 0 : 3)
    }

    await knowledge.buildKnowledgeDB()

    // Make the stub semantic layer "ready" — also resolves the pending
    // embedReadyPromise waiter started inside buildKnowledgeDB.
    state.embedPipeline = await pipeline()
    state.embedReady = true
    state.embedReadyResolve(true)

    if (process.env.B2_SEED === "1") {
        // quality gates are covered in smoke_test.js; we only need a committed
        // entry in knowledge.json + DB + embedding cache here.
        const ok = await knowledge.commitKnowledge("cache test about invoices", "answer about invoices cache test")
        console.log("SEEDED:" + (ok ? "yes" : "no"))
        if (!ok) process.exit(3)
        // Production flushes the embedding cache on the 30s timer +
        // shutdown; this short-lived child has neither, so flush explicitly
        // to keep the cross-process B2 roundtrip observable.
        require("../src/embedCache").flushEmbedCache()
    } else {
        // plain run: exercise the cache path for any DB row missing an embedding
        await knowledge.computeAllMissingEmbeddings()
        await sleep(400)   // let the fire-and-forget computeEmbeddingsFor finish logging
    }

    process.exit(0)
}

main().catch(e => { console.log("CHILD_FAIL " + e.message); process.exit(3) })
