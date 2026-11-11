# Brainige WhatsApp Bot

![version](https://img.shields.io/badge/version-6.5.0-informational)
![license](https://img.shields.io/badge/license-Apache%202.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

I built this for my business WhatsApp and my personal one. It answers customer questions from a knowledge base that I edit by hand. When the base has no answer, it asks a local LLM and replies with that, and nothing the LLM says enters the base until I have approved it myself.

It runs on my own machine, so customer data stays put. WhatsApp Web is driven through headless Chrome, the LLM runs in LM Studio, and the only outside call is the optional VirusTotal link check.

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Setup](#setup)
- [Running it](#running-it)
- [The knowledge base](#the-knowledge-base)
- [Reviewing what the LLM wants to learn](#reviewing-what-the-llm-wants-to-learn)
- [Admin commands](#admin-commands)
- [The dashboard](#the-dashboard)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Community](#community)
- [Troubleshooting](#troubleshooting)
- [Notes and limits](#notes-and-limits)
- [License](#license)

## What it does

Here's what it can do, in roughly the order you'll meet each piece:

- Hybrid search over the Q&A: word overlap plus embeddings (`all-MiniLM-L6-v2`), so "how much for delivery" finds "delivery charge" even with no shared keywords
- Replies in the customer's language: English, Bengali and Hindi, including the canned greetings and the I-don't-know fallback line
- Local LLM fallback: when no stored answer scores high enough, the bot asks LM Studio (any model works, Qwen3-1.7B by default) and caps the reply at three sentences
- Human review queue: every LLM answer waits for me. The bot never promotes an LLM answer into the knowledge base on its own
- Human-needed detection: three layers (keyword, context, semantic) catch what a bot shouldn't touch, like complaints, pricing disputes and anything urgent
- Link safety: every link is checked against VirusTotal, spaced out so the free tier is safe, and written to a local ledger. Customers never see the check. I get the flags, plus an immediate alert for malicious links
- Send pacing: a jittered 3 to 6 second gap between sends, roughly 25 per hour with a queue, and suppression of identical replies, so a busy hour doesn't look like spam
- Name-triggered pause: a customer who writes my name pauses auto-replies for that chat, so I can step in
- Owner handoff: when I reply to a customer from my own phone, the bot stands down for that chat for 30 minutes. Logging and learning keep running, and each reply from me pushes the stand-down further out
- `!sendmedia` pushes a file (price list, catalogue, sticker) into a chat, through the same size cap and logging as incoming media
- Miss log: every question the bot could not answer is recorded, so `!misses` tells me what to teach it next
- Group support: whitelist the groups the bot may answer in, learn from my own replies in those groups, stay silent everywhere else
- Daily digest at 21:00 covering replies sent, messages skipped, pairs queued for review and send-guard events
- Everything is logged locally: chats, errors, saved media and the link ledger

I built all of it for my own shop first. The pieces I would never switch off are the review queue, the miss log and the handoff, because they are what keep a small model from embarrassing me in front of a customer.

## Requirements

- Node.js 20 or newer (this PC runs 26.13.0)
- Google Chrome, driven headless by `whatsapp-web.js`
- LM Studio on the same machine with a model loaded. Any model LM Studio serves works. The default config expects Qwen3-1.7B at `http://127.0.0.1:1234`, and you change it with `LLM_MODEL`
- A VirusTotal API key if you want link scanning. The free tier is enough. Without one, links are still recorded, just not scanned

## Setup

```bash
git clone https://github.com/brainige/Brainige-Whatsapp-Bot.git
cd Brainige-Whatsapp-Bot
npm install
cp .env.example .env
```

On Windows, `better-sqlite3` and `sharp` are native modules and their binaries are only placed by install scripts. If either one fails to load later, run `npm rebuild better-sqlite3` or `npm rebuild sharp`. That's a Windows quirk, not a broken install.

Open `.env` and fill in the values below. Leave the VirusTotal key empty if you don't have one yet.

| Variable | What it is |
|---|---|
| `VT_API_KEY` | VirusTotal key. Leave empty to skip link scanning. |
| `ADMIN` | Your WhatsApp number in JID form: country code + number + `@c.us`. Commands only work from this number. |
| `LLM_URL` | Where LM Studio listens. Default `http://127.0.0.1:1234/v1/chat/completions`. |
| `LLM_MODEL` | Model name as LM Studio shows it. Default `Qwen3-1.7B-Instruct`. |
| `DASHBOARD_TOKEN` | Bearer token for the local dashboard. Leave it empty and the dashboard stays off while the bot runs normally. |
| `DASHBOARD_PORT` | Port for the dashboard. Default `7800`. |
| `BRAND_NAME` | Product name on the terminal banner, `!help` and the daily digest. Default `Brainige`. |
| `OWNER_DISPLAY` | How you appear in customer replies. Default `Utsab/Avi`. |
| `OWNER_DISPLAY_BN` / `OWNER_DISPLAY_HI` | The same for Bengali and Hindi replies. Default `উৎসব/আভি` / `उत्सब/अवि`. |
| `PAUSE_NAMES` | Words that pause replies when a customer addresses you by name, comma separated. Default `utsab,avi`. An empty value turns the trigger off. |

## Running it

Before I run `npm start`, I check that LM Studio has a model loaded and that Chrome is installed. Then:

1. Run `npm start`.
2. A QR code prints in the terminal. I scan it from my phone under WhatsApp, then Linked devices, then Link a device. I only do this once.
3. The session is saved in `.wwebjs_auth/`, so I never scan again. When I want to log out, I stop the bot and delete that folder.

## The knowledge base

`memory/knowledge.json` is the single source of truth and it is meant to be hand-edited. I edit mine by hand, and so can you:

```json
{
  "entries": [
    { "message": "what are your opening hours", "reply": "We're open 10am to 8pm, Monday to Saturday." }
  ]
}
```

`knowledge.db` is only a rebuild cache of that file, so you'll never edit it by hand. The bot rebuilds it at startup when the JSON changes, checking a content hash, so a warm restart costs milliseconds. It doesn't edit the JSON for you.

There is a `knowledge.example.json` in the repo root with three sample pairs. Copy it to `memory/knowledge.json` if you'd rather start from something than from an empty base.

Unknown questions fall through to the LLM, and the LLM's answers wait in the review queue.

## Reviewing what the LLM wants to learn

Send these from your own WhatsApp number, in any chat. I review every pair myself before it becomes an answer:

- `!review` shows the next queued pair
- `!approve` commits it into the knowledge base
- `!reject` discards it

A pair is only queued once. Duplicates of a pending question are ignored.

When a backlog builds up: `!review 5` lists the next five pairs numbered 1 to 5, and `!approve 1-5` (or `!reject 1-5`, or a list like `1,3`) acts on exactly those. There's no "approve everything" on purpose. One wrong tap must never dump a hundred unreviewed pairs into the brain.

## Admin commands

Send from the admin number, in any chat:

| Command | What it does |
|---|---|
| `!help` | Lists everything |
| `!pause` / `!resume` | Pause and resume replies globally |
| `!train q\|a` | Add a Q&A pair directly |
| `!forget q` | Remove a pair |
| `!correct old\|new` | Change the reply of an existing pair |
| `!blacklist n` / `!whitelist n` | Block or allow a number |
| `!group_allow [id]` / `!group_block [id]` | Manage which groups the bot answers in |
| `!learning on/off` | Toggle learning entirely |
| `!export_kb` | Export the knowledge base |
| `!review N` / `!approve 1-3` / `!reject 1-3` | Review and act on a numbered batch of queued pairs |
| `!misses [N]` | The questions the bot could not answer, most frequent first |
| `!sendmedia <jid> <path> [caption]` | Send a file to a chat. Replying to a customer's message with `!sendmedia <path> [caption]` sends it there |
| `!backup` | Snapshot the state files |
| `!stats` | Counters since the last restart |
| `!quiet on/off` | Hide the per-message decision line in the terminal |
| `!digest` | Print today's digest now |
| `!dnd_set 22:00 08:00` | Quiet hours |

## The dashboard

A local web dashboard is being built in phases. What exists today is the server, and it's deliberately boring:

- It lives inside the bot process and binds to `127.0.0.1` only, so nothing on your network can reach it
- Every route needs an `Authorization: Bearer <token>` header. A missing header, a wrong scheme or a wrong token all get the same bare `401` with no hints
- If `DASHBOARD_TOKEN` is empty, or the port is taken, the server refuses to start and prints one loud line. The bot carries on either way
- I keep the dashboard switched off unless I'm actively debugging something
- Shutdown closes the listener, waits a short grace window for in-flight requests, then force-closes stragglers, so an abandoned browser tab can never hang a Ctrl+C

The only routes today are `GET /health` and `GET /`. `/health` answers with uptime, and `/` returns a clean `503` until the frontend is built with `npm run build:dashboard`. The chat, VirusTotal and log screens come next.

Try it once the bot is running:

```bash
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:7800/health
```

The screens themselves arrive in 6.6.0.

## Testing

```bash
npm test
```

558 checks across fifteen suites, plus a boot suite that starts the real `bot.js` with stubbed WhatsApp and proves a clean Ctrl+C shutdown. Everything runs offline: WhatsApp, the network and the embedding model are stubbed, the suite finishes in seconds, and it never touches your real session or data. It snapshots and restores every project file it touches, so a test run leaves the project exactly as it found it.

## Project layout

```
bot.js                entry point: client setup, boot order, graceful shutdown
botV6.5.js            the original single file, kept untouched. npm run start:legacy runs it
src/
  config.js           every tunable number in one place
  handler.js          message pipeline: intake, media, links, search, decision, send
  knowledge.js        the base itself: rebuild, cache, search, learning gates
  llm.js              LM Studio calls, watchdog, system prompt
  security.js         URL extraction, VirusTotal, link ledger
  sendGuard.js        send pacing, hourly cap, identical-text suppression
  embeddings.js       all-MiniLM-L6-v2 wrapper
  humanNeeded.js      three-layer human-needed detection
  dashboard.js        the local dashboard server: auth, routes, fail-closed boot
  memory.js           chat memory, retention sweeps, flush timer
  admin.js            the self-chat command surface
  ...                 tracking, digest, notify, pause, reconnect, logging, db, text,
                      state, util, embedCache, handoff, mediaSend, misses
test/                 the sixteen suites plus their stubs
```

## Roadmap

- **6.6.0**: the dashboard screens themselves (live chat, link scan table, logs), then the admin controls
- Later: the Baileys transport migration (currently postponed), voice and OCR, scheduled broadcasts, group moderation
- Not planned for now: cloud LLMs, a plugin system, multi-session

The full plan lives in `Bot Reviews/plans/web-dashboard-implementation-plan.md` in my working copy, and it is not part of this repo.

## Community

This is a small personal project and I'm its only maintainer, so please read these before you open anything.

- [Code of Conduct](CODE_OF_CONDUCT.md) how I expect people to treat each other here, and what I can honestly promise back
- [Security Policy](SECURITY.md) how to report a vulnerability privately
- [Changelog](CHANGELOG.md) what changed in each version

## Troubleshooting

**`better-sqlite3` or `sharp` won't load after install.** Run `npm rebuild better-sqlite3` or `npm rebuild sharp`. Native binaries only get placed by install scripts.

**"Failed to load embedding model" and the bot still answers.** The same cause as above, and it's `sharp` that breaks. Without the model, semantic search quietly falls back to word overlap, so answers get weaker before anything looks broken. Fix it with `npm rebuild sharp` and restart.

**No QR code appears.** Make sure Chrome is installed and that nothing else is using the default session folder. Stop the bot, delete `.wwebjs_auth/`, and start again.

**The dashboard prints DISABLED.** That's the fail-closed path working. Set `DASHBOARD_TOKEN` and `DASHBOARD_PORT` in `.env`, or leave them empty and run without the dashboard.

**`/` returns `503 frontend_not_built`.** The frontend isn't built yet. Run `npm run build:dashboard` when the UI lands.

**A customer gets no reply at all.** That's usually the human-needed path doing its job. Check `logs/human_needed.txt` and `logs/errors.txt` before assuming a bug.

## Notes and limits

- The bot is only as good as your knowledge base plus a 1.7B model, and small models give generic answers sometimes. The review queue is the guard for exactly that. I read the miss log most weeks to see what my customers asked that the bot couldn't answer, and that's usually what I add next.
- Customer replies keep the `QUICK REPLY : ` prefix. That's a deliberate choice, because it helps me tell the bot's replies from mine. It's not a bug.
- `memory/`, `logs/`, `media/` and `llm_context/` hold data. The bot creates them on first run and they are gitignored.
- The bot sends from a WhatsApp Web session, which is against the terms of the consumer app. Use a number you can afford to lose, and don't blast volume at it. The send guard helps, but the risk is yours.
- If you enable the dashboard, keep `DASHBOARD_TOKEN` long and random. It's the only thing standing between your logs and anyone who can reach the port.

## License

Apache 2.0. See [LICENSE](LICENSE).
