"""Shared plumbing for the data layer: result type, rate limiting, retries."""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import requests

log = logging.getLogger("lens.data")


class DataUnavailable(Exception):
    """Raised when a source has no data for the request. Callers show n/a."""


@dataclass
class Fetched:
    """Every value the data layer returns carries where it came from and when it is as of."""
    data: Any
    source: str
    asof: str | None                 # ISO date the data describes (not when we downloaded it)
    lag: str | None = None           # human note if the data is structurally delayed
    extra: dict = field(default_factory=dict)


class RateLimiter:
    """Simple thread-safe minimum gap between calls."""

    def __init__(self, min_interval: float):
        self.min_interval = float(min_interval)
        self._last = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            gap = time.monotonic() - self._last
            if gap < self.min_interval:
                time.sleep(self.min_interval - gap)
            self._last = time.monotonic()


def with_retries(fn: Callable, *args, retries: int = 3, base_delay: float = 2.0, what: str = "", **kwargs):
    """Call fn with exponential backoff. DataUnavailable is not retried."""
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            return fn(*args, **kwargs)
        except DataUnavailable:
            raise
        except Exception as exc:  # network errors, rate limits, parse errors
            last_exc = exc
            msg = str(exc).lower()
            delay = base_delay * (2 ** (attempt - 1))
            if "rate" in msg and "limit" in msg or "too many requests" in msg or "429" in msg:
                delay = max(delay, 30.0 * attempt)
            if attempt < retries:
                log.warning("%s failed (attempt %d/%d): %s; retrying in %.0fs", what or fn.__name__, attempt, retries, exc, delay)
                time.sleep(delay)
    raise last_exc  # type: ignore[misc]


_session = requests.Session()


def http_get(url: str, *, headers: dict | None = None, params: dict | None = None,
             limiter: RateLimiter | None = None, timeout: int = 60, stream: bool = False) -> requests.Response:
    if limiter:
        limiter.wait()
    resp = _session.get(url, headers=headers, params=params, timeout=timeout, stream=stream)
    if resp.status_code == 404:
        raise DataUnavailable(f"404 for {url}")
    if resp.status_code == 429:
        raise RuntimeError(f"429 Too Many Requests: {url}")
    resp.raise_for_status()
    return resp


def http_post_json(url: str, payload, *, headers: dict | None = None, limiter: RateLimiter | None = None,
                   timeout: int = 60):
    if limiter:
        limiter.wait()
    h = {"Content-Type": "application/json", **(headers or {})}
    resp = _session.post(url, json=payload, headers=h, timeout=timeout)
    if resp.status_code == 429:
        raise RuntimeError("429 Too Many Requests")
    resp.raise_for_status()
    return resp.json()
