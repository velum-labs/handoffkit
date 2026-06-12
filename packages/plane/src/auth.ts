import { sha256Hex } from "@warrant/protocol";

import type { PrincipalRecord, PrincipalRole } from "./store.js";

/** The authenticated caller behind a request. */
export type Principal = {
  principalId: string;
  name: string;
  role: PrincipalRole;
};

/** Tokens are stored only as their sha256; high-entropy random tokens make
 * this a safe, constant-time-comparable lookup key. */
export function hashToken(token: string): string {
  // TODO(brittle): sha256-only lookup with no server-side pepper; safe for high-entropy tokens but weak if tokens are short/guessable.
  return sha256Hex(token);
}

export function toPrincipal(record: PrincipalRecord): Principal {
  return {
    principalId: record.principalId,
    name: record.name,
    role: record.role
  };
}

/**
 * Role capability model. `admin` can do anything; the others are scoped to
 * the actions the spec assigns them. Runner enrollment is gated separately
 * (enroller role or a single-use enroll token), and runner-claim/event/
 * completion endpoints authenticate with runner tokens + claim tokens, not
 * principals.
 */
// TODO(hardcoded): role→capability matrix is code-defined; cannot be customized per deployment without a code change.
const CAPABILITIES: Record<PrincipalRole, Set<string>> = {
  admin: new Set([
    "runs:read",
    "runs:create",
    "runs:approve",
    "runs:cancel",
    "runners:read",
    "policy:read",
    "blobs:write",
    "export:read",
    "principals:manage"
  ]),
  requester: new Set(["runs:read", "runs:create", "runs:cancel", "blobs:write", "policy:read"]),
  approver: new Set(["runs:read", "runs:approve", "policy:read"]),
  enroller: new Set(["runners:read"])
};

export type Capability =
  | "runs:read"
  | "runs:create"
  | "runs:approve"
  | "runs:cancel"
  | "runners:read"
  | "policy:read"
  | "blobs:write"
  | "export:read"
  | "principals:manage";

export function principalCan(role: PrincipalRole, capability: Capability): boolean {
  return CAPABILITIES[role].has(capability);
}
