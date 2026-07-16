import { artifactHash } from "@routekit/contracts";

import type {
  HarnessAdapter,
  HarnessArtifact,
  HarnessCandidateOutput,
  HarnessCapabilities,
  HarnessToolRecord
} from "./harness.js";

/**
 * Dashboard capability profile for the mock harness, owned here next to the
 * implementation so the dashboard never re-declares (or contradicts) it. The
 * mock harness replays synthetic fixtures:
 * - `route_model_observation` is degraded because the fixture *labels* a model
 *   id but no request ever reaches a live route, so the observation is
 *   asserted, not captured from real traffic.
 */
export const MOCK_DASHBOARD_CAPABILITIES: HarnessCapabilities = {
  model_override: "supported",
  transcript_capture: "supported",
  diff_capture: "supported",
  tool_loop_capture: "supported",
  patch_apply_visibility: "supported",
  route_model_observation: "degraded",
  verification_hint: "supported",
  replay_support: "supported"
};

/** Dashboard identity for the generic fixture harness (id/name/notes). */
export const MOCK_DASHBOARD_IDENTITY = {
  id: "mock",
  harnessKind: "generic",
  displayName: "Mock",
  notes: ["Pure synthetic fixture harness for CI."]
} as const;

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
      tool_records: "supported"
    }),
    verificationProfile: () => ({
      id: `${id}-evidence`,
      requiredEvidence: ["transcript", "diff"]
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
        toolRecords: fixture.toolRecords ?? []
      };
    },
    collectArtifacts: () => []
  };
}
