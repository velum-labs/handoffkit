import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { arch as osArch, homedir, platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { trimTrailingSlashes, writeFileAtomic } from "@velum-labs/routekit-runtime";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);

export const CLIPROXY_PINNED_VERSION = "7.2.72";
export const CLIPROXY_API_KEY_ENV = "ROUTEKIT_CLIPROXY_API_KEY";
export const CLIPROXY_BASE_URL_ENV = "ROUTEKIT_CLIPROXY_BASE_URL";
export const CLIPROXY_HOME_ENV = "ROUTEKIT_CLIPROXY_HOME";

const RELEASE_BASE = "https://github.com/router-for-me/CLIProxyAPI/releases/download";

export function cliproxyHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir()
): string {
  const explicit = env[CLIPROXY_HOME_ENV];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const stateHome = env.ROUTEKIT_HOME;
  return join(
    stateHome !== undefined && stateHome.length > 0 ? stateHome : join(home, ".routekit"),
    "cliproxy"
  );
}

export function cliproxyBaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const override = env[CLIPROXY_BASE_URL_ENV];
  if (override !== undefined && override.length > 0) return trimTrailingSlashes(override);
  return `http://127.0.0.1:${cliproxyManagedPort(env) ?? 8317}`;
}

export function cliproxyConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return join(cliproxyHome(env), "config.yaml");
}

/** The listen port of the RouteKit-managed sidecar config, when present. */
export function cliproxyManagedPort(
  env: Readonly<Record<string, string | undefined>> = process.env
): number | undefined {
  const path = cliproxyConfigPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as { port?: unknown };
    return typeof parsed.port === "number" && Number.isInteger(parsed.port)
      ? parsed.port
      : undefined;
  } catch {
    return undefined;
  }
}

export function cliproxyBinaryPath(
  version: string = CLIPROXY_PINNED_VERSION,
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const path = join(cliproxyHome(env), "bin", version, "cli-proxy-api");
  return existsSync(path) ? path : undefined;
}

export function cliproxyAssetName(
  version: string = CLIPROXY_PINNED_VERSION,
  platform: NodeJS.Platform = osPlatform(),
  arch: string = osArch()
): string | undefined {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "amd64" : undefined;
  if (os === undefined || cpu === undefined) return undefined;
  return `CLIProxyAPI_${version}_${os}_${cpu}.tar.gz`;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function expectedChecksum(checksums: string, asset: string): string {
  for (const line of checksums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && hash !== undefined) return hash.toLowerCase();
  }
  throw new Error(`release checksums.txt has no entry for ${asset}`);
}

export function cliproxyApiKey(
  env: Readonly<Record<string, string | undefined>> = process.env
): string | undefined {
  const path = cliproxyConfigPath(env);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as { "api-keys"?: unknown };
    const keys = parsed["api-keys"];
    return Array.isArray(keys) && typeof keys[0] === "string" && keys[0].length > 0
      ? keys[0]
      : undefined;
  } catch {
    return undefined;
  }
}

export function ensureCliproxyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const existing = cliproxyApiKey(env);
  if (existing !== undefined) return cliproxyConfigPath(env);
  const home = cliproxyHome(env);
  const authDirectory = join(home, "auth");
  mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  chmodSync(authDirectory, 0o700);
  const key = `rk-${randomBytes(16).toString("hex")}`;
  const config = [
    'host: "127.0.0.1"',
    "port: 8317",
    `auth-dir: "${authDirectory}"`,
    "api-keys:",
    `  - "${key}"`,
    "usage-statistics-enabled: false",
    "remote-management:",
    '  secret-key: ""',
    "  disable-control-panel: true",
    ""
  ].join("\n");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  writeFileAtomic(cliproxyConfigPath(env), config, { mode: 0o600 });
  chmodSync(cliproxyConfigPath(env), 0o600);
  return cliproxyConfigPath(env);
}

/**
 * Write a short-lived CLIProxyAPI login config whose auth store is isolated
 * from the daemon-owned store. The login command exits without serving this
 * port; the random ingress key is only required by CLIProxyAPI's config parser.
 */
