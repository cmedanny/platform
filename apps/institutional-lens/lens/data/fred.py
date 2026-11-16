"""FRED (Federal Reserve Bank of St. Louis) macro series."""
from __future__ import annotations

import io

import pandas as pd

from ..config import CFG
from .base import DataUnavailable, Fetched, RateLimiter, http_get

_limiter = RateLimiter(0.5)

# Series used by the macro block. ISM PMI is not on FRED (licensing ended 2016),
# so industrial production is the activity gauge.
MACRO_SERIES = {
    "DFF": "Effective fed funds rate",
    "DGS2": "2-year Treasury yield",
    "DGS10": "10-year Treasury yield",
    "T10Y2Y": "10Y minus 2Y Treasury spread",
    "T10Y3M": "10Y minus 3M Treasury spread",
    "DTWEXBGS": "Broad trade-weighted US dollar index",
    "BAMLH0A0HYM2": "ICE BofA US high-yield option-adjusted spread",
    "BAMLC0A0CM": "ICE BofA US investment-grade option-adjusted spread",
    "INDPRO": "Industrial production index",
    "UNRATE": "Unemployment rate",
}


def get_macro_series(series_id: str, start: str = "2005-01-01") -> Fetched:
    """Returns a pandas Series indexed by date. Uses the API if a key is set, else the public CSV."""
    key = (CFG["keys"].get("fred_api_key") or "").strip()
    if key:
        js = http_get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={"series_id": series_id, "api_key": key, "file_type": "json", "observation_start": start},
            limiter=_limiter,
        ).json()
        obs = js.get("observations", [])
        s = pd.Series({o["date"]: o["value"] for o in obs})
        source = f"FRED API ({series_id})"
    else:
        text = http_get(
            "https://fred.stlouisfed.org/graph/fredgraph.csv",
            params={"id": series_id, "cosd": start},
            limiter=_limiter, timeout=30,  # FRED's CDN stalls custom User-Agents; use the library default
        ).text
        df = pd.read_csv(io.StringIO(text))
        if df.shape[1] < 2:
            raise DataUnavailable(f"FRED returned no data for {series_id}")
        s = pd.Series(df.iloc[:, 1].values, index=df.iloc[:, 0].values)
        source = f"FRED ({series_id})"
    s = pd.to_numeric(s.replace(".", None), errors="coerce").dropna()
    s.index = pd.to_datetime(s.index)
    if s.empty:
        raise DataUnavailable(f"FRED series {series_id} empty")
    lag = "monthly release, ~2-6 week lag" if series_id in {"INDPRO", "UNRATE"} else None
    return Fetched(s, source, s.index[-1].date().isoformat(), lag=lag)
