"""Client for the AIBOM admin API, standard library only.

Uses the same endpoints as the admin UI's "AI로 정보 채우기":
  GET  /api/v1/health
  GET  /api/v1/admin/research-runs?modelName=..&limit=1   (is there a merged result already?)
  POST /api/v1/admin/model-research/stream                (SSE; source = huggingface | paper)
  POST /api/v1/admin/model-research/merge/stream          (SSE)
  POST /api/v1/admin/model-research/results               (stores the run -> "검토 대기")
"""
from __future__ import annotations

import http.client
import json
import socket
import threading
from typing import Any, Callable
from urllib.parse import quote, urlsplit

API = "/api/v1"
DEFAULT_API_URL = "https://aibom.jeesu.io"
# DEFAULT_API_URL = "http://127.0.0.1:8000"  # 로컬 백엔드
# How an error is handled by the runner.
RATE_LIMIT = "rate_limit"  # OpenRouter 429: slow down, then try again
RETRY = "retry"            # temporary: try again a few times
OFFLINE = "offline"        # backend unreachable: wait for it to come back
FAIL = "fail"              # this model cannot succeed as requested
FATAL = "fatal"            # nothing can succeed (API key, credits, model config): stop the batch


class Cancelled(Exception):
    """The batch was stopped while the call was running."""


