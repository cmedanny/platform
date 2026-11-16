"""Data layer: one function per data type.

To swap a free source for a licensed provider, replace the function here with
one that returns a `Fetched` holding the same data shape. Nothing else changes.

    Data type                         Function                              Source
    ────────────────────────────────  ────────────────────────────────────  ─────────────────────
    S&P 500 constituents              get_sp500_constituents()              Wikipedia
    Daily prices, dividends, splits   get_price_history(symbol)             yfinance
    Quote & market cap                get_quote(symbol)                     yfinance
    Valuation multiples (as reported) get_valuation_multiples(symbol)       yfinance
    Consensus EPS/revenue estimates   get_earnings_estimates(symbol)        yfinance
    EPS trend (7/30/60/90d ago)       get_eps_trend(symbol)                 yfinance
    EPS revision counts               get_eps_revisions(symbol)             yfinance
    Earnings surprises                get_earnings_history(symbol)          yfinance
    Next earnings date                get_earnings_calendar(symbol)         yfinance
    Analyst rating / target changes   get_analyst_rating_changes(symbol)    yfinance
    Price target consensus            get_price_targets(symbol)             yfinance
    Top institutional holders         get_institutional_holders(symbol)     yfinance (13F-based)
    Insider transactions (fallback)   get_insider_transactions_yahoo(sym)   yfinance
    Short interest                    get_short_interest(symbol)            yfinance (exchange data)
    Options implied volatility        get_options_implied_vol(symbol, px)   yfinance
    News headlines                    get_news(symbol)                      yfinance
    Company financials (history)      get_company_financials(cik)           SEC XBRL
    Insider Form 4 filings            get_form4_transactions(cik)           SEC EDGAR
    13F holdings, one quarter         get_13f_quarter(url, period, cusips)  SEC 13F data sets
    13F QoQ change (robust)           compute_13f_change(...)               derived
    13F data set catalogue            list_13f_datasets()                   SEC
    CUSIP -> ticker                   map_cusips_to_tickers(cusips)         OpenFIGI (free)
    Macro series                      get_macro_series(series_id)           FRED
"""
from .base import DataUnavailable, Fetched, with_retries  # noqa: F401
from .fred import MACRO_SERIES, get_macro_series  # noqa: F401
from .sec import (compute_13f_change, get_13f_quarter, get_company_financials, get_form4_transactions,  # noqa: F401
                  list_13f_datasets, map_cusips_to_tickers)
from .universe import get_sp500_constituents  # noqa: F401
from .yahoo import (get_analyst_rating_changes, get_earnings_calendar, get_earnings_estimates,  # noqa: F401
                    get_earnings_history, get_eps_revisions, get_eps_trend, get_institutional_holders,
                    get_insider_transactions_yahoo, get_news, get_options_implied_vol, get_price_history,
                    get_price_targets, get_quote, get_short_interest, get_valuation_multiples)
