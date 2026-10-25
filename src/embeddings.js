"use strict"
/* src/embeddings.js — Xenova embedding engine, cache, HN exemplar pre-embedding. */

const { HN_CONFIG, EMBED_CACHE_MAX } = require("./config")
const state = require("./state")
const { canonicalize, applyTypoMap } = require("./text")

/* EMBED_CACHE_MAX (25,000) lives in src/config.js with the other
   tunables. Each cached embedding is a 384-float Float32Array (~1.5KB in
   memory; ~2KB on disk in the v3 base64 format), so the worst case is
   ~38MB. The owner's knowledge.json is NEVER capped — this is only the
   machine-internal embedding cache. */

async function initEmbedder() {
    try {
        console.log("⏳ Loading semantic embedding model (all-MiniLM-L6-v2)...")
        const { pipeline, env } = await import("@xenova/transformers")
        env.cacheDir = "./memory/models"
        state.embedPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true })
        state.embedReady = true
        console.log("✅ Semantic embedding model ready.")
        state.embedReadyResolve(true)
        preEmbedHumanExemplars().catch(() => { })
    } catch (e) {
        console.error("❌ Failed to load embedding model:", e.message)
        state.embedReady = false
        state.embedReadyResolve(false)
    }
}

/* Cache key = "v2:" + SHA-256 of the FULL (trimmed, lowercased) text.
   The v2 prefix guarantees entries from the old 200-char-prefix scheme can
   never be looked up again. The model is fed the FULL text (capped only for
   CPU) — the model itself truncates at its own ~256-token window, which is
   far more generous than the old 200-char cut. */
const { cacheKey } = require("./embedCache")
const { EMBED_TEXT_MAX_CHARS } = require("./config")

function embedKey(text) {
    return cacheKey(String(text).trim().toLowerCase())
}

async function getEmbedding(text) {
    if (!text) return null
    const key = embedKey(text)
    if (state.embeddingCache.has(key)) return state.embeddingCache.get(key)
    if (!state.embedReady) return null
    try {
        const modelInput = String(text).trim().substring(0, EMBED_TEXT_MAX_CHARS)
        const output = await state.embedPipeline(modelInput, { pooling: "mean", normalize: true })
        const embedding = new Float32Array(output.data)
        if (state.embeddingCache.size >= EMBED_CACHE_MAX) {
            const evictCount = Math.ceil(EMBED_CACHE_MAX * 0.10)
            let removed = 0
            for (const oldest of state.embeddingCache.keys()) {
                state.embeddingCache.delete(oldest)
                if (++removed >= evictCount) break
            }
        }
        state.embeddingCache.set(key, embedding)
        return embedding
    } catch (e) {
        console.error("⚠️  Embedding error:", e.message)
        return null
    }
}

// Layer-2 exemplar store: [{ label, embedding }]
async function preEmbedHumanExemplars() {
    const exemplarMap = HN_CONFIG.exemplars || {}
    const out = []
    for (const [label, phrases] of Object.entries(exemplarMap)) {
        if (!Array.isArray(phrases)) continue
        for (const ph of phrases) {
            const emb = await getEmbedding(ph)
            if (emb) out.push({ label, embedding: emb })
        }
    }
    state.hnExemplars = out
    if (out.length > 0) console.log(`✅ Human-needed semantic layer ready (${out.length} exemplars embedded).`)
}

module.exports = { EMBED_CACHE_MAX, initEmbedder, getEmbedding, preEmbedHumanExemplars, embedKey }
