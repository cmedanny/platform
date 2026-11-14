# OFSD Terminal

A private, local workspace where you run Claude-powered research tools and watch them work live.
Everything runs on your computer. API keys stay in one file (`.env`) that the browser never sees.

**Build status:** All 4 steps done: app shell, web crawler, thesis builder, and Brain.

---

## First-time setup (about 5 minutes)

**On Windows, the easy way:**

1. Install Node.js: go to <https://nodejs.org>, download **LTS**, run it, click Next through it.
2. Download OFSD as a ZIP: <https://github.com/cmedanny/platform/archive/refs/heads/claude/ofsd-terminal-app-mpn1kb.zip>
3. Right-click the ZIP → **Extract All** → **Extract**.
4. Open the extracted folder, then the **ofsd-terminal** folder, and double-click **Start-OFSD-Windows.bat**.
   (If Windows says "Windows protected your PC", click **More info** → **Run anyway**. It's the starter in this folder.)
5. The first time, it installs everything and opens Notepad: paste your Claude key after `ANTHROPIC_API_KEY=`,
   put your name and email in `SEC_USER_AGENT`, press Ctrl+S, close Notepad. Your browser opens OFSD Terminal.

Next time, just double-click **Start-OFSD-Windows.bat** again. The steps below are the manual way (and for Mac).

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
| `/note <text> #tag` | Saves a note to the Brain (first line is the title) |
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

## Thesis builder

### One-time setup

1. **TwitterAPI.io key.** Sign up at <https://twitterapi.io>, open the dashboard, copy your API key, and paste it after
   `TWITTERAPI_IO_KEY=` in `.env`. They charge per post returned; one run reads at most 400 posts.
2. **Discord webhook for your private channel.** In Discord: hover the channel → gear icon (Edit Channel) →
   **Integrations** → **Webhooks** → **New Webhook** → **Copy Webhook URL**. Paste it after `DISCORD_WEBHOOK_URL=` in `.env`.
   Anyone with that URL can post to the channel, so keep it private like a password.
3. **Your accounts.** In the app: **Thesis → Accounts**. Type a handle (or paste several at once), pick its tags
   (rates, Fed, credit, FX, data) and press **Add**. Click a tag on any row to change it.

### Daily use

Press **Draft today's thesis** (or type `/thesis`). You'll see:

- the last 24 hours of posts from your accounts streaming in as cards,
- Claude tagging each one, which makes it dissolve into its theme cluster (rates, Fed, credit, FX, data, other),
- the draft typing itself out: main view, 3 to 5 supporting points (each linked to its source posts), what would
  invalidate it, and what to watch today.

The draft then opens in the editor. Click any text to change it; it saves itself. It's labeled **DRAFT** until you edit it
or press **Approve**. Hover a point to light up its source posts in the clusters, or click a source chip to open the post on X.

**Send to Discord…** shows exactly what will be posted, and nothing goes out until you press **Send** there.
Mentions are turned off, so it can't ping anyone. Nothing is ever posted automatically.

Other controls in the inspector:

- **Schedule:** turn on the daily auto-run and pick a time. It runs once a day while OFSD is open (if the app opens
  after that time, it runs then). It only makes a draft.
- **Style rules:** how the draft should sound. Defaults: short paragraphs, casual first person, no em dashes, no hype.
- **Extra context:** crawls you attached from the crawler's Report tab (switch **Attach to thesis** on). Their key figures
  and observations go into the draft.

Every thesis is kept in **History** with the posts it used, and you can replay how it was built.

---

## Brain

Every crawl, thesis and note becomes a node. Open **Brain** in the sidebar.

- **Views** (inspector → Form): **Clusters** (a slowly turning particle sphere per group; drag to turn it),
  **Grid** (cards), **Timeline** (one lane per group, the lime line is now) and **Table** (click a column to sort).
- **Group by** ticker, theme or date. **Show** turns crawls, theses or notes on and off. The filter box at the top
  matches tickers, themes and titles.
- **Click a node** to open it: a crawl opens its report, a thesis opens in the thesis editor, a note opens in a side panel.
- **Links** (the thin cyan lines) connect a thesis to the crawls attached to it, and anything that mentions a ticker
  to that ticker's latest crawl. Hover a node to light up its links.
- Shapes: square = crawl, diamond = thesis, circle = note. Lime = created today.

**Notes:** press **New note**, or type `/note NVDA guide implies more upside #semis` in the command bar. The first line
becomes the title and `#words` become themes. Write `$TICKER` in a note to link it to that ticker's crawls.
Notes are your own writing, so they're never labeled DRAFT.

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
| "No TwitterAPI.io key yet" / "rejected the API key" | Paste or fix `TWITTERAPI_IO_KEY` in `.env` |
| "out of credits" (TwitterAPI.io) | Top up your TwitterAPI.io balance |
| "No accounts yet" | Thesis → Accounts → add some handles |
| "No posts in the last 24 hours" | Your accounts were quiet, or the handles are misspelled (check the Last run column) |
| "Discord rejected the webhook" | The webhook was deleted. Make a new one and update `DISCORD_WEBHOOK_URL` |
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
    thesis/                TwitterAPI.io search, Discord webhook sender
    modules/               one file per backend module
  web/                     React front end
    shell/                 sidebar, top bar, inspector, command log, command bar
    ui/                    design-system components (Section, Segmented, Select, Switch...)
    styles/tokens.css      colors, type sizes, motion
    modules/               one folder per screen; registry.ts lists them
      crawler/             session (live/replay), spider rig + reader, raw/doc/network panes, HUD, report
      thesis/              session, particle cluster field, live draft + editor, accounts, history
      brain/               node model, Clusters + Timeline canvases, Grid, Table, note drawer
```

Adding a module (for example a macro data panel) means: one folder in `src/web/modules/`, one line in
`src/web/modules/registry.ts`, and (if it needs the backend) one file in `src/server/modules/` plus one line in
`src/server/modules/index.ts`. Existing modules don't change.
