"use strict"
/* src/text.js — typo map, normalization, vectors, similarity, intent detection. */

const { PATHS, HUMAN_NEEDED_PATTERNS, INTENT_WEIGHTS, loadJSON } = require("./config")

/* ── typo map (externalized; query-time only, never at learn time) ── */
const TYPO_MAP = (() => {
    const raw = loadJSON(PATHS.TYPO, {})
    const out = {}
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("_")) continue
        if (typeof v === "string" && v.trim()) out[k.toLowerCase()] = v
    }
    if (Object.keys(out).length === 0) {
        out["hu"] = "hi"; out["hy"] = "hi"; out["u"] = "you"; out["r"] = "are"
        out["thx"] = "thanks"; out["pls"] = "please"; out["sry"] = "sorry"
    }
    return out
})()

function applyTypoMap(text) {
    return text.toLowerCase().split(/\s+/).map(w => TYPO_MAP[w] || w).join(" ")
}

/* ── word sets ── */
const STOP_WORDS = new Set([
    "a", "an", "the", "is", "it", "in", "on", "at", "to", "of", "for", "and", "or",
    "but", "not", "with", "this", "that", "was", "are", "be", "been", "by", "from",
    "as", "its", "will", "do", "did", "does", "so", "up", "if", "we", "he", "she",
    "they", "you", "i", "my", "your", "our", "their", "his", "her", "have", "had",
    "has", "can", "could", "should", "would", "may", "might", "shall", "than", "then",
    "am", "me", "us", "no", "yes", "yet", "too", "also", "just", "very", "all",
    "any", "each", "every", "here", "there", "where", "when", "what", "which",
    "who", "whom", "how", "out", "over", "into", "about", "being", "were", "more",
    "some", "only", "own", "same", "such", "nor", "get", "got", "still", "much",
    "na", "re", "ta", "te", "ke", "je", "se", "ba", "ei", "oi", "haa", "ha",
    "hm", "hmm", "ok", "okay", "to", "r", "ki", "o", "go", "toh", "nah", "ar",
    "tai", "ni", "naki", "eto", "oto", "koto", "sob", "shob", "ektu", "onek",
    "kintu", "tobe", "jodi", "tahole", "othoba", "ebong", "abr", "abar",
    "bhi", "naa", "haan", "ji", "aur", "par", "lekin", "agar", "phir",
    "woh", "yeh", "kuch", "sab", "bohot", "bahut", "thoda", "zyada", "bas",
    "matlab", "waise", "bilkul", "ekdam", "sirf", "magar", "isliye", "kyunki"
])

const EMOTIONAL_EMOJIS = new Set([
    "😢", "😭", "😔", "😞", "😤", "😠", "😡", "😟", "😫", "😩",
    "😰", "😨", "😱", "😲", "😖", "😣", "😕", "😑", "😬",
    "❤️", "💔", "💕", "💞", "💓", "💗", "🥰", "😍", "😘", "😚",
    "😿", "🤣", "😂", "🤦", "🤦‍♂️", "🤦‍♀️",
    "😒", "😏", "🙄", "😓", "😥",
    "😪", "😴", "🥱", "😷", "🤒", "🤕", "🤮", "🤢",
    "☠️", "💀", "👻", "😈",
    "🙏", "😇", "🥺", "😾", "💧", "⚡", "🔥", "💥", "⚠️", "🚫",
    "🔞", "📵", "🆘", "⛔", "❌", "❎"
])

const CURRENCY_SYMBOLS = /[$€£¥₹₽₩₪₦₨₱₡₲₴₸₺₻]/

function extractEmojis(text) {
    if (!text) return []
    return Array.from(text).filter(char => {
        const code = char.codePointAt(0)
        if (!code) return false
        return (code >= 0x1F300 && code <= 0x1F9FF) ||
            (code >= 0x1F600 && code <= 0x1F64F) ||
            (code >= 0x2600 && code <= 0x27BF) ||
            (code >= 0x1F680 && code <= 0x1F6FF) ||
            (code >= 0x2300 && code <= 0x23FF) ||
            (code >= 0x2100 && code <= 0x2B55)
    })
}

function detectEmojiSentiment(text) {
    const emojis = extractEmojis(text)
    if (emojis.length === 0) return null
    return emojis.some(e => EMOTIONAL_EMOJIS.has(e)) ? "emotional" : "normal"
}

