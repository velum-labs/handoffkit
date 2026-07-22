import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listAccounts } from "../accounts.js";
import { writeStateSnapshot } from "../state.js";
import {
  disableTelemetry,
  enableTelemetry,
  resolveTelemetry,
  telemetryPath
} from "../telemetry.js";

test("account listing and state snapshots stay private", () => {
  const previous = process.env.ROUTEKIT_HOME;
  const home = mkdtempSync(join(tmpdir(), "routekit-state-test-"));
  process.env.ROUTEKIT_HOME = home;
  try {
    const codex = join(home, "subscriptions", "codex");
    mkdirSync(codex, { recursive: true, mode: 0o700 });
    writeFileSync(join(codex, "primary.json"), JSON.stringify({ secret: "not-read" }), {
      mode: 0o600
    });
    assert.deepEqual(listAccounts().map((entry) => entry.label), ["primary"]);

    const catalog = writeStateSnapshot("catalog", "models", { models: ["opaque"] });
    const health = writeStateSnapshot("health", "providers", { providers: [] });
    assert.equal(statSync(catalog).mode & 0o777, 0o600);
    assert.equal(statSync(health).mode & 0o777, 0o600);
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
});

test("telemetry is off by default and stores no id when disabled", () => {
  const previousHome = process.env.ROUTEKIT_HOME;
  const previousTelemetry = process.env.ROUTEKIT_TELEMETRY;
  const home = mkdtempSync(join(tmpdir(), "routekit-telemetry-test-"));
  process.env.ROUTEKIT_HOME = home;
  delete process.env.ROUTEKIT_TELEMETRY;
  try {
    assert.equal(resolveTelemetry().enabled, false);
    const enabled = enableTelemetry();
    assert.equal(typeof enabled.installId, "string");
    assert.equal(resolveTelemetry().enabled, true);
    disableTelemetry();
    assert.equal(resolveTelemetry().installId, undefined);
    assert.equal(telemetryPath(), join(home, "telemetry.json"));
    assert.equal(statSync(telemetryPath()).mode & 0o777, 0o600);
  } finally {
    if (previousHome === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previousHome;
    if (previousTelemetry === undefined) delete process.env.ROUTEKIT_TELEMETRY;
    else process.env.ROUTEKIT_TELEMETRY = previousTelemetry;
  }
});
