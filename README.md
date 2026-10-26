# Brainige WhatsApp Bot

This is the auto-reply bot I built for my business WhatsApp and normal WhatsApp. It answers customer questions from a knowledge base you edit by hand. When the base doesn't have an answer, it asks a local LLM and replies with that. Nothing the LLM says enters the knowledge base until you've approved it yourself.

It runs on your own machine, so your customer data stays local. WhatsApp Web is driven through headless Chrome, and the LLM runs in LM Studio. The only outside call is the optional VirusTotal link check.

## What it does

- Hybrid search over your Q&A: word overlap plus embeddings (all-MiniLM-L6-v2), so "how much for delivery" finds "delivery charge" even without shared keywords
- Replies in the customer's language: English, Bengali, and Hindi, including the canned greetings and the I-don't-know fallback line
- Local LLM fallback: when no stored answer scores high enough, the bot asks Qwen3-1.7B in LM Studio and replies with the answer capped at three sentences
- Human review queue: every LLM answer goes to a queue. You approve or reject it from your own WhatsApp. The bot never promotes an LLM answer into the knowledge base on its own
- Human-needed detection: three layers (keyword, context, semantic) catch the messages a bot shouldn't touch, like complaints, pricing disputes, or anything urgent
- Link safety: every link in a message is checked against VirusTotal and written to a local ledger. Customers never see the check. You get the flags, plus an immediate alert for malicious links
- Send pacing: a minimum gap between sends, an hourly cap, and suppression of identical replies, so a busy hour doesn't look like spam to WhatsApp
- Name-triggered pause: a customer writing your name (see `PAUSE_NAMES` below) pauses auto-replies for that chat, so you can step in yourself
- Owner handoff: when you reply to a customer from your own phone, the bot stands down for that chat for 30 minutes so you can take the thread. Logging and learning keep running, and each reply from you pushes the stand-down further out
- Send media: `!sendmedia` pushes a file (price list, catalog, sticker) into a chat, through the same size cap and logging as incoming media
- Miss log: every question the bot could not answer is recorded, so `!misses` tells you exactly what to teach it next
- Group support: whitelist the groups the bot may answer in, learn from your own replies in those groups, stay silent everywhere else
- Daily digest at 21:00 covering replies sent, messages skipped, pairs queued for review, and send-guard events
- Everything is logged locally: chats, errors, saved media, and the link ledger

## Requirements

You'll need:

- Node.js 20 or newer
- Google Chrome (the bot drives it headless through whatsapp-web.js)
- LM Studio running on this same machine, with a model loaded. Any model LM Studio serves works — the default config expects Qwen3-1.7B at `http://127.0.0.1:1234`, and you change it with `LLM_MODEL`
- A VirusTotal API key if you want link scanning. The free tier is enough. If you don't have one yet, links are still recorded, just not scanned

## Setup

```bash
git clone https://github.com/brainige/Brainige-Whatsapp-Bot.git
cd Brainige-Whatsapp-Bot
npm install
cp .env.example .env
```

Open `.env` and fill in the values below. If you skip the VirusTotal key, leave that one empty:

| Variable | What it is |
|---|---|
| `VT_API_KEY` | VirusTotal key. Leave empty to skip link scanning. |
| `ADMIN` | Your WhatsApp number in JID form: country code + number + `@c.us`. Commands only work from this number. |
| `LLM_URL` | Where LM Studio listens. Default `http://127.0.0.1:1234/v1/chat/completions`. |
| `LLM_MODEL` | Model name as LM Studio shows it. Default `Qwen3-1.7B-Instruct`. |
| `BRAND_NAME` | Product name on the terminal banner, `!help` and the daily digest. Default `Brainige`. |
| `OWNER_DISPLAY` | How you appear in customer replies. Default `Utsab/Avi`. |
| `OWNER_DISPLAY_BN` / `OWNER_DISPLAY_HI` | The same for Bengali and Hindi replies. Default `উৎসব/আভি` / `उत्सब/अवि`. |
| `PAUSE_NAMES` | Words that pause replies when a customer addresses you by name, comma separated. Default `utsab,avi`. An empty value turns the trigger off. |

Then:

1. Start LM Studio and load the model.
2. Run `npm start`.
3. A QR code prints in the terminal. Scan it from your phone under WhatsApp, then Linked devices, then Link a device.
4. The session is saved in `.wwebjs_auth/`, so you only scan once. To log out, stop the bot and delete that folder.

## The knowledge base

`memory/knowledge.json` is the single source of truth, and it's meant to be hand-edited:

```json
{
  "entries": [
    { "message": "what are your opening hours", "reply": "We're open 10am to 8pm, Monday to Saturday." }
  ]
}
```

`knowledge.db` is just a rebuild cache of that file, so you'll never edit it by hand. The bot rebuilds it at startup when the JSON changes (it checks a content hash, so a warm restart costs milliseconds), and it never edits the JSON for you.

There's a `knowledge.example.json` in the repo root with three sample pairs. Copy it to `memory/knowledge.json` if you'd rather start from something than from an empty base.

Unknown questions fall through to the LLM, and the LLM's answers wait in the review queue for you.

## Reviewing what the LLM wants to learn

Send these from your own WhatsApp number, in any chat:

- `!review` shows the next queued pair
- `!approve` commits it into the knowledge base
- `!reject` discards it

A pair only gets queued once. Duplicates of a pending question are ignored.

When a backlog builds up: `!review 5` lists the next five pairs numbered 1-5, and `!approve 1-5` (or `!reject 1-5`, or a list like `1,3`) acts on exactly those. There is deliberately no "approve everything" — one wrong tap must never dump a hundred unreviewed pairs into the brain.

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

## Testing

```bash
npm test
```

512 checks across fourteen suites, all offline. WhatsApp, the network, and the embedding model are stubbed, so the suite runs in seconds and never touches your real session or data files. It snapshots and restores everything it touches, so a test run leaves the project exactly as it found it.

## Project layout

```
bot.js             entry point: client setup, boot order, graceful shutdown
src/
  config.js        every tunable number in one place
  handler.js       message pipeline: intake, media, links, search, decision, send
  knowledge.js     the base itself: rebuild, cache, search, learning gates
  llm.js           LM Studio calls, watchdog, system prompt
  security.js      URL extraction, VirusTotal, link ledger
  sendGuard.js     send pacing, hourly cap, identical-text suppression
  embeddings.js    all-MiniLM-L6-v2 wrapper
  humanNeeded.js   three-layer human-needed detection
  memory.js        chat memory, retention sweeps, flush timer
  admin.js         the self-chat command surface
  ...              tracking, digest, notify, pause, reconnect, logging, db, text, state, util, embedCache, handoff, mediaSend, misses
test/              the fourteen suites plus stubs
```

## Notes and limits

- The bot is only as good as your knowledge base plus a 1.7B model, and small models like that give generic answers sometimes. The review queue is the guard for exactly that.
- Customer replies keep the `QUICK REPLY : ` prefix. That's a deliberate choice as it helps me differentiate between the bot's reply and my replies to my clients and my friends, not a bug.
- `memory/`, `logs/`, `media/`, and `llm_context/` hold data. When you start the bot, the bot creates everything so they're gitignored.
- On Windows, if `better-sqlite3` won't load after install, run `npm rebuild better-sqlite3`. That's a native-module quirk, not a broken install.
- The bot sends from a WhatsApp Web session, which is against WhatsApp's terms of the consumer app. Use a number you can afford to lose, and don't blast volume at it. The send guard helps, but the risk is yours.

## License

Apache 2.0. See [LICENSE](LICENSE).
