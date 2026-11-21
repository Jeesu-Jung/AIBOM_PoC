"""Hugging Face Hub access over plain HTTP (standard library only)."""
from __future__ import annotations

import http.client
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Iterator

DEFAULT_HUB_URL = "https://huggingface.co"
USER_AGENT = "aibom-collect"

# Sort orders of the Hugging Face model list: key -> (label on the site, API sort, API direction)
SORTS = {
    "trending": ("Trending", "trendingScore", "-1"),
    "likes": ("Most likes", "likes", "-1"),
    "downloads": ("Most downloads", "downloads", "-1"),
    "created": ("Recently created", "createdAt", "-1"),
    "modified": ("Recently updated", "lastModified", "-1"),
    "most_params": ("Most parameters", "num_parameters", "-1"),
    "least_params": ("Least parameters", "num_parameters", "1"),
}
DEFAULT_SORT = "downloads"

_SEGMENT = r"[A-Za-z0-9][\w.\-]*"
MODEL_ID = re.compile(rf"{_SEGMENT}/[\w.\-]+")
_INPUT_ID = re.compile(rf"{_SEGMENT}(?:/[\w.\-]+)?")
_HUB_PREFIX = re.compile(r"^(?:https?://)?(?:www\.)?huggingface\.co/", re.IGNORECASE)
_NEXT_LINK = re.compile(r'<([^>]+)>;\s*rel="next"')
_RESET_IN = re.compile(r"\bt=(\d+)")  # `RateLimit: "resolvers";r=0;t=129`: seconds until the window resets
MAX_RATE_LIMIT_WAIT = 600.0


class HubError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class Cancelled(Exception):
    """The stop event was set while a request was pending."""


def parse_model_id(text: str) -> str:
    """`Qwen/Qwen2.5-7B` or a Hugging Face URL -> model id. Raises ValueError when it is neither."""
    value = text.strip().strip("`\"'").strip()
    if _HUB_PREFIX.match(value):
        path = _HUB_PREFIX.sub("", value).split("?")[0].split("#")[0]
        value = "/".join(path.strip("/").split("/")[:2])
    value = value.rstrip("/")
    if not _INPUT_ID.fullmatch(value):
        raise ValueError(f"모델 이름 형식이 아닙니다: {text.strip()!r} (예: Qwen/Qwen2.5-7B)")
    return value


class HubClient:
    def __init__(self, base_url: str = DEFAULT_HUB_URL, attempts: int = 5, backoff_seconds: float = 2.0,
                 timeout: float = 60.0, stop: threading.Event | None = None, rate_limit_waits: int = 6):
        self.base_url = base_url.rstrip("/")
        self.attempts = max(1, attempts)
        self.backoff_seconds = backoff_seconds
        self.timeout = timeout
        self.stop = stop or threading.Event()
        self.rate_limit_waits = max(1, rate_limit_waits)  # 429 answers waited out per request before giving up
        self.on_wait = None  # callable(reason, seconds): a request failed and will be tried again after a wait
        self._lock = threading.Lock()
        self._resume_at = 0.0     # no request starts before this (set by a 429, shared by every thread)
        self._in_flight = 0
        self._last_activity = time.monotonic()

    def silent_seconds(self) -> float:
        """How long requests have been pending without any answer from the hub (0 when none is pending)."""
        with self._lock:
            return time.monotonic() - self._last_activity if self._in_flight else 0.0

    def _rate_limit_delay(self, headers, count: int) -> float:
        """Seconds to wait after a 429: Retry-After, else the reset time of the RateLimit header, else a backoff."""
        retry_after = ((headers.get("Retry-After") or "") if headers else "").strip()
        reset = _RESET_IN.search((headers.get("RateLimit") or "") if headers else "")
        if retry_after.isdigit():
            seconds = float(retry_after)
        elif reset:
            seconds = float(reset.group(1))
        else:
            return min(60.0, self.backoff_seconds * 2 ** count)
        return min(seconds + 1.0, MAX_RATE_LIMIT_WAIT) if seconds else 0.0  # +1s: start after the reset, not on it

    def _notify(self, reason: str, delay: float) -> None:
        if self.on_wait:
            self.on_wait(reason, delay)

    def _get(self, url: str) -> tuple[bytes, object]:
        """GET with retries. A 429 pauses every request until the limit resets; 5xx, timeouts and network
        errors are retried `attempts` times. Other HTTP errors fail at once."""
        if not url.startswith(self.base_url + "/"):
            raise HubError(f"예상하지 못한 주소입니다: {url}")
        failures = rate_limits = 0
        while True:
            while True:  # wait while the hub is rate limiting us
                if self.stop.is_set():
                    raise Cancelled()
                with self._lock:
                    remaining = self._resume_at - time.monotonic()
                if remaining <= 0:
                    break
                if self.stop.wait(min(remaining, 0.5)):
                    raise Cancelled()
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with self._lock:
                if not self._in_flight:
                    self._last_activity = time.monotonic()
                self._in_flight += 1
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return response.read(), response.headers
            except urllib.error.HTTPError as error:
                status, headers = error.code, error.headers
                error.close()
                if status == 429:
                    rate_limits += 1
                    last = "HTTP 429 (요청 한도 초과)"
                    if rate_limits >= self.rate_limit_waits:
                        raise HubError(f"{last}, {rate_limits}회 기다렸지만 풀리지 않음", status) from None
                    delay = self._rate_limit_delay(headers, rate_limits)
                    with self._lock:
                        self._resume_at = max(self._resume_at, time.monotonic() + delay)
                    self._notify(last, delay)
                    continue
                if status < 500:
                    raise HubError(f"HTTP {status}", status) from None
                last = f"HTTP {status} (Hugging Face 서버 오류)"
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as error:
                status, cause = None, getattr(error, "reason", None) or error
                if isinstance(cause, TimeoutError):
                    last = f"응답 없음 ({self.timeout:.0f}초 시간 초과)"
                else:
                    last = f"연결 오류 ({cause if isinstance(cause, str) else type(cause).__name__})"
            finally:
                with self._lock:
                    self._in_flight -= 1
                    self._last_activity = time.monotonic()
            failures += 1
            if failures >= self.attempts:
                raise HubError(f"{last}, {failures}회 시도", status)
            delay = self.backoff_seconds * failures
            self._notify(last, delay)
            if self.stop.wait(delay):
                raise Cancelled()

    def model_info(self, model_id: str) -> dict:
        data, _headers = self._get(f"{self.base_url}/api/models/{urllib.parse.quote(model_id)}")
        return json.loads(data)

    def iter_finetunes(self, root_id: str, sort: str = DEFAULT_SORT, page_size: int = 500) -> Iterator[list[dict]]:
        """Pages of models tagged `base_model:finetune:<root>`, in the order of the chosen sort."""
        _label, api_sort, direction = SORTS[sort]
        query = urllib.parse.urlencode({"filter": f"base_model:finetune:{root_id}", "full": "true",
                                        "limit": str(page_size), "sort": api_sort, "direction": direction})
        url: str | None = f"{self.base_url}/api/models?{query}"
        while url:
            data, headers = self._get(url)
            page = json.loads(data)
            if not isinstance(page, list):
                raise HubError("모델 목록 응답 형식이 예상과 다릅니다.")
            yield page
            match = _NEXT_LINK.search(headers.get("Link") or "")
            url = match.group(1) if match and page else None

    def readme(self, model_id: str) -> bytes:
        data, _headers = self._get(f"{self.base_url}/{urllib.parse.quote(model_id)}/resolve/main/README.md")
        return data
