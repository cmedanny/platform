"""One-sentence thesis: a rules template, optionally rewritten by a free local model (Ollama).

The model only sees the computed numbers below and is told not to add facts.
If Ollama is not installed or not running, the template is used.
"""
from __future__ import annotations

import json
import logging
import re

import requests

from .config import CFG

log = logging.getLogger("lens.thesis")


def _drivers(scores: dict):
    """Inputs ranked by how far they pull the composite from neutral."""
    w = CFG["weights"]
    items = []
    for b, blk in scores.items():
        for i in blk["inputs"]:
            if i["score"] is None or not i.get("phrase"):
                continue
            items.append(((i["score"] - 50) * i["weight"] * float(w.get(b, 0)), i["phrase"]))
    pos = [p for s, p in sorted(items, key=lambda x: -x[0]) if s > 0]
    neg = [p for s, p in sorted(items, key=lambda x: x[0]) if s < 0]
    return pos, neg


def template(m: dict, scores: dict, verdict: dict) -> str:
    stance = verdict.get("stance")
    if not stance:
        return "n/a: not enough data to form a view."
    pos, neg = _drivers(scores)
    if stance in ("Accumulate", "Hold"):
        lead = " and ".join(pos[:2]) or "no single dominant driver"
        tail = f"; the main offset is {neg[0]}" if neg else ""
        verb = "Supported by" if stance == "Accumulate" else "Balanced: supported by"
        s = f"{verb} {lead}{tail}."
    else:
        lead = " and ".join(neg[:2]) or "a weak composite across blocks"
        tail = f"; {pos[0]} is not enough to offset" if pos else ""
        s = f"Weighed down by {lead}{tail}."
    return s[0].upper() + s[1:]


class Ollama:
    def __init__(self, url: str, model: str):
        self.url, self.model = url.rstrip("/"), model

    @classmethod
    def maybe(cls):
        c = CFG["ollama"]
        if not c.get("enabled"):
            return None
        try:
            tags = requests.get(c["url"].rstrip("/") + "/api/tags", timeout=2).json()
        except Exception:
            return None
        names = [t.get("name", "") for t in tags.get("models", [])]
        if not names:
            log.info("Ollama is running but has no models; using template theses")
            return None
        model = c["model"] if any(n.startswith(c["model"]) for n in names) else names[0]
        log.info("Ollama found; writing theses with %s", model)
        return cls(c["url"], model)

    def thesis(self, m: dict, scores: dict, verdict: dict) -> str | None:
        facts = {
            "ticker": m["ticker"], "sector": m["sector"], "stance": verdict["stance"],
            "block_scores_0_100": {b: s["score"] for b, s in scores.items()},
            "base_case_upside": verdict.get("base_upside"), "bear_case_downside": verdict.get("bear_downside"),
            "inputs": [{"input": i["name"], "value": i["value"], "score": i["score"]}
                       for blk in scores.values() for i in blk["inputs"] if i["score"] is not None],
        }
        prompt = (
            "You are a buy-side equity analyst. Write ONE sentence (max 35 words) stating the investment thesis "
            f"behind the stance '{verdict['stance']}', using ONLY the data below. No hype, no adjectives like "
            "'exciting' or 'massive', no facts that are not in the data, no price predictions. "
            "Return only the sentence.\n\nDATA:\n" + json.dumps(facts, default=str)
        )
        try:
            r = requests.post(self.url + "/api/generate", json={"model": self.model, "prompt": prompt, "stream": False,
                                                                 "options": {"temperature": 0.2}}, timeout=90)
            text = (r.json().get("response") or "").strip().strip('"').strip()
        except Exception as exc:
            log.debug("Ollama failed: %s", exc)
            return None
        text = re.sub(r"\s+", " ", text)
        if not text or len(text.split()) > 45 or text.count(". ") > 1:
            return None
        return text
