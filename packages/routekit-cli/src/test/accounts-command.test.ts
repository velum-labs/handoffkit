import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  captureLoginCredential,
  claudeProfileKeychainService,
  loginAccount
} from "../accounts.js";
import { buildProgram } from "../cli.js";

test("accounts login captures isolated Codex auth without writing daemon-owned state", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-accounts-login-"));
  const stateHome = join(root, "state");
  const binDirectory = join(root, "bin");
  const markerPath = join(root, "login-marker.json");
  const fakeCodex = join(binDirectory, "codex");
  const previousHome = process.env.HOME;
  const previousStateHome = process.env.ROUTEKIT_HOME;
  const previousPath = process.env.PATH;
  const originalErrorWrite = process.stderr.write;
  mkdirSync(binDirectory);
  writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const home = process.env.CODEX_HOME;",
      "if (!home) process.exit(2);",
      "fs.mkdirSync(home, { recursive: true });",
      "fs.writeFileSync(",
      '  path.join(home, "auth.json"),',
      `  ${JSON.stringify(JSON.stringify({
        tokens: {
          access_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjk5OTk5OTk5OTl9.",
          refresh_token: "managed-refresh",
          account_id: "acct-managed"
        }
      }))}`,
      ");",
      "fs.writeFileSync(",
      `  ${JSON.stringify(markerPath)},`,
      '  JSON.stringify({ home, args: process.argv.slice(2), config: fs.readFileSync(path.join(home, "config.toml"), "utf8") })',
      ");",
      ""
    ].join("\n")
  );
  chmodSync(fakeCodex, 0o755);
  process.env.HOME = root;
  process.env.ROUTEKIT_HOME = stateHome;
  process.env.PATH = `${binDirectory}:${previousPath ?? ""}`;
  try {
    const captured = await captureLoginCredential("codex", "secondary", {
      temporaryParent: root
    });
    const target = join(stateHome, "subscriptions", "codex", "secondary.json");
    assert.equal(existsSync(target), false);
    assert.equal(captured.subscriptionKind, "codex");
    assert.equal(captured.label, "secondary");
    assert.equal(
      (captured.credential as { tokens?: { refresh_token?: string } }).tokens
        ?.refresh_token,
      "managed-refresh"
    );
    assert.equal(existsSync(join(root, ".codex", "auth.json")), false);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      home: string;
      args: string[];
      config: string;
    };
    assert.deepEqual(marker.args, ["login"]);
    assert.equal(marker.config, 'cli_auth_credentials_store = "file"\n');
    assert.equal(existsSync(marker.home), false);
  } finally {
    process.stderr.write = originalErrorWrite;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousStateHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousStateHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
test("managed Claude login uses isolated state and rejects failures and duplicate labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-claude-login-"));
  const stateHome = join(root, "state");
  const previousStateHome = process.env.ROUTEKIT_HOME;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.ROUTEKIT_HOME = stateHome;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  globalThis.fetch = async () => Response.json({ account: { uuid: "acct-claude" } });
  let profileDirectory = "";
  try {
    const enrolled = await loginAccount("claude-code", "secondary", {
      temporaryParent: root,
      runLogin: async (invocation) => {
        profileDirectory = invocation.profileDirectory;
        assert.equal(invocation.command, "claude");
        assert.deepEqual(invocation.args, ["auth", "login", "--claudeai"]);
        assert.equal(invocation.env.CLAUDE_CONFIG_DIR, invocation.profileDirectory);
        assert.equal(invocation.env.DISABLE_AUTOUPDATER, "1");
        assert.equal(invocation.env.ANTHROPIC_API_KEY, undefined);
        writeFileSync(
          invocation.sourcePath,
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "managed-claude",
              refreshToken: "managed-refresh",
              expiresAt: Date.now() + 3_600_000
            }
          })
        );
        return 0;
      }
    });
    assert.equal(enrolled.label, "secondary");
    assert.equal(existsSync(enrolled.path), true);
    assert.equal(existsSync(profileDirectory), false);

    let duplicateLoginRan = false;
    await assert.rejects(
      loginAccount("claude-code", "secondary", {
        temporaryParent: root,
        runLogin: async () => {
          duplicateLoginRan = true;
          return 0;
        }
      }),
      /already enrolled/
    );
    assert.equal(duplicateLoginRan, false);

    let failedProfile = "";
    await assert.rejects(
      loginAccount("claude-code", "failed", {
        temporaryParent: root,
        runLogin: async (invocation) => {
          failedProfile = invocation.profileDirectory;
          return 130;
        }
      }),
      /exited with code 130/
    );
    assert.equal(existsSync(failedProfile), false);
    assert.equal(
      existsSync(join(stateHome, "subscriptions", "claude-code", "failed.json")),
      false
    );

    let keychainService = "";
    let removedService = "";
    const keychainAccount = await loginAccount("claude-code", "keychain", {
      temporaryParent: root,
      platform: "darwin",
      runLogin: async (invocation) => {
        keychainService = claudeProfileKeychainService(invocation.profileDirectory);
        return 0;
      },
      keychain: {
        read: async (service) => {
          assert.equal(service, keychainService);
          return JSON.stringify({
            claudeAiOauth: {
              accessToken: "keychain-claude",
              refreshToken: "keychain-refresh",
              expiresAt: Date.now() + 3_600_000
            }
          });
        },
        remove: async (service) => {
          removedService = service;
        }
      }
    });
    assert.equal(removedService, keychainService);
    assert.equal(existsSync(keychainAccount.path), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousStateHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousStateHome;
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test("accounts login rejects non-interactive modes before starting OAuth", async () => {
  await assert.rejects(
    buildProgram().parseAsync([
      "node",
      "routekit",
      "--no-input",
      "accounts",
      "login",
      "claude-code",
      "--name",
      "secondary"
    ]),
    /interactive and does not support --json or --no-input/
  );
});
