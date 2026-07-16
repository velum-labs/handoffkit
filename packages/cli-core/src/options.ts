import { fail } from "./errors.js";

export function collect(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

export function parseIdValue(flag: string, spec: string): { id: string; value: string } {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    fail(`${flag} must be ID=VALUE, got "${spec}"`);
  }
  return { id: spec.slice(0, separator), value: spec.slice(separator + 1) };
}

export function parsePort(raw: string | undefined, fallback: number): number {
  const port = Number(raw ?? String(fallback));
  if (!Number.isInteger(port) || port < 0) fail("--port must be a non-negative integer");
  return port;
}

export function parsePositiveNumber(
  flag: string,
  value: string | undefined,
  description = "a positive number"
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${flag} must be ${description}`);
  return parsed;
}

export function parsePositiveInteger(
  flag: string,
  value: string | undefined,
  description = "a positive integer"
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) fail(`${flag} must be ${description}`);
  return parsed;
}
