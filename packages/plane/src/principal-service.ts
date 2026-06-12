import { randomUUID } from "node:crypto";

import { hashToken, principalCan, toPrincipal } from "./auth.js";
import type { Capability, Principal } from "./auth.js";
import { conflict, notFound } from "./domain-errors.js";
import type { PlaneStore, PrincipalRecord, PrincipalRole } from "./store.js";

export class PrincipalService {
  constructor(
    private readonly store: PlaneStore,
    private readonly newToken: () => string
  ) {}

  authenticate(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    const record = this.store.getPrincipalByTokenHash(hashToken(token));
    if (!record || record.revokedAt) return undefined;
    return toPrincipal(record);
  }

  authorize(token: string | undefined, capability: Capability): Principal | undefined {
    const principal = this.authenticate(token);
    if (!principal || !principalCan(principal.role, capability)) return undefined;
    return principal;
  }

  issue(name: string, role: PrincipalRole): {
    principalId: string;
    name: string;
    role: PrincipalRole;
    token: string;
  } {
    if (this.store.getPrincipalByName(name)) {
      throw conflict(`principal "${name}" already exists`);
    }
    const token = this.newToken();
    const record: PrincipalRecord = {
      principalId: `prn_${randomUUID()}`,
      name,
      role,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString()
    };
    this.store.savePrincipal(record);
    return { principalId: record.principalId, name, role, token };
  }

  rotate(name: string): { token: string } {
    const existing = this.store.getPrincipalByName(name);
    if (!existing || existing.revokedAt) {
      throw notFound(`principal "${name}" not found`);
    }
    const token = this.newToken();
    this.store.savePrincipal({ ...existing, tokenHash: hashToken(token) });
    return { token };
  }
}
