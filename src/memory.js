"use strict"
/* src/memory.js — convoMemory, user profiles, persistent memory, llm_context files,
   group name registry + auto-rename. */

const fs = require("fs-extra")
const path = require("path")

const { PATHS, CONVO_TTL, TOPIC_SHIFT_TTL, saveSettings } = require("./config")
const state = require("./state")
const { tokenize } = require("./text")
const { getNumber, sanitizeFolderName } = require("./util")

/* ── user personalization profile (English-only) ── */
function buildUserProfile(messages) {
    if (!messages || messages.length === 0) {
        return { tone: "casual", topKeywords: [], isAngry: false, isSad: false, messageCount: 0 }
    }
    const wordFreq = {}
    let angryCount = 0, sadCount = 0, formalCount = 0, playfulCount = 0

    for (const msg of messages) {
        if (/\b(rago|angry|frustrated|fight|hate)\b/i.test(msg)) angryCount++
        if (/\b(sad|crying|hurt|depressed)\b/i.test(msg)) sadCount++
        if (/\b(sir|madam|please|kindly|respect)\b/i.test(msg)) formalCount++
        if (/\b(xd|lol|hehe|haha|lmao)\b/i.test(msg)) playfulCount++
        for (const w of tokenize(msg, true)) if (w.length > 3) wordFreq[w] = (wordFreq[w] || 0) + 1
    }

    const n = messages.length
    const topKeywords = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w)
    const scores = { angry: angryCount, sad: sadCount, formal: formalCount, playful: playfulCount }
    const domTone = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
    const tone = domTone[1] > 0 ? domTone[0] : "casual"

    return { tone, topKeywords, isAngry: angryCount > 0, isSad: sadCount > 0, messageCount: n }
}

/* ── conversational memory ── */
const TOPIC_SHIFT_REGEX = /\b(anyway|by the way|btw|change topic|different topic|nevermind|forget that|stop that|new question|another topic|forget it|moving on)\b/i
const GREETING_RESET_REGEX = /^(hi|hello|hey|yo|greetings|good morning|good afternoon|good evening|hlo|hlw|hu|hy)\b/i

function restoreConvoMemoryFromDisk() {
    for (const [user, data] of Object.entries(state.persistentMemory)) {
        if (data && Array.isArray(data.history) && data.history.length > 0) {
            const msgs = data.history.slice(-10)
            // Profiles are built lazily on first read, not eagerly at boot.
            state.convoMemory.set(user, { messages: msgs, profile: null, lastActivity: 0 })
        }
    }
}

function updateConvoMemory(user, rawMsg) {
    const now = Date.now()
    if (!state.convoMemory.has(user)) {
        state.convoMemory.set(user, { messages: [], profile: null, lastActivity: now })
    }
    const ctx = state.convoMemory.get(user)

    let shouldReset = false
    if (ctx.lastActivity !== 0) {
        const elapsed = now - ctx.lastActivity
        if (elapsed > CONVO_TTL) shouldReset = true
        if (elapsed > TOPIC_SHIFT_TTL && GREETING_RESET_REGEX.test(rawMsg.trim())) shouldReset = true
    }
    if (TOPIC_SHIFT_REGEX.test(rawMsg)) shouldReset = true

    if (shouldReset) {
        ctx.messages = []; ctx.profile = null
        console.log(`🗑️  Context cleared for ${user.replace(/@.+/, "")}`)
    }

    ctx.messages.push(rawMsg)
    if (ctx.messages.length > 15) ctx.messages.shift()
    ctx.profile = null   // built lazily on the next actual read — same inputs, same output
    ctx.lastActivity = now
}

function getRecentMessages(user, n = 5) {
    const ctx = state.convoMemory.get(user)
    if (!ctx) return []
    if (Date.now() - ctx.lastActivity > CONVO_TTL) return []
    return ctx.messages.slice(-n - 1, -1)
}

function getUserProfile(user) {
    const ctx = state.convoMemory.get(user)
    if (!ctx) return null
    if (Date.now() - ctx.lastActivity > CONVO_TTL) return null
    // Built on first read per message cycle (updateConvoMemory nulls it)
    // — silent paths never pay for it. Same inputs → same output.
    if (!ctx.profile) ctx.profile = buildUserProfile(ctx.messages)
    return ctx.profile || null
}

function hasActiveContext(user) {
    const ctx = state.convoMemory.get(user)
    if (!ctx || ctx.messages.length < 2) return false
    return (Date.now() - ctx.lastActivity) < CONVO_TTL
}

function startConvoMemorySweeper() {
    setInterval(() => {
        const now = Date.now()
        for (const [user, ctx] of state.convoMemory.entries()) {
            if (now - ctx.lastActivity > CONVO_TTL * 3) state.convoMemory.delete(user)
        }
    }, 120000)
}

/* ── persistent memory ── */
const { saveJSONAsync } = require("./config")
const { logError } = require("./logging")

