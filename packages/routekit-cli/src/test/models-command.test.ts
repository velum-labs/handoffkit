import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatAccountClassLabel,
  formatBillingModeLabel
} from "@velum-labs/routekit-gateway";

test("models list billing columns use human-readable labels", () => {
  assert.equal(formatBillingModeLabel("metered-api"), "metered API");
  assert.equal(formatBillingModeLabel("subscription"), "subscription");
  assert.equal(formatAccountClassLabel("api-key"), "api-key");
  assert.equal(formatAccountClassLabel("subscription"), "subscription");
});
