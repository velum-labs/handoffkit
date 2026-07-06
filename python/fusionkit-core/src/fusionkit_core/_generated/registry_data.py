# GENERATED FILE - DO NOT EDIT. Source of truth: spec/registry/*.json. Regenerate with `node scripts/generate-registry.mjs`.
# ruff: noqa: E501
from __future__ import annotations

from typing import Any, Final

REGISTRY: Final[dict[str, Any]] = {
    "providers": {
        "openai": {
            "baseUrl": "https://api.openai.com",
            "keyEnv": "OPENAI_API_KEY",
            "baseUrlEnv": "OPENAI_BASE_URL",
            "apiCompatibility": "openai-chat-completions",
            "keyProbe": {
                "path": "/v1/models",
                "auth": "bearer",
                "invalidStatuses": [
                    401,
                    403,
                ],
            },
            "discovery": {
                "path": "/v1/models",
                "auth": "bearer",
                "responseShape": "openai",
            },
        },
        "anthropic": {
            "baseUrl": "https://api.anthropic.com",
            "keyEnv": "ANTHROPIC_API_KEY",
            "authTokenEnv": "ANTHROPIC_AUTH_TOKEN",
            "baseUrlEnv": "ANTHROPIC_BASE_URL",
            "apiCompatibility": "custom",
            "keyProbe": {
                "path": "/v1/models",
                "auth": "x-api-key",
                "extraHeaders": {
                    "anthropic-version": "2023-06-01",
                },
                "invalidStatuses": [
                    401,
                    403,
                ],
            },
            "discovery": {
                "path": "/v1/models",
                "auth": "x-api-key",
                "extraHeaders": {
                    "anthropic-version": "2023-06-01",
                },
                "responseShape": "anthropic",
            },
        },
        "google": {
            "baseUrl": "https://generativelanguage.googleapis.com",
            "keyEnv": "GEMINI_API_KEY",
            "apiCompatibility": "custom",
            "keyProbe": {
                "path": "/v1beta/models",
                "auth": "x-goog-api-key",
                "invalidStatuses": [
                    400,
                    401,
                    403,
                ],
            },
            "discovery": {
                "path": "/v1beta/models",
                "auth": "query-key",
                "responseShape": "google",
            },
        },
        "openrouter": {
            "baseUrl": "https://openrouter.ai/api",
            "keyEnv": "OPENROUTER_API_KEY",
            "apiCompatibility": "openai-chat-completions",
            "attributionHeaders": {
                "HTTP-Referer": "https://github.com/velum-labs/handoffkit",
                "X-Title": "FusionKit",
            },
            "keyProbe": {
                "path": "/v1/key",
                "auth": "bearer",
                "invalidStatuses": [
                    401,
                    403,
                ],
            },
            "discovery": {
                "path": "/v1/models",
                "auth": "bearer",
                "extraHeaders": {
                    "HTTP-Referer": "https://github.com/velum-labs/handoffkit",
                    "X-Title": "FusionKit",
                },
                "responseShape": "openai",
                "pickerDefaultSource": "curated",
            },
        },
        "codex": {
            "baseUrl": "https://chatgpt.com/backend-api/codex",
            "apiCompatibility": "openai-responses",
            "credentialEnvNames": [
                "CODEX_API_KEY",
                "OPENAI_API_KEY",
            ],
        },
        "ai-gateway": {
            "baseUrl": "https://ai-gateway.vercel.sh",
            "keyEnv": "AI_GATEWAY_API_KEY",
            "baseUrlEnv": "AI_GATEWAY_BASE_URL",
        },
        "openai-compatible": {
            "baseUrl": "http://127.0.0.1",
            "apiCompatibility": "openai-chat-completions",
        },
        "mlx-lm": {
            "apiCompatibility": "mlx-lm-server",
        },
        "mlx": {},
        "custom": {
            "apiCompatibility": "custom",
        },
    },
    "subscriptions": {
        "claude-code": {
            "provider": "anthropic",
            "credentialsPath": "~/.claude/.credentials.json",
            "keychainService": "Claude Code-credentials",
            "defaultModel": "claude-sonnet-4-5",
            "oauthBetaHeader": "oauth-2025-04-20",
            "spoofSystemPrompt": "You are Claude Code, Anthropic's official CLI for Claude.",
        },
        "codex": {
            "provider": "codex",
            "credentialsPath": "~/.codex/auth.json",
            "configPath": "~/.codex/config.toml",
            "modelsCachePath": "~/.codex/models_cache.json",
            "authFileName": "auth.json",
            "defaultModel": "gpt-5.5",
            "defaultInstructions": "You are a helpful assistant.",
            "defaultHeaders": {
                "OpenAI-Beta": "responses=v1",
                "originator": "fusionkit",
            },
            "requestDefaults": {
                "stream": True,
                "store": False,
                "omitSampling": True,
            },
            "overrideEnv": {
                "responsesBaseUrl": [
                    "FUSIONKIT_CODEX_RESPONSES_BASE_URL",
                    "CODEX_RESPONSES_BASE_URL",
                ],
                "responsesApiKey": [
                    "FUSIONKIT_CODEX_API_KEY",
                    "CODEX_API_KEY",
                    "OPENAI_API_KEY",
                ],
                "openaiCompatibleBaseUrl": [
                    "FUSIONKIT_CODEX_OPENAI_BASE_URL",
                    "OPENAI_BASE_URL",
                ],
                "openaiCompatibleApiKey": [
                    "FUSIONKIT_CODEX_OPENAI_API_KEY",
                    "OPENAI_API_KEY",
                ],
            },
        },
    },
    "fusion": {
        "fusedModelLabel": "fusion-panel",
        "bridgeModelName": "local-fusion",
        "localModelLabel": "fusionkit-local",
        "aliases": [
            "fusionkit/router",
            "fusionkit/panel",
            "fusionkit/self",
            "fusionkit/single",
        ],
        "defaultAlias": "fusionkit/router",
        "panelAlias": "fusionkit/panel",
        "gatewayDefaultBaseUrl": "http://127.0.0.1:8080",
        "gatewayApiKeyEnv": "FUSIONKIT_GATEWAY_API_KEY",
        "modeBySuffix": {
            "single": "single",
            "self": "self",
            "panel": "panel",
            "router": "router",
        },
        "defaultMode": "router",
    },
    "modelCatalog": {
        "defaultCloudPanel": [
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
            {
                "id": "gemini",
                "model": "gemini-2.5-pro",
                "provider": "google",
            },
        ],
        "defaultReasoningModel": "mlx-community/Qwen3-1.7B-4bit",
        "defaultModelByAuthChoice": {
            "claude-code": "claude-sonnet-4-5",
            "anthropic": "claude-sonnet-4-5",
            "codex": "gpt-5.5",
            "openai": "gpt-5.5",
            "google": "gemini-2.5-flash",
            "openrouter": "anthropic/claude-sonnet-4.5",
            "local": "mlx-community/Qwen3-1.7B-4bit",
        },
        "curated": {
            "claude-code": [
                "claude-sonnet-4-5",
                "claude-opus-4-8",
                "claude-haiku-4-5",
                "claude-sonnet-4-6",
            ],
            "anthropic": [
                "claude-sonnet-4-5",
                "claude-opus-4-8",
                "claude-haiku-4-5",
                "claude-sonnet-4-6",
                "claude-3-7-sonnet-latest",
            ],
            "codex": [
                "gpt-5.5",
                "gpt-5.5-codex",
                "gpt-5.3-codex",
                "gpt-5.1-codex",
            ],
            "openai": [
                "gpt-5.5",
                "gpt-5.1",
                "gpt-5",
                "o4-mini",
                "gpt-4.1",
                "gpt-4.1-mini",
            ],
            "google": [
                "gemini-2.5-flash",
                "gemini-2.5-pro",
                "gemini-2.0-flash",
            ],
            "openrouter": [
                "anthropic/claude-sonnet-4.5",
                "openai/gpt-5.5",
                "google/gemini-2.5-pro",
                "moonshotai/kimi-k2",
                "deepseek/deepseek-chat",
                "qwen/qwen3-coder",
                "x-ai/grok-4",
                "meta-llama/llama-3.3-70b-instruct",
            ],
        },
        "smokeModels": {
            "codex": "gpt-5.5-codex",
            "claude": "claude-sonnet-4-6",
        },
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
    },
    "modelCapabilities": {
        "samplingFamilies": [
            {
                "id": "qwen",
                "requires": [
                    "qwen",
                ],
                "overrides": {
                    "temperature": 0.55,
                    "top_p": 1,
                },
            },
            {
                "id": "kimi-k2-thinking",
                "requires": [
                    "kimi-k2",
                ],
                "anyOf": [
                    "thinking",
                    "k2.",
                    "k2p",
                    "k2-5",
                ],
                "overrides": {
                    "temperature": 1,
                },
            },
            {
                "id": "kimi-k2",
                "requires": [
                    "kimi-k2",
                ],
                "overrides": {
                    "temperature": 0.6,
                },
            },
        ],
        "chatTemplateFamilies": [
            {
                "id": "qwen-thinking",
                "requires": [
                    "qwen",
                ],
                "chatTemplateKwargs": {
                    "enable_thinking": True,
                },
            },
        ],
        "reasoningRequestFamilies": [
            {
                "id": "openrouter-kimi",
                "provider": "openrouter",
                "requires": [
                    "kimi",
                ],
                "reasoning": {
                    "enabled": True,
                    "exclude": False,
                },
            },
        ],
        "providerRequestShapes": {
            "openai": {
                "maxTokensParam": "max_completion_tokens",
                "omitSampling": True,
                "streamIncludeUsage": True,
            },
            "anthropic": {
                "omitSampling": True,
            },
        },
    },
    "pricing": {
        "models": {
            "claude-haiku": {
                "inputPer1mTokens": 1,
                "outputPer1mTokens": 5,
            },
            "claude-opus": {
                "inputPer1mTokens": 15,
                "outputPer1mTokens": 75,
            },
            "claude-sonnet": {
                "inputPer1mTokens": 3,
                "outputPer1mTokens": 15,
            },
            "claude-sonnet-4-6": {
                "inputPer1mTokens": 3,
                "outputPer1mTokens": 15,
            },
            "gemini-2.5-flash": {
                "inputPer1mTokens": 0.3,
                "outputPer1mTokens": 2.5,
            },
            "gemini-2.5-pro": {
                "inputPer1mTokens": 1.25,
                "outputPer1mTokens": 10,
            },
            "gpt-4.1": {
                "inputPer1mTokens": 2,
                "outputPer1mTokens": 8,
            },
            "gpt-4o": {
                "inputPer1mTokens": 2.5,
                "outputPer1mTokens": 10,
            },
            "gpt-5": {
                "inputPer1mTokens": 1.25,
                "outputPer1mTokens": 10,
            },
            "gpt-5.5": {
                "inputPer1mTokens": 1.25,
                "outputPer1mTokens": 10,
            },
            "o3": {
                "inputPer1mTokens": 2,
                "outputPer1mTokens": 8,
            },
        },
        "aliases": {
            "anthropic/claude-sonnet-4.5": "claude-sonnet",
            "claude-haiku-4-5": "claude-haiku",
            "claude-opus-4-8": "claude-opus",
            "claude-sonnet-4-5": "claude-sonnet",
            "gpt-4.1-mini": "gpt-4.1",
            "gpt-5.1": "gpt-5",
            "gpt-5.1-codex": "gpt-5",
            "gpt-5.3-codex": "gpt-5",
            "gpt-5.5-2026-05": "gpt-5.5",
            "gpt-5.5-codex": "gpt-5.5",
            "openai/gpt-5.5": "gpt-5.5",
        },
        "manualOverrides": {},
    },
    "localCatalog": {
        "gatewayDefaultModel": "prism-ml/Ternary-Bonsai-4B-mlx-2bit",
        "probeModel": "mlx-community/Qwen3-1.7B-4bit",
        "preferred": [
            {
                "id": "qwen",
                "repo": "mlx-community/Qwen3-1.7B-4bit",
            },
            {
                "id": "gemma",
                "repo": "mlx-community/gemma-3-1b-it-4bit",
            },
            {
                "id": "llama",
                "repo": "mlx-community/Llama-3.2-1B-Instruct-4bit",
            },
        ],
        "entries": [
            {
                "repo": "mlx-community/Llama-3.2-1B-Instruct-4bit",
                "label": "Llama 3.2 1B Instruct",
                "params": "1B",
                "quant": "4bit",
                "sizeGB": 0.7,
                "minRamGB": 4,
                "blurb": "tiny and fast; great for low-memory machines and quick panels",
                "role": "general",
            },
            {
                "repo": "mlx-community/gemma-3-1b-it-4bit",
                "label": "Gemma 3 1B Instruct",
                "params": "1B",
                "quant": "4bit",
                "sizeGB": 0.8,
                "minRamGB": 4,
                "blurb": "small Google model; a strong, diverse panel voice",
                "role": "general",
            },
            {
                "repo": "mlx-community/Qwen3-1.7B-4bit",
                "label": "Qwen3 1.7B",
                "params": "1.7B",
                "quant": "4bit",
                "sizeGB": 1,
                "minRamGB": 6,
                "blurb": "capable small all-rounder; a good default panel member",
                "role": "general",
            },
            {
                "repo": "mlx-community/Llama-3.2-3B-Instruct-4bit",
                "label": "Llama 3.2 3B Instruct",
                "params": "3B",
                "quant": "4bit",
                "sizeGB": 1.8,
                "minRamGB": 8,
                "blurb": "noticeably stronger than 1B while still light",
                "role": "general",
            },
            {
                "repo": "mlx-community/Qwen3-4B-4bit",
                "label": "Qwen3 4B",
                "params": "4B",
                "quant": "4bit",
                "sizeGB": 2.3,
                "minRamGB": 10,
                "blurb": "well-rounded mid-size model; good quality-to-size ratio",
                "role": "general",
            },
            {
                "repo": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
                "label": "Qwen2.5 Coder 7B",
                "params": "7B",
                "quant": "4bit",
                "sizeGB": 4.2,
                "minRamGB": 16,
                "blurb": "code-specialized; a strong local coding panelist",
                "role": "coder",
            },
            {
                "repo": "mlx-community/Qwen3-8B-4bit",
                "label": "Qwen3 8B",
                "params": "8B",
                "quant": "4bit",
                "sizeGB": 4.5,
                "minRamGB": 16,
                "blurb": "high-quality general model for 16GB+ machines",
                "role": "general",
            },
            {
                "repo": "mlx-community/Qwen3-14B-4bit",
                "label": "Qwen3 14B",
                "params": "14B",
                "quant": "4bit",
                "sizeGB": 8,
                "minRamGB": 24,
                "blurb": "frontier-ish local quality; needs a roomy machine",
                "role": "general",
            },
            {
                "repo": "mlx-community/Qwen2.5-Coder-32B-Instruct-4bit",
                "label": "Qwen2.5 Coder 32B",
                "params": "32B",
                "quant": "4bit",
                "sizeGB": 18,
                "minRamGB": 36,
                "blurb": "the strongest local coder here; for 36GB+ Macs",
                "role": "coder",
            },
        ],
    },
}
