"use strict"
/* src/embedCache.js — content-hash-keyed embedding cache.

   Embeddings are pure functions of the question text, so they don't need
   the model to survive a restart. Cache them keyed by SHA-256 of the
   NORMALIZED question text into memory/embeddings_cache.json.

   - Same text → same hash → reuse embedding (no model call).
   - Edited QUESTION → new hash → fresh embedding computed (correct).
   - Edited REPLY only → question hash unchanged → embedding reused (correct).
   - Deleted/corrupt cache → just recomputes, self-heals. Not hand-edited.

   The file is now v3 format — each value is
   a base64-encoded Float32Array (~2KB) instead of a JSON array of floats
   (~7.7KB), so the same knowledge costs ~4x less disk and parses ~4x faster.
   The map is capped at EMBED_CACHE_MAX entries (newest kept, oldest dropped —
   recomputing one takes a fraction of a second, so nothing is ever lost), and
   flushes are debounced to the 30s timer + shutdown by the callers. Legacy
   files (v2 or older) are parked once as embeddings_cache.old.json and the
   cache rebuilds fresh — the C2 pattern, never deleted. */

const crypto = require("crypto")
const fs = require("fs-extra")

const { PATHS, EMBED_CACHE_MAX } = require("./config")

let cache = null            // Map<hash, base64-string> — loaded lazily
let dirty = false

function hashText(text) {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/* Every cache key is version-prefixed so legacy entries can NEVER
   be looked up by new code. v3 = full-text hash + base64 Float32 values. */
const KEY_PREFIX = "v3:"

function cacheKey(text) {
    return KEY_PREFIX + hashText(text)
}

/* v3 value codec — byte-identical round-trip for 384-float vectors. */
function encodeEmb(arr) {
    const f32 = arr instanceof Float32Array ? arr : Float32Array.from(arr)
    return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString("base64")
}
function decodeEmb(b64) {
    try {
        const buf = Buffer.from(String(b64), "base64")
        // readFloatLE avoids any Buffer-pool byteOffset alignment issue —
        // byte-exact for every value, no shared-pool views.
        const out = new Float32Array(Math.floor(buf.byteLength / 4))
        for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
        return out
    } catch { return null }
}

function loadEmbedCache() {
    if (cache !== null) return cache
    cache = new Map()
    try {
        if (fs.existsSync(PATHS.EMBED_CACHE)) {
            const data = JSON.parse(fs.readFileSync(PATHS.EMBED_CACHE, "utf8"))
            const entries = Object.entries(data)
            const hasV3 = entries.some(([h]) => h.startsWith(KEY_PREFIX))
            if (!hasV3 && entries.length > 0) {
                fs.moveSync(PATHS.EMBED_CACHE, PATHS.EMBED_CACHE + ".old.json", { overwrite: true })
                console.log("🔁 Old-format embedding cache parked as embeddings_cache.old.json — rebuilding with compact v3 values.")
            } else {
                // shape: { "v3:<hash>": "<base64 Float32Array>" }
                for (const [h, val] of entries) {
                    if (h.startsWith(KEY_PREFIX) && typeof val === "string" && decodeEmb(val)) cache.set(h, val)
                }
                console.log(`🔗 Embedding cache loaded (${cache.size} entries).`)
            }
        }
    } catch (e) {
        console.error("⚠️  Embedding cache unreadable, starting fresh:", e.message)
        cache = new Map()
    }
    return cache
}

function getCachedEmbedding(normMsg) {
    loadEmbedCache()
    const b64 = cache.get(cacheKey(normMsg))
    return b64 ? decodeEmb(b64) : null
}

function setCachedEmbedding(normMsg, embeddingArray) {
    loadEmbedCache()
    cache.set(cacheKey(normMsg), encodeEmb(embeddingArray))
    dirty = true
}

function flushEmbedCache() {
    if (!dirty || cache === null) return
    try {
        // Cap the FILE too — keep the newest EMBED_CACHE_MAX entries.
        if (cache.size > EMBED_CACHE_MAX) {
            let excess = cache.size - EMBED_CACHE_MAX
            for (const oldest of cache.keys()) {
                cache.delete(oldest)
                if (--excess <= 0) break
            }
        }
        const obj = {}
        for (const [h, b64] of cache.entries()) obj[h] = b64
        const tmp = PATHS.EMBED_CACHE + ".tmp"
        fs.writeFileSync(tmp, JSON.stringify(obj))
        fs.moveSync(tmp, PATHS.EMBED_CACHE, { overwrite: true })   // A3-style atomic
        dirty = false
    } catch (e) {
        console.error("⚠️  Embedding cache flush failed:", e.message)
    }
}

module.exports = { hashText, cacheKey, loadEmbedCache, getCachedEmbedding, setCachedEmbedding, flushEmbedCache }
