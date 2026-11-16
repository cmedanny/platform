"""End-to-end self test against a throwaway database.

Runs the real updater (Wikipedia, FRED, SEC live) with Yahoo replaced by
tests/fake_yfinance.py, then checks the snapshot. Usage:

    LENS_DB=/tmp/lens_test.db python -m tests.selftest [--with-13f]
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
assert os.environ.get("LENS_DB"), "Set LENS_DB to a throwaway path so the real database is untouched"

from tests.fake_yfinance import FakeTicker  # noqa: E402
from lens.data import yahoo  # noqa: E402

_cache = {}


def fake_ticker(symbol):
    if symbol not in _cache:
        _cache.clear()
        _cache[symbol] = FakeTicker(symbol)
    return _cache[symbol]


yahoo._ticker = fake_ticker
yahoo._info = lambda s: fake_ticker(s).info
yahoo.clear_cache = lambda: None

from lens import db, updater  # noqa: E402
from lens.config import CFG  # noqa: E402

CFG["updater"]["openfigi_min_13f_value_usd"] = 150e9   # keep the CUSIP mapping small in tests
CFG["ollama"]["enabled"] = False

TICKERS = ["AAPL", "MSFT", "JPM", "XOM", "NEE", "BRK.B", "AMZN", "KO"]

if __name__ == "__main__":
    updater.setup_logging()
    rc = updater.run(tickers=TICKERS, skip_13f="--with-13f" not in sys.argv)
    con = db.connect()
    rows = con.execute("SELECT ticker, scanner FROM snapshot").fetchall()
    print(f"\nsnapshot rows: {len(rows)} (all constituents, most n/a)")
    for r in rows:
        s = json.loads(r["scanner"])
        if s["ticker"] in TICKERS:
            print({k: (round(v, 1) if isinstance(v, float) else v) for k, v in s.items() if k not in ("name",)})
    sys.exit(rc)
