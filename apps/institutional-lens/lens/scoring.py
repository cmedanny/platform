"""Scoring engine: five 0-100 block scores from transparent rules, composite, stance, verdict.

Every block score is a weighted average of input scores. Each input maps a raw
value to 0-100 with a straight line between two anchor points (clamped), e.g.
"90-day EPS revision: -6% -> 10, +6% -> 90". Inputs with no data are left out
and the remaining weights are rescaled. A block needs at least 35% of its input
weight available, otherwise it is n/a. 50 = neutral; higher = more attractive.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import date

import numpy as np

from . import db, macro, metrics, thesis
from .config import CFG

log = logging.getLogger("lens.scoring")

BLOCKS = ["valuation", "fundamentals", "ownership", "macro", "catalysts"]
BLOCK_TITLES = {
    "valuation": "Valuation", "fundamentals": "Fundamentals & Revisions", "ownership": "Ownership & Positioning",
    "macro": "Macro Regime", "catalysts": "Catalysts & Risk",
}


def lin(x, x0, y0, x1, y1):
    """Straight line through (x0, y0) and (x1, y1), clamped to the range between y0 and y1."""
    if x is None:
        return None
    y = y0 + (x - x0) * (y1 - y0) / (x1 - x0)
    return float(max(min(y0, y1), min(max(y0, y1), y)))


def ordinal(x) -> str:
    n = int(round(x))
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def pct(x, nd=1):
    return "n/a" if x is None else f"{x * 100:+.{nd}f}%"


def inp(name, value, score, weight, rule, phrase=None):
    return {"name": name, "value": value, "score": None if score is None else round(score, 1), "weight": weight,
            "rule": rule, "phrase": phrase}


def block(inputs: list[dict], min_coverage: float = 0.35) -> dict:
    total = sum(i["weight"] for i in inputs)
    avail = [i for i in inputs if i["score"] is not None]
    w = sum(i["weight"] for i in avail)
    score = sum(i["score"] * i["weight"] for i in avail) / w if avail and total and w / total >= min_coverage else None
    return {"score": None if score is None else round(score, 1), "inputs": inputs,
            "coverage": f"{len(avail)} of {len(inputs)} inputs available"}


def v(d):
    return (d or {}).get("v")


# ─────────────────────────────── sector medians ───────────────────────────────

def sector_medians(all_metrics: dict[str, dict]) -> dict:
    acc: dict[str, dict[str, list]] = {}
    for m in all_metrics.values():
        vm = m["valuation"]["metrics"]
        for key in ("pe_fwd", "pe_ttm", "ev_ebitda", "fcf_yield", "pb"):
            x = v(vm.get(key, {}).get("current"))
            if x is None or (key != "fcf_yield" and x <= 0) or (key in ("pe_fwd", "pe_ttm") and x > 300):
                continue
            acc.setdefault(m["sector"], {}).setdefault(key, []).append(x)
    return {s: {k: {"median": float(np.median(xs)), "n": len(xs)} for k, xs in d.items() if len(xs) >= 5}
            for s, d in acc.items()}


# ─────────────────────────────── blocks ───────────────────────────────

def score_valuation(m: dict, med: dict) -> dict:
    val = m["valuation"]
    used = ["pb", "pe_ttm"] if val["is_financial"] else ["ev_ebitda", "pe_ttm", "fcf_yield"]
    vp = v(val["valuation_pct"])
    ins = [inp("Percentile vs own 10-year history", None if vp is None else ordinal(vp),
               None if vp is None else 100 - vp, 50, "score = 100 - percentile (cheapest ever = 100)",
               None if vp is None else f"valuation in the {ordinal(vp)} percentile of its own 10-year range")]
    prem = []
    for k in used + ["pe_fwd"]:
        cur = v(val["metrics"].get(k, {}).get("current"))
        sm = med.get(k, {}).get("median")
        if cur is None or not sm or (k != "fcf_yield" and cur <= 0):
            continue
        prem.append(sm / cur - 1 if k == "fcf_yield" else cur / sm - 1)
    p = float(np.mean(prem)) if prem else None
    ins.append(inp("Premium vs sector median", pct(p, 0), lin(p, -0.4, 85, 0.4, 15), 25,
                   "-40% discount -> 85, +40% premium -> 15",
                   None if p is None else f"a {abs(p) * 100:.0f}% {'premium' if p > 0 else 'discount'} to the sector median"))
    fv, px = v(val["fair_value"]), v(val["price"])
    up = fv["base"] / px - 1 if fv and px else None
    ins.append(inp("Upside to base-case fair value", pct(up, 0), lin(up, -0.25, 15, 0.25, 85), 25,
                   "-25% -> 15, +25% -> 85",
                   None if up is None else f"{up * 100:+.0f}% to base-case fair value"))
    return block(ins)


def score_fundamentals(m: dict) -> dict:
    f, fin = m["fundamentals"], m["valuation"]["is_financial"]
    per = f.get("eps_rev_period_label") or "FY"
    r90, r30 = v(f["eps_rev_90d"]), v(f["eps_rev_30d"])
    br = v(f["eps_breadth_30d"]) or {}
    ins = [
        inp(f"EPS revision, 90 days ({per})", pct(r90), lin(r90, -0.06, 10, 0.06, 90), 20, "-6% -> 10, +6% -> 90",
            None if r90 is None else f"{per} EPS revised {'up' if r90 >= 0 else 'down'} {abs(r90) * 100:.1f}% over 90 days"),
        inp(f"EPS revision, 30 days ({per})", pct(r30), lin(r30, -0.03, 15, 0.03, 85), 10, "-3% -> 15, +3% -> 85"),
        inp("Revision breadth, 30 days", f"{br.get('up', 0):.0f} up / {br.get('down', 0):.0f} down" if br else None,
            lin(br.get("net"), -1, 10, 1, 90), 15, "(up - down) / (up + down): -1 -> 10, +1 -> 90",
            None if br.get("net") is None else f"revision breadth of {br['up']:.0f} up vs {br['down']:.0f} down"),
    ]
    rr = v(f["rev_rev_90d"]) if v(f["rev_rev_90d"]) is not None else v(f["rev_rev_30d"])
    ins.append(inp("Revenue estimate revision", pct(rr), lin(rr, -0.04, 15, 0.04, 85), 10, "-4% -> 15, +4% -> 85"))
    sp = [s["surprise"] for s in (v(f["surprises"]) or []) if s.get("surprise") is not None]
    avg_s = float(np.mean(sp)) if sp else None
    ins.append(inp("Last two EPS surprises (avg)", pct(avg_s), lin(avg_s, -0.05, 15, 0.05, 85), 10, "-5% -> 15, +5% -> 85",
                   None if avg_s is None else f"an average {abs(avg_s) * 100:.1f}% EPS {'beat' if avg_s >= 0 else 'miss'} over the last two quarters"))
    om = v(f["op_margin"]) or {}
    dm = om["now"] - om["1y_ago"] if om.get("now") is not None and om.get("1y_ago") is not None else None
    ins.append(inp("Operating margin change, 1 year", None if dm is None else f"{dm * 1e4:+.0f} bp",
                   None if fin else lin(dm, -0.03, 15, 0.03, 85), 10, "-300bp -> 15, +300bp -> 85",
                   None if dm is None or fin else f"operating margin {'up' if dm >= 0 else 'down'} {abs(dm) * 1e4:.0f}bp year on year"))
    if fin:
        roe = v(f["roe"])
        ins.append(inp("Return on equity", pct(roe), lin(roe, 0.06, 20, 0.18, 85), 10, "6% -> 20, 18% -> 85",
                       None if roe is None else f"ROE of {roe * 100:.0f}%"))
    else:
        roic = v(f["roic"])
        ins.append(inp("ROIC", pct(roic), lin(roic, 0.04, 20, 0.20, 90), 10, "4% -> 20, 20% -> 90",
                       None if roic is None else f"ROIC of {roic * 100:.0f}%"))
        cc = v(f["cash_conversion"])
        ins.append(inp("Cash conversion (CFO / net income)", None if cc is None else f"{cc:.2f}x",
                       lin(cc, 0.6, 15, 1.2, 85), 8, "0.6x -> 15, 1.2x -> 85",
                       None if cc is None else ("cash conversion of %.2fx" % cc)))
        nd = v(f["net_debt_ebitda"])
        ins.append(inp("Net debt / EBITDA", None if nd is None else f"{nd:.1f}x", lin(nd, 4, 10, 0, 85), 7,
                       "4.0x -> 10, 0x (net cash) -> 85", None if nd is None else f"net debt/EBITDA of {nd:.1f}x"))
        ic = v(f["interest_coverage"])
        ins.append(inp("Interest coverage", None if ic is None else f"{ic:.1f}x", lin(ic, 2, 15, 12, 90), 5,
                       "2x -> 15, 12x -> 90"))
    sc = v(f["share_count_yoy"])
    ins.append(inp("Share count change, 1 year", pct(sc), lin(sc, 0.03, 20, -0.03, 85), 5,
                   "+3% (dilution) -> 20, -3% (buybacks) -> 85",
                   None if sc is None else f"share count {'down' if sc < 0 else 'up'} {abs(sc) * 100:.1f}% in a year"))
    return block(ins)


def score_ownership(m: dict) -> dict:
    o = m["ownership"]
    f13 = v(o["f13_change"]) or {}
    th = v(o["top_holders"]) or {}
    ins = [
        inp("13F shares held, QoQ (all filers)", pct(f13.get("shares_chg")), lin(f13.get("shares_chg"), -0.04, 15, 0.04, 85),
            25, "-4% -> 15, +4% -> 85",
            None if f13.get("shares_chg") is None else
            f"13F holders {'adding' if f13['shares_chg'] >= 0 else 'cutting'} {abs(f13['shares_chg']) * 100:.1f}% QoQ"),
        inp("13F holder count, QoQ", pct(f13.get("holders_chg")), lin(f13.get("holders_chg"), -0.03, 20, 0.03, 80), 5,
            "-3% -> 20, +3% -> 80"),
    ]
    net = None
    if th and (th.get("adding", 0) + th.get("cutting", 0)) > 0:
        net = (th["adding"] - th["cutting"]) / (th["adding"] + th["cutting"])
    ins.append(inp("Top-10 holders adding vs cutting", f"{th.get('adding', 0)} adding / {th.get('cutting', 0)} cutting" if th else None,
                   lin(net, -1, 20, 1, 80), 15, "all cutting -> 20, all adding -> 80",
                   None if net is None else f"{th['adding']} of the top 10 holders adding vs {th['cutting']} cutting"))
    ins_d = v(o["insiders"])
    s_ins, val_ins, phrase = None, None, None
    if ins_d:
        if ins_d["cluster_buying"]:
            s_ins, phrase = 90, f"cluster buying by {ins_d['buyers']} insiders"
        elif ins_d["buyers"]:
            s_ins, phrase = 70, f"open-market buying by {ins_d['buyers']} insider(s)"
        else:
            # SEC basis: only discretionary sales count (10b5-1 plan sales are pre-scheduled noise).
            sells = ins_d["discretionary_sell_value"] if ins_d.get("discretionary_sell_value") is not None \
                else ins_d.get("sell_value")
            if (sells or 0) > 0:
                s_ins = 42
        val_ins = f"{ins_d['buyers']} buyers / {ins_d['sellers']} sellers (90d)"
    ins.append(inp("Insider open-market activity", val_ins, s_ins, 20,
                   "cluster buying (3+ insiders) -> 90, any buying -> 70, discretionary selling only -> 42; no trades or 10b5-1 plan sales only -> not scored", phrase))
    si = v(o["short_interest"]) or {}
    s_si = lin(si.get("pct_float"), 0.12, 15, 0.01, 70)
    if s_si is not None and (si.get("chg_vs_prior") or 0) > 0.15:
        s_si = max(0, s_si - 10)
    ins.append(inp("Short interest", None if si.get("pct_float") is None else
                   f"{si['pct_float'] * 100:.1f}% of float, {si.get('days_to_cover') or 0:.1f} days to cover", s_si, 15,
                   "12% of float -> 15, 1% -> 70; -10 if up >15% vs prior month",
                   None if si.get("pct_float") is None or si["pct_float"] < 0.08 else f"short interest at {si['pct_float'] * 100:.0f}% of float"))
    aa = v(o["analyst_actions"]) or {}
    tot = aa.get("up", 0) + aa.get("down", 0) + aa.get("pt_raise", 0) + aa.get("pt_cut", 0)
    net_a = (aa.get("up", 0) + aa.get("pt_raise", 0) - aa.get("down", 0) - aa.get("pt_cut", 0)) / tot if tot >= 2 else None
    ins.append(inp("Sell-side actions, 90 days", f"{aa.get('up', 0)} up / {aa.get('down', 0)} down, "
                   f"PT {aa.get('pt_raise', 0)} raised / {aa.get('pt_cut', 0)} cut" if aa else None,
                   lin(net_a, -1, 15, 1, 85), 20, "net (upgrades + PT raises - downgrades - PT cuts) / total; needs 2+ actions",
                   None if net_a is None else f"sell-side actions running {'positive' if net_a > 0 else 'negative'} "
                   f"({aa.get('pt_raise', 0)} target raises, {aa.get('pt_cut', 0)} cuts)"))
    return block(ins)


def score_macro(m: dict, cycle: dict) -> dict:
    sector = m["sector"]
    phase = cycle.get("phase")
    fit = None
    if phase:
        fit = 80 if sector in cycle.get("favored", []) else 20 if sector in cycle.get("disfavored", []) else 50
    rel = v(m["macro"]["relative"]) or {}

    def avg(key):
        xs = [rel.get(p, {}).get(key) for p in ("6m", "12m")]
        xs = [x for x in xs if x is not None]
        return float(np.mean(xs)) if xs else None

    vs_sec, vs_spy = avg("vs_sector"), avg("vs_spy")
    label = {80: "favored", 20: "out of favor", 50: "neutral"}.get(fit)
    return block([
        inp(f"Sector fit with {phase or 'n/a'}-cycle phase", f"{sector}: {label}" if fit is not None else None, fit, 40,
            "historically favored sector -> 80, neutral -> 50, disfavored -> 20",
            None if fit is None else f"{sector} {label} in a {phase.lower()}-cycle backdrop"),
        inp("Relative return vs sector ETF (6m/12m avg)", pct(vs_sec, 0), lin(vs_sec, -0.15, 20, 0.15, 80), 30,
            "-15% -> 20, +15% -> 80",
            None if vs_sec is None else f"{'out' if vs_sec >= 0 else 'under'}performing its sector by {abs(vs_sec) * 100:.0f}%"),
        inp("Relative return vs SPY (6m/12m avg)", pct(vs_spy, 0), lin(vs_spy, -0.15, 20, 0.15, 80), 30,
            "-15% -> 20, +15% -> 80"),
    ], min_coverage=0.5)  # sector fit alone is not a stock-level view


def score_catalysts(m: dict) -> dict:
    r = m["risk"]
    ivhv = v(r["iv_hv"])
    heads = v(r["headlines"]) or []
    cutoff = date.fromordinal(date.today().toordinal() - 30).isoformat()
    tc = [h for h in heads if h["tag"] == "thesis-changing" and (h.get("date") or "") >= cutoff]
    pol = sum(h["polarity"] for h in tc)
    s_head = (55 if not tc else lin(pol, -2, 15, 2, 80)) if heads else None
    adv = v(r["adv_usd"])
    nxt = v(r["next_earnings"])
    days = (date.fromisoformat(nxt) - date.today()).days if nxt else None
    return block([
        inp("Implied vs realized volatility", None if ivhv is None else f"{ivhv:.2f}x", lin(ivhv, 1.6, 20, 0.9, 70), 30,
            "IV/HV 1.6x (event priced) -> 20, 0.9x -> 70",
            None if ivhv is None or ivhv < 1.3 else f"options pricing elevated event risk (IV/HV {ivhv:.1f}x)"),
        inp("Thesis-changing headlines, 30 days", f"{len(tc)} ({'+' if pol >= 0 else ''}{pol} net tone)" if heads else None,
            s_head, 35, "none -> 55; net tone -2 -> 15, +2 -> 80",
            None if not tc else f"{len(tc)} thesis-relevant headline(s) with {'positive' if pol > 0 else 'negative' if pol < 0 else 'mixed'} tone"),
        inp("Liquidity (avg daily $ volume)", None if adv is None else f"${adv / 1e6:,.0f}M",
            lin(math.log10(adv) if adv else None, 7.3, 25, 8.7, 80), 20, "$20M -> 25, $500M -> 80 (log scale)"),
        inp("Days to next earnings", None if days is None else str(days), None if days is None else (40 if days <= 10 else 55),
            15, "within 10 days -> 40 (binary event), otherwise 55"),
    ])


# ─────────────────────────────── stance & verdict ───────────────────────────────

def composite(scores: dict) -> tuple[float | None, int]:
    w = CFG["weights"]
    avail = {b: s["score"] for b, s in scores.items() if s["score"] is not None}
    tw = sum(float(w.get(b, 0)) for b in avail)
    if not avail or tw <= 0:
        return None, 0
    return round(sum(s * float(w.get(b, 0)) for b, s in avail.items()) / tw, 1), len(avail)


def stance_for(comp, n_scored, fund_score) -> tuple[str | None, str | None]:
    c = CFG["stance"]
    if comp is None or n_scored < c["min_blocks_scored"]:
        return None, f"fewer than {c['min_blocks_scored']} blocks have data"
    if comp >= c["accumulate_at_or_above"]:
        if fund_score is not None and fund_score < c["accumulate_requires_fundamentals_at_least"]:
            return "Hold", f"composite qualifies for Accumulate but Fundamentals & Revisions ({fund_score:.0f}) is below the {c['accumulate_requires_fundamentals_at_least']} floor"
        return "Accumulate", None
    if comp >= c["hold_at_or_above"]:
        return "Hold", None
    if comp >= c["reduce_at_or_above"]:
        return "Reduce", None
    return "Avoid", None


def confidence(stance, scores) -> dict:
    band = CFG["stance"]["agreement_band"]
    scored = {b: s["score"] for b, s in scores.items() if s["score"] is not None}
    if not stance:
        return {"agree": 0, "of": len(scored), "label": "n/a", "blocks": []}
    if stance == "Accumulate":
        agree = [b for b, s in scored.items() if s >= band]
    elif stance in ("Reduce", "Avoid"):
        agree = [b for b, s in scored.items() if s <= 100 - band]
    else:
        agree = [b for b, s in scored.items() if 100 - band < s < band]
    n = len(agree)
    label = "High" if n >= 4 else "Medium" if n == 3 else "Low"
    return {"agree": n, "of": len(scored), "label": label, "blocks": agree}


def build_plan(m: dict, stance: str | None) -> dict:
    p = CFG["position"]
    val, risk = m["valuation"], m["risk"]
    zone, px = v(val["zone"]), v(val["price"])
    hv = v(risk["hv90"])
    adv = v(risk["adv_usd"])
    scale = None
    if hv:
        scale = max(p["min_scale"], min(p["max_scale"], p["target_volatility"] / hv))
    full = p["base_weight_pct"] * scale if scale else None
    days = None
    if full and adv:
        days = p["portfolio_size_usd"] * full / 100 / (adv * p["max_adv_participation"])
    sizing = {"full_weight_pct": full, "scale": scale, "hv90": hv, "days_to_build": days,
              "rule": f"{p['base_weight_pct']}% base x (target vol {p['target_volatility'] * 100:.0f}% / 90-day vol), "
                      f"capped {p['min_scale']}-{p['max_scale']}x; days to build assume ${p['portfolio_size_usd'] / 1e9:.1f}B "
                      f"portfolio at {p['max_adv_participation'] * 100:.0f}% of ADV"}
    if not zone or not zone.get("upper"):
        return {"tranches": [], "sizing": sizing, "note": "n/a: not enough valuation history to define the zone"}
    tr = []
    for i, (key, pctile) in enumerate((("upper", 25), ("mid", 17.5), ("lower", 10)), 1):
        price = zone.get(key)
        tr.append({"n": i, "price": price, "pctile": pctile, "weight_pct": full / 3 if full else None,
                   "status": "executable now" if price and px and px <= price else "pending"})
    w = p["weeks_between_tranches"]
    if stance == "Accumulate":
        note = (f"Three equal tranches at the 25th, 17.5th and 10th valuation percentiles, at least {w} weeks apart. "
                "Never a single entry; add only while revisions hold.")
    elif stance == "Hold":
        note = f"No adds above ${zone['upper']:,.2f}. Tranche 1 only if price reaches the zone and revisions hold."
    elif stance == "Reduce":
        note = "No adds. Trim into strength; reassess if price enters the valuation zone and revisions turn up."
    else:
        note = "No position. Re-examine only if price enters the valuation zone and fundamentals stabilize."
    return {"tranches": tr, "sizing": sizing, "note": note, "zone": zone, "price": px}


def invalidation(m: dict, stance: str | None) -> list[str]:
    f, o = m["fundamentals"], m["ownership"]
    out = []
    bullish = stance in ("Accumulate", "Hold")
    r90 = v(f["eps_rev_90d"])
    per = f.get("eps_rev_period_label") or "FY"
    if bullish:
        out.append(f"{per} consensus EPS revisions turn negative over 90 days (now {pct(r90)})" if r90 is not None
                   else "Consensus EPS revisions turn negative over 90 days")
        br = v(f["eps_breadth_30d"])
        if br and br.get("up") is not None:
            out.append(f"Downward revisions outnumber upward over 30 days (now {br['up']:.0f} up / {br['down']:.0f} down)")
        out.append("Guidance cut or withdrawn (headline monitor flags it)")
        nd = v(f["net_debt_ebitda"])
        if nd is not None:
            out.append(f"Net debt / EBITDA rises above {max(3.0, nd + 1):.1f}x (now {nd:.1f}x)")
        om = v(f["op_margin"]) or {}
        if om.get("now") is not None:
            out.append("Operating margin falls more than 150bp year on year")
        if v(o["f13_change"]):
            out.append("13F holders cut positions for two consecutive quarters")
    else:
        out.append("View changes if: consensus EPS revisions turn positive over 90 days" + (f" (now {pct(r90)})" if r90 is not None else ""))
        out.append("View changes if: price enters the valuation zone with stable guidance")
        out.append("View changes if: insider cluster buying (3+ insiders in 90 days)")
    return out[:5]


def horizon(scores: dict) -> str:
    w = CFG["weights"]
    contrib = {b: (s["score"] - 50) * float(w.get(b, 0)) for b, s in scores.items() if s["score"] is not None}
    if not contrib:
        return "n/a"
    lead = max(contrib, key=lambda b: abs(contrib[b]))
    return {"valuation": "12-24 months (valuation mean reversion)",
            "fundamentals": "6-12 months (earnings revision cycle)",
            "ownership": "3-9 months (positioning shifts)",
            "macro": "6-12 months (cycle phase)",
            "catalysts": "3-6 months (event-driven)"}[lead]


# ─────────────────────────────── rebuild ───────────────────────────────

def rebuild_all(con) -> int:
    snap = macro.snapshot(con)
    db.set_meta(con, "macro_snapshot", snap)
    con.commit()
    tickers = [dict(r) for r in con.execute("SELECT * FROM tickers ORDER BY ticker")]
    all_m = {}
    for t in tickers:
        try:
            all_m[t["ticker"]] = metrics.compute(con, t)
        except Exception as exc:
            log.exception("metrics failed for %s: %s", t["ticker"], exc)
    meds = sector_medians(all_m)
    db.set_meta(con, "sector_medians", meds)
    llm = thesis.Ollama.maybe()
    n_llm = 0
    rows = []
    for tk, m in all_m.items():
        med = meds.get(m["sector"], {})
        scores = {
            "valuation": score_valuation(m, med),
            "fundamentals": score_fundamentals(m),
            "ownership": score_ownership(m),
            "macro": score_macro(m, snap["cycle"]),
            "catalysts": score_catalysts(m),
        }
        comp, n = composite(scores)
        if n < CFG["stance"]["min_blocks_scored"]:
            comp = None
        stance, stance_note = stance_for(comp, n, scores["fundamentals"]["score"])
        conf = confidence(stance, scores)
        fv, px = v(m["valuation"]["fair_value"]), v(m["valuation"]["price"])
        verdict = {
            "stance": stance, "stance_note": stance_note, "composite": comp, "confidence": conf,
            "base_upside": fv["base"] / px - 1 if fv and px else None,
            "bear_downside": fv["bear"] / px - 1 if fv and fv.get("bear") and px else None,
            "bull_upside": fv["bull"] / px - 1 if fv and fv.get("bull") and px else None,
            "plan": build_plan(m, stance), "invalidation": invalidation(m, stance), "horizon": horizon(scores),
        }
        verdict["thesis"] = thesis.template(m, scores, verdict)
        verdict["thesis_source"] = "rules template"
        if llm and stance and n_llm < CFG["ollama"]["max_per_run"]:
            s = llm.thesis(m, scores, verdict)
            n_llm += 1
            if s:
                verdict["thesis"], verdict["thesis_source"] = s, f"local model ({llm.model}) from computed data"
        f = scores["fundamentals"]["inputs"]
        rev_scores = [i["score"] for i in f[:3] if i["score"] is not None]
        rev = None if not rev_scores else ("Up" if np.mean(rev_scores) >= 60 else "Down" if np.mean(rev_scores) <= 40 else "Flat")
        os_ = scores["ownership"]["score"]
        ms = scores["macro"]["score"]
        scanner = {
            "ticker": tk, "name": m["name"], "sector": m["sector"], "price": px,
            "price_asof": m["valuation"]["price"]["asof"],
            "valuation_pct": v(m["valuation"]["valuation_pct"]),
            "revisions": rev,
            "ownership": None if os_ is None else "Accumulating" if os_ >= 58 else "Distributing" if os_ <= 42 else "Stable",
            "regime": None if ms is None else "Tailwind" if ms >= 58 else "Headwind" if ms <= 42 else "Neutral",
            "stance": stance, "composite": comp, "confidence": conf["label"],
            **{f"score_{b}": scores[b]["score"] for b in BLOCKS},
        }
        detail = {"metrics": m, "scores": scores, "verdict": verdict, "sector_medians": med}
        rows.append((tk, json.dumps(scanner, default=str), json.dumps(detail, default=str), db.now_iso()))
    with db.transaction(con):
        con.execute("DELETE FROM snapshot")
        con.executemany("INSERT INTO snapshot(ticker, scanner, detail, computed_at) VALUES (?,?,?,?)", rows)
        db.set_meta(con, "last_scored", db.now_iso())
    return len(rows)
