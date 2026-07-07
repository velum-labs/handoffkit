"""Minimal local OTLP/HTTP-JSON trace collector for the judge autopsy.

FusionKit's engine exports spans as OTLP JSON (protobuf JSON mapping) to
``OTEL_EXPORTER_OTLP_TRACES_ENDPOINT``. This receiver appends every posted
batch to a JSONL file for offline analysis. No dependencies beyond stdlib.

Usage: python otlp_collector.py <out.jsonl> [port]
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "spans.jsonl")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 4318


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        try:
            payload = json.loads(body.decode("utf-8"))
            with OUT.open("a", encoding="utf-8") as f:
                f.write(json.dumps(payload) + "\n")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")
        except Exception as exc:  # noqa: BLE001 (diagnostic tool: log + 400)
            sys.stderr.write(f"collector error: {exc}\n")
            self.send_response(400)
            self.end_headers()

    def log_message(self, *args: object) -> None:
        return


if __name__ == "__main__":
    OUT.parent.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    sys.stderr.write(f"collector listening on 127.0.0.1:{PORT} -> {OUT}\n")
    server.serve_forever()
