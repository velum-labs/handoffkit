import assert from "node:assert/strict";
import test from "node:test";

import { parseRouterConfig } from "@velum-labs/routekit-gateway";

import { drainGraceMs } from "../commands/serve-options.js";
import { argsWithPort } from "../commands/upgrade.js";
import {
  daemonUnitSpec,
  missingServiceCredentialVariables,
  serviceEnvironment
} from "../daemon.js";

test("daemon service units use stable RouteKit state as their working directory", () => {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = "/tmp/routekit-stable-home";
  try {
    const spec = daemonUnitSpec({
      args: ["daemon", "run"],
      supervisor: "launchd",
      env: {},
      drainGraceMs: 30_000
    });
    assert.equal(spec.workingDirectory, "/tmp/routekit-stable-home");
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
});

test("daemon services capture credentials only for configured providers", () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "configured-secret";
  process.env.ANTHROPIC_API_KEY = "unrelated-secret";
  try {
    const env = serviceEnvironment(
      parseRouterConfig({
        providers: { openai: {} },
        defaultModel: "openai/test-model"
      })
    );
    assert.equal(env.OPENAI_API_KEY, "configured-secret");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(
      missingServiceCredentialVariables(
        parseRouterConfig({
          providers: { openai: {} },
          defaultModel: "openai/test-model"
        }),
        {}
      ),
      ["OPENAI_API_KEY"]
    );
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
  }
});

test("drain grace resolves flag, environment, and default in order", () => {
  const previous = process.env.ROUTEKIT_DRAIN_GRACE;
  delete process.env.ROUTEKIT_DRAIN_GRACE;
  try {
    assert.equal(drainGraceMs(undefined), 30_000);
    assert.equal(drainGraceMs("5"), 5_000);
    assert.equal(drainGraceMs("0"), 0);
    process.env.ROUTEKIT_DRAIN_GRACE = "12";
    assert.equal(drainGraceMs(undefined), 12_000);
    assert.equal(drainGraceMs("5"), 5_000);
    assert.throws(() => drainGraceMs("-1"));
    assert.throws(() => drainGraceMs("nope"));
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_DRAIN_GRACE;
    else process.env.ROUTEKIT_DRAIN_GRACE = previous;
  }
});

test("blue-green replacement argv rebinds the port to an ephemeral one", () => {
  assert.deepEqual(
    argsWithPort(["daemon", "run", "--port", "8080", "--no-portless"], "0"),
    ["daemon", "run", "--port", "0", "--no-portless"]
  );
  assert.deepEqual(argsWithPort(["daemon", "run"], "0"), [
    "daemon",
    "run",
    "--port",
    "0"
  ]);
});
