"""Logging reverse proxy: fusionkit serve -> (here) -> OpenRouter.

Captures every provider call the fused engine makes — member proposals,
judge analysis (request carries the packed candidates; response carries the
raw analysis JSON), synthesizer commits — as JSONL, without any change to
the engine. Point the panel config's ``base_url`` at this proxy.

Usage: python logging_proxy.py <out.jsonl> [port] [upstream]
"""

from __future__ import annotations

import gzip
import json
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "provider_calls.jsonl")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9333
UPSTREAM = (sys.argv[3] if len(sys.argv) > 3 else "https://openrouter.ai").rstrip("/")

_write_lock = threading.Lock()


def _log(record: dict) -> None:
    with _write_lock, OUT.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def _decode(body: bytes, encoding: str | None) -> bytes:
    if encoding == "gzip":
        return gzip.decompress(body)
    return body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _forward(self, method: str) -> None:
        length = int(self.headers.get("content-length", "0") or 0)
        req_body = self.rfile.read(length) if length else b""
        headers = {
            k: v
            for k, v in self.headers.items()
            if k.lower() not in ("host", "content-length", "connection", "accept-encoding")
        }
        headers["accept-encoding"] = "gzip"
        upstream_req = urllib.request.Request(
            f"{UPSTREAM}{self.path}", data=req_body or None, headers=headers, method=method
        )
        started = time.time()
        try:
            with urllib.request.urlopen(upstream_req, timeout=900) as resp:
                resp_body = _decode(resp.read(), resp.headers.get("content-encoding"))
                status = resp.status
                content_type = resp.headers.get("content-type", "application/json")
        except urllib.error.HTTPError as e:
            resp_body = _decode(e.read(), e.headers.get("content-encoding"))
            status = e.code
            content_type = e.headers.get("content-type", "application/json")
        latency = round(time.time() - started, 3)

        if self.path.startswith("/v1/chat/completions"):
            try:
                record = {
                    "ts": started,
                    "latency_s": latency,
                    "status": status,
                    "request": json.loads(req_body.decode("utf-8")) if req_body else None,
                    "response": json.loads(resp_body.decode("utf-8")),
                }
            except Exception:
                record = {
                    "ts": started,
                    "latency_s": latency,
                    "status": status,
                    "raw_request": req_body.decode("utf-8", "replace")[:2000],
                    "raw_response": resp_body.decode("utf-8", "replace")[:2000],
                }
            _log(record)

        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        self._forward("POST")

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        self._forward("GET")

    def log_message(self, *args: object) -> None:
        return


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(f"proxy on 127.0.0.1:{PORT} -> {UPSTREAM}, logging {OUT}\n")
    server.serve_forever()
