#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defaultPolicy, FileKeyProvider, Plane, resolveMasterKey, SecretStore, startPlaneServer } from "@fusionkit/plane";
import { Runner } from "@fusionkit/runner";
import { PlaneClient } from "@fusionkit/sdk";

const DEFAULT_HOME = process.env.FUSIONKIT_HOME ?? process.env.WARRANT_HOME ?? "/data/warrant";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7172;

function valueAfter(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}

function homeDir() {
  return valueAfter("--dir", DEFAULT_HOME);
}

function masterKeyPath(dir) {
  return join(dir, "master.key");
}

function keyProvider(dir, master) {
  return new FileKeyProvider(master, join(dir, "keys", "plane.pub.pem"), join(dir, "keys", "plane.key.enc"));
}

function initHome() {
  const dir = homeDir();
  mkdirSync(join(dir, "keys"), { recursive: true });
  const configPath = join(dir, "config.json");
  if (existsSync(configPath)) return;
  const port = Number(valueAfter("--port", String(DEFAULT_PORT)));
  const host = valueAfter("--host", DEFAULT_HOST);
  const config = {
    version: "warrant.config.v2",
    planeUrl: valueAfter("--plane-url", `http://${DEFAULT_HOST}:${port}`),
    port,
    host,
    adminToken: randomBytes(32).toString("base64url"),
    enrollToken: randomBytes(32).toString("base64url"),
    requestedBy: process.env.USER ?? "operator"
  };
  const master = resolveMasterKey(masterKeyPath(dir), { createIfMissing: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "policy.json"), JSON.stringify(defaultPolicy(), null, 2));
  keyProvider(dir, master).ensure();
}

function loadHome() {
  const dir = homeDir();
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
  const master = resolveMasterKey(masterKeyPath(dir));
  const pair = keyProvider(dir, master).getOrgKeyPair();
  return { dir, config, policy, master, planePublicKeyPem: pair.publicKeyPem, planePrivateKeyPem: pair.privateKeyPem };
}

async function startPlane() {
  const home = loadHome();
  const plane = new Plane({
    dataDir: join(home.dir, "data"),
    policy: home.policy,
    planePrivateKeyPem: home.planePrivateKeyPem,
    planePublicKeyPem: home.planePublicKeyPem,
    adminToken: home.config.adminToken,
    enrollToken: home.config.enrollToken,
    secretStore: new SecretStore(join(home.dir, "secrets.enc"), home.master)
  });
  await startPlaneServer(plane, home.config.port, home.config.host);
}

async function startRunner() {
  const home = loadHome();
  const runner = new Runner({
    planeUrl: valueAfter("--plane", home.config.planeUrl),
    pool: valueAfter("--pool", "default"),
    dataDir: valueAfter("--data-dir", "/data/runner"),
    enrollToken: home.config.enrollToken
  });
  await runner.start();
}

async function ui() {
  const home = loadHome();
  console.log(`login token ${home.config.adminToken}`);
}

async function runs() {
  const home = loadHome();
  const client = new PlaneClient(home.config.planeUrl, home.config.adminToken);
  const { runs: list } = await client.listRuns();
  for (const run of list) console.log(`${run.runId} ${run.status}`);
}

const [cmd, sub] = process.argv.slice(2);
if (cmd === "init") initHome();
else if (cmd === "plane" && sub === "start") await startPlane();
else if (cmd === "runner" && sub === "start") await startRunner();
else if (cmd === "ui") await ui();
else if (cmd === "runs") await runs();
else {
  console.error("legacy warrant docker entrypoint: init | plane start | runner start | ui | runs");
  process.exit(1);
}
