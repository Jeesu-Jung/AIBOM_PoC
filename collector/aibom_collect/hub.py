"""Hugging Face Hub access over plain HTTP (standard library only)."""
from __future__ import annotations

import http.client
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from typing import Iterator

DEFAULT_HUB_URL = "https://huggingface.co"
USER_AGENT = "aibom-collect"

_SEGMENT = r"[A-Za-z0-9][\w.\-]*"
MODEL_ID = re.compile(rf"{_SEGMENT}/[\w.\-]+")
_INPUT_ID = re.compile(rf"{_SEGMENT}(?:/[\w.\-]+)?")
_HUB_PREFIX = re.compile(r"^(?:https?://)?(?:www\.)?huggingface\.co/", re.IGNORECASE)
_NEXT_LINK = re.compile(r'<([^>]+)>;\s*rel="next"')


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
                 timeout: float = 60.0, stop: threading.Event | None = None):
        self.base_url = base_url.rstrip("/")
        self.attempts = max(1, attempts)
        self.backoff_seconds = backoff_seconds
        self.timeout = timeout
        self.stop = stop or threading.Event()

    def _get(self, url: str) -> tuple[bytes, object]:
        """GET with retries on 429, 5xx and network errors. Other HTTP errors fail at once."""
        if not url.startswith(self.base_url + "/"):
            raise HubError(f"예상하지 못한 주소입니다: {url}")
        last, status = "", None
        for attempt in range(1, self.attempts + 1):
            if self.stop.is_set():
                raise Cancelled()
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            delay = self.backoff_seconds * attempt
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return response.read(), response.headers
            except urllib.error.HTTPError as error:
                status = error.code
                error.close()
                if status != 429 and status < 500:
                    raise HubError(f"HTTP {status}", status) from None
                last = f"HTTP {status}"
                retry_after = (error.headers.get("Retry-After") or "") if error.headers else ""
                if retry_after.isdigit():
                    delay = min(float(retry_after), 120.0)
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError) as error:
                status, last = None, f"연결 오류 ({getattr(error, 'reason', None) or type(error).__name__})"
            if attempt < self.attempts and self.stop.wait(delay):
                raise Cancelled()
        raise HubError(f"{last}, {self.attempts}회 시도", status)

    def model_info(self, model_id: str) -> dict:
        data, _headers = self._get(f"{self.base_url}/api/models/{urllib.parse.quote(model_id)}")
        return json.loads(data)

    def iter_finetunes(self, root_id: str, page_size: int = 500) -> Iterator[list[dict]]:
        """Pages of models tagged `base_model:finetune:<root>`, most downloaded first."""
        query = urllib.parse.urlencode({"filter": f"base_model:finetune:{root_id}", "full": "true",
                                        "limit": str(page_size), "sort": "downloads", "direction": "-1"})
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
