import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";

export type CliTestResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export function runCliForTest(
  entry: string,
  args: readonly string[],
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {}
): CliTestResult {
  const result = spawnSync(process.execPath, [entry, ...args], {
    ...options,
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

export function withEnvironment<T>(
  changes: Record<string, string | undefined>,
  work: () => T
): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(changes)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return work();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
