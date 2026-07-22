import assert from "node:assert/strict";
import test from "node:test";

import {
  baggageOf,
  carrierFromEnv,
  envOf,
  newSessionCarrier,
  traceIdOf,
  withBaggage
} from "../index.js";

test("generic trace carriers cross environment and baggage boundaries", () => {
  const created = newSessionCarrier();
  const enriched = withBaggage(created.carrier, { "route.owner": "example", attempt: 2 });
  const roundTrip = carrierFromEnv(envOf(enriched));
  assert.ok(roundTrip);
  assert.equal(traceIdOf(roundTrip), created.traceId);
  assert.deepEqual(baggageOf(roundTrip, ["route.owner", "attempt"]), {
    "route.owner": "example",
    attempt: "2"
  });
});
