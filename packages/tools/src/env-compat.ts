/**
 * FusionKit environment variable helpers. Read canonical `FUSIONKIT_*` names
 * through these helpers; legacy `WARRANT_*` names are no longer honored.
 */

type Env = Record<string, string | undefined>;

/** Read a canonical `FUSIONKIT_*` env var. */
export function readEnv(env: Env, name: string): string | undefined {
  return env[name];
}

/** True when the env flag is set to `1`/`true`. */
export function envFlagEnabled(env: Env, name: string): boolean {
  const value = readEnv(env, name);
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * The cutover flag: when set, tool integrations resolve their panel harness
 * through the harness-core drivers (native sessions, typed events, resume
 * cursors) instead of the legacy one-shot CLI harnesses. Defaults off so the
 * driver path soaks behind a flag for one release before becoming the default.
 */
export const HARNESS_DRIVERS_FLAG = "FUSIONKIT_HARNESS_DRIVERS";

export function harnessDriversEnabled(env: Env = process.env): boolean {
  return envFlagEnabled(env, HARNESS_DRIVERS_FLAG);
}
