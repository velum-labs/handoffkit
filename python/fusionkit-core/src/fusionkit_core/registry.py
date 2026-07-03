"""Typed accessors over the generated registry data (spec/registry/*.json).

The single source of truth for provider metadata (base URLs, key env vars),
subscription auth metadata (Claude Code / Codex logins), the fusion model
identity, model catalogs, model-family capability quirks, and default pricing.
The Node packages consume the same data through ``@fusionkit/registry`` — both
bindings are generated from the same JSON by ``scripts/generate-registry.mjs``,
so the two stacks cannot drift.
"""

from __future__ import annotations

from typing import Any, cast

from fusionkit_core._generated.registry_data import REGISTRY

_PROVIDERS = cast(dict[str, dict[str, Any]], REGISTRY["providers"])
_SUBSCRIPTIONS = cast(dict[str, dict[str, Any]], REGISTRY["subscriptions"])
_FUSION = cast(dict[str, Any], REGISTRY["fusion"])
_MODEL_CATALOG = cast(dict[str, Any], REGISTRY["modelCatalog"])
_CAPABILITIES = cast(dict[str, Any], REGISTRY["modelCapabilities"])
_PRICING = cast(dict[str, Any], REGISTRY["pricing"])

# ---- providers ---------------------------------------------------------------

PROVIDER_DEFAULT_BASE_URL: dict[str, str] = {
    provider: info["baseUrl"] for provider, info in _PROVIDERS.items() if "baseUrl" in info
}

PROVIDER_KEY_ENV: dict[str, str] = {
    provider: info["keyEnv"] for provider, info in _PROVIDERS.items() if "keyEnv" in info
}

PROVIDER_API_COMPATIBILITY: dict[str, str] = {
    provider: info["apiCompatibility"]
    for provider, info in _PROVIDERS.items()
    if "apiCompatibility" in info
}

OPENROUTER_ATTRIBUTION_HEADERS: dict[str, str] = dict(
    _PROVIDERS["openrouter"]["attributionHeaders"]
)

# ---- subscriptions -------------------------------------------------------------

_CLAUDE_CODE = _SUBSCRIPTIONS["claude-code"]
_CODEX = _SUBSCRIPTIONS["codex"]

ANTHROPIC_DEFAULT_BASE_URL: str = PROVIDER_DEFAULT_BASE_URL["anthropic"]
CODEX_BASE_URL: str = PROVIDER_DEFAULT_BASE_URL["codex"]

CLAUDE_CODE_KEYCHAIN_SERVICE: str = _CLAUDE_CODE["keychainService"]
DEFAULT_CLAUDE_CREDENTIALS_PATH: str = _CLAUDE_CODE["credentialsPath"]
DEFAULT_CODEX_CREDENTIALS_PATH: str = _CODEX["credentialsPath"]
DEFAULT_CODEX_CONFIG_PATH: str = _CODEX["configPath"]

DEFAULT_CLAUDE_MODEL: str = _CLAUDE_CODE["defaultModel"]
DEFAULT_CODEX_MODEL: str = _CODEX["defaultModel"]

CLAUDE_CODE_SPOOF_SYSTEM: str = _CLAUDE_CODE["spoofSystemPrompt"]
ANTHROPIC_OAUTH_BETA: str = _CLAUDE_CODE["oauthBetaHeader"]
CODEX_DEFAULT_INSTRUCTIONS: str = _CODEX["defaultInstructions"]
CODEX_DEFAULT_HEADERS: dict[str, str] = dict(_CODEX["defaultHeaders"])


def provider_for_auth_mode(mode: str) -> str:
    """The provider a subscription auth mode speaks (claude-code -> anthropic)."""
    return cast(str, _SUBSCRIPTIONS[mode]["provider"])


# ---- fusion model identity --------------------------------------------------------

FUSION_MODEL_ALIASES: tuple[str, ...] = tuple(_FUSION["aliases"])
FUSION_DEFAULT_ALIAS: str = _FUSION["defaultAlias"]
FUSION_PANEL_ALIAS: str = _FUSION["panelAlias"]
FUSION_DEFAULT_MODE: str = _FUSION["defaultMode"]
FUSED_MODEL_LABEL: str = _FUSION["fusedModelLabel"]
FUSION_GATEWAY_DEFAULT_BASE_URL: str = _FUSION["gatewayDefaultBaseUrl"]
FUSION_GATEWAY_API_KEY_ENV: str = _FUSION["gatewayApiKeyEnv"]

_MODE_BY_SUFFIX = cast(dict[str, str], _FUSION["modeBySuffix"])


def fusion_mode_for_model(model: str) -> str:
    """Map a fusion alias's suffix to its FusionMode (defaults to the router mode)."""
    suffix = model.rsplit("/", maxsplit=1)[-1]
    return _MODE_BY_SUFFIX.get(suffix, FUSION_DEFAULT_MODE)


# ---- model catalog -------------------------------------------------------------------

_DEFAULT_MODEL_BY_AUTH = cast(dict[str, str], _MODEL_CATALOG["defaultModelByAuthChoice"])

API_KEY_ENVS: dict[str, str] = {
    provider: PROVIDER_KEY_ENV[provider]
    for provider in ("openai", "anthropic", "google", "openrouter")
}

