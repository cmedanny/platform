"""Nightly updater: downloads everything, stores it in SQLite, then rebuilds scores.

Each data type is fetched independently. If one fails, the previous value stays
in the database with its original as-of date, so the UI shows its true age.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone

import pandas as pd

from . import data as D
from . import db
from .config import BENCHMARK, CFG, LOG_DIR, SECTOR_ETF

log = logging.getLogger("lens.updater")


def setup_logging(verbose: bool = False) -> None:
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    fh = logging.FileHandler(LOG_DIR / f"update_{date.today().isoformat()}.log", encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root.addHandler(fh)
    root.addHandler(sh)
    for noisy in ("yfinance", "urllib3", "peewee", "curl_cffi"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _try(what: str, fn, *args, **kwargs):
    """Fetch with retries; return None (and log) on failure instead of stopping the run."""
    try:
        return D.with_retries(fn, *args, retries=CFG["updater"]["retries"], what=what, **kwargs)
    except D.DataUnavailable as exc:
        log.info("n/a  %s: %s", what, exc)
    except Exception as exc:
        log.warning("FAIL %s: %s", what, exc)
    return None


# ─────────────────────────────── global data ───────────────────────────────

def update_universe(con) -> None:
    f = _try("S&P 500 constituents", D.get_sp500_constituents)
    if f is None:
        if con.execute("SELECT COUNT(*) FROM tickers").fetchone()[0] == 0:
            raise RuntimeError("Could not download the S&P 500 list and the database is empty.")
        log.warning("Keeping the previous constituent list.")
        return
    with db.transaction(con):
        con.execute("DELETE FROM tickers")
        con.executemany(
            "INSERT INTO tickers(ticker, yahoo_symbol, name, sector, sub_industry, cik, date_added, source, asof) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            [(r.ticker, r.yahoo_symbol, r.name, r.sector, r.sub_industry, r.cik, r.date_added, f.source, f.asof)
             for r in f.data.itertuples()],
        )
    log.info("Universe: %d constituents", len(f.data))


def update_macro(con) -> None:
    for sid in D.MACRO_SERIES:
        f = _try(f"FRED {sid}", D.get_macro_series, sid)
        if f is None:
            continue
        with db.transaction(con):
            con.execute("DELETE FROM macro WHERE series_id=?", (sid,))
            con.executemany("INSERT INTO macro(series_id, date, value) VALUES (?,?,?)",
                            [(sid, d.date().isoformat(), float(v)) for d, v in f.data.items()])
            db.set_meta(con, f"macro_src:{sid}", {"source": f.source, "asof": f.asof, "lag": f.lag})
    log.info("Macro series updated")


def _store_prices(con, symbol: str, f) -> None:
    df = f.data
    with db.transaction(con):
        con.execute("DELETE FROM prices WHERE symbol=?", (symbol,))
        con.executemany("INSERT INTO prices(symbol, date, close, adj_close, volume) VALUES (?,?,?,?,?)",
                        [(symbol, d.date().isoformat(), float(r.close), float(r.adj_close), float(r.volume or 0))
                         for d, r in df.iterrows() if pd.notna(r.close)])
        con.execute("DELETE FROM corporate_actions WHERE symbol=?", (symbol,))
        rows = [(symbol, d.date().isoformat(), "dividend", float(r.dividend)) for d, r in df.iterrows() if r.dividend]
        rows += [(symbol, d.date().isoformat(), "split", float(r.split)) for d, r in df.iterrows() if r.split]
        con.executemany("INSERT OR REPLACE INTO corporate_actions(symbol, date, kind, value) VALUES (?,?,?,?)", rows)
        db.put_raw(con, symbol, "prices_meta", {"rows": len(df)}, f.source, f.asof)


def update_benchmarks(con) -> None:
    for sym in [BENCHMARK, *SECTOR_ETF.values()]:
        f = _try(f"{sym} prices", D.get_price_history, sym)
        if f is not None:
            _store_prices(con, sym, f)
        D.yahoo.clear_cache()
    log.info("Benchmark and sector ETF prices updated")


def update_13f(con, force: bool = False) -> None:
    """Quarterly: aggregate the latest SEC 13F data set, map CUSIPs, compute robust QoQ change."""
    sets = _try("13F data set list", D.list_13f_datasets)
    if not sets or len(sets) < 2:
        return
    prev, cur = sets[-2], sets[-1]
    if not force and db.get_meta(con, "f13_done") == cur["period"]:
        return
    log.info("New 13F quarter %s: downloading two SEC data sets (~100 MB each, a few minutes)", cur["period"])
    fc = _try(f"13F {cur['period']}", D.get_13f_quarter, cur["url"], cur["period"])
    if fc is None:
        return
    with db.transaction(con):
        con.execute("DELETE FROM f13_aggregate")
        con.executemany(
            "INSERT OR REPLACE INTO f13_aggregate(period, cusip, issuer, shares, value, holders) VALUES (?,?,?,?,?,?)",
            [(cur["period"], c, a["issuer"], a["shares"], a["value"], a["holders"])
             for c, a in fc.data["aggregate"].items() if a["value"] >= 5e6])
    _map_cusips(con, cur["period"])
    # CUSIPs of index members (largest holding value if a ticker maps to several)
    universe = {r[0] for r in con.execute(
        "SELECT cusip FROM (SELECT m.cusip, m.ticker, a.value, ROW_NUMBER() OVER (PARTITION BY m.ticker ORDER BY a.value DESC) rn "
        "FROM cusip_map m JOIN f13_aggregate a ON a.cusip = m.cusip JOIN tickers t "
        "ON UPPER(REPLACE(t.ticker,'-','.')) = UPPER(REPLACE(m.ticker,'-','.'))) WHERE rn = 1")}
    log.info("13F: %d index members matched to CUSIPs", len(universe))
    fc = _try(f"13F positions {cur['period']}", D.get_13f_quarter, cur["url"], cur["period"], universe)
    fp = _try(f"13F positions {prev['period']}", D.get_13f_quarter, prev["url"], prev["period"], universe)
    if fc is None or fp is None:
        return
    change = D.compute_13f_change(fc.data["positions"], fp.data["positions"], fc.data["book"], fp.data["book"])
    with db.transaction(con):
        con.execute("DELETE FROM f13_change")
        con.executemany(
            "INSERT INTO f13_change(cusip, period, prior_period, shares_cur, shares_prev, shares_chg, holders_cur, "
            "holders_panel_chg, panel_filers, excluded_positions) VALUES (?,?,?,?,?,?,?,?,?,?)",
            [(c, cur["period"], prev["period"], x["shares_cur"], x["shares_prev"], x["shares_chg"], x["holders_cur"],
              x["holders_panel_chg"], x["panel_filers"], x["excluded_positions"]) for c, x in change.items()])
        db.set_meta(con, "f13_done", cur["period"])
    for ds in (prev, cur):  # ~100 MB each; results are in the database
        (D.sec.CACHE_DIR / ds["url"].rsplit("/", 1)[-1]).unlink(missing_ok=True)
    log.info("13F change computed for %d securities (%s vs %s)", len(change), cur["period"], prev["period"])


def _map_cusips(con, period: str) -> None:
    min_value = CFG["updater"]["openfigi_min_13f_value_usd"]
    stale = (date.today() - timedelta(days=120)).isoformat()
    todo = [r[0] for r in con.execute(
        "SELECT a.cusip FROM f13_aggregate a LEFT JOIN cusip_map m ON a.cusip = m.cusip "
        "WHERE a.period=? AND a.value>=? AND (m.cusip IS NULL OR (m.ticker IS NULL AND m.mapped_at < ?)) "
        "ORDER BY a.value DESC", (period, min_value, stale))]
    if not todo:
        return
    log.info("Mapping %d CUSIPs to tickers via OpenFIGI (~%d min, first run only)", len(todo), len(todo) // 250 + 1)
    for i in range(0, len(todo), 200):
        f = _try("OpenFIGI mapping", D.map_cusips_to_tickers, todo[i:i + 200])
        if f is None:
            break
        with db.transaction(con):
            con.executemany("INSERT OR REPLACE INTO cusip_map(cusip, ticker, name, source, mapped_at) VALUES (?,?,?,?,?)",
                            [(c, m["ticker"], m["name"], f.source, f.asof) for c, m in f.data.items()])


# ─────────────────────────────── per ticker ───────────────────────────────

YAHOO_KINDS = [
    ("quote", D.get_quote), ("multiples", D.get_valuation_multiples), ("short_interest", D.get_short_interest),
    ("estimates", D.get_earnings_estimates), ("eps_trend", D.get_eps_trend), ("eps_revisions", D.get_eps_revisions),
    ("earnings_history", D.get_earnings_history), ("calendar", D.get_earnings_calendar),
    ("rating_changes", D.get_analyst_rating_changes), ("price_targets", D.get_price_targets),
    ("institutional_holders", D.get_institutional_holders), ("insider_yahoo", D.get_insider_transactions_yahoo),
    ("news", D.get_news),
]


def update_ticker(con, row, skip_form4: bool = False) -> bool:
    t, sym, cik = row["ticker"], row["yahoo_symbol"], row["cik"]
    got_any = False

    prices = _try(f"{t} prices", D.get_price_history, sym)
    if prices is not None:
        _store_prices(con, sym, prices)
        got_any = True

    results = {}
    for kind, fn in YAHOO_KINDS:
        f = _try(f"{t} {kind}", fn, sym)
        if f is not None:
            results[kind] = f
            with db.transaction(con):
                db.put_raw(con, t, kind, f.data, f.source, f.asof)
            got_any = True

    spot = (results.get("quote").data.get("price") if results.get("quote") else None)
    if spot:
        f = _try(f"{t} options IV", D.get_options_implied_vol, sym, spot)
        if f is not None:
            with db.transaction(con):
                db.put_raw(con, t, "options_iv", f.data, f.source, f.asof)
    D.yahoo.clear_cache()

    # Our own estimate history: lets the app compute revenue revisions and forward P/E history over time.
    est = results.get("estimates")
    if est is not None:
        today = date.today().isoformat()
        rev = {r.get("period"): r.get("avg") for r in est.data.get("revenue", [])}
        fwd_pe = results["multiples"].data.get("forwardPE") if results.get("multiples") else None
        with db.transaction(con):
            for r in est.data.get("eps", []):
                p = r.get("period")
                if p in ("0y", "+1y"):
                    con.execute("INSERT OR REPLACE INTO estimate_history(ticker, date, period, eps_avg, rev_avg, fwd_pe) "
                                "VALUES (?,?,?,?,?,?)", (t, today, p, r.get("avg"), rev.get(p), fwd_pe if p == "+1y" else None))

    if cik:
        fin = _try(f"{t} SEC financials", D.get_company_financials, cik)
        if fin is not None:
            rows = []
            for group in ("ttm", "instant"):
                for concept, series in fin.data[group].items():
                    rows += [(t, end, concept, val, filed, fin.source) for end, (val, filed) in series.items()]
            rows += [(t, end, "shares", val, end, fin.source) for end, val in fin.data["shares"].items()]
            with db.transaction(con):
                con.execute("DELETE FROM fundamentals WHERE ticker=?", (t,))
                con.executemany("INSERT OR REPLACE INTO fundamentals(ticker, end_date, metric, value, filed, source) "
                                "VALUES (?,?,?,?,?,?)", rows)
                db.put_raw(con, t, "sec_meta", {"share_basis": fin.data["share_basis"], "entity": fin.data["entity"]},
                           fin.source, fin.asof)
            got_any = True
        if not skip_form4:
            f4 = _try(f"{t} Form 4", D.get_form4_transactions, cik)
            if f4 is not None:
                with db.transaction(con):
                    db.put_raw(con, t, "form4", {"txns": f4.data, **f4.extra}, f4.source, f4.asof)
    return got_any


# ─────────────────────────────── orchestration ───────────────────────────────

def run(tickers: list[str] | None = None, limit: int | None = None, skip_13f: bool = False,
        skip_form4: bool = False, rescore_only: bool = False, stale_hours: float | None = None) -> int:
    from .scoring import rebuild_all  # local import keeps module load light

    con = db.connect()
    started = db.now_iso()
    cur = con.execute("INSERT INTO runs(started, status) VALUES (?, 'running')", (started,))
    run_id = cur.lastrowid
    con.commit()
    ok = failed = 0
    t0 = time.time()
    try:
        if not rescore_only:
            if "example.com" in CFG["keys"]["sec_user_agent"]:
                log.warning("config.toml: put your name and email in sec_user_agent; the SEC may block anonymous requests")
            update_universe(con)
            update_macro(con)
            update_benchmarks(con)
            if not skip_13f:
                update_13f(con)
            rows = con.execute("SELECT * FROM tickers ORDER BY ticker").fetchall()
            if tickers:
                wanted = {x.strip().upper() for x in tickers}
                rows = [r for r in rows if r["ticker"] in wanted or r["yahoo_symbol"] in wanted]
            if stale_hours:
                cutoff = (datetime.now(timezone.utc) - timedelta(hours=stale_hours)).replace(microsecond=0).isoformat()
                fresh = {r[0] for r in con.execute("SELECT ticker FROM raw WHERE kind='quote' AND fetched_at >= ?", (cutoff,))}
                rows = [r for r in rows if r["ticker"] not in fresh]
            if limit:
                rows = rows[:limit]
            log.info("Updating %d tickers", len(rows))
            for n, row in enumerate(rows, 1):
                try:
                    if update_ticker(con, row, skip_form4=skip_form4):
                        ok += 1
                    else:
                        failed += 1
                except Exception as exc:  # never let one ticker stop the night
                    failed += 1
                    log.exception("Ticker %s crashed: %s", row["ticker"], exc)
                if n % 10 == 0 or n == len(rows):
                    el = time.time() - t0
                    log.info("Progress %d/%d (%.0f min elapsed, ~%.0f min left)", n, len(rows), el / 60,
                             el / n * (len(rows) - n) / 60)
        n_scored = rebuild_all(con)
        log.info("Scores rebuilt for %d tickers", n_scored)
        db.set_meta(con, "last_update", db.now_iso())
        status = "ok" if failed == 0 else "partial"
    except Exception as exc:
        log.exception("Run failed: %s", exc)
        status = "failed"
    con.execute("UPDATE runs SET finished=?, status=?, ok=?, failed=? WHERE id=?",
                (db.now_iso(), status, ok, failed, run_id))
    con.commit()
    con.close()
    log.info("Done: status=%s ok=%d failed=%d in %.1f min", status, ok, failed, (time.time() - t0) / 60)
    return 0 if status != "failed" else 1
