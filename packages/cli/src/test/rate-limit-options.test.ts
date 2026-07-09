import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ON_RATE_LIMIT_MESSAGE,
  ON_RATE_LIMIT_OPTIONS,
  ON_RATE_LIMIT_POLICIES
} from "../shared/options.js";

// Snapshot of the rate-limit handoff prompt copy shown by `fusionkit init`
// (extras step) and `fusionkit config edit`. The wording was reworked after a
// QA report that "fusion — continue on the ensemble" was ambiguous (ENG-618);
// if a copy change here is intentional, keep every hint a concrete description
// of the runtime behavior in FusionVendorProxy and update this snapshot.
test("rate-limit handoff prompt copy explains each policy concretely", () => {
  assert.equal(ON_RATE_LIMIT_MESSAGE, "When a vendor passthrough model hits a rate limit / credit wall");
  assert.deepEqual(ON_RATE_LIMIT_OPTIONS, [
    {
      value: "fusion",
      label: "fusion",
      hint: "rerun the turn on the fusion ensemble (minus the throttled vendor) and answer from there (default)"
    },
    {
      value: "passthrough",
      label: "passthrough",
      hint: "return the vendor's error to the coding agent as-is (no fallback)"
    },
    { value: "fail", label: "fail", hint: "stop the session with a gateway error" }
  ]);
});

// The label a user picks in the UI must be the exact string written to
// `.fusionkit/fusion.json` (`onRateLimit`), so config files map one-to-one to
// the prompt wording.
test("rate-limit option labels are the exact persisted config values", () => {
  for (const option of ON_RATE_LIMIT_OPTIONS) {
    assert.equal(option.label, option.value);
  }
  assert.deepEqual(ON_RATE_LIMIT_POLICIES, ["fusion", "passthrough", "fail"]);
});

// Every policy has a non-empty hint: the picker must never show a bare policy
// name without an explanation of its behavior.
test("every rate-limit policy carries explanatory help text", () => {
  assert.equal(ON_RATE_LIMIT_OPTIONS.length, 3);
  for (const option of ON_RATE_LIMIT_OPTIONS) {
    assert.ok(option.hint.length > 0, `policy "${option.value}" is missing a hint`);
  }
});
