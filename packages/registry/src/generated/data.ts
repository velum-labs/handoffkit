// GENERATED FILE - DO NOT EDIT. Source of truth: spec/registry/*.json. Regenerate with `node scripts/generate-registry.mjs`.

export const FUSION_REGISTRY = {
  "fusion": {
    "fusedModelLabel": "fusion-panel",
    "bridgeModelName": "local-fusion",
    "localModelLabel": "fusionkit-local",
    "aliases": [
      "fusionkit/heuristic",
      "fusionkit/panel",
      "fusionkit/self",
      "fusionkit/single"
    ],
    "defaultAlias": "fusionkit/heuristic",
    "panelAlias": "fusionkit/panel",
    "gatewayDefaultBaseUrl": "http://127.0.0.1:8080",
    "gatewayApiKeyEnv": "FUSIONKIT_GATEWAY_API_KEY",
    "defaultCloudPanel": [
      {
        "id": "gpt",
        "model": "gpt-5.5",
        "provider": "openai"
      },
      {
        "id": "sonnet",
        "model": "claude-sonnet-4-6",
        "provider": "anthropic"
      },
      {
        "id": "gemini",
        "model": "gemini-2.5-pro",
        "provider": "google"
      }
    ],
    "benchmarkPanels": {
      "decorrelated-peers": {
        "panelId": "decorrelated-peers",
        "members": [
          {
            "id": "gpt",
            "model": "gpt-5.5",
            "provider": "openai"
          },
          {
            "id": "opus",
            "model": "claude-opus-4.8",
            "provider": "anthropic"
          },
          {
            "id": "gemini",
            "model": "gemini-3-pro",
            "provider": "google"
          }
        ],
        "judgeId": "gpt",
        "synthesizerId": "gpt",
        "note": "Recommended benchmark panel: decorrelated frontier peers with comparable strength and different model families."
      },
      "lopsided-default": {
        "panelId": "lopsided-default",
        "members": [
          {
            "id": "gpt",
            "model": "gpt-5.5",
            "provider": "openai"
          },
          {
            "id": "sonnet",
            "model": "claude-sonnet-4-6",
            "provider": "anthropic"
          }
        ],
        "judgeId": "gpt",
        "synthesizerId": "gpt",
        "note": "Shipping contrast panel retained for regression comparisons; lopsided by design."
      },
      "gpt-opus-smoke": {
        "panelId": "gpt-opus-smoke",
        "members": [
          {
            "id": "gpt",
            "model": "gpt-5.5",
            "provider": "openai"
          },
          {
            "id": "opus",
            "model": "claude-opus-4-8",
            "provider": "anthropic"
          }
        ],
        "judgeId": "gpt",
        "synthesizerId": "gpt",
        "note": "Two-model GPT + Opus smoke panel used by live E2E scripts."
      }
    },
    "modeBySuffix": {
      "single": "single",
      "self": "self",
      "panel": "panel",
      "heuristic": "heuristic"
    },
    "defaultMode": "heuristic"
  }
};
