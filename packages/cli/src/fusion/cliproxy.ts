/**
 * Managed lifecycle for a CLIProxyAPI sidecar — the local OpenAI-compatible
 * proxy (github.com/router-for-me/CLIProxyAPI, MIT) that fronts OAuth
 * subscription accounts (Codex, Claude Code, Gemini/Antigravity, Grok, Kimi)
 * with multi-account rotation. FusionKit consumes it as a plain `cliproxy`
 * panel provider; this module owns install (pinned release, SHA-256 verified),
 * the managed config, the OAuth login pass-through, and serving.
 *
 * Everything lives under `~/.fusionkit/cliproxy/`:
 *   bin/<version>/cli-proxy-api   the verified release binary
 *   config.yaml                   managed config (ingress key, auth dir), 0600
 *   auth/                         the proxy's OAuth credential store
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch as osArch, homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

import { cliproxyBaseUrl } from "./env.js";
import { probeOpenAiCompatibleModels } from "./openai-models.js";

const execFileAsync = promisify(execFile);

/** The CLIProxyAPI release this CLI installs (upgrade deliberately, not implicitly). */
export const CLIPROXY_PINNED_VERSION = "7.2.72";

const RELEASE_BASE = "https://github.com/router-for-me/CLIProxyAPI/releases/download";

/** State root (honoring `FUSIONKIT_CLIPROXY_DIR` for tests). */
export function cliproxyHome(): string {
  return process.env.FUSIONKIT_CLIPROXY_DIR ?? join(homedir(), ".fusionkit", "cliproxy");
}

/** The managed config path (`~/.fusionkit/cliproxy/config.yaml`). */
export function cliproxyConfigPath(): string {
  return join(cliproxyHome(), "config.yaml");
}

/** The installed pinned binary, or undefined when not installed yet. */
export function cliproxyBinaryPath(version: string = CLIPROXY_PINNED_VERSION): string | undefined {
  const path = join(cliproxyHome(), "bin", version, "cli-proxy-api");
  return existsSync(path) ? path : undefined;
}

/** The release asset name for this host, or undefined on unsupported platforms. */
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

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The expected sha256 for `asset` from the release's checksums.txt. */
function expectedChecksum(checksums: string, asset: string): string {
  for (const line of checksums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === asset && hash !== undefined) return hash.toLowerCase();
  }
  throw new Error(`release checksums.txt has no entry for ${asset}`);
}

/**
 * The proxy ingress key from the managed config, or undefined when the config
 * does not exist / carries no keys. This is what `CLIPROXY_API_KEY` must equal.
 */
export function cliproxyIngressKey(): string | undefined {
  const path = cliproxyConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as { "api-keys"?: unknown };
    const keys = parsed["api-keys"];
    if (Array.isArray(keys) && typeof keys[0] === "string" && keys[0].length > 0) return keys[0];
  } catch {
    // malformed config: treat as no key rather than crashing status/serve
  }
  return undefined;
}

/**
 * Write the managed config when absent: loopback-only, a generated ingress
 * key, the management API disabled, and the auth store under the managed home.
 * Returns the ingress key (existing or new).
 */
export function ensureCliproxyConfig(): string {
  const existing = cliproxyIngressKey();
  if (existing !== undefined) return existing;
  const home = cliproxyHome();
  mkdirSync(join(home, "auth"), { recursive: true, mode: 0o700 });
  const key = `fk-${randomBytes(16).toString("hex")}`;
  const config = [
    `host: "127.0.0.1"`,
    "port: 8317",
    `auth-dir: "${join(home, "auth")}"`,
    "api-keys:",
    `  - "${key}"`,
    "usage-statistics-enabled: false",
    "remote-management:",
    `  secret-key: ""`,
    "  disable-control-panel: true",
    ""
  ].join("\n");
  writeFileSync(cliproxyConfigPath(), config, { mode: 0o600 });
  chmodSync(cliproxyConfigPath(), 0o600);
  return key;
}

export type CliproxyInstallResult = {
  binary: string;
  version: string;
  /** The ingress key clients must present (also written to the managed config). */
  ingressKey: string;
  /** False when the pinned binary was already present (no download happened). */
  downloaded: boolean;
};

/**
 * Install the pinned CLIProxyAPI release: download the host's asset, verify it
 * against the release's checksums.txt (SHA-256), unpack it into the managed
 * home, and make sure a managed config with an ingress key exists. Idempotent —
 * an already-installed pinned version only ensures the config.
 */
