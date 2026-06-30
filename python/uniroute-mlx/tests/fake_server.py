"""An in-process fake OpenAI-compatible server for tests.

Implements just enough of /v1/chat/completions, /v1/embeddings, and
/v1/models to exercise the client, evaluator, and CLI end to end with no
MLX, no network, and no Apple Silicon: chat behaviour is a per-model
callable, embeddings are a deterministic keyword projection.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ChatFn = Callable[[str], str]


def keyword_embedding(text: str, keywords: list[str]) -> list[float]:
    """A deterministic embedding: one dimension per keyword (plus a bias).

    Prompts about the same keyword land on the same axis, giving k-means
    real clusters to find without any model.
    """
    lowered = text.casefold()
    return [1.0 if keyword in lowered else 0.0 for keyword in keywords] + [1.0]


class FakeOpenAIServer:
    """Start with ``with FakeOpenAIServer(...) as server: server.base_url``."""

    def __init__(
        self,
        *,
        chat_models: dict[str, ChatFn] | None = None,
        embed_keywords: list[str] | None = None,
        embed_model: str = "fake-embedder",
    ):
        self.chat_models = chat_models or {}
        self.embed_keywords = embed_keywords or ["math", "code"]
        self.embed_model = embed_model
        self.requests: list[dict] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        assert self._server is not None
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    @property
    def dims(self) -> int:
        return len(self.embed_keywords) + 1

    def __enter__(self) -> FakeOpenAIServer:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass  # keep test output clean

            def _send(self, status: int, payload: dict) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                if self.path == "/v1/models":
                    models = [*outer.chat_models, outer.embed_model]
                    self._send(200, {"data": [{"id": model} for model in models]})
                else:
                    self._send(404, {"error": f"unknown path {self.path}"})

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                request = json.loads(self.rfile.read(length).decode("utf-8"))
                outer.requests.append({"path": self.path, "body": request})
                if self.path == "/v1/chat/completions":
                    model = request.get("model", "")
                    chat = outer.chat_models.get(model)
                    if chat is None:
                        self._send(404, {"error": f"unknown model {model}"})
                        return
                    prompt = next(
                        (
                            message["content"]
                            for message in reversed(request.get("messages", []))
                            if message.get("role") == "user"
                        ),
                        "",
                    )
                    self._send(
                        200,
                        {
                            "choices": [
                                {"message": {"role": "assistant", "content": chat(prompt)}}
                            ]
                        },
                    )
                elif self.path == "/v1/embeddings":
                    texts = request.get("input", [])
                    if isinstance(texts, str):
                        texts = [texts]
                    self._send(
                        200,
                        {
                            "data": [
                                {
                                    "index": i,
                                    "embedding": keyword_embedding(text, outer.embed_keywords),
                                }
                                for i, text in enumerate(texts)
                            ]
                        },
                    )
                else:
                    self._send(404, {"error": f"unknown path {self.path}"})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        assert self._server is not None and self._thread is not None
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