/* chat_memory.json is no longer rewritten on every message (that was a
   full-file synchronous write per incoming message). Changes are marked
   dirty here and flushed by the 30s timer (startFlushTimer) + on shutdown.
   The per-chat .txt logs and conversations.db still record every message
   immediately — that was the owner's explicit requirement. */
function updatePersistentMemory(user, rawMsg, intent) {
    if (!state.persistentMemory[user])
        state.persistentMemory[user] = { history: [], intent: null, lastSeen: 0 }
    state.persistentMemory[user].history.push(rawMsg)
    if (state.persistentMemory[user].history.length > 50) state.persistentMemory[user].history.shift()
    state.persistentMemory[user].intent = intent
    state.persistentMemory[user].lastSeen = Date.now()
    state.memoryDirty = true
}

/* Flush from the 30s timer. On failure the dirty flag STAYS set, so the
   next tick retries — one transient hiccup never silently drops memory. */
async function flushPersistentMemory() {
    if (!state.memoryDirty) return
    try {
        await saveJSONAsync(PATHS.MEMORY, state.persistentMemory)
        state.memoryDirty = false
    } catch (e) {
        logError("memory.flushPersistentMemory", "chat_memory.json flush failed — will retry next tick", e)
    }
}

/* One shared flush timer. Each store runs in its own try/catch, so a
   failure in one never skips the other. The processed-ID compaction is a
   no-op unless it is actually due (see tracking.js).
   The embedding cache rides the same cadence — no more synchronous
   full-file write on every learned entry. */
function startFlushTimer() {
    const { FLUSH_INTERVAL_MS } = require("./config")
    const { compactProcessedIds } = require("./tracking")
    const { flushEmbedCache } = require("./embedCache")
    setInterval(() => {
        flushPersistentMemory().catch(() => { })
        compactProcessedIds().catch(() => { })
        try { flushEmbedCache() } catch { }
    }, FLUSH_INTERVAL_MS)
}

/* ── Retention sweeps ───────────────────────────────────────────────────────────
   Chat LOGS grow forever (no size cap — the existing 6-month age archive
   stays). conversations.db keeps EVERYTHING forever. Media files are deleted
   after MEDIA_RETENTION_DAYS (the permanent chat-log line for every media
   message keeps the record: who, when, file name). chat_memory users
   inactive longer than CHAT_MEMORY_USER_TTL_DAYS are pruned. ── */
const { MEDIA_RETENTION_DAYS, CHAT_MEMORY_USER_TTL_DAYS } = require("./config")

function sweepMediaDir(dir, cutoffMs, counter) {
    try {
        if (!fs.existsSync(dir)) return
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name)
            let st
            try { st = fs.statSync(full) } catch { continue }
            if (st.isDirectory()) { sweepMediaDir(full, cutoffMs, counter); continue }
            if (st.mtimeMs < cutoffMs) {
                try { fs.removeSync(full); counter.count++ } catch { }
            }
        }
    } catch { }
}

function pruneInactivePersistentUsers() {
    const cutoff = Date.now() - CHAT_MEMORY_USER_TTL_DAYS * 86400000
    let n = 0
    for (const [u, d] of Object.entries(state.persistentMemory || {})) {
        if (!d || !d.lastSeen || d.lastSeen < cutoff) { delete state.persistentMemory[u]; n++ }
    }
    if (n > 0) state.memoryDirty = true
    return n
}

function runRetentionSweepNow() {
    try {
        const cutoff = Date.now() - MEDIA_RETENTION_DAYS * 86400000
        const counter = { count: 0 }
        sweepMediaDir(PATHS.MEDIA_CHATS, cutoff, counter)
        sweepMediaDir(PATHS.MEDIA_GROUPS, cutoff, counter)
        const prunedUsers = pruneInactivePersistentUsers()
        if (counter.count > 0 || prunedUsers > 0) {
            console.log(`🧹 Retention sweep: ${counter.count} media file(s) older than ${MEDIA_RETENTION_DAYS}d removed, ${prunedUsers} inactive chat_memory user(s) pruned. Records stay in the chat logs.`)
        }
    } catch (e) { logError("memory.runRetentionSweepNow", "retention sweep failed (will retry next cycle)", e) }
}

function startRetentionSweeper() {
    let lastRun = 0
    setInterval(() => {
        if (Date.now() - lastRun < 24 * 60 * 60 * 1000) return
        lastRun = Date.now()
        runRetentionSweepNow()
    }, 60 * 60 * 1000)   // hourly check, daily run
}

/* ── llm_context/ files ── */
const LLMCTX_WIPE_MS = 600000

function llmCtxDir(chatId) {
    return chatId.endsWith("@g.us") ? PATHS.LLM_CTX_GROUPS : PATHS.LLM_CTX_CHATS
}

function llmCtxFilePath(chatId, folderName) {
    const base = folderName || getNumber(chatId)
    return path.join(llmCtxDir(chatId), `${base}.txt`)
}

