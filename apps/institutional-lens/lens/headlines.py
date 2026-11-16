"""Rules-based headline classifier: "thesis-changing" vs "noise".

A headline is thesis-changing when it matches an event type that can change
earnings power, capital structure or management, unless it is clearly
promotional/list content. Polarity (+1 / -1 / 0) comes from direction words.
Edit RULES to tune; every tag records which rule fired.
"""
from __future__ import annotations

import re

POS = r"\b(rais(e|es|ed|ing)|boost(s|ed)?|lift(s|ed)?|beat(s)?|tops|upgrad(e|es|ed)|approv(al|es|ed)|increas(e|es|ed)|record|accretive|wins?)\b"
NEG = (r"\b(cut(s|ting)?|lower(s|ed)?|slash(es|ed)?|withdraw(s|n)?|suspend(s|ed)?|miss(es|ed)?|downgrad(e|es|ed)|"
       r"probe|investigat(ion|es|ed)|lawsuit|sued|resign(s|ed)?|recall(s|ed)?|warn(s|ed|ing)?|weak(er|ness)?|restat(e|es|ed|ement)|"
       r"reject(s|ed)?|delay(s|ed)?|default(s|ed)?|bankrupt(cy)?|fraud|dilut(ive|ion)|halt(s|ed)?|fine[ds]?|penalt(y|ies))\b")

# (category, pattern, fixed polarity or None to infer from direction words)
RULES = [
    ("Guidance", r"\b(guidance|outlook|forecast|full[- ]year (view|target)s?)\b", None),
    ("Earnings vs consensus", r"\b(beat|beats|miss|misses|missed|tops|falls short)\b.*\b(estimate|estimates|expectations|consensus|views?)\b", None),
    ("Management change", r"\b(ceo|cfo|chief executive|chief financial|chairman|president)\b.*\b(resign|steps? down|stepping down|depart|exit|ousted|fired|retire|replace|successor|succeed|appoint|named|names|hires?)", None),
    ("M&A / portfolio", r"\b(acquir(e|es|ed|ing)|acquisition|merger|merge|buyout|takeover|to buy|agrees to buy|bid for|divest|spin[- ]?off|sell(s|ing)? (its )?(unit|division|business)|sale of)\b", 0),
    ("Investigation / legal", r"\b(investigation|probe|subpoena|sec charges|justice department|doj|ftc|antitrust|lawsuit|class action|indict|fraud|settle(s|d|ment)?)\b", -1),
    ("Accounting", r"\b(restat(e|es|ed|ement)|material weakness|auditor|accounting (error|irregularit)|delay(s|ed)? (its )?(10-k|10-q|annual report|filing))", -1),
    ("Rating change", r"\b(downgrad(e|es|ed)|upgrad(e|es|ed)|cut to (sell|underperform|underweight|neutral|hold)|raised to (buy|outperform|overweight))\b", None),
    ("Capital return", r"\b(dividend (cut|increase|hike|suspen)|(cuts?|suspends?|raises?|hikes?) (its |the )?dividend|special dividend|buyback|share repurchase)\b", None),
    ("Capital raise", r"\b(share offering|stock offering|secondary offering|equity raise|at-the-market offering|convertible (notes|offering))\b", -1),
    ("Credit / distress", r"\b(bankrupt|chapter 11|default|going concern|credit rating|downgraded by (moody|s&p|fitch))\b", None),
    ("Regulatory / product", r"\b(fda|approval|recall|ban(s|ned)?|tariff|sanction|export (curb|control|restriction|ban))\b", None),
    ("Activist / stake", r"\b(activist|proxy fight|board seats?|takes? (a )?stake|discloses? stake)\b", 0),
    ("Strike / disruption", r"\b(strike|walkout|outage|cyberattack|breach|explosion|shutdown)\b", -1),
]

NOISE = [
    r"\bstocks? to (buy|watch|sell)\b", r"\btop \d+\b", r"\bbest .{0,30}stocks?\b", r"\bshould you (buy|sell)\b",
    r"\bis (it|now) (a|the) (good )?time\b", r"\bbuy the dip\b", r"\b(motley fool|zacks rank)\b",
    r"\b\d+ (reasons|things)\b", r"\bmillionaire\b", r"\bunstoppable\b", r"\bprediction\b",
]


def classify(title: str) -> dict:
    t = (title or "").lower()
    if any(re.search(p, t) for p in NOISE):
        return {"tag": "noise", "category": "Promotional / list", "polarity": 0, "rule": "noise pattern"}
    for category, pattern, fixed in RULES:
        if re.search(pattern, t):
            if fixed is None:
                pos, neg = len(re.findall(POS, t)), len(re.findall(NEG, t))
                pol = 1 if pos > neg else -1 if neg > pos else 0
            else:
                pol = fixed
            return {"tag": "thesis-changing", "category": category, "polarity": pol, "rule": category}
    return {"tag": "noise", "category": "Other", "polarity": 0, "rule": "no event keyword"}
