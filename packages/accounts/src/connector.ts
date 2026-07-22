/**
 * Subscription account connectors.
 *
 * One user-facing account surface (`routekit accounts login <kind>`) is backed
 * by two mechanisms the user never has to distinguish:
 *
 * - `native`: the official provider CLI login captured into RouteKit's own
 *   account store and served by provider-native relays (claude-code, codex).
 * - `cliproxy`: the RouteKit-managed CLIProxyAPI sidecar, whose OAuth account
 *   store and ingress key live under RouteKit's home (gemini, grok, kimi).
 *
 * The registry (`@routekit/registry` connectors section) is the single source
 * of truth for which connector backs which kind.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import {
  ACCOUNT_CONNECTORS,
  accountKindForCliproxyAuthType,
  accountKinds,
  resolveAccountConnector
} from "@routekit/registry";
import type { AccountConnector } from "@routekit/registry";
import { superviseSpawn } from "@routekit/runtime";

import {
  CLIPROXY_PINNED_VERSION,
  cliproxyBinaryPath,
  cliproxyConfigPath,
  cliproxyHome,
  ensureCliproxyConfig,
  installCliproxy
} from "./cliproxy.js";

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
};

function cliproxyAuthDirectory(
  env: Readonly<Record<string, string | undefined>>
): string {
  return join(cliproxyHome(env), "auth");
}

/** List enrolled CLIProxyAPI accounts without reading credential values. */
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
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { type?: unknown };
      if (typeof parsed.type === "string" && parsed.type.length > 0) type = parsed.type;
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
    return { kind, label, path };
  });
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
