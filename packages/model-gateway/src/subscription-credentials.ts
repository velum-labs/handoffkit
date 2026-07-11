import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import {
  subscriptionInfo,
  type SubscriptionInfo,
  type SubscriptionMode
} from "@fusionkit/registry";

import type { SubscriptionCredential } from "./subscription-types.js";

const execFileAsync = promisify(execFile);

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function codexAccountId(claims: Record<string, unknown>): string | undefined {
  const auth = claims["https://api.openai.com/auth"];
  if (isRecord(auth) && typeof auth.chatgpt_account_id === "string") {
    return auth.chatgpt_account_id;
  }
  const organizations = claims.organizations;
  if (Array.isArray(organizations)) {
    const first = organizations[0];
    if (isRecord(first) && typeof first.id === "string") return first.id;
  }
  return undefined;
}

async function readMacosKeychain(service: string): Promise<string | undefined> {
  if (platform() !== "darwin") return undefined;
  try {
    const result = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      userInfo().username,
      "-w"
    ]);
    const output = result.stdout.trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

async function credentialBlob(
  mode: SubscriptionMode,
  path: string
): Promise<Record<string, unknown>> {
  let text: string | undefined;
  if (existsSync(path)) text = readFileSync(path, "utf8");
  if (text === undefined && mode === "claude-code") {
    const service = subscriptionInfo(mode).keychainService;
    if (service !== undefined) text = await readMacosKeychain(service);
  }
  if (text === undefined) {
    throw new Error(`no ${mode} credentials found at ${path}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${mode} credentials must be a JSON object`);
  return parsed;
}

export function defaultSubscriptionPoolDirectory(mode: SubscriptionMode): string {
  return expandHome(subscriptionInfo(mode).poolDirectory);
}

export function defaultSubscriptionCredentialPath(mode: SubscriptionMode): string {
  return expandHome(subscriptionInfo(mode).credentialsPath);
}

export async function loadSubscriptionCredential(
  mode: SubscriptionMode,
  sourcePath = defaultSubscriptionCredentialPath(mode)
): Promise<SubscriptionCredential> {
  const blob = await credentialBlob(mode, sourcePath);
  if (mode === "claude-code") {
    const oauth = blob.claudeAiOauth;
    if (!isRecord(oauth) || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
      throw new Error("Claude Code credentials contain no OAuth access token");
    }
    return {
      mode,
      accessToken: oauth.accessToken,
      sourcePath,
      ...(typeof oauth.refreshToken === "string" ? { refreshToken: oauth.refreshToken } : {}),
      ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt / 1000 } : {})
    };
  }

  const tokens = blob.tokens;
  if (!isRecord(tokens) || typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
    throw new Error("Codex credentials contain no OAuth access token");
  }
  const claims = decodeJwtClaims(tokens.access_token);
  const expiresAt = typeof claims.exp === "number" ? claims.exp : undefined;
  const explicitAccountId =
    typeof tokens.account_id === "string" && tokens.account_id.length > 0
      ? tokens.account_id
      : undefined;
  return {
    mode,
    accessToken: tokens.access_token,
    sourcePath,
    ...(typeof tokens.refresh_token === "string" ? { refreshToken: tokens.refresh_token } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(explicitAccountId ?? codexAccountId(claims) !== undefined
      ? { accountId: explicitAccountId ?? codexAccountId(claims) }
      : {})
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export async function persistSubscriptionCredential(
  previous: SubscriptionCredential,
  next: Pick<SubscriptionCredential, "accessToken" | "refreshToken" | "expiresAt">
): Promise<SubscriptionCredential> {
  const blob = await credentialBlob(previous.mode, previous.sourcePath);
  if (previous.mode === "claude-code") {
    const oauth = isRecord(blob.claudeAiOauth) ? { ...blob.claudeAiOauth } : {};
    oauth.accessToken = next.accessToken;
    if (next.refreshToken !== undefined) oauth.refreshToken = next.refreshToken;
    if (next.expiresAt !== undefined) oauth.expiresAt = next.expiresAt * 1000;
    blob.claudeAiOauth = oauth;
  } else {
    const tokens = isRecord(blob.tokens) ? { ...blob.tokens } : {};
    tokens.access_token = next.accessToken;
    if (next.refreshToken !== undefined) tokens.refresh_token = next.refreshToken;
    blob.tokens = tokens;
  }
  atomicWriteJson(previous.sourcePath, blob);
  return {
    ...previous,
    accessToken: next.accessToken,
    ...(next.refreshToken !== undefined ? { refreshToken: next.refreshToken } : {}),
    ...(next.expiresAt !== undefined ? { expiresAt: next.expiresAt } : {})
  };
}

function safeLabel(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "account";
}

function credentialIdentity(credential: SubscriptionCredential): string {
  return credential.accountId ?? createHash("sha256").update(credential.accessToken).digest("hex").slice(0, 12);
}

export async function enrollCurrentSubscription(
  mode: SubscriptionMode,
  options: { label?: string; poolDirectory?: string } = {}
): Promise<string> {
  const info: SubscriptionInfo = subscriptionInfo(mode);
  const sourcePath = defaultSubscriptionCredentialPath(mode);
  const source = await credentialBlob(mode, sourcePath);
  const credential = await loadSubscriptionCredential(mode, sourcePath);
  const directory = options.poolDirectory ?? defaultSubscriptionPoolDirectory(mode);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = credentialIdentity(credential);
  const label = safeLabel(options.label ?? `${mode}-${identity}`);
  const target = join(directory, `${label}.json`);
  atomicWriteJson(target, source);
  return target;
}

export function subscriptionCredentialLabel(path: string): string {
  return basename(path, ".json");
}
