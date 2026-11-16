"""Ticker Detail page: verdict card plus the five analysis blocks."""
from __future__ import annotations

import streamlit as st

from .components import (NA, detail, esc, f_money, f_num, f_ord, f_pct, f_price, f_x, isnum, md, meta, scanner_df,
                         score_breakdown, score_class, section, src_cell, stance_html, table, tip)

BLOCK_LABELS = [("valuation", "Valuation"), ("fundamentals", "Fundamentals"), ("ownership", "Ownership"),
                ("macro", "Macro regime"), ("catalysts", "Catalysts & risk")]


def v(d):
    return (d or {}).get("v")


def render(scanner_page) -> None:
    df = scanner_df()
    if df.empty:
        st.info("No data yet. Run the updater first (see README).")
        return
    df = df.sort_values("ticker")
    tickers = df["ticker"].tolist()
    names = dict(zip(df["ticker"], df["name"]))
    qp = st.query_params.get("t")
    current = st.session_state.get("ticker") or qp or tickers[0]
    if current not in tickers:
        current = tickers[0]

    top_l, top_r = st.columns([3, 1.2])
    with top_l:
        st.page_link(scanner_page, label="← Scanner")
    with top_r:
        pick = st.selectbox("Ticker", tickers, index=tickers.index(current),
                            format_func=lambda t: f"{t} · {names.get(t, '')}", label_visibility="collapsed")
    if pick != current:
        st.session_state["ticker"] = pick
        current = pick
    st.query_params["t"] = current

    d = detail(current)
    if not d:
        st.warning("No stored analysis for this ticker yet.")
        return
    m, scores, vd = d["metrics"], d["scores"], d["verdict"]
    val = m["valuation"]
    price = val["price"]

    md(f'<h1 class="il-h1" style="margin-top:1rem">{esc(m["ticker"])}<span class="name">{esc(m["name"])}</span></h1>')
    md(f'<div class="il-sub">{esc(m["sector"])} · {esc(m.get("sub_industry") or "")} · '
       f'{f_price(v(price))} <span class="il-meta">{src_cell(price)}</span></div>')

    verdict_card(m, scores, vd)
    score_strip(scores)
    valuation(m, scores["valuation"], d.get("sector_medians") or {})
    fundamentals(m, scores["fundamentals"])
    ownership(m, scores["ownership"])
    macro_block(m, scores["macro"])
    catalysts(m, scores["catalysts"], vd)


# ─────────────────────────────── verdict ───────────────────────────────

