# Methodology

Every number in the app comes from a stored data point with its source and as-of date.
Nothing is estimated to fill a gap: a missing input is shown as **n/a** and left out of the score.

## How a block score works

Each block (0–100, 50 = neutral, higher = more attractive) is a weighted average of input scores.
Each input maps its raw value to 0–100 along a straight line between two anchor points, clamped.
Example: *90-day EPS revision: −6% → 10, +6% → 90*, so +3% scores 70.
Missing inputs are dropped and the remaining weights rescaled. A block needs at least 35% of its
input weight available (50% for Macro), otherwise the block is n/a. The app's "How this score was
built" panel shows every input, its value, score, weight and rule.

## 1. Valuation (weight in composite: 0.25)

| Input | Weight | Rule |
|---|---|---|
| Percentile vs own 10-year history | 50 | score = 100 − percentile |
| Premium vs sector median (avg of multiples) | 25 | −40% → 85, +40% → 15 |
| Upside to base-case fair value | 25 | −25% → 15, +25% → 85 |

- **History**: month-end multiples for 10 years, built from SEC XBRL fundamentals and Yahoo prices.
  Point-in-time: each month uses only financials already *filed* by that date (no look-ahead).
- **Multiples**: trailing P/E, EV/EBITDA, FCF yield (non-financials); P/B and P/E (Financials).
  The composite percentile averages the multiples that apply. FCF yield is inverted so higher always
  means more expensive.
- **Forward P/E** comes from Yahoo consensus. Free sources have no history of forward P/E, so the app
  records it nightly; its own percentile appears after 12 months of records.
- **Sector median**: median across S&P 500 members in the same GICS sector (needs 5+ values).
- **Fair value (12-month)**: bear = low EPS estimate × 25th-percentile P/E; base = mean EPS × median
  P/E; bull = high EPS estimate × 75th-percentile P/E. EPS is next fiscal year consensus.
- **Valuation zone**: the price at which today's fundamentals would put each multiple at its 25th and
  10th percentile; the median across multiples gives the zone.
- **Share classes**: SEC share counts are scaled to match Yahoo's market cap when they differ by >5%
  (e.g. Berkshire A/B shares).

## 2. Fundamentals & revisions (0.30)

| Input | Weight | Rule |
|---|---|---|
| EPS revision, 90 days (next FY) | 20 | −6% → 10, +6% → 90 |
| EPS revision, 30 days | 10 | −3% → 15, +3% → 85 |
| Revision breadth, 30 days | 15 | (up − down)/(up + down): −1 → 10, +1 → 90 |
| Revenue estimate revision (90d, else 30d) | 10 | −4% → 15, +4% → 85 |
| Last two EPS surprises (avg) | 10 | −5% → 15, +5% → 85 |
| Operating margin change, 1 year | 10 | −300bp → 15, +300bp → 85 |
| ROIC (ROE for Financials) | 10 | 4% → 20, 20% → 90 (ROE 6% → 20, 18% → 85) |
| Cash conversion (CFO / net income) | 8 | 0.6x → 15, 1.2x → 85 |
| Net debt / EBITDA | 7 | 4.0x → 10, 0x → 85 |
| Interest coverage | 5 | 2x → 15, 12x → 90 |
| Share count change, 1 year | 5 | +3% → 20, −3% → 85 |

Revenue revisions use the app's own nightly record of consensus revenue (free sources do not publish
revenue revision history), so they appear after 30/90 days of running.

## 3. Ownership & positioning (0.20)

| Input | Weight | Rule |
|---|---|---|
| 13F shares held, QoQ (all managers) | 25 | −4% → 15, +4% → 85 |
| 13F holder count, QoQ | 5 | −3% → 20, +3% → 80 |
| Top-10 holders adding vs cutting | 15 | all cutting → 20, all adding → 80 |
| Insider open-market activity | 20 | cluster buying (3+ insiders, 90 days) → 90; any buying → 70; discretionary selling only → 42; none / 10b5-1 plan sales only → not scored |
| Short interest | 15 | 12% of float → 15, 1% → 70; −10 if up >15% vs prior month |
| Sell-side actions, 90 days | 20 | (upgrades + PT raises − downgrades − PT cuts) / total; needs 2+ |

