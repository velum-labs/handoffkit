import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  captureLoginCredential,
  claudeProfileKeychainService,
  legacyClaudeProfileKeychainService
} from "../managed-login.js";

test("Claude managed login uses current isolated secure-storage service and removes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-login-test-"));
  const accounts = join(root, "accounts");
  mkdirSync(accounts);
  const previousHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = root;
  const reads: string[] = [];
  const removals: string[] = [];
  let profileDirectory = "";
  try {
    const result = await captureLoginCredential(
      "claude-code",
      "managed-login-regression",
      {
        temporaryParent: root,
        platform: "darwin",
        runLogin: async (invocation) => {
          profileDirectory = invocation.profileDirectory;
          assert.equal(
            invocation.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
            profileDirectory
          );
          assert.equal(invocation.env.CLAUDE_CONFIG_DIR, profileDirectory);
          return 0;
        },
        keychain: {
          async read(service) {
            reads.push(service);
            if (service !== claudeProfileKeychainService(profileDirectory)) {
              throw new Error("not found");
            }
            return JSON.stringify({
              claudeAiOauth: {
                accessToken: "test-access",
                refreshToken: "test-refresh",
                expiresAt: Date.now() + 3_600_000
              }
            });
          },
          async remove(service) {
            removals.push(service);
          }
        }
      }
    );
    assert.equal(result.subscriptionKind, "claude-code");
    assert.equal(reads[0], claudeProfileKeychainService(profileDirectory));
    assert.equal(
      reads.includes(legacyClaudeProfileKeychainService(profileDirectory)),
      false
    );
    assert.deepEqual(removals, [
      claudeProfileKeychainService(profileDirectory)
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude managed login accepts the legacy isolated Keychain service", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-legacy-test-"));
  const previousHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = root;
  let profileDirectory = "";
  const removals: string[] = [];
  try {
    await captureLoginCredential("claude-code", "managed-login-legacy", {
      temporaryParent: root,
      platform: "darwin",
      runLogin: async (invocation) => {
        profileDirectory = invocation.profileDirectory;
        return 0;
      },
      keychain: {
        async read(service) {
          if (
            service === legacyClaudeProfileKeychainService(profileDirectory)
          ) {
            return JSON.stringify({
              claudeAiOauth: {
                accessToken: "legacy-access",
                expiresAt: Date.now() + 3_600_000
              }
            });
          }
          throw new Error("not found");
        },
        async remove(service) {
          removals.push(service);
        }
      }
    });
    assert.deepEqual(removals, [
      legacyClaudeProfileKeychainService(profileDirectory)
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
