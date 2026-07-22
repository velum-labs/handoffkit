import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { CLIPROXY_PINNED_VERSION } from "../cliproxy.js";
import {
  cliproxyAccountEntries,
  cliproxyAccountMatchesKind,
  loginCliproxyAccount,
  removeCliproxyAccount,
  resolveAccountKind
} from "../connector.js";

function plantAuthFile(home: string, name: string, type?: string): string {
  const path = join(home, "cliproxy", "auth", `${name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(type === undefined ? {} : { type }));
  return path;
}

test("account kinds resolve to their registry connector, including aliases", () => {
  assert.deepEqual(resolveAccountKind("codex"), {
    kind: "codex",
    connector: "native",
    localOnly: false
  });
  assert.deepEqual(resolveAccountKind("claude"), {
    kind: "claude-code",
    connector: "native",
    localOnly: false
  });
  const gemini = resolveAccountKind("antigravity");
  assert.equal(gemini.kind, "gemini");
  assert.equal(gemini.connector, "cliproxy");
  assert.equal(gemini.localOnly, true);
  assert.equal(gemini.cliproxyLoginFlag, "-antigravity-login");
  assert.throws(() => resolveAccountKind("not-a-kind"), /unknown subscription kind/);
});

test("cliproxy auth store entries classify by auth type and remove by label", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-connector-"));
  const env = { ROUTEKIT_HOME: home };
  try {
    assert.deepEqual(cliproxyAccountEntries(env), []);
    plantAuthFile(home, "antigravity-user@example.com", "antigravity");
    plantAuthFile(home, "xai-user@example.com", "xai");
    plantAuthFile(home, "kimi-1712", "kimi");
    plantAuthFile(home, "mystery-blob");
    const entries = cliproxyAccountEntries(env);
    assert.deepEqual(
      entries.map((entry) => [entry.kind, entry.label]),
      [
        ["gemini", "antigravity-user@example.com"],
        ["kimi", "kimi-1712"],
        ["mystery", "mystery-blob"],
        ["grok", "xai-user@example.com"]
      ]
    );
    assert.equal(removeCliproxyAccount("kimi-1712", env).removed, true);
    assert.equal(removeCliproxyAccount("kimi-1712", env).removed, false);
    assert.equal(
      cliproxyAccountEntries(env).some((entry) => entry.label === "kimi-1712"),
      false
    );

    // Legacy cliproxy claude/codex auth files keep a raw type; they still
    // match the native canonical kinds for removal routing.
    plantAuthFile(home, "legacy-claude@example.com", "claude");
    plantAuthFile(home, "legacy-codex@example.com", "codex");
    const legacy = cliproxyAccountEntries(env);
    const claudeLegacy = legacy.find((entry) => entry.label === "legacy-claude@example.com");
    const codexLegacy = legacy.find((entry) => entry.label === "legacy-codex@example.com");
    assert.ok(claudeLegacy);
    assert.ok(codexLegacy);
    assert.equal(claudeLegacy.kind, "claude");
    assert.equal(cliproxyAccountMatchesKind(claudeLegacy, "claude-code"), true);
    assert.equal(cliproxyAccountMatchesKind(codexLegacy, "codex"), true);
    assert.equal(cliproxyAccountMatchesKind(claudeLegacy, "gemini"), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cliproxy login installs, runs the kind's flag, and reports added accounts", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-connector-login-"));
  const env = { ROUTEKIT_HOME: home };
  const binary = join(home, "cliproxy", "bin", CLIPROXY_PINNED_VERSION, "cli-proxy-api");
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, "");
  try {
    let commandRan: string | undefined;
    let argsRan: readonly string[] = [];
    const result = await loginCliproxyAccount("gemini", {
      env,
      noBrowser: true,
      runLogin: async (invocation) => {
        commandRan = invocation.command;
        argsRan = invocation.args;
        plantAuthFile(home, "antigravity-fresh@example.com", "antigravity");
        return 0;
      }
    });
    assert.equal(commandRan, binary);
    assert.equal(argsRan[0], "--config");
    assert.ok(argsRan.includes("-antigravity-login"));
    assert.ok(argsRan.includes("-no-browser"));
    assert.deepEqual(
      result.added.map((entry) => [entry.kind, entry.label]),
      [["gemini", "antigravity-fresh@example.com"]]
    );
    // The login run created the private sidecar config with an ingress key.
    assert.equal(existsSync(join(home, "cliproxy", "config.yaml")), true);

    await assert.rejects(
      loginCliproxyAccount("gemini", { env, runLogin: async () => 130 }),
      /exited with code 130/
    );
    await assert.rejects(
      loginCliproxyAccount("gemini", {
        env,
        runLogin: async () => {
          // Wipe the store so a no-op login has nothing to refresh.
          for (const entry of cliproxyAccountEntries(env)) {
            removeCliproxyAccount(entry.label, env);
          }
          return 0;
        }
      }),
      /without adding an account/
    );
    plantAuthFile(home, "antigravity-refresh@example.com", "antigravity");
    const refreshed = await loginCliproxyAccount("gemini", {
      env,
      runLogin: async () => {
        // Overwrite the same auth file in place (re-login refresh).
        plantAuthFile(home, "antigravity-refresh@example.com", "antigravity");
        return 0;
      }
    });
    assert.deepEqual(
      refreshed.added.map((entry) => [entry.kind, entry.label]),
      [["gemini", "antigravity-refresh@example.com"]]
    );
    await assert.rejects(loginCliproxyAccount("codex", { env }), /not a cliproxy-backed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
