"""SEC EDGAR: XBRL company financials, Form 4 insider filings, 13F holdings data sets.

All free. The SEC requires a User-Agent with contact details (set in config.toml)
and allows at most 10 requests per second.
"""
from __future__ import annotations

import csv
import io
import logging
import re
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta

from ..config import CACHE_DIR, CFG
from .base import DataUnavailable, Fetched, RateLimiter, http_get, http_post_json

log = logging.getLogger("lens.data.sec")
_limiter = RateLimiter(CFG["updater"]["sec_pause_seconds"])


def _headers() -> dict:
    return {"User-Agent": CFG["keys"]["sec_user_agent"], "Accept-Encoding": "gzip, deflate"}


def _get(url: str, **kw):
    return http_get(url, headers=_headers(), limiter=_limiter, **kw)


# ─────────────────────────────── XBRL financials ───────────────────────────────

# Concept -> XBRL tags tried in priority order (companies switch tags over the years).
DURATION_TAGS = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense",
                "SalesRevenueGoodsNet"],
    "operating_income": ["OperatingIncomeLoss"],
    "net_income": ["NetIncomeLoss", "ProfitLoss"],
    "pretax_income": ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
                      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
    "income_tax": ["IncomeTaxExpenseBenefit"],
    "d_and_a": ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet",
                "DepreciationAndAmortization", "Depreciation"],
    "cfo": ["NetCashProvidedByUsedInOperatingActivities",
            "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    "interest_expense": ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt"],
    "dividends_paid": ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
    "buybacks": ["PaymentsForRepurchaseOfCommonStock"],
}
INSTANT_TAGS = {
    "lt_debt_total": ["LongTermDebt", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities"],
    "lt_debt_noncurrent": ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"],
    "lt_debt_current": ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent", "DebtCurrent"],
    "short_term_borrowings": ["ShortTermBorrowings", "CommercialPaper"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue",
             "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    "short_term_investments": ["ShortTermInvestments", "MarketableSecuritiesCurrent",
                               "AvailableForSaleSecuritiesDebtSecuritiesCurrent"],
    "equity": ["StockholdersEquity",
               "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
}
VALID_FORMS = {"10-K", "10-Q", "10-K/A", "10-Q/A", "10-KT", "20-F", "40-F"}


def _d(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()


def _first_filed(facts: list[dict]) -> dict[tuple, tuple]:
    """Dedupe facts by (start, end), keeping the value as first filed (point-in-time)."""
    out: dict[tuple, tuple] = {}
    for f in facts:
        if f.get("form") not in VALID_FORMS:
            continue
        key = (f.get("start"), f["end"])
        if key not in out or f["filed"] < out[key][1]:
            out[key] = (float(f["val"]), f["filed"])
    return out


def _ttm_from_facts(facts: list[dict]) -> dict[str, tuple[float, str]]:
    """Trailing-twelve-month values keyed by period end: FY value, or prior FY + YTD - prior-year YTD."""
    dedup = _first_filed(facts)
    annual, ytd = [], []
    for (start, end), (val, filed) in dedup.items():
        if not start:
            continue
        dur = (_d(end) - _d(start)).days
        rec = (_d(start), _d(end), val, filed)
        if 350 <= dur <= 380:
            annual.append(rec)
        elif 80 <= dur <= 290:
            ytd.append(rec)
    ttm: dict[str, tuple[float, str]] = {}
    for s, e, v, filed in annual:
        ttm[e.isoformat()] = (v, filed)
    for s, e, v, filed in ytd:
        prior_fy = next((a for a in annual if abs((a[1] - (s - timedelta(days=1))).days) <= 7), None)
        if not prior_fy:
            continue  # this is a 3-month quarter that does not start the fiscal year
        dur = (e - s).days
        prior_ytd = next((y for y in ytd
                          if abs((y[1] - (e - timedelta(days=365))).days) <= 10
                          and abs((y[1] - y[0]).days - dur) <= 10
                          and abs((y[0] - prior_fy[0]).days) <= 7), None)
        if not prior_ytd:
            continue
        key = e.isoformat()
        if key not in ttm:
            ttm[key] = (prior_fy[2] + v - prior_ytd[2], filed)
    return ttm


def _instant_from_facts(facts: list[dict]) -> dict[str, tuple[float, str]]:
    out: dict[str, tuple[float, str]] = {}
    for f in facts:
        if f.get("form") not in VALID_FORMS or f.get("start"):
            continue
        e = f["end"]
        if e not in out or f["filed"] < out[e][1]:
            out[e] = (float(f["val"]), f["filed"])
    return out


def _merge_by_priority(series_list: list[dict]) -> dict:
    merged: dict = {}
    for s in reversed(series_list):  # lower priority first, then overwrite
        merged.update(s)
    return merged


# New holding companies (re-domiciles, reorganizations) start with a fresh CIK and no
# history; their predecessor's filings are merged in. Add more under
# [cik_predecessors] in config.toml, e.g.  "0002115436" = ["0000034088"]
CIK_PREDECESSORS = {
    "0002115436": ["0000034088"],  # ExxonMobil Holdings Corp <- Exxon Mobil Corp (2026 reorganization)
}


def _merge_facts(docs: list[dict], ns: str) -> dict:
    merged: dict = {}
    for js in docs:
        for tag, body in js.get("facts", {}).get(ns, {}).items():
            for unit, facts in body.get("units", {}).items():
                merged.setdefault(tag, {"units": {}})["units"].setdefault(unit, []).extend(facts)
    return merged


def get_company_financials(cik: str) -> Fetched:
    """XBRL company facts -> {'ttm': {concept: {end: (val, filed)}}, 'instant': {...}, 'shares': {...}}."""
    cik10 = str(cik).zfill(10)
    js = _get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik10}.json").json()
    preds = {**CIK_PREDECESSORS, **{str(k).zfill(10): [str(x).zfill(10) for x in v]
                                    for k, v in CFG.get("cik_predecessors", {}).items()}}
    docs = [js]
    for p in preds.get(cik10, []):
        try:
            docs.append(_get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{p}.json").json())
        except Exception as exc:
            log.warning("predecessor CIK %s failed: %s", p, exc)
    gaap = _merge_facts(docs, "us-gaap")
    dei = _merge_facts(docs, "dei")

    def units(tag: str, unit: str = "USD") -> list[dict]:
        return gaap.get(tag, {}).get("units", {}).get(unit, [])

    ttm = {c: _merge_by_priority([_ttm_from_facts(units(t)) for t in tags]) for c, tags in DURATION_TAGS.items()}
    inst = {c: _merge_by_priority([_instant_from_facts(units(t)) for t in tags]) for c, tags in INSTANT_TAGS.items()}

    # Shares outstanding from the cover page (sum across share classes on the same date).
    by_filing: dict[tuple, float] = defaultdict(float)
    for f in dei.get("EntityCommonStockSharesOutstanding", {}).get("units", {}).get("shares", []):
        by_filing[(f["end"], f.get("accn"))] += float(f["val"])  # one entry per share class
    shares: dict[str, float] = {}
    for (end, _accn), val in by_filing.items():
        shares[end] = max(shares.get(end, 0.0), val)

    all_ends = [e for c in ttm.values() for e in c]
    asof = max(all_ends) if all_ends else None
    if not asof:
        raise DataUnavailable(f"No usable XBRL financials for CIK {cik10}")

    # Some filers stopped tagging cover-page shares; fall back to weighted diluted shares.
    share_basis = "cover page shares outstanding"
    if not shares or max(shares) < (_d(asof) - timedelta(days=400)).isoformat():
        wavg: dict[str, float] = {}
        for tag in ("WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"):
            for f in gaap.get(tag, {}).get("units", {}).get("shares", []):
                if f.get("form") in VALID_FORMS:
                    wavg.setdefault(f["end"], float(f["val"]))
            if wavg:
                break
        if wavg:
            shares, share_basis = wavg, "weighted average diluted shares"
    return Fetched(
        {"ttm": ttm, "instant": inst, "shares": dict(shares), "share_basis": share_basis,
         "entity": js.get("entityName")},
        "SEC EDGAR XBRL company facts (10-K/10-Q)", asof,
        lag="reported with each 10-Q/10-K (up to ~40-90 days after quarter end)",
    )


# ─────────────────────────────── Form 4 insiders ───────────────────────────────

def _txt(node, path: str):
    el = node.find(path)
    return el.text.strip() if el is not None and el.text else None


def get_form4_transactions(cik: str, lookback_days: int | None = None, max_filings: int | None = None) -> Fetched:
    """Open-market and other insider transactions parsed from Form 4 XML filed in the lookback window."""
    lookback_days = lookback_days or CFG["updater"]["form4_lookback_days"]
    max_filings = max_filings or CFG["updater"]["form4_max_filings"]
    cik10 = str(cik).zfill(10)
    sub = _get(f"https://data.sec.gov/submissions/CIK{cik10}.json").json()
    recent = sub["filings"]["recent"]
    cutoff = (date.today() - timedelta(days=lookback_days)).isoformat()
    txns: list[dict] = []
    n = 0
    for i, form in enumerate(recent["form"]):
        if form != "4" or recent["filingDate"][i] < cutoff:
            continue
        if n >= max_filings:
            break
        n += 1
        acc = recent["accessionNumber"][i].replace("-", "")
        doc = recent["primaryDocument"][i].split("/")[-1]
        try:
            xml = _get(f"https://www.sec.gov/Archives/edgar/data/{int(cik10)}/{acc}/{doc}").text
            root = ET.fromstring(xml.encode())
        except Exception as exc:  # one bad filing should not drop the rest
            log.debug("Form 4 parse failed %s: %s", acc, exc)
            continue
        owner = _txt(root, "reportingOwner/reportingOwnerId/rptOwnerName")
        rel = root.find("reportingOwner/reportingOwnerRelationship")
        role = []
        if rel is not None:
            if _txt(rel, "isDirector") in ("1", "true"):
                role.append("Director")
            if _txt(rel, "isOfficer") in ("1", "true"):
                role.append(_txt(rel, "officerTitle") or "Officer")
            if _txt(rel, "isTenPercentOwner") in ("1", "true"):
                role.append("10% owner")
        plan = _txt(root, "aff10b5One") in ("1", "true")
        for t in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
            code = _txt(t, "transactionCoding/transactionCode")
            shares = _txt(t, "transactionAmounts/transactionShares/value")
            price = _txt(t, "transactionAmounts/transactionPricePerShare/value")
            txns.append({
                "date": _txt(t, "transactionDate/value"),
                "filed": recent["filingDate"][i],
                "insider": owner,
                "role": ", ".join(role) or "n/a",
                "code": code,                 # P = open-market purchase, S = open-market sale
                "acq_disp": _txt(t, "transactionAmounts/transactionAcquiredDisposedCode/value"),
                "shares": float(shares) if shares else None,
                "price": float(price) if price else None,
                "plan_10b5_1": plan,
            })
    asof = max((t["filed"] for t in txns), default=date.today().isoformat())
    return Fetched(txns, "SEC EDGAR Form 4 filings", asof, 
                   extra={"filings_read": n, "lookback_days": lookback_days})


# ─────────────────────────────── 13F data sets ───────────────────────────────

F13_PAGE = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"
_MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def list_13f_datasets() -> list[dict]:
    """Available quarterly 13F data sets with the report period each mainly covers."""
    html = _get(F13_PAGE).text
    out = []
    for href in sorted(set(re.findall(r'href="([^"]+form13f[^"]*\.zip)"', html))):
        m = re.search(r"(\d{2})([a-z]{3})(\d{4})-(\d{2})([a-z]{3})(\d{4})_form13f\.zip", href)
        if not m:
            continue
        start_month, start_year = _MONTHS[m.group(2)], int(m.group(3))
        if start_month not in (3, 6, 9, 12):
            continue
        # Filings made in a window starting in Mar/Jun/Sep/Dec mostly report that month's quarter-end.
        period_end = (date(start_year + (start_month == 12), (start_month % 12) + 1, 1) - timedelta(days=1))
        url = href if href.startswith("http") else "https://www.sec.gov" + href
        out.append({"url": url, "period": period_end.isoformat()})
    return sorted(out, key=lambda x: x["period"])


def _13f_zip(dataset_url: str):
    path = CACHE_DIR / dataset_url.rsplit("/", 1)[-1]
    if not path.exists():
        resp = _get(dataset_url, stream=True, timeout=600)
        tmp = path.with_suffix(".part")
        with open(tmp, "wb") as fh:
            for chunk in resp.iter_content(1 << 20):
                fh.write(chunk)
        tmp.replace(path)
    return path


def get_13f_quarter(dataset_url: str, period: str, cusips: set[str] | None = None) -> Fetched:
    """One pass over a quarterly SEC 13F data set (original 13F-HR filings for `period`, common shares, no options).

    Returns {"aggregate": {cusip: {issuer, shares, value, holders}}, "filers": set of filer CIKs,
             "positions": {cusip: {cik: shares}}  (only for the requested cusips)}.
    """
    path = _13f_zip(dataset_url)
    period_tag = datetime.strptime(period, "%Y-%m-%d").strftime("%d-%b-%Y").upper()
    agg: dict[str, dict] = {}
    positions: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    book: dict[str, float] = defaultdict(float)   # each manager's total reported value
    with zipfile.ZipFile(path) as z:
        with z.open("SUBMISSION.tsv") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace"), delimiter="\t")
            accns = {r["ACCESSION_NUMBER"]: r["CIK"] for r in reader
                     if r["SUBMISSIONTYPE"] == "13F-HR" and r["PERIODOFREPORT"] == period_tag}
        with z.open("INFOTABLE.tsv") as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", errors="replace"), delimiter="\t",
                                    quoting=csv.QUOTE_NONE)
            for r in reader:
                cik = accns.get(r["ACCESSION_NUMBER"])
                if cik is None or r.get("PUTCALL") or r.get("SSHPRNAMTTYPE") != "SH":
                    continue
                cusip = (r.get("CUSIP") or "").strip().upper()
                if len(cusip) != 9:
                    continue
                try:
                    shares, value = float(r["SSHPRNAMT"]), float(r["VALUE"])
                except (TypeError, ValueError):
                    continue
                a = agg.setdefault(cusip, {"issuer": r.get("NAMEOFISSUER"), "shares": 0.0, "value": 0.0, "filers": set()})
                a["shares"] += shares
                a["value"] += value
                a["filers"].add(cik)
                book[cik] += value
                if cusips is not None and cusip in cusips:
                    positions[cusip][cik] += shares
    for a in agg.values():
        a["holders"] = len(a.pop("filers"))
    return Fetched({"aggregate": agg, "filers": set(accns.values()), "book": dict(book),
                    "positions": {c: dict(p) for c, p in positions.items()}},
                   "SEC Form 13F data sets", period,
                   lag="13F is filed up to 45 days after quarter end; SEC publishes the data set after that")


def compute_13f_change(cur: dict, prev: dict, cur_book: dict, prev_book: dict) -> dict:
    """Quarter-over-quarter change in 13F ownership per CUSIP, robust to bad filings.

    1. Matched panel: only managers that filed in BOTH quarters AND whose total reported
       book is within 0.5x-2x of last quarter's. Late, partial or restructured filings
       (common in the raw data) would otherwise read as huge buying or selling.
       New positions and full exits by panel managers still count.
    2. Position guard: a single manager's position is dropped if it is at least 1% of the
       panel's holding and moved more than 5x (or appeared/vanished), which in practice
       is almost always a unit or scope error rather than a trade.
    """
    panel = {k for k in set(cur_book) & set(prev_book)
             if prev_book[k] > 0 and 0.5 <= cur_book[k] / prev_book[k] <= 2.0}
    out = {}
    for cusip in set(cur) | set(prev):
        c = {k: x for k, x in cur.get(cusip, {}).items() if k in panel}
        p = {k: x for k, x in prev.get(cusip, {}).items() if k in panel}
        tc, tp = sum(c.values()), sum(p.values())
        base = max(tc, tp, 1.0)
        excluded = 0
        for cik in set(c) | set(p):
            a, b = c.get(cik, 0.0), p.get(cik, 0.0)
            lo, hi = min(a, b), max(a, b)
            if hi >= 0.01 * base and (lo == 0 or hi / lo > 5):
                tc, tp, excluded = tc - a, tp - b, excluded + 1
        hc = sum(1 for x in c.values() if x > 0)
        hp = sum(1 for x in p.values() if x > 0)
        out[cusip] = {
            "shares_cur": tc, "shares_prev": tp, "shares_chg": (tc / tp - 1) if tp > 0 else None,
            "holders_cur": sum(1 for x in cur.get(cusip, {}).values() if x > 0),
            "holders_panel_chg": (hc / hp - 1) if hp > 0 else None,
            "panel_filers": len(panel), "excluded_positions": excluded,
        }
    return out


def map_cusips_to_tickers(cusips: list[str]) -> Fetched:
    """CUSIP -> US ticker via the free OpenFIGI API (no key: 25 requests/min, 10 CUSIPs each)."""
    limiter = RateLimiter(2.6)
    out: dict[str, dict] = {}
    for i in range(0, len(cusips), 10):
        batch = cusips[i:i + 10]
        res = http_post_json("https://api.openfigi.com/v3/mapping",
                             [{"idType": "ID_CUSIP", "idValue": c, "exchCode": "US"} for c in batch], limiter=limiter)
        for c, item in zip(batch, res):
            rows = item.get("data") or []
            row = next((r for r in rows if r.get("marketSector") == "Equity"), rows[0] if rows else None)
            ticker = row.get("ticker").replace("/", ".") if row and row.get("ticker") else None
            out[c] = {"ticker": ticker, "name": row.get("name") if row else None}
    return Fetched(out, "OpenFIGI CUSIP mapping", date.today().isoformat())
