# GENERATED FILE - DO NOT EDIT. Source of truth: spec/registry/*.json. Regenerate with `node scripts/generate-registry.mjs`.
# ruff: noqa: E501
from __future__ import annotations

from typing import Any, Final

BENCHMARK_REGISTRY: Final[dict[str, Any]] = {
    "benchmarkPanels": {
        "decorrelated-peers": {
            "panelId": "decorrelated-peers",
            "members": [
                {
                    "id": "gpt",
                    "model": "gpt-5.5",
                    "provider": "openai",
                },
                {
                    "id": "opus",
                    "model": "claude-opus-4.8",
                    "provider": "anthropic",
                },
                {
                    "id": "gemini",
                    "model": "gemini-3-pro",
                    "provider": "google",
                },
            ],
            "judgeId": "gpt",
            "synthesizerId": "gpt",
            "note": "Recommended benchmark panel: decorrelated frontier peers with comparable strength and different model families.",
        },
        "lopsided-default": {
            "panelId": "lopsided-default",
            "members": [
                {
                    "id": "gpt",
                    "model": "gpt-5.5",
                    "provider": "openai",
                },
                {
                    "id": "sonnet",
                    "model": "claude-sonnet-4-6",
                    "provider": "anthropic",
                },
            ],
            "judgeId": "gpt",
            "synthesizerId": "gpt",
            "note": "Shipping contrast panel retained for regression comparisons; lopsided by design.",
        },
        "gpt-opus-smoke": {
            "panelId": "gpt-opus-smoke",
            "members": [
                {
                    "id": "gpt",
                    "model": "gpt-5.5",
                    "provider": "openai",
                },
                {
                    "id": "opus",
                    "model": "claude-opus-4-8",
                    "provider": "anthropic",
                },
            ],
            "judgeId": "gpt",
            "synthesizerId": "gpt",
            "note": "Two-model GPT + Opus smoke panel used by live E2E scripts.",
        },
    },
    "gatewayDefaultBaseUrl": "http://127.0.0.1:8080",
    "gatewayApiKeyEnv": "FUSIONKIT_GATEWAY_API_KEY",
}
