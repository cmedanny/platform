"""Yahoo Finance via the free yfinance library.

One function per data type. Each returns a Fetched with plain, JSON-safe data
(lists of dicts / dicts), so a licensed provider can replace any function by
returning the same shape.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timezone
from functools import lru_cache

import pandas as pd

from ..config import CFG
from .base import DataUnavailable, Fetched, RateLimiter

SOURCE = "Yahoo Finance via yfinance"
_limiter = RateLimiter(CFG["updater"]["yahoo_pause_seconds"])


def _yf():
    import yfinance as yf  # imported lazily so the UI never needs it
    return yf


@lru_cache(maxsize=2)
def _ticker(symbol: str):
    return _yf().Ticker(symbol)


@lru_cache(maxsize=2)
def _info(symbol: str) -> dict:
    _limiter.wait()
    info = _ticker(symbol).info or {}
    if not info or (info.get("regularMarketPrice") is None and info.get("currentPrice") is None):
        raise DataUnavailable(f"Yahoo returned no quote for {symbol}")
    return info


def clear_cache() -> None:
    _ticker.cache_clear()
    _info.cache_clear()


def _clean(v):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, (pd.Timestamp, datetime)):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if hasattr(v, "item"):
        try:
            return _clean(v.item())
        except Exception:
            return str(v)
    return v


def _records(df: pd.DataFrame, index_name: str | None = None) -> list[dict]:
    if df is None or len(df) == 0:
        return []
    d = df.reset_index()
    if index_name:
        d = d.rename(columns={d.columns[0]: index_name})
    return [{str(k): _clean(v) for k, v in row.items()} for row in d.to_dict("records")]


def _epoch_to_date(x):
    try:
        return datetime.fromtimestamp(int(x), tz=timezone.utc).date().isoformat()
    except Exception:
        return None


# ─────────────────────────────── prices ───────────────────────────────

def get_price_history(symbol: str, period: str = "10y") -> Fetched:
    """Daily close (split-adjusted), adjusted close (splits + dividends), volume, dividends, splits."""
    _limiter.wait()
    df = _ticker(symbol).history(period=period, interval="1d", auto_adjust=False, actions=True)
    if df is None or df.empty:
        raise DataUnavailable(f"No price history for {symbol}")
    df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
    out = pd.DataFrame({
        "close": df["Close"],
        "adj_close": df.get("Adj Close", df["Close"]),
        "volume": df["Volume"],
        "dividend": df.get("Dividends", 0.0),
        "split": df.get("Stock Splits", 0.0),
    })
    return Fetched(out, SOURCE, out.index[-1].date().isoformat())


# ─────────────────────────────── quote / valuation ───────────────────────────────

def get_quote(symbol: str) -> Fetched:
    i = _info(symbol)
    keys = ["currentPrice", "regularMarketPrice", "previousClose", "marketCap", "sharesOutstanding",
            "floatShares", "currency", "longName", "sector", "industry", "beta", "regularMarketTime"]
    data = {k: _clean(i.get(k)) for k in keys}
    data["price"] = data.get("currentPrice") or data.get("regularMarketPrice")
    asof = _epoch_to_date(i.get("regularMarketTime")) or date.today().isoformat()
    return Fetched(data, SOURCE + " (delayed quote)", asof)


def get_valuation_multiples(symbol: str) -> Fetched:
    """Multiples as Yahoo reports them (forward P/E uses consensus next-fiscal-year EPS)."""
    i = _info(symbol)
    keys = ["forwardPE", "trailingPE", "priceToBook", "enterpriseToEbitda", "enterpriseValue", "forwardEps",
            "trailingEps", "bookValue", "freeCashflow", "ebitda", "totalDebt", "totalCash", "returnOnEquity",
            "dividendRate", "dividendYield", "payoutRatio"]
    data = {k: _clean(i.get(k)) for k in keys}
    return Fetched(data, SOURCE, _epoch_to_date(i.get("regularMarketTime")) or date.today().isoformat())


def get_short_interest(symbol: str) -> Fetched:
    """Exchange-reported short interest (twice monthly). Days to cover = short shares / avg daily volume."""
    i = _info(symbol)
    data = {
        "shares_short": _clean(i.get("sharesShort")),
        "shares_short_prior_month": _clean(i.get("sharesShortPriorMonth")),
        "short_pct_float": _clean(i.get("shortPercentOfFloat")),
        "days_to_cover": _clean(i.get("shortRatio")),
        "prior_month_date": _epoch_to_date(i.get("sharesShortPreviousMonthDate")),
    }
    asof = _epoch_to_date(i.get("dateShortInterest"))
    if data["shares_short"] is None:
        raise DataUnavailable(f"No short interest for {symbol}")
    return Fetched(data, SOURCE + " (exchange short interest)", asof,
                   lag="settlement-date snapshot, published ~2 weeks later")


# ─────────────────────────────── estimates & revisions ───────────────────────────────

def get_earnings_estimates(symbol: str) -> Fetched:
    """Consensus EPS and revenue estimates for 0q, +1q, 0y (current FY), +1y (next FY)."""
    t = _ticker(symbol)
    _limiter.wait()
    eps = _records(t.earnings_estimate, "period")
    rev = _records(t.revenue_estimate, "period")
    if not eps and not rev:
        raise DataUnavailable(f"No estimates for {symbol}")
    return Fetched({"eps": eps, "revenue": rev}, SOURCE + " (analyst consensus)", date.today().isoformat())


def get_eps_trend(symbol: str) -> Fetched:
    """Consensus EPS now vs 7/30/60/90 days ago, per period: the basis for revision direction."""
    _limiter.wait()
    rows = _records(_ticker(symbol).eps_trend, "period")
    if not rows:
        raise DataUnavailable(f"No EPS trend for {symbol}")
    return Fetched(rows, SOURCE + " (consensus EPS trend)", date.today().isoformat())


def get_eps_revisions(symbol: str) -> Fetched:
    """Count of analysts revising EPS up/down over the last 7 and 30 days: revision breadth."""
    _limiter.wait()
    rows = _records(_ticker(symbol).eps_revisions, "period")
    if not rows:
        raise DataUnavailable(f"No EPS revisions for {symbol}")
    return Fetched(rows, SOURCE + " (EPS revision counts)", date.today().isoformat())


def get_earnings_history(symbol: str) -> Fetched:
    """Last four quarters: estimate, actual, surprise %."""
    _limiter.wait()
    rows = _records(_ticker(symbol).earnings_history, "quarter")
    if not rows:
        raise DataUnavailable(f"No earnings history for {symbol}")
    rows = sorted(rows, key=lambda r: r.get("quarter") or "", reverse=True)
    return Fetched(rows, SOURCE, rows[0].get("quarter"))


def get_earnings_calendar(symbol: str) -> Fetched:
    _limiter.wait()
    cal = _ticker(symbol).calendar or {}
    dates = [_clean(d) for d in (cal.get("Earnings Date") or [])]
    data = {"earnings_dates": dates, "ex_dividend": _clean(cal.get("Ex-Dividend Date")),
            "eps_avg": _clean(cal.get("Earnings Average")), "revenue_avg": _clean(cal.get("Revenue Average"))}
    return Fetched(data, SOURCE + " (company calendar)", date.today().isoformat())


# ─────────────────────────────── sell-side ───────────────────────────────

def get_analyst_rating_changes(symbol: str, days: int = 180) -> Fetched:
    """Upgrades, downgrades and price-target changes by firm."""
    _limiter.wait()
    df = _ticker(symbol).upgrades_downgrades
    if df is None or df.empty:
        raise DataUnavailable(f"No rating changes for {symbol}")
    df = df[df.index >= pd.Timestamp.today() - pd.Timedelta(days=days)]
    rows = _records(df, "date")
    return Fetched(rows, SOURCE + " (broker rating changes)", rows[0]["date"] if rows else None)


def get_price_targets(symbol: str) -> Fetched:
    _limiter.wait()
    d = _ticker(symbol).analyst_price_targets or {}
    if not d:
        raise DataUnavailable(f"No price targets for {symbol}")
    i = _info(symbol)
    d = {k: _clean(v) for k, v in d.items()}
    d["recommendation_mean"] = _clean(i.get("recommendationMean"))   # 1 = strong buy, 5 = sell
    d["analysts"] = _clean(i.get("numberOfAnalystOpinions"))
    return Fetched(d, SOURCE + " (analyst consensus)", date.today().isoformat())


# ─────────────────────────────── ownership ───────────────────────────────

def get_institutional_holders(symbol: str) -> Fetched:
    """Top 10 institutional holders from their latest 13F, with % change in position."""
    _limiter.wait()
    t = _ticker(symbol)
    rows = _records(t.institutional_holders)
    if not rows:
        raise DataUnavailable(f"No institutional holders for {symbol}")
    major = {}
    try:
        m = t.major_holders
        if m is not None and not m.empty:
            major = {str(k): _clean(v) for k, v in m["Value"].items()}
    except Exception:
        pass
    asof = max((r.get("Date Reported") or "" for r in rows), default=None) or None
    return Fetched({"top": rows, "summary": major}, SOURCE + " (13F-based holder data)", asof,
                   lag="13F: filed up to 45 days after quarter end")


def get_insider_transactions_yahoo(symbol: str) -> Fetched:
    """Yahoo's insider transaction list. The updater prefers SEC Form 4 and uses this as fallback."""
    _limiter.wait()
    rows = _records(_ticker(symbol).insider_transactions)
    if not rows:
        raise DataUnavailable(f"No insider transactions for {symbol}")
    return Fetched(rows, SOURCE + " (Form 4 summary)", rows[0].get("Start Date"))