DEFAULT_API_MODELS: dict[str, str] = {
    provider: _DEFAULT_MODEL_BY_AUTH[provider]
    for provider in ("openai", "anthropic", "google", "openrouter")
}

DEFAULT_CLOUD_PANEL_MEMBERS: tuple[dict[str, str], ...] = tuple(
    dict(cast(dict[str, str], member))
    for member in cast(list[dict[str, str]], _MODEL_CATALOG["defaultCloudPanel"])
)

BENCHMARK_PANEL_PRESETS: dict[str, dict[str, Any]] = {
    panel_id: dict(cast(dict[str, Any], preset))
    for panel_id, preset in cast(
        dict[str, dict[str, Any]],
        _MODEL_CATALOG["benchmarkPanels"],
    ).items()
}


def default_model_for_auth_choice(choice: str) -> str | None:
    """The catalog's default model for an auth choice, or None when unknown."""
    return _DEFAULT_MODEL_BY_AUTH.get(choice)


# ---- model capabilities ----------------------------------------------------------------


def _family_matches(family: dict[str, Any], lowered_model: str) -> bool:
    requires = cast(list[str], family["requires"])
    if not all(needle in lowered_model for needle in requires):
        return False
    any_of = cast(list[str] | None, family.get("anyOf"))
    return any_of is None or any(needle in lowered_model for needle in any_of)


def sampling_overrides_for_model(model: str) -> dict[str, float]:
    """Per-model sampling overrides (first matching family wins); {} when none."""
    lowered = model.lower()
    for family in cast(list[dict[str, Any]], _CAPABILITIES["samplingFamilies"]):
        if _family_matches(family, lowered):
            return dict(cast(dict[str, float], family["overrides"]))
    return {}


def reasoning_request_for(provider: str, model: str) -> dict[str, Any] | None:
    """Provider-extension reasoning request body for a model family, or None."""
    lowered = model.lower()
    for family in cast(list[dict[str, Any]], _CAPABILITIES["reasoningRequestFamilies"]):
        if family.get("provider") not in (None, provider):
            continue
        if _family_matches(family, lowered):
            return dict(cast(dict[str, Any], family["reasoning"]))
    return None


def provider_request_shape(provider: str) -> dict[str, Any]:
    """Wire payload quirks for a provider (max-tokens param, omitted sampling); {} when none."""
    shapes = cast(dict[str, dict[str, Any]], _CAPABILITIES["providerRequestShapes"])
    return dict(shapes.get(provider, {}))


# ---- pricing -------------------------------------------------------------------------------

DEFAULT_MODEL_PRICING: dict[str, dict[str, float]] = {
    **cast(dict[str, dict[str, float]], _PRICING["models"]),
    **cast(dict[str, dict[str, float]], _PRICING["manualOverrides"]),
}


def default_pricing_for(model: str) -> dict[str, float] | None:
    """Default list pricing for a model: exact match first, then longest prefix."""
    key = model.lower()
    exact = next(
        (pricing for name, pricing in DEFAULT_MODEL_PRICING.items() if name.lower() == key),
        None,
    )
    if exact is not None:
        return dict(exact)
    best: tuple[int, dict[str, float]] | None = None
    for name, pricing in DEFAULT_MODEL_PRICING.items():
        lowered = name.lower()
        if key.startswith(lowered) and (best is None or len(lowered) > best[0]):
            best = (len(lowered), pricing)
    return dict(best[1]) if best is not None else None


__all__ = [
    "ANTHROPIC_DEFAULT_BASE_URL",
    "ANTHROPIC_OAUTH_BETA",
    "API_KEY_ENVS",
    "BENCHMARK_PANEL_PRESETS",
    "CLAUDE_CODE_KEYCHAIN_SERVICE",
    "CLAUDE_CODE_SPOOF_SYSTEM",
    "CODEX_BASE_URL",
    "CODEX_DEFAULT_HEADERS",
    "CODEX_DEFAULT_INSTRUCTIONS",
    "DEFAULT_API_MODELS",
    "DEFAULT_CLOUD_PANEL_MEMBERS",
    "DEFAULT_CLAUDE_CREDENTIALS_PATH",
    "DEFAULT_CLAUDE_MODEL",
    "DEFAULT_CODEX_CONFIG_PATH",
    "DEFAULT_CODEX_CREDENTIALS_PATH",
    "DEFAULT_CODEX_MODEL",
    "DEFAULT_MODEL_PRICING",
    "FUSED_MODEL_LABEL",
    "FUSION_DEFAULT_ALIAS",
    "FUSION_DEFAULT_MODE",
    "FUSION_GATEWAY_API_KEY_ENV",
    "FUSION_GATEWAY_DEFAULT_BASE_URL",
    "FUSION_MODEL_ALIASES",
    "FUSION_PANEL_ALIAS",
    "OPENROUTER_ATTRIBUTION_HEADERS",
    "PROVIDER_API_COMPATIBILITY",
    "PROVIDER_DEFAULT_BASE_URL",
    "PROVIDER_KEY_ENV",
    "REGISTRY",
    "default_model_for_auth_choice",
    "default_pricing_for",
    "fusion_mode_for_model",
    "provider_for_auth_mode",
    "provider_request_shape",
    "reasoning_request_for",
    "sampling_overrides_for_model",
]
