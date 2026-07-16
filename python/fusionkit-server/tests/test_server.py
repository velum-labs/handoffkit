from fastapi import FastAPI
from fastapi.testclient import TestClient
from fusionkit_core.clients import FakeModelClient
from fusionkit_core.config import FusionConfig
from fusionkit_server import create_app


def _app() -> FastAPI:
    config = FusionConfig(
        routekit_url="http://routekit.test",
        routekit_model_ids=["test/judge"],
        default_model="test/judge",
        judge_model="test/judge",
    )
    return create_app(
        config,
        clients={
            "test/judge": FakeModelClient(
                "test/judge",
                [
                    '{"consensus":["candidate is sound"],"contradictions":[],'
                    '"unique_insights":[],"coverage_gaps":[],"likely_errors":[],'
                    '"recommended_final_structure":[]}',
                    "fused answer",
                ],
            )
        },
    )


def _client() -> TestClient:
    return TestClient(_app())


def test_sidecar_exposes_only_internal_routes() -> None:
    paths = {
        path
        for route in _app().routes
        if isinstance(path := getattr(route, "path", None), str)
        and not path.startswith(("/openapi", "/docs", "/redoc"))
    }

    assert paths == {
        "/health",
        "/v1/fusion/runs",
        "/v1/fusion/runs/{run_id}",
        "/v1/fusion/runs/{run_id}/events",
        "/v1/fusion/runs/{run_id}/inspect",
        "/v1/fusion/runs/{run_id}/tool-results",
        "/v1/fusion/trajectories:fuse",
    }


def test_health_is_the_sidecar_readiness_endpoint() -> None:
    response = _client().get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_fuse_rejects_unknown_routekit_model() -> None:
    response = _client().post(
        "/v1/fusion/trajectories:fuse",
        json={
            "model": "fusion-panel",
            "messages": [{"role": "user", "content": "fuse"}],
            "trajectories": [
                {
                    "trajectory_id": "a",
                    "model_id": "a",
                    "status": "succeeded",
                    "final_output": "candidate",
                }
            ],
            "judge_model": "test/missing",
        },
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unknown_model"
