import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

let home: string;

function warrant(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, "--dir", home, ...args], {
    encoding: "utf8"
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "warrant-cli-test-"));
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
});

test("help prints usage", () => {
  const result = warrant(["help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /governed execution and provenance plane/);
  assert.match(result.stdout, /warrant continue --agent KIND/);
  assert.match(result.stdout, /warrant ui/);
});

test("init creates keys, config, and policy; refuses to re-init", () => {
  const result = warrant(["init"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /initialized warrant home/);
  assert.match(result.stdout, /admin token \(for the control panel\)/);
  assert.ok(existsSync(join(home, "config.json")));
  assert.ok(existsSync(join(home, "policy.json")));
  // The org private key is sealed at rest; a master key file is generated.
  assert.ok(existsSync(join(home, "keys", "plane.key.enc")));
  assert.ok(existsSync(join(home, "keys", "plane.pub.pem")));
  assert.ok(existsSync(join(home, "master.key")));

  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    version: string;
    host: string;
    secretsKeyHex?: string;
  };
  assert.equal(config.version, "warrant.config.v2");
  assert.equal(config.host, "127.0.0.1");
  // No key material lives in config.json anymore.
  assert.equal(config.secretsKeyHex, undefined);

  const again = warrant(["init"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already initialized/);
});

test("secrets are stored encrypted and listed by name only", () => {
  const set = warrant(["secrets", "set", "NPM_TOKEN", "super-secret-value"]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /encrypted at rest/);

  const list = warrant(["secrets", "list"]);
  assert.equal(list.status, 0);
  assert.equal(list.stdout.trim(), "NPM_TOKEN");

  const stored = readFileSync(join(home, "secrets.enc"), "utf8");
  assert.ok(!stored.includes("super-secret-value"), "value must be encrypted");
});

test("ui prints the control panel address and login token", () => {
  const result = warrant(["ui"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /control panel: http:\/\/127\.0\.0\.1:7172\/ui\//);
  assert.match(result.stdout, /login token: {3}\S+/);
});

test("unknown commands and missing arguments fail with guidance", () => {
  const unknown = warrant(["frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command/);

  const missingAgent = warrant(["run", "do things"]);
  assert.equal(missingAgent.status, 1);
  assert.match(missingAgent.stderr, /--agent is required/);

  const missingTask = warrant(["continue", "--agent", "mock"]);
  assert.equal(missingTask.status, 1);
  assert.match(missingTask.stderr, /task prompt is required/);

  const badAgent = warrant(["continue", "--agent", "nonsense", "task"]);
  assert.equal(badAgent.status, 1);
  assert.match(badAgent.stderr, /unknown agent kind/);
});

test("verify fails closed on a tampered bundle file", () => {
  const path = join(home, "garbage.bundle.json");
  const fake = {
    version: "warrant.bundle.v1",
    contract: { signatures: [], workspace: { baseRef: "x" } },
    receipt: {
      contractHash: "0".repeat(64),
      signatures: [],
      status: "completed",
      workspaceIn: { baseRef: "y", manifestHash: "z" },
      workspaceOut: { diffHash: "", artifactHashes: [] },
      secretsReleased: [],
      eventsHead: "",
      eventCount: 0
    },
    events: [],
    keys: { planePublicKeyPem: "", runnerPublicKeyPem: "" }
  };
  writeFileSync(path, JSON.stringify(fake));
  const result = warrant(["verify", path]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VERIFICATION FAILED/);
});
