import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  captureLoginCredential,
  claudeProfileKeychainService
} from "@velum-labs/routekit-accounts";
import type { ManagedAccountLoginInvocation } from "@velum-labs/routekit-accounts";

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

    // Browserless logins ask Codex for its device-code flow explicitly.
    const device = await captureLoginCredential("codex", "device", {
      temporaryParent: root,
      noBrowser: true
    });
    assert.equal(device.label, "device");
    const deviceMarker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      args: string[];
    };
    assert.deepEqual(deviceMarker.args, ["login", "--device-auth"]);
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
  process.env.ROUTEKIT_HOME = stateHome;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  let profileDirectory = "";
  try {
    const captured = await captureLoginCredential("claude-code", "secondary", {
      temporaryParent: root,
      runLogin: async (invocation: ManagedAccountLoginInvocation) => {
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
    assert.equal(captured.label, "secondary");
    assert.equal(
      (captured.credential as { claudeAiOauth?: { accessToken?: string } })
        .claudeAiOauth?.accessToken,
      "managed-claude"
    );
    assert.equal(existsSync(profileDirectory), false);

    // A label already enrolled in the daemon-owned store never starts OAuth.
    const enrolledDirectory = join(stateHome, "subscriptions", "claude-code");
    mkdirSync(enrolledDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(enrolledDirectory, "taken.json"), "{}");
    let duplicateLoginRan = false;
    await assert.rejects(
      captureLoginCredential("claude-code", "taken", {
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
      captureLoginCredential("claude-code", "failed", {
        temporaryParent: root,
        runLogin: async (invocation: ManagedAccountLoginInvocation) => {
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
    const keychainCapture = await captureLoginCredential("claude-code", "keychain", {
      temporaryParent: root,
      platform: "darwin",
      runLogin: async (invocation: ManagedAccountLoginInvocation) => {
        keychainService = claudeProfileKeychainService(invocation.profileDirectory);
        return 0;
      },
      keychain: {
        read: async (service: string) => {
          assert.equal(service, keychainService);
          return JSON.stringify({
            claudeAiOauth: {
              accessToken: "keychain-claude",
              refreshToken: "keychain-refresh",
              expiresAt: Date.now() + 3_600_000
            }
          });
        },
        remove: async (service: string) => {
          removedService = service;
        }
      }
    });
    assert.equal(removedService, keychainService);
    assert.equal(
      (keychainCapture.credential as { claudeAiOauth?: { accessToken?: string } })
        .claudeAiOauth?.accessToken,
      "keychain-claude"
    );
  } finally {
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

test("accounts login rejects unknown kinds before contacting the daemon", async () => {
  await assert.rejects(
    buildProgram().parseAsync([
      "node",
      "routekit",
      "accounts",
      "login",
      "not-a-kind",
      "--name",
      "x"
    ]),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /unknown subscription kind.*first-launch kinds/);
      assert.doesNotMatch(message, /gemini|grok|kimi|cliproxy/i);
      return true;
    }
  );
});

test("accounts login rejects retained internal connectors before OAuth or daemon work", async () => {
  await assert.rejects(
    buildProgram().parseAsync([
      "node",
      "routekit",
      "accounts",
      "login",
      "gemini"
    ]),
    /not offered at first launch.*claude-code, codex/
  );
});

test("daemon enrollment rejects hidden and duplicate account labels before OAuth", async () => {
  await assert.rejects(
    captureLoginCredential("codex", ".hidden", {
      runLogin: async () => {
        throw new Error("OAuth must not run");
      }
    }),
    /account name/
  );
});

test("one unified accounts surface: no connector subcommands leak to the CLI", () => {
  const program = buildProgram();
  const accounts = program.commands.find((command) => command.name() === "accounts");
  assert.ok(accounts);
  const subcommands = accounts.commands.map((command) => command.name()).sort();
  assert.deepEqual(subcommands, ["add", "list", "login", "remove", "status"]);
  const login = accounts.commands.find((command) => command.name() === "login");
  assert.ok(login);
  assert.match(login.helpInformation(), /--no-browser/);
  assert.match(login.description(), /claude-code, codex/);
  assert.doesNotMatch(login.description(), /gemini|grok|kimi|cliproxy/i);
});
