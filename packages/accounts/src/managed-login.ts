/**
 * Native-connector managed logins.
 *
 * RouteKit gives the official provider CLI (claude / codex) a private
 * temporary profile, runs its login flow, imports only the resulting
 * credential, and removes the temporary profile. The user's normal Claude
 * Code or Codex login is never touched. The captured credential blob is
 * handed to the singleton daemon over its authenticated control channel;
 * this module never writes daemon-owned account state.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { SubscriptionMode } from "@velum-labs/routekit-registry";
import { buildChildEnv, commandOnPath, superviseSpawn } from "@velum-labs/routekit-runtime";

import {
  defaultSubscriptionAccountDirectory,
  sanitizeSubscriptionLabel
} from "./credentials.js";

const execFileAsync = promisify(execFile);

/** Narrow a user-supplied kind to a native subscription kind. */
export function parseAccountMode(value: string): SubscriptionMode {
  switch (value) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      throw new Error("subscription kind must be claude-code or codex");
  }
}

export type ManagedAccountLoginInvocation = {
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  profileDirectory: string;
  sourcePath: string;
};

export type ManagedLoginKeychain = {
  read(service: string): Promise<string>;
  remove(service: string): Promise<void>;
};

export type ManagedAccountLoginOptions = {
  temporaryParent?: string;
  /**
   * Prefer a browserless login flow: Codex uses its device-code flow
   * (`codex login --device-auth`); Claude Code already falls back to a
   * copyable URL + pasted code when no browser can open.
   */
  noBrowser?: boolean;
  runLogin?: (invocation: ManagedAccountLoginInvocation) => Promise<number>;
  platform?: NodeJS.Platform;
  keychain?: ManagedLoginKeychain;
};

function managedLoginInvocation(
  subscriptionKind: SubscriptionMode,
  profileDirectory: string,
  options: { noBrowser?: boolean } = {}
): ManagedAccountLoginInvocation {
  const shared = { profileDirectory };
  switch (subscriptionKind) {
    case "claude-code":
      return {
        command: "claude",
        args: ["auth", "login", "--claudeai"],
        ...shared,
        env: buildChildEnv({
          extra: {
            CLAUDE_CONFIG_DIR: profileDirectory,
            DISABLE_AUTOUPDATER: "1",
            DISABLE_UPDATES: "1"
          }
        }),
        sourcePath: join(profileDirectory, ".credentials.json")
      };
    case "codex":
      return {
        command: "codex",
        args: options.noBrowser === true ? ["login", "--device-auth"] : ["login"],
        ...shared,
        env: buildChildEnv({ extra: { CODEX_HOME: profileDirectory } }),
        sourcePath: join(profileDirectory, "auth.json")
      };
    default: {
      const exhaustive: never = subscriptionKind;
      throw new Error(`unsupported subscription kind: ${String(exhaustive)}`);
    }
  }
}

export function claudeProfileKeychainService(profileDirectory: string): string {
  const suffix = createHash("sha256")
    .update(profileDirectory)
    .digest("hex")
    .slice(0, 8);
  return `Claude Code-credentials-${suffix}`;
}

function systemKeychain(): ManagedLoginKeychain {
  const account = userInfo().username;
  return {
    read: async (service) => {
      try {
        const result = await execFileAsync("/usr/bin/security", [
          "find-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-w"
        ]);
        const value = String(result.stdout).trim();
        if (value.length === 0) throw new Error("empty credential");
        return value;
      } catch {
        throw new Error(`Claude login did not create the isolated Keychain item ${service}`);
      }
    },
    remove: async (service) => {
      try {
        await execFileAsync("/usr/bin/security", [
          "delete-generic-password",
          "-s",
          service,
          "-a",
          account
        ]);
      } catch {
        throw new Error(`could not remove the temporary Claude Keychain item ${service}`);
      }
    }
  };
}

