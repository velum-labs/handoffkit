import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createCursorIdeAttestation,
  cursorIdeAttestationContext
} from "./routekit-manual-evidence.mjs";
import {
  cursorDefaultProfileDirectory,
  snapshotCursorDefaultProfile
} from "./routekit-cursor-state.mjs";

const MODEL_CALL_PATHS = new Set([
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/cursor/chat/completions"
]);
const LOCAL_HARNESS_KEY = "routekit-attestation-local";
const GATEWAY_TOKEN_ENV = "ROUTEKIT_CURSOR_GATEWAY_TOKEN";
const PROXY_REQUEST_BASE = "http://routekit-attestation.invalid";

export function loopbackGatewayTarget(value) {
  const target = new URL(value);
  assert.equal(target.protocol, "http:", "gateway URL must use HTTP");
  assert.equal(target.hostname, "127.0.0.1", "gateway URL must use literal loopback");
  assert.equal(target.username, "", "gateway URL cannot contain credentials");
  assert.equal(target.password, "", "gateway URL cannot contain credentials");
  assert.match(target.port, /^\d+$/, "gateway URL must name an explicit port");
  assert.equal(target.pathname, "/", "gateway URL cannot contain a path");
  assert.equal(target.search, "", "gateway URL cannot contain a query");
  assert.equal(target.hash, "", "gateway URL cannot contain a fragment");
  return target;
}

export function proxyRequestPath(value) {
  const requestTarget = new URL(value, PROXY_REQUEST_BASE);
  assert.equal(
    requestTarget.origin,
    PROXY_REQUEST_BASE,
    "proxy request target must be relative"
  );
  return `${requestTarget.pathname}${requestTarget.search}`;
}

function parseModel(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.model === "string"
      ? parsed.model
      : undefined;
  } catch {
    return undefined;
  }
}

export async function startCursorGatewayProxy(input) {
  const target = loopbackGatewayTarget(input.gatewayUrl);
  assert.ok(
    typeof input.authToken === "string" && input.authToken.length > 0,
    `${GATEWAY_TOKEN_ENV} is required`
  );
  let requestsObserved = 0;
  let attemptsObserved = 0;
  let overBudget = false;
  let modelMatched = true;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const path = proxyRequestPath(request.url ?? "/");
      const url = new URL(path, target);
      const isModelCall =
        request.method === "POST" && MODEL_CALL_PATHS.has(url.pathname);
      if (isModelCall) {
        attemptsObserved += 1;
        modelMatched &&= parseModel(body) === input.model;
        if (requestsObserved >= input.maxCalls) {
          overBudget = true;
          response.writeHead(429, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                type: "routekit_cursor_attestation_budget_exhausted",
                message: "Cursor IDE attestation gateway budget exhausted"
              }
            })
          );
          return;
        }
        requestsObserved += 1;
      }
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      headers.authorization = `Bearer ${input.authToken}`;
      // lgtm[js/request-forgery] The origin is restricted to literal loopback,
      // the request target is forced relative, and redirects are disabled.
      const upstream = await fetch(url, {
        method: request.method,
        headers,
        redirect: "error",
        ...(body.length > 0 ? { body } : {})
      });
      response.writeHead(
        upstream.status,
        Object.fromEntries(
          [...upstream.headers].filter(
            ([name]) =>
              !["content-encoding", "content-length", "transfer-encoding"].includes(
                name
              )
          )
        )
      );
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })().catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            type: "routekit_cursor_attestation_proxy_error",
            message: "Cursor IDE attestation proxy request failed"
          }
        })
      );
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    measurements() {
      return {
        requestsObserved,
        attemptsObserved,
        maxAllowed: input.maxCalls,
        overBudget,
        modelMatched
      };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  };
}

function cursorVersion() {
  const result = spawnSync("cursor", ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Cursor IDE version is unavailable");
  }
  const version = result.stdout.trim().replaceAll(/[\r\n\t]/g, " ").slice(0, 160);
  if (version.length === 0) throw new Error("Cursor IDE version is unavailable");
  return version;
}

function bundledCursorkitPaths(root) {
  const require = createRequire(join(root, "packages", "tool-cursor", "package.json"));
  const serveCli = require.resolve("@velum-labs/cursorkit");
  return {
    serveCli,
    harnessCli: join(dirname(serveCli), "testing", "cli.js")
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function exactHarnessPids(root) {
  if (!existsSync(root)) return [];
  const paths = [root];
  const pids = new Set();
  while (paths.length > 0) {
    const directory = paths.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        paths.push(path);
      } else if (entry.isFile() && entry.name === "state.json") {
        try {
          const state = JSON.parse(readFileSync(path, "utf8"));
          for (const field of [
            "pid",
            "cursorPid",
            "bridgePid",
            "connectProxyPid"
          ]) {
            if (Number.isInteger(state[field]) && state[field] > 1) {
              pids.add(state[field]);
            }
          }
        } catch {
          // A partial state file is not cleanup authority.
        }
      }
    }
  }
  return [...pids];
}

function signalExactProcess(pid, signal) {
  if (!processAlive(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The exact process exited between the liveness check and signal.
    }
  }
}

