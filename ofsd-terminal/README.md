# OFSD Terminal

A private, local workspace where you run Claude-powered research tools and watch them work live.
Everything runs on your computer. API keys stay in one file (`.env`) that the browser never sees.

**Build status:** Steps 1 and 2 of 4 done (app shell + web crawler).
The thesis builder and brain screens are placeholders until steps 3 and 4.

---

## First-time setup (about 5 minutes)

### 1. Install Node.js (once)

Go to <https://nodejs.org>, download the **LTS** installer, and run it. Version 22.13 or newer is needed.
To check it worked, open the **Terminal** app and type `node -v`. You should see something like `v22.x` or higher.

### 2. Get the code

In Terminal:

```bash
git clone https://github.com/cmedanny/platform.git
cd platform
git checkout claude/ofsd-terminal-app-mpn1kb
cd ofsd-terminal
```

(If macOS asks to install "command line developer tools" for `git`, click Install and run the commands again.)

### 3. Install (the one install command)

```bash
npm install
```

This downloads everything the app needs and creates your settings file, `ofsd-terminal/.env`.

### 4. Add your Claude API key

1. Go to <https://console.anthropic.com>, sign in, open **API Keys**, click **Create Key**, and copy it.
2. Open the settings file. In Terminal, from the `ofsd-terminal` folder: `open -e .env` (opens it in TextEdit).
3. Paste your key right after `ANTHROPIC_API_KEY=` with no spaces, like:
   `ANTHROPIC_API_KEY=sk-ant-api03-...`
4. While you're there, replace the SEC line with your real name and email (SEC requires this for step 2):
   `SEC_USER_AGENT="OFSD Terminal Jane Doe jane@example.com"`
5. Save and close.

Leave `TWITTERAPI_IO_KEY` and `DISCORD_WEBHOOK_URL` empty for now. We set those up in step 3.

### 5. Run (the one run command)

```bash
npm start
```

Your browser opens at <http://localhost:5173>. Keep the Terminal window open while you use the app.
To stop, click the Terminal window and press **Ctrl + C**.

Next time, you only need: `cd` into the `ofsd-terminal` folder, then `npm start`.

---

## Using it

| Do this | What happens |
|---|---|
| Type a question and press Enter | Claude answers, streaming into the command log |
| `/help` | Lists every command |
| `/runs` | Opens the Runs list. Every command is saved and has a Replay button |
| `/clear` | Clears the on-screen log (runs stay saved) |
| ⌘K (Ctrl+K on Windows) | Jumps to the command bar from anywhere |
| ↑ / ↓ in the bar | Previous commands |
| Tab | Completes a slash command |

The top-right dots show which connections are set up (lime = ready). Click them to open **Settings**.
If you edit `.env` while the app is running, it picks up the change within about 20 seconds. No restart needed.

Anything Claude writes is tagged **DRAFT**.

---

## Web crawler

| Type this | What it reads |
|---|---|
| `/crawl NVDA 10-Q` | NVIDIA's latest quarterly report from SEC EDGAR |
| `/crawl AAPL 10-K` | Apple's latest annual report |
| `/crawl MSFT 8-K` | Latest 8-K, plus its press release (exhibit 99) when there is one |
| `/crawl NVDA` | Latest filing of the default form (set in the inspector) |
| `/crawl https://…` | Any public web page |

You can also start a crawl from the inspector's **New crawl** section.

What you see while it runs, all driven by the real download and parse:

- **Network strip:** every real request (GET, status, size, time) with a live byte counter.
- **Raw source:** the actual HTML streaming in. Tags are dim, text is bright. Once reading starts, it follows the spider and underlines the exact bytes being read.
- **Document:** the rendered page. A large spider walks down it on a wandering path, plants its feet on the words, and finds each extracted value with a silk line (the highlight traces itself in, then settles). It only highlights extracted things: numbers, $, %, dates, fiscal periods, line items, section headers.
  Colors: **lime** = current period, **magenta** = prior period, **cyan** = labels, **orange** = section headers.
