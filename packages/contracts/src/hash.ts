import { createHash } from "node:crypto";

import { canonicalize } from "./jcs.js";

export const SHA256_PREFIX = "sha256:";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256PrefixedHex(data: string | Buffer): string {
  return `${SHA256_PREFIX}${sha256Hex(data)}`;
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export function hashCanonicalSha256(value: unknown): string {
  return sha256PrefixedHex(canonicalize(value));
}

export function requestHash(value: unknown): string {
  return hashCanonicalSha256(value);
}

export function responseHash(value: unknown): string {
  return hashCanonicalSha256(value);
}

export function artifactHash(data: string | Buffer): string {
  return sha256PrefixedHex(data);
}

export function schemaBundleHash(schemas: Record<string, unknown>): string {
  const payload = Object.entries(schemas)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, schema]) => ({ path, schema }));
  return hashCanonicalSha256(payload);
}
