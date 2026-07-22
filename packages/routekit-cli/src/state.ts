import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { readPackageVersion } from "@routekit/cli-core";
import { writeFileAtomic } from "@routekit/runtime";

import { routekitHome } from "./config.js";

export function routekitVersion(): string {
  return readPackageVersion(import.meta.url);
}

export function writeStateSnapshot(
  category: "catalog" | "health",
  name: string,
  value: unknown
): string {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`invalid state snapshot name: ${name}`);
  const directory = join(routekitHome(), category);
  const path = join(directory, `${name}.json`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readStateSnapshot(
  category: "catalog" | "health",
  name: string
): unknown {
  if (!/^[a-z0-9-]+$/i.test(name)) {
    throw new Error(`invalid state snapshot name: ${name}`);
  }
  const path = join(routekitHome(), category, `${name}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}
