"use strict"
/* src/state.js — all shared mutable bot state. No imports (leaf module). */

const state = {
    // loaded singletons (set by config.js at startup)
    settings: null,
    knowledge: null,
    persistentMemory: null,

    // knowledge caches
    knowledgeCache: [],
    normalizedMsgIndex: new Set(),
    knowledgeCacheById: new Map(),
    knowledgeWordIndex: new Map(),   // meaningful word → Set(cache row) — book-index for big-KB search

    // embeddings
    embeddingCache: new Map(),   // key -> Float32Array
    contextEmbCache: new Map(), // chatId -> { ctx, vec, emb } — recent-context embedding, invalidated the moment the context string changes
    embedPipeline: null,
    embedReady: false,
    embedReadyResolve: null,
    embedReadyPromise: null,     // assigned below
    hnExemplars: [],

    // conversation memory / context
    convoMemory: new Map(),
    llmCtxLastActivity: new Map(),

    // pause / dnd
    pauseMap: new Map(),
    globalPauseUntil: 0,

    // LLM
    llmAvailable: false,
    llmCallCount: 0,

    // admin / client
    selfChatId: null,
    adminClient: null,

    // dedup + bot-sent tracking
    processed: new Set(),
    lastMessageMap: new Map(),
    botSentIds: new Map(),   // id -> expiry (was an unswept Set — pruned by the tracking sweeper now)
    botSentTexts: new Map(),

    // URL security
    urlCache: new Map(),
    vtBucket: { nextAllowedAt: 0 },   // strict spacing — one VirusTotal call per VT_MIN_INTERVAL (free-tier safe; was a burst-prone bucket)

    // counters / misc
    knowledgeHitCount: 0,
    reviewCurrentId: null,
    reconnectAttempts: 0,
    clientActive: true,
    hasEverReady: false,   // disconnects before the first ready are startup failures, not reconnects
    shuttingDown: false,
    memoryDirty: false      // chat_memory.json has unsaved changes
}

state.embedReadyPromise = new Promise(resolve => { state.embedReadyResolve = resolve })

module.exports = state
