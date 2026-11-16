# Institutional Lens

A free, fully automated S&P 500 analyzer that looks at stocks the way a buy-side institution does:
valuation against the stock's own history, earnings revisions, who owns it and which way they are
moving, the macro regime, and event risk. No paid data, no paid AI, no retail trading tools.

- **Scanner**: all ~500 stocks on one screen, sortable and filterable by sector, stance and factor.
- **Ticker Detail**: a one-page note with a verdict card (stance, base/bear case, 3-tranche build
  plan, thesis invalidation triggers) and five analysis blocks.
- **Nightly updater**: downloads everything once a night into a local database, so the app opens instantly.

*Analysis, not financial advice.*

---

## Setup on Windows (about 15 minutes, no coding)

### 1. Install Python

1. Go to **https://www.python.org/downloads/** and click the yellow **Download Python 3.12** (or newer) button.
2. Run the installer. On the first screen, **tick "Add python.exe to PATH"**, then click **Install Now**.

### 2. Get the app

Download this folder (`apps/institutional-lens`) to somewhere simple, for example
`C:\InstitutionalLens`. If you downloaded the repository as a ZIP from GitHub, right-click it →
**Extract All**, then open the `apps\institutional-lens` folder inside.

### 3. Run setup

Double-click **`setup.bat`**. A black window installs the libraries (2–5 minutes). When it says
*Setup complete*, press any key.

> If Windows shows "Windows protected your PC", click **More info → Run anyway**. The file only
> creates a private Python environment inside this folder.

### 4. Add your email for the SEC

The SEC asks every program that downloads its data to identify itself.

1. Right-click **`config.toml`** → **Open with** → **Notepad**.
2. Change the line
   `sec_user_agent = "Institutional Lens your.name@example.com"`
   to your name and email, e.g. `sec_user_agent = "Jane Doe jane@gmail.com"`.
3. Save and close. (It is only sent to sec.gov.)

Optional: get a free FRED key at https://fred.stlouisfed.org/docs/api/api_key.html and paste it into
`fred_api_key`. Without it the app uses FRED's public download, which also works.

### 5. Download the data (first time)

Quick test first (about 2 minutes): open the folder, click the address bar, type `cmd`, press Enter,
and run:

```
run_update.bat --tickers AAPL,MSFT,JPM
```

Then the full run: double-click **`run_update.bat`**. The first full run takes **2–3 hours**
(about 500 stocks, politely rate-limited, plus a one-time ~200 MB download of SEC 13F data and a
one-time CUSIP lookup). You can use the computer meanwhile. Progress is written to the `logs` folder.

### 6. Open the app

Double-click **`run_app.bat`**. Your browser opens at http://localhost:8501. Keep the black window
open while you use the app; close it to stop.

### 7. Make it nightly

Double-click **`schedule_nightly.bat`**. It creates a Windows scheduled task that runs the update
every night at 02:00. The computer must be on (or asleep with wake timers allowed). To change the
time: Start menu → **Task Scheduler** → *Institutional Lens nightly update*.

---

## Everyday use

| You want to… | Do this |
|---|---|
| See today's picture | `run_app.bat` |
| Refresh now | `run_update.bat` |
| Refresh a few stocks | `run_update.bat --tickers NVDA,XOM` |
| Resume after an interrupted run | `run_update.bat --stale 20` (skips stocks refreshed in the last 20 h) |
| Change block weights or stance cut-offs | edit `config.toml`, then `run_update.bat --rescore` (seconds) |
| Check what happened overnight | open the newest file in `logs` |

### Optional: local AI thesis with Ollama (free)

The app writes a one-sentence thesis from rules. If you install **Ollama** (https://ollama.com) and
run `ollama pull llama3.1:8b` once, the nightly update uses that local model to phrase the sentence
from the computed numbers only. Nothing leaves your PC. If Ollama is not running, the rules sentence
is used. Turn it off with `enabled = false` under `[ollama]` in `config.toml`.

---

## Data sources and their limits

| Data | Source | Notes |
|---|---|---|
| Prices, dividends, splits | Yahoo Finance via `yfinance` | Unofficial library; Yahoo can change or rate-limit it. Quotes are delayed. |
| Consensus EPS/revenue, EPS trend & revision counts | yfinance | Revision **breadth** is published for 30 days only (90-day breadth shows n/a). |
| Revenue revisions, forward P/E history | Recorded nightly by this app | Not available free; appear after 30/90 days (revisions) and 12 months (forward P/E percentile). |
| Earnings surprises, rating & target changes, top holders, short interest, options, news | yfinance | Short interest is a twice-monthly exchange snapshot (**lagged** ~2 weeks). |
| Financial statements (10 years) | SEC EDGAR XBRL | Point-in-time; some companies' data appears weeks after filing. |
| Insider trades | SEC Form 4 | Open-market buys/sells; 10b5-1 plan sales are flagged and not scored. |
| 13F ownership change | SEC Form 13F data sets | **Lagged**: quarter-end holdings, filed up to 45 days later; the SEC publishes the data set after that, so it can be ~4 months old. Matched-panel method filters bad filings. |
| CUSIP → ticker | OpenFIGI (free) | One-time lookup per security. |
| Macro (Fed funds, 2Y, 10Y, curve, dollar, credit spreads, industrial production, unemployment) | FRED | ICE credit spread history on FRED covers ~3 years. |
| S&P 500 members | Wikipedia | |

Not available from free sources, shown as n/a or omitted: ISM PMI (industrial production is used
instead), company guidance figures (guidance changes are caught by the headline classifier),
credit ratings and company bond spreads, investor-day / index-rebalance / lockup calendars, and
90-day revision breadth.

Every value in the app shows its source and as-of date. Structurally delayed data carries a
**LAGGED** tag (hover for detail). Missing data is shown as **n/a** and never estimated.

## How the judgments are made

See **[METHODOLOGY.md](METHODOLOGY.md)** for every rule, weight and threshold. In the app, each
block has a *How this score was built* panel listing the inputs behind its score.

## Swapping in a licensed data provider later

All downloading lives in `lens/data/`, with **one function per data type** (see the table at the top
of `lens/data/__init__.py`). To use a paid provider for, say, consensus estimates, rewrite
`get_earnings_estimates()` to call the new API and return the same shape. Nothing else changes.

## Folder map

```
app.py               Streamlit app (reads the database only)
update.py            nightly updater entry point
config.toml          your settings: SEC email, weights, thresholds, sizing, Ollama
lens/data/           data layer: yahoo.py, sec.py, fred.py, universe.py
lens/updater.py      download orchestration, retries, logging
lens/metrics.py      turns raw data into dated, sourced metrics
lens/scoring.py      block scores, composite, stance, verdict
lens/macro.py        macro snapshot and business-cycle rules
lens/headlines.py    thesis-changing vs noise classifier
lens/ui/             page layouts and styling
data/lens.db         the database (created on first run)
logs/                one log file per day
tests/               offline checks: python -m tests.test_core
```

## Troubleshooting

- **"Python was not found"**: reinstall Python with *Add python.exe to PATH* ticked, then run `setup.bat` again.
- **Lots of "rate limited" lines in the log**: Yahoo is throttling. Raise `yahoo_pause_seconds` in `config.toml` (e.g. to 1.5) and run `run_update.bat --stale 20` later to fill the gaps.
- **SEC 403 errors**: the `sec_user_agent` email in `config.toml` is missing or still the placeholder.
- **App says "No data yet"**: the updater has not finished a run yet; check `logs`.
