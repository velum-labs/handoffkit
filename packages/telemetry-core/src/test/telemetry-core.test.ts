import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  anonymousEventProperties,
  CLI_COMMAND_TELEMETRY_FIELDS,
  createConsentManager,
  telemetryStatusMetadata
} from "../index.js";

test("consent is parameterized and anonymous events redact network identity", () => {
  const root = mkdtempSync(join(tmpdir(), "routekit-telemetry-"));
  try {
    const manager = createConsentManager({
      path: () => join(root, "consent.json"),
      environmentVariable: "EXAMPLE_TELEMETRY",
      randomId: () => "install-id",
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    assert.equal(manager.resolve({}).enabled, false);
    assert.equal(manager.enable().installId, "install-id");
    assert.equal(manager.resolve({}).enabled, true);
    assert.deepEqual(anonymousEventProperties({ command: "test" }), {
      command: "test",
      $process_person_profile: false,
      $ip: null
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared CLI telemetry metadata supports product-specific fields and presentation", () => {
  const fields = {
    "cli.command": [...CLI_COMMAND_TELEMETRY_FIELDS, "product_mode"]
  };
  assert.deepEqual(fields["cli.command"], [
    "command",
    "cli_version",
    "os",
    "arch",
    "node_major",
    "duration_bucket",
    "exit_kind",
    "is_ci",
    "product_mode"
  ]);
  assert.deepEqual(
    telemetryStatusMetadata(
      { enabled: false, source: "do-not-track" },
      fields
    ),
    {
      enabled: false,
      source: "do-not-track",
      installId: null,
      fields
    }
  );
});
