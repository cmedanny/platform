"""S&P 500 constituent list (Wikipedia)."""
from __future__ import annotations

import io
from datetime import date

import pandas as pd

from .base import DataUnavailable, Fetched, http_get

WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
SOURCE = "Wikipedia: List of S&P 500 companies"


def get_sp500_constituents() -> Fetched:
    """Returns a DataFrame: ticker, yahoo_symbol, name, sector, sub_industry, cik, date_added."""
    html = http_get(WIKI_URL, headers={"User-Agent": "InstitutionalLens/1.0 (personal research tool)"}).text
    tables = pd.read_html(io.StringIO(html))
    table = next((t for t in tables if "Symbol" in t.columns and "GICS Sector" in t.columns), None)
    if table is None:
        raise DataUnavailable("Constituent table not found on Wikipedia page")
    df = pd.DataFrame({
        "ticker": table["Symbol"].astype(str).str.strip(),
        "name": table["Security"].astype(str).str.strip(),
        "sector": table["GICS Sector"].astype(str).str.strip(),
        "sub_industry": table.get("GICS Sub-Industry", pd.Series([None] * len(table))).astype(str),
        "cik": table["CIK"].apply(lambda x: str(int(x)).zfill(10) if pd.notna(x) else None) if "CIK" in table else None,
        "date_added": table.get("Date added", pd.Series([None] * len(table))).astype(str),
    })
    # Yahoo uses a dash for share classes: BRK.B -> BRK-B
    df["yahoo_symbol"] = df["ticker"].str.replace(".", "-", regex=False)
    if len(df) < 400:
        raise DataUnavailable(f"Constituent table looks incomplete ({len(df)} rows)")
    return Fetched(df, SOURCE, date.today().isoformat())
