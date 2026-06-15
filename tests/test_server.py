from __future__ import annotations

from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig, ModelEndpoint
from fusionkit_server import create_app


def test_chat_completions_single_mode() -> None:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(id="fast", model="fake-fast", base_url="http://localhost:8101"),
        ],
        default_model="fast",
        default_mode="single",
    )
    app = create_app(config, clients={"fast": FakeModelClient("fast", ["hello from fake"])})
    client = TestClient(app)

    response = client.post(
        "/v1/chat/completions",
        json={
            "model": "fusionkit/single",
            "messages": [{"role": "user", "content": "hello"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["choices"][0]["message"]["content"] == "hello from fake"
