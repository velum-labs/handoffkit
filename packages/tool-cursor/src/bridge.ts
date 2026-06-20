import type { ChildProcess } from "node:child_process";

import { resolveCursorkitCli } from "@fusionkit/ensemble";
import { freePort, spawnLogged, terminate, waitForOutput } from "@fusionkit/tools";

/**
 * Inject the portless CA so spawned Node children (the cursor bridge) trust the
 * proxy's HTTPS routes. Only `NODE_EXTRA_CA_CERTS` is set: it extends Node's
 * trust store rather than replacing it. A no-op when portless is off.
 */
function withCaEnv<T extends Record<string, string | undefined>>(
  env: T,
  caCertPath: string | undefined
): T {
  if (caCertPath === undefined) return env;
  return {
    ...env,
    NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS ?? caCertPath
  };
}

/** Drop bridge/model/e2e env so a parent's leftover config never leaks in. */
function scrubbedBridgeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith("BRIDGE_") ||
      key.startsWith("MODEL_") ||
      key.startsWith("E2E_") ||
      key.startsWith("CURSOR_UPSTREAM")
    ) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

/**
 * Start the Cursorkit bridge with its local-model backend pointed at the fusion
 * gateway, and resolve once it is listening. Returns the child and its port.
 */
export async function startCursorBridge(input: {
  fusionUrl: string;
  modelLabel: string;
  logFile?: string;
  caCertPath?: string;
  log: (line: string) => void;
}): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const env = {
    ...withCaEnv(scrubbedBridgeEnv(), input.caCertPath),
    BRIDGE_PORT: String(port),
    BRIDGE_ROUTE_INVENTORY: "true",
    CURSOR_UPSTREAM_BASE_URL: "https://api2.cursor.sh",
    MODEL_BASE_URL: `${input.fusionUrl}/v1`,
    MODEL_API_KEY: "local",
    MODEL_NAME: input.modelLabel,
    MODEL_PROVIDER_MODEL: input.modelLabel,
    MODEL_CONTEXT_TOKEN_LIMIT: "128000"
  };
  const { serveCli } = resolveCursorkitCli();
  const proc = spawnLogged(process.execPath, [serveCli, "serve"], {
    ...(input.logFile !== undefined ? { logFile: input.logFile } : {}),
    env
  });
  try {
    await waitForOutput(proc, /bridge listening/, { timeoutMs: 20_000, label: "Cursorkit bridge" });
  } catch (error) {
    terminate(proc.child);
    throw error instanceof Error ? error : new Error(String(error));
  }
  input.log(`fusion: Cursorkit bridge listening on http://127.0.0.1:${port}`);
  return { child: proc.child, port };
}
