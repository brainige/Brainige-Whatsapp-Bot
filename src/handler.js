"use strict"
/* src/handler.js — main message_create handler (V6.5 logic, modularized).

   Behavior preserved from botV6.5.js except the approved A2 change:
   - Unsafe/malicious links: contact gets NO VT warning reply (contacts must
     not see any backend link-check evidence). Admin is still notified,
     links.jsonl ledger is written.
   - The "too many links" guard reply is likewise removed from contact view. */

const fs = require("fs-extra")
const path = require("path")

const { PATHS, MEDIA_MAX_BYTES, LLM_DONT_KNOW,
    GROUP_CONFIDENCE_THRESHOLD, THRESHOLD_HIGH, THRESHOLD_MEDIUM } = require("./config")   // the decision thresholds now come from config (they existed there but were never used before)
const state = require("./state")
const { normalize, detectIntent, isQuestionLike } = require("./text")
const { getNumber, debugMode, dryRunMode, quietMode, getMediaSizeBytes, downloadedMediaBytes } = require("./util")
const { findBestReply, fuseConfidence, learn, bumpKnowledgeHit } = require("./knowledge")
const { needsHumanFull } = require("./humanNeeded")
const {
    TOPIC_SHIFT_REGEX, updateConvoMemory, updatePersistentMemory,
    hasActiveContext, getUserProfile, getRegisteredFolderName,
    appendLLMContext, markLLMContextTopicShift
} = require("./memory")
const { saveConversation } = require("./db")
const { logIncoming, logBotReply, logOutgoing, logHumanNeeded, logAdminActivity, logError } = require("./logging")
const { markProcessed, preRegisterBotText, trackBotReply, isBotSentText, getLastMessage, setLastMessage } = require("./tracking")
const { notifyAdmin, notifyAdminBatched } = require("./notify")
const sendGuard = require("./sendGuard")
const { extractURLs, stripURLs, checkURL, getContactName, appendLinkLedger, buildLinkEntry } = require("./security")
const { callLLM } = require("./llm")
const { checkAndTriggerPause, isUserPaused, isGloballyPaused, isInDND, getPauseDuration } = require("./pause")
const { bumpDigest, bumpDigestMessage, bumpDigestPausedSkip, bumpDigestSendGuard, trackNewContact } = require("./digest")
const { handleCommand } = require("./admin")

/* Wire the send guard's drop events → digest counters + a batched admin
   notice. A suppressed/dropped reply means that customer got silence — it is
   always visible to the owner, never silent. */
sendGuard.initDropLogger(({ chatId, reason }) => {
    if (reason === "identical_suppressed") bumpDigestSendGuard("identicalSuppressed")
    else bumpDigestSendGuard("rateDropped")
    notifyAdminBatched("Reply guard",
        reason === "identical_suppressed"
            ? `🔁 identical reply suppressed for ${getNumber(chatId)} (over the per-hour repeat cap)`
            : `⏱ rate-capped reply dropped for ${getNumber(chatId)} (waited past the queue age limit)`)
})

/* ── quick reply pool (single English pool) ── */
const QUICK_REPLY_POOL = {
    greeting: [
        "Hey! 👋 UTSAB/AVI is a bit busy right now. What's up?",
        "Hi there! I'm the bot. UTSAB/AVI will get back to you soon!",
        "Hello 😊 How can I help while UTSAB/AVI is away?"
    ],
    apology: [
        "Apology noted. Whether it's accepted depends on what happened — UTSAB/AVI will sort it out.",
        "It happens. Don't stress too much — UTSAB/AVI will talk to you soon."
    ],
    angry: [
        "Hey, take a breath. UTSAB/AVI will handle this personally. 🤝",
        "I hear you. UTSAB/AVI will reach out — hang tight."
    ],
    emotional: [
        "That sounds tough 💙 UTSAB/AVI genuinely cares and will talk to you soon.",
        "I hear you. Things get heavy sometimes. UTSAB/AVI will be with you shortly."
    ],
    thanks: ["You're welcome! 😊", "Anytime!", "No problem at all! 👍"],
    bye: ["Take care! 👋", "Goodbye! UTSAB/AVI will catch you later.", "Bye! Talk soon 😊"]
}

