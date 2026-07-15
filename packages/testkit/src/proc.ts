import type { ChildProcess } from "node:child_process";

import {
  freePort,
  reservePort,
  spawnLogged,
  terminateGroup
} from "@routekit/runtime";
import type { ReservedPort } from "@routekit/runtime";

export type SpawnedProcess = {
  child: ChildProcess;
  log: () => string;
  nextLine: (pattern: RegExp, timeoutMs: number) => Promise<string>;
  close: () => Promise<void>;
};

export function spawnCaptured(input: {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): SpawnedProcess {
  const processHandle = spawnLogged(input.command, [...input.args], {
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.env !== undefined ? { env: input.env } : {})
  });
  return {
    child: processHandle.child,
    log: processHandle.log,
    nextLine: (pattern, timeoutMs) =>
      new Promise<string>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = (): void => {
          const match = processHandle.log().split("\n").find((line) => pattern.test(line));
          if (match !== undefined) {
            resolve(match);
            return;
          }
          if (Date.now() >= deadline) {
            reject(
              new Error(
                `timed out waiting for ${pattern} in child output:\n${processHandle.log()}`
              )
            );
            return;
          }
          setTimeout(poll, 20);
        };
        poll();
      }),
    close: async () => {
      const child = processHandle.child;
      if (child.exitCode !== null || child.signalCode !== null) return;
      terminateGroup(child);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      terminateGroup(child, 0, "SIGKILL");
      processHandle.closeLog();
    }
  };
}

export async function waitForHttpReady(
  url: string,
  proc: SpawnedProcess,
  input: { timeoutMs: number; label: string }
): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) {
      throw new Error(
        `${input.label} exited with code ${proc.child.exitCode} during startup\n--- log ---\n${proc.log()}`
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${input.label} did not become ready within ${input.timeoutMs}ms\n--- log ---\n${proc.log()}`
  );
}

export { freePort, reservePort };
export type { ReservedPort };
