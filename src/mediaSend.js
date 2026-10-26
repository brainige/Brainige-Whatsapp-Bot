"use strict"
/* src/mediaSend.js — sending a local file (image/PDF/sticker) to a chat.
   The size is checked BEFORE the file is read into memory: anything over
   MEDIA_MAX_BYTES is rejected up front and never sent (an oversized upload
   is also the fastest way to get a number flagged). opts.maxBytes lets tests
   exercise the cap deterministically with a tiny value — same knob pattern
   as sendGuard.init. Whatever fails goes through logError first: nothing
   about a send is ever silent. */

const fs = require("fs-extra")
const { MEDIA_MAX_BYTES } = require("./config")
const { logError } = require("./logging")

/* The library is heavy (it pulls in Puppeteer), so it loads on first use
   instead of at module load — code paths that never send a file never
   pay for it, and nothing requires it just to boot. */
let MessageMediaClass = null
function getMediaClass() {
    if (!MessageMediaClass) MessageMediaClass = require("whatsapp-web.js").MessageMedia
    return MessageMediaClass
}

function buildMedia(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`file not found: ${filePath}`)
    }
    return getMediaClass().fromFilePath(filePath)
}

function fmtBytes(n) {
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${n}B`
}

async function sendMediaFile(client, chatId, filePath, caption, opts = {}) {
    try {
        const maxBytes = opts && typeof opts.maxBytes === "number" && opts.maxBytes > 0
            ? opts.maxBytes
            : MEDIA_MAX_BYTES
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`file not found: ${filePath}`)
        }
        const size = fs.statSync(filePath).size
        if (size > maxBytes) {
            throw new Error(`file too large: ${fmtBytes(size)} (limit ${fmtBytes(maxBytes)}) — ${filePath}`)
        }
        const media = buildMedia(filePath)
        const chat = await client.getChatById(chatId)
        return await chat.sendMessage(media, { caption })
    } catch (e) {
        logError("mediaSend.sendMediaFile", "sending a media file failed", e)
        throw e
    }
}

module.exports = { buildMedia, sendMediaFile }
