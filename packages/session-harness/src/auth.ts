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
import { CapabilityMismatchError } from "@warrant/runner";

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