def verdict_card(m, scores, vd) -> None:
    stance = vd.get("stance")
    conf = vd.get("confidence") or {}
    plan = vd.get("plan") or {}
    sizing = plan.get("sizing") or {}

    exp_v = f'{f_pct(vd.get("base_upside"), 0, True)} / {f_pct(vd.get("bear_downside"), 0, True)}' \
        if isnum(vd.get("base_upside")) else NA
    kv = [
        ("Base / bear case", exp_v, "expected return vs price" + (
            f" · bull {f_pct(vd.get('bull_upside'), 0, True)}" if isnum(vd.get("bull_upside")) else "")),
        ("Composite", f'<span class="{score_class(vd.get("composite"))}">{f_num(vd.get("composite"), 0)}</span> / 100',
         "weighted average of block scores"),
        ("Confidence", esc(conf.get("label", "n/a")),
         f'{conf.get("agree", 0)} of {conf.get("of", 0)} blocks agree with the stance'),
        ("Time horizon", esc((vd.get("horizon") or "n/a").split(" (")[0]),
         esc(vd.get("horizon", "").split(" (")[1].rstrip(")")) if "(" in (vd.get("horizon") or "") else ""),
    ]
    grid = "".join(f'<div class="il-kv"><div class="k">{k}</div><div class="v">{val}</div><div class="s">{s}</div></div>'
                   for k, val, s in kv)

    rows = []
    for t in plan.get("tranches") or []:
        rows.append([f"Tranche {t['n']}", f_price(t["price"]), f"{t['pctile']:g}th pctile",
                     f_pct((t["weight_pct"] or 0) / 100, 2) if isnum(t.get("weight_pct")) else NA,
                     esc(t["status"])])
    plan_html = table(["", "Price", "Valuation", "Weight", "Status"], rows, num_cols=(1, 3)) if rows else \
        f'<div class="il-note">{esc(plan.get("note", "n/a"))}</div>'
    size_line = ""
    if isnum(sizing.get("full_weight_pct")):
        dtb = f", ~{sizing['days_to_build']:.1f} trading days to build" if isnum(sizing.get("days_to_build")) else ""
        size_line = (f'Full position {sizing["full_weight_pct"]:.2f}% of portfolio '
                     f'({sizing["scale"]:.2f}x volatility scaling, 90-day vol {f_pct(sizing["hv90"], 0)}){dtb}.')
    note = plan.get("note") if rows else ""
    inv = "".join(f"<li>{esc(x)}</li>" for x in vd.get("invalidation") or []) or f"<li>{NA}</li>"
    inv_label = "Thesis invalidation (exit triggers)" if stance in ("Accumulate", "Hold") else "What would change the view"
    stance_note = f'<div class="il-meta" style="margin-top:8px">{esc(vd["stance_note"])}</div>' if vd.get("stance_note") else ""

    md(f'''<div class="il-card">
      <div class="il-brand">Verdict</div>
      <div class="il-stance" style="margin-top:10px">{stance_html(stance)}</div>{stance_note}
      <p class="il-thesis">{esc(vd.get("thesis") or "n/a")}</p>
      <div class="il-meta">Thesis written by {esc(vd.get("thesis_source", "rules template"))}.</div>
      <div class="il-grid">{grid}</div>
      <div class="il-cols">
        <div><div class="il-label">{tip("Build plan", text="Three tranches across the valuation zone, sized for volatility. Never a single entry.")}</div>
          {plan_html}
          <div class="il-note" style="margin-top:.7rem">{esc(note)} {esc(size_line)}</div></div>
        <div><div class="il-label">{inv_label}</div><ul class="il-list">{inv}</ul></div>
      </div>
    </div>''')


def score_strip(scores) -> None:
    cells = "".join(f'<div><div class="k">{label}</div><div class="v">'
                    f'{"<span class=" + chr(34) + score_class(scores[b]["score"]) + chr(34) + ">" + f_num(scores[b]["score"], 0) + "</span>" if isnum(scores[b]["score"]) else NA}'
                    f'</div></div>' for b, label in BLOCK_LABELS)
    md(f'<div class="il-scores">{cells}</div>')


# ─────────────────────────────── 1. valuation ───────────────────────────────

