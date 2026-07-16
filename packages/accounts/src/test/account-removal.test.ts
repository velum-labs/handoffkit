import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { removeSubscriptionAccount } from "../credentials.js";

test("account removal is private, contained, and idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-remove-"));
  const directory = join(root, "accounts");
  const path = join(directory, "work.json");
  mkdirSync(directory, { mode: 0o777 });
  writeFileSync(path, '{"accessToken":"never-print-this"}\n', { mode: 0o666 });
  try {
    const removed = removeSubscriptionAccount("codex", "work", {
      accountsDirectory: directory
    });
    assert.deepEqual(removed, {
      mode: "codex",
      label: "work",
      path,
      removed: true
    });
    assert.equal(existsSync(path), false);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(removed).includes("never-print-this"), false);

    assert.deepEqual(
      removeSubscriptionAccount("codex", "work", { accountsDirectory: directory }),
      { mode: "codex", label: "work", path, removed: false }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account removal rejects traversal and symbolic links", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-remove-safe-"));
  const directory = join(root, "accounts");
  const outside = join(root, "outside.json");
  mkdirSync(directory);
  writeFileSync(outside, "{}\n", { mode: 0o600 });
  symlinkSync(outside, join(directory, "linked.json"));
  try {
    for (const unsafe of ["../outside", "/tmp/outside", ".hidden", "UPPER"]) {
      assert.throws(
        () =>
          removeSubscriptionAccount("claude-code", unsafe, {
            accountsDirectory: directory
          }),
        /account name/
      );
    }
    assert.throws(
      () =>
        removeSubscriptionAccount("claude-code", "linked", {
          accountsDirectory: directory
        }),
      /not a regular file/
    );
    assert.equal(existsSync(outside), true);

    const linkedDirectory = join(root, "linked-accounts");
    symlinkSync(directory, linkedDirectory);
    assert.throws(
      () =>
        removeSubscriptionAccount("claude-code", "missing", {
          accountsDirectory: linkedDirectory
        }),
      /not a real directory|symbolic link/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