export function writeCliproxyLoginConfig(path: string, authDirectory: string): string {
  mkdirSync(authDirectory, { recursive: true, mode: 0o700 });
  chmodSync(authDirectory, 0o700);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const config = [
    'host: "127.0.0.1"',
    "port: 8317",
    `auth-dir: "${authDirectory}"`,
    "api-keys:",
    `  - "rk-login-${randomBytes(16).toString("hex")}"`,
    "usage-statistics-enabled: false",
    "remote-management:",
    '  secret-key: ""',
    "  disable-control-panel: true",
    ""
  ].join("\n");
  writeFileAtomic(path, config, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export type CliproxyInstallResult = {
  binary: string;
  version: string;
  configPath: string;
  downloaded: boolean;
};

export async function installCliproxy(
  options: {
    onProgress?: (line: string) => void;
    env?: Readonly<Record<string, string | undefined>>;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<CliproxyInstallResult> {
  const env = options.env ?? process.env;
  const progress = options.onProgress ?? ((): void => undefined);
  const version = CLIPROXY_PINNED_VERSION;
  const already = cliproxyBinaryPath(version, env);
  if (already !== undefined) {
    return {
      binary: already,
      version,
      configPath: ensureCliproxyConfig(env),
      downloaded: false
    };
  }
  const asset = cliproxyAssetName(version);
  if (asset === undefined) {
    throw new Error(
      `CLIProxyAPI has no prebuilt release for ${osPlatform()}/${osArch()}; install it manually or set ${CLIPROXY_BASE_URL_ENV}`
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  progress(`downloading ${asset} (v${version})`);
  const [tarball, checksums] = await Promise.all([
    download(`${RELEASE_BASE}/v${version}/${asset}`, fetchImpl),
    download(`${RELEASE_BASE}/v${version}/checksums.txt`, fetchImpl)
  ]);
  progress("verifying SHA-256");
  const actual = createHash("sha256").update(tarball).digest("hex");
  const expected = expectedChecksum(checksums.toString("utf8"), asset);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }
  progress("unpacking");
  const directory = join(cliproxyHome(env), "bin", version);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tarballPath = join(directory, asset);
  writeFileSync(tarballPath, tarball, { mode: 0o600 });
  await execFileAsync("tar", ["xzf", tarballPath, "-C", directory, "cli-proxy-api"]);
  const binary = join(directory, "cli-proxy-api");
  chmodSync(binary, 0o755);
  return {
    binary,
    version,
    configPath: ensureCliproxyConfig(env),
    downloaded: true
  };
}

export function spawnCliproxy(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { stdio?: "inherit" | "ignore" } = {}
): ReturnType<typeof spawn> {
  const binary = cliproxyBinaryPath(CLIPROXY_PINNED_VERSION, env);
  if (binary === undefined) {
    throw new Error("CLIProxyAPI is not installed for this retained internal connector");
  }
  ensureCliproxyConfig(env);
  return spawn(binary, ["--config", cliproxyConfigPath(env)], {
    stdio: options.stdio ?? "inherit"
  });
}

export type CliproxyStatus = {
  installed: boolean;
  version: string;
  baseUrl: string;
  configPath: string;
  reachable: boolean;
  models?: number;
  keyRejected?: boolean;
  accounts: string[];
};

export async function cliproxyStatus(
  options: {
    env?: Readonly<Record<string, string | undefined>>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
): Promise<CliproxyStatus> {
  const env = options.env ?? process.env;
  const baseUrl = cliproxyBaseUrl(env);
  const key = env[CLIPROXY_API_KEY_ENV] ?? cliproxyApiKey(env) ?? "";
  const authDirectory = join(cliproxyHome(env), "auth");
  let accounts: string[] = [];
  try {
    accounts = readdirSync(authDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort();
  } catch {
    accounts = [];
  }
  const status: CliproxyStatus = {
    installed: cliproxyBinaryPath(CLIPROXY_PINNED_VERSION, env) !== undefined,
    version: CLIPROXY_PINNED_VERSION,
    baseUrl,
    configPath: cliproxyConfigPath(env),
    reachable: false,
    accounts
  };
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 2_500)
    });
    status.reachable = true;
    if (response.status === 401 || response.status === 403) {
      status.keyRejected = true;
    } else if (response.ok) {
      const body = await response.json() as { data?: unknown };
      status.models = Array.isArray(body.data) ? body.data.length : 0;
    }
  } catch {
    status.reachable = false;
  }
  return status;
}
