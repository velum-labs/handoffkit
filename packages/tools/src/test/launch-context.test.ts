import assert from "node:assert/strict";
import test from "node:test";

import {
  createDisposerRunner,
  createToolLaunchContext
} from "../launch-context.js";
import type { ToolLaunchSpec } from "../types.js";

const spec: ToolLaunchSpec = {
  gatewayUrl: "https://gateway.test",
  defaultModel: "model-a",
  models: [{ id: "model-a" }],
  args: []
};

test("disposer runner tears down once in reverse registration order", async () => {
  const order: string[] = [];
  const runner = createDisposerRunner();
  runner.register(() => {
    order.push("first");
  });
  runner.register(async () => {
    order.push("second");
  });

  const firstRun = runner.run();
  const secondRun = runner.run();
  assert.equal(secondRun, firstRun);
  await firstRun;

  assert.deepEqual(order, ["second", "first"]);
  assert.throws(() => runner.register(() => {}), /teardown started/);
});

test("disposer runner attempts every teardown and aggregates failures", async () => {
  const order: string[] = [];
  const runner = createDisposerRunner();
  runner.register(() => {
    order.push("first");
    throw new Error("first failed");
  });
  runner.register(() => {
    order.push("second");
    throw new Error("second failed");
  });

  await assert.rejects(runner.run(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((entry) => (entry as Error).message),
      ["second failed", "first failed"]
    );
    return true;
  });
  assert.deepEqual(order, ["second", "first"]);
});

test("tool launch context wires host services to the shared disposer", async () => {
  const calls: string[] = [];
  const log = (line: string): void => {
    calls.push(`log:${line}`);
  };
  const launch = createToolLaunchContext({
    spec,
    log,
    prepareForPassthrough: () => {
      calls.push("prepare");
    },
    registerPort: (name, port) => `${name}:${port}`,
    unregisterPort: (name) => {
      calls.push(`unregister:${name}`);
    }
  });

  assert.equal(launch.context.spec, spec);
  assert.equal(launch.context.log, log);
  assert.equal(launch.context.registerPort("gateway", 8080), "gateway:8080");
  launch.context.prepareForPassthrough();
  launch.context.unregisterPort("gateway");
  launch.context.registerDisposer(() => {
    calls.push("dispose");
  });
  await launch.dispose();

  assert.deepEqual(calls, ["prepare", "unregister:gateway", "dispose"]);
});
