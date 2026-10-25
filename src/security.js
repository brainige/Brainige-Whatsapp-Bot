"use strict"
/* src/security.js — URL security: trusted-domain hostname check, VirusTotal
   scanning (contacts NEVER see VT messages; flags are admin-only), and the
   links.jsonl ledger.

   Design note:
   - Contacts must not see ANY VirusTotal/backend check notifications.
   - The WhatsApp ADMIN account receives all VT flags.
   - Every link seen in WhatsApp is appended to memory/links.jsonl as a
     human-readable memory file (for the owner, not for the bot). */

const fs = require("fs-extra")
const axios = require("axios")

const { PATHS, TRUSTED_DOMAINS, VT_API_KEY, VT_RATE_LIMIT, VT_RATE_WINDOW, VT_TIMEOUT_MS, CONTACT_NAME_TTL_MS } = require("./config")
const state = require("./state")
const { sleep } = require("./util")
const { notifyAdmin, notifyAdminBatched } = require("./notify")
const { logError } = require("./logging")

const URL_CACHE_MAX = 500
const vtBucket = state.vtBucket

/* A REAL rate limiter, free-tier safe: outbound VirusTotal calls are strictly
   spaced one per VT_MIN_INTERVAL, so a burst of links can NEVER fire together
   and blow the free 4/minute quota (the old bucket let every queued caller
   through at once → 429s → silent fail-opens). Waiting callers are served in
   call order — first link ~immediately, later ones spaced. */
let vtMinIntervalMs = VT_RATE_WINDOW / VT_RATE_LIMIT   // 60s / 3 = one call per 20s
function vtInitForTests(overrides) { if (overrides && overrides.minIntervalMs) vtMinIntervalMs = overrides.minIntervalMs }

function vtAcquire() {
    return new Promise(resolve => {
        const now = Date.now()
        if (now >= vtBucket.nextAllowedAt) {
            vtBucket.nextAllowedAt = now + vtMinIntervalMs
            resolve()
            return
        }
        const wait = vtBucket.nextAllowedAt - now
        vtBucket.nextAllowedAt += vtMinIntervalMs
        setTimeout(resolve, wait)
    })
}

/* ── Scheme-less URLs used to bypass ALL link
   security — a bare `bit.ly/xyz` or `evil-site.xyz` (both auto-linkified by
   WhatsApp, the most common phishing shape) was never scanned and never
   ledgered, and `www.` without a scheme failed new URL() so it was treated
   as untrusted junk. New extractor, three passes:
     1. explicit https?:// or www. matches (as before)
     2. known URL-shortener hosts, scheme-less (bit.ly, t.co, ...)
     3. bare domains ending in a known site TLD (com, xyz, in, io, ...)
   Trailing punctuation (., ! ? ) ] } ' ") is stripped, scheme-less matches
   get an https:// prefix so new URL() can parse them, duplicates collapse by
   host+path (www.b.com ≡ b.com), and e-mail addresses are masked first so
   they are never treated as links. */

const URL_SHORTENERS = [
    "bit.ly", "t.co", "tinyurl.com", "cutt.ly", "is.gd", "rb.gy", "ow.ly",
    "shorturl.at", "tiny.cc", "buff.ly", "rebrand.ly", "s.id", "lnkd.in",
    "goo.gl", "bit.do", "v.gd", "clck.ru", "shrtco.de", "tinyuid.com"
]
const BARE_URL_TLDS = [
    "com", "net", "org", "co", "in", "io", "info", "biz", "me", "cc", "ly",
    "xyz", "top", "site", "online", "link", "shop", "store", "live", "life",
    "world", "space", "website", "club", "fun", "icu", "buzz", "rest", "cyou",
    "sbs", "page", "one", "pro", "wiki", "vip", "tech", "zone", "click", "today"
]
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const SHORTENER_RE = new RegExp(`(?:${URL_SHORTENERS.map(escRe).join("|")})(?:/[^\\s<>"']*)?`, "gi")
const BARE_DOMAIN_RE = new RegExp(`\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${BARE_URL_TLDS.join("|")})(?:/[^\\s<>"']*)?`, "gi")
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi

