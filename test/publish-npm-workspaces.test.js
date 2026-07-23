import assert from "node:assert/strict";
import test from "node:test";

import {
  exactPackageVersionExists,
  publishTarball
} from "../scripts/publish-npm-workspaces.mjs";

const registry = "https://registry.npmjs.org";
const packageVersion = {
  name: "@velum-labs/routekit",
  version: "0.9.0",
  tarball: "/tmp/velum-labs-routekit-0.9.0.tgz",
  registry,
  access: "public"
};

function sequenceSpawn(results) {
  const calls = [];
  return {
    calls,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      const result = results.shift();
      assert.ok(result, `unexpected command: ${command} ${args.join(" ")}`);
      return result;
    }
  };
}

test("exact package version lookup distinguishes published versions from 404s", () => {
  const published = sequenceSpawn([{ status: 0, stdout: '"0.9.0"\n', stderr: "" }]);
  assert.equal(
    exactPackageVersionExists(packageVersion.name, packageVersion.version, {
      registry,
      spawn: published.spawn
    }),
    true
  );
  assert.deepEqual(published.calls[0].args, [
    "view",
    "@velum-labs/routekit@0.9.0",
    "version",
    "--json",
    "--registry",
    registry
  ]);

  const missing = sequenceSpawn([
    { status: 1, stdout: "", stderr: "npm error code E404\nnpm error 404 Not Found" }
  ]);
  assert.equal(
    exactPackageVersionExists(packageVersion.name, packageVersion.version, {
      registry,
      spawn: missing.spawn
    }),
    false
  );
});

test("exact package version lookup fails closed on registry errors", () => {
  const unavailable = sequenceSpawn([
    { status: 1, stdout: "", stderr: "npm error code EAI_AGAIN" }
  ]);
  assert.throws(
    () =>
      exactPackageVersionExists(packageVersion.name, packageVersion.version, {
        registry,
        spawn: unavailable.spawn
      }),
    /could not query/
  );
});

test("publisher skips an immutable version that already exists", () => {
  const fake = sequenceSpawn([{ status: 0, stdout: '"0.9.0"\n', stderr: "" }]);
  assert.equal(publishTarball(packageVersion, { spawn: fake.spawn }), "skipped");
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].args[0], "view");
});

test("publisher uploads a missing version with provenance enabled", () => {
  const fake = sequenceSpawn([
    { status: 1, stdout: "", stderr: "npm error code E404" },
    { status: 0 }
  ]);
  assert.equal(publishTarball(packageVersion, { spawn: fake.spawn }), "published");
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1].args, [
    "publish",
    packageVersion.tarball,
    "--access",
    "public",
    "--registry",
    registry
  ]);
  assert.equal(fake.calls[1].options.env.NPM_CONFIG_PROVENANCE, "true");
});

test("publisher recovers when a failed upload became visible on npm", () => {
  const fake = sequenceSpawn([
    { status: 1, stdout: "", stderr: "npm error code E404" },
    { status: 1 },
    { status: 0, stdout: '"0.9.0"\n', stderr: "" }
  ]);
  assert.equal(publishTarball(packageVersion, { spawn: fake.spawn }), "recovered");
  assert.equal(fake.calls.length, 3);
});
