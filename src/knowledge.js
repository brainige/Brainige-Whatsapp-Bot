"use strict"
/* src/knowledge.js — knowledge base: rebuild, cache, search, learning, review routing. */

const Filter = require("bad-words")
const profanity = new Filter()

const { PATHS, LLM_LEARN_MAX_HYBRID, saveJSON, LEARN_DIRECT_MIN_COSINE, LEARN_DIRECT_MIN_SHARED_WORDS,
    KB_FULL_SCAN_MAX, KB_CANDIDATE_POOL,
    SEARCH_LEX_COSINE_WEIGHT, SEARCH_LEX_JACCARD_WEIGHT, SEARCH_LEN_NORM_BASE, SEARCH_LEN_NORM_RATIO,
    SEARCH_HYBRID_SEM_WEIGHT, SEARCH_HYBRID_LEX_WEIGHT, SEARCH_CONTEXT_LEX_BOOST, SEARCH_CONTEXT_SEM_BOOST,
    SEARCH_MARGIN_MIN, SEARCH_MARGIN_PENALTY, FUSE_HYBRID_WEIGHT, FUSE_INTENT_WEIGHT,
    LEARN_ANSWER_RELATED_COSINE, NEAR_DUP_LEXICAL, NEAR_DUP_COSINE } = require("./config")
const state = require("./state")
const {
    canonicalize, normalize, applyTypoMap, buildVector,
    cosineLexical, jaccardSim, jaccardSimFromSets, cosineEmbedding,
    embeddingToBuffer, bufferToEmbedding, isNearDuplicate, tokenize, isQuestionLike
} = require("./text")
const { logError } = require("./logging")
const { getEmbedding } = require("./embeddings")
const { getCachedEmbedding, setCachedEmbedding } = require("./embedCache")
const { startupProtectKnowledge } = require("./config")
const { knowledgeDB, reviewAdd } = require("./db")
const { getRecentMessages, getUserProfile } = require("./memory")
const { debugMode, sha256File } = require("./util")

// notifyAdmin injected via init() to avoid circular imports
let notifyAdmin = () => { }
let notifyAdminBatched = () => { }   // coalesced variant (defaults to a no-op so old init() calls keep working)
// B3 notices queued pre-client-ready — delivered by bot.js once WhatsApp is up
let pendingStartupNotices = []
function queueStartupNotice(text) { pendingStartupNotices.push(text) }
function drainStartupNotices() { const out = pendingStartupNotices; pendingStartupNotices = []; return out }
function init(deps) { notifyAdmin = deps.notifyAdmin || notifyAdmin; notifyAdminBatched = deps.notifyAdminBatched || notifyAdminBatched }

/* ── knowledge.json save (special pretty format preserved) ── */
function saveKnowledgeJSON(data) {
    try {
        const lines = data.entries.map(e => JSON.stringify(e)).join(",\n")
        const fs = require("fs-extra")
        const tmp = PATHS.KNOWLEDGE + ".tmp"
        if (fs.existsSync(PATHS.KNOWLEDGE)) {
            try { fs.copySync(PATHS.KNOWLEDGE, PATHS.KNOWLEDGE + ".bak") } catch (e) { logError("knowledge.saveKnowledgeJSON", "knowledge.json .bak copy failed", e, { quiet: true }) }
        }
        fs.writeFileSync(tmp, `{\n"entries":[\n${lines}\n]\n}`)
        fs.moveSync(tmp, PATHS.KNOWLEDGE, { overwrite: true })
        refreshKnowledgeStamp()   // reconnect rebuilds only if the file changed on disk since
    } catch (e) { console.error("⚠️  Failed to save knowledge.json:", e.message) }
}

/* A fingerprint of knowledge.json on disk, so a reconnect only rebuilds
   knowledge.db if the file actually changed (keeps mid-run hand-edits live
   without paying a rebuild on every reconnect). The old mtime+size stamp was
   too weak (two saves in the same millisecond with identical size looked
   unchanged); it is now the SHA-256 of the file CONTENT. */
let knowledgeStamp = null
function refreshKnowledgeStamp() {
    try {
        const fs = require("fs-extra")
        if (!fs.existsSync(PATHS.KNOWLEDGE)) { knowledgeStamp = null; return }
        knowledgeStamp = sha256File(PATHS.KNOWLEDGE)
    } catch (e) { knowledgeStamp = null }
}
function knowledgeJsonChanged() {
    try {
        const fs = require("fs-extra")
        if (!fs.existsSync(PATHS.KNOWLEDGE)) return false
        return knowledgeStamp !== sha256File(PATHS.KNOWLEDGE)
    } catch (e) { return false }
}