function appendLLMContext(chatId, role, text, folderName) {
    try {
        const fpath = llmCtxFilePath(chatId, folderName)
        const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        const label = role === "user" ? "USER" : role === "assistant" ? "BOT" : "YOU"
        const line = `[${ts}] ${label}: ${text}\n`
        fs.appendFileSync(fpath, line)
        state.llmCtxLastActivity.set(chatId, Date.now())
    } catch (e) { logError("memory.appendLLMContext", "LLM context append failed", e) }
}

function markLLMContextTopicShift(chatId, folderName) {
    try {
        const fpath = llmCtxFilePath(chatId, folderName)
        const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
        fs.appendFileSync(fpath, `[${ts}] --- TOPIC SHIFT ---\n`)
        state.llmCtxLastActivity.set(chatId, Date.now())
    } catch (e) { logError("memory.markLLMContextTopicShift", "LLM context topic-shift append failed", e) }
}

function wipeLLMContext(chatId, folderName) {
    try {
        const fpath = llmCtxFilePath(chatId, folderName)
        if (fs.existsSync(fpath)) fs.writeFileSync(fpath, "")
        state.llmCtxLastActivity.delete(chatId)
    } catch (e) { logError("memory.wipeLLMContext", "LLM context wipe failed", e, { quiet: true }) }
}

// V6.5 bug #4 lifecycle: every llm_context file is wiped on bot restart
function wipeAllLLMContextsOnStartup() {
    for (const dir of [PATHS.LLM_CTX_CHATS, PATHS.LLM_CTX_GROUPS]) {
        try {
            for (const f of fs.readdirSync(dir)) {
                if (f.endsWith(".txt")) { try { fs.writeFileSync(path.join(dir, f), "") } catch (e) { logError("memory.wipeAllLLMContextsOnStartup", "wipe failed for one file", e, { quiet: true }) } }
            }
        } catch (e) { logError("memory.wipeAllLLMContextsOnStartup", "context dir unreadable", e, { quiet: true }) }
    }
}

function startLLMCtxSweeper() {
    setInterval(() => {
        const now = Date.now()
        for (const [chatId, ts] of state.llmCtxLastActivity.entries()) {
            if (now - ts > LLMCTX_WIPE_MS) {
                const registryName = chatId.endsWith("@g.us") ? getRegisteredFolderName(chatId, null) : null
                wipeLLMContext(chatId, registryName)
            }
        }
    }, 60000)
}

/* ── group name registry + auto-rename ── */
function getRegisteredFolderName(groupId, currentDisplay) {
    if (!groupId || !groupId.endsWith("@g.us")) return null
    const registry = state.settings.groupNames || {}
    if (currentDisplay) {
        let clean = sanitizeFolderName(currentDisplay)
        const taken = new Set(Object.entries(registry).filter(([id]) => id !== groupId).map(([, v]) => v))
        let finalName = clean
        let suffix = 2
        while (taken.has(finalName)) finalName = `${clean}_${suffix++}`
        if (registry[groupId] !== finalName) {
            const oldName = registry[groupId]
            registry[groupId] = finalName
            saveSettings()
            if (oldName && oldName !== finalName) {
                renameGroupFolders(oldName, finalName)
                console.log(`📝 Group renamed: "${oldName}" → "${finalName}"`)
            }
        }
        return finalName
    }
    return registry[groupId] || null
}

function renameGroupFolders(oldName, newName) {
    for (const [dir, name] of [[PATHS.LOG_GROUPS, `${oldName}.txt`], [PATHS.LLM_CTX_GROUPS, `${oldName}.txt`]]) {
        const from = path.join(dir, name)
        if (fs.existsSync(from)) {
            try { fs.moveSync(from, path.join(dir, `${newName}.txt`)) } catch (e) { logError("memory.renameGroupFolders", "log/ctx rename failed", e) }
        }
    }
    const mediaFrom = path.join(PATHS.MEDIA_GROUPS, oldName)
    if (fs.existsSync(mediaFrom)) {
        try { fs.moveSync(mediaFrom, path.join(PATHS.MEDIA_GROUPS, newName)) } catch (e) { logError("memory.renameGroupFolders", "media folder rename failed", e) }
    }
}

module.exports = {
    buildUserProfile, TOPIC_SHIFT_REGEX, GREETING_RESET_REGEX,
    restoreConvoMemoryFromDisk, updateConvoMemory, getRecentMessages,
    getUserProfile, hasActiveContext, startConvoMemorySweeper,
    updatePersistentMemory, flushPersistentMemory, startFlushTimer,
    runRetentionSweepNow, startRetentionSweeper,
    llmCtxFilePath, appendLLMContext, markLLMContextTopicShift, wipeLLMContext,
    wipeAllLLMContextsOnStartup, startLLMCtxSweeper,
    getRegisteredFolderName, renameGroupFolders
}
