/**
 * Shared bearer-token verification for the local gateway servers. One
 * implementation, hardened once: comparisons run over fixed-length digests so
 * neither content nor length differences are observable through timing.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Constant-time string equality (length-independent; no timing leaks). */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  // The digest comparison decides; the direct check only guards the
  // astronomically unlikely hash collision and runs on match alone.
  return timingSafeEqual(aDigest, bDigest) && a === b;
}

/** Verify an `Authorization: Bearer <token>` header value. */
export function verifyBearerToken(header: string | undefined, expected: string): boolean {
  return typeof header === "string" && timingSafeStringEqual(header, `Bearer ${expected}`);
}

/**
 * The gateway's request-authorization rule: a matching bearer token or a
 * matching `x-api-key` header.
 */
export function authorizedRequest(req: IncomingMessage, token: string): boolean {
  if (verifyBearerToken(req.headers.authorization, token)) return true;
  const apiKey = req.headers["x-api-key"];
  return typeof apiKey === "string" && timingSafeStringEqual(apiKey, token);
}