function hasCurrencySymbol(text) { return CURRENCY_SYMBOLS.test(text) }

/* F4 (documented 2026-10-21; deliberately NOT merged): canonicalize is the
   COMPARISON cleaner — strips text to bare words (a-z0-9 + Bengali/Devanagari
   ranges) and removes emojis. Used ONLY where texts are compared (search,
   similarity, question-shape). */
function canonicalize(text) {
    if (!text) return ""
    let t = text.toString().toLowerCase()
    const emojis = extractEmojis(t)
    for (const e of emojis) t = t.replace(e, " ")
    t = t.replace(/[^a-z0-9\s\u0980-\u09FF\u0900-\u097F]/g, " ")
    t = t.replace(/\s+/g, " ").trim()
    return t
}

/* normalize is the STORAGE cleaner — gentler than canonicalize: keeps
   basic punctuation (: / . - ! ? ') so stored keys stay faithful to the
   original text. Used for DB keys, knowledge.json entries, embedding-cache
   keys, admin !forget/!correct lookups. Do NOT merge with canonicalize:
   different consumers, and merging would silently re-key the embedding
   cache and every stored lookup. */
function normalize(text) {
    return text
        .toString()
        .toLowerCase()
        .replace(/[^\w\s\u0980-\u09FF\u0900-\u097F:/.\-!?']/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function cleanText(text) { return canonicalize(text) }

function tokenize(text, removeStops = true) {
    return normalize(text)
        .split(" ")
        .filter(w => w.length > 1 && (!removeStops || !STOP_WORDS.has(w)))
}

function buildVector(text) {
    const words = tokenize(text, true)
    if (words.length === 0) return {}
    const freq = {}
    for (const w of words) freq[w] = (freq[w] || 0) + 1
    const total = words.length
    const v = {}
    for (const [w, count] of Object.entries(freq)) {
        const tf = count / total
        const idf = Math.log(2 + w.length / 3)
        v[w] = tf * idf
    }
    return v
}

function cosineLexical(a, b) {
    let dot = 0, magA = 0, magB = 0
    for (const k in a) {
        if (b[k]) dot += a[k] * b[k]
        magA += a[k] * a[k]
    }
    for (const k in b) magB += b[k] * b[k]
    magA = Math.sqrt(magA)
    magB = Math.sqrt(magB)
    if (!magA || !magB) return 0
    return dot / (magA * magB)
}

function jaccardSim(a, b) {
    const setA = new Set(tokenize(a, true))
    const setB = new Set(tokenize(b, true))
    return jaccardSimFromSets(setA, setB)
}

/* Same math as jaccardSim, but on PRE-COMPUTED token sets — the search
   loop reuses sets it already built instead of re-tokenizing both texts. */
function jaccardSimFromSets(setA, setB) {
    if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0
    let inter = 0
    for (const t of setA) if (setB.has(t)) inter++
    const union = setA.size + setB.size - inter
    return union === 0 ? 0 : inter / union
}

function cosineEmbedding(a, b) {
    if (!a || !b || a.length !== b.length) return 0
    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        magA += a[i] * a[i]
        magB += b[i] * b[i]
    }
    magA = Math.sqrt(magA)
    magB = Math.sqrt(magB)
    if (!magA || !magB) return 0
    return dot / (magA * magB)
}

function embeddingToBuffer(arr) { return Buffer.from(arr.buffer) }
function bufferToEmbedding(buf) {
    if (!buf) return null
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

function isNearDuplicate(text1, text2, threshold = 0.90) {
    const clean1 = canonicalize(text1)
    const clean2 = canonicalize(text2)
    if (clean1 === clean2) return true
    if (!clean1.length || !clean2.length) return false
    const words1 = new Set(clean1.split(/\s+/).filter(w => w.length > 1))
    const words2 = new Set(clean2.split(/\s+/).filter(w => w.length > 1))
    let intersection = 0
    for (const w of words1) if (words2.has(w)) intersection++
    const union = words1.size + words2.size - intersection
    return union === 0 ? false : intersection / union >= threshold
}

/* ── intent detection (English-only regex) ── */
function detectIntent(msg) {
    const raw = applyTypoMap(msg.toLowerCase())

    const rules = [
        {
            test: s => /\b(hello|hi+|hey+|yo+|hii+|sup|greetings|good morning|good night|good afternoon|good evening|howdy|what's up|wassup|how are you|hu+|hy|hlo|hlw)\b/.test(s),
            intent: "greeting"
        },
        {
            test: s => /\b(sorry|apologize|apologies|my bad|forgive me|pardon|excuse me|i was wrong|i apologize|my mistake|my fault)\b/.test(s),
            intent: "apology"
        },
        {
            test: s => /\b(angry|furious|frustrated|mad|upset|hate you|pissed|annoyed|irritated|livid|enraged|fed up|sick of|can't stand|pissed off)\b/.test(s),
            intent: "angry"
        },
        {
            test: s => /\b(sad|depressed|crying|hurt|heartbroken|pain|down|lonely|hopeless|worthless|miserable|devastated|broken|feel like dying|can't take it|feeling low|weeping)\b/.test(s),
            intent: "emotional"
        },
        {
            test: s => /\b(thanks|thank you|thank|ty|thx|thnks|thnku|thanku|thankss|tysm|tyvm|thankful|grateful|appreciated)\b/.test(s),
            intent: "thanks"
        },
        {
            test: s => /\b(bye|goodbye|ciao|see you|later|good night|gotta go|gtg|ttyl|take care|byebye|bbye|see ya|laters)\b/.test(s),
            intent: "bye"
        },
        {
            test: s => /\b(help|assist|problem|issue|fix|how do i|how to|support|trouble|stuck|error|not working|can you help|need help|help me|solution|solve|guidance)\b/.test(s),
            intent: "help"
        },
        {
            test: s => /(\?|what\b|when\b|where\b|why\b|who\b|how\b|which\b|tell me|explain|describe|could you|can you tell|do you know|any idea|wondering|curious|doubt|query|clarify)/.test(s),
            intent: "question"
        }
    ]

    for (const rule of rules) {
        if (rule.test(raw)) {
            const weight = INTENT_WEIGHTS[rule.intent]
            const conf = weight >= 0.88 ? "high" : "medium"
            return { intent: rule.intent, confidence: conf, intentWeight: weight }
        }
    }

    if (msg.trim().length < 5) {
        return { intent: "short", confidence: "low", intentWeight: INTENT_WEIGHTS.short }
    }
    return { intent: "chat", confidence: "low", intentWeight: INTENT_WEIGHTS.chat }
}

/* ── isQuestionLike — deterministic question-shape detector ──────────
   Gates learning: a pair is only learnable when the QUESTION side really
   looks like a question. English + romanized Bangla/Hindi aware, and it
   tolerates trailing emojis. Pure regex + the existing rule-based
   detectIntent — NEVER the LLM, so the verdict is reproducible. */

const QUESTION_TRAILING = /[\p{Extended_Pictographic}\s]+$/u
const QUESTION_WORDS_ANYWHERE = /\b(kya|kab|kaise|kahan|kyun|kaun|kothay|kothai|kobe|kemon|kivabe|kibhabe|keno|koto)\b/i
const QUESTION_PREFIX = /^(what|when|where|who|whom|whose|why|which|how|tell me|show me)\b/i
const QUESTION_AUX_PREFIX = /^(is|are|am|do|does|did|can|could|will|would|shall|should|may)\b/i

function isQuestionLike(text) {
    if (!text) return false
    const raw = String(text)
    const stripped = raw.trim().replace(QUESTION_TRAILING, "")
    if (stripped.endsWith("?")) return true
    if (detectIntent(raw).intent === "question") return true
    if (QUESTION_WORDS_ANYWHERE.test(stripped)) return true
    if (/^ki(\s|$)/i.test(stripped)) return true
    if (QUESTION_PREFIX.test(stripped)) return true
    if (QUESTION_AUX_PREFIX.test(stripped) && stripped.includes("?")) return true
    return false
}

module.exports = {
    TYPO_MAP, applyTypoMap, extractEmojis, detectEmojiSentiment, hasCurrencySymbol,
    canonicalize, normalize, cleanText, tokenize,
    buildVector, cosineLexical, jaccardSim, jaccardSimFromSets, cosineEmbedding,
    embeddingToBuffer, bufferToEmbedding, isNearDuplicate, detectIntent,
    isQuestionLike
}
