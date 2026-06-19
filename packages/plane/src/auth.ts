import { sha256Hex } from "@fusionkit/protocol";

import type { PrincipalRecord, PrincipalRole } from "./store.js";

/** The authenticated caller behind a request. */
export type Principal = {
  principalId: string;
  name: string;
  role: PrincipalRole;
};

/**
 * Tokens are stored only as their sha256. Every token the plane issues is
 * 256 bits of CSPRNG output, so a plain SHA-256 lookup key is safe: there
 * is nothing to brute-force and no need for a slow password hash. (Short,
 * human-chosen tokens are never issued; if they were, this would need a
 * peppered KDF instead.)
 */
export function hashToken(token: string): string {
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
 * Role capability model, defined in code as the plane's authorization
 * policy. `admin` can do anything; the others are scoped to the actions the
 * spec assigns them. Runner enrollment is gated separately (enroller role
 * or a single-use enroll token), and runner-claim/event/completion
 * endpoints authenticate with runner tokens + claim tokens, not principals.
 * Per-deployment custom roles are intentionally out of scope; this matrix
 * is the contract.
 */
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