/* ── rebuild knowledge.db from knowledge.json (startup) ── */
async function buildKnowledgeDB() {
    // Protect the source of truth BEFORE anything else.
    const prot = startupProtectKnowledge()
    if (prot.notice) queueStartupNotice(prot.notice)

    // If knowledge.db and .json are exactly similar then no rebuild — skip
    // ONLY when the meta fingerprint PROVES the table
    // already matches knowledge.json — the file's content hash AND the row
    // count are unchanged since the last completed build. The check is
    // dynamic (not a boot-time flag), so a mid-session call after a commit
    // or a hand-edit still rebuilds exactly as before. db.js already wiped
    // the table at boot whenever the fingerprint was stale, so a warm boot
    // lands here with a matching table and just refreshes the in-memory
    // cache — startup drops from seconds to milliseconds.
    let fileHashNow = null, metaHash = null, metaCount = null, rowsNow = null
    try { fileHashNow = sha256File(PATHS.KNOWLEDGE) } catch { }
    try {
        metaHash = knowledgeDB.prepare("SELECT value FROM meta WHERE key = 'build_hash'").get()
        metaCount = knowledgeDB.prepare("SELECT value FROM meta WHERE key = 'build_count'").get()
        rowsNow = knowledgeDB.prepare("SELECT COUNT(*) as c FROM knowledge").get().c
    } catch { }
    if (fileHashNow && metaHash && metaCount && metaHash.value === fileHashNow && Number(metaCount.value) === rowsNow) {
        console.log("⚡ knowledge.json unchanged since the last build (fingerprint + row count match) — skipping the rebuild.")
        refreshKnowledgeCache()
        refreshKnowledgeStamp()
        return
    }

    console.log("🔄 Rebuilding knowledge.db from knowledge.json...")

    const insertStmt = knowledgeDB.prepare(
        "INSERT OR IGNORE INTO knowledge(message, reply, vector, embedding) VALUES(?, ?, ?, ?)"
    )

    let inserted = 0
    let skipped = 0
    let dupIgnored = 0
    const preCount = knowledgeDB.prepare("SELECT COUNT(*) as c FROM knowledge").get().c
    const toEmbed = []

    const tx = knowledgeDB.transaction(() => {
        for (const e of state.knowledge.entries) {
            if (!e.message || !e.reply) continue
            const cleanedMsg = canonicalize(e.message.trim())
            const cleanedReply = e.reply.trim()
            if (cleanedMsg.length < 2 || cleanedReply.length < 2) { skipped++; continue }
            if (isGarbage(cleanedMsg) || isGarbage(cleanedReply)) { skipped++; continue }
            if (isFiller(cleanedReply)) { skipped++; continue }
            const normMsg = normalize(cleanedMsg)
            const vec = buildVector(normMsg)
            try {
                const info = insertStmt.run(normMsg, cleanedReply, JSON.stringify(vec), null)
                if (info.changes > 0) {
                    toEmbed.push(normMsg)
                    inserted++
                } else {
                    // Two knowledge.json entries normalizing to the same
                    // key — the duplicate was silently dropped before; now it is
                    // counted and surfaced to the admin. Only meaningful on
                    // a fresh rebuild — a mid-session rebuild legitimately merges
                    // with existing rows, which must NOT look like duplicates.
                    if (preCount === 0) {
                        dupIgnored++
                        logError("knowledge.buildKnowledgeDB", "duplicate normalized key in knowledge.json — only the first entry is kept", undefined, { quiet: true })
                    }
                }
            } catch (e) { logError("knowledge.buildKnowledgeDB", "insert failed for one entry", e, { quiet: true }) }
        }
    })

    tx()
    refreshKnowledgeCache()
    const total = knowledgeDB.prepare("SELECT COUNT(*) as c FROM knowledge").get().c
    console.log(`📚 DB built — ${inserted} entries inserted, ${skipped} skipped, ${dupIgnored} duplicate key(s) ignored | Total: ${total}`)
    // A freshly-emptied table must hold EXACTLY
    // what we tried to insert — a mismatch means silent row loss. Loud, never quiet.
    if (preCount === 0 && total !== inserted) {
        const msg = `🚨 knowledge.db rebuild mismatch: inserted ${inserted} but the table holds ${total}. Check memory/knowledge.json for malformed entries.`
        console.error(msg)
        logError("knowledge.buildKnowledgeDB", "post-rebuild count mismatch", new Error(`inserted=${inserted} total=${total}`))
        queueStartupNotice(msg)
    }
    if (dupIgnored > 0) {
        const msg = `⚠️ knowledge.json contains ${dupIgnored} duplicate question(s) after normalization — only the first of each is in the brain.`
        console.error(msg)
        queueStartupNotice(msg)
    }
    refreshKnowledgeStamp()

    // Remember what this build produced so the NEXT boot can skip.
    // Unconditional — a mid-session rebuild (commit / hand-edit) must refresh
    // the fingerprint too, or the next boot would needlessly rebuild again.
    try {
        const finalHash = sha256File(PATHS.KNOWLEDGE)
        knowledgeDB.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('build_hash', ?)").run(finalHash)
        knowledgeDB.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('build_count', ?)").run(String(total))
    } catch (e) { logError("knowledge.buildKnowledgeDB", "build fingerprint write failed (next boot will simply rebuild)", e, { quiet: true }) }

    if (toEmbed.length > 0) computeEmbeddingsFor(toEmbed)
}

