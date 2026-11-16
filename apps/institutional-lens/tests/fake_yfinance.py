"""Test double for yfinance.Ticker, shaped exactly like yfinance 1.x returns.

Used only by tests/selftest.py to exercise the full pipeline without calling
Yahoo. Prices come from Stooq's free CSV when reachable (synthetic otherwise);
every other Yahoo field is synthetic test data and never ships to the app's
real database.
"""
from __future__ import annotations

import io
import random
from collections import namedtuple
from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import requests

Options = namedtuple("Options", ["calls", "puts", "underlying"])


def _prices(symbol: str) -> pd.DataFrame:
    try:
        txt = requests.get(f"https://stooq.com/q/d/l/?s={symbol.lower()}.us&i=d", timeout=30).text
        df = pd.read_csv(io.StringIO(txt), parse_dates=["Date"]).set_index("Date")
        df = df[df.index >= pd.Timestamp.today() - pd.DateOffset(years=10)]
        if len(df) > 500:
            out = pd.DataFrame({"Open": df["Open"], "High": df["High"], "Low": df["Low"], "Close": df["Close"],
                                "Adj Close": df["Close"], "Volume": df["Volume"], "Dividends": 0.0, "Stock Splits": 0.0})
            out.index = out.index.tz_localize("America/New_York")
            return out
    except Exception:
        pass
    idx = pd.bdate_range(end=pd.Timestamp.today(), periods=2520, tz="America/New_York")
    px = 100 * np.exp(np.cumsum(np.random.default_rng(1).normal(0.0003, 0.015, len(idx))))
    return pd.DataFrame({"Open": px, "High": px, "Low": px, "Close": px, "Adj Close": px, "Volume": 5e6,
                         "Dividends": 0.0, "Stock Splits": 0.0}, index=idx)


