"""Offline checks of the core calculations.  Run:  python -m tests.test_core"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lens.data.sec import _ttm_from_facts, compute_13f_change  # noqa: E402
from lens.headlines import classify  # noqa: E402
from lens.macro import classify_cycle  # noqa: E402
from lens.scoring import lin, stance_for  # noqa: E402


def fact(start, end, val, filed, form="10-Q"):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form}


def test_ttm():
    facts = [
        fact("2024-01-01", "2024-12-31", 400, "2025-02-01", "10-K"),
        fact("2024-01-01", "2024-06-30", 190, "2024-08-01"),
        fact("2025-01-01", "2025-06-30", 230, "2025-08-01"),
        fact("2025-04-01", "2025-06-30", 120, "2025-08-01"),  # 3-month quarter: must be ignored
    ]
    ttm = _ttm_from_facts(facts)
    assert ttm["2024-12-31"] == (400, "2025-02-01")
    assert ttm["2025-06-30"] == (440, "2025-08-01"), ttm  # 400 + 230 - 190


def test_13f_panel():
    prev = {"X": {"a": 100.0, "b": 50.0, "bad": 1.0, "late": 0.0}}
    cur = {"X": {"a": 102.0, "b": 49.0, "bad": 400.0, "new": 5.0, "late": 300.0}}
    prev_book = {"a": 1e9, "b": 1e9, "bad": 1e9, "new": 1e9, "late": 1e6}
    cur_book = {"a": 1e9, "b": 1e9, "bad": 1.1e9, "new": 1e9, "late": 1e9}  # "late" book jumped 1000x
    out = compute_13f_change(cur, prev, cur_book, prev_book)["X"]
    # "late" leaves the panel; "bad" (1 -> 400, large) is excluded; "new" counts as buying
    assert out["excluded_positions"] == 1, out
    assert abs(out["shares_chg"] - ((102 + 49 + 5) / 150 - 1)) < 1e-9, out


def test_headlines():
    assert classify("Acme raises full-year guidance")["polarity"] == 1
    assert classify("Acme cuts outlook on weak demand")["polarity"] == -1
    assert classify("SEC opens probe into Acme accounting")["tag"] == "thesis-changing"
    assert classify("3 stocks to buy before the Fed meeting")["tag"] == "noise"
    assert classify("Acme shares edge higher in early trade")["tag"] == "noise"


def test_cycle():
    idx = pd.date_range("2020-01-01", periods=72, freq="MS")
    s = {
        "INDPRO": pd.Series([100 * 1.002 ** i for i in range(72)], index=idx),
        "T10Y2Y": pd.Series([1.0] * 72, index=idx),
        "BAMLH0A0HYM2": pd.Series([3.5] * 72, index=idx),
        "UNRATE": pd.Series([4.0] * 72, index=idx),
    }
    assert classify_cycle(s)["phase"] == "Mid"
    s["UNRATE"] = pd.Series([4.0] * 66 + [4.3, 4.6, 4.9, 5.2, 5.5, 5.8], index=idx)
    s["BAMLH0A0HYM2"] = pd.Series([3.5] * 66 + [4, 5, 6, 7, 7.5, 8], index=idx)
    assert classify_cycle(s)["phase"] == "Recession"


def test_rules():
    assert lin(0.0, -0.06, 10, 0.06, 90) == 50
    assert lin(1.0, -0.06, 10, 0.06, 90) == 90
    assert stance_for(70, 5, 60)[0] == "Accumulate"
    assert stance_for(70, 5, 30)[0] == "Hold"        # fundamentals floor
    assert stance_for(70, 2, 60)[0] is None          # too few blocks
    assert stance_for(30, 5, 60)[0] == "Avoid"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok ", name)
