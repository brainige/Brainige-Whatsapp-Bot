"use strict"
/* test/dashboard_test.js — Phase 0 part 1: the fail-closed local server.
   Real HTTP against 127.0.0.1 on ephemeral ports (listen(0)) — real
   sockets, real headers, real JSON. No supertest, no new dependency,
   no WhatsApp, no network. The module under test requires NOTHING
   from the project (everything is injected), so no .env is read and
   no project file is touched — nothing to snapshot/restore. */

const http = require("http")
const net = require("net")
const os = require("os")
const dashboard = require("../src/dashboard")

let pass = 0, fail = 0
function check(name, cond) {
    if (cond) { pass++; console.log(`  ✅ ${name}`) }
    else { fail++; console.log(`  ❌ ${name}`) }
}

/* A session-local test token — deliberately NOT the owner's real one
   (which this suite never reads). */
const TOKEN = "test-token-" + Math.random().toString(36).slice(2)

/* Everything the process prints + everything injected into logError is
   captured, then asserted token-free at the end. */
const captured = []
const origConsoleError = console.error
const origConsoleLog = console.log
console.error = (...args) => { captured.push(args.map(String).join(" ")); origConsoleError(...args) }
console.log = (...args) => { captured.push(args.map(String).join(" ")); origConsoleLog(...args) }

/* ── tiny real-HTTP client ───────────────────────────────────────────
   agent:false → a one-off connection per request, closed with the
   response, so no keep-alive socket ever outlives a test section. */
function request(port, pathname, { method = "GET", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: "127.0.0.1", port, path: pathname, method, headers, agent: false
        }, res => {
            let body = ""
            res.setEncoding("utf8")
            res.on("data", c => { body += c })
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }))
        })
        req.on("error", reject)
        req.setTimeout(4000, () => { req.destroy(new Error("request timeout")) })
        req.end()
    })
}

function authHeaders() { return { Authorization: `Bearer ${TOKEN}` } }

/* Raw connect — for "is the port even open" checks. Resolves true only
   if a TCP connection SUCCEEDS. */
function portOpen(port, host = "127.0.0.1") {
    return new Promise(resolve => {
        const sock = net.connect({ port, host })
        sock.on("connect", () => { sock.destroy(); resolve(true) })
        sock.on("error", () => resolve(false))
        sock.setTimeout(4000, () => { sock.destroy(); resolve(false) })
    })
}

function lanIPv4() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list) if (ni.family === "IPv4" && !ni.internal) return ni.address
    }
    return null
}