- **HUD:** live counts, speed (0.5x to 4x, default 1x), Replay, Jump to statements, and **Ask this document** (press `/`).

When it finishes, the **Report** tab shows Claude's summary, key figures (current, prior, change, and a source link that
walks the spider back to the number) and observations. Export to CSV or Excel from there. The **Attach to thesis**
switch marks a crawl as extra context for the thesis builder (step 3).

The spider wanders slowly down the page and reads values as it passes them. A full 10-Q (about 43 pages) takes
roughly 10 minutes at the default 1x, 5 at 2x and 2.5 at 4x. The Report tab is ready as soon as Claude finishes,
you don't have to wait for the spider. Use **Jump to statements** to go straight to the numbers.
Without a Claude key the crawl still works; you just don't get the summary and observations.

Every crawl is saved. Reopen one from **Recent** in the inspector, or replay it from **Runs**.

---

## Settings you can change in `.env`

| Line | What it does |
|---|---|
| `ANTHROPIC_API_KEY` | Your Claude key |
| `CLAUDE_MODEL` | Which Claude model to use. Default `claude-opus-5-5` |
| `SEC_USER_AGENT` | Your name and email, sent to SEC EDGAR as they require (step 2) |
| `TWITTERAPI_IO_KEY` | TwitterAPI.io key (step 3) |
| `DISCORD_WEBHOOK_URL` | Webhook for your private Discord channel (step 3) |
| `PORT` | Backend port. Leave as 8787 unless something else uses it |

If Claude declines a request for policy reasons, Anthropic automatically retries it on a fallback model
inside the same call ("server-side fallback"). It's on by default.

---

## Troubleshooting

| You see | Fix |
|---|---|
| `OFSD Terminal needs Node.js 22.13 or newer` | Install the LTS from nodejs.org (step 1) |
| "No Claude API key found" in the log | Paste your key into `.env` (step 4) and save |
| "Claude rejected the API key" | The key is wrong or was revoked. Create a new one |
| "out of credits" | Add credits in the Anthropic Console (Billing) |
| "Backend offline" in the top bar | The Terminal window running `npm start` was closed. Run it again |
| "SEC needs your name and email" | Fill in `SEC_USER_AGENT` in `.env` (step 4) |
| "SEC refused the request (403)" | `SEC_USER_AGENT` needs a real-looking name and email |
| "Couldn't find ticker" | Check the spelling. EDGAR only has US-listed companies |
| "found no readable text" | That page builds itself with JavaScript, which the crawler can't run |
| `Port 5173 is in use` | Another copy is already running. Close it, or use the browser tab it opened |

Your saved runs live in `ofsd-terminal/data/ofsd.sqlite`. Back up that file to keep your history.

---

## For future modules (how the code is laid out)

```
src/
  shared/types.ts          types used by both sides
  server/                  Express backend (keys live here only)
    index.ts               routes + command dispatch
    runs.ts                every run is an event timeline in SQLite (powers live view + replay)
    claude.ts              Claude streaming + plain-English errors
    crawler/               fetch (live network events), EDGAR lookups, streaming HTML parser, extractor, Claude analysis
    modules/               one file per backend module
  web/                     React front end
    shell/                 sidebar, top bar, inspector, command log, command bar
    ui/                    design-system components (Section, Segmented, Select, Switch...)
    styles/tokens.css      colors, type sizes, motion
    modules/               one folder per screen; registry.ts lists them
      crawler/             session (live/replay), spider rig + reader, raw/doc/network panes, HUD, report
```

Adding a module (for example a macro data panel) means: one folder in `src/web/modules/`, one line in
`src/web/modules/registry.ts`, and (if it needs the backend) one file in `src/server/modules/` plus one line in
`src/server/modules/index.ts`. Existing modules don't change.
