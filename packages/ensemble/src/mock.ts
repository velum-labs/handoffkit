import { artifactHash } from "@warrant/protocol";

import type {
  HarnessAdapter,
  HarnessArtifact,
  HarnessCandidateOutput,
  HarnessToolRecord
} from "./harness.js";

export type MockCandidateFixture = {
  transcript?: string;
  diff?: string;
  modelCallId?: string;
  modelCallRecord?: HarnessCandidateOutput["modelCallRecord"];
  branchName?: string;
  worktreePath?: string;
  summary?: string;
  status?: HarnessCandidateOutput["status"];
  score?: number;
  artifacts?: HarnessArtifact[];
  toolRecords?: HarnessToolRecord[];
  verification?: HarnessCandidateOutput["verification"];
};

export type MockHarnessOptions = {
  id?: string;
  candidates?: Record<string, MockCandidateFixture>;
};

function artifactFor(kind: HarnessArtifact["kind"], id: string, content: string): HarnessArtifact {
  return {
    artifact_id: id,
    kind,
    hash: artifactHash(content),
    redaction_status: "synthetic"
  };
}

export function createMockHarness(options: MockHarnessOptions = {}): HarnessAdapter {
  const id = options.id ?? "mock";
  return {
    id,
    prepare: () => ({ preparedAt: new Date().toISOString() }),
    capabilities: () => ({
      workspace_read: "supported",
      apply_patch: "supported",
      tool_records: "supported",
      verification: "supported"
    }),
    verificationProfile: () => ({
      id: `${id}-verification`,
      requiredEvidence: ["transcript", "diff", "verification"]
    }),
    run: ({ descriptor, model, ordinal }) => {
      const fixture = options.candidates?.[model.id] ?? {};
      const transcript =
        fixture.transcript ?? `mock transcript for ${descriptor.id}/${model.id}`;
      const diff = fixture.diff ?? `diff --git a/${model.id}.txt b/${model.id}.txt`;
      const artifacts = fixture.artifacts ?? [
        artifactFor("transcript", `artifact_${descriptor.id}_${model.id}_transcript`, transcript),
        artifactFor("patch", `artifact_${descriptor.id}_${model.id}_diff`, diff)
      ];
      return {
        candidateId: `${descriptor.id}_${model.id}_${ordinal}`,
        model,
        status: fixture.status ?? "succeeded",
        ...(fixture.modelCallId ? { modelCallId: fixture.modelCallId } : {}),
        ...(fixture.modelCallRecord ? { modelCallRecord: fixture.modelCallRecord } : {}),
        ...(fixture.branchName ? { branchName: fixture.branchName } : {}),
        ...(fixture.worktreePath ? { worktreePath: fixture.worktreePath } : {}),
        transcript,
        diff,
        ...(fixture.summary ? { summary: fixture.summary } : {}),
        score: fixture.score ?? 1,
        artifacts,
        toolRecords: fixture.toolRecords ?? [],
        verification:
          fixture.verification ?? {
            status: "succeeded",
            evidence: ["mock verification passed"],
            exitCode: 0
          }
      };
    },
    collectArtifacts: () => []
  };
}
