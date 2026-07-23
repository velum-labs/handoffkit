/**
 * Subscription account connectors.
 *
 * The neutral account layer retains two connector mechanisms:
 *
 * - `native`: the official provider CLI login captured into RouteKit's own
 *   account store and served by provider-native relays (claude-code, codex).
 * - `cliproxy`: the RouteKit-managed CLIProxyAPI sidecar, whose OAuth account
 *   store and ingress key live under RouteKit's home (gemini, grok, kimi).
 *
 * The registry (`@velum-labs/routekit-registry` connectors section) is the single source
 * of truth for which connector backs which kind. RouteKit's public CLI applies
 * a narrower first-launch allowlist; retained connectors are non-contractual.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  ACCOUNT_CONNECTORS,
  accountKindForCliproxyAuthType,
  accountKinds,
  resolveAccountConnector
} from "@velum-labs/routekit-registry";
import type { AccountConnector, SubscriptionMode } from "@velum-labs/routekit-registry";
import { superviseSpawn } from "@velum-labs/routekit-runtime";

import {
  CLIPROXY_PINNED_VERSION,
  cliproxyBinaryPath,
  cliproxyConfigPath,
  cliproxyHome,
  ensureCliproxyConfig,
  installCliproxy,
  writeCliproxyLoginConfig
} from "./cliproxy.js";
import { defaultSubscriptionAccountDirectory } from "./credentials.js";

export type ResolvedAccountKind = {
  /** Canonical kind, e.g. "codex" or "gemini" (aliases resolved). */
  kind: string;
  connector: AccountConnector;
  /** ToS restriction: reverse-engineered upstream, personal/local use only. */
  localOnly: boolean;
  cliproxyLoginFlag?: string;
};

/** Resolve a user-supplied kind or alias, or fail with the accepted kinds. */
export function resolveAccountKind(value: string): ResolvedAccountKind {
  const resolved = resolveAccountConnector(value);
  if (resolved === undefined) {
    throw new Error(
      `unknown subscription kind ${JSON.stringify(value)}; expected one of ${accountKinds().join(", ")}`
    );
  }
  return {
    kind: resolved.kind,
    connector: resolved.info.connector,
    localOnly: resolved.info.localOnly === true,
    ...(resolved.info.cliproxyLoginFlag !== undefined
      ? { cliproxyLoginFlag: resolved.info.cliproxyLoginFlag }
      : {})
  };
}

export type CliproxyAccountEntry = {
  /** Canonical kind when the auth type is recognized, else the raw type. */
  kind: string;
  /** Auth-store file stem; the OAuth identity chosen by the provider. */
  label: string;
  path: string;
  /** Local structural/token check; does not make a provider network request. */
  credentialValid: boolean;
};

export function cliproxyAuthDirectory(
  env: Readonly<Record<string, string | undefined>>
): string {
  return join(cliproxyHome(env), "auth");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function expirationMillis(record: Record<string, unknown>): number | undefined {
  for (const key of [
    "expired",
    "expire",
    "expires_at",
    "expiresAt",
    "expiry",
    "expires"
  ]) {
    const raw = record[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw > 1_000_000_000_000 ? raw : raw * 1_000;
    }
    if (typeof raw === "string" && raw.trim().length > 0) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
      }
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const nested = recordValue(record.token) ?? recordValue(record.Token);
  return nested === undefined ? undefined : expirationMillis(nested);
}

export function cliproxyCredentialValid(
  parsed: Record<string, unknown>,
  type: string | undefined
): boolean {
  const classified =
    type !== undefined &&
    (accountKindForCliproxyAuthType(type) !== undefined ||
      resolveAccountConnector(type) !== undefined);
  if (!classified) return false;
  const token = recordValue(parsed.token) ?? recordValue(parsed.Token);
  const hasAccessToken =
    nonEmptyString(parsed.access_token) || nonEmptyString(token?.access_token);
  const hasRefreshToken =
    nonEmptyString(parsed.refresh_token) || nonEmptyString(token?.refresh_token);
  const expiresAt = expirationMillis(parsed);
  const accessExpired = expiresAt !== undefined && expiresAt <= Date.now();
  return hasRefreshToken || (hasAccessToken && !accessExpired);
}

/** List enrolled CLIProxyAPI accounts without returning credential values. */
export function cliproxyAccountEntries(
  env: Readonly<Record<string, string | undefined>> = process.env
): CliproxyAccountEntry[] {
  const directory = cliproxyAuthDirectory(env);
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const path = join(directory, name);
    let type: string | undefined;
    let credentialValid = false;
    try {
      const parsed = recordValue(JSON.parse(readFileSync(path, "utf8")));
      if (parsed === undefined) throw new Error("auth file must contain an object");
      if (typeof parsed.type === "string" && parsed.type.length > 0) type = parsed.type;
      credentialValid = cliproxyCredentialValid(parsed, type);
    } catch {
      type = undefined;
    }
    const label = name.slice(0, -".json".length);
    const kind =
      (type !== undefined ? accountKindForCliproxyAuthType(type) : undefined) ??
      // Legacy cliproxy logins used raw provider aliases (`claude`, `codex`)
      // that are native kinds today; surface the canonical registry kind.
      (type !== undefined ? resolveAccountConnector(type)?.kind : undefined) ??
      type ??
      label.split("-")[0] ??
      "cliproxy";
    return { kind, label, path, credentialValid };
  });
}

