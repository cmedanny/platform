"""SQLite storage. The updater writes; the UI only reads."""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS tickers (
    ticker TEXT PRIMARY KEY, yahoo_symbol TEXT, name TEXT, sector TEXT, sub_industry TEXT,
    cik TEXT, date_added TEXT, source TEXT, asof TEXT
);
CREATE TABLE IF NOT EXISTS prices (
    symbol TEXT, date TEXT, close REAL, adj_close REAL, volume REAL,
    PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS corporate_actions (
    symbol TEXT, date TEXT, kind TEXT, value REAL, PRIMARY KEY (symbol, date, kind)
);
CREATE TABLE IF NOT EXISTS fundamentals (
    ticker TEXT, end_date TEXT, metric TEXT, value REAL, filed TEXT, source TEXT,
    PRIMARY KEY (ticker, metric, end_date)
);
CREATE TABLE IF NOT EXISTS estimate_history (
    ticker TEXT, date TEXT, period TEXT, eps_avg REAL, rev_avg REAL, fwd_pe REAL,
    PRIMARY KEY (ticker, date, period)
);
CREATE TABLE IF NOT EXISTS macro (
    series_id TEXT, date TEXT, value REAL, PRIMARY KEY (series_id, date)
);
CREATE TABLE IF NOT EXISTS f13_aggregate (
    period TEXT, cusip TEXT, issuer TEXT, shares REAL, value REAL, holders INTEGER,
    PRIMARY KEY (period, cusip)
);
CREATE TABLE IF NOT EXISTS f13_change (
    cusip TEXT PRIMARY KEY, period TEXT, prior_period TEXT, shares_cur REAL, shares_prev REAL, shares_chg REAL,
    holders_cur INTEGER, holders_panel_chg REAL, panel_filers INTEGER, excluded_positions INTEGER
);
CREATE TABLE IF NOT EXISTS cusip_map (
    cusip TEXT PRIMARY KEY, ticker TEXT, name TEXT, source TEXT, mapped_at TEXT
);
CREATE TABLE IF NOT EXISTS raw (
    ticker TEXT, kind TEXT, payload TEXT, source TEXT, asof TEXT, fetched_at TEXT,
    PRIMARY KEY (ticker, kind)
);
CREATE TABLE IF NOT EXISTS metrics (
    ticker TEXT PRIMARY KEY, payload TEXT, computed_at TEXT
);
CREATE TABLE IF NOT EXISTS snapshot (
    ticker TEXT PRIMARY KEY, scanner TEXT, detail TEXT, computed_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started TEXT, finished TEXT, status TEXT,
    ok INTEGER, failed INTEGER, note TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect(path: Path | str = DB_PATH, readonly: bool = False) -> sqlite3.Connection:
    if readonly:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
    else:
        con = sqlite3.connect(path, timeout=60)
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(SCHEMA)
    con.row_factory = sqlite3.Row
    return con


@contextmanager
def transaction(con: sqlite3.Connection):
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise


def set_meta(con, key: str, value) -> None:
    con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, json.dumps(value, default=str)))


def get_meta(con, key: str, default=None):
    row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def put_raw(con, ticker: str, kind: str, payload, source: str, asof: str | None) -> None:
    con.execute(
        "INSERT OR REPLACE INTO raw(ticker, kind, payload, source, asof, fetched_at) VALUES (?,?,?,?,?,?)",
        (ticker, kind, json.dumps(payload, default=str), source, asof, now_iso()),
    )


def get_raw(con, ticker: str, kind: str):
    row = con.execute("SELECT payload, source, asof, fetched_at FROM raw WHERE ticker=? AND kind=?", (ticker, kind)).fetchone()
    if not row:
        return None
    return {"data": json.loads(row["payload"]), "source": row["source"], "asof": row["asof"], "fetched_at": row["fetched_at"]}
