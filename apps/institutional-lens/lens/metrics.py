"""Turns raw stored data into per-ticker metrics.

Every value is a data point: {"v": value, "src": source, "asof": date, "lag": note}.
Missing inputs produce v=None, which the UI shows as "n/a". Nothing is imputed.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd

from . import db
from .config import BENCHMARK, FINANCIAL_SECTORS, SECTOR_ETF
from .headlines import classify

SEC_SRC = "SEC EDGAR XBRL (10-K/10-Q)"
DERIVED = "derived: SEC XBRL fundamentals x Yahoo prices"


def dp(v, src=None, asof=None, lag=None, note=None) -> dict:
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        v = None
    return {"v": v, "src": src, "asof": asof, "lag": lag, "note": note}


def _num(x):
    try:
        f = float(x)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def _div(a, b):
    a, b = _num(a), _num(b)
    return a / b if a is not None and b not in (None, 0) else None


# ─────────────────────────────── loaders ───────────────────────────────

def load_prices(con, symbol: str) -> pd.DataFrame:
    rows = con.execute("SELECT date, close, adj_close, volume FROM prices WHERE symbol=? ORDER BY date", (symbol,)).fetchall()
    if not rows:
        return pd.DataFrame(columns=["close", "adj_close", "volume"])
    df = pd.DataFrame([dict(r) for r in rows])
    df.index = pd.to_datetime(df.pop("date"))
    return df


def load_actions(con, symbol: str, kind: str) -> pd.Series:
    rows = con.execute("SELECT date, value FROM corporate_actions WHERE symbol=? AND kind=? ORDER BY date",
                       (symbol, kind)).fetchall()
    return pd.Series([r["value"] for r in rows], index=pd.to_datetime([r["date"] for r in rows]), dtype=float)


def load_fundamentals(con, ticker: str) -> dict[str, dict[str, tuple[float, str]]]:
    out: dict[str, dict] = {}
    for r in con.execute("SELECT metric, end_date, value, filed FROM fundamentals WHERE ticker=?", (ticker,)):
        out.setdefault(r["metric"], {})[r["end_date"]] = (r["value"], r["filed"])
    return out


def raw(con, ticker, kind):
    return db.get_raw(con, ticker, kind)


# ─────────────────────────────── fundamentals table ───────────────────────────────

def _instant_near(series: dict, end: str, days: int = 5):
    if not series:
        return None
    if end in series:
        return series[end][0]
    e = date.fromisoformat(end)
    best = None
    for k, (v, _f) in series.items():
        d = abs((date.fromisoformat(k) - e).days)
        if d <= days and (best is None or d < best[0]):
            best = (d, v)
    return best[1] if best else None


def fundamental_rows(fund: dict) -> list[dict]:
    """One row per TTM period end with everything needed for multiples, as known when filed."""
    base = fund.get("net_income") or fund.get("revenue") or {}
    rows = []
    for end in sorted(base):
        filed = base[end][1]
        g = lambda c: (fund.get(c) or {}).get(end, (None,))[0]  # noqa: E731
        i = lambda c: _instant_near(fund.get(c) or {}, end)  # noqa: E731
        lt_total = i("lt_debt_total")
        lt_parts = [x for x in (i("lt_debt_noncurrent"), i("lt_debt_current")) if x is not None]
        lt = lt_total if lt_total is not None else (sum(lt_parts) if lt_parts else None)
        debt = None if lt is None else lt + (i("short_term_borrowings") or 0.0)
        cash = i("cash")
        cash_total = None if cash is None else cash + (i("short_term_investments") or 0.0)
        oi, da = g("operating_income"), g("d_and_a")
        rows.append({
            "end": end, "filed": filed,
            "revenue": g("revenue"), "operating_income": oi, "net_income": g("net_income"),
            "pretax_income": g("pretax_income"), "income_tax": g("income_tax"), "d_and_a": da,
            "ebitda": oi + da if oi is not None and da is not None else None,
            "cfo": g("cfo"), "capex": g("capex"), "interest_expense": g("interest_expense"),
            "dividends_paid": g("dividends_paid"), "buybacks": g("buybacks"),
            "debt": debt, "cash": cash_total, "equity": i("equity"),
        })
    return rows


def _row_ago(rows: list[dict], end: str, days: int, tol: int = 45):
    target = date.fromisoformat(end) - timedelta(days=days)
    cands = [r for r in rows if abs((date.fromisoformat(r["end"]) - target).days) <= tol]
    return min(cands, key=lambda r: abs((date.fromisoformat(r["end"]) - target).days)) if cands else None


# ─────────────────────────────── valuation ───────────────────────────────

def _split_factor_after(splits: pd.Series, when: pd.Timestamp) -> float:
    f = 1.0
    for d, ratio in splits.items():
        if d > when and ratio and ratio > 0:
            f *= ratio
    return f


def _shares_at(shares: dict, when: pd.Timestamp, splits: pd.Series):
    keys = [k for k in shares if pd.Timestamp(k) <= when]
    if not keys:
        return None
    k = max(keys)
    return shares[k][0] * _split_factor_after(splits, pd.Timestamp(k))


def _multiples(price, shares, row, k=1.0) -> dict:
    if price is None or shares is None or row is None:
        return {}
    mcap = price * shares * k
    out = {"mcap": mcap}
    ni, eq, eb = row.get("net_income"), row.get("equity"), row.get("ebitda")
    out["pe"] = mcap / ni if ni and ni > 0 else None
    out["pb"] = mcap / eq if eq and eq > 0 else None
    if eb and eb > 0 and row.get("debt") is not None and row.get("cash") is not None:
        out["ev"] = mcap + row["debt"] - row["cash"]
        out["ev_ebitda"] = out["ev"] / eb
    else:
        out["ev_ebitda"] = None
    if row.get("cfo") is not None and row.get("capex") is not None:
        out["fcf"] = row["cfo"] - row["capex"]
        out["fcf_yield"] = out["fcf"] / mcap
    else:
        out["fcf_yield"] = None
    return out


def _hist_stats(series: pd.Series, current, higher_is_expensive=True) -> dict | None:
    s = series.dropna()
    if current is None or len(s) < 24:
        return None
    pct = float((s < current).mean() * 100)
    return {
        "pct_rank": pct,                                      # where today sits in its own history
        "expensive_pct": pct if higher_is_expensive else 100 - pct,
        "min": float(s.min()), "p10": float(s.quantile(0.10)), "p25": float(s.quantile(0.25)),
        "median": float(s.median()), "p75": float(s.quantile(0.75)), "p90": float(s.quantile(0.90)),
        "max": float(s.max()), "n_months": int(len(s)), "start": s.index[0].date().isoformat(),
    }


def valuation_block(con, t: dict, prices: pd.DataFrame, fund: dict, rows: list[dict]) -> dict:
    sym, ticker, is_fin = t["yahoo_symbol"], t["ticker"], t["sector"] in FINANCIAL_SECTORS
    quote = raw(con, ticker, "quote")
    mult = raw(con, ticker, "multiples")
    est = raw(con, ticker, "estimates")
    splits = load_actions(con, sym, "split")
    shares = fund.get("shares") or {}
    sec_meta = raw(con, ticker, "sec_meta")

    price = _num(quote["data"].get("price")) if quote else None
    price_asof = quote["asof"] if quote else None
    if price is None and len(prices):
        price, price_asof = float(prices["close"].iloc[-1]), prices.index[-1].date().isoformat()
    out = {"price": dp(price, quote["source"] if quote else "Yahoo Finance via yfinance", price_asof),
           "is_financial": is_fin}

    latest = rows[-1] if rows else None
    shares_now = _shares_at(shares, pd.Timestamp.today(), splits)
    k, k_note = 1.0, None
    if quote and price and shares_now:
        yf_mcap = _num(quote["data"].get("marketCap"))
        if yf_mcap:
            ratio = yf_mcap / (price * shares_now)
            if abs(ratio - 1) > 0.05:
                k, k_note = ratio, f"SEC share count scaled x{ratio:.3g} to match Yahoo market cap (share classes)"
    cur = _multiples(price, shares_now, latest, k)
    fund_asof = latest["end"] if latest else None
    fund_lag = None
    if fund_asof and (date.today() - date.fromisoformat(fund_asof)).days > 120:
        fund_lag = f"latest SEC financials are for the period ending {fund_asof}"

    # Monthly history, point-in-time: only fundamentals already filed by each month-end.
    hist = pd.DataFrame()
    if len(prices) and rows and shares:
        month_close = prices["close"].resample("ME").last().dropna()
        month_close = month_close[month_close.index >= month_close.index[-1] - pd.DateOffset(years=10)]
        recs = []
        for m, px in month_close.items():
            known = [r for r in rows if r["filed"] <= m.date().isoformat()]
            if not known:
                continue
            row = max(known, key=lambda r: r["end"])
            sh = _shares_at(shares, m, splits)
            mm = _multiples(float(px), sh, row, k)
            if mm:
                recs.append({"month": m, **{x: mm.get(x) for x in ("pe", "ev_ebitda", "fcf_yield", "pb")}})
        if recs:
            hist = pd.DataFrame(recs).set_index("month").astype(float)

    def series(col):
        return hist[col] if col in hist else pd.Series(dtype=float)

    metrics = {}
    specs = [("pe_ttm", "pe", True), ("pb", "pb", True)]
    if not is_fin:
        specs += [("ev_ebitda", "ev_ebitda", True), ("fcf_yield", "fcf_yield", False)]
    for name, col, hi_exp in specs:
        v = cur.get(col)
        metrics[name] = {"current": dp(v, DERIVED, fund_asof, fund_lag, k_note),
                         "hist": _hist_stats(series(col), v, hi_exp)}

    # Forward P/E: Yahoo consensus; its own history is built nightly by this app.
    fwd = _num(mult["data"].get("forwardPE")) if mult else None
    fh_rows = con.execute("SELECT date, fwd_pe FROM estimate_history WHERE ticker=? AND period='+1y' AND fwd_pe IS NOT NULL "
                          "ORDER BY date", (ticker,)).fetchall()
    fh = pd.Series([r["fwd_pe"] for r in fh_rows], index=pd.to_datetime([r["date"] for r in fh_rows]), dtype=float)
    fwd_hist = None
    if len(fh) and (fh.index[-1] - fh.index[0]).days >= 365:
        fwd_hist = _hist_stats(fh.resample("ME").last(), fwd, True)
    metrics["pe_fwd"] = {
        "current": dp(fwd, mult["source"] if mult else None, mult["asof"] if mult else None,
                      note="price / consensus next-fiscal-year EPS"),
        "hist": fwd_hist,
        "hist_note": None if fwd_hist else (
            f"own forward P/E history is recorded nightly since {fh.index[0].date().isoformat()}; shown after 12 months"
            if len(fh) else "own forward P/E history starts with the first nightly run; shown after 12 months"),
    }
    out["metrics"] = metrics

    # Composite valuation percentile (higher = more expensive vs own history).
    used = ["pb", "pe_ttm"] if is_fin else ["ev_ebitda", "pe_ttm", "fcf_yield"]
    pcts = [metrics[m]["hist"]["expensive_pct"] for m in used if metrics.get(m, {}).get("hist")]
    out["valuation_pct"] = dp(float(np.mean(pcts)) if pcts else None, DERIVED, fund_asof, fund_lag,
                              note=f"average of {', '.join(used)} percentiles vs own 10-year monthly history")

    # Price that would put each multiple at a given percentile of its history (current fundamentals).
    def price_at(pct: float) -> float | None:
        cands = []
        for m in used:
            h = metrics.get(m, {}).get("hist")
            v = metrics.get(m, {}).get("current", {}).get("v")
            if not h or v is None or price is None:
                continue
            s = series({"pe_ttm": "pe"}.get(m, m)).dropna()
            if m == "fcf_yield":
                target = float(s.quantile(1 - pct / 100))
                p = price * v / target if target > 0 and v > 0 else None
            elif m == "ev_ebitda":
                target = float(s.quantile(pct / 100))
                eb, nd = latest.get("ebitda"), (latest.get("debt") or 0) - (latest.get("cash") or 0)
                p = (target * eb - nd) / (shares_now * k) if eb and shares_now else None
            else:
                target = float(s.quantile(pct / 100))
                p = price * target / v if v > 0 else None
            if p and p > 0:
                cands.append(p)
        return float(np.median(cands)) if cands else None

    zone_hi, zone_mid, zone_lo = price_at(25), price_at(17.5), price_at(10)
    out["zone"] = dp({"upper": zone_hi, "mid": zone_mid, "lower": zone_lo} if zone_hi else None, DERIVED, fund_asof,
                     fund_lag, note="price range where the stock would sit in the cheapest 25% of its own valuation history "
                                    "(25th to 10th percentile), at current fundamentals")

    # Fair value: consensus EPS x own historical P/E distribution.
    eps_row = None
    if est:
        rows_e = {r.get("period"): r for r in est["data"].get("eps", [])}
        eps_row = rows_e.get("+1y") or rows_e.get("0y")
    pe_h = metrics["pe_ttm"]["hist"]
    fv = None
    if eps_row and pe_h:
        avg, low, high = _num(eps_row.get("avg")), _num(eps_row.get("low")), _num(eps_row.get("high"))
        base = avg * pe_h["median"] if avg and avg > 0 else None
        bull = high * pe_h["p75"] if high and high > 0 else None
        bear = low * pe_h["p25"] if low and low > 0 else None
        if base:
            fv = {"bull": bull, "base": base, "bear": bear, "eps_period": eps_row.get("period"),
                  "eps_avg": avg, "eps_low": low, "eps_high": high, "analysts": eps_row.get("numberOfAnalysts"),
                  "pe_p25": pe_h["p25"], "pe_median": pe_h["median"], "pe_p75": pe_h["p75"]}
    out["fair_value"] = dp(fv, "derived: Yahoo consensus EPS x SEC/Yahoo P/E history", est["asof"] if est else None,
                           note="bear = low EPS estimate x 25th-pct P/E; base = mean EPS x median P/E; "
                                "bull = high EPS estimate x 75th-pct P/E (12-month view)")
    out["share_basis"] = (sec_meta["data"].get("share_basis") if sec_meta else None)
    out["current_raw"] = {"mcap": cur.get("mcap"), "ev": cur.get("ev"), "shares": shares_now, "k": k}
    return out


# ─────────────────────────────── fundamentals & revisions ───────────────────────────────

def _pct_change(now, then):
    now, then = _num(now), _num(then)
    if now is None or then in (None, 0):
        return None
    return (now - then) / abs(then)


def fundamentals_block(con, t: dict, rows: list[dict], prices: pd.DataFrame, mcap) -> dict:
    ticker, sym, is_fin = t["ticker"], t["yahoo_symbol"], t["sector"] in FINANCIAL_SECTORS
    out = {}
    trend = raw(con, ticker, "eps_trend")
    revs = raw(con, ticker, "eps_revisions")
    hist = raw(con, ticker, "earnings_history")

    # EPS revisions (direction) from the consensus EPS trend
    period = None
    if trend:
        by = {r.get("period"): r for r in trend["data"]}
        period = "+1y" if "+1y" in by else "0y" if "0y" in by else None
        r = by.get(period) or {}
        out["eps_rev_30d"] = dp(_pct_change(r.get("current"), r.get("30daysAgo")), trend["source"], trend["asof"],
                                note="change in consensus EPS over 30 days")
        out["eps_rev_90d"] = dp(_pct_change(r.get("current"), r.get("90daysAgo")), trend["source"], trend["asof"],
                                note="change in consensus EPS over 90 days")
    else:
        out["eps_rev_30d"] = dp(None)
        out["eps_rev_90d"] = dp(None)
    out["eps_rev_period"] = period
    out["eps_rev_period_label"] = {"+1y": "next FY", "0y": "current FY"}.get(period)

    # Breadth: analysts revising up vs down (last 30 days; Yahoo does not publish 90-day counts)
    if revs:
        by = {r.get("period"): r for r in revs["data"]}
        r = by.get(period or "+1y") or by.get("0y") or {}
        up, down = _num(r.get("upLast30days")), _num(r.get("downLast30days"))
        breadth = (up - down) / (up + down) if up is not None and down is not None and (up + down) > 0 else None
        out["eps_breadth_30d"] = dp({"up": up, "down": down, "net": breadth} if up is not None else None,
                                    revs["source"], revs["asof"], note="analysts revising EPS up vs down, last 30 days")
    else:
        out["eps_breadth_30d"] = dp(None)
    out["eps_breadth_90d"] = dp(None, note="not published by the free source (30-day counts only)")

    # Revenue revisions from this app's own nightly record of consensus
    eh = con.execute("SELECT date, rev_avg FROM estimate_history WHERE ticker=? AND period=? AND rev_avg IS NOT NULL "
                     "ORDER BY date", (ticker, period or "+1y")).fetchall()
    for days in (30, 90):
        val, note = None, "consensus revenue tracked nightly by this app; needs %d days of history" % days
        if eh:
            last_d, last_v = date.fromisoformat(eh[-1]["date"]), eh[-1]["rev_avg"]
            old = [r for r in eh if date.fromisoformat(r["date"]) <= last_d - timedelta(days=days)]
            if old:
                val, note = _pct_change(last_v, old[-1]["rev_avg"]), f"since {old[-1]['date']}"
        out[f"rev_rev_{days}d"] = dp(val, "derived: nightly Yahoo consensus snapshots", eh[-1]["date"] if eh else None, note=note)

    # Last two earnings vs consensus
    surprises = []
    if hist:
        for r in hist["data"][:2]:
            est, act = _num(r.get("epsEstimate")), _num(r.get("epsActual"))
            surprises.append({"quarter": r.get("quarter"), "estimate": est, "actual": act,
                              "surprise": (act - est) / abs(est) if est not in (None, 0) and act is not None else None})
    out["surprises"] = dp(surprises or None, hist["source"] if hist else None, hist["asof"] if hist else None)

    # From SEC fundamentals
    latest = rows[-1] if rows else None
    asof = latest["end"] if latest else None
    lag = (f"period ending {asof}" if asof and (date.today() - date.fromisoformat(asof)).days > 120 else None)
    yr = _row_ago(rows, asof, 365) if latest else None
    yr2 = _row_ago(rows, asof, 730) if latest else None

    def margin(r):
        return _div(r.get("operating_income"), r.get("revenue")) if r else None

    out["op_margin"] = dp({"now": margin(latest), "1y_ago": margin(yr), "2y_ago": margin(yr2)} if latest else None,
                          SEC_SRC, asof, lag, note="operating income / revenue, trailing 12 months")
    roic = roe = None
    if latest:
        tax_rate = _div(latest.get("income_tax"), latest.get("pretax_income"))
        if tax_rate is not None and 0 <= tax_rate <= 0.5 and latest.get("operating_income") is not None:
            ic = (latest.get("debt") or 0) + (latest.get("equity") or 0) - (latest.get("cash") or 0)
            if latest.get("equity") is not None and ic > 0:
                roic = latest["operating_income"] * (1 - tax_rate) / ic
        roe = _div(latest.get("net_income"), latest.get("equity")) if (latest.get("equity") or 0) > 0 else None
    out["roic"] = dp(None if is_fin else roic, SEC_SRC, asof, lag,
                     note="after-tax operating income / (debt + equity - cash)")
    out["roe"] = dp(roe, SEC_SRC, asof, lag, note="net income / shareholders' equity")
    cash_conv = None
    if latest and not is_fin and (latest.get("net_income") or 0) > 0:
        cash_conv = _div(latest.get("cfo"), latest.get("net_income"))
    out["cash_conversion"] = dp(cash_conv, SEC_SRC, asof, lag,
                                note="operating cash flow / net income; below ~0.8 flags accrual-heavy earnings")
    nd_ebitda = cov = None
    if latest and not is_fin:
        if latest.get("debt") is not None and latest.get("cash") is not None and (latest.get("ebitda") or 0) > 0:
            nd_ebitda = (latest["debt"] - latest["cash"]) / latest["ebitda"]
        if (latest.get("interest_expense") or 0) > 0 and latest.get("operating_income") is not None:
            cov = latest["operating_income"] / latest["interest_expense"]
    out["net_debt_ebitda"] = dp(nd_ebitda, SEC_SRC, asof, lag, note="(debt - cash) / EBITDA")
    out["interest_coverage"] = dp(cov, SEC_SRC, asof, lag, note="operating income / interest expense")

    # Capital return
    out["buyback_yield"] = dp(_div(latest.get("buybacks"), mcap) if latest else None, SEC_SRC + " / Yahoo market cap",
                              asof, lag, note="trailing 12-month share repurchases / market cap")
    shares = load_fundamentals_cached(con, ticker).get("shares") or {}
    sh_chg = None
    if len(shares) >= 2:
        ks = sorted(shares)
        last_k = ks[-1]
        prior = [k for k in ks if date.fromisoformat(k) <= date.fromisoformat(last_k) - timedelta(days=330)]
        if prior:
            splits = load_actions(con, sym, "split")
            a = shares[last_k][0] * _split_factor_after(splits, pd.Timestamp(last_k))
            b = shares[prior[-1]][0] * _split_factor_after(splits, pd.Timestamp(prior[-1]))
            sh_chg = _pct_change(a, b)
    out["share_count_yoy"] = dp(sh_chg, SEC_SRC, max(shares) if shares else None, note="change in shares outstanding, ~1 year")

    divs = load_actions(con, sym, "dividend")
    dg = dg5 = ttm_dps = None
    if len(divs):
        today = pd.Timestamp.today()
        ttm_dps = float(divs[divs.index > today - pd.DateOffset(years=1)].sum())
        prev = float(divs[(divs.index > today - pd.DateOffset(years=2)) & (divs.index <= today - pd.DateOffset(years=1))].sum())
        five = float(divs[(divs.index > today - pd.DateOffset(years=6)) & (divs.index <= today - pd.DateOffset(years=5))].sum())
        dg = _pct_change(ttm_dps, prev) if prev else None
        dg5 = (ttm_dps / five) ** (1 / 5) - 1 if five > 0 and ttm_dps > 0 else None
    out["dividend"] = dp({"ttm_dps": ttm_dps, "growth_1y": dg, "cagr_5y": dg5} if len(divs) else None,
                         "Yahoo Finance via yfinance (dividend history)",
                         divs.index[-1].date().isoformat() if len(divs) else None)
    return out


_FUND_CACHE: dict = {}


def load_fundamentals_cached(con, ticker):
    if ticker not in _FUND_CACHE:
        _FUND_CACHE.clear()
        _FUND_CACHE[ticker] = load_fundamentals(con, ticker)
    return _FUND_CACHE[ticker]


# ─────────────────────────────── ownership ───────────────────────────────

def ownership_block(con, t: dict) -> dict:
    ticker, sym = t["ticker"], t["yahoo_symbol"]
    out = {}

    # 13F, quarter over quarter (matched panel of managers filing in both quarters; see data/sec.py)
    norm = ticker.replace("-", ".").upper()
    row = con.execute(
        "SELECT c.* FROM f13_change c JOIN cusip_map m ON m.cusip = c.cusip "
        "WHERE UPPER(REPLACE(m.ticker,'-','.')) = ? ORDER BY c.shares_cur DESC LIMIT 1", (norm,)).fetchone()
    f13 = None
    if row:
        splits = load_actions(con, sym, "split")
        adj = 1.0
        for d, ratio in splits.items():
            if pd.Timestamp(row["prior_period"]) < d <= pd.Timestamp(row["period"]) and ratio:
                adj *= ratio
        f13 = {"period": row["period"], "prior_period": row["prior_period"],
               "shares_chg": _pct_change(row["shares_cur"], (row["shares_prev"] or 0) * adj) if row["shares_prev"] else None,
               "holders": row["holders_cur"], "holders_chg": row["holders_panel_chg"], "cusip": row["cusip"],
               "panel_filers": row["panel_filers"], "excluded": row["excluded_positions"]}
    out["f13_change"] = dp(f13, "SEC Form 13F data sets (all managers, matched panel)", row["period"] if row else None,
                           lag="13F: quarter-end holdings filed up to 45 days later; SEC data set published after that")

    ih = raw(con, ticker, "institutional_holders")
    top = []
    if ih:
        for r in ih["data"].get("top", [])[:10]:
            top.append({"holder": r.get("Holder"), "pct_held": _num(r.get("pctHeld")), "shares": _num(r.get("Shares")),
                        "pct_change": _num(r.get("pctChange")), "reported": r.get("Date Reported")})
    adds = sum(1 for r in top if (r["pct_change"] or 0) > 0.01)
    cuts = sum(1 for r in top if (r["pct_change"] or 0) < -0.01)
    out["top_holders"] = dp({"rows": top, "adding": adds, "cutting": cuts} if top else None,
                            ih["source"] if ih else None, ih["asof"] if ih else None,
                            lag="13F: filed up to 45 days after quarter end")
    out["inst_ownership_pct"] = dp(_num(ih["data"].get("summary", {}).get("institutionsPercentHeld")) if ih else None,
                                   ih["source"] if ih else None, ih["asof"] if ih else None, lag="13F-based")

    # Insiders: SEC Form 4 preferred, Yahoo fallback
    f4 = raw(con, ticker, "form4")
    cutoff = (date.today() - timedelta(days=90)).isoformat()
    ins = None
    if f4:
        tx = [x for x in f4["data"].get("txns", []) if (x.get("date") or "") >= cutoff]
        buys = [x for x in tx if x.get("code") == "P"]
        sells = [x for x in tx if x.get("code") == "S"]
        disc_sells = [x for x in sells if not x.get("plan_10b5_1")]
        val = lambda xs: sum((x.get("shares") or 0) * (x.get("price") or 0) for x in xs)  # noqa: E731
        buyers = sorted({x["insider"] for x in buys if x.get("insider")})
        ins = {"buyers": len(buyers), "buyer_names": buyers[:6], "buy_value": val(buys), "sellers":
               len({x["insider"] for x in sells if x.get("insider")}), "sell_value": val(sells),
               "discretionary_sell_value": val(disc_sells), "cluster_buying": len(buyers) >= 3,
               "recent": sorted([x for x in tx if x.get("code") in ("P", "S")], key=lambda x: x.get("date") or "",
                                reverse=True)[:8], "basis": "SEC Form 4, open-market trades (codes P/S), last 90 days"}
        src, asof = f4["source"], f4["asof"]
    else:
        iy = raw(con, ticker, "insider_yahoo")
        src, asof = (iy["source"], iy["asof"]) if iy else (None, None)
        if iy:
            tx = [x for x in iy["data"] if (x.get("Start Date") or "") >= cutoff]
            buys = [x for x in tx if "purchase" in (x.get("Text") or "").lower()]
            sells = [x for x in tx if "sale" in (x.get("Text") or "").lower()]
            buyers = sorted({x.get("Insider") for x in buys if x.get("Insider")})
            ins = {"buyers": len(buyers), "buyer_names": buyers[:6], "buy_value": sum(_num(x.get("Value")) or 0 for x in buys),
                   "sellers": len({x.get("Insider") for x in sells}), "sell_value": sum(_num(x.get("Value")) or 0 for x in sells),
                   "discretionary_sell_value": None, "cluster_buying": len(buyers) >= 3, "recent": [],
                   "basis": "Yahoo insider transactions, last 90 days"}
    out["insiders"] = dp(ins, src, asof)

    si = raw(con, ticker, "short_interest")
    if si:
        d = si["data"]
        out["short_interest"] = dp({"pct_float": _num(d.get("short_pct_float")), "days_to_cover": _num(d.get("days_to_cover")),
                                    "chg_vs_prior": _pct_change(d.get("shares_short"), d.get("shares_short_prior_month"))},
                                   si["source"], si["asof"], lag="exchange short interest, published ~2 weeks after settlement")
    else:
        out["short_interest"] = dp(None)

    rc = raw(con, ticker, "rating_changes")
    if rc:
        recent = [r for r in rc["data"] if (r.get("date") or "") >= cutoff]
        acts = {"up": 0, "down": 0, "init": 0, "pt_raise": 0, "pt_cut": 0}
        for r in recent:
            a = (r.get("Action") or "").lower()
            acts["up"] += a == "up"
            acts["down"] += a == "down"
            acts["init"] += a == "init"
            pa = (r.get("priceTargetAction") or "").lower()
            acts["pt_raise"] += pa.startswith("raise")
            acts["pt_cut"] += pa.startswith("lower")
        rows = [{"date": r.get("date"), "firm": r.get("Firm"), "from": r.get("FromGrade"), "to": r.get("ToGrade"),
                 "action": r.get("Action"), "pt": _num(r.get("currentPriceTarget")),
                 "pt_prior": _num(r.get("priorPriceTarget"))} for r in rc["data"][:8]]
        out["analyst_actions"] = dp({**acts, "n": len(recent), "rows": rows}, rc["source"], rc["asof"],
                                    note="last 90 days")
    else:
        out["analyst_actions"] = dp(None)
    pt = raw(con, ticker, "price_targets")
    out["price_targets"] = dp(pt["data"] if pt else None, pt["source"] if pt else None, pt["asof"] if pt else None)
    return out


# ─────────────────────────────── macro fit & relative performance ───────────────────────────────

def _ret(s: pd.Series, n: int):
    s = s.dropna()
    return float(s.iloc[-1] / s.iloc[-1 - n] - 1) if len(s) > n else None


def relative_block(con, t: dict, prices: pd.DataFrame) -> dict:
    etf = SECTOR_ETF.get(t["sector"])
    spy = load_prices(con, BENCHMARK)
    sec = load_prices(con, etf) if etf else pd.DataFrame()
    out = {"sector_etf": etf}
    rel = {}
    for label, n in (("3m", 63), ("6m", 126), ("12m", 252)):
        r = _ret(prices["adj_close"], n) if len(prices) else None
        rs = _ret(sec["adj_close"], n) if len(sec) else None
        rb = _ret(spy["adj_close"], n) if len(spy) else None
        rel[label] = {"stock": r, "vs_sector": r - rs if r is not None and rs is not None else None,
                      "vs_spy": r - rb if r is not None and rb is not None else None}
    out["relative"] = dp(rel, "derived: Yahoo adjusted closes (total return)",
                         prices.index[-1].date().isoformat() if len(prices) else None)
    return out


# ─────────────────────────────── catalysts & risk ───────────────────────────────

def risk_block(con, t: dict, prices: pd.DataFrame) -> dict:
    ticker = t["ticker"]
    out = {}
    asof = prices.index[-1].date().isoformat() if len(prices) else None
    hv30 = hv90 = adv = None
    if len(prices) > 100:
        lr = np.log(prices["adj_close"]).diff().dropna()
        hv30 = float(lr.iloc[-30:].std() * math.sqrt(252))
        hv90 = float(lr.iloc[-90:].std() * math.sqrt(252))
        adv = float((prices["close"] * prices["volume"]).iloc[-60:].mean())
    out["hv30"] = dp(hv30, "derived: Yahoo daily prices", asof, note="30-day realized volatility, annualized")
    out["hv90"] = dp(hv90, "derived: Yahoo daily prices", asof, note="90-day realized volatility, annualized")
    oi = raw(con, ticker, "options_iv")
    iv = _num(oi["data"].get("atm_iv")) if oi else None
    out["iv30"] = dp(iv, oi["source"] if oi else None, oi["asof"] if oi else None,
                     note=f"at-the-money implied vol, {oi['data'].get('expiry')} expiry" if oi else None)
    out["iv_hv"] = dp(iv / hv30 if iv and hv30 else None, "derived", oi["asof"] if oi else None,
                      note="implied / 30-day realized; above ~1.3 means the options market prices an event")
    out["adv_usd"] = dp(adv, "derived: Yahoo daily prices", asof, note="60-day average daily dollar volume")
    cal = raw(con, ticker, "calendar")
    nxt = None
    if cal:
        dates = sorted(d for d in cal["data"].get("earnings_dates") or [] if d and d >= date.today().isoformat())
        nxt = dates[0] if dates else None
    out["next_earnings"] = dp(nxt, cal["source"] if cal else None, cal["asof"] if cal else None,
                              note="may be an estimate until the company confirms")
    nw = raw(con, ticker, "news")
    heads = []
    if nw:
        for h in nw["data"][:12]:
            heads.append({**h, **classify(h.get("title"))})
    out["headlines"] = dp(heads or None, nw["source"] if nw else None, nw["asof"] if nw else None)
    return out


# ─────────────────────────────── per ticker ───────────────────────────────

def compute(con, t: dict) -> dict:
    prices = load_prices(con, t["yahoo_symbol"])
    fund = load_fundamentals_cached(con, t["ticker"])
    rows = fundamental_rows(fund)
    val = valuation_block(con, t, prices, fund, rows)
    quote = raw(con, t["ticker"], "quote")
    mcap = val["current_raw"]["mcap"] or (_num(quote["data"].get("marketCap")) if quote else None)
    return {
        "ticker": t["ticker"], "name": t["name"], "sector": t["sector"], "sub_industry": t["sub_industry"],
        "valuation": val,
        "fundamentals": fundamentals_block(con, t, rows, prices, mcap),
        "ownership": ownership_block(con, t),
        "macro": relative_block(con, t, prices),
        "risk": risk_block(con, t, prices),
    }
