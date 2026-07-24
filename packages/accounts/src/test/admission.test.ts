import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasUsableCredits,
  isPoolEligible,
  windowAdmissionStatus
} from "../admission.js";

test("hasUsableCredits recognizes team credit signals", () => {
  assert.equal(hasUsableCredits({ hasCredits: true, unlimited: false }), true);
  assert.equal(hasUsableCredits({ hasCredits: false, unlimited: false }), false);
  assert.equal(hasUsableCredits({ unlimited: true }), true);
  assert.equal(hasUsableCredits(undefined), false);
});

test("pool eligibility keeps credit-backed members over the switch threshold", () => {
  const limits = {
    windows: {
      primary: {
        utilization: 1,
        observedAt: 1,
        source: "usage" as const
      }
    },
    observedAt: 1,
    source: "usage" as const,
    completeness: "snapshot" as const,
    credits: { hasCredits: true, unlimited: false }
  };
  assert.equal(
    isPoolEligible({ limits, switchThreshold: 0.9 }),
    true
  );
  assert.equal(
    isPoolEligible({
      limits: { ...limits, credits: { hasCredits: false, unlimited: false } },
      switchThreshold: 0.9
    }),
    false
  );
});

test("window admission status distinguishes credits-only pressure from exhaustion", () => {
  assert.equal(windowAdmissionStatus(0.5, 0.9, { hasCredits: true }), "ok");
  assert.equal(
    windowAdmissionStatus(1, 0.9, { hasCredits: true, unlimited: false }),
    "credits-only"
  );
  assert.equal(
    windowAdmissionStatus(1, 0.9, { hasCredits: false, unlimited: false }),
    "exhausted"
  );
  assert.equal(windowAdmissionStatus(1, 0.9, undefined, "rejected"), "exhausted");
});
