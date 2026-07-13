/**
 * Auth as a per-model axis for the `fusionkit init` panel builder.
 *
 * A subscription is an auth mechanism that grants access to models, not a panel
 * that prescribes them. Each panel member independently picks how it
 * authenticates - a Claude Code / Codex subscription, an API key, or a local
 * model - and any of these can be mixed in one panel.
 */
import { catalogDefaultModel, defaultKeyEnv } from "@fusionkit/registry";

import { detectHost } from "./local-catalog.js";
import type { HostInfo } from "./local-catalog.js";
import { detectCodexModel, detectSubscription } from "./subscriptions.js";
import type { PanelModelSpec } from "./env.js";

export type AuthChoice =
  | "claude-code"
  | "codex"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "cliproxy"
  | "local";

type ApiKeyProvider = "openai" | "anthropic" | "google" | "openrouter" | "cliproxy";

function apiKeyEnvFor(provider: ApiKeyProvider): string {
  const keyEnv = defaultKeyEnv(provider);
  if (keyEnv === undefined) {
    throw new Error(`provider ${provider} has no API key env in the registry`);
  }
  return keyEnv;
}

function registryDefault(choice: AuthChoice): string {
  const model = catalogDefaultModel(choice);
  if (model === undefined) {
    throw new Error(`auth choice ${choice} has no default model in the registry`);
  }
  return model;
}

/**
 * The default OpenRouter model offered by the wizard (vendor/model id).
 * Registry model-catalog metadata — the curated fallback when live discovery
 * is unavailable (see listModelsForAuth).
 */
export const DEFAULT_OPENROUTER_MODEL = registryDefault("openrouter");

/** Translate a per-model auth choice into a panel spec (model is chosen separately). */
export function specForAuthChoice(choice: AuthChoice, id: string, model: string): PanelModelSpec {
  switch (choice) {
    case "claude-code":
      return { id, model, provider: "anthropic", auth: "claude-code" };
    case "codex":
      return { id, model, auth: "codex" };
    case "openai":
    case "anthropic":
    case "google":
    case "openrouter":
    case "cliproxy":
      return { id, model, provider: choice, keyEnv: apiKeyEnvFor(choice) };
    case "local":
      return { id, model, provider: "mlx" };
    default: {
      const exhaustive: never = choice;
      throw new Error(`unknown auth choice: ${String(exhaustive)}`);
    }
  }
}

/**
 * A sensible default model for a given auth choice (the subscription grants the
 * model set). Registry model-catalog metadata; the codex choice honors the
 * locally pinned Codex CLI model as a runtime override.
 */
export function defaultModelForAuthChoice(choice: AuthChoice): string {
  if (choice === "codex") return detectCodexModel();
  return registryDefault(choice);
}

export type AuthOption = { value: AuthChoice; label: string; hint: string };

/**
 * The auth methods to offer per panel member, subscriptions first (only when a
 * login is detected), then the API-key providers, then local. Hints note login
 * expiry and whether each API key env is set.
 */
export async function buildAuthOptions(
  env: Record<string, string | undefined> = process.env,
  host: HostInfo = detectHost()
): Promise<AuthOption[]> {
  const options: AuthOption[] = [];

  const claude = await detectSubscription("claude-code");
  if (claude.available) {
    options.push({
      value: "claude-code",
      label: "Claude Code subscription",
      hint: claude.expired ? "expired - run `claude` to refresh" : "logged in - anthropic models, no API key"
    });
  }
  const codex = await detectSubscription("codex");
  if (codex.available) {
    options.push({
      value: "codex",
      label: "Codex subscription",
      hint: codex.expired ? "expired - run `codex login` to refresh" : "logged in - gpt codex models, no API key"
    });
  }

  for (const provider of ["openai", "anthropic", "google", "openrouter"] as const) {
    const keyEnv = apiKeyEnvFor(provider);
    const isSet = (env[keyEnv] ?? "").length > 0;
    const reach = provider === "openrouter" ? " — any vendor's models with one key" : "";
    options.push({
      value: provider,
      label: `${provider} API key`,
      hint: (isSet ? `${keyEnv} is set` : `set ${keyEnv}`) + reach
    });
  }

  // CLIProxyAPI: a local OpenAI-compatible proxy that fronts OAuth subscription
  // accounts (Gemini/Antigravity, Grok, Kimi, and pooled Codex/Claude). Offered
  // like an API-key provider: the "key" is the proxy's own ingress key.
  const cliproxyKeyEnv = apiKeyEnvFor("cliproxy");
  const cliproxySet = (env[cliproxyKeyEnv] ?? "").length > 0;
  options.push({
    value: "cliproxy",
    label: "CLIProxyAPI (local proxy)",
    hint:
      (cliproxySet ? `${cliproxyKeyEnv} is set` : `set ${cliproxyKeyEnv}`) +
      " — subscription models (Gemini, Grok, Kimi, …) via a local OAuth proxy"
  });

  const localHint = host.appleSilicon
    ? `${Math.round(host.totalRamGB)}GB RAM, no keys`
    : "Apple Silicon only — unavailable on this host";
  options.push({ value: "local", label: "local MLX", hint: localHint });
  return options;
}
