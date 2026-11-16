"""Formatting and small HTML building blocks shared by both pages."""
from __future__ import annotations

import html
import json
import os
import sqlite3
from pathlib import Path

import pandas as pd
import streamlit as st

from ..config import DB_PATH

NA = '<span class="na">n/a</span>'

STANCE_CLASS = {"Accumulate": "c-acc", "Hold": "c-hold", "Reduce": "c-red", "Avoid": "c-red"}

TIPS = {
    "pe_fwd": "Price / consensus EPS for the next fiscal year.",
    "pe_ttm": "Price / reported earnings over the last 12 months (SEC filings).",
    "ev_ebitda": "Enterprise value (market cap + debt - cash) / operating income before D&A, trailing 12 months.",
    "fcf_yield": "Operating cash flow minus capex, trailing 12 months, as % of market cap. Higher = cheaper.",
    "pb": "Market cap / shareholders' equity. The core multiple for banks and insurers.",
    "valuation_pct": "Where today's multiples sit in the stock's own 10-year monthly history. 0 = cheapest ever, 100 = most expensive.",
    "zone": "Price at which today's fundamentals would put the stock in the cheapest 25% of its own valuation history.",
    "eps_rev": "Change in the consensus EPS estimate for the fiscal year shown.",
    "breadth": "How many analysts raised vs cut their EPS estimate.",
    "rev_rev": "Change in consensus revenue estimate, recorded nightly by this app.",
    "roic": "After-tax operating income / capital invested (debt + equity - cash).",
    "roe": "Net income / shareholders' equity.",
    "cash_conv": "Operating cash flow / net income. Persistently below ~0.8 means earnings are not turning into cash.",
    "nd_ebitda": "Net debt / EBITDA: years of operating earnings needed to repay net debt.",
    "int_cov": "Operating income / interest expense: how many times profits cover interest.",
    "buyback_yield": "Share repurchases over the last 12 months as % of market cap.",
    "f13": "Total shares held by every 13F filer (managers with >$100M), this quarter vs last. Filed up to 45 days after quarter end.",
    "cluster": "Three or more different insiders buying on the open market within 90 days, historically the strongest insider signal.",
    "si": "Shares sold short as % of float. Days to cover = short shares / average daily volume.",
    "iv_hv": "Options-implied volatility vs realized. Well above 1 means the market is pricing an event.",
    "adv": "Average daily dollar volume, 60 days. Sets how fast a position can be built without moving the price.",
    "fed_path": "2-year Treasury yield minus fed funds. Negative = market pricing cuts; positive = hikes.",
    "curve": "10-year minus 2-year Treasury yield. Inversion has preceded most US recessions.",
    "hy": "Extra yield on high-yield bonds over Treasuries. Widening signals rising credit stress.",
}


# ─────────────────────────────── data access (read-only) ───────────────────────────────

def _db_version() -> float:
    try:
        return os.path.getmtime(DB_PATH) + (os.path.getmtime(str(DB_PATH) + "-wal") if Path(str(DB_PATH) + "-wal").exists() else 0)
    except OSError:
        return 0.0


def _con():
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)


@st.cache_data(show_spinner=False)
def _scanner(version: float) -> pd.DataFrame:
    with _con() as con:
        rows = [json.loads(r[0]) for r in con.execute("SELECT scanner FROM snapshot")]
    return pd.DataFrame(rows)


@st.cache_data(show_spinner=False)
def _detail(ticker: str, version: float) -> dict | None:
    with _con() as con:
        r = con.execute("SELECT detail FROM snapshot WHERE ticker=?", (ticker,)).fetchone()
    return json.loads(r[0]) if r else None