def valuation(m, block, med) -> None:
    val = m["valuation"]
    section(1, "Valuation", "Is this cheap or expensive relative to what it's worth?", block["score"])
    names = [("pe_fwd", "Forward P/E"), ("pe_ttm", "Trailing P/E")]
    names += [("pb", "Price / book")] if val["is_financial"] else [("ev_ebitda", "EV / EBITDA"), ("fcf_yield", "FCF yield")]
    rows = []
    for key, label in names:
        x = val["metrics"].get(key) or {}
        cur = v(x.get("current"))
        fmt = (lambda y: f_pct(y, 1)) if key == "fcf_yield" else f_x
        h = x.get("hist")
        if h:
            pct_cell = f'{f_ord(h["expensive_pct"])} <span class="il-meta">({h["n_months"]} mo)</span>'
            rng = f'{fmt(h["min"])} · {fmt(h["median"])} · {fmt(h["max"])}'
        else:
            pct_cell = f'<span class="na" title="{esc(x.get("hist_note") or "fewer than 24 months of history")}">n/a</span>'
            rng = NA
        sm = (med.get(key) or {})
        smv = f'{fmt(sm["median"])} <span class="il-meta">(n={sm["n"]})</span>' if sm else NA
        rows.append([tip(label, key), fmt(cur), pct_cell, rng, smv, src_cell(x.get("current"))])
    if not val["is_financial"]:
        x = val["metrics"].get("pb") or {}
        h = x.get("hist")
        sm = med.get("pb") or {}
        rows.append([tip("Price / book", "pb") + ' <span class="il-meta">(context)</span>', f_x(v(x.get("current"))),
                     f_ord(h["expensive_pct"]) if h else NA, f'{f_x(h["min"])} · {f_x(h["median"])} · {f_x(h["max"])}' if h else NA,
                     f'{f_x(sm["median"])} <span class="il-meta">(n={sm["n"]})</span>' if sm else NA, src_cell(x.get("current"))])
    md(table(["Multiple", "Current", tip("10Y pctile", "valuation_pct"), "10Y min · median · max", "Sector median", "Source"],
             rows, num_cols=(1,), src_col=5))
    vp = val["valuation_pct"]
    md(f'<div class="il-note" style="margin-top:.6rem">Composite valuation percentile: <b>{f_ord(v(vp))}</b> '
       f'({esc(vp.get("note") or "")}). Percentiles are point-in-time: each month uses only financials already filed. '
       f'For FCF yield the percentile is inverted so that higher always means more expensive.</div>')
    if val.get("share_basis") and "weighted" in val["share_basis"]:
        md(f'<div class="il-meta">Share count basis: {esc(val["share_basis"])}.</div>')

    c1, c2 = st.columns(2)
    with c1:
        md(f'<div class="il-label">{tip("Fair value range (12-month)", text=val["fair_value"].get("note"))}</div>')
        fv = v(val["fair_value"])
        px = v(val["price"])
        if fv:
            rows = [[name, f_price(fv.get(k)), f_pct(fv[k] / px - 1, 0, True) if isnum(fv.get(k)) and px else NA, esc(how)]
                    for name, k, how in (
                        ("Bear", "bear", f"low EPS {f_num(fv.get('eps_low'), 2)} x {f_x(fv.get('pe_p25'))} (25th pct P/E)"),
                        ("Base", "base", f"mean EPS {f_num(fv.get('eps_avg'), 2)} x {f_x(fv.get('pe_median'))} (median P/E)"),
                        ("Bull", "bull", f"high EPS {f_num(fv.get('eps_high'), 2)} x {f_x(fv.get('pe_p75'))} (75th pct P/E)"))]
            md(table(["Case", "Value", "vs price", "Method"], rows, num_cols=(1, 2)))
            per_lbl = {"+1y": "Next fiscal year", "0y": "Current fiscal year"}.get(fv.get("eps_period"), "")
            md(f'<div class="il-meta" style="margin-top:6px">{per_lbl} consensus EPS from '
               f'{f_num(fv.get("analysts"), 0)} analysts · {src_cell(val["fair_value"])}</div>')
        else:
            md(f'<div class="il-note">{NA}: needs consensus EPS and at least 24 months of P/E history.</div>')
    with c2:
        md(f'<div class="il-label">{tip("Valuation zone", "zone")}</div>')
        z = v(val["zone"])
        px = v(val["price"])
        if z:
            gap = px / z["upper"] - 1 if px else None
            where = ("inside the zone" if px and px <= z["upper"] else f"{f_pct(gap, 0)} above the top of the zone") if px else ""
            md(f'<div style="font-size:22px;font-weight:500">{f_price(z["lower"])} – {f_price(z["upper"])}</div>'
               f'<div class="il-note" style="margin-top:.4rem">Cheapest 25% of the stock\'s own 10-year valuation history '
               f'(25th to 10th percentile) at current fundamentals. Price today is {where}.</div>'
               f'<div class="il-meta" style="margin-top:6px">{src_cell(val["zone"])}</div>')
        else:
            md(f'<div class="il-note">{NA}: not enough valuation history.</div>')
    score_breakdown(block)


# ─────────────────────────────── 2. fundamentals ───────────────────────────────

