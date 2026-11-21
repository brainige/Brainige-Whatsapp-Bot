# Brainige WhatsApp Bot

![version](https://img.shields.io/badge/version-6.5.0-informational)
![license](https://img.shields.io/badge/license-Apache%202.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

Brainige WhatsApp Bot answers customer questions on business and personal WhatsApp accounts. It searches a hand-edited knowledge base first. When no answer matches, it asks a local large language model (LLM). An LLM answer enters the knowledge base only after the owner approves it.

You run the bot on your own machine, so customer data stays local. It controls WhatsApp Web through headless Chrome and runs the LLM in LM Studio. The optional VirusTotal link check is the only external call.

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
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
- [Support](#support)
- [Troubleshooting](#troubleshooting)
- [Notes and limits](#notes-and-limits)
- [License](#license)

## What it does

The bot includes the following features:

- **Hybrid search:** Combines word overlap with `all-MiniLM-L6-v2` embeddings to match questions without shared keywords
- **Multilingual replies:** Answers in English, Bengali, and Hindi, including greetings and unknown-answer fallbacks
- **Local LLM fallback:** Uses any LM Studio model when no stored answer matches, with Qwen3-1.7B as the default and a three-sentence cap
- **Human review queue:** Requires owner approval before an LLM-generated pair enters the knowledge base
- **Human-needed detection:** Uses keyword, context, and semantic checks for complaints, pricing disputes, and urgent requests
- **Link safety:** Checks VirusTotal, records local verdicts, and alerts the owner about malicious links without notifying customers
- **Send pacing:** Adds 3 to 6 second gaps, queues replies above roughly 25 per hour, and suppresses duplicates
- **Name-triggered pause:** Pauses auto-replies when a customer addresses the owner by name
- **Owner handoff:** Pauses replies for 30 minutes after an owner phone reply, while logging and learning continue
- **Media sending:** Sends files with `!sendmedia` under the same 20 MB cap and logging as incoming media
- **Miss log:** Records unanswered questions for `!misses`
- **Group support:** Answers in approved groups and learns only from the owner's replies there
- **Daily digest:** Summarizes activity at 21:00
- **Local logging:** Stores chats, errors, saved media, and link verdicts locally

The review queue, miss log, and owner handoff reduce the risk of a small model giving a customer the wrong answer.

## Tech stack

| Part | Tools |
|---|---|
| Runtime | Node.js 20 or newer, JavaScript |
| WhatsApp | `whatsapp-web.js`, headless Chrome |
| Storage | `better-sqlite3`, JSON files |
| Knowledge search | `@xenova/transformers`, `all-MiniLM-L6-v2` |
| Local AI | LM Studio, Qwen3-1.7B by default |
| Dashboard | React, Vite, and GSAP, currently in development |

## Requirements

- Install Node.js 20 or newer
- Install Google Chrome so `whatsapp-web.js` can control it headlessly
- Install LM Studio on the same machine and load a model. Any model served by LM Studio works. The default config expects Qwen3-1.7B at `http://127.0.0.1:1234`. If you choose another model, set `LLM_MODEL`
- Add a VirusTotal API key if you want link scanning. You can use the free tier. If you don't add a key, the bot records links without scanning them

## Setup

Once you've cloned the repository, run these commands in your terminal:

```bash
git clone https://github.com/brainige/Brainige-Whatsapp-Bot.git
cd Brainige-Whatsapp-Bot
npm install
cp .env.example .env
```

If `cp` isn't available in your Windows terminal, use your file manager to copy `.env.example` to `.env` instead.

On Windows, `better-sqlite3` and `sharp` need native binaries placed by install scripts. If either module doesn't load, run `npm rebuild better-sqlite3` or `npm rebuild sharp`.

Open `.env` and fill in the values below. If you don't have a VirusTotal key yet, leave it empty.

| Variable | What it is |
|---|---|
| `VT_API_KEY` | VirusTotal key. Leave empty to skip link scanning. |
| `ADMIN` | Your WhatsApp number in JID form: country code + number + `@c.us`. Commands only work from this number. |
| `LLM_URL` | Where LM Studio listens. Default `http://127.0.0.1:1234/v1/chat/completions`. |
| `LLM_MODEL` | Model name as LM Studio shows it. Default `Qwen3-1.7B-Instruct`. |
| `DASHBOARD_TOKEN` | Bearer token for the local dashboard. Leave it empty to keep the dashboard off while the bot runs normally. |
| `DASHBOARD_PORT` | Port for the dashboard. Default `7800`. |
| `BRAND_NAME` | Product name on the terminal banner, `!help`, and the daily digest. Default `Brainige`. |
| `OWNER_DISPLAY` | Your name in customer replies. Default `Utsab/Avi`. |
| `OWNER_DISPLAY_BN` / `OWNER_DISPLAY_HI` | Your name in Bengali and Hindi replies. Default `উৎসব/আভি` / `उत्सब/अवि`. |
| `PAUSE_NAMES` | Comma-separated names that pause replies when a customer addresses you. Default `utsab,avi`. An empty value turns the trigger off. |

## Running it

Before you start the bot, load a model in LM Studio and install Chrome.

1. Run `npm start`.
2. Scan the QR code shown in the terminal. Open WhatsApp on your phone, then go to **Linked devices** and **Link a device**. You'll only need to do this once.
3. Keep the session in `.wwebjs_auth/`. You won't need another scan. When you want to log out, stop the bot and delete that folder.

## The knowledge base

Edit `memory/knowledge.json` by hand. It's the single source of truth:

```json
{
  "entries": [
    { "message": "what are your opening hours", "reply": "We're open 10am to 8pm, Monday to Saturday." }
  ]
}
```

Don't edit `knowledge.db`. It's only a rebuild cache of the JSON file. At startup, the bot checks a content hash and rebuilds the database when the JSON changes. A warm restart takes milliseconds. The bot doesn't edit the JSON for you.

After you edit the file by hand, you'll need to restart the bot to rebuild the cache and search your new pairs.

You'll find `knowledge.example.json` in the repository root. It contains three sample pairs. Copy it to `memory/knowledge.json` if you want examples instead of an empty base.

Unknown questions go to the LLM. Their answers wait in the review queue before they can enter the knowledge base.

## Reviewing what the LLM wants to learn

Send these commands from your admin WhatsApp number in any chat. Review each pair before you approve it:

- `!review` shows the next queued pair
- `!approve` adds it to the knowledge base
- `!reject` discards it

The queue ignores duplicate pending questions, so you won't review the same pair twice.

Use `!review 5` when a backlog builds up. You'll see the next five pairs numbered from 1 to 5. Run `!approve 1-5` or `!reject 1-5` on that batch. You can also select entries with a list like `1,3`.

There's no "approve everything" command. This prevents one wrong tap from adding a hundred unreviewed pairs to the knowledge base.

## Admin commands

Send these commands from the admin number in any chat:

| Command | What it does |
|---|---|
| `!help` | List all commands |
| `!pause` / `!resume` | Pause or resume replies globally |
| `!train q\|a` | Add a Q&A pair directly |
| `!forget q` | Remove a pair |
| `!correct old\|new` | Change the reply of an existing pair |
| `!blacklist n` / `!whitelist n` | Block or allow a number |
| `!group_allow [id]` / `!group_block [id]` | Manage which groups the bot answers in |
| `!learning on/off` | Turn learning on or off |
| `!export_kb` | Export the knowledge base |
| `!review N` / `!approve 1-3` / `!reject 1-3` | Review and act on a numbered batch of queued pairs |
| `!misses [N]` | List unanswered questions, most frequent first |
| `!sendmedia <jid> <path> [caption]` | Send a file to a chat. Reply to a customer's message with `!sendmedia <path> [caption]` to send it there |
| `!backup` | Snapshot the state files |
| `!stats` | Show counters since the last restart |
| `!quiet on/off` | Hide or show the per-message decision line in the terminal |
| `!digest` | Print today's digest now |
| `!dnd_set 22:00 08:00` | Set quiet hours |

## The dashboard

The local web dashboard is still under development. The current codebase includes only its server:

- It runs inside the bot process and binds to `127.0.0.1` only. Other devices on your network can't reach it
- Every route requires an `Authorization: Bearer YOUR_DASHBOARD_TOKEN` header. A missing header, wrong scheme, or wrong token returns the same bare `401`
- If you leave `DASHBOARD_TOKEN` empty or choose a busy port, the server won't start. It prints one clear error, and your bot continues running
- Shutdown closes the listener and allows a short grace period for active requests. It then force-closes remaining connections so a browser tab can't hang Ctrl+C

The only routes are `GET /health` and `GET /`. The health route returns uptime. You'll get a `503` from `/` because the frontend is not part of this release yet. Chat, VirusTotal, and log screens are planned next.

You can try the health route while the bot is running. Replace the placeholder with your token:

```bash
curl -H "Authorization: Bearer YOUR_DASHBOARD_TOKEN" http://127.0.0.1:7800/health
```

Version 6.6.0 will add the dashboard screens.

## Testing

You can run the full suite with:

```bash
npm test
```

The test command runs 16 suites, including a boot suite. The boot suite starts the real `bot.js` with stubbed WhatsApp and checks a clean Ctrl+C shutdown.

The suites run offline. They use test data, not your real WhatsApp session. WhatsApp, network access, and the embedding model are stubbed. Each suite snapshots and restores the project files it touches.

## Project layout

```
bot.js                entry point: client setup, boot order, graceful shutdown
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
test/                 the 16 suites plus their stubs
```

## Roadmap

- **6.6.0** will add dashboard screens for live chat, link scans, and logs, followed by admin controls.
- **Later versions** may cover the postponed Baileys migration, voice messages, text extraction from images, scheduled broadcasts, and group moderation.
- **Cloud LLMs, a plugin system, and multi-session support** aren't planned for now.

The full dashboard plan isn't included in this repository.

## Community

This personal project has one maintainer. Please read these documents before opening an issue or pull request:

- [Code of Conduct](CODE_OF_CONDUCT.md): Community expectations and enforcement
- [Security Policy](SECURITY.md): Private vulnerability reporting
- [Changelog](CHANGELOG.md): Changes by version

## Support

If you find a bug or need a feature, use [GitHub Issues](https://github.com/brainige/Brainige-Whatsapp-Bot/issues). Please don't use public issues for security reports. Follow the [Security Policy](SECURITY.md) instead.

## Troubleshooting

**`better-sqlite3` or `sharp` won't load after install.** Run `npm rebuild better-sqlite3` or `npm rebuild sharp`. Install scripts place the required native binaries.

**The embedding model won't load, but the bot still answers.** Repair `sharp` with `npm rebuild sharp`, then restart. Without the model, semantic search falls back to word overlap. Your answers can get weaker without an obvious failure.

**You don't see a QR code.** Check that Chrome is installed and no other process is using the default session folder. Stop the bot, delete `.wwebjs_auth/`, and start again.

**The dashboard prints `DISABLED`.** Set `DASHBOARD_TOKEN` and `DASHBOARD_PORT` in `.env`. You can also leave them empty and run without the dashboard.

**`/` returns `503 frontend_not_built`.** The frontend is not included in this release yet.

**A customer gets no reply.** Check `logs/human_needed.txt` and `logs/errors.txt`. The human-needed path may have paused the reply deliberately.

## Notes and limits

- The bot depends on your knowledge base and a small local model. Small models sometimes give generic or wrong answers. Review the miss log regularly and add the answers your customers need.
- Customer replies keep the `QUICK REPLY : ` prefix. It distinguishes bot replies from owner replies and is deliberate.
- The `memory/`, `logs/`, `media/`, and `llm_context/` directories hold data. The bot creates them on first run, and Git ignores them.
- The bot sends through a WhatsApp Web session, which is against the consumer app's terms. Use a number you can afford to lose, and avoid high message volumes. The send guard reduces risk but doesn't remove it.
- If you enable the dashboard, you'll need a long, random `DASHBOARD_TOKEN`. It protects your logs from anyone who can reach the port.

## License

Apache 2.0. See [LICENSE](LICENSE).
