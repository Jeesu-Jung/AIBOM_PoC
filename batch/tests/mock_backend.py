"""In-process stand-in for the AIBOM backend: same endpoints and SSE shape, scripted failures."""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


class MockBackend:
    """`script[(model, phase)]` is a list of outcomes used one per call, then "ok".

    Outcomes: "ok", an int (OpenRouter status passed through as an SSE error), "invalid" (answer
    failed validation), "drop" (stream ends without a result), "key" (API key not configured).
    """

    def __init__(self, script: dict | None = None, delay: float = 0.02, existing: dict | None = None,
                 max_concurrent: int | None = None):
        self.script = {key: list(value) for key, value in (script or {}).items()}
        self.delay = delay
        self.existing = existing or {}        # model name -> run summary returned by research-runs
        self.max_concurrent = max_concurrent  # more concurrent LLM calls than this answer 429
        self.calls: list[tuple[str, str]] = []
        self.saves: list[dict] = []
        self.in_flight = 0
        self.peak = 0
        self.lock = threading.Lock()
        backend = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _json(self, status, payload):
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                url = urlsplit(self.path)
                if url.path == "/api/v1/health":
                    return self._json(200, {"status": "ok"})
                if url.path == "/api/v1/admin/research-runs":
                    name = parse_qs(url.query).get("modelName", [""])[0]
                    run = backend.existing.get(name)
                    return self._json(200, [run] if run else [])
                self._json(404, {"detail": "Not found"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                path = urlsplit(self.path).path
                if path == "/api/v1/admin/model-research/results":
                    with backend.lock:
                        backend.saves.append(body)
                        run_id = 100 + len(backend.saves)
                    return self._json(200, {"runId": run_id, "modelName": body["modelName"]})
                if path == "/api/v1/admin/model-research/stream":
                    return self._stream(body["modelName"], body["source"])
                if path == "/api/v1/admin/model-research/merge/stream":
                    return self._stream(body["modelName"], "merged")
                self._json(404, {"detail": "Not found"})

            def _event(self, event, data):
                self.wfile.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
                self.wfile.flush()

            def _stream(self, name, phase):
                with backend.lock:
                    backend.calls.append((name, phase))
                    queue = backend.script.get((name, phase)) or []
                    outcome = queue.pop(0) if queue else "ok"
                    backend.in_flight += 1
                    backend.peak = max(backend.peak, backend.in_flight)
                    if backend.max_concurrent and backend.in_flight > backend.max_concurrent:
                        outcome = 429
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                try:
                    if isinstance(outcome, int):
                        return self._event("error", {"message": f"OpenRouter HTTP {outcome}: scripted",
                                                     "upstream": {"status": outcome}})
                    if outcome == "key":
                        return self._event("error", {"message": "OPENROUTER_API_KEY is not configured."})
                    self._event("status", {"stage": "researching", "message": "..."})
                    time.sleep(backend.delay)
                    self._event("content", {"delta": "x" * 10, "characters": 10})
                    if outcome == "invalid":
                        return self._event("error", {"message": "OpenRouter returned an invalid draft."})
                    if outcome == "drop":
                        return None
                    self._event("complete", {"result": {
                        "status": "found", "draft": {"modelId": name},
                        "research": {"source": phase, "usage": {"cost": 0.5}}}})
                except OSError:
                    pass  # the client aborted the call
                finally:
                    with backend.lock:
                        backend.in_flight -= 1

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
