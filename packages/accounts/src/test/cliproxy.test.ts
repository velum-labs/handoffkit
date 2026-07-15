import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CLIPROXY_API_KEY_ENV,
  CLIPROXY_BASE_URL_ENV,
  CLIPROXY_PINNED_VERSION,
  cliproxyAssetName,
  cliproxyBinaryPath,
  cliproxyConfigPath,
  cliproxyHome,
  cliproxyStatus,
  ensureCliproxyConfig,
  installCliproxy
} from "../cliproxy.js";

test("managed cliproxy state uses RouteKit paths and private permissions", async () => {
  const routekitHome = mkdtempSync(join(tmpdir(), "routekit-cliproxy-"));
  const env = { ROUTEKIT_HOME: routekitHome };
  assert.equal(cliproxyHome(env), join(routekitHome, "cliproxy"));
  const configPath = ensureCliproxyConfig(env);
  assert.equal(configPath, cliproxyConfigPath(env));
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(configPath)).mode & 0o777, 0o700);
  const text = readFileSync(configPath, "utf8");
  assert.match(text, /auth-dir:/);
  assert.doesNotMatch(text, /fusion/i);

  const binary = join(
    routekitHome,
    "cliproxy",
    "bin",
    CLIPROXY_PINNED_VERSION,
    "cli-proxy-api"
  );
  mkdirSync(dirname(binary), { recursive: true });
  writeFileSync(binary, "");
  assert.equal(cliproxyBinaryPath(CLIPROXY_PINNED_VERSION, env), binary);
  const installed = await installCliproxy({ env });
  assert.equal(installed.downloaded, false);
  assert.equal(installed.binary, binary);
  assert.equal("ingressKey" in installed, false);
});

test("cliproxy status honors RouteKit env names without exposing credentials", async () => {
  const routekitHome = mkdtempSync(join(tmpdir(), "routekit-cliproxy-status-"));
  const env = {
    ROUTEKIT_HOME: routekitHome,
    [CLIPROXY_BASE_URL_ENV]: "http://127.0.0.1:9999/",
    [CLIPROXY_API_KEY_ENV]: "private-test-value"
  };
  let authorization: string | null = null;
  const status = await cliproxyStatus({
    env,
    fetchImpl: (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return Promise.resolve(Response.json({ data: [{ id: "one" }, { id: "two" }] }));
    }
  });
  assert.equal(authorization, "Bearer private-test-value");
  assert.equal(status.baseUrl, "http://127.0.0.1:9999");
  assert.equal(status.reachable, true);
  assert.equal(status.models, 2);
  assert.equal(JSON.stringify(status).includes("private-test-value"), false);
});

test("cliproxy release asset mapping is exhaustive for supported hosts", () => {
  assert.equal(
    cliproxyAssetName(CLIPROXY_PINNED_VERSION, "linux", "x64"),
    `CLIProxyAPI_${CLIPROXY_PINNED_VERSION}_linux_amd64.tar.gz`
  );
  assert.equal(
    cliproxyAssetName(CLIPROXY_PINNED_VERSION, "darwin", "arm64"),
    `CLIProxyAPI_${CLIPROXY_PINNED_VERSION}_darwin_aarch64.tar.gz`
  );
  assert.equal(cliproxyAssetName(CLIPROXY_PINNED_VERSION, "win32", "x64"), undefined);
});
