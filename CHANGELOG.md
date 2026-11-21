# Changelog

All notable user-facing changes to Brainige WhatsApp Bot are listed here, newest first. Entries are added as changes ship. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

These changes will ship as **6.6.0** after the web dashboard is complete.

### Added

- Added a local dashboard server in `src/dashboard.js`. It runs inside the bot process and binds only to `127.0.0.1`.
- Added Bearer authentication to every dashboard route. Missing or incorrect credentials return the same bare `401` response.
- Added fail-closed dashboard startup for missing tokens and busy ports. The bot continues running if the dashboard cannot start.
- Added bounded dashboard shutdown. Active requests receive a short grace period before remaining connections are closed.
- Added real-socket dashboard tests for authentication, loopback binding, shutdown, busy ports, and token leaks.
- Added React, Vite, and GSAP as local dependencies for the planned dashboard frontend. The dashboard makes no requests to outside hosts.

### Fixed

- Fixed the dashboard shutdown test to cover idle keep-alive sockets and stuck requests separately.
- Fixed the VirusTotal spacing test to read the limiter schedule instead of unreliable wall-clock gaps.
- Fixed unsafe media extensions so downloaded files stay inside the correct chat folder.
- Fixed group folder names and log handling to block path escapes and newline-based log forgery.
- Fixed LLM transcript parsing to block forged roles and topic markers.
- Fixed `!review N` output to show complete pairs and flag links, payment terms, and long numbers.
- Fixed URL verdict caching so path and query casing cannot cause collisions.

### Changed

- Documented the `npm rebuild sharp` requirement after `npm install --ignore-scripts` on Windows. Without the native binary, semantic search falls back to word overlap.
- Removed redundant emoji replacements and reused prepared SQLite statements to reduce hot-path work.
- Made VirusTotal outage alerts immediate instead of batching them.
- Limited media folders to 400 files per chat and VirusTotal wait queues to 20 requests.
- Restricted dashboard Host headers and blocked admin commands from group chat IDs.

### Security

- Capped link and email scans at 4,000 characters to prevent long messages from blocking the event loop.
- Removed sensitive request details from fatal error output.
- Tightened system-prompt rules so user text cannot become instructions, commands, or role changes.

## [6.5.0] - 2026-10-26

Version 6.5.0 moved the existing single-file bot into modules and added regression coverage. Most features below already existed in the single-file version.

### Added

- Added a modular layout built around `bot.js` as the entry point.
- Added hybrid knowledge search using word overlap and `all-MiniLM-L6-v2` embeddings.
- Added English, Bengali, and Hindi replies, including greetings, apologies, and unknown-answer fallbacks.
- Added local LLM fallback through LM Studio. Replies use Qwen3-1.7B by default and are capped at three sentences.
- Added a human review queue with `!review`, `!approve`, and `!reject`. LLM-generated pairs require owner approval before entering the knowledge base.
- Added numbered review batches with `!review 5`, `!approve 1-3`, `!reject 1-3`, and lists such as `1,3`.
- Added a miss log and the `!misses` command, sorted by question frequency.
- Added `!sendmedia` for price lists, catalogs, and stickers, with the same 20 MB cap and logging as incoming media.
- Added owner handoff for 30 minutes after an owner phone reply. Logging and learning continue during the pause.
- Added configurable identity through `BRAND_NAME`, `OWNER_DISPLAY`, `OWNER_DISPLAY_BN`, `OWNER_DISPLAY_HI`, and `PAUSE_NAMES`.
- Added name-triggered pauses for direct customer chats.
- Added scheme-less URL detection and spaced VirusTotal checks. Malicious links trigger immediate owner alerts.
- Added a send guard with 3 to 6 second gaps, a roughly 25-per-hour queue, and identical-reply suppression.
- Added group allowlists and learning from owner replies in approved groups.
- Added a daily digest at 21:00, `!digest` on demand, and quiet hours through `!dnd_set`.
- Added atomic writes and rolling backups for `knowledge.json`, `settings.json`, and `chat_memory.json`.
- Added a single-flight reconnect controller with a fresh client for each attempt.

### Changed

- Limited learning to owner phone replies and the LLM. Removed customer-to-customer pairing so customer guesses cannot become answers.
- Added learning gates for question shape, cosine similarity, and shared words. Question-shaped answers always go to review.
- Reduced warm-boot time by rebuilding `knowledge.db` only after its fingerprint or row count changes.
- Reduced the embedding cache size with base64 values and capped it at 25,000 entries.
- Added a word index for large knowledge bases and limited semantic scoring to the top 200 lexical candidates.
- Enabled SQLite WAL mode and 24-hour display-name caching.
- Added retention sweeps for media older than 60 days and inactive chat memory. `conversations.db` is never trimmed.
- Normalized punctuation in `!forget` and `!correct` so apostrophes no longer prevent matches.

### Security

- Added system-prompt rules that treat user text and transcript lines as chat content, never instructions.
- Removed unsafe-link warnings from customer replies. Owners receive alerts and ledger entries instead.
- Fixed trusted-domain checks to parse hostnames, so `youtube.com.evil.xyz` is not treated as YouTube.
- Filled 43 empty catch blocks, added repeated-error coalescing, and capped `logs/errors.txt` rotation at 1 MB.
- Added `uncaughtException` and `unhandledRejection` hooks.
- Persisted processed message IDs immediately to prevent replays after a crash.

### Testing

- Expanded offline coverage to 16 suites, including a boot suite for startup and clean Ctrl+C shutdown.
- Added stubs for WhatsApp, network access, and the embedding model.
- Added snapshots and restores for project files touched by tests.

## Tags

No git tags or compare links have been published yet.
