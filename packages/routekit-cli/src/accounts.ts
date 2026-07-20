import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { platform, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  defaultSubscriptionAccountDirectory,
  enrollCurrentSubscription,
  loadSubscriptionCredential,
  removeSubscriptionAccount,
  sanitizeSubscriptionLabel,
  startSubscriptionProxy,
  SubscriptionProxyClient
} from "@routekit/accounts";
import type {
  SubscriptionSelectionStrategy,
  SubscriptionUsageResponse
} from "@routekit/accounts";
import type { SubscriptionMode } from "@routekit/registry";
import type { RouterConfig } from "@routekit/gateway";
import {
  buildChildEnv,
  commandOnPath,
  registerCleanup,
  superviseSpawn
} from "@routekit/runtime";

import { readServiceRecord, registerService, stopService } from "./state.js";

const execFileAsync = promisify(execFile);

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

export type AccountListEntry = {
  subscriptionKind: SubscriptionMode;
  /** @deprecated Use subscriptionKind. */
  provider: SubscriptionMode;
  label: string;
  path: string;
};

export function listAccounts(): AccountListEntry[] {
  const subscriptionKinds: readonly SubscriptionMode[] = ["claude-code", "codex"];
  return subscriptionKinds.flatMap((subscriptionKind) => {
    const directory = defaultSubscriptionAccountDirectory(subscriptionKind);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .map((name) => ({
        subscriptionKind,
        provider: subscriptionKind,
        label: name.slice(0, -".json".length),
        path: join(directory, name)
      }));
  });
}

export async function addAccount(
  subscriptionKindInput: string,
  label?: string
): Promise<AccountListEntry> {
  const subscriptionKind = parseAccountMode(subscriptionKindInput);
  const path = await enrollCurrentSubscription(subscriptionKind, {
    ...(label !== undefined ? { label } : {})
  });
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return {
    subscriptionKind,
    provider: subscriptionKind,
    label: name.endsWith(".json") ? name.slice(0, -".json".length) : name,
    path
  };
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
  runLogin?: (invocation: ManagedAccountLoginInvocation) => Promise<number>;
  platform?: NodeJS.Platform;
  keychain?: ManagedLoginKeychain;
  enroll?: (input: {
    subscriptionKind: SubscriptionMode;
    label: string;
    sourcePath: string;
  }) => Promise<AccountListEntry>;
};

function managedLoginInvocation(
  subscriptionKind: SubscriptionMode,
  profileDirectory: string
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
        args: ["login"],
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

export async function loginAccount(
  subscriptionKindInput: string,
  label: string,
  options: ManagedAccountLoginOptions = {}
): Promise<AccountListEntry> {
  const subscriptionKind = parseAccountMode(subscriptionKindInput);
  const normalizedLabel = sanitizeSubscriptionLabel(label);
  if (normalizedLabel !== label) {
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
  const invocation = managedLoginInvocation(subscriptionKind, profileDirectory);
  try {
    const code = await (options.runLogin ?? spawnManagedLogin)(invocation);
    if (code !== 0) {
      throw new Error(`${invocation.command} login exited with code ${code}`);
    }
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
    return options.enroll !== undefined
      ? await options.enroll({
          subscriptionKind,
          label: normalizedLabel,
          sourcePath: invocation.sourcePath
        })
      : {
          subscriptionKind,
          provider: subscriptionKind,
          label: normalizedLabel,
          path: await enrollCurrentSubscription(subscriptionKind, {
            label: normalizedLabel,
            sourcePath: invocation.sourcePath
          })
        };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function removeAccount(subscriptionKindInput: string, label: string) {
  return removeSubscriptionAccount(parseAccountMode(subscriptionKindInput), label);
}

export type AccountsStatus = {
  running: boolean;
  url?: string;
  pid?: number;
  usage?: SubscriptionUsageResponse;
  accounts: Array<
    AccountListEntry & {
      credentialValid: boolean;
      configured: boolean;
      relayOpen: boolean;
    }
  >;
};

export async function accountsStatus(config?: RouterConfig): Promise<AccountsStatus> {
  const record = readServiceRecord("accounts");
  const accounts = await Promise.all(
    listAccounts().map(async (entry) => {
      let credentialValid = false;
      try {
        await loadSubscriptionCredential(entry.subscriptionKind, entry.path);
        credentialValid = true;
      } catch {
        credentialValid = false;
      }
      const configured =
        config?.providers[entry.subscriptionKind] !== undefined;
      return {
        ...entry,
        credentialValid,
        configured,
        relayOpen: configured && credentialValid
      };
    })
  );
  if (record === undefined) return { running: false, accounts };
  let usage: SubscriptionUsageResponse | undefined;
  if (record.authToken !== undefined) {
    try {
      usage = await SubscriptionProxyClient.open({
        baseUrl: record.url,
        token: record.authToken
      }).usage();
    } catch {
      usage = undefined;
    }
  }
  return {
    running: true,
    url: record.url,
    pid: record.pid,
    ...(usage !== undefined ? { usage } : {}),
    accounts
  };
}

export async function serveAccounts(input: {
  host?: string;
  port?: number;
  token?: string;
  strategy?: SubscriptionSelectionStrategy;
  switchThreshold?: number;
  probeIntervalMs?: number;
  portless?: boolean;
}): Promise<{ url: string; providers: readonly string[]; close(): Promise<void> }> {
  const policy = {
    source: { kind: "auto" as const },
    strategy: input.strategy ?? "sticky",
    switchThreshold: input.switchThreshold ?? 0.9,
    ...(input.probeIntervalMs !== undefined ? { probeIntervalMs: input.probeIntervalMs } : {})
  };
  const proxy = await startSubscriptionProxy({
    accounts: { "claude-code": policy, codex: policy },
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(input.token !== undefined ? { token: input.token } : {})
  });
  const registration = await registerService({
    kind: "accounts",
    loopbackUrl: proxy.url(),
    port: proxy.port(),
    authToken: proxy.token,
    ...(input.portless !== undefined ? { portless: input.portless } : {})
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await registration.release();
    await proxy.close();
  };
  registerCleanup(close);
  return { url: registration.url, providers: proxy.providers, close };
}

export async function stopAccounts(): Promise<ReturnType<typeof stopService> extends Promise<infer T> ? T : never> {
  return await stopService("accounts");
}