def fundamentals(m, block) -> None:
    f = m["fundamentals"]
    fin = m["valuation"]["is_financial"]
    section(2, "Fundamentals & revisions", "Is the business getting better or worse?", block["score"])
    per = f.get("eps_rev_period_label") or "FY"
    br = v(f["eps_breadth_30d"])
    rows = [
        [tip(f"EPS estimate ({per})", "eps_rev"), f_pct(v(f["eps_rev_30d"]), 1, True), f_pct(v(f["eps_rev_90d"]), 1, True),
         src_cell(f["eps_rev_90d"])],
        [tip("Revision breadth (up / down)", "breadth"),
         f'{br["up"]:.0f} / {br["down"]:.0f}' if br and br.get("up") is not None else NA,
         f'<span class="na" title="{esc(f["eps_breadth_90d"].get("note") or "")}">n/a</span>', src_cell(f["eps_breadth_30d"])],
        [tip(f"Revenue estimate ({per})", "rev_rev"), _with_note(f["rev_rev_30d"]), _with_note(f["rev_rev_90d"]),
         src_cell(f["rev_rev_90d"])],
    ]
    md('<div class="il-label">Consensus revisions</div>')
    md(table(["", "30 days", "90 days", "Source"], rows, num_cols=(1, 2), src_col=3))

    sp = v(f["surprises"]) or []
    md('<div class="il-label">Last two earnings</div>')
    if sp:
        rows = [[esc(s.get("quarter") or ""), f_num(s.get("estimate"), 2), f_num(s.get("actual"), 2),
                 f_pct(s.get("surprise"), 1, True), src_cell(f["surprises"]) if i == 0 else ""] for i, s in enumerate(sp)]
        md(table(["Quarter", "EPS estimate", "EPS actual", "Surprise", "Source"], rows, num_cols=(1, 2, 3), src_col=4))
        md('<div class="il-meta" style="margin-top:6px">Guidance changes are picked up by the headline monitor in block 5; '
           'the free data sources do not publish guidance figures.</div>')
    else:
        md(f'<div class="il-note">{NA}</div>')

    om = v(f["op_margin"]) or {}
    rows = [
        [tip("Operating margin (TTM)", text="Operating income / revenue, trailing 12 months."),
         f"{f_pct(om.get('now'))} <span class='il-meta'>vs {f_pct(om.get('1y_ago'))} 1y ago, {f_pct(om.get('2y_ago'))} 2y ago</span>"
         if om else NA, src_cell(f["op_margin"])],
        [tip("Return on equity", "roe"), f_pct(v(f["roe"])), src_cell(f["roe"])],
    ]
    if not fin:
        rows += [
            [tip("ROIC", "roic"), f_pct(v(f["roic"])), src_cell(f["roic"])],
            [tip("Cash conversion (CFO / net income)", "cash_conv"), f_x(v(f["cash_conversion"]), 2), src_cell(f["cash_conversion"])],
            [tip("Net debt / EBITDA", "nd_ebitda"), f_x(v(f["net_debt_ebitda"])), src_cell(f["net_debt_ebitda"])],
            [tip("Interest coverage", "int_cov"), f_x(v(f["interest_coverage"])), src_cell(f["interest_coverage"])],
        ]
    md('<div class="il-label">Quality and balance sheet</div>')
    md(table(["", "Value", "Source"], rows, num_cols=(1,), src_col=2))
    if fin:
        md('<div class="il-meta" style="margin-top:6px">ROIC, cash conversion and leverage ratios are not meaningful for '
           'banks and insurers and are omitted.</div>')

    dv = v(f["dividend"]) or {}
    rows = [
        [tip("Buyback yield", "buyback_yield"), f_pct(v(f["buyback_yield"])), src_cell(f["buyback_yield"])],
        ["Share count, 1-year change", f_pct(v(f["share_count_yoy"]), 1, True), src_cell(f["share_count_yoy"])],
        ["Dividend per share, trailing 12 months", f"${dv['ttm_dps']:.2f}" if isnum(dv.get("ttm_dps")) else NA, src_cell(f["dividend"])],
        ["Dividend growth, 1 year / 5-year CAGR", f"{f_pct(dv.get('growth_1y'), 1, True)} / {f_pct(dv.get('cagr_5y'), 1, True)}",
         src_cell(f["dividend"])],
    ]
    md('<div class="il-label">Capital return</div>')
    md(table(["", "Value", "Source"], rows, num_cols=(1,), src_col=2))
    score_breakdown(block)


def _with_note(d):
    if v(d) is None:
        return f'<span class="na" title="{esc(d.get("note") or "")}">n/a</span>'
    return f_pct(v(d), 1, True)