function prepareManagedLoginProfile(
  subscriptionKind: SubscriptionMode,
  profileDirectory: string
): void {
  if (subscriptionKind !== "codex") return;
  const configPath = join(profileDirectory, "config.toml");
  writeFileSync(configPath, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

async function materializeManagedCredential(
  subscriptionKind: SubscriptionMode,
  invocation: ManagedAccountLoginInvocation,
  hostPlatform: NodeJS.Platform,
  keychain: ManagedLoginKeychain
): Promise<void> {
  if (existsSync(invocation.sourcePath)) return;
  if (subscriptionKind !== "claude-code" || hostPlatform !== "darwin") return;
  const service = claudeProfileKeychainService(invocation.profileDirectory);
  const blob = await keychain.read(service);
  writeFileSync(invocation.sourcePath, `${blob}\n`, { mode: 0o600 });
  chmodSync(invocation.sourcePath, 0o600);
  try {
    await keychain.remove(service);
  } catch (error) {
    rmSync(invocation.sourcePath, { force: true });
    throw error;
  }
}

async function spawnManagedLogin(
  invocation: ManagedAccountLoginInvocation
): Promise<number> {
  if (!commandOnPath(invocation.command, invocation.env)) {
    throw new Error(
      `${invocation.command} is not installed or is not on PATH; install the official CLI and retry`
    );
  }
  const spawned = superviseSpawn(invocation.command, invocation.args, {
    stdio: "inherit",
    env: { ...invocation.env }
  });
  const result = await spawned.done;
  if (result.signal !== null) {
    throw new Error(`${invocation.command} login terminated by ${result.signal}`);
  }
  return result.exitCode ?? 1;
}

/**
 * Run the interactive provider login in an isolated local profile and return
 * the credential blob instead of writing RouteKit state. The singleton daemon
 * is the sole account-store writer; the thin CLI sends this blob over its
 * authenticated control channel.
 */
export async function captureLoginCredential(
  subscriptionKindInput: string,
  label: string,
  options: ManagedAccountLoginOptions = {}
): Promise<{
  subscriptionKind: SubscriptionMode;
  label: string;
  credential: unknown;
}> {
  const subscriptionKind = parseAccountMode(subscriptionKindInput);
  const normalizedLabel = sanitizeSubscriptionLabel(label);
  if (normalizedLabel !== label || label.startsWith(".")) {
    throw new Error(
      "account name must be lowercase and contain only letters, numbers, dots, underscores, or hyphens"
    );
  }
  const target = join(
    defaultSubscriptionAccountDirectory(subscriptionKind),
    `${normalizedLabel}.json`
  );
  if (existsSync(target)) {
    throw new Error(
      `${subscriptionKind}/${normalizedLabel} is already enrolled; remove it before logging in again`
    );
  }
  const temporaryDirectory = mkdtempSync(
    join(options.temporaryParent ?? tmpdir(), "routekit-account-login-")
  );
  chmodSync(temporaryDirectory, 0o700);
  const profilePath = join(temporaryDirectory, subscriptionKind);
  mkdirSync(profilePath, { mode: 0o700 });
  const profileDirectory = realpathSync(profilePath);
  prepareManagedLoginProfile(subscriptionKind, profileDirectory);
  const invocation = managedLoginInvocation(subscriptionKind, profileDirectory, {
    ...(options.noBrowser !== undefined ? { noBrowser: options.noBrowser } : {})
  });
  try {
    const code = await (options.runLogin ?? spawnManagedLogin)(invocation);
    if (code !== 0) throw new Error(`${invocation.command} login exited with code ${code}`);
    await materializeManagedCredential(
      subscriptionKind,
      invocation,
      options.platform ?? platform(),
      options.keychain ?? systemKeychain()
    );
    if (!existsSync(invocation.sourcePath)) {
      throw new Error(
        `${invocation.command} login completed without creating ${invocation.sourcePath}`
      );
    }
    return {
      subscriptionKind,
      label: normalizedLabel,
      credential: JSON.parse(readFileSync(invocation.sourcePath, "utf8")) as unknown
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
