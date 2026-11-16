"""Loads config.toml and exposes app-wide paths and constants."""
from __future__ import annotations

import os
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.toml"
DATA_DIR = ROOT / "data"
LOG_DIR = ROOT / "logs"
CACHE_DIR = DATA_DIR / "cache"
DB_PATH = Path(os.environ.get("LENS_DB", DATA_DIR / "lens.db"))  # override for testing

for _d in (DATA_DIR, LOG_DIR, CACHE_DIR):
    _d.mkdir(parents=True, exist_ok=True)

DEFAULTS = {
    "keys": {"sec_user_agent": "Institutional Lens your.name@example.com", "fred_api_key": ""},
    "weights": {"valuation": 0.25, "fundamentals": 0.30, "ownership": 0.20, "macro": 0.10, "catalysts": 0.15},
    "stance": {
        "accumulate_at_or_above": 62, "hold_at_or_above": 48, "reduce_at_or_above": 40,
        "min_blocks_scored": 3, "accumulate_requires_fundamentals_at_least": 45, "agreement_band": 55,
    },
    "position": {
        "base_weight_pct": 2.0, "target_volatility": 0.25, "min_scale": 0.5, "max_scale": 1.5,
        "weeks_between_tranches": 3, "portfolio_size_usd": 1_000_000_000, "max_adv_participation": 0.10,
    },
    "updater": {
        "yahoo_pause_seconds": 0.6, "sec_pause_seconds": 0.15, "retries": 3,
        "form4_lookback_days": 120, "form4_max_filings": 25, "openfigi_min_13f_value_usd": 1_000_000_000,
    },
    "ollama": {"enabled": True, "url": "http://localhost:11434", "model": "llama3.1:8b", "max_per_run": 600},
}


def load_config() -> dict:
    cfg = {k: dict(v) for k, v in DEFAULTS.items()}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "rb") as f:
            user = tomllib.load(f)
        for section, values in user.items():
            if isinstance(values, dict):
                cfg.setdefault(section, {}).update(values)
    return cfg


CFG = load_config()

# GICS sector -> SPDR sector ETF (used for relative performance)
SECTOR_ETF = {
    "Communication Services": "XLC",
    "Consumer Discretionary": "XLY",
    "Consumer Staples": "XLP",
    "Energy": "XLE",
    "Financials": "XLF",
    "Health Care": "XLV",
    "Industrials": "XLI",
    "Information Technology": "XLK",
    "Materials": "XLB",
    "Real Estate": "XLRE",
    "Utilities": "XLU",
}
BENCHMARK = "SPY"
FINANCIAL_SECTORS = {"Financials"}