function getQuickReply(intentResult, hasCtx) {
    const { intent, confidence } = intentResult
    if (confidence !== "high") return null
    if (intent === "greeting" && hasCtx) return null
    const pool = QUICK_REPLY_POOL[intent]
    if (!pool) return null
    return pool[Math.floor(Math.random() * pool.length)]
}

/* ── reply composition ── */
function softenAssertiveLanguage(text) {
    return text
        .replace(/\bstop\b/gi, "please wait")
        .replace(/\bnever\b/gi, "try not to")
        .replace(/\bmust\b/gi, "should probably")
        .replace(/\bdon't\b/gi, "please try not to")
        .replace(/\bdo not\b/gi, "please try not to")
        .replace(/\bshut up\b/gi, "let's stay calm")
        .replace(/\bno way\b/gi, "i'm not sure that's possible")
        .replace(/\bwrong\b/gi, "perhaps not quite right")
}

function applyVariation(reply, uses) {
    if (!uses || uses <= 2) return reply
    const variations = [
        { pattern: /busy right now/i, options: ["a bit occupied at the moment", "caught up with something", "currently tied up"] },
        { pattern: /get back to you/i, options: ["reach out to you", "respond shortly", "text you back"] },
        { pattern: /talk to you soon/i, options: ["catch up with you shortly", "chat with you soon", "connect soon"] }
    ]
    for (const v of variations) {
        if (v.pattern.test(reply)) {
            const roll = Math.floor(Math.random() * (v.options.length + 1))
            if (roll < v.options.length) return reply.replace(v.pattern, v.options[roll])
        }
    }
    return reply
}

function composePersonalizedReply(reply, profile, uses) {
    let out = reply
    if (profile && profile.isSad) {
        const lower = out.toLowerCase()
        const alreadyEmpathetic = /^(hey,? hope|sorry to hear|oh,?|take care|bura mat|mon kharap|arey yaar)/.test(lower)
        if (!alreadyEmpathetic) {
            out = "Hey, hope you're doing okay. " + out
        }
    }
    if (profile && profile.isAngry) out = softenAssertiveLanguage(out)
    out = applyVariation(out, uses)
    return out
}

/* Recognizes the LLM's unsure-fallback reply (tolerating small case /
   punctuation drift, since the model may not echo the line byte-perfectly)
   so it can be replied to the contact but never learned. */
function isDontKnowReply(text) {
    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/g, "").trim()
    return norm(text) === norm(LLM_DONT_KNOW)
}

/* ── decision engine ── */
const DECISION = {
    REPLY_QUICK: "REPLY_QUICK",
    REPLY_KNOW: "REPLY_KNOW",
    REPLY_LLM: "REPLY_LLM",
    SILENT: "SILENT",
    HUMAN_NEEDED: "HUMAN_NEEDED"
}

