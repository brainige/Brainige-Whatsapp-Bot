"use strict"
/* src/admin.js — admin commands (existing V6.5 set), notifications channel.

   Injected via init() to avoid circular imports:
     admin.init({ commitKnowledge, learn, reviewQueueCount, reviewNext,
                  reviewDelete, reviewDB, buildDigestText, computeAllMissingEmbeddings, refreshKnowledgeCache })
*/

const path = require("path")
const fs = require("fs-extra")

const { PATHS, VERSION, saveSettings, saveJSON } = require("./config")
const state = require("./state")
const { normalize, canonicalize } = require("./text")
const { getNumber } = require("./util")
const { isAdminChannel } = require("./notify")
const { logAdminActivity, logError } = require("./logging")

let deps = null
function init(d) { deps = d }

function setReviewCurrentId(id) { state.reviewCurrentId = id }

async function handleCommand(message, user, rawMsg) {
    if (!isAdminChannel(user, message)) return false
    const msg = rawMsg.trim()
    logAdminActivity(`[CMD] ${msg}`)

    const replyOrLog = async (text) => {
        logAdminActivity(`[REPLY] ${text}`)
        require("./tracking").preRegisterBotText(text)
        await message.reply(text)
        return true
    }

    if (msg === "!help") {
        return replyOrLog(
            `🤖 UTSAB/AVI v${VERSION} commands:\n` +
            `!pause !resume !train q|a !forget q\n` +
            `!blacklist n !whitelist n !learning on/off\n` +
            `!group_allow [id] !group_block [id]\n` +
            `!learn_allow n !learn_block n\n` +
            `!review !approve !reject !export_kb\n` +
            `!correct old|new\n` +
            `!backup !stats !context !clean_knowledge\n` +
            `!changet <chat|global> <seconds>\n` +
            `!dnd_set hh:mm hh:mm !dnd_off\n` +
            `!debug on/off !dryrun on/off !quiet on/off !digest\n` +
            `Version: v${VERSION}`
        )
    }
    if (msg === "!pause") {
        const until = Date.now() + state.settings.globalPauseDuration * 1000
        require("./pause").setGlobalPause(until)
        return replyOrLog(`⏸ Bot globally paused (${state.settings.globalPauseDuration}s).`)
    }
    if (msg === "!resume") {
        require("./pause").setGlobalPause(0)
        return replyOrLog("▶️ Bot resumed.")
    }
    if (msg.startsWith("!train ")) {
        const content = msg.slice(7).trim()
        const split = content.indexOf("|")
        if (split > 0) {
            const q = content.substring(0, split).trim()
            const a = content.substring(split + 1).trim()
            const ok = await deps.learn(q, a)
            return replyOrLog(ok ? `✅ Trained:\nQ: ${q}\nA: ${a}` : `⚠️ Entry rejected by quality filters.`)
        }
        return replyOrLog("⚠️ Format: !train question|answer")
    }
    if (msg.startsWith("!forget ")) {
        // Stored keys are normalize(canonicalize(q)) — the admin lookup used
        // plain normalize(), which keeps punctuation, so "!forget what's the
        // price?" silently removed 0 rows. Canonicalize the input to match.
        const target = normalize(canonicalize(msg.slice(8).trim()))
        const before = state.knowledge.entries.length
        state.knowledge.entries = state.knowledge.entries.filter(e => normalize(e.message) !== target)
        const removed = before - state.knowledge.entries.length
        deps.saveKnowledgeJSON(state.knowledge)
        deps.knowledgeDB.prepare("DELETE FROM knowledge WHERE message = ?").run(target)
        deps.refreshKnowledgeCache()   // rebuilds cache + word-index from DB truth (a manual splice would leave the word-index serving deleted entries)
        return replyOrLog(`🗑️ Removed ${removed} entr${removed === 1 ? "y" : "ies"}.`)
    }
    if (msg.startsWith("!blacklist ")) {
        const target = msg.slice(11).trim()
        if (target && !state.settings.blacklist.includes(target)) {
            state.settings.blacklist.push(target)
            saveSettings()
            return replyOrLog(`🚫 Blacklisted: ${target} (no reply, no learning — logging continues)`)
        }
        return replyOrLog(`ℹ️ Already blacklisted.`)
    }
    if (msg.startsWith("!whitelist ")) {
        const target = msg.slice(11).trim()
        state.settings.blacklist = state.settings.blacklist.filter(u => u !== target)
        saveSettings()
        return replyOrLog(`✅ Un-blacklisted: ${target}`)
    }
    if (msg.startsWith("!learn_block ")) {
        const target = msg.slice(13).trim()
        if (target && !state.settings.learnBlock.includes(target)) {
            state.settings.learnBlock.push(target)
            saveSettings()
            return replyOrLog(`⛔ Learning blocked from: ${target} (replies continue normally)`)
        }
        return replyOrLog(`ℹ️ Already learn-blocked.`)
    }
    if (msg.startsWith("!learn_allow ")) {
        const target = msg.slice(13).trim()
        state.settings.learnBlock = state.settings.learnBlock.filter(u => u !== target)
        saveSettings()
        return replyOrLog(`✅ Learning re-enabled from: ${target}`)
    }
    if (msg === "!learning on") {
        state.settings.learning = true; saveSettings()
        return replyOrLog("✅ Learning enabled.")
    }
    if (msg === "!learning off") {
        state.settings.learning = false; saveSettings()
        return replyOrLog("⛔ Learning disabled.")
    }
    if (msg.startsWith("!group_allow")) {
        let target = msg.slice(12).trim()
        if (!target && message.from.endsWith("@g.us")) target = message.from
        if (target) {
            if (!state.settings.groupWhitelist.includes(target)) {
                state.settings.groupWhitelist.push(target)
                state.settings.groupBlacklist = state.settings.groupBlacklist.filter(g => g !== target)
                saveSettings()
                return replyOrLog(`✅ Group allowed: ${target}`)
            }
            return replyOrLog(`ℹ️ Group already allowed.`)
        }
        return replyOrLog("⚠️ Specify a group ID or run this command inside a group.")
    }
    if (msg.startsWith("!group_block")) {
        let target = msg.slice(12).trim()
        if (!target && message.from.endsWith("@g.us")) target = message.from
        if (target) {
            if (!state.settings.groupBlacklist.includes(target)) {
                state.settings.groupBlacklist.push(target)
                state.settings.groupWhitelist = state.settings.groupWhitelist.filter(g => g !== target)
                saveSettings()
                return replyOrLog(`🚫 Group blocked: ${target}`)
            }
            return replyOrLog(`ℹ️ Group already blocked.`)
        }
        return replyOrLog("⚠️ Specify a group ID or run this this command inside a group.")
    }
    // --- V6.5 commands ---
    if (msg === "!review") {
        const row = deps.reviewNext()
        if (!row) return replyOrLog("📭 Review queue is empty.")
        setReviewCurrentId(row.id)
        return replyOrLog(
            `📋 Pending entry #${row.id} of ${deps.reviewQueueCount()}:\n\n` +
            `Q: ${row.question}\n` +
            `A: ${row.answer}\n` +
            `${row.context ? `Context: ${row.context}\n` : ""}` +
            `\nReply !approve to commit, !reject to discard.`
        )
    }
    if (msg === "!approve") {
        if (!state.reviewCurrentId) return replyOrLog("⚠️ Nothing shown yet — use !review first.")
        const row = deps.reviewDB.prepare("SELECT * FROM pending WHERE id = ?").get(state.reviewCurrentId)
        if (!row) { state.reviewCurrentId = null; return replyOrLog("⚠️ Entry no longer exists.") }
        const ok = await deps.commitKnowledge(row.question, row.answer)
        if (ok) {
            deps.reviewDelete(row.id)
            state.reviewCurrentId = null
            const next = deps.reviewNext()
            return replyOrLog(`✅ Committed to knowledge base.${next ? `\n\nNext pending (#${next.id}):\nQ: ${next.question}\nA: ${next.answer}\n!approve / !reject` : "\nQueue is now empty."}`)
        }
        return replyOrLog("⚠️ Commit failed (likely a duplicate of an existing entry) — use !reject to discard it.")
    }
    if (msg === "!reject") {
        if (!state.reviewCurrentId) return replyOrLog("⚠️ Nothing shown yet — use !review first.")
        deps.reviewDelete(state.reviewCurrentId)
        state.reviewCurrentId = null
        const next = deps.reviewNext()
        return replyOrLog(`🗑️ Discarded.${next ? `\n\nNext pending (#${next.id}):\nQ: ${next.question}\nA: ${next.answer}\n!approve / !reject` : "\nQueue is now empty."}`)
    }
    if (msg === "!export_kb") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const file = path.join(PATHS.LOG_BACKUPS, `kb_export_${stamp}.txt`)
        let out = `# Knowledge base export — UTSAB/AVI v${VERSION}\n# ${new Date().toISOString()}\n# Total entries: ${state.knowledgeCache.length}\n\n`
        for (const row of state.knowledgeCache) {
            out += `--- #${row.id} (uses: ${row.uses || 0}) ---\nQ: ${row.message}\nA: ${row.reply}\n\n`
        }
        try {
            fs.writeFileSync(file, out)
            return replyOrLog(`📤 Knowledge base exported:\n${state.knowledgeCache.length} entries → ${file}`)
        } catch (e) {
            return replyOrLog(`⚠️ Export failed: ${e.message}`)
        }
    }
    if (msg.startsWith("!correct ")) {
        const content = msg.slice(9).trim()
        const split = content.indexOf("|")
        if (split <= 0) return replyOrLog("⚠️ Format: !correct old text|new reply")
        const oldQ = normalize(canonicalize(content.substring(0, split).trim()))   // same canonical form as the stored keys
        const newA = content.substring(split + 1).trim()
        const row = deps.knowledgeDB.prepare("SELECT id FROM knowledge WHERE message = ?").get(oldQ)
        if (!row) return replyOrLog(`⚠️ No entry found for:\n"${oldQ.substring(0, 60)}"`)
        deps.knowledgeDB.prepare("UPDATE knowledge SET reply = ?, embedding = NULL WHERE id = ?").run(newA.substring(0, 500), row.id)
        for (const e of state.knowledge.entries) if (normalize(e.message) === oldQ) e.reply = newA.substring(0, 500)
        deps.saveKnowledgeJSON(state.knowledge)
        deps.refreshKnowledgeCache()
        const { getEmbedding } = require("./embeddings")
        const emb = await getEmbedding(oldQ)
        if (emb) {
            try { deps.knowledgeDB.prepare("UPDATE knowledge SET embedding = ? WHERE id = ?").run(require("./text").embeddingToBuffer(emb), row.id) } catch (e) { logError("admin.!correct", "embedding update after correction failed", e) }
            deps.refreshKnowledgeCacheEmbeddings()
        }
        return replyOrLog(`✅ Corrected:\nQ: ${oldQ}\nNew A: ${newA}`)
    }
    if (msg === "!backup") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const dir = path.join(PATHS.LOG_BACKUPS, `backup_${stamp}`)
        try {
            fs.ensureDirSync(dir)
            // WAL mode: checkpoint the live database into its main file first,
            // so the copy is complete (a raw copy of a WAL-mode .db alone can
            // miss the newest writes).
            try { deps.convoDB.pragma("wal_checkpoint(TRUNCATE)") } catch { }
            fs.copySync("./memory/knowledge.json", path.join(dir, "knowledge.json"))
            fs.copySync("./memory/settings.json", path.join(dir, "settings.json"))
            fs.copySync("./memory/conversations.db", path.join(dir, "conversations.db"))
            return replyOrLog(`💾 Backed up to ${dir}`)
        } catch (e) {
            return replyOrLog(`⚠️ Backup failed: ${e.message}`)
        }
    }
    if (msg.startsWith("!changet ")) {
        const parts = msg.slice(9).trim().split(/\s+/)
        if (parts.length < 2) return replyOrLog("⚠️ Format: !changet <chat_id | global> <seconds>")
        const secs = Number(parts[parts.length - 1])
        if (!Number.isFinite(secs) || secs < 0) return replyOrLog("⚠️ Seconds must be a number ≥ 0.")
        if (parts[0].toLowerCase() === "global" && parts.length === 2) {
            state.settings.globalPauseDuration = secs
            saveSettings()
            return replyOrLog(`✅ Global !pause duration set to ${secs}s.`)
        }
        const target = parts.slice(0, -1).join(" ")
        state.settings.customPauseDurations[target] = secs
        saveSettings()
        return replyOrLog(`✅ "utsab/avi" pause for ${target} set to ${secs}s.`)
    }
    if (msg.startsWith("!dnd_set")) {
        const parts = msg.slice(8).trim().split(/\s+/).filter(Boolean)
        if (parts.length !== 2) return replyOrLog("⚠️ Format: !dnd_set 23:00 07:00 (IST)")
        const start = require("./util").parseHHMM(parts[0]), end = require("./util").parseHHMM(parts[1])
        if (start === null || end === null) return replyOrLog("⚠️ Times must be HH:MM (24h, IST).")
        state.settings.dndSchedule = { enabled: true, start: parts[0], end: parts[1] }
        saveSettings()
        return replyOrLog(`🌙 Quiet hours set: ${parts[0]}–${parts[1]} IST. Replies paused inside the window; logging continues.`)
    }
    if (msg === "!dnd_off") {
        state.settings.dndSchedule.enabled = false
        saveSettings()
        return replyOrLog("☀️ Quiet hours disabled.")
    }
    if (msg === "!debug on" || msg === "!debug off") {
        state.settings.debug = msg.endsWith("on")
        saveSettings()
        return replyOrLog(state.settings.debug ? "🐞 Debug mode ON — extra console detail." : "🐞 Debug mode OFF.")
    }
    if (msg === "!dryrun on" || msg === "!dryrun off") {
        state.settings.dryRun = msg.endsWith("on")
        saveSettings()
        return replyOrLog(state.settings.dryRun ? "🧪 Dry-run mode ON — no replies will actually be sent; decisions logged only." : "🧪 Dry-run mode OFF — live replies active.")
    }
    if (msg === "!quiet on" || msg === "!quiet off") {
        // Quiet mode hides ONLY the per-message decision line in the terminal.
        // Errors, warnings, learning events, HUMAN NEEDED and all file logs stay.
        state.settings.quiet = msg.endsWith("on")
        saveSettings()
        return replyOrLog(state.settings.quiet ? "🤫 Quiet mode ON — per-message decision lines hidden from the terminal (everything else unchanged)." : "🤫 Quiet mode OFF — per-message decision lines visible again.")
    }
    if (msg === "!digest") {
        return replyOrLog(deps.buildDigestText())
    }
    if (msg === "!stats") {
        const kCount = state.knowledgeCache.length
        const eCount = state.knowledgeCache.filter(r => r.embedding != null).length
        const mCount = Object.keys(state.persistentMemory).length
        const dmCount = deps.convoDB.prepare("SELECT COUNT(*) as c FROM conversations WHERE user NOT LIKE '%@g.us'").get().c
        const grpCount = deps.convoDB.prepare("SELECT COUNT(*) as c FROM conversations WHERE user LIKE '%@g.us'").get().c
        const topRows = deps.knowledgeDB.prepare("SELECT message, uses FROM knowledge ORDER BY uses DESC LIMIT 3").all()
        const topStr = topRows.map(r => `  "${r.message.substring(0, 30)}..." (${r.uses}x)`).join("\n") || "  (none yet)"
        return replyOrLog(
            `📊 Bot Stats v${VERSION}\n──────────────────────\n` +
            `Knowledge entries  : ${kCount}\n` +
            `Embedded entries   : ${eCount}/${kCount}\n` +
            `Pending review     : ${deps.reviewQueueCount()}\n` +
            `Users in memory    : ${mCount}\n` +
            `Active contexts    : ${state.convoMemory.size}\n` +
            `DM messages        : ${dmCount}\n` +
            `Group messages     : ${grpCount}\n` +
            `LLM calls (session): ${state.llmCallCount}\n` +
            `Knowledge hits (s) : ${state.knowledgeHitCount}\n` +
            `Semantic model     : ${state.embedReady ? "✅ ready" : "⏳ loading"}\n` +
            `LM Studio          : ${state.llmAvailable ? "✅ online" : "⚠️ offline"}\n` +
            `Learning           : ${state.settings.learning ? "ON ✅" : "OFF ⛔"}\n` +
            `Blacklisted users  : ${state.settings.blacklist.length}\n` +
            `Learn-blocked      : ${state.settings.learnBlock.length}\n` +
            `Whitelisted groups : ${state.settings.groupWhitelist.length}\n` +
            `Blocked groups     : ${state.settings.groupBlacklist.length}\n` +
            `DND quiet hours    : ${state.settings.dndSchedule.enabled ? `${state.settings.dndSchedule.start}–${state.settings.dndSchedule.end} IST` : "off"}\n` +
            `Dry-run            : ${state.settings.dryRun ? "ON 🧪" : "off"}\n` +
            `Quiet              : ${state.settings.quiet ? "ON 🤫" : "off"}\n` +
            `Debug              : ${state.settings.debug ? "ON 🐞" : "off"}\n\n` +
            `Top used entries:\n${topStr}`
        )
    }
    if (msg === "!context") {
        let info = "Active conversational contexts:\n"
        for (const [u, ctx] of state.convoMemory.entries()) {
            const age = Math.round((Date.now() - ctx.lastActivity) / 1000)
            const profile = ctx.profile
            const tone = profile ? profile.tone : "?"
            info += `• ${getNumber(u)} — ${ctx.messages.length} msgs, ${age}s ago | tone: ${tone}\n`
        }
        return replyOrLog(info.trim() || "No active contexts.")
    }
    if (msg === "!clean_knowledge") {
        await replyOrLog("🧹 Cleaning knowledge base...")
        const before = state.knowledge.entries.length
        const filtered = []
        const toDelete = []
        let removed = 0
        for (const entry of state.knowledge.entries) {
            try {
                if (deps.isGarbage(entry.message) || deps.isGarbage(entry.reply) || deps.isFiller(entry.reply) ||
                    !deps.hasMinimumMeaningfulContent(entry.message) || !deps.hasMinimumMeaningfulContent(entry.reply)) {
                    toDelete.push(normalize(require("./text").canonicalize(entry.message)))
                    removed++; continue
                }
                filtered.push(entry)
            } catch { filtered.push(entry) }
        }
        state.knowledge.entries = filtered
        deps.saveKnowledgeJSON(state.knowledge)

        if (toDelete.length > 0) {
            const delStmt = deps.knowledgeDB.prepare("DELETE FROM knowledge WHERE message = ?")
            const delTx = deps.knowledgeDB.transaction(() => {
                for (const m of toDelete) delStmt.run(m)
            })
            delTx()
            deps.refreshKnowledgeCache()
        }

        return replyOrLog(`✅ Cleaned!\nBefore: ${before}\nAfter: ${filtered.length}\nRemoved: ${removed}`)
    }
    return false
}

module.exports = { init, handleCommand, setReviewCurrentId }
