"use strict"
/* ══════════════════════════════════════════════════════
   src/dashboard.js — the local-only web dashboard server
   (Phase 0 foundation: server skeleton + fail-closed auth).

   HOSTING (locked plan): the dashboard is a passenger INSIDE the
   bot's own process — it starts with the bot and dies with it. It
   listens on 127.0.0.1 ONLY: that address never leaves this PC, so
   the page cannot be reached from the Wi-Fi, the router, the phone,
   or the internet. Every byte it serves comes from this folder
   (the Vite-built frontend in src/dashboard/dist/) — no CDN, no
   external fonts, no analytics, works with the network cable out.

   FAIL-CLOSED RULES (by design, tested in test/dashboard_test.js):
   - No/empty token at start() → the port NEVER opens; the bot runs on.
   - Port busy / unusable      → loud error line; the bot runs on.
   - Missing/wrong/malformed token on ANY route — even /health, even
     unknown paths → 401 with a bare, hint-free JSON body (no stack
     traces, no "token" word, no echo of what was received).
   - A dashboard crash can never take the bot down: the request
     handler wraps everything, and shutdown() awaits stop() BEFORE
     the databases close.
   - The token is compared in constant time, never logged, and
     travels only in the Authorization header (never a URL).

   Phase 0 scope: /health, the static shell for the built frontend
   (served once src/dashboard/dist/ exists — built in Phase 1), and
   uniform 401/404/405/400/503 hygiene. Data routes (stats, review,
   misses), the SSE hub + tickets and the event bus arrive in later
   phases; the route table below is the seam they extend.
══════════════════════════════════════════════════════ */

const http = require("http")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")

const HOST = "127.0.0.1"                                    // loopback ONLY — never the LAN, never the internet
const STOP_GRACE_MS = 1500                                  // in-flight requests get this long before sockets are forced shut
const DIST_DIR = path.join(__dirname, "dashboard", "dist")  // Vite build output (Phase 1+), read at boot, served from disk

/* Constant-time comparison. Both sides are hashed to fixed-length
   digests FIRST — crypto.timingSafeEqual throws on a length
   mismatch, and the raw token never lands in any log line. */
function tokenMatches(given, expected) {
    const a = crypto.createHash("sha256").update(String(given == null ? "" : given)).digest()
    const b = crypto.createHash("sha256").update(String(expected == null ? "" : expected)).digest()
    return crypto.timingSafeEqual(a, b)
}

/* Every response is JSON — never HTML-rendered, never sniffed into
   something else, never cached (this is live private data). */
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store"
    })
    res.end(body)
}

/* "Authorization: Bearer <token>" — the ONLY accepted shape.
   Anything else (missing header, wrong scheme, no token, junk)
   returns null → the same 401 as a wrong token: uniform, no hints. */
function extractBearer(headerValue) {
    if (typeof headerValue !== "string") return null
    const m = /^Bearer[ \t]+(\S+)$/i.exec(headerValue)
    return m ? m[1] : null
}

function buildHandler(ctx) {
    // ctx = { getToken, distDir }
    return function handle(req, res) {
        try {
            const parsed = new URL(req.url, "http://127.0.0.1")
            const pathname = parsed.pathname

            /* Auth first — EVERY route, no exceptions. */
            const given = extractBearer(req.headers && req.headers.authorization)
            if (!given || !tokenMatches(given, ctx.getToken())) {
                sendJson(res, 401, { ok: false, error: "unauthorized" })
                return
            }

            /* GET /health — liveness probe (still token-protected). */
            if (pathname === "/health") {
                if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method_not_allowed" }); return }
                sendJson(res, 200, {
                    ok: true,
                    service: "dashboard",
                    uptime_s: Math.floor((Date.now() - ctx.startedAt) / 1000)
                })
                return
            }

            /* GET / — the built frontend shell (Phase 1+). Until the
               Vite build exists this is a clean 503, never a stack. */
            if (pathname === "/") {
                if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method_not_allowed" }); return }
                const indexFile = path.join(ctx.distDir, "index.html")   // fixed name — user input never touches the path
                let html
                try { html = fs.readFileSync(indexFile) }
                catch { sendJson(res, 503, { ok: false, error: "frontend_not_built" }); return }
                res.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "X-Content-Type-Options": "nosniff",
                    "Cache-Control": "no-store"
                })
                res.end(html)
                return
            }

            /* Unknown path — 404 (the body is identical for every
               unknown path so it leaks nothing about what exists). */
            sendJson(res, 404, { ok: false, error: "not_found" })
        } catch (e) {
            /* Garbage request line, weird URL, anything unexpected:
               a bare 400. Stack traces never leave the process. */
            try { sendJson(res, 400, { ok: false, error: "bad_request" }) } catch { }
        }
    }
}

