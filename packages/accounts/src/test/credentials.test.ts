import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  defaultSubscriptionAccountDirectory,
  defaultSubscriptionCredentialPath,
  enrollCurrentSubscription,
  loadSubscriptionCredential
} from "../index.js";

test("managed account directories honor the supplied RouteKit environment", () => {
  assert.equal(
    defaultSubscriptionAccountDirectory("codex", {
      HOME: "/isolated/home",
      ROUTEKIT_HOME: "/isolated/state"
    }),
    join("/isolated/state", "subscriptions", "codex")
  );
  assert.equal(
    defaultSubscriptionCredentialPath("codex", {
      HOME: "/isolated/home"
    }),
    join("/isolated/home", ".codex", "auth.json")
  );
});

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
