import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { routekitHome } from "@velum-labs/routekit-config";
import {
  isLoopbackHost,
  trimTrailingSlashes,
  writeFileAtomic
} from "@velum-labs/routekit-runtime";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "routekit-remote";

export type RouteKitRemote = {
  name: string;
  gatewayUrl: string;
  sshHost: string;
  addedAt: string;
};

export type RemoteRegistry = {
  version: 1;
  active?: string;
  remotes: RouteKitRemote[];
};

function emptyRegistry(): RemoteRegistry {
  return { version: 1, remotes: [] };
}

export function remotesPath(): string {
  return join(routekitHome(), "remotes.json");
}

export function remoteTokenPath(name: string): string {
  return join(routekitHome(), "secrets", `remote-${name}`);
}

export function validateRemoteName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new Error(
      "remote names must start with a letter or number and contain only letters, numbers, ., _, or -"
    );
  }
}

export function validateSshHost(host: string): void {
  if (
    host.length === 0 ||
    host.length > 255 ||
    host.startsWith("-") ||
    !/^[a-z0-9_.@%:+\[\]-]+$/i.test(host)
  ) {
    throw new Error("SSH host must be a host name, user@host destination, or configured SSH alias");
  }
}

export function normalizeRemoteUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("remote gateway URLs must not contain credentials");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(hostname))
  ) {
    throw new Error("remote gateways require HTTPS unless they use a loopback host");
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("remote gateway URLs must not contain a query string or fragment");
  }
  return trimTrailingSlashes(url.toString());
}

function parseRegistry(value: unknown): RemoteRegistry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid RouteKit remote registry: ${remotesPath()}`);
  }
  const raw = value as { version?: unknown; active?: unknown; remotes?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.remotes)) {
    throw new Error(`unsupported RouteKit remote registry: ${remotesPath()}`);
  }
  const remotes = raw.remotes.map((entry): RouteKitRemote => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`invalid RouteKit remote entry: ${remotesPath()}`);
    }
    const remote = entry as Record<string, unknown>;
    if (
      typeof remote.name !== "string" ||
      typeof remote.gatewayUrl !== "string" ||
      typeof remote.sshHost !== "string" ||
      typeof remote.addedAt !== "string"
    ) {
      throw new Error(`invalid RouteKit remote entry: ${remotesPath()}`);
    }
    validateRemoteName(remote.name);
    validateSshHost(remote.sshHost);
    return {
      name: remote.name,
      gatewayUrl: normalizeRemoteUrl(remote.gatewayUrl),
      sshHost: remote.sshHost,
      addedAt: remote.addedAt
    };
  });
  if (new Set(remotes.map((remote) => remote.name)).size !== remotes.length) {
    throw new Error(`RouteKit remote names must be unique: ${remotesPath()}`);
  }
  const active = typeof raw.active === "string" ? raw.active : undefined;
  if (active !== undefined && !remotes.some((remote) => remote.name === active)) {
    throw new Error(`active RouteKit remote does not exist: ${active}`);
  }
  return { version: 1, remotes, ...(active !== undefined ? { active } : {}) };
}

export function readRemoteRegistry(): RemoteRegistry {
  const path = remotesPath();
  if (!existsSync(path)) return emptyRegistry();
  return parseRegistry(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export function writeRemoteRegistry(registry: RemoteRegistry): void {
  const path = remotesPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify(parseRegistry(registry), null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(path, 0o600);
}

export function findRemote(name: string): RouteKitRemote | undefined {
  return readRemoteRegistry().remotes.find((remote) => remote.name === name);
}

export function activeRemote(): RouteKitRemote | undefined {
  const registry = readRemoteRegistry();
  return registry.active === undefined
    ? undefined
    : registry.remotes.find((remote) => remote.name === registry.active);
}

export function putRemote(remote: RouteKitRemote, activate = true): void {
  validateRemoteName(remote.name);
  validateSshHost(remote.sshHost);
  const registry = readRemoteRegistry();
  const remotes = registry.remotes.filter((entry) => entry.name !== remote.name);
  remotes.push({ ...remote, gatewayUrl: normalizeRemoteUrl(remote.gatewayUrl) });
  remotes.sort((left, right) => left.name.localeCompare(right.name));
  writeRemoteRegistry({
    version: 1,
    remotes,
    ...(activate
      ? { active: remote.name }
      : registry.active !== undefined
        ? { active: registry.active }
        : {})
  });
}

export function useRemote(name: string | undefined): void {
  const registry = readRemoteRegistry();
  if (name !== undefined && !registry.remotes.some((remote) => remote.name === name)) {
    throw new Error(`unknown RouteKit remote: ${name}`);
  }
  writeRemoteRegistry({
    version: 1,
    remotes: registry.remotes,
    ...(name !== undefined ? { active: name } : {})
  });
}

export async function removeRemote(
  name: string,
  credentialOptions: RemoteCredentialOptions = {}
): Promise<boolean> {
  const registry = readRemoteRegistry();
  const remotes = registry.remotes.filter((remote) => remote.name !== name);
  if (remotes.length === registry.remotes.length) return false;
  await deleteRemoteToken(name, credentialOptions);
  writeRemoteRegistry({
    version: 1,
    remotes,
    ...(registry.active !== name && registry.active !== undefined
      ? { active: registry.active }
      : {})
  });
  return true;
}

async function keychain(args: readonly string[]): Promise<string> {
  const result = await execFileAsync("security", [...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  return result.stdout.trim();
}

export type RemoteCredentialOptions = {
  platform?: NodeJS.Platform;
  runKeychain?: (args: readonly string[]) => Promise<string>;
};

export async function writeRemoteToken(
  name: string,
  token: string,
  options: RemoteCredentialOptions = {}
): Promise<void> {
  validateRemoteName(name);
  if (token.trim().length === 0) throw new Error("remote gateway token is empty");
  if ((options.platform ?? process.platform) === "darwin") {
    try {
      await (options.runKeychain ?? keychain)([
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        name,
        "-w",
        token.trim()
      ]);
    } catch {
      throw new Error(`could not store the gateway token for remote "${name}" in Keychain`);
    }
    return;
  }
  const path = remoteTokenPath(name);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export async function readRemoteToken(
  name: string,
  options: RemoteCredentialOptions = {}
): Promise<string | undefined> {
  validateRemoteName(name);
  if ((options.platform ?? process.platform) === "darwin") {
    try {
      const token = await (options.runKeychain ?? keychain)([
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        name,
        "-w"
      ]);
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  }
  const path = remoteTokenPath(name);
  if (!existsSync(path)) return undefined;
  const token = readFileSync(path, "utf8").trim();
  return token.length > 0 ? token : undefined;
}

export async function deleteRemoteToken(
  name: string,
  options: RemoteCredentialOptions = {}
): Promise<void> {
  validateRemoteName(name);
  if ((options.platform ?? process.platform) === "darwin") {
    try {
      await (options.runKeychain ?? keychain)([
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        name
      ]);
    } catch (error) {
      const candidate = error as { stderr?: string | Buffer };
      const stderr = typeof candidate.stderr === "string"
        ? candidate.stderr
        : Buffer.isBuffer(candidate.stderr)
          ? candidate.stderr.toString("utf8")
          : "";
      if (/could not be found|specified item.*not.*found/i.test(stderr)) return;
      throw new Error(`could not delete the gateway token for remote "${name}" from Keychain`);
    }
    return;
  }
  const path = remoteTokenPath(name);
  if (existsSync(path)) unlinkSync(path);
}
