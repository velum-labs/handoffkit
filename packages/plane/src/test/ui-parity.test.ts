import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { RUN_EVENT_TYPES } from "@fusionkit/protocol";

/**
 * The control panel is deliberately dependency-free, so it carries its own
 * copy of the event-summary switch instead of importing the protocol's
 * `summarizeRunEvent`. This test is the drift guard the copy pays for: the
 * UI must name exactly the run-event types the protocol vocabulary declares
 * (which is itself completeness-checked against the `RunEvent` union at
 * compile time). Adding an event type without teaching the panel about it
 * fails here, not silently in a browser's default branch.
 */

const APP_JS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "ui",
  "app.js"
);

test("the control panel's eventSummary covers exactly the protocol's run-event types", () => {
  const source = readFileSync(APP_JS, "utf8");
  const start = source.indexOf("function eventSummary(");
  assert.ok(start >= 0, "ui/app.js must define eventSummary");
  const end = source.indexOf("function ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);

  const seen = new Set<string>();
  for (const match of body.matchAll(/case "([a-z.]+)":/g)) {
    seen.add(match[1] as string);
  }

  assert.deepEqual(
    [...seen].sort(),
    [...RUN_EVENT_TYPES].sort(),
    "ui eventSummary switch must handle exactly the protocol's RunEvent types"
  );
});
