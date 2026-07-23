import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  accountStoreSnapshot,
  stageSubscriptionAccounts,
  subscriptionStoresUnchanged
} from "../lib/routekit-subscription-state.mjs";

const NOW = 1_800_000_000;

function fixture(expiresAt, provider = "claude-code") {
  const root = mkdtempSync(join(tmpdir(), "routekit-subscription-state-"));
  const source = join(root, "source");
  const isolated = join(root, "isolated");
  const credentialPath = join(source, "member.json");
  const credential =
    provider === "claude-code"
      ? {
          claudeAiOauth: {
            accessToken: "test-access",
            refreshToken: "test-refresh",
            ...(expiresAt === undefined ? {} : { expiresAt: expiresAt * 1000 })
          },
          metadata: { retained: true }
        }
      : {
          tokens: {
            access_token: "test-access",
            refresh_token: "test-refresh"
          },
          metadata: { retained: true }
        };
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(
    credentialPath,
    `${JSON.stringify(credential)}\n`,
    { mode: 0o640 }
  );
  return {
    root,
    source,
    isolated,
    credentialPath,
    options: {
      accountDirectory: () => source,
      loadCredential: async () => ({ expiresAt }),
      nowSeconds: NOW
    }
  };
}

test("qualification rejects unverifiable and near-expiry credentials without staging or mutation", async () => {
  for (const expiresAt of [undefined, NOW - 1, NOW + 300]) {
    const state = fixture(expiresAt);
    try {
      const before = accountStoreSnapshot(state.source);
      const contents = readFileSync(state.credentialPath, "utf8");
      await assert.rejects(
        stageSubscriptionAccounts(
          state.isolated,
          ["claude-code"],
          state.options
        ),
        /(?:no verifiable expiration|expires too soon).*re-enroll/
      );
      assert.deepEqual(accountStoreSnapshot(state.source), before);
      assert.equal(readFileSync(state.credentialPath, "utf8"), contents);
      assert.equal(
        existsSync(join(state.isolated, "subscriptions", "claude-code", "member.json")),
        false
      );
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  }
});

test("qualification stages fresh access tokens privately without rotation-capable refresh tokens", async () => {
  for (const provider of ["claude-code", "codex"]) {
    const state = fixture(NOW + 301, provider);
    try {
      const before = accountStoreSnapshot(state.source);
      const snapshots = await stageSubscriptionAccounts(
        state.isolated,
        [provider],
        state.options
      );
      const staged = join(
        state.isolated,
        "subscriptions",
        provider,
        "member.json"
      );
      const stagedCredential = JSON.parse(readFileSync(staged, "utf8"));
      assert.equal(statSync(staged).mode & 0o777, 0o600);
      assert.deepEqual(stagedCredential.metadata, { retained: true });
      if (provider === "claude-code") {
        assert.equal(stagedCredential.claudeAiOauth.accessToken, "test-access");
        assert.equal("refreshToken" in stagedCredential.claudeAiOauth, false);
      } else {
        assert.equal(stagedCredential.tokens.access_token, "test-access");
        assert.equal("refresh_token" in stagedCredential.tokens, false);
      }
      assert.deepEqual(accountStoreSnapshot(state.source), before);
      assert.deepEqual(subscriptionStoresUnchanged(snapshots), { [provider]: true });

      writeFileSync(staged, "disposable staged change\n");
      assert.deepEqual(subscriptionStoresUnchanged(snapshots), { [provider]: true });
      writeFileSync(state.credentialPath, "canonical source change\n");
      assert.deepEqual(subscriptionStoresUnchanged(snapshots), { [provider]: false });
    } finally {
      rmSync(state.root, { recursive: true, force: true });
    }
  }
});

test("qualification detects a canonical source mutation during credential preflight", async () => {
  const state = fixture(NOW + 301);
  try {
    await assert.rejects(
      stageSubscriptionAccounts(
        state.isolated,
        ["claude-code"],
        {
          ...state.options,
          loadCredential: async (_provider, path) => {
            const blob = JSON.parse(readFileSync(path, "utf8"));
            writeFileSync(path, `${JSON.stringify({ ...blob, changed: true })}\n`);
            return { expiresAt: NOW + 301 };
          }
        }
      ),
      /account store changed during qualification preflight/
    );
    assert.equal(
      existsSync(join(state.isolated, "subscriptions", "claude-code", "member.json")),
      false
    );
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});
