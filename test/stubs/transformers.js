"use strict"
/* Stub of @xenova/transformers for tests only — no model download.
   Provides a fake pipeline returning pseudo-embeddings so the semantic
   layer's code paths run without the ~100MB model. */
async function pipeline() {
    return async function fakeEmbed(text) {
        // deterministic pseudo-embedding based on text hash
        const dim = 384
        const arr = new Float32Array(dim)
        let h = 0
        for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 100000
        for (let i = 0; i < dim; i++) {
            h = (h * 1103515245 + 12345) % 2147483648
            arr[i] = ((h / 2147483648) * 2) - 1
        }
        // normalize
        let mag = 0
        for (let i = 0; i < dim; i++) mag += arr[i] * arr[i]
        mag = Math.sqrt(mag)
        for (let i = 0; i < dim; i++) arr[i] = arr[i] / mag
        return { data: arr }
    }
}
module.exports = { pipeline, env: { cacheDir: "" } }
