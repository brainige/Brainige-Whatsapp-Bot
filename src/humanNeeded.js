"use strict"
/* src/humanNeeded.js — 3-layer human-needed check. */

const { HUMAN_NEEDED_PATTERNS, HN_SEM_THRESHOLD } = require("./config")
const state = require("./state")
const { applyTypoMap, canonicalize, detectEmojiSentiment, hasCurrencySymbol, cosineEmbedding } = require("./text")
const { getEmbedding } = require("./embeddings")

function needsHumanRegex(msg) {
    const lowered = msg.toLowerCase()
    const typoed = applyTypoMap(lowered)
    // Every pattern is compiled case-insensitive ("i" flag in config),
    // so testing the raw text already covers the lowered copy — identical
    // verdicts with ~1/3 the regex executions. The typo-mapped copy is only
    // tested when the typo map actually changed something.
    const typoDiffers = typoed !== lowered
    for (const entry of HUMAN_NEEDED_PATTERNS) {
        if (entry.regex.test(msg) || (typoDiffers && entry.regex.test(typoed))) return entry.label
    }
    if (detectEmojiSentiment(msg) === "emotional") return "emotional_emoji"
    if (hasCurrencySymbol(msg)) return "currency_symbol"
    return null
}

async function needsHumanSemantic(msg, msgEmbedding) {
    if (state.hnExemplars.length === 0) return null
    const emb = msgEmbedding || await getEmbedding(canonicalize(applyTypoMap(msg)))
    if (!emb) return null
    let best = 0, bestLabel = null
    for (const ex of state.hnExemplars) {
        const sim = cosineEmbedding(emb, ex.embedding)
        if (sim > best) { best = sim; bestLabel = ex.label }
    }
    if (best >= HN_SEM_THRESHOLD) return bestLabel
    return null
}

async function needsHumanFull(msg, msgEmbedding) {
    const regexHit = needsHumanRegex(msg)
    if (regexHit) return { hit: true, layer: "regex", label: regexHit }
    const semHit = await needsHumanSemantic(msg, msgEmbedding)
    if (semHit) return { hit: true, layer: "semantic", label: semHit }
    return { hit: false, layer: null, label: null }
}

module.exports = { needsHumanRegex, needsHumanSemantic, needsHumanFull }
