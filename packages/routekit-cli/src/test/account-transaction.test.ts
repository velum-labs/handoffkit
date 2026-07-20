import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  enrollAndActivateAccount,
  recoverPendingEnrollmentTransactions
} from "../account-transaction.js";

const AUTH = JSON.stringify({
  tokens: {
    access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
    refresh_token: "refresh",
    account_id: "acct-test"
  }
});

test("enrollment commits credentials and config with no pending journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-transaction-"));
  const stateHome = join(root, "state");
  const sourcePath = join(root, "auth.json");
  const configPath = join(root, "router.yaml");
  const previousHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = stateHome;
  writeFileSync(sourcePath, AUTH);
  writeFileSync(configPath, "providers:\n  openai: {}\n");
  try {
    const result = await enrollAndActivateAccount({
      subscriptionKind: "codex",
      label: "primary",
      sourcePath,
      config: { configPath }
    });
    assert.equal(
      result.path,
      join(stateHome, "subscriptions", "codex", "primary.json")
    );
    assert.match(readFileSync(configPath, "utf8"), /codex: \{\}/);
    assert.equal(existsSync(result.path), true);
    assert.deepEqual(
      existsSync(join(stateHome, "transactions"))
        ? readdirSync(join(stateHome, "transactions"))
        : [],
      []
    );
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending enrollment journals roll both files back before retry", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-recovery-"));
  const stateHome = join(root, "state");
  const transactionDirectory = join(stateHome, "transactions");
  const credentialDirectory = join(stateHome, "subscriptions", "codex");
  const credentialPath = join(credentialDirectory, "primary.json");
  const configPath = join(root, "router.yaml");
  const previousHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = stateHome;
  mkdirSync(transactionDirectory, { recursive: true });
  mkdirSync(credentialDirectory, { recursive: true });
  const previousCredential = '{"tokens":{"access_token":"old"}}\n';
  const previousConfig = "providers:\n  openai: {}\n";
  writeFileSync(credentialPath, '{"tokens":{"access_token":"new"}}\n');
  writeFileSync(configPath, "providers:\n  openai: {}\n  codex: {}\n");
  writeFileSync(
    join(transactionDirectory, "enrollment-codex-primary.json"),
    `${JSON.stringify({
      version: 1,
      mode: "codex",
      label: "primary",
      credentialPath,
      previousCredential,
      configPath,
      previousConfig
    })}\n`,
    { mode: 0o600 }
  );
  try {
    assert.deepEqual(recoverPendingEnrollmentTransactions(), ["codex/primary"]);
    assert.equal(readFileSync(credentialPath, "utf8"), previousCredential);
    assert.equal(readFileSync(configPath, "utf8"), previousConfig);
    assert.deepEqual(readdirSync(transactionDirectory), []);
    assert.deepEqual(recoverPendingEnrollmentTransactions(), []);
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid config is rejected before credential persistence", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-invalid-config-"));
  const stateHome = join(root, "state");
  const sourcePath = join(root, "auth.json");
  const configPath = join(root, "router.yaml");
  const target = join(stateHome, "subscriptions", "codex", "primary.json");
  const previousHome = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = stateHome;
  writeFileSync(sourcePath, AUTH);
  writeFileSync(configPath, "endpoints: []\n");
  try {
    await assert.rejects(
      enrollAndActivateAccount({
        subscriptionKind: "codex",
        label: "primary",
        sourcePath,
        config: { configPath }
      }),
      /unrecognized key|invalid input/i
    );
    assert.equal(existsSync(target), false);
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