**13F method.** Raw 13F data contains late, partial and mis-scaled filings. The QoQ change uses a
matched panel: only managers that filed in both quarters and whose total reported book is within
0.5–2x of the prior quarter. Within that panel a single position is dropped if it is ≥1% of the
total and moved more than 5x (or appeared/vanished). 13F data is lagged by design: holdings are as of
quarter end, filed up to 45 days later, and the SEC data set is published after the filing window.

## 4. Macro regime (0.10)

| Input | Weight | Rule |
|---|---|---|
| Sector fit with cycle phase | 40 | favored → 80, neutral → 50, disfavored → 20 |
| Relative return vs sector ETF (6m/12m avg) | 30 | −15% → 20, +15% → 80 |
| Relative return vs SPY (6m/12m avg) | 30 | −15% → 20, +15% → 80 |

**Cycle classification** (1 point per rule met, most points wins, ties go to the more defensive phase):

- *Recession*: Sahm rule (3-mo unemployment ≥0.5pp above 12-mo low, 2 pts); industrial production YoY < −1%; HY spread > 6.5% or +1.5pp in 6 months.
- *Early*: IP YoY < 2% and improving; curve steepened > 0.25pp in 6 months; HY spread tightened > 0.5pp; unemployment elevated but no longer rising.
- *Mid*: IP YoY > 0 and not decelerating > 0.5pp; 10Y−2Y > 0.5pp; HY < 4.5% and stable; unemployment stable or falling.
- *Late*: IP growth decelerating; curve < 0.25pp; HY widened > 0.3pp; unemployment within 0.3pp of 24-mo low.

Sector leadership by phase follows Fidelity's *Business Cycle Approach to Sector Investing*. Edit
`SECTOR_PHASE` in `lens/macro.py` to use another map. ISM PMI is not free (FRED dropped it in 2016),
so industrial production is the activity gauge.

## 5. Catalysts & risk (0.15)

| Input | Weight | Rule |
|---|---|---|
| Implied vs realized volatility | 30 | 1.6x → 20, 0.9x → 70 |
| Thesis-changing headlines, 30 days | 35 | none → 55; net tone −2 → 15, +2 → 80 |
| Liquidity (avg daily $ volume) | 20 | $20M → 25, $500M → 80 (log) |
| Days to next earnings | 15 | ≤10 days → 40, else 55 |

**Headline classifier** (`lens/headlines.py`): a headline is *thesis-changing* if it matches an event
rule (guidance, earnings vs consensus, management change, M&A, investigation/legal, accounting,
rating change, capital return/raise, credit/distress, regulatory/product, activist, disruption) and
is not promotional/list content. Tone comes from direction words (raise/cut, beat/miss, …).

## Stance, confidence, horizon

- **Composite** = weighted average of available block scores (weights in `config.toml`).
- **Stance**: Accumulate ≥ 62 > Hold ≥ 48 > Reduce ≥ 40 > Avoid. Accumulate also requires
  Fundamentals ≥ 45. Fewer than 3 scored blocks → n/a. All thresholds are in `config.toml`.
- **Confidence**: number of blocks agreeing with the stance (≥55 for Accumulate, ≤45 for
  Reduce/Avoid, 45–55 for Hold): 4–5 High, 3 Medium, ≤2 Low.
- **Time horizon**: set by the block that moves the composite most (valuation → 12–24 months,
  fundamentals → 6–12, ownership → 3–9, macro → 6–12, catalysts → 3–6).
- **Build plan**: three equal tranches at the 25th, 17.5th and 10th valuation percentiles, at least
  3 weeks apart. Full position = base weight × (target vol / 90-day realized vol), capped 0.5–1.5x.
- **Thesis invalidation**: fundamental events (revisions turning negative, breadth turning down,
  guidance cut, leverage or margin breaks, 13F distribution), never a price stop.
- **Thesis sentence**: built from the strongest positive and negative inputs; optionally rewritten by
  a local Ollama model that is given only these computed numbers.
