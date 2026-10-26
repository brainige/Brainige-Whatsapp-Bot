"use strict"
/* test/media_test.js — sending a local file (image/PDF/sticker) to a chat.
   Covers:
   - buildMedia: a missing path throws a clean "file not found: ..." error;
     a real file becomes a MessageMedia carrying its base64 data + filename
   - sendMediaFile: a file OVER the cap (tiny maxBytes knob + a small real
     temp file) is rejected BEFORE the client is touched — nothing is sent
   - sendMediaFile: an under-cap file goes through the stub client with its
     caption, and the send result comes back
   - whatsapp-web.js is the offline stub — no network ever happens
   Project state files are snapshotted + restored at the end. */

const path = require("path")
const os = require("os")
const fs = require("fs-extra")

const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    return origResolve.call(this, request, ...args)
}

process.env.VT_API_KEY = ""
process.env.ADMIN = "smoketest_admin@c.us"

const CHAT_ID = "1112223334@c.us"
const PDF_BYTES = "%PDF-1.4 fake price list for tests\n"

let pass = 0, fail = 0
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✅ ${name}`) }
    else { fail++; console.log(`  ❌ ${name}`) }
}

function snapshotFile(p) { try { return fs.readFileSync(p, "utf8") } catch { return null } }
function restoreFile(p, content) {
    try {
        if (content === null) { if (fs.existsSync(p)) fs.removeSync(p) }
        else fs.writeFileSync(p, content)
    } catch { }
}

async function main() {
    /* ── snapshots: the real project files must survive this test ── */
    const { PATHS, MEDIA_MAX_BYTES } = require("../src/config")
    const snapSettings = snapshotFile(PATHS.SETTINGS)
    const snapSettingsBak = snapshotFile(PATHS.SETTINGS + ".bak")
    const snapMemory = snapshotFile(PATHS.MEMORY)
    const snapMemoryBak = snapshotFile(PATHS.MEMORY + ".bak")
    const snapKnowledge = snapshotFile(PATHS.KNOWLEDGE)
    const snapKnowledgeBak = snapshotFile(PATHS.KNOWLEDGE + ".bak")
    const snapHN = snapshotFile(PATHS.HN_JSON)
    const snapErrors = snapshotFile(PATHS.LOG_ERRORS)

    const { buildMedia, sendMediaFile } = require("../src/mediaSend")
    const wweb = require("whatsapp-web.js")   // resolves to the test stub

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wabot-media-"))
    const missingPath = path.join(tmpDir, "does_not_exist.pdf")
    const pdfPath = path.join(tmpDir, "price_list.pdf")
    fs.writeFileSync(pdfPath, PDF_BYTES)

    console.log("\n── buildMedia ──")
    let threw = null
    try { buildMedia(missingPath) } catch (e) { threw = e }
    check("missing file throws", threw instanceof Error)
    check("missing-file message is clean ('file not found: ...')",
        threw && threw.message.startsWith(`file not found: ${missingPath}`))

    const media = buildMedia(pdfPath)
    check("media carries the file name", media.filename === "price_list.pdf")
    check("media carries the right mime type", media.mimetype === "application/pdf")
    check("media carries the base64 file data", media.data === Buffer.from(PDF_BYTES).toString("base64"))

    console.log("\n── sendMediaFile: missing file ──")
    const client = new wweb.Client()
    let spyCalls = []
    const spy = { getChatById: async (id) => { spyCalls.push(id); return client.getChatById(id) } }
    wweb.sentMedia.length = 0
    spyCalls = []
    let sendThrew = null
    try { await sendMediaFile(spy, CHAT_ID, missingPath, "caption") } catch (e) { sendThrew = e }
    check("missing file rejects with the clean error", sendThrew && String(sendThrew.message).includes("file not found"))
    check("nothing sent for a missing file", wweb.sentMedia.length === 0)
    check("the client was never called for a missing file", spyCalls.length === 0)

    console.log("\n── sendMediaFile: over the cap ──")
    wweb.sentMedia.length = 0
    spyCalls = []
    let capThrew = null
    try { await sendMediaFile(spy, CHAT_ID, pdfPath, "caption", { maxBytes: 16 }) } catch (e) { capThrew = e }
    check("a file over the cap is rejected", capThrew instanceof Error)
    check("the rejection says why (size + limit)", capThrew && capThrew.message.includes("too large"))
    check("nothing sent for an over-cap file", wweb.sentMedia.length === 0)
    check("the client was never called for an over-cap file", spyCalls.length === 0)

    console.log("\n── sendMediaFile: under the cap ──")
    wweb.sentMedia.length = 0
    spyCalls = []
    const result = await sendMediaFile(spy, CHAT_ID, pdfPath, "here is the price list", { maxBytes: 10 * 1024 })
    check("exactly one media message sent", wweb.sentMedia.length === 1)
    const sent = wweb.sentMedia[0]
    check("the right chat was used", spyCalls.length === 1 && spyCalls[0] === CHAT_ID)
    check("the MessageMedia went through", sent.media && sent.media.filename === "price_list.pdf")
    check("the base64 payload matches the file", sent.media && sent.media.data === media.data)
    check("the caption was attached", sent.options && sent.options.caption === "here is the price list")
    check("the send result is returned", result && typeof result.id._serialized === "string")

    console.log("\n── sendMediaFile: the default cap comes from config ──")
    wweb.sentMedia.length = 0
    spyCalls = []
    await sendMediaFile(spy, CHAT_ID, pdfPath, "default cap")
    check("no opts → config MEDIA_MAX_BYTES applies and the small file sends",
        wweb.sentMedia.length === 1 && MEDIA_MAX_BYTES === 20 * 1024 * 1024)

    console.log("\n── offline ──")
    check("whatsapp-web.js resolved to the test stub (no real client)", wweb.Client.name === "FakeClient")
    check("the stub exposes MessageMedia", typeof wweb.MessageMedia.fromFilePath === "function")

    console.log("\n── cleanup ──")
    try { fs.removeSync(tmpDir) } catch { }
    restoreFile(PATHS.SETTINGS, snapSettings)
    restoreFile(PATHS.SETTINGS + ".bak", snapSettingsBak)
    restoreFile(PATHS.MEMORY, snapMemory)
    restoreFile(PATHS.MEMORY + ".bak", snapMemoryBak)
    restoreFile(PATHS.KNOWLEDGE, snapKnowledge)
    restoreFile(PATHS.KNOWLEDGE + ".bak", snapKnowledgeBak)
    restoreFile(PATHS.HN_JSON, snapHN)
    restoreFile(PATHS.LOG_ERRORS, snapErrors)
    check("cleanup done (temp files removed, project files restored)", !fs.existsSync(tmpDir))

    console.log("\n═══════════════════════════════")
    console.log(`MEDIA TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error("MEDIA TEST CRASHED:", e); process.exit(1) })
