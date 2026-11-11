# Security Policy

This bot answers real customers on a real WhatsApp number and keeps their messages, files and photos on one machine. That is why I would rather hear about a problem quietly than read about it in a public issue.

## Supported versions

| Version | Security fixes |
|---|---|
| 6.5.x | Yes |
| Anything older | No |

Only the latest 6.5.x line gets fixes. If you are on an older copy, update first and check whether the problem is still there.

## How to report a vulnerability

Please do **not** open a public issue, a pull request, or a discussion for a security problem. Public reports put every user of this bot at risk before a fix exists.

Two private ways to reach me:

1. **Email**: brainigemee@gmail.com
2. **GitHub private vulnerability reporting**: open the repository, go to the **Security** tab, and click **Report a vulnerability**. If that button is not there, the repo owner needs to switch it on under Settings, then Code security. In that case email me.

Either route reaches only me.

## What to put in the report

The more of this you include, the faster I can fix it:

- Which version you are on (`package.json` shows it, currently 6.5.0)
- Which file, command or endpoint behaves badly
- Steps to reproduce it, in order
- What an attacker could actually do with it, in plain words
- A suggested fix, if you have one

Please do not send real API keys, tokens, or a copy of a customer's `.env`. A description is enough. If you must show a secret, blank out the value first.

## What happens after you report

1. I read it and reply to you. Realistically **2 to 3 weeks**. I'm a student and this is a side project, so I won't promise 24 hours I can't keep.
2. If I agree it is a vulnerability, I fix it, run the test suite, and ship it in the next release. I will tell you when it is out.
3. If I decide it is out of scope or not a vulnerability, I will tell you why rather than going silent.
4. You get credited in the release notes unless you ask to stay anonymous.

I aim to keep details private until a fix is available. After that I am happy for the write-up to be public.

## What counts as in scope

- This repository's code: `bot.js`, everything in `src/`, and the test suites
- The local dashboard server, its token check, and what it exposes
- How the bot stores customer data on disk, and how it handles files, links and media
- Anything that lets someone read, change, or send messages they should not be able to

## What is out of scope

- WhatsApp's own servers, and the `whatsapp-web.js` library itself. Report those upstream to Meta and to the library maintainer.
- Third-party services the bot calls: LM Studio, VirusTotal, and the embedding model.
- Anything that needs my phone, my `.env`, or physical access to the machine the bot runs on.
- Flooding a service I do not control to slow it down.
- Problems already listed as known limits in the README, unless the report shows they are worse than I thought.

## Safe harbour

If you report in good faith, stay inside this policy, and give me a reasonable chance to fix things, I will not take legal action against you. Research on your own machine and your own WhatsApp number is fine. Do not test against other people's accounts or data.

## No bounty

There is no bug bounty and no payment. I am one person running a small business bot, so there is nothing to pay from. Reports are still welcome and I read every one.

## How the bot handles data, so you can judge the risk

- It runs on one machine and listens on `127.0.0.1` only. The dashboard server refuses every request without a valid token and never binds to the network.
- Customer messages, saved media, logs and the knowledge base stay local, in `memory/`, `logs/` and `media/`. Nothing is uploaded anywhere.
- The only outside call is the optional VirusTotal link check, and only when `VT_API_KEY` is set in `.env`. It's read from `.env` and never printed.
- There is no analytics, no telemetry, and no cloud account of any kind.
