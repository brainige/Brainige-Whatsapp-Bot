# Security Policy

Brainige WhatsApp Bot answers real customer questions and stores private messages, files, and photos on one machine, so security reports need careful handling. Please report problems privately to protect users before a fix is available.

## Supported versions

| Version | Security fixes |
|---|---|
| 6.5.x | Yes |
| Older than 6.5.x | No |

Only the latest 6.5.x release receives security fixes, so update older versions and check whether the problem remains before reporting it.

## How to report a vulnerability

Please don't open a public issue, pull request, or discussion for a security problem. Public reports can expose users before a fix exists. Thank you for helping protect the project's users.

Use one of these private routes:

1. **Email:** Send your report to brainigemee@gmail.com.
2. **GitHub private vulnerability reporting:** Open the repository's **Security** tab and select **Report a vulnerability**. If that option is unavailable, use email instead.

Both email and GitHub private reports reach only the maintainer and remain private until disclosure.

## What to include in the report

Include as much of the following as you can:

- The affected version from `package.json`, so the maintainer can test the same release
- The file, command, or endpoint involved
- Numbered steps to reproduce the problem, including any configuration that changes the result
- The practical impact in plain language, including what an attacker could read, change, or send
- A safe proof of concept with customer data and secrets removed, if available
- A suggested fix, if you have one

Please don't send real API keys, tokens, passwords, or `.env` files. Describe the problem without secret values, and remove or mask any secrets in your examples.

## What happens after you report

1. We read every report and aim to reply within **2 to 3 weeks**. The project has one student maintainer, so we can't promise a 24-hour response.
2. We investigate each report to confirm whether it describes a vulnerability that affects this project.
3. We fix confirmed vulnerabilities, run relevant tests, and ship each fix in a release. We'll tell you when it's available.
4. If we reject a report, we'll explain why.
5. We'll credit you in the release notes unless you ask to remain anonymous.

We keep report details private until a fix is available, and then you may publish a write-up. Please coordinate the disclosure date with us.

## What is in scope

- Code in `bot.js`, `src/`, and the test suites
- The local dashboard server, its token check, and exposed data
- Local storage of customer messages, files, links, media, and logs
- Flaws that let someone read, change, or send messages without permission

## What is out of scope

- Report WhatsApp server or `whatsapp-web.js` issues upstream to Meta or the library maintainer.
- Report flaws in LM Studio, VirusTotal, or the embedding model to their respective projects.
- Don't report attacks that require the maintainer's phone, `.env`, or physical access to the machine.
- Don't flood third-party services or perform denial-of-service tests against them.
- Don't report known limits from the README unless you can show additional impact.

## Safe harbor

We won't take legal action against you if you report in good faith, follow this policy, and allow reasonable time for a fix. Research only on your own machine and your own WhatsApp number. Never test against other people's accounts or data.

## No bounty

We don't offer a bug bounty or payment because one maintainer runs this small business bot. We still welcome your reports and read every one.

## How the bot handles data

- The bot runs on one machine, and the dashboard binds only to `127.0.0.1` while refusing requests without a valid token.
- Customer messages, saved media, logs, and the knowledge base stay local in `memory/`, `logs/`, and `media/`, and the bot doesn't upload these files.
- The optional VirusTotal check is the only external call. VirusTotal receives submitted URLs only when `VT_API_KEY` is set, and the bot never prints your API key.
- The bot has no analytics, telemetry, or cloud account.