export type AccountStoreEntry =
  | {
      subscriptionKind: SubscriptionMode;
      label: string;
      path: string;
      connector: "native";
    }
  | {
      subscriptionKind: string;
      label: string;
      path: string;
      connector: "cliproxy";
      localOnly: boolean;
      credentialValid: boolean;
    };

function nativeSubscriptionKinds(): SubscriptionMode[] {
  return Object.entries(ACCOUNT_CONNECTORS)
    .filter(([, info]) => info.connector === "native")
    .map(([kind]) => kind as SubscriptionMode);
}

/** Enumerate every RouteKit-owned account store from one shared implementation. */
export function accountStoreEntries(
  env: Readonly<Record<string, string | undefined>> = process.env
): AccountStoreEntry[] {
  const native = nativeSubscriptionKinds().flatMap(
    (subscriptionKind): AccountStoreEntry[] => {
      const directory = defaultSubscriptionAccountDirectory(subscriptionKind, env);
      let names: string[];
      try {
        names = readdirSync(directory)
          .filter((name) => name.endsWith(".json") && !name.startsWith("."))
          .sort();
      } catch {
        return [];
      }
      return names.map((name) => ({
        subscriptionKind,
        label: name.slice(0, -".json".length),
        path: join(directory, name),
        connector: "native"
      }));
    }
  );
  const cliproxy = cliproxyAccountEntries(env).map(
    (entry): AccountStoreEntry => ({
      subscriptionKind: entry.kind,
      label: entry.label,
      path: entry.path,
      connector: "cliproxy",
      localOnly: resolveAccountConnector(entry.kind)?.info.localOnly ?? true,
      credentialValid: entry.credentialValid
    })
  );
  return [...native, ...cliproxy];
}

