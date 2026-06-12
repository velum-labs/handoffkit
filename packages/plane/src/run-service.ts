import { randomUUID } from "node:crypto";

import type { RunStatus } from "@warrant/protocol";

import type { PlaneStore, RunRecord, RunRequest } from "./store.js";

export type CreateRunInput = {
  request: Omit<RunRequest, "runId">;
  status: Extract<RunStatus, "created" | "awaiting_approval">;
  consentRequirements: string[];
};

export class RunService {
  constructor(private readonly store: PlaneStore) {}

  create(input: CreateRunInput): RunRecord {
    const runId = `run_${randomUUID()}`;
    const now = new Date().toISOString();
    return {
      id: runId,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      request: { ...input.request, runId },
      consentRequirements: input.consentRequirements,
      approvals: []
    };
  }

  save(record: RunRecord): void {
    this.store.saveRun(record);
  }
}