function decide(rawMsg, user, intentResult, matchResult, isGroup, hnCheck, groupEngaged) {
    const { intent, confidence, intentWeight } = intentResult
    const { hybridScore } = matchResult
    const ctx = hasActiveContext(user)
    const profile = getUserProfile(user)
    // The SAME extractor the link-check path uses — a bare bit.ly/xyz
    // or evil-site.xyz now counts as a link here too (used to slip through).
    const hasUrl = extractURLs(rawMsg).length > 0
    const stripped = stripURLs(rawMsg).trim()

    if (hnCheck && hnCheck.hit) return { action: DECISION.HUMAN_NEEDED, reason: `${hnCheck.layer}:${hnCheck.label}` }
    if (hasUrl && stripped.length < 3) return { action: DECISION.SILENT, reason: "pure link" }

    if (isGroup) {
        if (!groupEngaged) return { action: DECISION.SILENT, reason: "group not engaged (whitelist/mention/quoted)" }
        const finalScore = fuseConfidence(hybridScore, intentWeight)
        if (finalScore >= GROUP_CONFIDENCE_THRESHOLD && matchResult.reply) return { action: DECISION.REPLY_KNOW, reason: `group fused=${finalScore.toFixed(3)}` }   // F2
        return { action: DECISION.SILENT, reason: `group under threshold (${finalScore.toFixed(3)})` }
    }

    if (rawMsg.trim().length < 4 && hybridScore < THRESHOLD_MEDIUM) {   // F2
        const hasQuickPool = QUICK_REPLY_POOL[intent]
        if (confidence !== "high" || !hasQuickPool) return { action: DECISION.SILENT, reason: "too short + no match" }
    }

    if (confidence === "high" && QUICK_REPLY_POOL[intent]) {
        if (intent === "greeting" && ctx) {
        } else if ((intent === "chat" || intent === "help") && profile && (profile.isAngry || profile.isSad)) {
        } else {
            return { action: DECISION.REPLY_QUICK, reason: `intent=${intent}` }
        }
    }

    const finalScore = fuseConfidence(hybridScore, intentWeight)

    if (finalScore >= THRESHOLD_HIGH) return { action: DECISION.REPLY_KNOW, reason: `fused=${finalScore.toFixed(3)}` }   // F2

    if (finalScore >= THRESHOLD_MEDIUM && (ctx || intent === "help" || intent === "question")) {   // F2
        return { action: DECISION.REPLY_KNOW, reason: `fused=${finalScore.toFixed(3)}+ctx` }
    }

    if (state.llmAvailable) return { action: DECISION.REPLY_LLM, reason: `fallback llm (fused=${finalScore.toFixed(3)})` }

    return { action: DECISION.SILENT, reason: `fused=${finalScore.toFixed(3)} low` }
}

/* ── group gating ── */
async function shouldProcessGroupMessage(message, rawBody) {
    const groupId = message.from
    if (state.settings.groupBlacklist.includes(groupId)) return false
    if (!state.settings.groupWhitelist.includes(groupId)) return false
    if (/\butsab\b|\bavi\b/i.test(rawBody)) return true
    if (message.hasQuotedMsg) {
        try {
            const quoted = await message.getQuotedMessage()
            if (quoted && quoted.fromMe) return true
        } catch (e) { logError("handler.shouldProcessGroupMessage", "quoted message read failed", e) }
    }
    return false
}

function isGroupLearnEnabled(groupId) {
    return state.settings.groupWhitelist.includes(groupId) &&
        !state.settings.groupBlacklist.includes(groupId)
}

