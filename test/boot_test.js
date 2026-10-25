"use strict"
/* test/boot_test.js — boots the REAL bot.js with stubbed whatsapp-web.js,
   qrcode-terminal and @xenova/transformers. Verifies:
   1. Full startup sequence runs without crashing.
   2. A4 graceful shutdown: SIGINT → flush → DB close → exit code 0.
   Nothing connects to WhatsApp; no model downloads. */

const path = require("path")

const mod = require("module")
const origResolve = mod._resolveFilename
mod._resolveFilename = function (request, ...args) {
    if (request === "whatsapp-web.js") return path.join(__dirname, "stubs", "whatsapp-web.js")
    if (request === "qrcode-terminal") return path.join(__dirname, "stubs", "qrcode-terminal.js")
    if (request === "@xenova/transformers") return path.join(__dirname, "stubs", "transformers.js")
    return origResolve.call(this, request, ...args)
}

process.env.ADMIN = "smoketest_admin@c.us"

console.log("[boot_test] requiring bot.js (stubbed client)...")
process.on("exit", code => {
    console.log(`[boot_test] process exited with code ${code}`)
})

require("../bot.js")

// Give startup ~4 seconds, then simulate Ctrl+C.
// NOTE: on Windows, process.kill(pid, "SIGINT") bypasses Node's signal
// handlers. A REAL Ctrl+C in a console window DOES invoke them (Node installs
// a SetConsoleCtrlHandler). process.emit("SIGINT") invokes them directly,
// which is what a real Ctrl+C does — the honest way to test on Windows.
setTimeout(() => {
    console.log("\n[boot_test] simulating Ctrl+C (SIGINT)...")
    process.emit("SIGINT", "SIGINT")
}, 4000)

// Hard fail-safe: if shutdown doesn't finish in 12s, something is stuck.
setTimeout(() => {
    console.log("[boot_test] FAIL-SAFE: shutdown took too long, killing.")
    process.exit(2)
}, 12000)