async function main() {
    /* ── 1. Fail-closed boot: no token → the port never opens ───────── */
    console.log("\n── 1. Missing token at boot = no port ──")
    {
        const d = dashboard.init({
            getToken: () => "",
            getPort: () => 7899,
            logError: (loc, ctx, err) => captured.push(`[${loc}] ${ctx} ${err ? (err.message || err) : ""}`),
            graceMs: 200
        })
        const r = await d.start()
        check("start() reports not started", r.started === false && r.reason === "no_token")
        check("start() threw nothing and returned (module loads clean)", typeof d.stop === "function")
        const open = await portOpen(7899)
        check("nothing is listening on the configured port", open === false)
        check("isRunning() is false", d.isRunning() === false)
        check("fail-closed notice was printed", captured.some(s => s.includes("DISABLED") && s.includes("DASHBOARD_TOKEN")))
        check("stop() on a never-started server resolves", (await d.stop()).stopped === true)
    }

    /* ── 2. Happy path: token in → server up, /health answers ───────── */
    console.log("\n── 2. Server with a token ──")
    let port
    {
        const d = dashboard.init({
            getToken: () => TOKEN,
            getPort: () => 0,                       // 0 = ephemeral — never a fixed port in tests
            logError: (loc, ctx, err) => captured.push(`[${loc}] ${ctx} ${err ? (err.message || err) : ""}`),
            graceMs: 300
        })
        const r = await d.start()
        check("start() opened a port", r.started === true && typeof r.port === "number")
        check("isRunning() is true", d.isRunning() === true)
        port = r.port

        const ok = await request(port, "/health", { headers: authHeaders() })
        check("GET /health with the right token → 200", ok.status === 200)
        let health = null
        try { health = JSON.parse(ok.body) } catch { }
        check("health body is JSON with the shape {ok, service, uptime_s}",
            !!health && health.ok === true && health.service === "dashboard" && Number.isFinite(health.uptime_s))

        const noTok = await request(port, "/health")
        check("GET /health with NO token → 401", noTok.status === 401)
        check("401 body is bare, hint-free", noTok.body === '{"ok":false,"error":"unauthorized"}')

        const wrong = await request(port, "/health", { headers: { Authorization: "Bearer not-the-token" } })
        check("GET /health with a WRONG token → 401", wrong.status === 401)

        const noBearer = await request(port, "/health", { headers: { Authorization: TOKEN } })
        check("token WITHOUT the Bearer scheme → 401", noBearer.status === 401)

        const bearerAlone = await request(port, "/health", { headers: { Authorization: "Bearer" } })
        check("'Bearer' with no token → 401", bearerAlone.status === 401)

        const basic = await request(port, "/health", { headers: { Authorization: "Basic dXNlcjpwYXNz" } })
        check("Basic scheme → 401 (Bearer only)", basic.status === 401)

        /* Unknown paths and method mismatches — uniform, no hints. */
        const nf = await request(port, "/does-not-exist", { headers: authHeaders() })
        check("unknown path + right token → 404", nf.status === 404)
        check("404 body is bare", nf.body === '{"ok":false,"error":"not_found"}')

        const nfNoTok = await request(port, "/does-not-exist")
        check("unknown path + NO token → 401 (auth runs before routing)", nfNoTok.status === 401)

        const mna = await request(port, "/health", { method: "POST", headers: authHeaders() })
        check("POST /health + right token → 405", mna.status === 405)
        check("405 body is bare", mna.body === '{"ok":false,"error":"method_not_allowed"}')

        /* The frontend shell: no dist/ built in Phase 0 → clean 503. */
        const idx = await request(port, "/", { headers: authHeaders() })
        check("GET / before the Phase-1 build → 503 frontend_not_built", idx.status === 503)
        check("503 body names the reason, no stack", idx.body === '{"ok":false,"error":"frontend_not_built"}')

        /* Constant-time compare, exercised through the public surface. */
        const tm = dashboard.tokenMatches
        check("tokenMatches: exact match", tm(TOKEN, TOKEN) === true)
        check("tokenMatches: wrong token", tm("x" + TOKEN, TOKEN) === false)
        check("tokenMatches: different length never throws", tm("", TOKEN) === false && tm(TOKEN, "") === false)
        check("extractBearer: exact shape", dashboard.extractBearer("Bearer abc123") === "abc123")
        check("extractBearer: junk shapes → null",
            dashboard.extractBearer("bearer") === null &&
            dashboard.extractBearer("Basic abc") === null &&
            dashboard.extractBearer(undefined) === null &&
            dashboard.extractBearer("Bearer  a b") === null)

        await d.stop()
        check("after stop(): isRunning() false", d.isRunning() === false)
        const afterStop = await portOpen(port)
        check("after stop(): the port is closed again", afterStop === false)
    }

    /* ── 3. Loopback-only: the LAN address must refuse ──────────────── */
    console.log("\n── 3. Loopback-only binding ──")
    {
        const lan = lanIPv4()
        const d = dashboard.init({
            getToken: () => TOKEN,
            getPort: () => 0,
            logError: () => { },
            graceMs: 200
        })
        const r = await d.start()
        if (!lan) {
            check("LAN-address refusal (skipped — no non-internal IPv4 on this PC)", true)
        } else {
            const open = await portOpen(r.port, lan)
            check(`LAN address ${lan} cannot reach the server`, open === false)
            const ok = await request(r.port, "/health", { headers: authHeaders() })
            check("loopback still answers while LAN is refused", ok.status === 200)
        }
        check("server module binds HOST to loopback only", dashboard.HOST === "127.0.0.1")
        await d.stop()
    }

    /* ── 4. Shutdown grace: an idle keep-alive socket must not hang ─── */
    console.log("\n── 4. Clean shutdown under an idle keep-alive socket ──")
    {
        const d = dashboard.init({
            getToken: () => TOKEN,
            getPort: () => 0,
            logError: (loc, ctx, err) => captured.push(`[${loc}] ${ctx} ${err ? (err.message || err) : ""}`),
            graceMs: 400
        })
        const r = await d.start()
        const idle = net.connect({ port: r.port, host: "127.0.0.1" })
        await new Promise(res => idle.on("connect", res))
        /* nothing is ever sent on it — a browser tab left open looks
           exactly like this. server.close() alone would wait forever. */
        const t0 = Date.now()
        const stopResult = await d.stop()
        const elapsed = Date.now() - t0
        check("stop() resolved with an idle socket attached", stopResult.stopped === true)
        check(`stop() finished inside the grace window (${elapsed}ms < 2500ms)`, elapsed < 2500)
        check("stop() actually waited for the grace period (>= ~400ms)", elapsed >= 350)
        idle.destroy()
    }

    /* ── 5. Port busy: a second server fails closed, loudly ─────────── */
    console.log("\n── 5. Port already busy ──")
    {
        const a = dashboard.init({ getToken: () => TOKEN, getPort: () => 7898, logError: () => { }, graceMs: 200 })
        const first = await a.start()
        check("first server owns 7898", first.started === true)

        const b = dashboard.init({ getToken: () => TOKEN, getPort: () => 7898, logError: () => { }, graceMs: 200 })
        const second = await b.start()
        check("second server on the busy port did NOT start", second.started === false && /EADDRINUSE|EACCES|listen_failed/.test(second.reason))
        check("busy-port failure printed a DISABLED line (bot-safe, loud)", captured.some(s => s.includes("7898")))
        check("first server still healthy while the second failed", a.isRunning() === true)

        await a.stop()
        const freed = await portOpen(7898)
        check("after stop() the port is free again", freed === false)
    }

    /* ── 6. The token must never appear in any output ────────────────── */
    console.log("\n── 6. Token-leak guard ──")
    {
        const d = dashboard.init({
            getToken: () => TOKEN,
            getPort: () => 0,
            logError: (loc, ctx, err) => captured.push(`[${loc}] ${ctx} ${err ? (err.message || err) : ""}`),
            graceMs: 200
        })
        const r = await d.start()
        const bodies = await Promise.all([
            request(r.port, "/health").then(x => x.body),
            request(r.port, "/health", { headers: { Authorization: "Bearer wrong" } }).then(x => x.body),
            request(r.port, "/nope", { headers: authHeaders() }).then(x => x.body),
            request(r.port, "/", { method: "POST", headers: authHeaders() }).then(x => x.body),
            request(r.port, "/", { headers: authHeaders() }).then(x => x.body)
        ])
        check("no response body contains the token", bodies.every(b => !b.includes(TOKEN)))
        check("the startup console line prints the URL but not the token",
            captured.some(s => s.includes("http://127.0.0.1:") && !s.includes(TOKEN)))
        check("nothing captured all-run contains the token", captured.every(s => !s.includes(TOKEN)))
        await d.stop()
    }

    console.error = origConsoleError
    console.log = origConsoleLog

    console.log("\n═══════════════════════════════════")
    console.log(`DASHBOARD TEST: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error = origConsoleError; console.log = origConsoleLog; console.error(e); process.exit(1) })
