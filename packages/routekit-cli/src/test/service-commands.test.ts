import assert from "node:assert/strict";
import test from "node:test";

import { drainGraceMs, serveArgvFrom } from "../commands/serve-options.js";
import { argsWithPort } from "../commands/upgrade.js";

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

test("serve argv reconstruction preserves options and pins the config path", () => {
  assert.deepEqual(
    serveArgvFrom({
      options: {
        host: "127.0.0.1",
        port: "8080",
        authToken: "secret",
        portless: false,
        drainGrace: "10"
      },
      configPath: "/abs/router.yaml"
    }),
    [
      "--config",
      "/abs/router.yaml",
      "gateway",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "--auth-token",
      "secret",
      "--no-portless",
      "--drain-grace",
      "10"
    ]
  );
  assert.deepEqual(
    serveArgvFrom({ options: { host: "127.0.0.1", port: "8080" }, port: "0" }),
    ["gateway", "serve", "--host", "127.0.0.1", "--port", "0"]
  );
});

test("blue-green replacement argv rebinds the port to an ephemeral one", () => {
  assert.deepEqual(
    argsWithPort(["gateway", "serve", "--port", "8080", "--no-portless"], "0"),
    ["gateway", "serve", "--port", "0", "--no-portless"]
  );
  assert.deepEqual(argsWithPort(["gateway", "serve"], "0"), [
    "gateway",
    "serve",
    "--port",
    "0"
  ]);
});
