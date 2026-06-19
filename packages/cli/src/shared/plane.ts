import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { isTerminalStatus } from "@fusionkit/protocol";
import { PlaneClient } from "@fusionkit/sdk";

import { loadHome } from "../config.js";

/** Poll interval while watching a run from the terminal. */
export const WATCH_POLL_MS = 500;
/** How long `warrant continue` waits for the run before returning. */
export const CONTINUE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolve the fusionkit home directory: the `--dir` flag wins, then
 * `FUSIONKIT_HOME` (legacy `WARRANT_HOME`), then `./.fusionkit` (falling back to
 * a pre-existing `./.warrant` so older checkouts keep working).
 */
export function resolveDir(dirFlag: string | undefined): string {
  const fromEnv = process.env.FUSIONKIT_HOME ?? process.env.WARRANT_HOME;
  if (dirFlag !== undefined) return resolve(dirFlag);
  if (fromEnv !== undefined) return resolve(fromEnv);
  if (existsSync(".warrant") && !existsSync(".fusionkit")) return resolve(".warrant");
  return resolve(".fusionkit");
}

export function clientFor(dir: string): PlaneClient {
  const home = loadHome(dir);
  return new PlaneClient(home.config.planeUrl, home.config.adminToken);
}

export async function waitForTerminal(
  client: PlaneClient,
  runId: string,
  onStatus: (status: string) => void
): Promise<string> {
  let last = "";
  for (;;) {
    const view = await client.getRun(runId);
    if (view.status !== last) {
      last = view.status;
      onStatus(view.status);
    }
    if (isTerminalStatus(view.status)) {
      return view.status;
    }
    if (view.status === "awaiting_approval") {
      onStatus(
        `awaiting approval (${view.consentRequirements.join("; ")}) — run: warrant approve ${runId}`
      );
      return view.status;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, WATCH_POLL_MS));
  }
}