class ApiError(Exception):
    def __init__(self, message: str, kind: str = RETRY, status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


def _upstream_kind(status: Any, message: str) -> str:
    """Classify an SSE `error` event (the backend passes OpenRouter's status in `upstream.status`)."""
    if status == 429:
        return RATE_LIMIT
    if status in (401, 402, 404) or "OPENROUTER_API_KEY" in message:
        return FATAL
    if status in (400, 403, 413, 422):
        return FAIL
    return RETRY  # 408 / 5xx / timeouts / an answer that failed validation


class BackendClient:
    def __init__(self, base_url: str = DEFAULT_API_URL, stream_timeout: float = 360.0,
                 request_timeout: float = 60.0):
        parts = urlsplit(base_url if "://" in base_url else f"http://{base_url}")
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"잘못된 백엔드 주소입니다: {base_url}")
        self.base_url = base_url
        self._https = parts.scheme == "https"
        self._host = parts.hostname
        self._port = parts.port
        self._prefix = parts.path.rstrip("/")
        self._stream_timeout = stream_timeout
        self._request_timeout = request_timeout
        self._active: set[http.client.HTTPConnection] = set()
        self._lock = threading.Lock()

    # --- plumbing -------------------------------------------------------------------------------
    def _connection(self, timeout: float) -> http.client.HTTPConnection:
        factory = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
        conn = factory(self._host, self._port, timeout=timeout)
        with self._lock:
            self._active.add(conn)
        return conn

    def _close(self, conn: http.client.HTTPConnection, response: http.client.HTTPResponse | None = None) -> None:
        with self._lock:
            self._active.discard(conn)
        for closable in (response, conn):
            try:
                if closable is not None:
                    closable.close()
            except (OSError, ValueError):
                pass

    def abort(self) -> None:
        """Interrupt every running request (used when the batch is stopped)."""
        with self._lock:
            active = list(self._active)
        for conn in active:
            try:
                if conn.sock is not None:
                    conn.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def _open(self, conn: http.client.HTTPConnection, method: str, path: str, body: Any,
              accept: str) -> http.client.HTTPResponse:
        headers = {"Accept": accept}
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            conn.request(method, f"{self._prefix}{path}", body=data, headers=headers)
            response = conn.getresponse()
        except TimeoutError as error:
            raise ApiError(f"백엔드 응답 시간 초과: {method} {path}", RETRY) from error
        except (OSError, http.client.HTTPException) as error:
            raise ApiError(f"백엔드({self.base_url})에 연결할 수 없습니다: {error}", OFFLINE) from error
        if response.status >= 400:
            raise self._http_error(response)
        return response

    @staticmethod
    def _http_error(response: http.client.HTTPResponse) -> ApiError:
        text = response.read().decode("utf-8", "replace")
        try:
            detail = json.loads(text).get("detail")
        except (json.JSONDecodeError, AttributeError):
            detail = text.strip()[:500]
        if isinstance(detail, list):
            detail = " · ".join(str(item.get("msg", item)) if isinstance(item, dict) else str(item) for item in detail)
        kind = RETRY if response.status >= 500 else FAIL
        return ApiError(f"백엔드 HTTP {response.status}: {detail or '오류'}", kind, response.status)

    def _json(self, method: str, path: str, body: Any = None) -> Any:
        conn = self._connection(self._request_timeout)
        response = None
        try:
            response = self._open(conn, method, path, body, "application/json")
            return json.loads(response.read().decode("utf-8") or "null")
        except (OSError, http.client.HTTPException, json.JSONDecodeError) as error:
            raise ApiError(f"백엔드 응답을 읽지 못했습니다: {error}", RETRY) from error
        finally:
            self._close(conn, response)

    def _stream(self, path: str, body: Any, on_event: Callable[[str, dict], None] | None,
                cancel: threading.Event | None) -> dict:
        """POST and read the SSE stream until its `complete` event; returns that event's result."""
        def cancelled() -> bool:
            return cancel is not None and cancel.is_set()

        conn = self._connection(self._stream_timeout)
        response = None
        try:
            try:
                response = self._open(conn, "POST", path, body, "text/event-stream")
            except ApiError:
                if cancelled():
                    raise Cancelled() from None
                raise
            event, data_lines = "message", []
            while True:
                try:
                    raw = response.readline()
                except (OSError, http.client.HTTPException) as error:
                    if cancelled():
                        raise Cancelled() from None
                    reason = "응답 대기 시간 초과" if isinstance(error, TimeoutError) else f"연결이 끊어졌습니다 ({error})"
                    raise ApiError(f"조사 스트림 {reason}", RETRY) from error
                if cancelled():
                    raise Cancelled()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                if line.startswith("event:"):
                    event = line[6:].strip()
                elif line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
                elif not line:
                    if data_lines:
                        try:
                            data = json.loads("\n".join(data_lines))
                        except json.JSONDecodeError:
                            data = {}
                        if event == "complete" and isinstance(data.get("result"), dict):
                            return data["result"]
                        if event == "error":
                            message = str(data.get("message") or "모델 조사 중 오류가 발생했습니다.")
                            status = (data.get("upstream") or {}).get("status")
                            raise ApiError(message, _upstream_kind(status, message),
                                           status if isinstance(status, int) else None)
                        if on_event:
                            on_event(event, data if isinstance(data, dict) else {})
                    event, data_lines = "message", []
            raise ApiError("조사 스트림이 결과 없이 종료되었습니다.", RETRY)
        finally:
            self._close(conn, response)

    # --- API ------------------------------------------------------------------------------------
    def health(self) -> bool:
        try:
            return (self._json("GET", f"{API}/health") or {}).get("status") == "ok"
        except ApiError as error:
            if error.kind == OFFLINE:
                raise
            return False

    def latest_runs(self, model_name: str) -> list[dict]:
        """Newest stored run of this requested name (summary only), or an empty list."""
        return self._json("GET", f"{API}/admin/research-runs?modelName={quote(model_name, safe='')}&limit=1") or []

    def research(self, model_name: str, source: str, on_event=None, cancel=None) -> dict:
        return self._stream(f"{API}/admin/model-research/stream", {"modelName": model_name, "source": source},
                            on_event, cancel)

    def merge(self, model_name: str, results: dict[str, dict | None], on_event=None, cancel=None) -> dict:
        return self._stream(f"{API}/admin/model-research/merge/stream", {"modelName": model_name, "results": results},
                            on_event, cancel)

    def save_results(self, model_name: str, results: dict[str, dict | None], replace_previous: bool = True,
                     run_id: int | None = None) -> dict:
        return self._json("POST", f"{API}/admin/model-research/results", {
            "modelName": model_name, "results": results, "replacePrevious": replace_previous, "runId": run_id})
