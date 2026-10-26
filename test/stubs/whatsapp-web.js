"use strict"
/* Stub of whatsapp-web.js for tests only — never connects anywhere. */
const fs = require("fs")
const path = require("path")

class FakeMessage {
    constructor() { this.sentTexts = [] }
    async reply(text) { this.sentTexts.push(text); return { id: { _serialized: "stub_" + Date.now() } } }
}
class FakeChat {
    constructor() { this.sentTexts = [] }
    async sendMessage(content, options) {
        if (content && typeof content === "object") {
            // media send — record it for assertions (text sends unchanged below)
            sentMedia.push({ media: content, options: options || null })
        } else {
            this.sentTexts.push(content)
        }
        return { id: { _serialized: "stub_" + Date.now() } }
    }
}
class FakeClient {
    constructor() { this.handlers = {} }
    on(evt, fn) { this.handlers[evt] = fn }
    async initialize() { /* no-op: test only */ }
    async destroy() { /* no-op */ }
    async getChatById(id) { return new FakeChat() }
    async getContactById(id) { return { name: null } }
}

/* Every chat.sendMessage(media) lands here so tests can assert on it. */
const sentMedia = []

/* MessageMedia.fromFilePath — the same { mimetype, data (base64), filename }
   shape the real library returns; a missing file throws, like the real one. */
const MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf"
}
const MessageMedia = {
    fromFilePath(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`ENOENT: no such file or directory, open '${filePath}'`)
        }
        return {
            mimetype: MIME_BY_EXT[path.extname(String(filePath)).toLowerCase()] || "application/octet-stream",
            data: fs.readFileSync(filePath).toString("base64"),
            filename: path.basename(String(filePath))
        }
    }
}

module.exports = { Client: FakeClient, LocalAuth: class { }, Message: FakeMessage, MessageMedia, sentMedia }