# ─────────────────────────────── options ───────────────────────────────

def get_options_implied_vol(symbol: str, spot: float, target_days: int = 30) -> Fetched:
    """At-the-money implied volatility from the listed expiry closest to ~30 days."""
    t = _ticker(symbol)
    _limiter.wait()
    expiries = list(t.options or [])
    if not expiries or not spot:
        raise DataUnavailable(f"No listed options for {symbol}")
    today = date.today()
    dated = [(e, (datetime.strptime(e, "%Y-%m-%d").date() - today).days) for e in expiries]
    dated = [x for x in dated if x[1] >= 14] or dated
    expiry, dte = min(dated, key=lambda x: abs(x[1] - target_days))
    _limiter.wait()
    chain = t.option_chain(expiry)
    ivs = []
    for side in (chain.calls, chain.puts):
        if side is None or side.empty:
            continue
        s = side[(side["impliedVolatility"] > 0.01) & (side["impliedVolatility"] < 5)].copy()
        if s.empty:
            continue
        s["dist"] = (s["strike"] - spot).abs()
        ivs.extend(s.nsmallest(2, "dist")["impliedVolatility"].tolist())
    if not ivs:
        raise DataUnavailable(f"No usable option quotes for {symbol}")
    iv = sum(ivs) / len(ivs)
    return Fetched({"atm_iv": iv, "expiry": expiry, "days": dte, "n_quotes": len(ivs)},
                   SOURCE + " (listed options, delayed)", today.isoformat())


# ─────────────────────────────── news ───────────────────────────────

def get_news(symbol: str, count: int = 20) -> Fetched:
    _limiter.wait()
    t = _ticker(symbol)
    try:
        items = t.get_news(count=count)
    except TypeError:
        items = t.news
    out = []
    for it in items or []:
        c = it.get("content") or it
        title = c.get("title")
        if not title:
            continue
        pub = c.get("pubDate") or c.get("displayTime")
        if not pub and it.get("providerPublishTime"):
            pub = datetime.fromtimestamp(int(it["providerPublishTime"]), tz=timezone.utc).isoformat()
        provider = (c.get("provider") or {}).get("displayName") if isinstance(c.get("provider"), dict) else None
        url = ((c.get("canonicalUrl") or {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else None) \
            or ((c.get("clickThroughUrl") or {}).get("url") if isinstance(c.get("clickThroughUrl"), dict) else None) \
            or it.get("link")
        out.append({"title": title, "date": (pub or "")[:10] or None, "publisher": provider or it.get("publisher"),
                    "url": url})
    if not out:
        raise DataUnavailable(f"No news for {symbol}")
    out.sort(key=lambda r: r["date"] or "", reverse=True)
    return Fetched(out, SOURCE + " (news feed)", out[0]["date"])