/* Per-row precompute. The search loop used to re-tokenize EVERY entry on
   EVERY incoming message (length + jaccard ran tokenize up to 3× per row) —
   on a 2,000-entry brain that was thousands of redundant splits per message. */
function primeCacheRow(row) {
    try { row.parsedVector = JSON.parse(row.vector) } catch { row.parsedVector = buildVector(row.message) }
    row.tokenArr = tokenize(row.message, true)
    row.tokenSet = new Set(row.tokenArr)
    row.canonMsg = canonicalize(row.message)   // precomputed — the learn-path near-dup scan used to re-clean every row on every learn
}

/* Word-index, book-index style — meaningful word → the entries that
   contain it. Lets a big-KB search jump straight to entries that share at
   least one meaningful word with the incoming message, instead of running
   meaning-math over everything. Built in refreshKnowledgeCache, updated
   incrementally in commitKnowledge. */
function indexKnowledgeRow(row) {
    if (!row.tokenSet) return
    for (const w of row.tokenSet) {
        let postings = state.knowledgeWordIndex.get(w)
        if (!postings) { postings = new Set(); state.knowledgeWordIndex.set(w, postings) }
        postings.add(row)
    }
}

function refreshKnowledgeCache() {
    state.knowledgeCache = knowledgeDB.prepare(
        "SELECT id, message, reply, vector, embedding, uses FROM knowledge ORDER BY uses DESC"
    ).all()
    state.normalizedMsgIndex.clear()
    state.knowledgeCacheById.clear()
    state.knowledgeWordIndex.clear()   // rebuilt below from the fresh rows
    for (const row of state.knowledgeCache) {
        state.normalizedMsgIndex.add(row.message)
        state.knowledgeCacheById.set(row.id, row)
        primeCacheRow(row)             // vector + tokens computed once, not per message
        indexKnowledgeRow(row)         // D1
    }
}

async function computeEmbeddingsFor(messages) {
    const modelLoaded = await state.embedReadyPromise
    if (!modelLoaded || !state.embedReady) return
    console.log(`🔢 Computing embeddings for ${messages.length} entries...`)

    // Separate cache-hits (already embedded in a previous run — no model
    // call needed) from entries that genuinely need the model.
    const hits = []
    const misses = []
    for (const msg of messages) (getCachedEmbedding(msg) ? hits : misses).push(msg)

    const updateStmt = knowledgeDB.prepare("UPDATE knowledge SET embedding = ? WHERE message = ?")

    // Cache hits: write straight to DB.
    for (const msg of hits) {
        try { updateStmt.run(embeddingToBuffer(Float32Array.from(getCachedEmbedding(msg))), msg) } catch (e) { logError("knowledge.computeEmbeddingsFor", "cached-embedding DB update failed", e, { quiet: true }) }
    }
    if (hits.length > 0) console.log(`  🔁 ${hits.length}/${messages.length} reused from embedding cache`)

    // Cache misses: actually compute + stash for next restart.
    const BATCH = 10
    for (let i = 0; i < misses.length; i += BATCH) {
        const batch = misses.slice(i, i + BATCH)
        await Promise.all(batch.map(async msg => {
            const emb = await getEmbedding(msg)
            if (emb) {
                try { updateStmt.run(embeddingToBuffer(emb), msg) } catch (e) { logError("knowledge.computeEmbeddingsFor", "embedding DB update failed", e, { quiet: true }) }
                setCachedEmbedding(msg, emb)
                // (no manual cache seeding needed — getEmbedding caches under
                //  the v2 full-text key itself; the old 200-char seeding line is gone.)
            }
        }))
    }
    // No inline flush — the 30s flush timer + shutdown write the file.
    refreshKnowledgeCacheEmbeddings()
    console.log("✅ Embeddings done.")
}

