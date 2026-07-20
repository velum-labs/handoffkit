import assert from "node:assert/strict";
import test from "node:test";

import { ControlError } from "@routekit/runtime";

import {
  createRouteKitControlHandler,
  validateRouteKitParams
} from "../index.js";
import type { RouteKitControlHandlers } from "../index.js";

test("method-specific validators reject malformed mutations at the protocol edge", () => {
  assert.throws(
    () => validateRouteKitParams("config.update", { document: "providers: {}" }),
    /expectedRevision/
  );
  assert.throws(
    () => validateRouteKitParams("providers.set", { provider: "openai" }),
    /enabled/
  );
  assert.throws(
    () => validateRouteKitParams("accounts.enroll", {
      kind: "codex",
      label: "work"
    }),
    /credential/
  );
  assert.deepEqual(
    validateRouteKitParams("launcher.prepare", { tool: "codex", cwd: "/tmp" }),
    { tool: "codex", cwd: "/tmp" }
  );
});

test("dispatcher rejects unknown methods and deduplicates idempotent mutations", async () => {
  let calls = 0;
  const handlers = new Proxy(
    {},
    {
      get: () => async () => {
        calls += 1;
        return { revision: calls };
      }
    }
  ) as RouteKitControlHandlers;
  const dispatch = createRouteKitControlHandler(handlers);
  const context = {
    signal: new AbortController().signal,
    requestId: "request",
    idempotencyKey: "same"
  };
  const first = await dispatch(
    "providers.set",
    { provider: "openai", enabled: true },
    context
  );
  const second = await dispatch(
    "providers.set",
    { provider: "openai", enabled: true },
    context
  );
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
  await assert.rejects(
    Promise.resolve().then(async () => await dispatch("unknown", {}, context)),
    (error: unknown) => error instanceof ControlError && error.code === "not_found"
  );
});