# ─────────────────────────────── 3. ownership ───────────────────────────────

def ownership(m, block) -> None:
    o = m["ownership"]
    section(3, "Ownership & positioning", "Who owns it and which way are they moving?", block["score"])
    f13 = v(o["f13_change"])
    si = v(o["short_interest"]) or {}
    ins = v(o["insiders"])
    rows = [
        [tip("13F shares held, QoQ (all filers)", "f13"),
         f'{f_pct(f13.get("shares_chg"), 1, True)} <span class="il-meta">{esc(f13["prior_period"])} → {esc(f13["period"])}</span>'
         if f13 else NA, src_cell(o["f13_change"])],
        ["13F holders (count, QoQ change)", f'{f13["holders"]:,} ({f_pct(f13.get("holders_chg"), 1, True)})' if f13 else NA,
         src_cell(o["f13_change"])],
        ["Institutional ownership", f_pct(v(o["inst_ownership_pct"]), 1), src_cell(o["inst_ownership_pct"])],
        [tip("Short interest (% float · days to cover)", "si"),
         f'{f_pct(si.get("pct_float"))} · {f_num(si.get("days_to_cover"), 1)} days '
         f'<span class="il-meta">({f_pct(si.get("chg_vs_prior"), 0, True)} vs prior)</span>' if si else NA,
         src_cell(o["short_interest"])],
        [tip("Insider cluster buying", "cluster"),
         ("Yes" if ins["cluster_buying"] else "No") + f' <span class="il-meta">{ins["buyers"]} buyer(s), {ins["sellers"]} seller(s), 90 days</span>'
         if ins else NA, src_cell(o["insiders"])],
    ]
    md(table(["", "Value", "Source"], rows, num_cols=(), src_col=2))
    if f13:
        md(f'<div class="il-meta" style="margin-top:6px">13F change is measured on a matched panel of {f13.get("panel_filers", 0):,} '
           f'managers that filed consistent reports in both quarters; {f13.get("excluded", 0)} implausible position(s) excluded. '
           'Top-holder data from Yahoo can be one quarter more recent than the SEC data set.</div>')
    else:
        md('<div class="il-meta" style="margin-top:6px">13F aggregate n/a: needs two quarterly SEC 13F data sets and a '
           'CUSIP match for this ticker (a new CUSIP after a corporate reorganization has no prior quarter).</div>')

    th = v(o["top_holders"])
    md(f'<div class="il-label">Top holders {src_cell(o["top_holders"])}</div>')
    if th:
        rows = [[esc(r["holder"] or ""), f_pct(r["pct_held"], 2), f_pct(r["pct_change"], 1, True), esc(r.get("reported") or "")]
                for r in th["rows"]]
        md(table(["Holder", "% held", "Position change", "Reported"], rows, num_cols=(1, 2)))
        md(f'<div class="il-meta" style="margin-top:6px">{th["adding"]} adding, {th["cutting"]} cutting (change beyond ±1%).</div>')
    else:
        md(f'<div class="il-note">{NA}</div>')

    md(f'<div class="il-label">Insider transactions, 90 days {src_cell(o["insiders"])}</div>')
    if ins and ins.get("recent"):
        rows = [[esc(t.get("date") or ""), esc(t.get("insider") or ""), esc(t.get("role") or ""),
                 "Buy" if t.get("code") == "P" else "Sell", f_num(t.get("shares"), 0), f_price(t.get("price")),
                 "10b5-1 plan" if t.get("plan_10b5_1") else "discretionary"] for t in ins["recent"]]
        md(table(["Date", "Insider", "Role", "Type", "Shares", "Price", "Basis"], rows, num_cols=(4, 5)))
        md(f'<div class="il-meta" style="margin-top:6px">{esc(ins.get("basis", ""))}. Sales under pre-arranged 10b5-1 plans '
           'carry little information and are not scored.</div>')
    else:
        md(f'<div class="il-note">No open-market insider trades in the last 90 days{"" if ins else " (n/a)"}.</div>')

    aa = v(o["analyst_actions"])
    pt = v(o["price_targets"]) or {}
    px = v(m["valuation"]["price"])
    md(f'<div class="il-label">Sell-side {src_cell(o["analyst_actions"])}</div>')
    if aa:
        md(f'<div class="il-note">Last 90 days: {aa["up"]} upgrades, {aa["down"]} downgrades, {aa["init"]} initiations; '
           f'price targets {aa["pt_raise"]} raised, {aa["pt_cut"]} cut. Mean target {f_price(pt.get("mean"))} '
           f'({f_pct(pt["mean"] / px - 1, 0, True) if isnum(pt.get("mean")) and px else "n/a"}), range '
           f'{f_price(pt.get("low"))}–{f_price(pt.get("high"))}.</div>')
        rows = [[esc(r["date"] or ""), esc(r["firm"] or ""), f'{esc(r["from"] or "–")} → {esc(r["to"] or "")}',
                 esc(r["action"] or ""), f'{f_price(r["pt_prior"])} → {f_price(r["pt"])}'] for r in aa["rows"]]
        md(table(["Date", "Firm", "Rating", "Action", "Price target"], rows))
    else:
        md(f'<div class="il-note">{NA}</div>')
    score_breakdown(block)