function refreshKnowledgeCacheEmbeddings() {
    const rows = knowledgeDB.prepare("SELECT id, embedding FROM knowledge").all()
    const embMap = new Map(rows.map(r => [r.id, r.embedding]))
    for (const row of state.knowledgeCache) {
        if (embMap.has(row.id)) row.embedding = embMap.get(row.id)
    }
}

async function computeAllMissingEmbeddings() {
    const modelLoaded = await state.embedReadyPromise
    if (!modelLoaded || !state.embedReady) return
    const rows = knowledgeDB.prepare("SELECT id, message FROM knowledge WHERE embedding IS NULL").all()
    if (rows.length === 0) return
    console.log(`🔢 Computing ${rows.length} missing embeddings...`)

    // Same cache-split as computeEmbeddingsFor.
    const hitRows = []
    const missRows = []
    for (const row of rows) (getCachedEmbedding(row.message) ? hitRows : missRows).push(row)

    const updateStmt = knowledgeDB.prepare("UPDATE knowledge SET embedding = ? WHERE id = ?")

    for (const row of hitRows) {
        try { updateStmt.run(embeddingToBuffer(Float32Array.from(getCachedEmbedding(row.message))), row.id) } catch (e) { logError("knowledge.computeAllMissingEmbeddings", "cached-embedding DB update failed", e, { quiet: true }) }
    }
    if (hitRows.length > 0) console.log(`  🔁 ${hitRows.length}/${rows.length} reused from embedding cache`)

    const BATCH = 10
    for (let i = 0; i < missRows.length; i += BATCH) {
        const batch = missRows.slice(i, i + BATCH)
        await Promise.all(batch.map(async row => {
            const emb = await getEmbedding(row.message)
            if (emb) {
                try { updateStmt.run(embeddingToBuffer(emb), row.id) } catch (e) { logError("knowledge.computeAllMissingEmbeddings", "embedding DB update failed", e, { quiet: true }) }
                setCachedEmbedding(row.message, emb)
            }
        }))
    }
    // No inline flush — the 30s flush timer + shutdown write the file.
    refreshKnowledgeCacheEmbeddings()
    console.log("✅ All embeddings filled.")
}

/* ── hybrid knowledge search ──
   D1 (two-stage, auto-switch): while the brain is small (≤ KB_FULL_SCAN_MAX
   entries) this is EXACTLY the V6.5 full scan — every entry gets lexical +
   meaning-math (identical math, identical answers). Once the brain grows
   past that, stage 1 scores every entry on cheap word-match (via the D1
   word-index) and stage 2 runs the expensive meaning-math only on the top
   KB_CANDIDATE_POOL candidates. If the message shares no meaningful word
   with ANY entry, we fall back to the full scan so pure meaning-matches
   (e.g. Bangla question vs English entry) are still found.
   The incoming message is tokenized ONCE here; entries carry
   precomputed token sets from primeCacheRow. */
