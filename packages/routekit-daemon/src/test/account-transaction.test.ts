import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  markAccountTransactionCommitted,
  prepareAccountTransaction,
  recoverAccountTransactions
} from "../account-transaction.js";

test("prepared account transactions restore exact prior files without secrets in the journal", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-transaction-"));
  const home = join(root, "state");
  const account = join(home, "subscriptions", "codex", "work.json");
  const config = join(root, "router.yaml");
  const revisions = join(home, "daemon-revisions.json");
  const oldAccount =
    '{"tokens":{"access_token":"old-access","refresh_token":"old-refresh"}}\n';
  const oldConfig = "providers:\n  openai: {}\n";
  const oldRevisions = '{"config":2,"accounts":3,"daemon":1}\n';
  mkdirSync(join(home, "subscriptions", "codex"), { recursive: true });
  writeFileSync(account, oldAccount, { mode: 0o600 });
  writeFileSync(config, oldConfig, { mode: 0o600 });
  writeFileSync(revisions, oldRevisions, { mode: 0o600 });
  try {
    const transaction = prepareAccountTransaction({
      home,
      configPath: config,
      accountPaths: [account],
      kind: "codex",
      provider: "codex",
      labels: ["work"]
    });
    const journal = readFileSync(
      join(transaction.directory, "transaction.json"),
      "utf8"
    );
    assert.doesNotMatch(journal, /old-access|old-refresh|access_token|refresh_token/);

    writeFileSync(
      account,
      '{"tokens":{"access_token":"new-access","refresh_token":"new-refresh"}}\n'
    );
    writeFileSync(config, "providers:\n  openai: {}\n  codex: {}\n");
    writeFileSync(revisions, '{"config":3,"accounts":4,"daemon":1}\n');

    assert.deepEqual(recoverAccountTransactions(home, config), {
      recovered: 1,
      cleaned: 0
    });
    assert.equal(readFileSync(account, "utf8"), oldAccount);
    assert.equal(readFileSync(config, "utf8"), oldConfig);
    assert.equal(readFileSync(revisions, "utf8"), oldRevisions);
    assert.equal(statSync(account).mode & 0o777, 0o600);
    assert.equal(existsSync(join(home, "account-transactions")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("committed transactions preserve new state and only clean rollback data", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-transaction-"));
  const home = join(root, "state");
  const account = join(home, "cliproxy", "auth", "xai-user.json");
  const config = join(root, "router.yaml");
  mkdirSync(home, { recursive: true });
  writeFileSync(config, "providers: {}\n");
  try {
    const transaction = prepareAccountTransaction({
      home,
      configPath: config,
      accountPaths: [account],
      kind: "grok",
      provider: "cliproxy",
      labels: ["xai-user"]
    });
    mkdirSync(join(home, "cliproxy", "auth"), { recursive: true });
    writeFileSync(account, '{"type":"xai","access_token":"new-access"}\n');
    writeFileSync(config, "providers:\n  cliproxy: {}\n");
    markAccountTransactionCommitted(transaction);

    assert.deepEqual(recoverAccountTransactions(home, config), {
      recovered: 0,
      cleaned: 1
    });
    assert.match(readFileSync(account, "utf8"), /new-access/);
    assert.match(readFileSync(config, "utf8"), /cliproxy/);
    assert.equal(existsSync(join(home, "account-transactions")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orphaned pre-prepare transaction directories are safe cleanup only", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-transaction-"));
  const home = join(root, "state");
  const config = join(root, "router.yaml");
  const orphan = join(home, "account-transactions", "orphan");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "backup-0.bin"), "opaque");
  writeFileSync(config, "providers: {}\n");
  try {
    assert.deepEqual(recoverAccountTransactions(home, config), {
      recovered: 0,
      cleaned: 1
    });
    assert.deepEqual(
      existsSync(join(home, "account-transactions"))
        ? readdirSync(join(home, "account-transactions"))
        : [],
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL after account/config writes is rolled back from the prepared journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-sigkill-"));
  const home = join(root, "state");
  const account = join(home, "subscriptions", "codex", "killed.json");
  const config = join(root, "router.yaml");
  const oldConfig = "providers:\n  openai: {}\n";
  writeFileSync(config, oldConfig);
  const moduleUrl = new URL("../account-transaction.js", import.meta.url).href;
  const input = JSON.stringify({ home, account, config });
  const script = `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    import { prepareAccountTransaction } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.env.ROUTEKIT_TX_INPUT);
    prepareAccountTransaction({
      home: input.home,
      configPath: input.config,
      accountPaths: [input.account],
      kind: "codex",
      provider: "codex",
      labels: ["killed"]
    });
    mkdirSync(dirname(input.account), { recursive: true });
    writeFileSync(input.account, '{"tokens":{"access_token":"killed-access"}}\\n');
    writeFileSync(input.config, 'providers:\\n  openai: {}\\n  codex: {}\\n');
    process.kill(process.pid, "SIGKILL");
  `;
  try {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, ROUTEKIT_TX_INPUT: input },
      stdio: "ignore"
    });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    );
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(existsSync(account), true);

    assert.deepEqual(recoverAccountTransactions(home, config), {
      recovered: 1,
      cleaned: 0
    });
    assert.equal(existsSync(account), false);
    assert.equal(readFileSync(config, "utf8"), oldConfig);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
