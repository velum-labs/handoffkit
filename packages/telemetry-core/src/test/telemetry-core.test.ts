import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { anonymousEventProperties, createConsentManager } from "../index.js";

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