async function findBestReply(rawMsg, user, opts) {
    const cleanedMsg = canonicalize(applyTypoMap(rawMsg))
    const inputVec = buildVector(cleanedMsg)
    const inputEmb = await getEmbedding(cleanedMsg)

    // A non-engaged group's decision is SILENT no matter what the search
    // says (owner choice 2026-10-23: skip the search + context work there, keep
    // the HN flagging). inputEmb is still computed so the human-needed check
    // stays byte-identical — only the scan and context embedding are skipped.
    if (opts && opts.light) {
        return { reply: null, id: null, hybridScore: 0, rawScore: 0, uses: 0, inputEmb, debugTop3: null }
    }

    const recentMsgs = getRecentMessages(user, 4)
    const contextStr = recentMsgs.join(" ")
    let contextVec = null
    let contextEmb = null
    if (contextStr.length > 3) {
        // The context embedding only changes when a new message arrives —
        // cache it per chat; any context change makes the string differ, which
        // invalidates the cache automatically. Identical string → identical
        // embedding, so scores are unchanged.
        const cachedCtx = state.contextEmbCache.get(user)
        if (cachedCtx && cachedCtx.ctx === contextStr) {
            contextVec = cachedCtx.vec
            contextEmb = cachedCtx.emb
        } else {
            contextVec = buildVector(canonicalize(applyTypoMap(contextStr)))
            contextEmb = await getEmbedding(canonicalize(applyTypoMap(contextStr)))
            if (state.contextEmbCache.size > 500) state.contextEmbCache.clear()
            state.contextEmbCache.set(user, { ctx: contextStr, vec: contextVec, emb: contextEmb })
        }
    }

    const inputTokenArr = tokenize(cleanedMsg, true)
    const inputTokenSet = new Set(inputTokenArr)
    const iLen = inputTokenArr.length || 1

    // Pick the candidate set
    let candidates = state.knowledgeCache
    let fullScan = true
    if (state.knowledgeCache.length > KB_FULL_SCAN_MAX) {
        const byWord = new Set()
        for (const w of inputTokenSet) {
            const postings = state.knowledgeWordIndex.get(w)
            if (postings) for (const row of postings) byWord.add(row)
        }
        if (byWord.size > 0) { candidates = [...byWord]; fullScan = false }
        // byWord empty → no entry shares any word → full scan (rare, protects accuracy)
    }

    // Stage 1: lexical score (cheap word math) for every candidate
    const lexScored = []
    for (const row of candidates) {
        if (!row.message || !row.reply) continue
        const entryVec = row.parsedVector && Object.keys(row.parsedVector).length > 0 ? row.parsedVector : buildVector(row.message)
        const lexCos = cosineLexical(inputVec, entryVec)
        const jac = jaccardSimFromSets(inputTokenSet, row.tokenSet)
        const lexScore = lexCos * SEARCH_LEX_COSINE_WEIGHT + jac * SEARCH_LEX_JACCARD_WEIGHT   // F2
        const eLen = row.tokenArr.length || 1
        const lenRatio = Math.min(iLen, eLen) / Math.max(iLen, eLen)
        const lexFinal = lexScore * (SEARCH_LEN_NORM_BASE + SEARCH_LEN_NORM_RATIO * lenRatio)   // F2
        lexScored.push({ row, entryVec, lexFinal })
    }

    // D1 stage 2 gate: big brain → meaning-math only on the top word-matched
    // candidates. Array.sort is stable, so ties keep cache order (deterministic).
    let scored = lexScored
    if (!fullScan && lexScored.length > KB_CANDIDATE_POOL) {
        lexScored.sort((a, b) => b.lexFinal - a.lexFinal)
        scored = lexScored.slice(0, KB_CANDIDATE_POOL)
    }

    let bestScore = 0, bestReply = null, bestId = null, secondScore = 0, bestUses = 0
    const debugTop = []

    for (const { row, entryVec, lexFinal } of scored) {
        const entryEmb = bufferToEmbedding(row.embedding)
        const semScore = (inputEmb && entryEmb) ? cosineEmbedding(inputEmb, entryEmb) : 0

        const hybridScore = inputEmb ? (semScore * SEARCH_HYBRID_SEM_WEIGHT + lexFinal * SEARCH_HYBRID_LEX_WEIGHT) : lexFinal   // F2

        let score = hybridScore
        if (contextVec) score = Math.min(1.0, score + cosineLexical(contextVec, entryVec) * SEARCH_CONTEXT_LEX_BOOST)   // F2
        if (contextEmb && entryEmb) score = Math.min(1.0, score + cosineEmbedding(contextEmb, entryEmb) * SEARCH_CONTEXT_SEM_BOOST)   // F2

        if (score > bestScore) {
            secondScore = bestScore; bestScore = score; bestReply = row.reply; bestId = row.id; bestUses = row.uses || 0
        } else if (score > secondScore) {
            secondScore = score
        }
        if (debugMode()) debugTop.push({ id: row.id, msg: row.message, score })
    }

    const margin = bestScore - secondScore
    const adjustedScore = margin < SEARCH_MARGIN_MIN ? bestScore * SEARCH_MARGIN_PENALTY : bestScore   // F2

    let debugTop3 = null
    if (debugMode()) {
        debugTop3 = debugTop.sort((a, b) => b.score - a.score).slice(0, 3)
            .map(d => `  ${d.score.toFixed(3)}  "${d.msg.substring(0, 40)}"`)
    }

    return { reply: bestReply, id: bestId, hybridScore: adjustedScore, rawScore: bestScore, uses: bestUses, inputEmb, debugTop3 }
}