@st.cache_data(show_spinner=False)
def _meta(version: float) -> dict:
    with _con() as con:
        meta = {k: json.loads(v) for k, v in con.execute("SELECT key, value FROM meta WHERE key IN "
                                                       "('last_update','last_scored','macro_snapshot')")}
        run = con.execute("SELECT started, finished, status, ok, failed FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    meta["last_run"] = dict(zip(["started", "finished", "status", "ok", "failed"], run)) if run else None
    return meta


def has_data() -> bool:
    if not Path(DB_PATH).exists():
        return False
    try:
        with _con() as con:
            return con.execute("SELECT COUNT(*) FROM snapshot").fetchone()[0] > 0
    except sqlite3.Error:
        return False


def scanner_df() -> pd.DataFrame:
    return _scanner(_db_version())


def detail(ticker: str) -> dict | None:
    return _detail(ticker, _db_version())


def meta() -> dict:
    return _meta(_db_version())


# ─────────────────────────────── formatting ───────────────────────────────

def esc(x) -> str:
    return html.escape(str(x))


def isnum(x) -> bool:
    return isinstance(x, (int, float)) and not (isinstance(x, float) and x != x)


def f_pct(x, nd=1, signed=False):
    if not isnum(x):
        return NA
    return f"{x * 100:{'+' if signed else ''}.{nd}f}%"


def f_x(x, nd=1):
    return f"{x:.{nd}f}x" if isnum(x) else NA


def f_num(x, nd=1):
    return f"{x:,.{nd}f}" if isnum(x) else NA


def f_price(x):
    return f"${x:,.2f}" if isnum(x) else NA


def f_money(x):
    if not isnum(x):
        return NA
    a = abs(x)
    for div, suf in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if a >= div:
            return f"${x / div:,.1f}{suf}"
    return f"${x:,.0f}"


def f_ord(x):
    if not isnum(x):
        return NA
    n = int(round(x))
    suf = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


def short_src(src: str | None) -> str:
    if not src:
        return ""
    s = src.lower()
    if s.startswith("derived"):
        return "Derived"
    for key, label in (("sec", "SEC"), ("yahoo", "Yahoo"), ("fred", "FRED"), ("openfigi", "OpenFIGI"), ("wikipedia", "Wikipedia")):
        if key in s:
            return label
    return src.split(" ")[0]


def tip(label: str, key: str | None = None, text: str | None = None) -> str:
    t = text or TIPS.get(key or "")
    return f'<span class="tip" title="{esc(t)}">{esc(label)}</span>' if t else esc(label)


def src_cell(d: dict | None, extra_lag: str | None = None) -> str:
    """'SEC · 2026-09-26 [LAGGED]' with full source and lag note on hover."""
    if not d or (d.get("src") is None and d.get("asof") is None):
        return ""
    parts = []
    if d.get("src"):
        parts.append(f'<span title="{esc(d["src"])}">{esc(short_src(d["src"]))}</span>')
    if d.get("asof"):
        parts.append(esc(d["asof"]))
    out = " · ".join(parts)
    lag = extra_lag or d.get("lag")
    if lag:
        out += f'<span class="lag" title="{esc(lag)}">LAGGED</span>'
    return f'<span class="srcwrap">{out}</span>'


def stance_html(stance: str | None, cls_extra="") -> str:
    if not stance:
        return NA
    return f'<span class="{STANCE_CLASS.get(stance, "")} {cls_extra}">{esc(stance)}</span>'


def score_class(score) -> str:
    if not isnum(score):
        return "c-muted"
    return "c-acc" if score >= 55 else "c-hold" if score > 45 else "c-red"


def score_html(score) -> str:
    return f'<span class="{score_class(score)}">{score:.0f}</span>' if isnum(score) else NA


def table(headers: list[str], rows: list[list[str]], num_cols: tuple[int, ...] = (), src_col: int | None = None) -> str:
    th = "".join(f'<th class="{"num" if i in num_cols else ""}">{h}</th>' for i, h in enumerate(headers))
    body = ""
    for r in rows:
        tds = ""
        for i, c in enumerate(r):
            cls = "num" if i in num_cols else "src" if i == src_col else ""
            tds += f'<td class="{cls}">{c if c not in (None, "") else ("" if i == src_col else NA)}</td>'
        body += f"<tr>{tds}</tr>"
    return f'<table class="il"><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>'


def md(s: str) -> None:
    st.markdown(s, unsafe_allow_html=True)


def section(n: int, title: str, question: str, score=None) -> None:
    sc = f'<span class="il-score">Score {score_html(score)} / 100</span>'
    md(f'<div class="il-section"><h2>{n} · {esc(title)}<span class="q">{esc(question)}</span></h2>{sc}</div>')


def score_breakdown(block: dict) -> None:
    with st.expander(f"How this score was built · {block.get('coverage', '')}"):
        rows = [[esc(i["name"]), esc(i["value"]) if i["value"] is not None else NA,
                 f_num(i["score"], 0) if i["score"] is not None else '<span class="na">not scored</span>',
                 str(i["weight"]), f'<span class="il-meta">{esc(i["rule"])}</span>'] for i in block["inputs"]]
        md(table(["Input", "Value", "Score", "Weight", "Rule"], rows, num_cols=(2, 3)))
        md('<div class="il-note" style="margin-top:.6rem">Block score = weighted average of scored inputs (missing inputs '
           'are excluded and weights rescaled; at least 35% of the weight must be available). 50 is neutral.</div>')


def footer() -> None:
    md('<div class="il-footer">Analysis, not financial advice. Data: Yahoo Finance via the unofficial yfinance library, '
       'SEC EDGAR (XBRL, Form 4, Form 13F), FRED, Wikipedia, OpenFIGI. Quotes are delayed; items marked LAGGED are '
       'structurally delayed (hover for detail). Missing data is shown as n/a and never estimated.</div>')