class FakeTicker:
    def __init__(self, symbol: str):
        self.ticker = symbol
        self._rng = random.Random(symbol)
        self._hist = _prices(symbol)
        # quarterly dividends for the last 6 years, growing
        divs = pd.date_range(end=pd.Timestamp.today(), periods=24, freq="QE", tz="America/New_York")
        for i, d in enumerate(divs):
            j = self._hist.index.searchsorted(d)
            if j < len(self._hist):
                self._hist.iloc[j, self._hist.columns.get_loc("Dividends")] = 0.5 * (1.06 ** (i / 4))
        self.price = float(self._hist["Close"].iloc[-1])

    # ── prices
    def history(self, period="10y", interval="1d", auto_adjust=False, actions=True):
        return self._hist.copy()

    # ── info
    @property
    def info(self):
        r = self._rng
        now = int(datetime.now(timezone.utc).timestamp())
        return {
            "currentPrice": self.price, "regularMarketPrice": self.price, "regularMarketTime": now,
            "marketCap": None,  # None -> app skips share-class calibration in the test
            "forwardPE": round(self.price / (self.price / r.uniform(14, 32)), 2), "trailingPE": r.uniform(15, 35),
            "sharesShort": 3.0e7, "sharesShortPriorMonth": 2.7e7, "shortPercentOfFloat": r.uniform(0.005, 0.06),
            "shortRatio": r.uniform(1, 6), "dateShortInterest": now - 14 * 86400,
            "sharesShortPreviousMonthDate": now - 44 * 86400,
            "recommendationMean": r.uniform(1.6, 3.0), "numberOfAnalystOpinions": r.randint(10, 40),
            "longName": self.ticker, "currency": "USD",
        }

    # ── estimates
    def _eps(self):
        return self.price / self._rng.uniform(16, 30)

    @property
    def earnings_estimate(self):
        e = self._eps()
        rows = {p: {"avg": e * f, "low": e * f * 0.9, "high": e * f * 1.1, "yearAgoEps": e * f * 0.92,
                    "numberOfAnalysts": 25, "growth": 0.08} for p, f in (("0q", 0.25), ("+1q", 0.26), ("0y", 1.0), ("+1y", 1.1))}
        df = pd.DataFrame(rows).T
        df.index.name = "period"
        return df

    @property
    def revenue_estimate(self):
        rows = {p: {"avg": 1e11 * f, "low": 0.95e11 * f, "high": 1.05e11 * f, "numberOfAnalysts": 22,
                    "yearAgoRevenue": 0.93e11 * f, "growth": 0.07} for p, f in (("0q", 0.25), ("+1q", 0.26), ("0y", 1), ("+1y", 1.07))}
        df = pd.DataFrame(rows).T
        df.index.name = "period"
        return df

    @property
    def eps_trend(self):
        e, d = self._eps(), self._rng.uniform(-0.05, 0.05)
        rows = {p: {"current": e * f, "7daysAgo": e * f * (1 - d / 6), "30daysAgo": e * f * (1 - d / 3),
                    "60daysAgo": e * f * (1 - d / 1.5), "90daysAgo": e * f * (1 - d)}
                for p, f in (("0q", 0.25), ("+1q", 0.26), ("0y", 1.0), ("+1y", 1.1))}
        df = pd.DataFrame(rows).T
        df.index.name = "period"
        return df

    @property
    def eps_revisions(self):
        r = self._rng
        rows = {p: {"upLast7days": r.randint(0, 4), "upLast30days": r.randint(0, 12), "downLast30days": r.randint(0, 12),
                    "downLast7Days": r.randint(0, 4)} for p in ("0q", "+1q", "0y", "+1y")}
        df = pd.DataFrame(rows).T
        df.index.name = "period"
        return df

    @property
    def earnings_history(self):
        qs = pd.date_range(end=pd.Timestamp.today(), periods=4, freq="QE")
        rows = []
        for q in qs:
            est = self._eps() / 4
            act = est * (1 + self._rng.uniform(-0.04, 0.08))
            rows.append({"quarter": q, "epsActual": act, "epsEstimate": est, "epsDifference": act - est,
                         "surprisePercent": (act - est) / est})
        return pd.DataFrame(rows).set_index("quarter")

    @property
    def calendar(self):
        return {"Earnings Date": [date.today() + timedelta(days=self._rng.randint(5, 80))], "Earnings Average": 1.2}

    # ── sell side
    @property
    def upgrades_downgrades(self):
        r = self._rng
        rows = []
        for i in range(10):
            a = r.choice(["main", "main", "up", "down", "init", "reit"])
            pta = r.choice(["Raises", "Lowers", "Maintains"])
            rows.append({"GradeDate": pd.Timestamp.today().normalize() - pd.Timedelta(days=9 * i + 1),
                         "Firm": r.choice(["Morgan Stanley", "Goldman Sachs", "JPMorgan", "Barclays", "UBS"]),
                         "ToGrade": "Overweight", "FromGrade": "Equal-Weight" if a == "up" else "Overweight",
                         "Action": a, "priceTargetAction": pta, "currentPriceTarget": self.price * 1.1,
                         "priorPriceTarget": self.price * (1.0 if pta == "Raises" else 1.2)})
        return pd.DataFrame(rows).set_index("GradeDate")

    @property
    def analyst_price_targets(self):
        return {"current": self.price, "high": self.price * 1.4, "low": self.price * 0.8, "mean": self.price * 1.12,
                "median": self.price * 1.1}

    # ── holders
    @property
    def institutional_holders(self):
        r = self._rng
        names = ["Vanguard Group Inc", "Blackrock Inc.", "State Street Corporation", "FMR, LLC", "Geode Capital Management",
                 "Capital Research Global Investors", "T. Rowe Price", "Morgan Stanley", "Northern Trust", "JPMorgan Chase"]
        return pd.DataFrame([{"Date Reported": pd.Timestamp("2026-09-30"), "Holder": n, "pctHeld": r.uniform(0.005, 0.09),
                              "Shares": r.randint(10_000_000, 900_000_000), "Value": 1e9, "pctChange": r.uniform(-0.06, 0.06)}
                             for n in names])

    @property
    def major_holders(self):
        return pd.DataFrame({"Value": [0.01, 0.72, 0.73, 4000]},
                            index=["insidersPercentHeld", "institutionsPercentHeld", "institutionsFloatPercentHeld",
                                   "institutionsCount"])

    @property
    def insider_transactions(self):
        return pd.DataFrame([{"Shares": 10000, "Value": 1.5e6, "URL": "", "Text": "Sale at price 150.00 per share.",
                              "Insider": "DOE JANE", "Position": "Officer", "Transaction": "",
                              "Start Date": pd.Timestamp.today() - pd.Timedelta(days=20), "Ownership": "D"}])

    # ── options
    @property
    def options(self):
        return tuple((date.today() + timedelta(days=d)).isoformat() for d in (3, 10, 31, 59, 94))

    def option_chain(self, expiry):
        strikes = np.round(np.linspace(self.price * 0.8, self.price * 1.2, 21), 0)
        iv = self._rng.uniform(0.18, 0.40)
        df = pd.DataFrame({"strike": strikes, "impliedVolatility": iv + np.abs(strikes / self.price - 1) * 0.3,
                           "bid": 1.0, "ask": 1.1})
        return Options(df.copy(), df.copy(), {})

    # ── news
    def get_news(self, count=10, tab="news"):
        titles = [
            f"{self.ticker} raises full-year guidance after strong quarter",
            "5 stocks to buy now before year-end",
            f"{self.ticker} CFO to step down, company names successor",
            f"{self.ticker} shares rise 2% in morning trading",
            f"Regulators open probe into {self.ticker} sales practices",
            f"{self.ticker} beats estimates on cloud demand",
        ]
        now = datetime.now(timezone.utc)
        return [{"id": str(i), "content": {"title": t, "pubDate": (now - timedelta(days=2 * i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                           "provider": {"displayName": "Test Wire"},
                                           "canonicalUrl": {"url": "https://example.com"}}} for i, t in enumerate(titles)]
