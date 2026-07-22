import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "@routekit/runtime";

export type ConfigSource = "flag" | "config" | "default";
export type LayeredValue<T> = { value: T; source: ConfigSource };

export function resolveLayer<T>(
  flag: T | undefined,
  config: T | undefined,
  fallback: T
): LayeredValue<T> {
  if (flag !== undefined) return { value: flag, source: "flag" };
  if (config !== undefined) return { value: config, source: "config" };
  return { value: fallback, source: "default" };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function readValidatedJson<T>(
  path: string,
  parse: (raw: unknown, source: string) => T,
  error: (message: string) => Error = (message) => new Error(message)
): T {
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (cause) {
    throw error(
      `${path}: invalid JSON (${cause instanceof Error ? cause.message : String(cause)})`
    );
  }
  return parse(raw, path);
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: { force?: boolean; space?: number } = {}
): string {
  if (existsSync(path) && options.force !== true) {
    throw new Error(`${path} already exists`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(value, null, options.space ?? 2)}\n`);
  return path;
}

export function loadMigratingConfig<T>(input: {
  currentPath: string;
  legacyPaths?: readonly string[];
  parse: (raw: unknown, source: string) => T;
  serialize: (value: T) => unknown;
  writeError?: (message: string) => Error;
  onMigration?: (legacyPath: string, currentPath: string) => void;
}): T | undefined {
  const parseFile = (path: string): T =>
    readValidatedJson(path, input.parse, input.writeError);
  if (existsSync(input.currentPath)) return parseFile(input.currentPath);
  const legacyPath = input.legacyPaths?.find((path) => existsSync(path));
  if (legacyPath === undefined) return undefined;
  const value = parseFile(legacyPath);
  try {
    writeJsonAtomic(input.currentPath, input.serialize(value));
    input.onMigration?.(legacyPath, input.currentPath);
  } catch {
    // A read-only filesystem must not make a readable legacy config unusable.
  }
  return value;
}

export function editConfig<T, U = T>(
  current: T,
  mutate: (draft: T) => void,
  clone: (value: T) => T,
  validate: (draft: T) => U
): U {
  const draft = clone(current);
  mutate(draft);
  return validate(draft);
}
