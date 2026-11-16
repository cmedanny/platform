"""Macro snapshot and rules-based business-cycle classification.

Phase rules (each satisfied rule = 1 point; most points wins; ties resolve in the
order Recession > Late > Early > Mid, i.e. the more defensive call):

Recession  - Unemployment trigger: 3-mo avg unemployment >= 0.5pp above its 12-mo low (Sahm rule) [2 pts]
           - Industrial production YoY below -1%
           - High-yield spread above 6.5% or widened more than 1.5pp in 6 months
Early      - Industrial production YoY below 2% but improving over 6 months
           - Yield curve (10Y-2Y) steepened more than 0.25pp in 6 months
           - High-yield spread tightened more than 0.5pp in 6 months
           - Unemployment elevated (Sahm gap > 0.3pp) but no longer rising (3-mo change <= 0)
Mid        - Industrial production YoY positive and not decelerating by more than 0.5pp over 6 months
           - Yield curve (10Y-2Y) above 0.5pp
           - High-yield spread below 4.5% and stable (6-mo change within +/-0.5pp)
           - Unemployment stable or falling (6-mo change <= 0.1pp)
Late       - Industrial production growth decelerating (6-mo change in YoY < 0) while YoY > -1%
           - Yield curve flat or inverted (10Y-2Y below 0.25pp)
           - High-yield spread widened more than 0.3pp in 6 months
           - Unemployment near cycle low (within 0.3pp of 24-mo low) and Sahm gap < 0.2pp

Sector leadership by phase follows Fidelity Investments' "The Business Cycle
Approach to Sector Investing" (historical relative performance, 1962-2016
study). Edit SECTOR_PHASE below to use a different framework.
"""
from __future__ import annotations

import pandas as pd

from . import db
from .data.fred import MACRO_SERIES

SECTOR_PHASE = {
    "Early": {"favored": ["Financials", "Real Estate", "Consumer Discretionary", "Industrials",
                          "Information Technology", "Materials"],
              "disfavored": ["Utilities", "Consumer Staples", "Health Care", "Energy", "Communication Services"]},
    "Mid": {"favored": ["Information Technology", "Communication Services"],
            "disfavored": ["Utilities", "Materials"]},
    "Late": {"favored": ["Energy", "Materials", "Health Care", "Consumer Staples", "Utilities"],
             "disfavored": ["Information Technology", "Consumer Discretionary", "Financials"]},
    "Recession": {"favored": ["Consumer Staples", "Utilities", "Health Care"],
                  "disfavored": ["Industrials", "Information Technology", "Real Estate", "Financials",
                                 "Consumer Discretionary"]},
}
SECTOR_PHASE_SOURCE = "Fidelity Investments, 'The Business Cycle Approach to Sector Investing'"


def load_series(con) -> dict[str, pd.Series]:
    out = {}
    for sid in MACRO_SERIES:
        rows = con.execute("SELECT date, value FROM macro WHERE series_id=? ORDER BY date", (sid,)).fetchall()
        if rows:
            s = pd.Series([r["value"] for r in rows], index=pd.to_datetime([r["date"] for r in rows]))
            out[sid] = s
    return out


def _at(s: pd.Series, when: pd.Timestamp):
    s = s[s.index <= when]
    return float(s.iloc[-1]) if len(s) else None


def _chg(s: pd.Series | None, months: int):
    if s is None or s.empty:
        return None
    last = s.index[-1]
    prev = _at(s, last - pd.DateOffset(months=months))
    return None if prev is None else float(s.iloc[-1]) - prev


def snapshot(con) -> dict:
    series = load_series(con)
    items = {}
    for sid, label in MACRO_SERIES.items():
        s = series.get(sid)
        meta = db.get_meta(con, f"macro_src:{sid}", {}) or {}
        if s is None or s.empty:
            items[sid] = {"label": label, "v": None, "asof": None, "src": f"FRED ({sid})", "lag": None}
            continue
        if sid == "INDPRO":
            yoy = s.pct_change(12) * 100
            yoy = yoy.dropna()
            items[sid] = {"label": "Industrial production, YoY %", "v": float(yoy.iloc[-1]),
                          "chg_6m": _chg(yoy, 6), "asof": yoy.index[-1].date().isoformat(), "unit": "%"}
        elif sid == "DTWEXBGS":
            prev = _at(s, s.index[-1] - pd.DateOffset(months=6))
            items[sid] = {"label": label, "v": float(s.iloc[-1]), "asof": s.index[-1].date().isoformat(),
                          "chg_6m_pct": (float(s.iloc[-1]) / prev - 1) * 100 if prev else None, "unit": "index"}
        else:
            items[sid] = {"label": label, "v": float(s.iloc[-1]), "chg_6m": _chg(s, 6),
                          "asof": s.index[-1].date().isoformat(), "unit": "%"}
        items[sid]["src"] = meta.get("source", f"FRED ({sid})")
        items[sid]["lag"] = meta.get("lag")
    # Market-implied policy path proxy: 2Y yield vs fed funds.
    if items.get("DGS2", {}).get("v") is not None and items.get("DFF", {}).get("v") is not None:
        gap = items["DGS2"]["v"] - items["DFF"]["v"]
        items["FED_PATH"] = {
            "label": "Market-implied Fed path (2Y minus fed funds)", "v": gap, "unit": "pp",
            "asof": min(items["DGS2"]["asof"], items["DFF"]["asof"]), "src": "FRED (DGS2, DFF), derived",
            "read": "cuts priced" if gap < -0.25 else "hikes priced" if gap > 0.25 else "on hold priced",
            "chg_6m": (items["DGS2"]["chg_6m"] - items["DFF"]["chg_6m"])
            if items["DGS2"].get("chg_6m") is not None and items["DFF"].get("chg_6m") is not None else None,
        }
    cycle = classify_cycle(series)
    return {"items": items, "cycle": cycle}