async function cleanupExactProcesses(root, child) {
  if (child !== undefined && child.exitCode === null) {
    signalExactProcess(child.pid, "SIGTERM");
  }
  const pids = exactHarnessPids(root);
  for (const pid of pids) signalExactProcess(pid, "SIGTERM");
  const deadline = Date.now() + 3_000;
  while (
    Date.now() < deadline &&
    [child?.pid, ...pids].some((pid) => pid !== undefined && processAlive(pid))
  ) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  for (const pid of [child?.pid, ...pids]) {
    if (pid !== undefined && processAlive(pid)) signalExactProcess(pid, "SIGKILL");
  }
}

async function runBundledHarness(input) {
  const artifactsDirectory = join(input.temporaryRoot, "cursorkit-artifacts");
  const cursorkit = bundledCursorkitPaths(input.root);
  const quotedServeCli = cursorkit.serveCli.replaceAll('"', '\\"');
  writeFileSync(
    join(input.temporaryRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        scripts: { ck: `node "${quotedServeCli}" ck` }
      },
      null,
      2
    )}\n`
  );
  const env = { ...process.env };
  delete env[GATEWAY_TOKEN_ENV];
  delete env.MODEL_API_KEY;
  delete env.BRIDGE_LOG_MODEL_PAYLOADS;
  delete env.E2E_SCRIPTED_TOOL_BACKEND;
  const child = spawn(
    process.execPath,
    [
      cursorkit.harnessCli,
      "--suite",
      "desktop-ui-experimental",
      "--include-experimental",
      "--base-url",
      `${input.proxyUrl}/v1`,
      "--model",
      input.model,
      "--provider-model",
      input.model,
      "--display-name",
      "routekit-qualified",
      "--api-key",
      LOCAL_HARNESS_KEY,
      "--timeout-ms",
      String(input.timeoutMs),
      "--artifacts-dir",
      artifactsDirectory
    ],
    {
      cwd: input.temporaryRoot,
      env,
      detached: true,
      stdio: "ignore"
    }
  );
  try {
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      const timer = setTimeout(
        () => rejectExit(new Error("Cursorkit desktop harness timed out")),
        input.timeoutMs + 30_000
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectExit(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });
    assert.equal(exitCode, 0, "Cursorkit desktop harness child failed");
    const summaryPath = join(artifactsDirectory, "summary.json");
    assert.ok(existsSync(summaryPath), "Cursorkit desktop harness summary is missing");
    return JSON.parse(readFileSync(summaryPath, "utf8"));
  } finally {
    await cleanupExactProcesses(
      join(input.temporaryRoot, ".cursor-rpc", "ck"),
      child
    );
  }
}

export async function runActiveCursorIdeAttestation(input, dependencies = {}) {
  const context = cursorIdeAttestationContext(
    input.mapping,
    input.report,
    input.revision
  );
  assert.equal(
    context.maxGatewayRequests,
    1,
    "Cursor IDE attestation requires the one-call route budget"
  );
  const profileDirectory =
    input.profileDirectory ??
    (dependencies.cursorDefaultProfileDirectory ?? cursorDefaultProfileDirectory)();
  const snapshot =
    dependencies.snapshotDefaultProfile ?? snapshotCursorDefaultProfile;
  const before = snapshot(profileDirectory);
  assert.ok(before.count > 0, "Cursor default-profile state is unavailable");
  const temporaryRoot = (
    dependencies.makeTemporaryRoot ??
    (() => mkdtempSync(join(tmpdir(), "routekit-cursor-attestation-")))
  )();
  const startProxy = dependencies.startProxy ?? startCursorGatewayProxy;
  let proxy;
  try {
    proxy = await startProxy({
      gatewayUrl: input.gatewayUrl,
      authToken: input.authToken,
      model: context.model,
      maxCalls: context.maxGatewayRequests
    });
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  let summary;
  let runError;
  let isolatedProfileRemoved = false;
  try {
    summary = await (dependencies.runHarness ?? runBundledHarness)({
      root: input.root,
      temporaryRoot,
      proxyUrl: proxy.url,
      model: context.model,
      timeoutMs: input.timeoutMs
    });
  } catch (error) {
    runError = error;
  } finally {
    try {
      await proxy.close();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
      isolatedProfileRemoved = !existsSync(temporaryRoot);
    }
  }
  const after = snapshot(profileDirectory);
  const unchanged =
    before.count === after.count && before.digest === after.digest;
  if (!unchanged) throw new Error("Cursor default-profile state changed");
  if (!isolatedProfileRemoved) {
    throw new Error("Cursorkit isolated profile was not removed");
  }
  if (runError !== undefined) throw runError;
  const measurements = {
    gateway: proxy.measurements(),
    defaultProfileState: { before, after, unchanged },
    isolatedProfileRemoved
  };
  return createCursorIdeAttestation(
    input.mapping,
    input.report,
    summary,
    (dependencies.cursorVersion ?? cursorVersion)(),
    measurements,
    input.revision
  );
}

export { GATEWAY_TOKEN_ENV };
