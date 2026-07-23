import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

export const QUALIFICATION_MINIMUM_CREDENTIAL_VALIDITY_SECONDS = 300;

export function accountStoreSnapshot(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const stat = statSync(path);
      return {
        name,
        size: stat.size,
        mode: stat.mode & 0o777,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
      };
    });
}

function snapshotsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCredentialFresh(provider, credential, refreshBefore) {
  if (!Number.isFinite(credential.expiresAt)) {
    throw new Error(
      `${provider} enrolled subscription credential has no verifiable expiration; re-enroll it before qualification`
    );
  }
  if (credential.expiresAt <= refreshBefore) {
    throw new Error(
      `${provider} enrolled subscription credential expires too soon for isolated qualification; re-enroll it before qualification`
    );
  }
}

function qualificationCredentialContents(provider, sourcePath) {
  const blob = JSON.parse(readFileSync(sourcePath, "utf8"));
  if (typeof blob !== "object" || blob === null || Array.isArray(blob)) {
    throw new Error(`${provider} enrolled subscription credential must be a JSON object`);
  }
  if (provider === "claude-code") {
    const oauth = blob.claudeAiOauth;
    if (typeof oauth === "object" && oauth !== null && !Array.isArray(oauth)) {
      delete oauth.refreshToken;
    }
  } else {
    const tokens = blob.tokens;
    if (typeof tokens === "object" && tokens !== null && !Array.isArray(tokens)) {
      delete tokens.refresh_token;
    }
  }
  return `${JSON.stringify(blob, null, 2)}\n`;
}

export async function stageSubscriptionAccounts(
  isolatedStateHome,
  providers,
  {
    accountDirectory,
    loadCredential,
    nowSeconds = Date.now() / 1000,
    minimumValiditySeconds = QUALIFICATION_MINIMUM_CREDENTIAL_VALIDITY_SECONDS
  }
) {
  const snapshots = {};
  const refreshBefore = nowSeconds + minimumValiditySeconds;
  for (const provider of ["codex", "claude-code"]) {
    if (!providers.includes(provider)) continue;
    const source = accountDirectory(provider);
    const before = accountStoreSnapshot(source);

    for (const { name } of before) {
      const credential = await loadCredential(provider, join(source, name));
      assertCredentialFresh(provider, credential, refreshBefore);
    }
    if (!snapshotsEqual(accountStoreSnapshot(source), before)) {
      throw new Error(
        `${provider} enrolled subscription account store changed during qualification preflight`
      );
    }

    const destination = join(isolatedStateHome, "subscriptions", provider);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const { name } of before) {
      const destinationPath = join(destination, name);
      writeFileSync(
        destinationPath,
        qualificationCredentialContents(provider, join(source, name)),
        { mode: 0o600 }
      );
    }
    if (!snapshotsEqual(accountStoreSnapshot(source), before)) {
      throw new Error(
        `${provider} enrolled subscription account store changed while staging qualification credentials`
      );
    }
    snapshots[provider] = { source, before, stagedCount: before.length };
  }
  return snapshots;
}

export function subscriptionStoresUnchanged(snapshots) {
  return Object.fromEntries(
    Object.entries(snapshots).map(([provider, snapshot]) => [
      provider,
      snapshotsEqual(accountStoreSnapshot(snapshot.source), snapshot.before)
    ])
  );
}
