import { randomUUID } from "node:crypto";

import { PROTOCOL_VERSIONS } from "@warrant/protocol";
import type { Checkpoint, SemanticState } from "@warrant/protocol";
import type { CapturedWorkspace } from "@warrant/workspace";

export class HandoffCheckpointManager {
  private readonly history: Checkpoint[] = [];

  get count(): number {
    return this.history.length;
  }

  snapshot(): Checkpoint[] {
    return [...this.history];
  }

  create(input: {
    captured: CapturedWorkspace;
    message?: string;
    transcriptHash?: string;
    toolJournalHash?: string;
    remember?: boolean;
  }): Checkpoint {
    const semantic: SemanticState = {
      ...(input.transcriptHash ? { transcriptHash: input.transcriptHash } : {}),
      ...(input.toolJournalHash ? { toolJournalHash: input.toolJournalHash } : {}),
      ...(input.message ? { note: input.message } : {})
    };
    const hasSemantic =
      input.transcriptHash !== undefined || input.toolJournalHash !== undefined;
    const parent = this.history.at(-1)?.checkpointId;
    const checkpoint: Checkpoint = {
      version: PROTOCOL_VERSIONS.checkpoint,
      checkpointId: `chk_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      tier: "workspace",
      ...(input.message ? { message: input.message } : {}),
      ...(hasSemantic ? { semantic } : {}),
      workspace: input.captured.manifest,
      ...(parent ? { parent } : {})
    };
    if (input.remember !== false) this.history.push(checkpoint);
    return checkpoint;
  }
}