function fuseConfidence(hybridScore, intentWeight) {
    return FUSE_HYBRID_WEIGHT * hybridScore + FUSE_INTENT_WEIGHT * intentWeight   // F2
}

/* ── learning system (7-step pipeline) ── */

function isGarbage(text) {
    if (!text || text.trim().length < 3) return true
    const t = text.trim().toLowerCase()
    if (/^(https?:\/\/|www\.)/i.test(t)) return true
    if (/^[\W\d\s]+$/.test(t)) return true
    if (/^(.)\1{4,}$/.test(t)) return true
    if (/^[a-z\u0980-\u09FF\u0900-\u097F]{1,2}$/.test(t)) return true
    if ((t.match(/\d/g) || []).length / t.length > 0.75) return true
    if (tokenize(t, false).filter(w => w.length > 1).length < 1) return true
    return false
}

function isFiller(text) {
    if (!text) return true
    const t = text.trim().toLowerCase()
    const cleanT = canonicalize(t)

    const trivial = new Set([
        "ok", "okay", "ok ok", "okay okay", "fine", "sure", "yes", "no", "yeah", "yup", "nope",
        "lol", "haha", "lmao", "rofl", "ha", "loll", "lololol", "hmm", "hmmm", "uh", "ugh",
        "err", "meh", "idk", "right", "cool", "nice", "good", "bad", "great", "awesome",
        "k", "kk", "kkk", "123", "yay", "yesss", "nooo",
        "thanks", "thank you", "thx", "ty", "no thanks",
        "bye", "bye bye", "see you", "later", "cya", "gtg", "gotta go",
        "help", "need help", "help me", "hello", "hi", "hey", "yo", "sup",
        "hm", "huh", "eww", "bruh", "smh", "tbh", "ngl",
        "hola", "namaste", "salam",
        ".", "..", "...", "????", "!!!!", "!!!!!", "?????"
    ])

    if (trivial.has(cleanT) || trivial.has(t)) return true
    if (cleanT.length < 5) return true
    const words = cleanT.split(/\s+/).filter(w => w.length > 1)
    if (words.length === 1 && words[0].length < 5) return true
    return false
}

function isEcho(q, a) {
    return normalize(q).substring(0, 50) === normalize(a).substring(0, 50)
}

function hasMinimumMeaningfulContent(text) {
    if (!text || text.trim().length < 5) return false
    const cleaned = canonicalize(text)
    if (cleaned.length < 5) return false
    const words = cleaned.split(/\s+/).filter(w => w.length > 2)
    return words.length >= 2
}

async function isAnswerRelated(question, answer) {
    const cleanQ = canonicalize(question)
    const cleanA = canonicalize(answer)
    if (cleanA.length < 8) return false
    const qWords = new Set(cleanQ.split(/\s+/).filter(w => w.length > 2))
    const aWords = new Set(cleanA.split(/\s+/).filter(w => w.length > 2))
    if (qWords.size < 2) return true
    let overlap = 0
    for (const w of qWords) if (aWords.has(w)) overlap++
    if (overlap / qWords.size < 0.15 && overlap < 2) return false
    try {
        const qEmb = await getEmbedding(cleanQ)
        const aEmb = await getEmbedding(cleanA)
        if (qEmb && aEmb && cosineEmbedding(qEmb, aEmb) < LEARN_ANSWER_RELATED_COSINE) return false   // F2
    } catch (e) {
        logError("knowledge.isAnswerRelated", "embedding compare failed — pair rejected conservatively", e)
        return false
    }
    return true
}

