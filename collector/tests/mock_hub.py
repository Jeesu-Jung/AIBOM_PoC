"""A tiny stand-in for huggingface.co: model info, paged finetune listing, README downloads."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


class MockHub:
    def __init__(self, root: str, root_readme: str | None, models: list[dict], readmes: dict[str, str]):
        """`models`: listing entries (id, downloads, siblings...). `readmes`: id -> README text."""
        self.root = root
        self.models = models
        self.readmes = dict(readmes)
        if root_readme is not None:
            self.readmes[root] = root_readme
        self.fail_always: set[str] = set()   # README requests answered with 500
        self.rate_limit_once: set[str] = set()  # README requests answered with 429 the first time
        self.requests: list[str] = []
        self.auth_headers: list[str | None] = []
        hub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):  # keep test output quiet
                pass

            def _send(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                parsed = urlparse(self.path)
                hub.requests.append(self.path)
                hub.auth_headers.append(self.headers.get("Authorization"))
                if parsed.path == "/api/models":
                    query = parse_qs(parsed.query)
                    if query.get("filter") != [f"base_model:finetune:{hub.root}"]:
                        return self._send(200, b"[]")
                    limit = int(query.get("limit", ["500"])[0])
                    offset = int(query.get("cursor", ["0"])[0])
                    page = hub.models[offset:offset + limit]
                    headers = {}
                    if offset + limit < len(hub.models):
                        base = f"http://{self.headers['Host']}/api/models?{parsed.query.split('&cursor=')[0]}"
                        headers["Link"] = f'<{base}&cursor={offset + limit}>; rel="next"'
                    return self._send(200, json.dumps(page).encode(), headers)
                if parsed.path.startswith("/api/models/"):
                    model_id = parsed.path[len("/api/models/"):]
                    if model_id.lower() == hub.root.lower():
                        return self._send(200, json.dumps({"id": hub.root}).encode())
                    return self._send(404, b"{}")
                if parsed.path.endswith("/resolve/main/README.md"):
                    model_id = parsed.path[1:-len("/resolve/main/README.md")]
                    if model_id in hub.fail_always:
                        return self._send(500, b"")
                    if model_id in hub.rate_limit_once:
                        hub.rate_limit_once.discard(model_id)
                        return self._send(429, b"", {"Retry-After": "0"})
                    if model_id in hub.readmes:
                        return self._send(200, hub.readmes[model_id].encode("utf-8"))
                return self._send(404, b"")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> "MockHub":
        self._thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.server.shutdown()
        self.server.server_close()
