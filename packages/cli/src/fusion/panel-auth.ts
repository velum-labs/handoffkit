/**
 * Auth as a per-model axis for the `fusionkit init` panel builder.
 *
 * A subscription is an auth mechanism that grants access to models, not a panel
 * that prescribes them. Each panel member independently picks how it
 * authenticates - a Claude Code / Codex subscription, an API key, or a local
 * model - and any of these can be mixed in one panel.
 */
import { detectHost } from "./local-catalog.js";
import type { HostInfo } from "./local-catalog.js";
import { DEFAULT_CLAUDE_SUB_MODEL, detectCodexModel, detectSubscription } from "./subscriptions.js";
import type { PanelModelSpec } from "./env.js";

export type AuthChoice =
  | "claude-code"
  | "codex"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "local";

type ApiKeyProvider = "openai" | "anthropic" | "google" | "openrouter";

const API_KEY_ENV: Record<ApiKeyProvider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
};

/** The default OpenRouter model offered by the wizard (vendor/model id). */
export const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4.5";

const DEFAULT_LOCAL_MODEL = "mlx-community/Qwen3-1.7B-4bit";

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
      return { id, model, provider: choice, keyEnv: API_KEY_ENV[choice] };
    case "local":
      return { id, model, provider: "mlx" };
    default: {
      const exhaustive: never = choice;
      throw new Error(`unknown auth choice: ${String(exhaustive)}`);
    }
  }
}

/** A sensible default model for a given auth choice (the subscription grants the model set). */
export function defaultModelForAuthChoice(choice: AuthChoice): string {
  switch (choice) {
    case "claude-code":
    case "anthropic":
      return DEFAULT_CLAUDE_SUB_MODEL;
    case "codex":
      return detectCodexModel();
    case "openai":
      return "gpt-5.5";
    case "google":
      return "gemini-2.5-flash";
    case "openrouter":
      return DEFAULT_OPENROUTER_MODEL;
    case "local":
      return DEFAULT_LOCAL_MODEL;
    default: {
      const exhaustive: never = choice;
      throw new Error(`unknown auth choice: ${String(exhaustive)}`);
    }
  }
}

export type AuthOption = { value: AuthChoice; label: string; hint: string };

/**
 * The auth methods to offer per panel member, subscriptions first (only when a
 * login is detected), then the API-key providers, then local. Hints note login
 * expiry and whether each API key env is set.
 */
export function buildAuthOptions(
  env: Record<string, string | undefined> = process.env,
  host: HostInfo = detectHost()
): AuthOption[] {
  const options: AuthOption[] = [];

  const claude = detectSubscription("claude-code");
  if (claude.available) {
    options.push({
      value: "claude-code",
      label: "Claude Code subscription",
      hint: claude.expired ? "expired - run `claude` to refresh" : "logged in - anthropic models, no API key"
    });
  }
  const codex = detectSubscription("codex");
  if (codex.available) {
    options.push({
      value: "codex",
      label: "Codex subscription",
      hint: codex.expired ? "expired - run `codex login` to refresh" : "logged in - gpt codex models, no API key"
    });
  }

  for (const provider of ["openai", "anthropic", "google", "openrouter"] as const) {
    const keyEnv = API_KEY_ENV[provider];
    const isSet = (env[keyEnv] ?? "").length > 0;
    const reach = provider === "openrouter" ? " — any vendor's models with one key" : "";
    options.push({
      value: provider,
      label: `${provider} API key`,
      hint: (isSet ? `${keyEnv} is set` : `set ${keyEnv}`) + reach
    });
  }

  const localHint = host.appleSilicon
    ? `${Math.round(host.totalRamGB)}GB RAM, no keys`
    : "Apple Silicon only — unavailable on this host";
  options.push({ value: "local", label: "local MLX", hint: localHint });
  return options;
}
