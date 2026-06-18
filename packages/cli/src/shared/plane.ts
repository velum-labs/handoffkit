import { resolve } from "node:path";

import { isTerminalStatus } from "@warrant/protocol";
import { PlaneClient } from "@warrant/sdk";

import { loadHome } from "../config.js";

/** Poll interval while watching a run from the terminal. */
export const WATCH_POLL_MS = 500;
/** How long `warrant continue` waits for the run before returning. */
export const CONTINUE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Resolve the warrant home directory: the `--dir` flag wins, then
 * `WARRANT_HOME`, then `./.warrant`.
 */
export function resolveDir(dirFlag: string | undefined): string {
  return resolve(dirFlag ?? process.env.WARRANT_HOME ?? ".warrant");
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
