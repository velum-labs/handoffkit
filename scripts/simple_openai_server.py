#!/usr/bin/env python3
"""Front one model endpoint (any provider) as an OpenAI Chat Completions server.

Thin CLI wrapper around the same uvicorn path as ``fusionkit serve-endpoint``.
Kept for the in-repo demos and scripts; the shipped path is
``uvx fusionkit serve-endpoint``.
"""
from __future__ import annotations

import argparse
import json

import uvicorn
from fusionkit_core.config import FusionConfig
from fusionkit_core.registry import API_KEY_ENVS
from fusionkit_core.trace import setup_fusion_tracing
from fusionkit_server.app import create_app
from fusionkit_server.openai_endpoint import build_endpoint

DEFAULT_PROVIDER = next(iter(API_KEY_ENVS))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True, help="endpoint id exposed via /v1/models")
    parser.add_argument("--model", required=True, help="provider model name (e.g. gpt-5.5)")
    parser.add_argument(
        "--provider",
        default=DEFAULT_PROVIDER,
        choices=["openai", "anthropic", "google", "openai-compatible", "mlx-lm", "custom"],
    )
    parser.add_argument("--base-url", default=None, help="override the provider base URL")
    parser.add_argument("--api-key-env", default=None, help="env var holding the API key")
    parser.add_argument("--timeout-s", type=float, default=120.0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    setup_fusion_tracing("fusionkit-panel-model")
    endpoint = build_endpoint(
        id=args.id,
        model=args.model,
        provider=args.provider,
        base_url=args.base_url,
        api_key_env=args.api_key_env,
        timeout_s=args.timeout_s,
    )
    print(
        json.dumps(
            {
                "event": "starting",
                "id": endpoint.id,
                "provider": endpoint.provider,
                "model": endpoint.model,
            }
        ),
        flush=True,
    )
    fusion_config = FusionConfig(endpoints=[endpoint], default_model=endpoint.id)
    api = create_app(fusion_config)
    print(json.dumps({"event": "listening", "host": args.host, "port": args.port}), flush=True)
    uvicorn.run(api, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
