import type { ChildProcess } from "node:child_process";

import { resolveCursorkitCli } from "@fusionkit/ensemble";
import { freePort, spawnLogged, terminate, waitForOutput } from "@fusionkit/tools";

import { cursorBridgeEnv } from "./bridge-config.js";

/**
 * Start the Cursorkit bridge with its local-model backend pointed at the fusion
 * gateway, and resolve once it is listening. Returns the child and its port.
 */
export async function startCursorBridge(input: {
  fusionUrl: string;
  modelLabel: string;
  /** Every fused ensemble model id (session default first). */
  fusedModels?: readonly string[];
  nativeModels?: readonly string[];
  logFile?: string;
  caCertPath?: string;
  log: (line: string) => void;
}): Promise<{ child: ChildProcess; port: number }> {
  const port = await freePort();
  const env = cursorBridgeEnv({
    port,
    gatewayUrl: input.fusionUrl,
    modelName: input.modelLabel,
    providerModel: input.modelLabel,
    ...(input.fusedModels !== undefined ? { fusedModels: input.fusedModels } : {}),
    ...(input.nativeModels !== undefined ? { nativeModels: input.nativeModels } : {}),
    ...(input.caCertPath !== undefined ? { caCertPath: input.caCertPath } : {})
  });
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
