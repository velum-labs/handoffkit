import type { ChildProcess } from "node:child_process";

import { reservePort, spawnLogged, terminate, waitForOutput } from "@velum-labs/routekit-runtime";

import { cursorBridgeEnv } from "./bridge-config.js";
import type { CursorBridgeModelDescriptor } from "./bridge-config.js";
import { resolveCursorkitCli } from "./cursorkit-path.js";

/**
 * Start the Cursorkit bridge with its local-model backend pointed at the
 * configured gateway. Resolves once it is listening.
 */
export async function startCursorBridge(input: {
  gatewayUrl: string;
  modelLabel: string;
  models?: readonly CursorBridgeModelDescriptor[];
  logFile?: string;
  caCertPath?: string;
  apiKey?: string;
  log: (line: string) => void;
}): Promise<{ child: ChildProcess; port: number }> {
  // Hold the port until the bridge is about to bind it, so a concurrent picker
  // cannot steal it in the gap between choosing and spawning.
  const reservation = await reservePort();
  const port = reservation.port;
  const env = cursorBridgeEnv({
    port,
    gatewayUrl: input.gatewayUrl,
    modelName: input.modelLabel,
    providerModel: input.modelLabel,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    ...(input.models !== undefined ? { models: input.models } : {}),
    ...(input.caCertPath !== undefined ? { caCertPath: input.caCertPath } : {})
  });
  const { serveCli } = resolveCursorkitCli();
  await reservation.release();
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
  input.log(`Cursorkit bridge listening on http://127.0.0.1:${port}`);
  return { child: proc.child, port };
}
