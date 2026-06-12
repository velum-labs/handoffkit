import { randomUUID } from "node:crypto";

import { keyIdFromPublicPem } from "@warrant/protocol";

import { hashToken } from "./auth.js";
import { unauthorized } from "./domain-errors.js";
import type { PlaneStore, RunnerRecord } from "./store.js";

export class RunnerRegistry {
  constructor(
    private readonly store: PlaneStore,
    private readonly newToken: () => string
  ) {}

  authenticate(runnerToken: string): RunnerRecord {
    const runner = this.store.getRunnerByTokenHash(hashToken(runnerToken));
    if (!runner) throw unauthorized("invalid runner token");
    return runner;
  }

  enroll(input: {
    publicKeyPem: string;
    pool: string;
  }): { runnerId: string; runnerToken: string; record: RunnerRecord } {
    const runnerId = `rnr_${randomUUID()}`;
    const runnerToken = this.newToken();
    const record: RunnerRecord = {
      runnerId,
      pool: input.pool,
      publicKeyPem: input.publicKeyPem,
      tokenHash: hashToken(runnerToken),
      enrolledAt: new Date().toISOString()
    };
    this.store.saveRunner(record);
    return { runnerId, runnerToken, record };
  }

  list(): { runnerId: string; pool: string; keyId: string; enrolledAt: string }[] {
    return this.store.listRunners().map((runner) => ({
      runnerId: runner.runnerId,
      pool: runner.pool,
      keyId: keyIdFromPublicPem(runner.publicKeyPem),
      enrolledAt: runner.enrolledAt
    }));
  }
}
