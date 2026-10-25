"use strict"
/* Stub of whatsapp-web.js for tests only — never connects anywhere. */
class FakeMessage {
    constructor() { this.sentTexts = [] }
    async reply(text) { this.sentTexts.push(text); return { id: { _serialized: "stub_" + Date.now() } } }
}
class FakeChat {
    constructor() { this.sentTexts = [] }
    async sendMessage(text) { this.sentTexts.push(text); return { id: { _serialized: "stub_" + Date.now() } } }
}
class FakeClient {
    constructor() { this.handlers = {} }
    on(evt, fn) { this.handlers[evt] = fn }
    async initialize() { /* no-op: test only */ }
    async destroy() { /* no-op */ }
    async getChatById(id) { return new FakeChat() }
    async getContactById(id) { return { name: null } }
}
module.exports = { Client: FakeClient, LocalAuth: class { }, Message: FakeMessage }
