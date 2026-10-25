"use strict"
/* src/db.js — SQLite databases: conversations, knowledge, review queue. */

const Database = require("better-sqlite3")
const { PATHS, saveJSON } = require("./config")
const state = require("./state")
const { logError } = require("./logging")

const convoDB = new Database(PATHS.CONVO_DB)
convoDB.prepare(`
  CREATE TABLE IF NOT EXISTS conversations(
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user      TEXT,
    message   TEXT,
    direction TEXT DEFAULT 'in',
    timestamp INTEGER
  )
`).run()
convoDB.prepare("CREATE INDEX IF NOT EXISTS idx_convo_user_ts ON conversations(user, timestamp)").run()

let _knowledgeNeedsRebuild = true
const knowledgeDB = (() => {
    // V6.4 full-rebuild strategy: knowledge.db is emptied at startup and
    // rebuilt from knowledge.json (the editable source of truth).
    //
    // The old code DELETED the file. On Windows an antivirus/indexer/second
    // instance can hold it (EBUSY — 3 real occurrences in logs/errors.txt),
    // the delete failed quietly, the OLD database was then opened, and
    // INSERT OR IGNORE merged STALE rows back in: !forget-ed or edited answers
    // kept replying to customers. Now the file is OPENED and the table EMPTIED
    // with SQL — no file deletion required — and the empty state is VERIFIED
    // before the rebuild.
    // Fail-closed: if the table cannot be emptied, the bot REFUSES TO START
    // rather than serve a mixed brain. knowledge.json is never touched, so
    // nothing is lost — restart once the lock clears.
    //
    // If knowledge.db and knowledge.json are exactly similar, no rebuild:
    // the wipe+rebuild only happens when knowledge.json's CONTENT hash or
    // the table's row count no longer match the fingerprint of the last build
    // (stored in the meta table). On a warm boot the rebuild is skipped.
    // boot the table is provably identical to the JSON — the rebuild is
    // skipped entirely and startup drops from seconds to milliseconds.
    const fs = require("fs-extra")
    const { sha256File } = require("./util")
    const fatal = (e) => {
        const msg =
            "\n🚨 STARTUP REFUSED: knowledge.db could not be emptied for the fresh rebuild.\n" +
            "   Another program (antivirus, a DB viewer, or a second bot instance) is holding the file.\n" +
            "   Close it and start the bot again — knowledge.json is NOT affected, nothing is lost.\n" +
            `   Reason: ${e && e.message ? e.message : e}\n`
        try { logError("db.knowledgeDB", "knowledge.db wipe failed — refusing to start (stale rows would merge back)", e) } catch { }
        console.error(msg)
        process.exit(1)
    }
    let db
    try {
        db = new Database(PATHS.KNOW_DB)
    } catch (e) {
        // File exists but is not a valid SQLite database → remove + retry once.
        try { fs.unlinkSync(PATHS.KNOW_DB) } catch { }
        try { db = new Database(PATHS.KNOW_DB) } catch (e2) { fatal(e2) }
    }
    db.prepare(`
      CREATE TABLE IF NOT EXISTS knowledge(
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        message   TEXT UNIQUE,
        reply     TEXT,
        vector    TEXT,
        embedding BLOB,
        uses      INTEGER DEFAULT 0
      )
    `).run()
    db.prepare("CREATE INDEX IF NOT EXISTS idx_know_uses ON knowledge(uses DESC)").run()
    db.prepare("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)").run()
    try {
        const fileHash = sha256File(PATHS.KNOWLEDGE)
        const metaHash = db.prepare("SELECT value FROM meta WHERE key = 'build_hash'").get()
        const metaCount = db.prepare("SELECT value FROM meta WHERE key = 'build_count'").get()
        const rows = db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c
        _knowledgeNeedsRebuild =
            !metaHash || !metaCount || metaHash.value !== fileHash || Number(metaCount.value) !== rows
    } catch { _knowledgeNeedsRebuild = true }
    if (_knowledgeNeedsRebuild) {
        try {
            db.prepare("DELETE FROM knowledge").run()
        } catch (e) { fatal(e) }
        const remaining = db.prepare("SELECT COUNT(*) as c FROM knowledge").get().c
        if (remaining !== 0) fatal(new Error(`table still holds ${remaining} rows after DELETE`))
    }
    return db
})()
function getKnowledgeNeedsRebuild() { return _knowledgeNeedsRebuild }

const reviewDB = new Database(PATHS.REVIEW_DB)
reviewDB.prepare(`
  CREATE TABLE IF NOT EXISTS pending(
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    question  TEXT,
    answer    TEXT,
    context   TEXT,
    timestamp INTEGER
  )
`).run()

// WAL journal mode + NORMAL sync for all three databases — no disk-fsync on
// every message insert. Creates transient -wal/-shm sidecar files
// (checkpointed on clean close; !backup checkpoints explicitly).
// Crash-safety is preserved: SQLite recovers the WAL on open.
for (const dbw of [convoDB, knowledgeDB, reviewDB]) {
    try { dbw.pragma("journal_mode = WAL"); dbw.pragma("synchronous = NORMAL") } catch { }
}

function reviewQueueCount() {
    try { return reviewDB.prepare("SELECT COUNT(*) as c FROM pending").get().c } catch { return 0 }
}
function reviewNext() {
    try { return reviewDB.prepare("SELECT * FROM pending ORDER BY id ASC LIMIT 1").get() || null } catch { return null }
}
function reviewAdd(q, a, ctx) {
    try {
        // Duplicate suppression — the same question pending
        // twice never creates a second row (was: 10 asks = 10 rows + 10 notifications).
        const dup = reviewDB.prepare("SELECT id FROM pending WHERE question = ?").get(q)
        if (dup) return { id: dup.id, deduped: true }
        const info = reviewDB.prepare("INSERT INTO pending(question, answer, context, timestamp) VALUES(?, ?, ?, ?)")
            .run(q, a, ctx || "", Date.now())
        return { id: info.lastInsertRowid, deduped: false }
    } catch { return null }
}
function reviewDelete(id) {
    try { reviewDB.prepare("DELETE FROM pending WHERE id = ?").run(id); return true } catch { return false }
}

function saveConversation(user, msg, direction) {
    try {
        convoDB.prepare(
            "INSERT INTO conversations(user, message, direction, timestamp) VALUES(?, ?, ?, ?)"
        ).run(user, msg, direction || "in", Date.now())
    } catch (e) { logError("db.saveConversation", "conversation insert failed", e) }
}

function closeAllDatabases() {
    for (const [name, db] of [["conversations", convoDB], ["knowledge", knowledgeDB], ["review", reviewDB]]) {
        try { db.close() } catch (e) { console.error(`⚠️  Failed to close ${name}.db:`, e.message) }
    }
}

module.exports = {
    convoDB, knowledgeDB, reviewDB,
    getKnowledgeNeedsRebuild,
    reviewQueueCount, reviewNext, reviewAdd, reviewDelete,
    saveConversation, closeAllDatabases
}
