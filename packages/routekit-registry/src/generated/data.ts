// GENERATED FILE - DO NOT EDIT. Source of truth: spec/registry/*.json. Regenerate with `node scripts/generate-registry.mjs`.

export const REGISTRY = {
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com",
      "keyEnv": "OPENAI_API_KEY",
      "baseUrlEnv": "OPENAI_BASE_URL",
      "apiCompatibility": "openai-chat-completions",
      "wire": {
        "protocol": "openai",
        "basePath": "/v1"
      },
      "keyProbe": {
        "path": "/v1/models",
        "auth": "bearer",
        "invalidStatuses": [
          401,
          403
        ]
      },
      "discovery": {
        "path": "/v1/models",
        "auth": "bearer",
        "responseShape": "openai"
      }
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "keyEnv": "ANTHROPIC_API_KEY",
      "authTokenEnv": "ANTHROPIC_AUTH_TOKEN",
      "baseUrlEnv": "ANTHROPIC_BASE_URL",
      "apiCompatibility": "custom",
      "wire": {
        "protocol": "anthropic",
        "basePath": "/v1"
      },
      "keyProbe": {
        "path": "/v1/models",
        "auth": "x-api-key",
        "extraHeaders": {
          "anthropic-version": "2023-06-01"
        },
        "invalidStatuses": [
          401,
          403
        ]
      },
      "discovery": {
        "path": "/v1/models",
        "auth": "x-api-key",
        "extraHeaders": {
          "anthropic-version": "2023-06-01"
        },
        "responseShape": "anthropic"
      }
    },
    "google": {
      "baseUrl": "https://generativelanguage.googleapis.com",
      "keyEnv": "GEMINI_API_KEY",
      "apiCompatibility": "custom",
      "wire": {
        "protocol": "google",
        "basePath": "/v1beta"
      },
      "keyProbe": {
        "path": "/v1beta/models",
        "auth": "x-goog-api-key",
        "invalidStatuses": [
          400,
          401,
          403
        ]
      },
      "discovery": {
        "path": "/v1beta/models",
        "auth": "x-goog-api-key",
        "responseShape": "google"
      }
    },
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api",
      "keyEnv": "OPENROUTER_API_KEY",
      "apiCompatibility": "openai-chat-completions",
      "wire": {
        "protocol": "openai",
        "basePath": "/v1"
      },
      "attributionHeaders": {
        "HTTP-Referer": "https://github.com/velum-labs/handoffkit",
        "X-Title": "RouteKit"
      },
      "keyProbe": {
        "path": "/v1/key",
        "auth": "bearer",
        "invalidStatuses": [
          401,
          403
        ]
      },
      "discovery": {
        "path": "/v1/models",
        "auth": "bearer",
        "extraHeaders": {
          "HTTP-Referer": "https://github.com/velum-labs/handoffkit",
          "X-Title": "RouteKit"
        },
        "responseShape": "openai",
        "pickerDefaultSource": "curated"
      }
    },
    "cliproxy": {
      "$comment": "CLIProxyAPI (github.com/router-for-me/CLIProxyAPI): a local OpenAI-compatible proxy fronting OAuth subscription accounts (Codex, Claude Code, Gemini/Antigravity, Grok, Kimi) with multi-account rotation. Personal/local use only.",
      "baseUrl": "http://127.0.0.1:8317",
      "keyEnv": "ROUTEKIT_CLIPROXY_API_KEY",
      "baseUrlEnv": "ROUTEKIT_CLIPROXY_BASE_URL",
      "apiCompatibility": "openai-chat-completions",
      "wire": {
        "protocol": "openai",
        "basePath": "/v1"
      },
      "keyProbe": {
        "path": "/v1/models",
        "auth": "bearer",
        "invalidStatuses": [
          401,
          403
        ]
      },
      "discovery": {
        "path": "/v1/models",
        "auth": "bearer",
        "responseShape": "openai"
      }
    },
    "codex": {
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "apiCompatibility": "openai-responses",
      "credentialEnvNames": [
        "CODEX_API_KEY",
        "OPENAI_API_KEY"
      ],
      "wire": {
        "protocol": "codex",
        "basePath": ""
      },
      "discovery": {
        "path": "/models",
        "auth": "bearer",
        "responseShape": "codex"
      }
    },
    "ai-gateway": {
      "baseUrl": "https://ai-gateway.vercel.sh",
      "keyEnv": "AI_GATEWAY_API_KEY",
      "baseUrlEnv": "AI_GATEWAY_BASE_URL"
    },
    "openai-compatible": {
      "baseUrl": "http://127.0.0.1",
      "apiCompatibility": "openai-chat-completions"
    },
    "mlx-lm": {
      "apiCompatibility": "mlx-lm-server"
    },
    "mlx": {},
    "custom": {
      "apiCompatibility": "custom"
    }
  },
  "subscriptions": {
    "claude-code": {
      "provider": "anthropic",
      "credentialsPath": "~/.claude/.credentials.json",
      "configPath": "~/.claude/settings.json",
      "accountsDirectory": "~/.routekit/subscriptions/claude-code",
      "keychainService": "Claude Code-credentials",
      "defaultModel": "claude-sonnet-4-5",
      "oauthBetaHeader": "oauth-2025-04-20",
      "spoofSystemPrompt": "You are Claude Code, Anthropic's official CLI for Claude.",
      "wire": {
        "protocol": "anthropic",
        "basePath": "/v1"
      },
      "discovery": {
        "path": "/v1/models",
        "responseShape": "anthropic",
        "extraHeaders": {
          "anthropic-version": "2023-06-01"
        }
      },
      "oauth": {
        "tokenEndpoint": "https://console.anthropic.com/v1/oauth/token",
        "clientId": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        "usageEndpoint": "https://api.anthropic.com/api/oauth/usage",
        "profileEndpoint": "https://api.anthropic.com/api/oauth/profile"
      },
      "rateLimit": {
        "headerPrefix": "anthropic-ratelimit-unified",
        "retryAfterHeader": "retry-after"
      },
      "admin": {
        "keyEnv": "ANTHROPIC_ADMIN_KEY",
        "usageEndpoint": "https://api.anthropic.com/v1/organizations/usage_report/messages",
        "costEndpoint": "https://api.anthropic.com/v1/organizations/cost_report"
      }
    },
    "codex": {
      "provider": "codex",
      "credentialsPath": "~/.codex/auth.json",
      "accountsDirectory": "~/.routekit/subscriptions/codex",
      "configPath": "~/.codex/config.toml",
      "modelsCachePath": "~/.codex/models_cache.json",
      "authFileName": "auth.json",
      "defaultModel": "gpt-5.5",
      "defaultInstructions": "You are a helpful assistant.",
      "wire": {
        "protocol": "codex",
        "basePath": ""
      },
      "discovery": {
        "path": "/models",
        "responseShape": "codex",
        "clientVersion": "0.145.0",
        "cacheFallback": true,
        "extraHeaders": {
          "OpenAI-Beta": "responses=v1",
          "originator": "routekit"
        }
      },
      "defaultHeaders": {
        "OpenAI-Beta": "responses=v1",
        "originator": "routekit"
      },
      "requestDefaults": {
        "stream": true,
        "store": false,
        "omitSampling": true
      },
      "oauth": {
        "tokenEndpoint": "https://auth.openai.com/oauth/token",
        "clientId": "app_EMoamEEZ73f0CkXaXp7hrann",
        "usageEndpoint": "https://chatgpt.com/backend-api/wham/usage",
        "usagePathFallback": "/api/codex/usage"
      },
      "rateLimit": {
        "headerPrefix": "x-codex",
        "activeLimitHeader": "x-codex-active-limit",
        "retryAfterHeader": "retry-after"
      },
      "admin": {
        "keyEnv": "OPENAI_ADMIN_KEY",
        "usageEndpoint": "https://api.openai.com/v1/organization/usage/completions",
        "costEndpoint": "https://api.openai.com/v1/organization/costs"
      },
      "overrideEnv": {
        "responsesBaseUrl": [
          "CODEX_RESPONSES_BASE_URL"
        ],
        "responsesApiKey": [
          "CODEX_API_KEY",
          "OPENAI_API_KEY"
        ],
        "openaiCompatibleBaseUrl": [
          "OPENAI_BASE_URL"
        ],
        "openaiCompatibleApiKey": [
          "OPENAI_API_KEY"
        ]
      }
    }
  },
  "connectors": {
    "claude-code": {
      "connector": "native",
      "aliases": [
        "claude"
      ]
    },
    "codex": {
      "connector": "native"
    },
    "gemini": {
      "connector": "cliproxy",
      "cliproxyLoginFlag": "-antigravity-login",
      "cliproxyAuthTypes": [
        "antigravity",
        "gemini",
        "gemini-cli"
      ],
      "localOnly": true,
      "aliases": [
        "antigravity"
      ]
    },
    "grok": {
      "connector": "cliproxy",
      "cliproxyLoginFlag": "-xai-login",
      "cliproxyAuthTypes": [
        "xai",
        "grok"
      ],
      "localOnly": true,
      "aliases": [
        "xai"
      ]
    },
    "kimi": {
      "connector": "cliproxy",
      "cliproxyLoginFlag": "-kimi-login",
      "cliproxyAuthTypes": [
        "kimi"
      ],
      "localOnly": true
    }
  },
  "modelCatalog": {
    "defaultReasoningModel": "mlx-community/Qwen3-1.7B-4bit",
    "defaultModelByAuthChoice": {
      "claude-code": "claude-sonnet-4-5",
      "anthropic": "claude-sonnet-4-5",
      "codex": "gpt-5.5",
      "openai": "gpt-5.5",
      "google": "gemini-2.5-flash",
      "openrouter": "anthropic/claude-sonnet-4.5",
      "cliproxy": "gemini-3.1-pro-preview",
      "local": "mlx-community/Qwen3-1.7B-4bit"
    },
    "curated": {
      "claude-code": [
        "claude-sonnet-4-5",
        "claude-opus-4-8",
        "claude-haiku-4-5",
        "claude-sonnet-4-6"
      ],
      "anthropic": [
        "claude-sonnet-4-5",
        "claude-opus-4-8",
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
        "claude-3-7-sonnet-latest"
      ],
      "codex": [
        "gpt-5.5",
        "gpt-5.5-codex",
        "gpt-5.3-codex",
        "gpt-5.1-codex"
      ],
      "openai": [
        "gpt-5.5",
        "gpt-5.1",
        "gpt-5",
        "o4-mini",
        "gpt-4.1",
        "gpt-4.1-mini"
      ],
      "google": [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash"
      ],
      "openrouter": [
        "anthropic/claude-sonnet-4.5",
        "openai/gpt-5.5",
        "google/gemini-2.5-pro",
        "moonshotai/kimi-k2",
        "deepseek/deepseek-chat",
        "qwen/qwen3-coder",
        "x-ai/grok-4",
        "meta-llama/llama-3.3-70b-instruct"
      ],
      "cliproxy": [
        "gemini-3.1-pro-preview",
        "gpt-5.5",
        "gpt-5.5-codex",
        "claude-sonnet-4-5",
        "grok-4.3",
        "kimi-k2.5",
        "qwen3-coder"
      ]
    },
    "smokeModels": {
      "codex": "gpt-5.5-codex",
      "claude": "claude-sonnet-4-6"
    }
  },
  "modelCapabilities": {
    "samplingFamilies": [
      {
        "id": "qwen",
        "requires": [
          "qwen"
        ],
        "overrides": {
          "temperature": 0.55,
          "top_p": 1
        }
      },
      {
        "id": "kimi-k2-thinking",
        "requires": [
          "kimi-k2"
        ],
        "anyOf": [
          "thinking",
          "k2.",
          "k2p",
          "k2-5"
        ],
        "overrides": {
          "temperature": 1
        }
      },
      {
        "id": "kimi-k2",
        "requires": [
          "kimi-k2"
        ],
        "overrides": {
          "temperature": 0.6
        }
      }
    ],
    "chatTemplateFamilies": [
      {
        "id": "qwen-thinking",
        "requires": [
          "qwen"
        ],
        "chatTemplateKwargs": {
          "enable_thinking": true
        }
      }
    ],
    "reasoningRequestFamilies": [
      {
        "id": "openrouter-kimi",
        "provider": "openrouter",
        "requires": [
          "kimi"
        ],
        "reasoning": {
          "enabled": true,
          "exclude": false
        }
      }
    ],
    "providerRequestShapes": {
      "openai": {
        "maxTokensParam": "max_completion_tokens",
        "omitSampling": true,
        "streamIncludeUsage": true
      },
      "anthropic": {
        "omitSampling": true
      }
    }
  },
  "pricing": {
    "models": {
      "claude-haiku": {
        "inputPer1mTokens": 1,
        "outputPer1mTokens": 5
      },
      "claude-opus": {
        "inputPer1mTokens": 15,
        "outputPer1mTokens": 75
      },
      "claude-sonnet": {
        "inputPer1mTokens": 3,
        "outputPer1mTokens": 15
      },
      "claude-sonnet-4-6": {
        "inputPer1mTokens": 3,
        "outputPer1mTokens": 15
      },
      "gemini-2.5-flash": {
        "inputPer1mTokens": 0.3,
        "outputPer1mTokens": 2.5
      },
      "gemini-2.5-pro": {
        "inputPer1mTokens": 1.25,
        "outputPer1mTokens": 10
      },
      "gpt-4.1": {
        "inputPer1mTokens": 2,
        "outputPer1mTokens": 8
      },
      "gpt-4o": {
        "inputPer1mTokens": 2.5,
        "outputPer1mTokens": 10
      },
      "gpt-5": {
        "inputPer1mTokens": 1.25,
        "outputPer1mTokens": 10
      },
      "gpt-5.5": {
        "inputPer1mTokens": 1.25,
        "outputPer1mTokens": 10
      },
      "o3": {
        "inputPer1mTokens": 2,
        "outputPer1mTokens": 8
      }
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
      "openai/gpt-5.5": "gpt-5.5"
    },
    "manualOverrides": {}
  },
  "localCatalog": {
    "gatewayDefaultModel": "prism-ml/Ternary-Bonsai-4B-mlx-2bit",
    "probeModel": "mlx-community/Qwen3-1.7B-4bit",
    "preferred": [
      {
        "id": "qwen",
        "repo": "mlx-community/Qwen3-1.7B-4bit"
      },
      {
        "id": "gemma",
        "repo": "mlx-community/gemma-3-1b-it-4bit"
      },
      {
        "id": "llama",
        "repo": "mlx-community/Llama-3.2-1B-Instruct-4bit"
      }
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
        "role": "general"
      },
      {
        "repo": "mlx-community/gemma-3-1b-it-4bit",
        "label": "Gemma 3 1B Instruct",
        "params": "1B",
        "quant": "4bit",
        "sizeGB": 0.8,
        "minRamGB": 4,
        "blurb": "small Google model; a strong, diverse panel voice",
        "role": "general"
      },
      {
        "repo": "mlx-community/Qwen3-1.7B-4bit",
        "label": "Qwen3 1.7B",
        "params": "1.7B",
        "quant": "4bit",
        "sizeGB": 1,
        "minRamGB": 6,
        "blurb": "capable small all-rounder; a good default panel member",
        "role": "general"
      },
      {
        "repo": "mlx-community/Llama-3.2-3B-Instruct-4bit",
        "label": "Llama 3.2 3B Instruct",
        "params": "3B",
        "quant": "4bit",
        "sizeGB": 1.8,
        "minRamGB": 8,
        "blurb": "noticeably stronger than 1B while still light",
        "role": "general"
      },
      {
        "repo": "mlx-community/Qwen3-4B-4bit",
        "label": "Qwen3 4B",
        "params": "4B",
        "quant": "4bit",
        "sizeGB": 2.3,
        "minRamGB": 10,
        "blurb": "well-rounded mid-size model; good quality-to-size ratio",
        "role": "general"
      },
      {
        "repo": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit",
        "label": "Qwen2.5 Coder 7B",
        "params": "7B",
        "quant": "4bit",
        "sizeGB": 4.2,
        "minRamGB": 16,
        "blurb": "code-specialized; a strong local coding panelist",
        "role": "coder"
      },
      {
        "repo": "mlx-community/Qwen3-8B-4bit",
        "label": "Qwen3 8B",
        "params": "8B",
        "quant": "4bit",
        "sizeGB": 4.5,
        "minRamGB": 16,
        "blurb": "high-quality general model for 16GB+ machines",
        "role": "general"
      },
      {
        "repo": "mlx-community/Qwen3-14B-4bit",
        "label": "Qwen3 14B",
        "params": "14B",
        "quant": "4bit",
        "sizeGB": 8,
        "minRamGB": 24,
        "blurb": "frontier-ish local quality; needs a roomy machine",
        "role": "general"
      },
      {
        "repo": "mlx-community/Qwen2.5-Coder-32B-Instruct-4bit",
        "label": "Qwen2.5 Coder 32B",
        "params": "32B",
        "quant": "4bit",
        "sizeGB": 18,
        "minRamGB": 36,
        "blurb": "the strongest local coder here; for 36GB+ Macs",
        "role": "coder"
      }
    ]
  }
};
