import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  resolveSubscriptionAccounts,
  SubscriptionAccountSet,
  subscriptionProvider
} from "../index.js";

const FUTURE_CODEX_TOKEN =
  "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.";

function codexCredential(accountId: string): string {
  return JSON.stringify({
    tokens: {
      access_token: FUTURE_CODEX_TOKEN,
      refresh_token: `refresh-${accountId}`,
      account_id: accountId
    }
  });
}

test("canonical login is imported as the one-member account-set case", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-source-"));
  const canonical = join(root, "auth.json");
  const directory = join(root, "accounts");
  writeFileSync(canonical, codexCredential("acct-one"), { mode: 0o600 });
  try {
    const resolved = await resolveSubscriptionAccounts("codex", {
      kind: "auto",
      directory,
      canonicalPath: canonical
    });
    assert.equal(resolved.paths.length, 1);
    assert.equal(JSON.parse(readFileSync(resolved.paths[0]!, "utf8")).tokens.account_id, "acct-one");

    const accounts = await SubscriptionAccountSet.open(subscriptionProvider("codex"), {
      mode: "codex",
      source: {
        kind: "auto",
        directory,
        canonicalPath: canonical
      }
    });
    try {
      assert.equal(accounts.size, 1);
      const response = await accounts.execute("gpt-5.3-codex", (credential) =>
        Promise.resolve(new Response(credential.accountId))
      );
      assert.equal(await response.text(), "acct-one");
    } finally {
      await accounts.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same auto source grows naturally from one account to many", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-account-source-"));
  const canonical = join(root, "auth.json");
  const directory = join(root, "accounts");
  writeFileSync(canonical, codexCredential("acct-one"), { mode: 0o600 });
  try {
    await resolveSubscriptionAccounts("codex", {
      kind: "auto",
      directory,
      canonicalPath: canonical
    });
    writeFileSync(join(directory, "second.json"), codexCredential("acct-two"), {
      mode: 0o600
    });
    const accounts = await SubscriptionAccountSet.open(subscriptionProvider("codex"), {
      mode: "codex",
      source: {
        kind: "auto",
        directory,
        canonicalPath: canonical
      },
      strategy: "round_robin"
    });
    try {
      assert.equal(accounts.size, 2);
      const served: string[] = [];
      for (let index = 0; index < 2; index += 1) {
        const response = await accounts.execute("gpt-5.3-codex", (credential) =>
          Promise.resolve(new Response(credential.accountId))
        );
        served.push(await response.text());
      }
      assert.deepEqual(new Set(served), new Set(["acct-one", "acct-two"]));
    } finally {
      await accounts.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