async function isTooSimilarToExisting(q) {
    const cleanQ = canonicalize(q)
    const normQ = normalize(cleanQ)

    if (state.normalizedMsgIndex.has(normQ)) return true

    let inputEmb = null
    if (state.embedReady) inputEmb = await getEmbedding(cleanQ)

    // A row sharing NO meaningful word with the question can never
    // reach the 0.90 lexical near-dup bar, so the per-row text re-clean only
    // runs on candidates. The semantic cosine still scans every row, so
    // zero-overlap near-duplicates are still caught. Verdicts are identical.
    const qWords = new Set(cleanQ.split(/\s+/).filter(w => w.length > 1))
    for (const row of state.knowledgeCache) {
        if (row.canonMsg === cleanQ) return true
        if (row.tokenSet) {
            let shares = false
            for (const w of qWords) { if (row.tokenSet.has(w)) { shares = true; break } }
            if (shares && isNearDuplicate(q, row.message, NEAR_DUP_LEXICAL)) return true   // F2
        } else if (isNearDuplicate(q, row.message, NEAR_DUP_LEXICAL)) {
            return true   // edge: row without a precomputed token set — full check
        }
        if (inputEmb) {
            const entryEmb = bufferToEmbedding(row.embedding)
            if (entryEmb && cosineEmbedding(inputEmb, entryEmb) > NEAR_DUP_COSINE) return true   // F2
        }
    }
    return false
}

// Full 7-gate check, reusable for direct-commit vs review-queue routing
async function passesAllQualityGates(q, a) {
    if (isGarbage(q) || isGarbage(a)) return false
    if (isFiller(a)) return false
    if (isEcho(q, a)) return false
    if (profanity.isProfane(a)) return false
    if (!hasMinimumMeaningfulContent(q) || !hasMinimumMeaningfulContent(a)) return false
    if (await isTooSimilarToExisting(q)) return false
    if (!(await isAnswerRelated(q, a))) return false
    return true
}

// Commit a pair to knowledge.db + knowledge.json + caches.
async function commitKnowledge(q, a) {
    const cleanedQ = canonicalize(q)
    const normQ = normalize(cleanedQ).substring(0, 300)
    const finalA = a.trim().substring(0, 500)
    const vector = buildVector(normQ)
    const emb = await getEmbedding(normQ)
    const embBuf = emb ? embeddingToBuffer(emb) : null

    try {
        const stmt = knowledgeDB.prepare(
            "INSERT OR IGNORE INTO knowledge(message, reply, vector, embedding) VALUES(?, ?, ?, ?)"
        )
        const info = stmt.run(normQ, finalA, JSON.stringify(vector), embBuf)
        if (info.changes === 0) return false

        // Stash this new embedding so the next rebuild reuses it.
        // The flush is debounced (30s timer + shutdown) — no more
        // synchronous full-file write on every learned entry.
        if (emb) { setCachedEmbedding(normQ, emb) }

        // Entries are stored as clean {message, reply} pairs:
        // entries are stored as clean {message, reply} pairs. The machine
        // "vector" field is dropped — it is fully rebuilt from the question
        // text on every boot, and it made the hand-edited file ugly and huge.
        state.knowledge.entries.push({ message: normQ, reply: finalA })
        saveKnowledgeJSON(state.knowledge)

        const newRow = knowledgeDB.prepare("SELECT id, message, reply, vector, embedding, uses FROM knowledge WHERE message = ?").get(normQ)
        if (newRow) {
            primeCacheRow(newRow)          // tokens precomputed once
            indexKnowledgeRow(newRow)      // word-index stays live for freshly learned entries
            state.knowledgeCache.push(newRow)
            state.normalizedMsgIndex.add(normQ)
            state.knowledgeCacheById.set(newRow.id, newRow)
        }

        console.log(`✅ LEARNED: "${normQ.substring(0, 40)}" → "${finalA.substring(0, 40)}"`)
        return true
    } catch (e) {
        console.error("⚠️  Learn insert error:", e.message)
        return false
    }
}

/* One review-queue writer, used by every tier that needs human eyes. */
async function queueForReview(q, a, context) {
    const res = reviewAdd(normalize(canonicalize(q)).substring(0, 300), a.trim().substring(0, 500), context)
    if (res && res.deduped) {
        // The same question is already pending — no second
        // row, no second notification. Still true: the pair IS in the queue.
        console.log(`📥 Already pending review (id ${res.id}) — duplicate not re-queued: "${q.substring(0, 40)}"`)
        return true
    }
    if (res) {
        console.log(`📥 QUEUED FOR REVIEW (id ${res.id}): "${q.substring(0, 40)}" → "${a.substring(0, 40)}"`)
        // Coalesced — one 5-minute summary instead of one message per entry
        notifyAdminBatched("Review queue", `📥 New entry #${res.id}:\nQ: ${q.substring(0, 80)}\nA: ${a.substring(0, 80)}\nUse !review to see it.`)
        return true
    }
    return false
}

/* Strong relatedness for direct commits — the answer must be tightly
   tied to the question: shared meaningful words AND high semantic similarity.
   If the model isn't loaded we return false → the pair goes to review. */