/* ── main handler ── */
async function onMessage(message) {
    try {
        if (!message.body && !message.hasMedia) return

        const id = message.id?._serialized
        if (!id || state.processed.has(id)) return
        markProcessed(id)

        const rawBody = message.body || ""

        /* ── YOUR OWN MESSAGES (fromMe = true) ───────────── */
        if (message.fromMe) {
            const chatPartner = message.to || message.from
            const isBotMsg = state.botSentIds.has(id) || isBotSentText(rawBody) || rawBody.trim().startsWith("QUICK REPLY :")

            if (state.selfChatId && chatPartner === state.selfChatId) {
                if (isBotMsg) {
                    state.botSentIds.delete(id)
                    logAdminActivity(`[SELF-CHAT BOT] ${rawBody}`)
                } else if (rawBody.trim().startsWith("!")) {
                    logAdminActivity(`[SELF-CHAT CMD] ${rawBody}`)
                    await handleCommand(message, chatPartner, rawBody)
                } else {
                    logAdminActivity(`[SELF-CHAT IN] (non-command) ${rawBody}`)
                }
                return
            }

            if (isBotMsg) {
                state.botSentIds.delete(id)
            } else {
                let ownGroupName = null
                if (chatPartner.endsWith("@g.us")) {
                    try {
                        const chat = await message.getChat()
                        if (chat && chat.name) ownGroupName = getRegisteredFolderName(chatPartner, chat.name)
                    } catch { ownGroupName = getRegisteredFolderName(chatPartner, null) }
                }

                logOutgoing(chatPartner, rawBody, ownGroupName)
                const cleanOutgoing = rawBody.startsWith("QUICK REPLY : ") ? rawBody.slice(14).trim() : rawBody
                saveConversation(chatPartner, cleanOutgoing, "out")
                appendLLMContext(chatPartner, "YOU", cleanOutgoing, ownGroupName)
                if (state.settings.learning && rawBody.trim().length >= 3 && !chatPartner.endsWith("@g.us") &&
                    !state.settings.blacklist.includes(chatPartner) && !state.settings.learnBlock.includes(chatPartner)) {
                    if (message.hasQuotedMsg) {
                        try {
                            const quoted = await message.getQuotedMessage()
                            if (quoted && quoted.body && quoted.body.trim().length > 2) {
                                // Quoted replies are anchored by the quote itself — trusted source.
                                await learn(quoted.body.trim(), rawBody.trim(), false, 1.0, "owner quoted reply", "quoted")
                            }
                        } catch (e) { logError("handler.onMessage", "owner quoted-message read failed", e) }
                    } else {
                        // Your manual reply pairs with the customer's stored question.
                        // (Your own messages no longer overwrite the pending-question slot —
                        //  the old joke→"lol" garbage source is gone.)
                        const pending = getLastMessage(chatPartner)
                        if (pending && isQuestionLike(pending)) {
                            await learn(pending, rawBody, false, 1.0, "owner phone reply", "auto")
                        }
                    }
                }
            }
            return
        }

        /* ── INCOMING (fromMe = false) ───────────────────── */
        const user = message.from
        const isGroup = user.endsWith("@g.us")

        let groupName = null
        if (isGroup) {
            try {
                const chat = await message.getChat()
                if (chat && chat.name) groupName = getRegisteredFolderName(user, chat.name)
            } catch { groupName = getRegisteredFolderName(user, null) }
        }

        let replyToLabel = null
        if (isGroup && message.hasQuotedMsg) {
            try {
                const quoted = await message.getQuotedMessage()
                if (quoted) {
                    const qAuthor = quoted.fromMe ? "BOT" : (quoted.author || quoted.from || "").replace(/@.+/, "")
                    replyToLabel = `${qAuthor}: ${(quoted.body || "").substring(0, 40)}`
                }
            } catch (e) { logError("handler.onMessage", "quoted read for reply-label failed", e) }
        }

        // Logging is UNCONDITIONAL for all incoming
        if (message.hasMedia) {
            try {
                // Cap media at MEDIA_MAX_BYTES (20MB). One
                // huge file must never eat RAM or disk. WhatsApp reports the
                // size before download when it can — oversized media is then
                // skipped ENTIRELY; otherwise the size is checked after
                // download but BEFORE the (memory-doubling) save. Either way
                // the message is still logged + still routed to HUMAN_NEEDED.
                const fmtMB = b => `${(b / 1048576).toFixed(1)}MB`
                const sizeHint = getMediaSizeBytes(message)
                if (sizeHint != null && sizeHint > MEDIA_MAX_BYTES) {
                    logIncoming(user, rawBody || "[no caption]", `too_large_${fmtMB(sizeHint)}_skipped`, isGroup ? groupName : undefined, replyToLabel)
                    console.log(`⚠️  Media from ${getNumber(user)} skipped — ${fmtMB(sizeHint)} is over the ${fmtMB(MEDIA_MAX_BYTES)} cap (not downloaded).`)
                } else {
                    const media = await message.downloadMedia()
                    if (media && media.data) {
                        const bytes = downloadedMediaBytes(media)   // exact library-reported size when available, else base64 estimate
                        if (bytes > MEDIA_MAX_BYTES) {
                            logIncoming(user, rawBody || "[no caption]", `too_large_${fmtMB(bytes)}_not_saved`, isGroup ? groupName : undefined, replyToLabel)
                            console.log(`⚠️  Media from ${getNumber(user)} downloaded but NOT saved — ${fmtMB(bytes)} is over the ${fmtMB(MEDIA_MAX_BYTES)} cap.`)
                        } else {
                            const ext = (media.mimetype || "").split("/")[1]?.split(";")[0] || "bin"
                            const mediaDir = isGroup ? path.join(PATHS.MEDIA_GROUPS, groupName || getNumber(user)) : path.join(PATHS.MEDIA_CHATS, getNumber(user))
                            fs.ensureDirSync(mediaDir)
                            const fname = `${getNumber(user)}_${Date.now()}.${ext}`
                            fs.writeFileSync(path.join(mediaDir, fname), Buffer.from(media.data, "base64"))
                            logIncoming(user, rawBody || "[no caption]", `${fname}`, isGroup ? groupName : undefined, replyToLabel)
                        }
                    } else {
                        logIncoming(user, rawBody || "[media received]", "download_failed", isGroup ? groupName : undefined, replyToLabel)
                    }
                }
            } catch {
                logIncoming(user, rawBody || "[media]", "error", isGroup ? groupName : undefined, replyToLabel)
            }
        } else {
            logIncoming(user, rawBody, null, isGroup ? groupName : undefined, replyToLabel)
        }

        const isBlacklisted = !isGroup && state.settings.blacklist.includes(user)
        const isLearnBlocked = !isGroup && state.settings.learnBlock.includes(user)

        if (isBlacklisted) {
            saveConversation(user, rawBody, "in")
            bumpDigestMessage()
            return
        }

        // any non-text message type → immediate HUMAN_NEEDED
        const isNonText = message.hasMedia || message.type === "location" || message.type === "contact" ||
            (message.type && message.type !== "chat" && message.type !== "buttons_response")
        if (isNonText) {
            if (!isGroup) checkAndTriggerPause(user, rawBody || "")   // DM-only, addressable trigger
            saveConversation(user, rawBody || "[media]", "in")
            appendLLMContext(user, "USER", rawBody || "[media]", isGroup ? groupName : undefined)
            updateConvoMemory(user, rawBody || "[media]")
            updatePersistentMemory(user, rawBody || "[media]", "chat")
            bumpDigestMessage()
            logHumanNeeded(user, rawBody || "[media]", "media/message-type")
            bumpDigest(null, "media")
            if (!isGroup || isGroupLearnEnabled(user)) {
                // Coalesced — one 5-minute summary instead of one message per media item
                notifyAdminBatched("Media needs you", `👀 Media/voice/document from ${getNumber(user)}${isGroup ? ` in ${groupName || "group"}` : ""} → HUMAN_NEEDED`)
            }
            return
        }

        saveConversation(user, rawBody, "in")
        appendLLMContext(user, "USER", rawBody, isGroup ? groupName : undefined)
        bumpDigestMessage()
        trackNewContact(user)

        const groupEngaged = isGroup ? await shouldProcessGroupMessage(message, rawBody) : true
        const urls = (isGroup && !groupEngaged) ? [] : extractURLs(rawBody)

        // A2 (approved): link checks are INVISIBLE to contacts.
        // - >3 links: original guard kept (protects the VT rate limit) but the
        //   contact gets NO warning reply; each URL is ledgered "not_checked".
        // - Unsafe links: no contact-facing warning; admin gets the flag,
        //   ledger marks "malicious", human_needed log records it.
        if (urls.length > 3) {
            const senderJid = message.author ? (message.author.includes("@") ? message.author : `${message.author}@c.us`) : user
            const name = await getContactName(senderJid)
            for (const url of urls) {
                appendLinkLedger(buildLinkEntry(url, senderJid, name, isGroup ? "group" : "dm", groupName, "not_checked"))
            }
            notifyAdmin(`⚠️ ${urls.length} links in one message from ${getNumber(senderJid)}${isGroup ? ` in ${groupName || "group"}` : ""} — skipped scanning (limit 3), all logged to links.jsonl as not_checked.`)
            logHumanNeeded(user, rawBody, "too_many_links")
            bumpDigest(null, "too_many_links")
            return
        }
        if (urls.length > 0) {
            // The sender is resolved ONCE per message (was once per
            // link), and all links are checked in parallel — each still spaced
            // strictly by the VT rate limiter, so the free-tier quota holds.
            const senderJid = message.author ? (message.author.includes("@") ? message.author : `${message.author}@c.us`) : user
            const name = await getContactName(senderJid)
            const sourceLabel = `${getNumber(senderJid)}${isGroup ? ` in ${groupName || "group"}` : ""}`
            const verdicts = await Promise.all(urls.map(url =>
                checkURL(url, sourceLabel, senderJid, name, isGroup ? "group" : "dm", groupName)))
            if (verdicts.some(v => !v)) {
                logHumanNeeded(user, rawBody, "unsafe_link")
                bumpDigest(null, "unsafe_link")
                return   // stop processing this message (no contact reply)
            }
        }

        const msgStripped = stripURLs(rawBody).trim()   // same extractor as the link path
        if (urls.length > 0 && msgStripped.length < 3) return

        const msg = normalize(rawBody)
        if (!msg || msg.length < 2) return

        // Admin commands (admin JID or self-chat, incoming side)
        if (await handleCommand(message, user, rawBody)) return

        const pauseTriggered = isGroup ? false : checkAndTriggerPause(user, rawBody)   // DM-only

        const intentResult = detectIntent(msg)
        const { intent } = intentResult

        if (TOPIC_SHIFT_REGEX.test(rawBody)) markLLMContextTopicShift(user, isGroup ? groupName : undefined)

        updateConvoMemory(user, rawBody)
        updatePersistentMemory(user, rawBody, intent)

        // C1 learning — quoted replies only for groups (the quote anchors the pair).
        // DM sequential learning is REMOVED: a customer's messages never pair with
        // each other. In DMs the incoming message only HOLDS the pending-question
        // slot; learning happens when the OWNER replies from the phone (fromMe branch).
        const groupLearnOK = isGroup ? isGroupLearnEnabled(user) : true
        if (isGroup && state.settings.learning && !isLearnBlocked && groupLearnOK &&
            urls.length === 0 && msgStripped.length > 4 &&
            intent !== "greeting" && intent !== "short" && intent !== "bye" && message.hasQuotedMsg) {
            try {
                const quotedMsg = await message.getQuotedMessage()
                if (quotedMsg && quotedMsg.fromMe && quotedMsg.body && quotedMsg.body.trim().length > 2) {
                    // Group members are not trusted teachers — the pair goes to
                    // the review queue, never a direct commit.
                    const ok = await learn(quotedMsg.body.trim(), rawBody.trim(), false, 1.0, `group reply in ${groupName || user}`, "group_quoted")
                    if (ok) console.log(`👥 GROUP REPLY QUEUED FOR REVIEW in ${groupName || user}: "${quotedMsg.body.substring(0, 30)}" → "${rawBody.substring(0, 30)}"`)
                }
            } catch (e) { logError("handler.onMessage", "group quoted-message read failed", e) }
        }
        if (!isGroup && !isLearnBlocked && rawBody.trim().length >= 3 &&
            intent !== "greeting" && intent !== "short" && intent !== "bye") {
            setLastMessage(user, rawBody)   // holds the pending question for the owner's phone reply
        }

        if (pauseTriggered || isUserPaused(user) || isGloballyPaused() || isInDND()) {
            bumpDigestPausedSkip()   // the daily digest shows what went unanswered
            if (pauseTriggered) {
                notifyAdmin(`⏸ Replies paused for ${getNumber(user)} for ${Math.round(getPauseDuration(user) / 1000)}s — you were addressed by name. Logging & learning continue.`)
            }
            if (debugMode()) console.log(`🔇 Reply suppressed for ${getNumber(user)} (pause/DND) — logging/learning continue`)
            return
        }

        /* ── KNOWLEDGE SEARCH + HUMAN-CHECK ─────────────── */
        const t0 = Date.now()
        // A non-engaged group's decision is SILENT regardless of the
        // search result (owner choice 2026-10-23) — skip the scan + context
        // embedding there; the input embedding is still computed inside so the
        // HN flagging stays byte-identical.
        const matchResult = (isGroup && !groupEngaged)
            ? await findBestReply(msg, user, { light: true })
            : await findBestReply(msg, user)
        const tMatch = Date.now() - t0
        const hnCheck = await needsHumanFull(rawBody, matchResult.inputEmb)
        const tHn = Date.now() - t0 - tMatch
        const decision = decide(rawBody, user, intentResult, matchResult, isGroup, hnCheck, groupEngaged)

        const activeCtx = hasActiveContext(user)
        const profile = getUserProfile(user)

        if (debugMode()) {
            console.log(`🐞 [${getNumber(user)}] debug detail:`)
            if (matchResult.debugTop3) console.log(`   top-3 KB: ${matchResult.debugTop3.join(" | ")}`)
            console.log(`   hybrid:${matchResult.hybridScore.toFixed(3)} fused:${fuseConfidence(matchResult.hybridScore, intentResult.intentWeight).toFixed(3)} hn:${hnCheck.hit ? hnCheck.label : "no"}`)
            console.log(`   timing: kbSearch=${tMatch}ms humanCheck=${tHn}ms`)
        }
        /* This is the ONLY unconditional per-message console write — on a
           busy Windows terminal each print blocks the event loop until drawn.
           !quiet on hides exactly this line; errors, warnings, learning
           events, HUMAN NEEDED, and all file logging are unaffected. */
        if (!quietMode()) console.log(
            `[${getNumber(user).padEnd(12)}] ` +
            `intent:${intent.padEnd(10)} conf:${intentResult.confidence.padEnd(7)} ` +
            `hybrid:${matchResult.hybridScore.toFixed(3)} ` +
            `fused:${fuseConfidence(matchResult.hybridScore, intentResult.intentWeight).toFixed(3)}` +
            ` match:"${(matchResult.reply || "").substring(0, 40).replace(/\n/g, " ")}"` +
            ` → ${decision.action} (${decision.reason})`
        )

        /* ── EXECUTE DECISION ────────────────────────────── */
        /* The actual send + ALL post-send bookkeeping go through the send
           guard (pacing, hourly cap, queue-with-stale-drop, identical-text
           suppression). Replies stay INSTANT in the normal case — the guard
           only bounds volume. onSent runs only when the reply really goes
           out, so digest counters and the LLM learning pairing stay truthful
           for queued / dropped replies. */
        const sendOrDryRun = async (fullReply, opts) => {
            if (dryRunMode()) {
                console.log(`🧪 DRY-RUN — would send to ${getNumber(user)}:\n${fullReply}`)
                logAdminActivity(`[DRY-RUN] to ${getNumber(user)}: ${fullReply}`)
                if (opts && opts.onSent) opts.onSent()
                return null
            }
            preRegisterBotText(fullReply)
            sendGuard.guardCustomerReply(user, fullReply, async () => {
                const sent = await message.reply(fullReply)
                trackBotReply(sent, fullReply)
                logBotReply(user, fullReply, isGroup ? groupName : undefined)
                const cleanReplyForDb = fullReply.slice(14).trim()
                saveConversation(user, cleanReplyForDb, "out")
                appendLLMContext(user, "BOT", cleanReplyForDb, isGroup ? groupName : undefined)
                if (opts && opts.onSent) opts.onSent()
            })
            return null
        }

        switch (decision.action) {

            case DECISION.HUMAN_NEEDED: {
                logHumanNeeded(user, rawBody, decision.reason)
                bumpDigest(null, decision.reason.includes(":") ? decision.reason.split(":")[1] : decision.reason)
                break
            }

            case DECISION.REPLY_QUICK: {
                const quickText = getQuickReply(intentResult, activeCtx)
                if (quickText) {
                    await sendOrDryRun(`QUICK REPLY : ${quickText}`, { onSent: () => bumpDigest("quickReplies") })
                } else if (matchResult.reply &&
                    fuseConfidence(matchResult.hybridScore, intentResult.intentWeight) >= THRESHOLD_MEDIUM) {   // F2
                    const personalized = composePersonalizedReply(matchResult.reply, profile, matchResult.uses)
                    await sendOrDryRun(`QUICK REPLY : ${personalized}`, { onSent: () => { bumpDigest("kbReplies"); bumpKnowledgeHit(matchResult.id) } })
                }
                break
            }

            case DECISION.REPLY_KNOW: {
                const { reply } = matchResult
                if (reply) {
                    const personalized = composePersonalizedReply(reply, profile, matchResult.uses)
                    await sendOrDryRun(`QUICK REPLY : ${personalized}`, { onSent: () => { bumpDigest("kbReplies"); bumpKnowledgeHit(matchResult.id) } })
                } else {
                    logHumanNeeded(user, rawBody, "score ok but no reply object")
                }
                break
            }

            case DECISION.REPLY_LLM: {
                const llmResult = await callLLM(rawBody, user, isGroup ? groupName : undefined)
                if (debugMode()) console.log(`   llm: latency=${llmResult.latency}ms needsHuman:${llmResult.needsHuman}`)
                if (llmResult.needsHuman) {
                    logHumanNeeded(user, rawBody, "llm_self_flag")
                    bumpDigest(null, "llm_self_flag")
                    break
                }
                if (llmResult.text) {
                    // The learn() pairing + digest only fire when the reply
                    // really goes out (send-guard onSent) — a queued or dropped reply
                    // must never pair with a message it never actually answered.
                    await sendOrDryRun(`QUICK REPLY : ${llmResult.text}`, {
                        onSent: () => {
                            bumpDigest("llmReplies")
                            // The unsure-fallback line is NOT knowledge — reply to
                            // the contact, but never queue it for review/learning.
                            if (!isDontKnowReply(llmResult.text)) {
                                learn(rawBody, llmResult.text, true, matchResult.hybridScore, `LLM reply, hybrid=${matchResult.hybridScore.toFixed(3)}`)
                            }
                        }
                    })
                } else {
                    const finalScore = fuseConfidence(matchResult.hybridScore, intentResult.intentWeight)
                    if (finalScore >= THRESHOLD_MEDIUM && (activeCtx || intent === "help" || intent === "question") && matchResult.reply) {   // F2
                        const personalized = composePersonalizedReply(matchResult.reply, profile, matchResult.uses)
                        await sendOrDryRun(`QUICK REPLY : ${personalized}`)
                        bumpDigest("kbReplies")
                        bumpKnowledgeHit(matchResult.id)
                    }
                }
                break
            }

            case DECISION.SILENT:
            default:
                break
        }

    } catch (err) {
        console.error("❌ HANDLER ERROR:", err.message)
        console.error(err.stack)
    }
}

module.exports = { onMessage, decide, DECISION, getQuickReply, composePersonalizedReply, shouldProcessGroupMessage, isGroupLearnEnabled, QUICK_REPLY_POOL, isDontKnowReply }
