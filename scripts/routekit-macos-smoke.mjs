#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildChildEnv } from "../packages/runtime-utils/dist/index.js";

assert.equal(process.platform, "darwin", "the RouteKit launchd smoke requires macOS");
assert.equal(
  process.env.CI,
  "true",
  "the launchd smoke is CI-only because it owns the com.routekit.daemon user service"
);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTEKIT = join(ROOT, "packages", "routekit-cli", "dist", "index.js");

function run(command, args, env, timeoutMs = 90_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`${command} ${args.join(" ")} timed out\n${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function checked(command, args, env) {
  const result = await run(command, args, env);
  assert.equal(
    result.code,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`
  );
  return result;
}

const temporary = mkdtempSync(join(tmpdir(), "routekit-macos-smoke-"));
const home = join(temporary, "home");
const stateHome = join(temporary, "routekit");
const portlessState = join(temporary, "portless");
const configPath = join(home, ".config", "routekit", "router.yaml");
mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });

const provider = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1/models") {
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "macos-smoke", object: "model" }]
      })
    );
    return;
  }
  request.resume();
  response.end(
    JSON.stringify({
      id: "chatcmpl-macos-smoke",
      object: "chat.completion",
      created: 0,
      model: "macos-smoke",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "MACOS_ROUTEKIT_OK" },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    })
  );
});
await new Promise((resolveListen) =>
  provider.listen(0, "127.0.0.1", resolveListen)
);
const address = provider.address();
assert.ok(typeof address === "object" && address !== null);
writeFileSync(
  configPath,
  "providers:\n  openai: {}\ndefaultModel: openai/macos-smoke\n"
);

const env = buildChildEnv({
  extra: {
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    PORTLESS_STATE_DIR: portlessState,
    ROUTEKIT_PORTLESS: "1",
    ROUTEKIT_TELEMETRY: "0",
    ROUTEKIT_NO_UPDATE_CHECK: "1",
    OPENAI_API_KEY: "macos-smoke-key",
    OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    NO_COLOR: "1"
  }
});

let routekitStarted = false;
let portlessStarted = false;
try {
  await checked(
    "pnpm",
    [
      "--filter",
      "@velum-labs/routekit-runtime",
      "exec",
      "portless",
      "proxy",
      "start",
      "--no-tls",
      "-p",
      "1355"
    ],
    env
  );
  portlessStarted = true;

  const started = JSON.parse(
    (
      await checked(
        process.execPath,
        [ROUTEKIT, "start", "--port", "0", "--json"],
        env
      )
    ).stdout
  );
  routekitStarted = true;
  assert.equal(started.supervisor, "launchd");
  assert.match(started.url, /\.localhost(?::1355)?$/);

  const token = readFileSync(
    join(stateHome, "secrets", "data-token"),
    "utf8"
  ).trim();
  const response = await fetch(`${started.url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "openai/macos-smoke",
      messages: [{ role: "user", content: "macOS launchd smoke" }]
    })
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /MACOS_ROUTEKIT_OK/);

  const status = JSON.parse(
    (
      await checked(
        process.execPath,
        [ROUTEKIT, "status", "--json"],
        env
      )
    ).stdout
  );
  assert.equal(status.daemon.supervisor, "launchd");
  assert.equal(status.daemon.dataUrl, started.url);
} finally {
  if (routekitStarted) {
    await run(
      process.execPath,
      [ROUTEKIT, "stop", "--force", "--json"],
      env
    );
  }
  await run(
    process.execPath,
    [ROUTEKIT, "daemon", "service", "uninstall", "--json"],
    env
  );
  if (portlessStarted) {
    await run(
      "pnpm",
      [
        "--filter",
        "@velum-labs/routekit-runtime",
        "exec",
        "portless",
        "proxy",
        "stop"
      ],
      env
    );
  }
  await new Promise((resolveClose) => provider.close(resolveClose));
  rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  });
}

process.stdout.write("RouteKit macOS launchd + Portless smoke passed\n");