/* init({ getToken, getPort, logError, distDir, graceMs }) → { start, stop, isRunning }
   getToken/getPort are injected (never read from .env here) — bot.js
   passes config-backed getters, tests pass their own. That keeps this
   module dependency-free and the auth path fully testable offline. */
function init(opts) {
    const o = opts || {}
    const getToken = typeof o.getToken === "function" ? o.getToken : () => ""
    const getPort  = typeof o.getPort  === "function" ? o.getPort  : () => 7800
    const logError = typeof o.logError === "function" ? o.logError : () => { }
    const distDir  = o.distDir || DIST_DIR
    const graceMs  = typeof o.graceMs === "number" ? o.graceMs : STOP_GRACE_MS

    const ctx = { getToken, distDir, startedAt: 0 }
    const handler = buildHandler(ctx)
    const sockets = new Set()   // live connections — for a clean, never-hanging stop()

    let server = null

    /* Returns { started, port?, reason? } — never throws, never
       exits the process. A failure here is a lost dashboard, not a
       dead bot. */
    async function start() {
        if (server) return { started: true, already: true }

        const token = String(getToken() == null ? "" : getToken())
        if (!token) {
            logError("dashboard", "start skipped — DASHBOARD_TOKEN missing in .env (fail-closed)", null)
            console.error("🎛 Dashboard: DISABLED — DASHBOARD_TOKEN is not set in .env (the bot runs fine without it).")
            return { started: false, reason: "no_token" }
        }

        const port = Number(getPort())
        if (!Number.isInteger(port) || port < 0 || port > 65535) {
            logError("dashboard", `start skipped — DASHBOARD_PORT is not a valid port (got ${port})`, null)
            console.error(`🎛 Dashboard: DISABLED — DASHBOARD_PORT "${port}" is not a valid port (the bot runs fine without it).`)
            return { started: false, reason: "bad_port" }
        }

        server = http.createServer(handler)
        const opened = await new Promise(resolve => {
            server.once("error", err => resolve({ err }))
            server.listen(port, HOST, () => resolve({ err: null }))
        })

        if (opened.err) {
            server = null
            logError("dashboard", `start failed — cannot listen on ${HOST}:${port}`, opened.err)
            console.error(`🎛 Dashboard: DISABLED — cannot listen on ${HOST}:${port} (${opened.err.code || opened.err.message}). The bot runs fine without it.`)
            return { started: false, reason: opened.err.code || "listen_failed" }
        }

        ctx.startedAt = Date.now()
        const bound = server.address().port

        /* Track sockets so stop() can force-close idle keep-alives
           (server.close() alone waits forever on them). */
        server.on("connection", sock => {
            sockets.add(sock)
            sock.on("close", () => sockets.delete(sock))
        })
        /* A mid-run server error is logged and contained — the bot's
           own error handling is untouched. */
        server.on("error", err => logError("dashboard", "server error after start", err))

        console.log(`🎛 Dashboard: http://${HOST}:${bound}`)
        return { started: true, port: bound }
    }

    /* Graceful stop: stop accepting, wait for in-flight requests up
       to graceMs, then force-close stragglers so a socket left open
       by an abandoned browser tab can never hang shutdown. */
    async function stop() {
        if (!server) return { stopped: true }
        const s = server
        server = null
        const closed = new Promise(resolve => s.once("close", resolve))
        try { s.close() } catch { }
        const timer = setTimeout(() => {
            for (const sock of sockets) { try { sock.destroy() } catch { } }
        }, graceMs)
        try { await closed } finally { clearTimeout(timer) }
        for (const sock of sockets) { try { sock.destroy() } catch { } }
        sockets.clear()
        return { stopped: true }
    }

    function isRunning() { return !!server }

    return { start, stop, isRunning }
}

module.exports = { init, HOST, STOP_GRACE_MS, DIST_DIR, tokenMatches, extractBearer }
