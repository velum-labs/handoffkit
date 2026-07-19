import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  enrollCurrentSubscription,
  loadSubscriptionCredential
} from "../index.js";

test("an explicit missing Claude credential never falls back to the canonical keychain", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-explicit-claude-"));
  const sourcePath = join(root, "isolated", ".credentials.json");
  const accountsDirectory = join(root, "accounts");
  try {
    await assert.rejects(
      loadSubscriptionCredential("claude-code", sourcePath),
      /no claude-code credentials found/
    );
    await assert.rejects(
      enrollCurrentSubscription("claude-code", {
        label: "secondary",
        sourcePath,
        accountsDirectory
      }),
      /no claude-code credentials found/
    );
    assert.equal(existsSync(join(accountsDirectory, "secondary.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
