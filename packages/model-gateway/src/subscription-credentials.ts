import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    const fusionkit = isRecord(blob.fusionkit) ? blob.fusionkit : undefined;
    return {
      mode,
      accessToken: oauth.accessToken,
      sourcePath,
      ...(typeof oauth.refreshToken === "string" ? { refreshToken: oauth.refreshToken } : {}),
      ...(typeof oauth.expiresAt === "number" ? { expiresAt: oauth.expiresAt / 1000 } : {}),
      ...(typeof fusionkit?.accountId === "string" ? { accountId: fusionkit.accountId } : {})
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

export function sanitizeSubscriptionLabel(label: string): string {
  let normalized = "";
  let pendingSeparator = false;
  for (const character of label.trim().toLowerCase()) {
    const code = character.charCodeAt(0);
    const allowed =
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      character === "." ||
      character === "_" ||
      character === "-";
    if (allowed) {
      if (character === "-" && normalized.length === 0) continue;
      if (
        pendingSeparator &&
        character !== "-" &&
        normalized.length > 0 &&
        !normalized.endsWith("-")
      ) {
        normalized += "-";
      }
      normalized += character;
      pendingSeparator = false;
    } else {
      pendingSeparator = true;
    }
  }
  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === "-") end -= 1;
  normalized = normalized.slice(0, end);
  return normalized.length > 0 ? normalized : "account";
}

function credentialIdentity(credential: SubscriptionCredential): string {
  return credential.accountId ?? randomUUID();
}

function accountIdFromProfile(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["account_uuid", "accountUuid"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  const account = value.account;
  if (isRecord(account)) {
    const uuid = account.uuid ?? account.id;
    if (typeof uuid === "string" && uuid.length > 0) return uuid;
  }
  for (const child of Object.values(value)) {
    const candidate = accountIdFromProfile(child);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

async function enrichClaudePoolBlob(
  info: SubscriptionInfo,
  credential: SubscriptionCredential,
  source: Record<string, unknown>
): Promise<void> {
  const endpoint = info.oauth.profileEndpoint;
  if (endpoint === undefined) return;
  try {
    const response = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "anthropic-beta": info.oauthBetaHeader ?? "oauth-2025-04-20",
        accept: "application/json"
      }
    });
    if (!response.ok) return;
    const accountId = accountIdFromProfile(await response.json());
    if (accountId !== undefined) source.fusionkit = { accountId };
  } catch {
    // Enrollment still succeeds offline; the relay simply preserves the
    // caller's metadata until this account is re-enrolled online.
  }
}

export async function enrollCurrentSubscription(
  mode: SubscriptionMode,
  options: { label?: string; poolDirectory?: string } = {}
): Promise<string> {
  const info: SubscriptionInfo = subscriptionInfo(mode);
  const sourcePath = defaultSubscriptionCredentialPath(mode);
  const source = await credentialBlob(mode, sourcePath);
  const credential = await loadSubscriptionCredential(mode, sourcePath);
  if (mode === "claude-code") await enrichClaudePoolBlob(info, credential, source);
  const directory = options.poolDirectory ?? defaultSubscriptionPoolDirectory(mode);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const identity = credentialIdentity(credential);
  const label = sanitizeSubscriptionLabel(options.label ?? `${mode}-${identity}`);
  const target = join(directory, `${label}.json`);
  atomicWriteJson(target, source);
  return target;
}

export function subscriptionCredentialLabel(path: string): string {
  return basename(path, ".json");
}