function normalizeURL(raw) {
    let s = String(raw || "").trim()
    s = s.replace(/[.,!?)\]}'"]+$/g, "")   // trailing punctuation is never part of the URL
    if (!s) return null
    if (!/^https?:\/\//i.test(s)) s = "https://" + s
    try { new URL(s).hostname } catch { return null }   // unparseable → not a URL
    return s
}

function urlDedupeKey(normalized) {
    try {
        const u = new URL(normalized)
        let host = u.hostname.toLowerCase()
        if (host.startsWith("www.")) host = host.slice(4)
        return host + u.pathname + u.search
    } catch { return normalized }
}

/* All URLs found in the text, NORMALIZED (https:// prefixed, trailing junk
   stripped) and de-duplicated — ready for scanning and the ledger. */
function extractURLs(text) {
    if (!text) return []
    const found = []
    const seen = new Set()
    const add = raw => {
        const n = normalizeURL(raw)
        if (!n) return
        const key = urlDedupeKey(n)
        if (seen.has(key)) return
        seen.add(key)
        found.push(n)
    }
    let masked = String(text)
    masked = masked.replace(EMAIL_RE, " ")   // e-mail ≠ link
    masked = masked.replace(/(?:https?:\/\/|www\.)[^\s<>"]+/gi, m => { add(m); return " " })
    masked = masked.replace(SHORTENER_RE, m => { add(m); return " " })
    masked = masked.replace(BARE_DOMAIN_RE, m => { add(m); return " " })
    return found
}

/* The SAME matches, but removed from the text — lets the decision engine see
   what the sender actually said besides the link(s). */
function stripURLs(text) {
    if (!text) return ""
    let out = String(text)
    out = out.replace(EMAIL_RE, " ")
    out = out.replace(/(?:https?:\/\/|www\.)[^\s<>"]+/gi, " ")
    out = out.replace(SHORTENER_RE, " ")
    out = out.replace(BARE_DOMAIN_RE, " ")
    return out
}

/* ── A1 fix: hostname-based trusted-domain check ──────────
   OLD (bypassable): url.toLowerCase().includes(domain)
     → "https://youtube.com.evil-site.xyz" passed as trusted.
   NEW: parse the real hostname and compare exactly. */

function getHostname(url) {
    try {
        let host = new URL(url).hostname.toLowerCase()
        if (host.startsWith("www.")) host = host.slice(4)
        return host
    } catch {
        return null   // malformed URL → never trusted
    }
}

function isTrustedURL(url) {
    const host = getHostname(url)
    if (!host) return false
    return TRUSTED_DOMAINS.some(d => host === d || host.endsWith("." + d))
}

/* ── links.jsonl ledger (A2 new mechanism, human memory file) ──
   One JSON line per link occurrence:
   { ts, from, name, chat, chatName, url, verdict }
   verdict: "safe" | "malicious" | "not_checked" */

/* JID → display name cached for 24h — was a WhatsApp round-trip per
   link, even for repeated links from the same sender. Only successful
   non-empty lookups are cached; failures keep retrying (unchanged). */
const contactNameCache = new Map()   // jid -> { name, at }

async function getContactName(jid) {
    // best-effort contact display name; falls back to the bare number
    try {
        if (state.adminClient && jid) {
            const hit = contactNameCache.get(jid)
            if (hit && Date.now() - hit.at < CONTACT_NAME_TTL_MS) return hit.name
            const contact = await state.adminClient.getContactById(jid)
            if (contact && contact.name) {
                contactNameCache.set(jid, { name: contact.name, at: Date.now() })
                return contact.name
            }
        }
    } catch (e) { logError("security.getContactName", "contact name lookup failed", e, { quiet: true }) }
    return null
}

function appendLinkLedger(entry) {
    try { fs.appendFileSync(PATHS.LINKS_LEDGER, JSON.stringify(entry) + "\n") } catch (e) { logError("security.appendLinkLedger", "links.jsonl append failed", e) }
}

function buildLinkEntry(url, jid, contactName, chatType, chatName, verdict) {
    return {
        ts: new Date().toISOString(),
        from: (jid || "").replace(/@.+/, ""),
        name: contactName || "",
        chat: chatType === "group" ? "group" : "dm",
        chatName: chatName || "",
        url,
        verdict   // "safe" | "malicious" | "not_checked"
    }
}

/* ── VirusTotal check with ledger + admin-only flags ── */
async function checkURL(url, sourceLabel, senderJid, contactName, chatType, chatName) {
    // No API key configured — record as not_checked, no scan.
    if (!VT_API_KEY) {
        appendLinkLedger(buildLinkEntry(url, senderJid, contactName, chatType, chatName, "not_checked"))
        return true
    }

    // A1 fix: trusted domains are declared safe by hostname — never by substring.
    if (isTrustedURL(url)) {
        // Trusted-SAFE checks are SILENT —
        // ledger only. The old per-link admin message was pure spam.
        appendLinkLedger(buildLinkEntry(url, senderJid, contactName, chatType, chatName, "safe"))
        return true
    }

    const lurl = url.toLowerCase()

    if (state.urlCache.has(lurl)) {
        const c = state.urlCache.get(lurl)
        if (Date.now() - c.time < 86400000) {
            appendLinkLedger(buildLinkEntry(url, senderJid, contactName, chatType, chatName, c.safe ? "safe" : "malicious"))
            // Cached-SAFE is silent; a cached
            // UNSAFE verdict is now notified IMMEDIATELY (it never was before).
            if (!c.safe) notifyAdmin(`🚨 UNSAFE link (cached verdict)${sourceLabel ? `\nFrom: ${sourceLabel}` : ""}:\n${url}\nNo reply was sent to the contact.`)
            return c.safe
        }
        state.urlCache.delete(lurl)
    }

    await vtAcquire()

    const MAX_RETRIES = 3
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await axios.post(
                "https://www.virustotal.com/api/v3/urls",
                new URLSearchParams({ url }),
                { headers: { "x-apikey": VT_API_KEY, "content-type": "application/x-www-form-urlencoded" }, timeout: VT_TIMEOUT_MS }
            )
            const id = res.data.data.id
            await sleep(2000)
            const report = await axios.get(
                `https://www.virustotal.com/api/v3/analyses/${id}`,
                { headers: { "x-apikey": VT_API_KEY }, timeout: VT_TIMEOUT_MS }
            )
            const stats = report.data.data.attributes.stats
            const safe = !(stats.malicious >= 1 || stats.suspicious > 0)
            if (state.urlCache.size >= URL_CACHE_MAX) state.urlCache.delete(state.urlCache.keys().next().value)
            state.urlCache.set(lurl, { safe, time: Date.now() })
            appendLinkLedger(buildLinkEntry(url, senderJid, contactName, chatType, chatName, safe ? "safe" : "malicious"))
            if (!safe) {
                // A fresh UNSAFE verdict is notified IMMEDIATELY — before,
                // the owner only learned about unsafe links from the daily digest.
                notifyAdmin(`🚨 UNSAFE link${sourceLabel ? `\nFrom: ${sourceLabel}` : ""}:\n${url}\nMalicious: ${stats.malicious} | Suspicious: ${stats.suspicious}\nNo reply was sent to the contact.`)
            } else {
                notifyAdminBatched("Safe link scans", `✅ SAFE ${url}${sourceLabel ? ` (from ${sourceLabel})` : ""}`)
            }
            return safe
        } catch (e) {
            console.log(`⚠️  VT ERROR (attempt ${attempt}/${MAX_RETRIES}):`, e.message)
            if (attempt < MAX_RETRIES) await sleep(1000 * Math.pow(2, attempt - 1))
        }
    }
    // All retries failed → ledger marks not_checked; admin notified (contact sees nothing)
    appendLinkLedger(buildLinkEntry(url, senderJid, contactName, chatType, chatName, "not_checked"))
    console.log(`⚠️  VT: All retries failed for ${lurl.substring(0, 60)} — allowing (fail open)`)
    notifyAdminBatched("Link check failures", `⚠️ VirusTotal failed (allowing, fail-open): ${url}${sourceLabel ? ` — from ${sourceLabel}` : ""}`)
    return true
}

module.exports = {
    vtAcquire, vtInitForTests, extractURLs, stripURLs, isTrustedURL, getHostname,
    getContactName, appendLinkLedger, buildLinkEntry, checkURL
}
