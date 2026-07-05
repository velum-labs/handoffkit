import { scryptSync } from "node:crypto";

import type { PrincipalRecord, PrincipalRole } from "./store.js";

/** The authenticated caller behind a request. */
export type Principal = {
  principalId: string;
  name: string;
  role: PrincipalRole;
};

/**
 * Tokens are stored only as a one-way hash used as a deterministic lookup
 * key. Every token the plane issues is 256 bits of CSPRNG output, so even a
 * fast hash would leave nothing to brute-force; scrypt with a fixed
 * application salt is used anyway so a leaked store resists offline attack
 * regardless of how a deployment mints tokens. The salt must stay fixed:
 * hashes double as store lookup keys (`getPrincipalByTokenHash`), so a
 * per-token salt would break authentication. Changing this scheme
 * invalidates previously stored token hashes (re-issue tokens on upgrade).
 */
const TOKEN_HASH_SALT = "warrant-plane-token-index-v2";

export function hashToken(token: string): string {
  return scryptSync(token, TOKEN_HASH_SALT, 32).toString("hex");
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
