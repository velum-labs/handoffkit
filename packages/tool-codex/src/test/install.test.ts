import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  installCodexIntegration,
  uninstallCodexIntegration
} from "../install.js";
import type { CodexInstallOwner } from "../install.js";

const OWNER: CodexInstallOwner = {
  id: "example-host",
  displayName: "Example Host",
  providerId: "example_route",
  installCommand: "example install codex",
  uninstallCommand: "example uninstall codex",
  startCommand: "example serve"
};

test("Codex managed install updates and removes only owner-marked config", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-install-"));
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, 'model = "user-default"\n');
  try {
    const installed = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:9999/",
      owner: OWNER,
      profiles: [
        { modelId: "opaque-primary" },
        { modelId: "opaque-secondary", description: "Secondary route" }
      ],
      codexHome: home
    });
    assert.equal(installed.action, "installed");
    assert.match(readFileSync(configPath, "utf8"), /model = "user-default"/);
    assert.match(readFileSync(configPath, "utf8"), /base_url = "http:\/\/127\.0\.0\.1:9999\/v1"/);
    assert.equal(existsSync(join(home, "opaque-secondary.config.toml")), true);

    const updated = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:8888",
      owner: OWNER,
      profiles: [{ modelId: "opaque-primary" }],
      codexHome: home
    });
    assert.equal(updated.action, "updated");
    assert.equal(existsSync(join(home, "opaque-secondary.config.toml")), false);

    assert.equal(uninstallCodexIntegration({ ownerId: OWNER.id, codexHome: home }).removed, true);
    assert.equal(readFileSync(configPath, "utf8"), 'model = "user-default"\n');
    assert.equal(existsSync(join(home, "opaque-primary.config.toml")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Codex profiles can preserve an opaque model id behind a safe selector", () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-codex-opaque-"));
  try {
    const result = installCodexIntegration({
      gatewayUrl: "http://127.0.0.1:9999",
      owner: OWNER,
      profiles: [{ modelId: "provider/model", profileId: "route-1" }],
      codexHome: home
    });
    assert.deepEqual(result.profiles, ["route-1"]);
    assert.match(readFileSync(join(home, "route-1.config.toml"), "utf8"), /provider\/model/);
    assert.equal(existsSync(join(home, "provider", "model.config.toml")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