def classify_cycle(series: dict[str, pd.Series]) -> dict:
    ind = {}
    ip = series.get("INDPRO")
    if ip is not None and len(ip) > 30:
        yoy = (ip.pct_change(12) * 100).dropna()
        ind["ip_yoy"] = float(yoy.iloc[-1])
        ind["ip_yoy_6m_change"] = _chg(yoy, 6)
    curve = series.get("T10Y2Y")
    if curve is not None and len(curve):
        ind["curve"] = float(curve.iloc[-1])
        ind["curve_6m_change"] = _chg(curve, 6)
    hy = series.get("BAMLH0A0HYM2")
    if hy is not None and len(hy):
        ind["hy"] = float(hy.iloc[-1])
        ind["hy_6m_change"] = _chg(hy, 6)
    un = series.get("UNRATE")
    if un is not None and len(un) > 26:
        avg3 = un.rolling(3).mean().dropna()
        ind["unrate"] = float(un.iloc[-1])
        ind["sahm_gap"] = float(avg3.iloc[-1] - avg3.iloc[-13:-1].min())
        ind["unrate_3m_change"] = _chg(un, 3)
        ind["unrate_6m_change"] = _chg(un, 6)
        ind["unrate_vs_24m_low"] = float(un.iloc[-1] - un.iloc[-24:].min())

    def has(*keys):
        return all(ind.get(k) is not None for k in keys)

    rules = {"Recession": [], "Early": [], "Mid": [], "Late": []}

    def add(phase, label, cond, pts=1):
        rules[phase].append({"rule": label, "met": bool(cond), "points": pts if cond else 0})

    if has("sahm_gap"):
        add("Recession", "Sahm rule: 3-mo unemployment >= 0.5pp above 12-mo low", ind["sahm_gap"] >= 0.5, 2)
    if has("ip_yoy"):
        add("Recession", "Industrial production YoY < -1%", ind["ip_yoy"] < -1)
    if has("hy", "hy_6m_change"):
        add("Recession", "HY spread > 6.5% or +1.5pp in 6 mo", ind["hy"] > 6.5 or ind["hy_6m_change"] > 1.5)
    if has("ip_yoy", "ip_yoy_6m_change"):
        add("Early", "IP YoY < 2% and improving", ind["ip_yoy"] < 2 and ind["ip_yoy_6m_change"] > 0)
        add("Mid", "IP YoY > 0% and not decelerating > 0.5pp", ind["ip_yoy"] > 0 and ind["ip_yoy_6m_change"] >= -0.5)
        add("Late", "IP growth decelerating, YoY > -1%", ind["ip_yoy_6m_change"] < 0 and ind["ip_yoy"] > -1)
    if has("curve", "curve_6m_change"):
        add("Early", "Curve steepened > 0.25pp in 6 mo", ind["curve_6m_change"] > 0.25)
        add("Mid", "Curve (10Y-2Y) > 0.5pp", ind["curve"] > 0.5)
        add("Late", "Curve flat/inverted (< 0.25pp)", ind["curve"] < 0.25)
    if has("hy", "hy_6m_change"):
        add("Early", "HY spread tightened > 0.5pp in 6 mo", ind["hy_6m_change"] < -0.5)
        add("Mid", "HY spread < 4.5% and stable", ind["hy"] < 4.5 and abs(ind["hy_6m_change"]) <= 0.5)
        add("Late", "HY spread widened > 0.3pp in 6 mo", ind["hy_6m_change"] > 0.3)
    if has("sahm_gap", "unrate_3m_change", "unrate_6m_change", "unrate_vs_24m_low"):
        add("Early", "Unemployment elevated but no longer rising", ind["sahm_gap"] > 0.3 and ind["unrate_3m_change"] <= 0)
        add("Mid", "Unemployment stable/falling (6-mo chg <= 0.1pp)", ind["unrate_6m_change"] <= 0.1)
        add("Late", "Unemployment near cycle low", ind["unrate_vs_24m_low"] <= 0.3 and ind["sahm_gap"] < 0.2)

    points = {p: sum(r["points"] for r in rs) for p, rs in rules.items()}
    if not any(rules.values()):
        return {"phase": None, "points": points, "rules": rules, "indicators": ind}
    order = ["Recession", "Late", "Early", "Mid"]
    phase = max(order, key=lambda p: (points[p], -order.index(p)))
    return {"phase": phase, "points": points, "rules": rules, "indicators": ind,
            "favored": SECTOR_PHASE[phase]["favored"], "disfavored": SECTOR_PHASE[phase]["disfavored"],
            "framework_source": SECTOR_PHASE_SOURCE}
