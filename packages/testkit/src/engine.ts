/**
 * Spawn the REAL Python fusion engine (`fusionkit serve`) from Node — the same
 * entrypoint the production CLI spawns (`packages/cli/src/fusion/stack.ts`),
 * run from the repo checkout via `uv run --package fusionkit`, against a
 * caller-provided router config (usually built by `simRouterConfigYaml` so
 * every endpoint points at the provider simulator).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freePort, spawnCaptured, waitForHttpReady } from "./proc.js";
import { uvRunArgv } from "./python.js";

export type EngineHandle = {
  /** Base URL of the engine's OpenAI-compatible surface (`/v1/...`). */
  url: string;
  port: number;
  /** The engine process's own output (uvicorn, tracebacks, ...). */
  log: () => string;
  close: () => Promise<void>;
};

export async function startEngine(options: {
  /** The `fusionkit serve` router YAML (see `simRouterConfigYaml`). */
  configYaml: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}): Promise<EngineHandle> {
  const configDir = mkdtempSync(join(tmpdir(), "fusionkit-testkit-engine-"));
  const configPath = join(configDir, "router.yaml");
  writeFileSync(configPath, options.configYaml);
  const port = await freePort();
  const runner = uvRunArgv("fusionkit", "fusionkit", [
    "serve",
    "--config",
    configPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ]);
  const proc = spawnCaptured({
    ...runner,
    ...(options.env !== undefined ? { env: options.env } : {})
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHttpReady(`${url}/v1/models`, proc, {
      timeoutMs: options.startupTimeoutMs ?? 120_000,
      label: "fusionkit serve (real engine)"
    });
  } catch (error) {
    await proc.close();
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    port,
    log: proc.log,
    close: async () => {
      await proc.close();
      rmSync(configDir, { recursive: true, force: true });
    }
  };
}
