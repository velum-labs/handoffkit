#!/usr/bin/env python3
"""Front one model endpoint (any provider) as an OpenAI Chat Completions server.

Thin CLI wrapper around ``fusionkit_server.openai_endpoint`` (the same code that
backs the ``fusionkit serve-endpoint`` command). Kept for the in-repo demos and
scripts; the shipped path is ``uvx fusionkit serve-endpoint``.
"""
from __future__ import annotations

import argparse

from fusionkit_server.openai_endpoint import build_endpoint, serve_single_endpoint


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True, help="endpoint id exposed via /v1/models")
    parser.add_argument("--model", required=True, help="provider model name (e.g. gpt-5.5)")
    parser.add_argument(
        "--provider",
        default="openai",
        choices=["openai", "anthropic", "google", "openai-compatible", "mlx-lm", "custom"],
    )
    parser.add_argument("--base-url", default=None, help="override the provider base URL")
    parser.add_argument("--api-key-env", default=None, help="env var holding the API key")
    parser.add_argument("--timeout-s", type=float, default=120.0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    endpoint = build_endpoint(
        id=args.id,
        model=args.model,
        provider=args.provider,
        base_url=args.base_url,
        api_key_env=args.api_key_env,
        timeout_s=args.timeout_s,
    )
    serve_single_endpoint(endpoint, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