async function strongRelatedness(q, a) {
    const qWords = new Set(tokenize(canonicalize(q), true))
    const aWords = new Set(tokenize(canonicalize(a), true))
    let shared = 0
    for (const w of qWords) if (aWords.has(w)) shared++
    if (shared < LEARN_DIRECT_MIN_SHARED_WORDS) return false
    try {
        const qEmb = await getEmbedding(canonicalize(q))
        const aEmb = await getEmbedding(canonicalize(a))
        if (!qEmb || !aEmb) return false
        return cosineEmbedding(qEmb, aEmb) >= LEARN_DIRECT_MIN_COSINE
    } catch (e) {
        logError("knowledge.strongRelatedness", "embedding compare failed — routing to review", e)
        return false
    }
}

/* The learning ladder. Sources:
   - "explicit" (default): admin !train — trusted, commits directly (unchanged
     from V6.5).
   - "quoted": anchored by a WhatsApp quote from the OWNER — commits directly,
     unless the "answer" is itself a question (G11 → review).
   - "group_quoted": a GROUP MEMBER quoting the bot — ALWAYS the review queue
     (group members are not trusted teachers; learning continues but
     human-gated).
   - "auto": the owner's phone reply paired with the customer's stored
     question — commits directly only at strong relatedness; otherwise
     review queue.
   - fromLLM=true: ALWAYS the review queue — nothing from the small model
     enters the brain without human eyes).
     An answer that is itself a question isn't even queued.
   Gate G8 (question-shape) is applied by the CALLER (handler) before
   pairing, so it never re-fires here. Customer→customer pairing no longer
   exists at all — the old garbage source is gone. */
async function learn(q, a, fromLLM = false, hybridScore = 1.0, sourceContext = "", source = "explicit") {
    if (!state.settings.learning) return false
    if (!q || !a) return false
    if (fromLLM && hybridScore >= LLM_LEARN_MAX_HYBRID) return false

    if (!(await passesAllQualityGates(q, a))) {
        if (debugMode()) console.log(`🚫 LEARN REJECTED by quality gates (source=${source}): "${String(q).substring(0, 40)}"`)
        return false
    }

    // ALL LLM-sourced entries wait for the human review queue.
    if (fromLLM) {
        if (isQuestionLike(a)) return false   // a question is not an answer — don't even queue it
        return queueForReview(q, a, sourceContext || "LLM reply")
    }

    if (source === "explicit") return commitKnowledge(q, a)
    if (isQuestionLike(a)) {
        // An answer that is itself a question never commits directly.
        return queueForReview(q, a, `${sourceContext || source} [answer looks like a question]`)
    }
    // Group-member quotes are NOT trusted teachers — "quoted ⇒ trusted"
    // holds only for the OWNER. Any whitelisted group member quoting the bot
    // used to direct-commit a pair that then answered every future customer.
    // Group quotes wait for the human review queue instead. The owner's own
    // quotes (DM, fromMe branch) keep the trusted "quoted" source.
    if (source === "group_quoted") {
        return queueForReview(q, a, sourceContext || "group quote — awaiting human review")
    }
    if (source === "quoted") return commitKnowledge(q, a)

    // source === "auto" — the owner's phone reply to a stored customer question
    if (!(await strongRelatedness(q, a))) {
        return queueForReview(q, a, `${sourceContext || source} [relatedness below direct-commit bar]`)
    }
    return commitKnowledge(q, a)
}

function bumpKnowledgeHit(id) {
    state.knowledgeHitCount++
    knowledgeDB.prepare("UPDATE knowledge SET uses = uses + 1 WHERE id = ?").run(id)
    const cached = state.knowledgeCacheById.get(id)
    if (cached) cached.uses = (cached.uses || 0) + 1
}

module.exports = {
    init, queueStartupNotice, drainStartupNotices,
    saveKnowledgeJSON, knowledgeJsonChanged,
    buildKnowledgeDB, refreshKnowledgeCache, computeEmbeddingsFor,
    refreshKnowledgeCacheEmbeddings, computeAllMissingEmbeddings,
    findBestReply, fuseConfidence,
    isGarbage, isFiller, isEcho, hasMinimumMeaningfulContent,
    isAnswerRelated, isTooSimilarToExisting, passesAllQualityGates,
    queueForReview, strongRelatedness,
    commitKnowledge, learn, bumpKnowledgeHit
}
