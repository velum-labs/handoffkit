/**
 * Naming compatibility: the project is standardizing on `FUSIONKIT_*` env vars
 * but still accepts the legacy `WARRANT_*` names. Read canonical names through
 * these helpers so both keep working; prefer the canonical name in new code,
 * docs, and help text.
 */

const CANONICAL_ENV_PREFIX = "FUSIONKIT_";
const LEGACY_ENV_PREFIX = "WARRANT_";

type Env = Record<string, string | undefined>;

/** The legacy `WARRANT_*` spelling of a canonical `FUSIONKIT_*` name, if any. */
export function legacyEnvName(name: string): string | undefined {
  return name.startsWith(CANONICAL_ENV_PREFIX)
    ? LEGACY_ENV_PREFIX + name.slice(CANONICAL_ENV_PREFIX.length)
    : undefined;
}

/** Read a canonical `FUSIONKIT_*` env var, falling back to the legacy `WARRANT_*` name. */
export function readEnv(env: Env, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const legacy = legacyEnvName(name);
  return legacy !== undefined ? env[legacy] : undefined;
}

/** True when the canonical or legacy env flag is set to `1`/`true`. */
export function envFlagEnabled(env: Env, name: string): boolean {
  const value = readEnv(env, name);
  return value === "1" || value?.toLowerCase() === "true";
}
