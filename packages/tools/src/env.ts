/** Shared environment helpers used by the per-tool harness/launch packages. */

type ToolEnv = Record<string, string | undefined>;

/** Drop `undefined` values so the result is a concrete `Record<string,string>`. */
export function definedEnv(env: ToolEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Ensure an OpenAI-style base URL ends in `/v1` (trimming trailing slashes). */
export function normalizeApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Default env prefixes scrubbed before spawning a Cursorkit bridge. */
export const DEFAULT_BRIDGE_SCRUB_PREFIXES = [
  "BRIDGE_",
  "MODEL_",
  "CURSOR_UPSTREAM"
] as const;

/**
 * Copy `env` dropping `undefined` values and any key starting with one of
 * `prefixes`, so a parent's leftover bridge/model config never leaks into a
 * freshly spawned bridge process.
 */
export function scrubBridgeEnv(
  env: ToolEnv,
  prefixes: readonly string[] = DEFAULT_BRIDGE_SCRUB_PREFIXES
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
}
