/**
 * Fail-closed mapping from a governed session's resolved environment (the
 * contract's env policy plus broker-released secrets) onto the explicit
 * auth settings of the `@ai-sdk/harness-claude-code` adapter.
 *
 * The adapter's default behavior resolves credentials from the *host*
 * process environment — which on a Warrant runner would bypass the secret
 * broker entirely (the runner operator's own ANTHROPIC_API_KEY would leak
 * into the session). This module therefore always constructs an explicit
 * auth object, and fills unset credential fields with empty strings: the
 * adapter treats "" as present-but-falsy, so it neither falls back to the
 * host environment nor exports the variable into the bridge.
 */
import type { ClaudeCodeAuthOptions } from "@ai-sdk/harness-claude-code";
import type { PiAuthOptions } from "@ai-sdk/harness-pi";
import { CapabilityMismatchError } from "@fusionkit/runner";

/**
 * The only environment variables this harness path can honor: the adapter
 * forwards exactly these to the in-sandbox bridge. Pinned here so anything
 * else in the contract's env policy fails closed instead of being silently
 * dropped.
 */
const SUPPORTED_AUTH_VARS = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
] as const;

/**
 * The adapter's documented default gateway URL. Passed explicitly when the
 * session selects gateway auth without a base URL, so the adapter never
 * consults the host environment for it.
 */
const DEFAULT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";

/**
 * Build the explicit claude-code auth settings from the session env.
 *
 * Fails closed when the env carries variables this path cannot deliver to
 * the agent runtime, and when no credential is present at all (the adapter
 * would otherwise fall back to the runner host's own credentials).
 */
export function claudeCodeAuthFromEnv(
  env: Record<string, string>
): ClaudeCodeAuthOptions {
  const supported = new Set<string>(SUPPORTED_AUTH_VARS);
  const unsupported = Object.keys(env).filter((name) => !supported.has(name));
  if (unsupported.length > 0) {
    throw new CapabilityMismatchError(
      `ai-sdk harness backend cannot deliver env vars [${unsupported.join(", ")}] ` +
        `to the agent runtime; supported: ${SUPPORTED_AUTH_VARS.join(", ")}`
    );
  }

  if (env.AI_GATEWAY_API_KEY) {
    return {
      gateway: {
        apiKey: env.AI_GATEWAY_API_KEY,
        baseUrl: env.AI_GATEWAY_BASE_URL || DEFAULT_GATEWAY_BASE_URL
      }
    };
  }

  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    // Empty strings deliberately occupy the unset fields: the adapter's
    // `explicit ?? process.env.*` resolution then never reaches the host
    // environment, and falsy values are not exported to the bridge.
    return {
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY ?? "",
        authToken: env.ANTHROPIC_AUTH_TOKEN ?? "",
        baseUrl: env.ANTHROPIC_BASE_URL ?? ""
      }
    };
  }

  throw new CapabilityMismatchError(
    "claude-code over the ai-sdk harness requires a credential released into the " +
      "session env (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or AI_GATEWAY_API_KEY); " +
      "refusing to fall back to the runner host environment"
  );
}

/**
 * The provider env-var pairs the Pi adapter understands. Pi maps each
 * `<PREFIX>_API_KEY` (with an optional `<PREFIX>_BASE_URL`) to a provider:
 * OPENAI → openai, ANTHROPIC → anthropic, AI_GATEWAY → vercel-ai-gateway.
 * For the swarm's local-model workers the meaningful pair is
 * `OPENAI_BASE_URL` + `OPENAI_API_KEY` pointing at a local OpenAI-compatible
 * endpoint (Ollama / mlx-lm), where the key is typically a dummy value.
 *
 * Pinned here so anything else in the contract's env policy fails closed
 * rather than being silently dropped, exactly like the claude-code path.
 */
const PI_SUPPORTED_AUTH_VARS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
] as const;

/** A `<PREFIX>_API_KEY` is what actually selects a provider for Pi. */
const PI_API_KEY_VARS = [
  "OPENAI_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN"
] as const;

/**
 * Build explicit Pi auth from the session env, fail-closed.
 *
 * Pi's default resolution reaches into the *host* process environment for an
 * AI Gateway key or `VERCEL_OIDC_TOKEN`. On a Warrant runner that would
 * bypass the secret broker, so this always passes an explicit `customEnv`
 * built only from broker-released vars. It fails closed when the env carries
 * a variable Pi cannot honor, and when no provider key is present at all
 * (otherwise Pi would fall back to the host environment).
 */
export function piAuthFromEnv(env: Record<string, string>): PiAuthOptions {
  const supported = new Set<string>(PI_SUPPORTED_AUTH_VARS);
  const unsupported = Object.keys(env).filter((name) => !supported.has(name));
  if (unsupported.length > 0) {
    throw new CapabilityMismatchError(
      `pi over the ai-sdk harness cannot deliver env vars [${unsupported.join(", ")}] ` +
        `to the agent runtime; supported: ${PI_SUPPORTED_AUTH_VARS.join(", ")}`
    );
  }

  const hasKey = PI_API_KEY_VARS.some((name) => env[name]);
  if (!hasKey) {
    throw new CapabilityMismatchError(
      "pi over the ai-sdk harness requires a provider credential released into the " +
        "session env (OPENAI_API_KEY with OPENAI_BASE_URL for a local endpoint, " +
        "ANTHROPIC_API_KEY, or AI_GATEWAY_API_KEY); refusing to fall back to the " +
        "runner host environment"
    );
  }

  // Forward only the recognized, present pairs as resolved customEnv. Pi
  // honors customEnv ahead of any ambient gateway credential, so the host
  // environment is never consulted.
  const customEnv: Record<string, string> = {};
  for (const name of PI_SUPPORTED_AUTH_VARS) {
    if (env[name]) customEnv[name] = env[name];
  }
  return { customEnv };
}
