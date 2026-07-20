import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRateLimitWindowName,
  formatResetCountdown,
  formatUtilizationBar,
  limitsSummary,
  renderUsageLines
} from "../usage-format.js";

test("usage formatters clamp bars and show precise reset countdowns", () => {
  assert.match(formatUtilizationBar(0.52), /52%$/);
  assert.match(formatUtilizationBar(2), /100%$/);
  assert.equal(
    formatResetCountdown(Date.UTC(2026, 0, 1, 2, 14) / 1000, Date.UTC(2026, 0, 1)),
    "resets in 2h 14m"
  );
  assert.equal(
    formatResetCountdown(Date.UTC(2026, 0, 1) / 1000, Date.UTC(2026, 0, 1)),
    "resets now"
  );
  assert.equal(formatRateLimitWindowName("five_hour"), "5 hour");
  assert.equal(formatRateLimitWindowName("seven_day_sonnet"), "7 day · sonnet");
  assert.equal(formatRateLimitWindowName("extra_usage"), "extra usage");
});

test("usage rendering includes windows, provenance, and no-observation hint", () => {
  const now = Date.UTC(2026, 0, 1);
  const usage = {
    accountSets: [{
      mode: "codex" as const,
      strategy: "sticky" as const,
      switchThreshold: 0.9,
      members: [
        {
          id: "one",
          mode: "codex" as const,
          label: "work",
          sourcePath: "/private/work.json",
          active: true,
          models: [],
          limits: {
            windows: {
              primary: {
                utilization: 0.52,
                resetsAt: now / 1000 + 2 * 60 * 60,
                observedAt: now / 1000 - 3 * 60,
                source: "headers" as const
              }
            },
            planType: "pro",
            observedAt: now / 1000 - 3 * 60,
            source: "headers" as const,
            completeness: "partial" as const
          }
        },
        {
          id: "two",
          mode: "codex" as const,
          label: "spare",
          sourcePath: "/private/spare.json",
          active: false,
          models: []
        }
      ]
    }]
  };
  const output = renderUsageLines(usage, now).join("\n");
  assert.match(output, /primary/);
  assert.match(output, /52%/);
  assert.match(output, /observed 3m ago via headers/);
  assert.match(output, /no usage data available yet/);
  assert.match(output, /routekit doctor/);
  assert.equal(limitsSummary(usage, "codex", "work", now), "primary 52% · resets in 2h");
});
