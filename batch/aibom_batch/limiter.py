"""Adaptive limit on concurrent LLM calls: as many as OpenRouter accepts without 429.

AIMD, like TCP congestion control:
- every `limit` successful calls raise the limit by one, up to the ceiling;
- a 429 halves the limit, pauses new calls for a cool-down (doubling while 429s keep coming) and
  lowers the ceiling to just under the level that caused it;
- the ceiling climbs back by one per quiet `recover_seconds`, up to the configured maximum.
"""
from __future__ import annotations

import threading
import time


class AdaptiveLimiter:
    def __init__(self, start: int, maximum: int, cooldown_seconds: float = 15.0,
                 max_cooldown_seconds: float = 180.0, recover_seconds: float = 300.0):
        self._maximum = max(1, maximum)
        self._limit = float(max(1, min(start, self._maximum)))
        self._ceiling = self._maximum
        self._cooldown = cooldown_seconds
        self._max_cooldown = max_cooldown_seconds
        self._recover = recover_seconds
        self._in_flight = 0
        self._credit = 0
        self._strikes = 0          # consecutive cuts without a success in between
        self._last_cut = 0.0       # calls started before this do not cut again
        self._resume_at = 0.0
        self._ceiling_at = 0.0
        self._priority_waiting = 0
        self.rate_limits = 0
        self._cond = threading.Condition()

    def set_maximum(self, maximum: int) -> None:
        with self._cond:
            raised = maximum > self._maximum
            self._maximum = max(1, maximum)
            self._ceiling = self._maximum if raised else min(self._ceiling, self._maximum)
            self._limit = min(self._limit, float(self._ceiling))
            self._cond.notify_all()

    def acquire(self, cancel: threading.Event, priority: bool = False) -> float | None:
        """Wait for a slot. Returns a token for `release`, or None when cancelled.

        `priority` callers (the merge of a model whose research is done) go first, so started
        models finish before new ones begin.
        """
        with self._cond:
            if priority:
                self._priority_waiting += 1
            try:
                while not cancel.is_set():
                    now = time.monotonic()
                    self._recover_ceiling(now)
                    if (now >= self._resume_at and self._in_flight < int(self._limit)
                            and (priority or not self._priority_waiting)):
                        self._in_flight += 1
                        return now
                    self._cond.wait(min(0.5, max(0.05, self._resume_at - now)))
                return None
            finally:
                if priority:
                    self._priority_waiting -= 1
                    self._cond.notify_all()

    def release(self, token: float, outcome: str) -> None:
        """`outcome`: "ok", "rate_limit", or anything else (no effect on the limit)."""
        with self._cond:
            now = time.monotonic()
            self._in_flight -= 1
            if outcome == "ok":
                if token >= self._last_cut:
                    self._strikes = 0
                self._credit += 1
                if self._credit >= int(self._limit):
                    self._credit = 0
                    self._limit = min(self._limit + 1, float(self._ceiling))
            elif outcome == "rate_limit":
                self.rate_limits += 1
                # Calls that were already running when the limit was cut fail together; count once.
                if token >= self._last_cut:
                    level = int(self._limit)
                    self._ceiling = max(1, min(self._ceiling, level - 1))
                    self._limit = float(max(1, level // 2))
                    self._credit = 0
                    self._strikes += 1
                    self._last_cut = self._ceiling_at = now
                    pause = min(self._max_cooldown, self._cooldown * 2 ** (self._strikes - 1))
                    self._resume_at = max(self._resume_at, now + pause)
            self._cond.notify_all()

    def _recover_ceiling(self, now: float) -> None:
        if self._ceiling < self._maximum and now - self._ceiling_at >= self._recover:
            self._ceiling += 1
            self._ceiling_at = now

    def snapshot(self) -> dict:
        with self._cond:
            return {
                "limit": int(self._limit),
                "ceiling": self._ceiling,
                "maximum": self._maximum,
                "inFlight": self._in_flight,
                "rateLimits": self.rate_limits,
                "cooldown": max(0.0, self._resume_at - time.monotonic()),
            }
