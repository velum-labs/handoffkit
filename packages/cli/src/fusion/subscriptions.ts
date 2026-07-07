/**
 * Read-only detection of the user's local Claude Code / Codex CLI logins, used
 * by `fusionkit init` to offer a subscriptions panel. Mirrors FusionKit's Python
 * `subscription_status`: we never read or print the token itself, only whether a
 * login exists, whether it is expired, and (for codex) the account id + pinned
 * model. FusionKit does the real auth at run time.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

import { SUBSCRIPTIONS } from "@fusionkit/registry";
import { superviseSpawn } from "@fusionkit/runtime-utils";

import type { PanelAuthMode } from "./env.js";

const CLAUDE_KEYCHAIN_SERVICE = SUBSCRIPTIONS["claude-code"].keychainService ?? "";

/** Expand a registry `~/`-prefixed credential path against the current $HOME. */
function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

// Paths are computed lazily (not module constants) so they honor the current
// `$HOME` — which keeps detection testable with a temp home directory. The
// locations come from the subscription registry, shared with
// fusionkit_core.credentials on the Python side.
const claudeCredentialsPath = (): string => expandHome(SUBSCRIPTIONS["claude-code"].credentialsPath);
const codexAuthPath = (): string => expandHome(SUBSCRIPTIONS.codex.credentialsPath);
const codexConfigPath = (): string => expandHome(SUBSCRIPTIONS.codex.configPath ?? "~/.codex/config.toml");

/** Default subscription models: registry subscription metadata. */
export const DEFAULT_CLAUDE_SUB_MODEL = SUBSCRIPTIONS["claude-code"].defaultModel;
/** detectCodexModel() is the runtime override; this is the registry fallback. */
export const DEFAULT_CODEX_MODEL = SUBSCRIPTIONS.codex.defaultModel;

export type SubscriptionStatus = {
  mode: PanelAuthMode;
  available: boolean;
  expired: boolean;
  expiresAt?: number;
  accountId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode a JWT payload (no signature check). Returns {} on any problem. */
function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  const payload = parts[1];
  if (payload === undefined) return {};
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims: unknown = JSON.parse(json);
    return isRecord(claims) ? claims : {};
  } catch {
    return {};
  }
}

async function readMacosKeychain(service: string): Promise<string | undefined> {
  if (platform() !== "darwin") return undefined;
  try {
    const spawned = superviseSpawn(
      "security",
      ["find-generic-password", "-s", service, "-a", userInfo().username, "-w"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    const chunks: string[] = [];
    spawned.child.stdout?.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    const exit = await spawned.done;
    if (exit.exitCode !== 0) return undefined;
    const out = chunks.join("").trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function detectClaudeCode(): Promise<SubscriptionStatus> {
  let blob: string | undefined;
  const path = claudeCredentialsPath();
  if (existsSync(path)) {
    try {
      blob = readFileSync(path, "utf8");
    } catch {
      blob = undefined;
    }
  }
  blob ??= await readMacosKeychain(CLAUDE_KEYCHAIN_SERVICE);
  if (blob === undefined) return { mode: "claude-code", available: false, expired: false };

  let oauth: unknown;
  try {
    const parsed: unknown = JSON.parse(blob);
    oauth = isRecord(parsed) ? parsed.claudeAiOauth : undefined;
  } catch {
    return { mode: "claude-code", available: false, expired: false };
  }
  if (!isRecord(oauth) || typeof oauth.accessToken !== "string") {
    return { mode: "claude-code", available: false, expired: false };
  }
  // Claude Code stores expiry as ms since epoch.
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt / 1000 : undefined;
  const expired = expiresAt !== undefined && Date.now() / 1000 >= expiresAt;
  return {
    mode: "claude-code",
    available: true,
    expired,
    ...(expiresAt !== undefined ? { expiresAt } : {})
  };
}

function codexAccountId(claims: Record<string, unknown>): string | undefined {
  const auth = claims["https://api.openai.com/auth"];
  if (isRecord(auth) && typeof auth.chatgpt_account_id === "string") return auth.chatgpt_account_id;
  return undefined;
}

function detectCodex(): SubscriptionStatus {
  const path = codexAuthPath();
  if (!existsSync(path)) return { mode: "codex", available: false, expired: false };
  let tokens: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    tokens = isRecord(parsed) ? parsed.tokens : undefined;
  } catch {
    return { mode: "codex", available: false, expired: false };
  }
  if (!isRecord(tokens) || typeof tokens.access_token !== "string") {
    return { mode: "codex", available: false, expired: false };
  }
  const claims = decodeJwtClaims(tokens.access_token);
  const expiresAt = typeof claims.exp === "number" ? claims.exp : undefined;
  const expired = expiresAt !== undefined && Date.now() / 1000 >= expiresAt;
  const accountId =
    typeof tokens.account_id === "string" ? tokens.account_id : codexAccountId(claims);
  return {
    mode: "codex",
    available: true,
    expired,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(accountId !== undefined ? { accountId } : {})
  };
}

/** Detect whether a subscription login is present locally (read-only). */
export async function detectSubscription(mode: PanelAuthMode): Promise<SubscriptionStatus> {
  return mode === "claude-code" ? detectClaudeCode() : detectCodex();
}

/** Best-effort read of the model the Codex CLI is pinned to (`~/.codex/config.toml`). */
export function detectCodexModel(): string {
  const path = codexConfigPath();
  if (!existsSync(path)) return DEFAULT_CODEX_MODEL;
  try {
    // A line-level read avoids adding a TOML dependency: `model = "..."` at the
    // top level (before any [section]) is the codex CLI's format.
    for (const rawLine of readFileSync(path, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("[")) break;
      const match = /^model\s*=\s*"([^"]+)"/.exec(line);
      if (match?.[1] !== undefined) return match[1];
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_CODEX_MODEL;
}