# ─────────────────────────────── 4. macro ───────────────────────────────

def macro_block(m, block) -> None:
    section(4, "Macro regime", "Is the environment a tailwind or a headwind?", block["score"])
    snap = meta().get("macro_snapshot") or {}
    items, cyc = snap.get("items") or {}, snap.get("cycle") or {}
    order = [("DFF", None), ("FED_PATH", "fed_path"), ("DGS2", None), ("DGS10", None), ("T10Y2Y", "curve"), ("T10Y3M", None),
             ("DTWEXBGS", None), ("BAMLH0A0HYM2", "hy"), ("BAMLC0A0CM", None), ("INDPRO", None), ("UNRATE", None)]
    rows = []
    for sid, tkey in order:
        it = items.get(sid)
        if not it:
            continue
        if it.get("unit") == "index":
            val, chg = f_num(it.get("v"), 1), (f'{it["chg_6m_pct"]:+.1f}%' if isnum(it.get("chg_6m_pct")) else NA)
        else:
            val = f'{it["v"]:.2f}%' if isnum(it.get("v")) and it.get("unit") == "%" else (
                f'{it["v"]:+.2f}pp' if isnum(it.get("v")) else NA)
            chg = f'{it["chg_6m"]:+.2f}pp' if isnum(it.get("chg_6m")) else ""
        label = tip(it["label"], tkey) if tkey else esc(it["label"])
        if sid == "FED_PATH":
            val += f' <span class="il-meta">{esc(it.get("read", ""))}</span>'
        rows.append([label, val, chg, src_cell({"src": it.get("src"), "asof": it.get("asof"), "lag": it.get("lag")})])
    md('<div class="il-label">Macro snapshot</div>')
    md(table(["", "Latest", "6-month change", "Source"], rows, num_cols=(1, 2), src_col=3))
    md('<div class="il-meta" style="margin-top:6px">ISM PMI is not available from free sources (FRED dropped it in 2016); '
       'industrial production is used as the activity gauge.</div>')

    phase = cyc.get("phase")
    pts = cyc.get("points") or {}
    md('<div class="il-label">Business cycle (rules-based)</div>')
    if phase:
        md(f'<div style="font-size:20px;font-weight:500">{esc(phase)} cycle</div>'
           f'<div class="il-note">Points: ' + " · ".join(f"{k} {pts.get(k, 0)}" for k in ("Early", "Mid", "Late", "Recession"))
           + f'. Institutions have historically overweighted {esc(", ".join(cyc.get("favored", [])))} in this phase and '
           f'underweighted {esc(", ".join(cyc.get("disfavored", [])))}.</div>'
           f'<div class="il-meta" style="margin-top:4px">Sector map: {esc(cyc.get("framework_source", ""))}.</div>')
        with st.expander("Cycle rules and which ones are met"):
            rows = []
            for p in ("Early", "Mid", "Late", "Recession"):
                for r in (cyc.get("rules") or {}).get(p, []):
                    rows.append([esc(p), esc(r["rule"]), "met" if r["met"] else '<span class="na">not met</span>', str(r["points"])])
            md(table(["Phase", "Rule", "Status", "Points"], rows, num_cols=(3,)))
            ind = cyc.get("indicators") or {}
            md('<div class="il-meta" style="margin-top:6px">' + " · ".join(f"{esc(k)} {v_:.2f}" for k, v_ in ind.items() if isnum(v_)) + "</div>")
    else:
        md(f'<div class="il-note">{NA}: macro series missing.</div>')

    mm = m["macro"]
    rel = v(mm["relative"]) or {}
    rows = [[p, f_pct((rel.get(p) or {}).get("stock"), 1, True), f_pct((rel.get(p) or {}).get("vs_sector"), 1, True),
             f_pct((rel.get(p) or {}).get("vs_spy"), 1, True)] for p in ("3m", "6m", "12m")]
    md(f'<div class="il-label">Relative performance (total return) {src_cell(mm["relative"])}</div>')
    md(table(["Period", "Stock", f"vs sector ({esc(mm.get('sector_etf') or 'n/a')})", "vs SPY"], rows, num_cols=(1, 2, 3)))
    score_breakdown(block)


