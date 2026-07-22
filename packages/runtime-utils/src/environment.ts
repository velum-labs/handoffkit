import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

type EnvInput = Record<string, string | undefined>;

/**
 * True when `command` resolves to an executable: an existing path when it
 * contains a separator, else a match on any `PATH` entry (with Windows
 * `PATHEXT` extensions appended).
 */
export function commandOnPath(
  command: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  // An explicitly passed env is authoritative: the probe must see exactly
  // what the spawn will see. Falling back to the real PATH here would make
  // availability checks pass for binaries the child could never resolve.
  const pathValue = env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry.length > 0)
      : [""];
  return pathValue
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((dir) =>
      exts.some((ext) => existsSync(join(dir, ext.length > 0 ? `${command}${ext}` : command)))
    );
}

export function definedEnv(env: EnvInput): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * System variables every spawned CLI legitimately needs: process resolution,
 * home/config discovery, temp dirs, locale, terminal, TLS trust, and proxies.
 * Deliberately excludes every credential-shaped variable — those must be
 * allowlisted per harness via {@link buildChildEnv}.
 */
const BASELINE_CHILD_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TZ",
  "TERM",
  "COLORTERM",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Windows process resolution and config discovery.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "PROGRAMFILES"
];

const BASELINE_CHILD_ENV_PATTERNS: readonly RegExp[] = [/^LC_/, /^XDG_/];

export type BuildChildEnvInput = {
  /** Source environment (defaults to `process.env`). */
  base?: Record<string, string | undefined>;
  /** Harness-specific names or patterns forwarded in addition to the baseline. */
  allow?: readonly (string | RegExp)[];
  /** Explicit values set unconditionally (win over `base`). */
  extra?: Record<string, string>;
};

/**
 * Build a child environment from an explicit allowlist instead of spreading
 * the entire parent environment: a harness CLI driven headlessly must not
 * inherit every credential the parent process happens to hold. The baseline
 * covers system plumbing (PATH/HOME/locale/TLS/proxy); everything else must be
 * named by the caller.
 */
export function buildChildEnv(input: BuildChildEnvInput = {}): Record<string, string> {
  const base = input.base ?? process.env;
  const names = new Set<string>(BASELINE_CHILD_ENV_NAMES);
  const patterns: RegExp[] = [...BASELINE_CHILD_ENV_PATTERNS];
  for (const entry of input.allow ?? []) {
    if (typeof entry === "string") names.add(entry);
    else patterns.push(entry);
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (names.has(key) || patterns.some((pattern) => pattern.test(key))) {
      result[key] = value;
    }
  }
  Object.assign(result, input.extra ?? {});
  return result;
}

export const DEFAULT_BRIDGE_SCRUB_PREFIXES = [
  "BRIDGE_",
  "MODEL_",
  "CURSOR_UPSTREAM"
] as const;

export function scrubBridgeEnv(
  env: EnvInput,
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
