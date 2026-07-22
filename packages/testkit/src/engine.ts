/**
 * Spawn the internal Python synthesis sidecar from Node — the same
 * `fusionkit-sidecar` entrypoint the production CLI spawns — against a
 * caller-provided sidecar config.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reservePort, spawnCaptured, waitForHttpReady } from "./proc.js";
import { uvRunArgv } from "./python.js";
import { CODEX_TEST_TOKEN_ENV } from "./router-config.js";

export type EngineHandle = {
  /** Base URL of the internal sidecar surface. */
  url: string;
  port: number;
  /** The engine process's own output (uvicorn, tracebacks, ...). */
  log: () => string;
  close: () => Promise<void>;
};

export async function startEngine(options: {
  /** The sidecar YAML (see `simSidecarConfigYaml`). */
  configYaml: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}): Promise<EngineHandle> {
  const configDir = mkdtempSync(join(tmpdir(), "fusionkit-testkit-engine-"));
  const configPath = join(configDir, "router.yaml");
  writeFileSync(configPath, options.configYaml);
  const reservation = await reservePort();
  const port = reservation.port;
  const runner = uvRunArgv("fusionkit", "fusionkit-sidecar", [
    "serve",
    "--config",
    configPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port)
  ]);
  // Seed the fake codex subscription token so sim-backed `codex` endpoints
  // authenticate without a real ChatGPT login (harmless for other providers).
  // env-spread-allowed: the engine is a trusted test child of this harness
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [CODEX_TEST_TOKEN_ENV]: process.env[CODEX_TEST_TOKEN_ENV] ?? "sim-codex-token",
    ...options.env
  };
  await reservation.release();
  const proc = spawnCaptured({ ...runner, env });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHttpReady(`${url}/health`, proc, {
      timeoutMs: options.startupTimeoutMs ?? 120_000,
      label: "fusionkit-sidecar"
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
