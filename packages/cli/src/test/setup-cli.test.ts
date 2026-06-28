import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { FUSIONKIT_PYPI_VERSION, fusionkitWarmArgv } from "../fusion/env.js";
import type { HostInfo } from "../fusion/local-catalog.js";
import {
  ensureLocalPanelSupported,
  localPanelUnsupportedMessage,
  panelUsesLocalMlx,
  platformCapabilities
} from "../fusion/platform.js";
import type { PanelModelSpec } from "../fusion/env.js";

const CLI = fileURLToPath(new URL("../index.js", import.meta.url));

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FUSIONKIT_NO_TUI: "1" }
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function host(appleSilicon: boolean): HostInfo {
  return {
    platform: appleSilicon ? "darwin" : "linux",
    arch: appleSilicon ? "arm64" : "x64",
    totalRamGB: 32,
    appleSilicon
  };
}

const MLX_PANEL: PanelModelSpec[] = [{ id: "qwen", model: "mlx-community/Qwen3-1.7B-4bit", provider: "mlx" }];
const CLOUD_PANEL: PanelModelSpec[] = [{ id: "gpt", model: "gpt-5.5", provider: "openai" }];

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
  assert.deepEqual(argv.args, ["run", "fusionkit", "--help"]);
  assert.equal(argv.cwd, "/tmp/fusionkit-checkout");

  const offline = fusionkitWarmArgv("/tmp/fusionkit-checkout", { offline: true });
  assert.deepEqual(offline.args, ["run", "--offline", "fusionkit", "--help"]);
});

// ---- cross-platform gating ----

test("panelUsesLocalMlx detects mlx members (provider defaults to mlx)", () => {
  assert.equal(panelUsesLocalMlx(MLX_PANEL), true);
  assert.equal(panelUsesLocalMlx([{ id: "q", model: "some-model" }]), true);
  assert.equal(panelUsesLocalMlx(CLOUD_PANEL), false);
});

test("ensureLocalPanelSupported throws for a local panel off Apple Silicon", () => {
  assert.throws(() => ensureLocalPanelSupported(MLX_PANEL, host(false)), /Apple Silicon/);
  // ... and points the user at the cross-platform cloud path.
  assert.match(localPanelUnsupportedMessage(host(false)), /cloud panel/);
});

test("ensureLocalPanelSupported allows a local panel on Apple Silicon and cloud anywhere", () => {
  assert.doesNotThrow(() => ensureLocalPanelSupported(MLX_PANEL, host(true)));
  assert.doesNotThrow(() => ensureLocalPanelSupported(CLOUD_PANEL, host(false)));
  assert.doesNotThrow(() => ensureLocalPanelSupported(CLOUD_PANEL, host(true)));
});

test("platformCapabilities reports cloud everywhere and local MLX only on Apple Silicon", () => {
  const linux = platformCapabilities(host(false));
  const cloud = linux.find((cap) => cap.label === "cloud ensembles");
  const localMlx = linux.find((cap) => cap.label === "local MLX ensembles");
  assert.equal(cloud?.ok, true);
  assert.equal(localMlx?.ok, false);

  const mac = platformCapabilities(host(true));
  assert.equal(mac.find((cap) => cap.label === "local MLX ensembles")?.ok, true);
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

test("doctor --help documents the --provision warm-up flag", () => {
  const result = runCli(["doctor", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--provision/);
});
