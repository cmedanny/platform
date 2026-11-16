"""Scanner page: the whole S&P 500 on one screen."""
from __future__ import annotations

from datetime import datetime

import pandas as pd
import streamlit as st

from .components import esc, md, meta, scanner_df

STANCE_ORDER = ["Accumulate", "Hold", "Reduce", "Avoid"]
STANCE_COLOR = {"Accumulate": "#3FB27F", "Hold": "#E0A73A", "Reduce": "#E5534B", "Avoid": "#E5534B"}


def _fmt_time(iso: str | None) -> str:
    if not iso:
        return "never"
    try:
        dt = datetime.fromisoformat(iso)
        return dt.strftime("%d %b %Y, %H:%M UTC")
    except ValueError:
        return iso


def render(detail_page) -> None:
    m = meta()
    df = scanner_df()
    cyc = (m.get("macro_snapshot") or {}).get("cycle") or {}
    with_data = int(df["stance"].notna().sum()) if len(df) else 0
    run = m.get("last_run") or {}
    run_note = f" · last run {run.get('status')}" if run.get("status") and run.get("status") != "ok" else ""

    md('<div class="il-brand">Institutional Lens</div>')
    md('<h1 class="il-h1">S&amp;P 500 Scanner</h1>')
    md(f'<div class="il-sub">Updated {_fmt_time(m.get("last_update"))} · {with_data} of {len(df)} constituents rated'
       f' · Cycle phase: {esc(cyc.get("phase") or "n/a")}{esc(run_note)}</div>')

    if df.empty:
        st.info("No data yet. Run the updater first (see README).")
        return

    c1, c2, c3, c4 = st.columns([1.4, 1.2, 1.1, 1])
    sectors = sorted(df["sector"].dropna().unique())
    sel_sec = c1.multiselect("Sector", sectors, placeholder="All sectors")
    sel_st = c2.multiselect("Stance", STANCE_ORDER + ["n/a"], placeholder="All stances")
    factor = c3.selectbox("Sort by factor", ["Composite", "Valuation", "Fundamentals", "Ownership", "Macro", "Catalysts"])
    query = c4.text_input("Search", placeholder="Ticker or name").strip().lower()

    view = df.copy()
    view["stance_f"] = view["stance"].fillna("n/a")
    if sel_sec:
        view = view[view["sector"].isin(sel_sec)]
    if sel_st:
        view = view[view["stance_f"].isin(sel_st)]
    if query:
        view = view[view["ticker"].str.lower().str.contains(query, regex=False)
                    | view["name"].str.lower().str.contains(query, regex=False)]
    sort_col = {"Composite": "composite"}.get(factor, f"score_{factor.lower()}")
    view = view.sort_values(sort_col, ascending=False, na_position="last")

    counts = view["stance_f"].value_counts()
    parts = [f'<span style="color:{STANCE_COLOR[s]}">{s}</span> {counts.get(s, 0)}' for s in STANCE_ORDER]
    md(f'<div class="il-meta" style="font-size:13px">{" &nbsp;·&nbsp; ".join(parts)} &nbsp;·&nbsp; '
       f'<span class="c-muted">n/a {counts.get("n/a", 0)}</span> &nbsp;·&nbsp; {len(view)} shown. '
       f'Select a row to open the ticker.</div>')

    show = pd.DataFrame({
        "Ticker": view["ticker"],
        "Sector": view["sector"],
        "Price": view["price"],
        "Valuation pctile": view["valuation_pct"],
        "Revisions": view["revisions"],
        "Ownership": view["ownership"],
        "Regime fit": view["regime"],
        "Stance": view["stance_f"],
        "Score": view["composite"],
        "Factor": view[sort_col] if sort_col != "composite" else view["composite"],
    }).reset_index(drop=True)
    if sort_col == "composite":
        show = show.drop(columns=["Factor"])
    else:
        show = show.rename(columns={"Factor": f"{factor} score"})
    for c in ("Revisions", "Ownership", "Regime fit"):
        show[c] = show[c].fillna("n/a")
    # Numbers become right-aligned, space-padded text so that missing values read "n/a"
    # while column sorting still follows numeric order.
    def pad(series, fmt, width):
        return pd.to_numeric(series, errors="coerce").map(lambda x: "n/a" if pd.isna(x) else fmt.format(x).rjust(width))

    show["Price"] = pad(show["Price"], "{:,.2f}", 12)
    for c in [c for c in show.columns if c in ("Valuation pctile", "Score") or c.endswith(" score")]:
        show[c] = pad(show[c], "{:.0f}", 3)
    num_cols = [c for c in show.columns if c in ("Price", "Valuation pctile", "Score") or c.endswith(" score")]

    styler = show.style \
        .map(lambda s: f"color: {STANCE_COLOR.get(s, '#5C636D')}", subset=["Stance"]) \
        .map(lambda s: "color: #5C636D" if s == "n/a" else "", subset=["Revisions", "Ownership", "Regime fit", *num_cols])
    tips = {
        "Price": "Last price, USD (delayed). As-of date on the ticker page.",
        "Valuation pctile": "Today's multiples vs the stock's own 10-year history. 0 = cheapest ever, 100 = most expensive.",
        "Score": "Composite score, 0-100. 50 = neutral.",
    }
    cfg = {
        "Ticker": st.column_config.TextColumn(width="small"),
        **{c: st.column_config.TextColumn(alignment="right", help=tips.get(c, f"{factor} block score, 0-100."))
           for c in num_cols},
        "Revisions": st.column_config.TextColumn(help="Direction and breadth of consensus EPS revisions (30/90 days)."),
        "Ownership": st.column_config.TextColumn(help="13F holders, insiders, short interest and sell-side actions combined."),
        "Regime fit": st.column_config.TextColumn(help="Sector fit with the current business-cycle phase plus relative strength."),
        "Stance": st.column_config.TextColumn(help="From the weighted composite of the five block scores (weights in config.toml)."),
    }
    event = st.dataframe(styler, column_config=cfg, hide_index=True, use_container_width=True, height=640,
                         on_select="rerun", selection_mode="single-row", key="scanner_table")
    sel = getattr(getattr(event, "selection", None), "rows", None) or []
    if sel:
        st.session_state["ticker"] = show.iloc[sel[0]]["Ticker"]
        st.switch_page(detail_page)
