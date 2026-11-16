"""Nightly updater entry point.

    python update.py                  full refresh of all ~500 tickers (1.5-3 hours)
    python update.py --tickers AAPL,MSFT,JPM   only these tickers (quick test)
    python update.py --stale 20       only tickers not refreshed in the last 20 hours (resume after a crash)
    python update.py --rescore        no downloads; rebuild scores after editing config.toml
"""
import argparse
import sys

from lens.updater import run, setup_logging


def main() -> int:
    p = argparse.ArgumentParser(description="Institutional Lens nightly updater")
    p.add_argument("--tickers", help="comma-separated tickers to refresh (default: all)")
    p.add_argument("--limit", type=int, help="refresh at most N tickers")
    p.add_argument("--stale", type=float, metavar="HOURS", help="skip tickers refreshed within HOURS")
    p.add_argument("--rescore", action="store_true", help="rebuild scores only, no downloads")
    p.add_argument("--skip-13f", action="store_true", help="skip the quarterly 13F data set check")
    p.add_argument("--skip-form4", action="store_true", help="skip SEC Form 4 insider filings")
    p.add_argument("--verbose", action="store_true")
    a = p.parse_args()
    setup_logging(a.verbose)
    return run(tickers=a.tickers.split(",") if a.tickers else None, limit=a.limit, skip_13f=a.skip_13f,
               skip_form4=a.skip_form4, rescore_only=a.rescore, stale_hours=a.stale)


if __name__ == "__main__":
    sys.exit(main())
