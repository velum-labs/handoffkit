import { mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { SubscriptionMode } from "@velum-labs/routekit-registry";

import {
  defaultSubscriptionAccountDirectory,
  defaultSubscriptionCredentialPath
} from "./credentials.js";

export type SubscriptionAccountSource =
  | { kind: "auto"; directory?: string; canonicalPath?: string }
  | { kind: "canonical"; directory?: string; canonicalPath?: string }
  | { kind: "directory"; path: string }
  | { kind: "paths"; paths: readonly string[]; stateDirectory?: string };

export type ResolvedSubscriptionAccounts = {
  paths: string[];
  stateDirectory: string;
};

function accountFiles(directory: string): string[] {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => resolve(directory, name));
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

/**
 * Resolve every server-owned subscription configuration to the same account
 * sequence. `auto` reads only daemon-enrolled accounts; enrollment is a
 * daemon-owned transaction and router startup must never mutate credentials.
 */
export async function resolveSubscriptionAccounts(
  mode: SubscriptionMode,
  source: SubscriptionAccountSource = { kind: "auto" }
): Promise<ResolvedSubscriptionAccounts> {
  switch (source.kind) {
    case "directory":
      return { paths: accountFiles(source.path), stateDirectory: resolve(source.path) };
    case "paths": {
      const stateDirectory = resolve(
        source.stateDirectory ?? defaultSubscriptionAccountDirectory(mode)
      );
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      return { paths: uniquePaths(source.paths), stateDirectory };
    }
    case "canonical":
    case "auto": {
      const directory = resolve(
        source.directory ?? defaultSubscriptionAccountDirectory(mode)
      );
      const enrolled = accountFiles(directory);
      if (source.kind === "auto") {
        return { paths: enrolled, stateDirectory: directory };
      }
      const canonical = resolve(
        source.canonicalPath ?? defaultSubscriptionCredentialPath(mode)
      );
      return {
        // The credential loader owns file/keychain fallback and will report a
        // precise error when neither source exists.
        paths: [canonical],
        stateDirectory: directory
      };
    }
    default: {
      const unreachable: never = source;
      throw new Error(`unsupported subscription account source: ${String(unreachable)}`);
    }
  }
}