function authFileFingerprint(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Whether a cliproxy auth-store entry belongs to a canonical account kind.
 * Matches the classified kind and aliases (including legacy orphan files whose
 * raw `type` is an alias of a native kind, e.g. `claude` → `claude-code`).
 */
export function cliproxyAccountMatchesKind(
  entry: CliproxyAccountEntry,
  kind: string
): boolean {
  if (entry.kind === kind) return true;
  return resolveAccountConnector(entry.kind)?.kind === kind;
}

/** Remove one CLIProxyAPI account by its label (auth-store file stem). */
export function removeCliproxyAccount(
  label: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): { removed: boolean; path?: string } {
  const entry = cliproxyAccountEntries(env).find(
    (candidate) => candidate.label === label
  );
  if (entry === undefined) return { removed: false };
  if (basename(entry.path) !== `${label}.json`) return { removed: false };
  rmSync(entry.path, { force: true });
  return { removed: true, path: entry.path };
}

export type CliproxyLoginInvocation = {
  command: string;
  args: readonly string[];
};

export type CliproxyLoginOptions = {
  noBrowser?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
  onProgress?: (line: string) => void;
  runLogin?: (invocation: CliproxyLoginInvocation) => Promise<number>;
};

export type CapturedCliproxyCredential = {
  subscriptionKind: string;
  label: string;
  credential: Record<string, unknown>;
};

async function spawnCliproxyLogin(
  invocation: CliproxyLoginInvocation,
  env: Readonly<Record<string, string | undefined>>
): Promise<number> {
  const spawned = superviseSpawn(invocation.command, invocation.args, {
    stdio: "inherit",
    env: { ...process.env, ...env } as Record<string, string>
  });
  const result = await spawned.done;
  if (result.signal !== null) {
    throw new Error(`CLIProxyAPI login terminated by ${result.signal}`);
  }
  return result.exitCode ?? 1;
}

/**
 * Run CLIProxyAPI OAuth against a disposable auth directory. The returned
 * credential blobs exist only in memory until the authenticated daemon commits
 * them together with provider activation.
 */
export async function captureCliproxyLoginCredentials(
  kindInput: string,
  options: CliproxyLoginOptions & { temporaryParent?: string } = {}
): Promise<{ accounts: CapturedCliproxyCredential[] }> {
  const resolved = resolveAccountKind(kindInput);
  const flag = resolved.cliproxyLoginFlag ?? ACCOUNT_CONNECTORS[resolved.kind]?.cliproxyLoginFlag;
  if (resolved.connector !== "cliproxy" || flag === undefined) {
    throw new Error(`${resolved.kind} is not a cliproxy-backed subscription kind`);
  }
  const env = options.env ?? process.env;
  const installed = await installCliproxy({
    env,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {})
  });
  const temporaryHome = mkdtempSync(
    join(options.temporaryParent ?? tmpdir(), "routekit-cliproxy-login-")
  );
  const isolatedEnv = {
    ...env,
    ROUTEKIT_CLIPROXY_HOME: temporaryHome
  };
  const configPath = join(temporaryHome, "config.yaml");
  writeCliproxyLoginConfig(configPath, cliproxyAuthDirectory(isolatedEnv));
  const invocation: CliproxyLoginInvocation = {
    command: installed.binary,
    args: [
      "--config",
      configPath,
      flag,
      ...(options.noBrowser === true ? ["-no-browser"] : [])
    ]
  };
  try {
    const code = await (options.runLogin !== undefined
      ? options.runLogin(invocation)
      : spawnCliproxyLogin(invocation, isolatedEnv));
    if (code !== 0) throw new Error(`CLIProxyAPI login exited with code ${code}`);
    const entries = cliproxyAccountEntries(isolatedEnv).filter((entry) =>
      cliproxyAccountMatchesKind(entry, resolved.kind)
    );
    if (entries.length === 0) {
      throw new Error("CLIProxyAPI login completed without adding an account");
    }
    return {
      accounts: entries.map((entry) => {
        const parsed = recordValue(JSON.parse(readFileSync(entry.path, "utf8")));
        if (parsed === undefined) {
          throw new Error("CLIProxyAPI login produced an invalid account file");
        }
        return {
          subscriptionKind: resolved.kind,
          label: entry.label,
          credential: parsed
        };
      })
    };
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true });
  }
}

/**
 * Enroll a cliproxy-backed account end to end: install the pinned sidecar
 * binary if missing, run its OAuth login for the kind, and report the
 * accounts the login added to the RouteKit-owned auth store.
 */
export async function loginCliproxyAccount(
  kindInput: string,
  options: CliproxyLoginOptions = {}
): Promise<{ added: CliproxyAccountEntry[] }> {
  const resolved = resolveAccountKind(kindInput);
  const flag = resolved.cliproxyLoginFlag ?? ACCOUNT_CONNECTORS[resolved.kind]?.cliproxyLoginFlag;
  if (resolved.connector !== "cliproxy" || flag === undefined) {
    throw new Error(`${resolved.kind} is not a cliproxy-backed subscription kind`);
  }
  const env = options.env ?? process.env;
  await installCliproxy({
    env,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {})
  });
  const binary = cliproxyBinaryPath(CLIPROXY_PINNED_VERSION, env);
  if (binary === undefined) {
    throw new Error("CLIProxyAPI is not installed");
  }
  ensureCliproxyConfig(env);
  const beforeEntries = cliproxyAccountEntries(env);
  const beforePaths = new Set(beforeEntries.map((entry) => entry.path));
  const beforeFingerprints = new Map(
    beforeEntries.map((entry) => [entry.path, authFileFingerprint(entry.path)])
  );
  const invocation: CliproxyLoginInvocation = {
    command: binary,
    args: [
      "--config",
      cliproxyConfigPath(env),
      flag,
      ...(options.noBrowser === true ? ["-no-browser"] : [])
    ]
  };
  const code = await (options.runLogin !== undefined
    ? options.runLogin(invocation)
    : spawnCliproxyLogin(invocation, env));
  if (code !== 0) throw new Error(`CLIProxyAPI login exited with code ${code}`);
  const after = cliproxyAccountEntries(env);
  const added = after.filter((entry) => !beforePaths.has(entry.path));
  if (added.length > 0) return { added };
  // Re-login often overwrites the same auth file in place; only treat entries
  // whose fingerprint changed as a successful refresh.
  const refreshed = after.filter((entry) => {
    if (!cliproxyAccountMatchesKind(entry, resolved.kind)) return false;
    const previous = beforeFingerprints.get(entry.path);
    return previous !== undefined && authFileFingerprint(entry.path) !== previous;
  });
  if (refreshed.length > 0) return { added: refreshed };
  throw new Error("CLIProxyAPI login completed without adding an account");
}
