import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  installClaudeIntegration,
  uninstallClaudeIntegration
} from "../install.js";
import type { ClaudeInstallOwner } from "../install.js";

const OWNER: ClaudeInstallOwner = {
  id: "example-host",
  displayName: "Example Host",
  installCommand: "example install claude",
  uninstallCommand: "example uninstall claude",
  startCommand: "example serve"
};

function install(
  configDirectory: string,
  gatewayUrl = "http://127.0.0.1:9999/",
  authToken?: string
) {
  return installClaudeIntegration({
    gatewayUrl,
    ...(authToken !== undefined ? { authToken } : {}),
    modelId: "claude-code/claude-sonnet",
    owner: OWNER,
    claudeConfigDir: configDirectory
  });
}

test("Claude managed install updates and restores the exact original settings", () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-install-"));
  const configPath = join(configDirectory, "settings.json");
  const original = '{ "permissions": { "allow": ["Bash(git status)"] } }\n';
  writeFileSync(configPath, original);
  try {
    const installed = install(configDirectory, "http://127.0.0.1:9999/", "gateway-secret");
    assert.equal(installed.action, "installed");
    assert.deepEqual(installed.managedKeys.sort(), [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
      "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
    ]);
    const settings = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Bash(git status)"] });
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9999");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "gateway-secret");

    assert.equal(
      install(configDirectory, "http://127.0.0.1:8888", "updated-secret").action,
      "updated"
    );
    assert.equal(
      JSON.parse(readFileSync(configPath, "utf8")).env.ANTHROPIC_BASE_URL,
      "http://127.0.0.1:8888"
    );

    assert.equal(
      uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      }).removed,
      true
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(
      existsSync(join(configDirectory, `.${OWNER.id}-integration.json`)),
      false
    );
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("Claude uninstall preserves user edits made after install", () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-edits-"));
  const configPath = join(configDirectory, "settings.json");
  try {
    install(configDirectory);
    const settings = JSON.parse(readFileSync(configPath, "utf8"));
    settings.theme = "dark";
    settings.env.USER_SETTING = "kept";
    writeFileSync(configPath, `${JSON.stringify(settings, null, 2)}\n`);

    uninstallClaudeIntegration({
      ownerId: OWNER.id,
      claudeConfigDir: configDirectory
    });
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      theme: "dark",
      env: { USER_SETTING: "kept" }
    });
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("Claude install refuses malformed settings and user-owned env conflicts", () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-conflict-"));
  const configPath = join(configDirectory, "settings.json");
  try {
    writeFileSync(configPath, "{not-json");
    assert.throws(() => install(configDirectory), /not valid JSON/);
    writeFileSync(
      configPath,
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://user.example" } })}\n`
    );
    assert.throws(() => install(configDirectory), /already define env\.ANTHROPIC_BASE_URL/);
    assert.equal(
      existsSync(join(configDirectory, `.${OWNER.id}-integration.json`)),
      false
    );
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("pending ownership metadata safely restores after an interrupted update", () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "routekit-claude-interrupt-"));
  const configPath = join(configDirectory, "settings.json");
  const manifestPath = join(configDirectory, `.${OWNER.id}-integration.json`);
  const original = '{"theme":"light"}\n';
  writeFileSync(configPath, original);
  try {
    install(configDirectory);
    const installed = readFileSync(configPath, "utf8");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.installedContentHashes = [
      createHash("sha256").update(installed).digest("hex"),
      "pending-next-content"
    ];
    manifest.managedEnvValues.ANTHROPIC_BASE_URL.push("http://127.0.0.1:7777");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    assert.equal(
      uninstallClaudeIntegration({
        ownerId: OWNER.id,
        claudeConfigDir: configDirectory
      }).removed,
      true
    );
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
});