# ─────────────────────────────── 5. catalysts ───────────────────────────────

def catalysts(m, block, vd) -> None:
    r = m["risk"]
    section(5, "Catalysts & risk", "What could move it, and how much size can it take?", block["score"])
    sizing = ((vd.get("plan") or {}).get("sizing") or {})
    rows = [
        ["Next earnings date", esc(v(r["next_earnings"]) or "n/a"), src_cell(r["next_earnings"])],
        [tip("Implied vol (30-day, ATM)", text=r["iv30"].get("note") or ""), f_pct(v(r["iv30"]), 0), src_cell(r["iv30"])],
        ["Realized vol (30 / 90 day)", f'{f_pct(v(r["hv30"]), 0)} / {f_pct(v(r["hv90"]), 0)}', src_cell(r["hv30"])],
        [tip("Implied / realized", "iv_hv"), f_x(v(r["iv_hv"]), 2), src_cell(r["iv_hv"])],
        [tip("Avg daily dollar volume", "adv"), f_money(v(r["adv_usd"])) + (
            f' <span class="il-meta">~{sizing["days_to_build"]:.1f} days to build the full position at 10% of ADV</span>'
            if isnum(sizing.get("days_to_build")) else ""), src_cell(r["adv_usd"])],
    ]
    md(table(["", "Value", "Source"], rows, num_cols=(), src_col=2))
    md('<div class="il-meta" style="margin-top:6px">Investor days, index rebalances and lockups are not covered by the free '
       'sources; watch company IR calendars and S&amp;P index announcements.</div>')

    heads = v(r["headlines"]) or []
    md(f'<div class="il-label">Recent headlines {src_cell(r["headlines"])}</div>')
    if heads:
        heads = sorted(heads, key=lambda h: (h["tag"] != "thesis-changing", -(int((h.get("date") or "0000-00-00").replace("-", "")))))[:5]
        rows = []
        for h in heads:
            arrow = {1: "▲", -1: "▼"}.get(h.get("polarity"), "")
            tag = (f'<b>Thesis-changing</b> <span class="il-meta">{esc(h["category"])} {arrow}</span>'
                   if h["tag"] == "thesis-changing" else '<span class="c-muted">Noise</span>')
            title = esc(h["title"])
            if h.get("url"):
                title = f'<a href="{esc(h["url"])}" target="_blank">{title}</a>'
            rows.append([esc(h.get("date") or ""), title, tag, f'<span class="il-meta">{esc(h.get("publisher") or "")}</span>'])
        md(table(["Date", "Headline", "Tag", "Source"], rows))
        md('<div class="il-meta" style="margin-top:6px">Tags come from a keyword rules classifier (guidance, management change, '
           'M&amp;A, investigations, accounting, rating changes, capital actions). ▲/▼ = direction words in the headline.</div>')
    else:
        md(f'<div class="il-note">{NA}</div>')
    score_breakdown(block)