export async function installCliproxy(
  options: { onProgress?: (line: string) => void } = {}
): Promise<CliproxyInstallResult> {
  const progress = options.onProgress ?? ((): void => undefined);
  const version = CLIPROXY_PINNED_VERSION;
  const already = cliproxyBinaryPath(version);
  if (already !== undefined) {
    return { binary: already, version, ingressKey: ensureCliproxyConfig(), downloaded: false };
  }

  const asset = cliproxyAssetName(version);
  if (asset === undefined) {
    throw new Error(
      `CLIProxyAPI has no prebuilt release for ${osPlatform()}/${osArch()} — install it manually ` +
        `and set CLIPROXY_BASE_URL / CLIPROXY_API_KEY instead`
    );
  }

  progress(`downloading ${asset} (v${version})`);
  const [tarball, checksums] = await Promise.all([
    download(`${RELEASE_BASE}/v${version}/${asset}`),
    download(`${RELEASE_BASE}/v${version}/checksums.txt`)
  ]);

  progress("verifying SHA-256");
  const actual = createHash("sha256").update(tarball).digest("hex");
  const expected = expectedChecksum(checksums.toString("utf8"), asset);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}`);
  }

  progress("unpacking");
  const dir = join(cliproxyHome(), "bin", version);
  mkdirSync(dir, { recursive: true });
  const tarballPath = join(dir, asset);
  writeFileSync(tarballPath, tarball);
  await execFileAsync("tar", ["xzf", tarballPath, "-C", dir, "cli-proxy-api"]);
  chmodSync(join(dir, "cli-proxy-api"), 0o755);

  const ingressKey = ensureCliproxyConfig();
  return { binary: join(dir, "cli-proxy-api"), version, ingressKey, downloaded: true };
}

/** The OAuth login providers the pinned CLIProxyAPI supports, -> its CLI flag. */
export const CLIPROXY_LOGIN_FLAGS: Readonly<Record<string, string>> = {
  claude: "-claude-login",
  codex: "-codex-login",
  "codex-device": "-codex-device-login",
  gemini: "-antigravity-login",
  antigravity: "-antigravity-login",
  kimi: "-kimi-login",
  grok: "-xai-login",
  xai: "-xai-login"
};

/**
 * Run the proxy's interactive OAuth login for `provider` (inherited stdio: the
 * binary prints the URL / drives the browser flow itself). Resolves with the
 * binary's exit code.
 */
export async function runCliproxyLogin(
  provider: string,
  options: { noBrowser?: boolean } = {}
): Promise<number> {
  const flag = CLIPROXY_LOGIN_FLAGS[provider];
  if (flag === undefined) {
    throw new Error(
      `unknown login provider ${JSON.stringify(provider)} — expected one of ${Object.keys(CLIPROXY_LOGIN_FLAGS).join(", ")}`
    );
  }
  const binary = cliproxyBinaryPath();
  if (binary === undefined) {
    throw new Error("CLIProxyAPI is not installed — run `fusionkit proxy cliproxy install` first");
  }
  ensureCliproxyConfig();
  const args = ["--config", cliproxyConfigPath(), flag];
  if (options.noBrowser === true) args.push("-no-browser");
  const child = spawn(binary, args, { stdio: "inherit" });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

/** Spawn the managed proxy in the foreground (inherited stdio). */
export function spawnCliproxy(): ReturnType<typeof spawn> {
  const binary = cliproxyBinaryPath();
  if (binary === undefined) {
    throw new Error("CLIProxyAPI is not installed — run `fusionkit proxy cliproxy install` first");
  }
  ensureCliproxyConfig();
  return spawn(binary, ["--config", cliproxyConfigPath()], { stdio: "inherit" });
}

export type CliproxyStatus = {
  installed: boolean;
  version: string;
  baseUrl: string;
  reachable: boolean;
  /** Model count from /v1/models when reachable with a valid key. */
  models?: number;
  /** True when the proxy answered 401/403 (running, but the key is wrong). */
  keyRejected?: boolean;
  /** OAuth credential files in the managed auth store. */
  accounts: string[];
};

/** Probe the managed (or env-pointed) proxy: install state, reachability, accounts. */
export async function cliproxyStatus(): Promise<CliproxyStatus> {
  const baseUrl = cliproxyBaseUrl();
  const key = process.env.CLIPROXY_API_KEY ?? cliproxyIngressKey() ?? "";
  const authDir = join(cliproxyHome(), "auth");
  let accounts: string[] = [];
  try {
    accounts = readdirSync(authDir).filter((name) => name.endsWith(".json"));
  } catch {
    // no managed auth store yet
  }
  const status: CliproxyStatus = {
    installed: cliproxyBinaryPath() !== undefined,
    version: CLIPROXY_PINNED_VERSION,
    baseUrl,
    reachable: false,
    accounts
  };
  const probe = await probeOpenAiCompatibleModels({ baseUrl, apiKey: key, timeoutMs: 2500 });
  switch (probe.kind) {
    case "ok":
      status.reachable = true;
      status.models = probe.models.length;
      break;
    case "unauthorized":
      status.reachable = true;
      status.keyRejected = true;
      break;
    case "http-error":
      status.reachable = true;
      break;
    case "unreachable":
      break;
    default: {
      const exhaustive: never = probe;
      throw new Error(`unknown probe outcome: ${String(exhaustive)}`);
    }
  }
  return status;
}
