import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { runCliForTest } from "@routekit/cli-core/testing";
import { FUSIONKIT_PYPI_VERSION, fusionkitPyCommand, fusionkitWarmArgv } from "../fusion/env.js";
import type { HostInfo } from "../fusion/local-catalog.js";
import {
  localPanelUnsupportedMessage,
  platformCapabilities
} from "../fusion/platform.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = runCliForTest(CLI, args, {
    env: { ...process.env, NO_COLOR: "1", FUSIONKIT_NO_TUI: "1" }
  });
  return { ...result, status: result.status ?? 1 };
}

function host(appleSilicon: boolean): HostInfo {
  return {
    platform: appleSilicon ? "darwin" : "linux",
    arch: appleSilicon ? "arm64" : "x64",
    totalRamGB: 32,
    appleSilicon
  };
}

// ---- engine run argv (the uvx/uv invocation used for real router launches) ----

test("fusionkitPyCommand defaults to the pinned uvx engine", () => {
  const runner = fusionkitPyCommand();
  assert.equal(runner.command, "uvx");
  assert.deepEqual(runner.prefix, [`fusionkit@${FUSIONKIT_PYPI_VERSION}`]);
  assert.equal(runner.cwd, undefined);
});

test("fusionkitPyCommand uses the fusionkit workspace package for local checkouts", () => {
  const runner = fusionkitPyCommand("/tmp/fusionkit-checkout");
  assert.equal(runner.command, "uv");
  assert.deepEqual(runner.prefix, ["run", "--package", "fusionkit", "fusionkit"]);
  assert.equal(runner.cwd, "/tmp/fusionkit-checkout");
});

// ---- engine warm argv (the uvx/uv invocation that pre-provisions the engine) ----

test("fusionkitWarmArgv defaults to the pinned uvx engine help", () => {
  const argv = fusionkitWarmArgv();
  assert.equal(argv.command, "uvx");
  assert.deepEqual(argv.args, [`fusionkit@${FUSIONKIT_PYPI_VERSION}`, "--help"]);
  assert.equal(argv.cwd, undefined);
});

test("fusionkitWarmArgv offline probe inserts --offline before the package spec", () => {
  const argv = fusionkitWarmArgv(undefined, { offline: true });
  assert.equal(argv.command, "uvx");
  assert.deepEqual(argv.args, ["--offline", `fusionkit@${FUSIONKIT_PYPI_VERSION}`, "--help"]);
});

test("fusionkitWarmArgv uses `uv run` against a local checkout (dev override)", () => {
  const argv = fusionkitWarmArgv("/tmp/fusionkit-checkout");
  assert.equal(argv.command, "uv");
  assert.deepEqual(argv.args, ["run", "--package", "fusionkit", "fusionkit", "--help"]);
  assert.equal(argv.cwd, "/tmp/fusionkit-checkout");

  const offline = fusionkitWarmArgv("/tmp/fusionkit-checkout", { offline: true });
  assert.deepEqual(offline.args, ["run", "--offline", "--package", "fusionkit", "fusionkit", "--help"]);
});

// ---- cross-platform gating ----

test("local lifecycle guidance points unsupported hosts to RouteKit", () => {
  assert.match(localPanelUnsupportedMessage(host(false)), /RouteKit/);
  assert.match(localPanelUnsupportedMessage(host(false)), /Apple Silicon/);
});

test("platformCapabilities reports RouteKit fusion everywhere and local lifecycle only on Apple Silicon", () => {
  const linux = platformCapabilities(host(false));
  const routed = linux.find((cap) => cap.label === "RouteKit-backed fusion");
  const localMlx = linux.find((cap) => cap.label === "local MLX lifecycle");
  assert.equal(routed?.ok, true);
  assert.equal(localMlx?.ok, false);

  const mac = platformCapabilities(host(true));
  assert.equal(mac.find((cap) => cap.label === "local MLX lifecycle")?.ok, true);
});

// ---- CLI surface ----

test("top-level help lists the setup command", () => {
  const result = runCli(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\bsetup\b/);
});

test("setup --help documents the warm-up and its flags", () => {
  const result = runCli(["setup", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pre-provision/);
  assert.match(result.stdout, /--force/);
  assert.match(result.stdout, /--fusionkit-dir/);
});

test("doctor --help no longer offers the removed --provision flag", () => {
  const result = runCli(["doctor", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /--provision/);
});
