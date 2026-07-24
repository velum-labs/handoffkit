import assert from "node:assert/strict";
import test from "node:test";

import { ControlError } from "@velum-labs/routekit-runtime";

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
  assert.throws(
    () => validateRouteKitParams("launcher.prepare", { tool: "shell" }),
    /must be one of/
  );
  // `accounts.remove` kinds are connector-routed by the daemon; the protocol
  // edge still requires the identifying fields.
  assert.throws(
    () => validateRouteKitParams("accounts.remove", { label: "work" }),
    /kind/
  );
  assert.deepEqual(
    validateRouteKitParams("accounts.rename", {
      kind: "codex",
      source: "work",
      target: "personal"
    }),
    { kind: "codex", source: "work", target: "personal" }
  );
  assert.throws(
    () =>
      validateRouteKitParams("accounts.rename", {
        kind: "gemini",
        source: "work",
        target: "personal"
      }),
    /must be one of/
  );
  assert.throws(
    () => validateRouteKitParams("accounts.rename", { kind: "codex", source: "work" }),
    /target/
  );
  assert.throws(
    () =>
      validateRouteKitParams("accounts.enroll", {
        kind: "github",
        label: "work",
        credential: {}
      }),
    /must be one of/
  );
  assert.throws(
    () => validateRouteKitParams("accounts.enrollActivate", {
      kind: "gemini",
      accounts: []
    }),
    /one or more accounts/
  );
  assert.deepEqual(
    validateRouteKitParams("accounts.enrollActivate", {
      kind: "codex",
      accounts: [{ label: "work" }]
    }),
    { kind: "codex", accounts: [{ label: "work" }] }
  );
  assert.throws(
    () => validateRouteKitParams("calls.inspect", {}),
    /callId/
  );
  assert.deepEqual(
    validateRouteKitParams("calls.inspect", { callId: "model_call_test" }),
    { callId: "model_call_test" }
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
    Promise.resolve(
      dispatch(
        "providers.set",
        { provider: "anthropic", enabled: true },
        context
      )
    ),
    (error: unknown) =>
      error instanceof ControlError &&
      error.code === "conflict" &&
      /different parameters/.test(error.message)
  );
  await assert.rejects(
    Promise.resolve().then(async () => await dispatch("unknown", {}, context)),
    (error: unknown) => error instanceof ControlError && error.code === "not_found"
  );
});

test("concurrent idempotent retries share one in-flight mutation", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers = new Proxy(
    {},
    {
      get: () => async () => {
        calls += 1;
        await gate;
        return { enabled: true };
      }
    }
  ) as RouteKitControlHandlers;
  const dispatch = createRouteKitControlHandler(handlers);
  const context = {
    signal: new AbortController().signal,
    requestId: "concurrent",
    idempotencyKey: "one-invocation"
  };
  const first = dispatch("telemetry.set", { enabled: true }, context);
  const second = dispatch("telemetry.set", { enabled: true }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, await second);
});
