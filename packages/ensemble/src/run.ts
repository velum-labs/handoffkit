import {
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1,
  hashCanonicalSha256,
  requestHash
} from "@warrant/protocol";
import type {
  HarnessCandidateRecordV1,
  HarnessRunRequestV1,
  HarnessRunResultV1,
  JsonValue,
  ModelFusionStatus
} from "@warrant/protocol";

import type {
  EnsembleDescriptor,
  EnsembleRunResult,
  HarnessArtifact,
  HarnessCandidateOutput,
  HarnessToolRecord
} from "./harness.js";

const SCHEMA_BUNDLE_HASH =
  "sha256:75792f89c091b6ab4fd317a15fb03fd73438563dceff5ccf9f5d7c752dbf35f3";
const PRODUCER_GIT_SHA = "0".repeat(40);
const PRODUCER = "handoffkit-ensemble";
const PRODUCER_VERSION = "0.1.0";

type ContractMetadataInput<S extends string> = {
  schema: S;
  createdAt: string;
};

function metadata<S extends string>(input: ContractMetadataInput<S>) {
  return {
    schema: input.schema,
    schema_version: "v1" as const,
    schema_bundle_hash: SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
    created_at: input.createdAt
  };
}

function terminalStatus(outputs: readonly HarnessCandidateOutput[]): ModelFusionStatus {
  if (outputs.some((output) => output.status === "failed")) return "failed";
  if (outputs.some((output) => output.status === "requires_action")) return "requires_action";
  if (outputs.every((output) => output.status === "skipped")) return "skipped";
  return "succeeded";
}

function assertDescriptor(descriptor: EnsembleDescriptor): void {
  if ("checks" in descriptor && descriptor.checks !== undefined) {
    throw new Error("ensemble descriptors do not accept ad hoc checks");
  }
  if (!descriptor.harness) throw new Error("ensemble descriptor requires one harness");
  if (!Array.isArray(descriptor.models) || descriptor.models.length === 0) {
    throw new Error("ensemble descriptor requires at least one model");
  }
  for (const model of descriptor.models) {
    if (!model.id || !model.model) {
      throw new Error("each ensemble model requires id and model");
    }
  }
  if (!descriptor.runtime?.id) throw new Error("ensemble descriptor requires one runtime");
  if (!descriptor.judge?.id) throw new Error("ensemble descriptor requires one judge");
  if (!descriptor.policy?.id) throw new Error("ensemble descriptor requires one policy");
}

function candidateId(descriptor: EnsembleDescriptor, modelId: string, ordinal: number): string {
  return `${descriptor.id}_${modelId}_${ordinal}`.replace(/[^A-Za-z0-9_.:-]/g, "_");
}

function freezeResult(result: EnsembleRunResult): EnsembleRunResult {
  for (const candidate of result.candidates) Object.freeze(candidate);
  for (const artifact of result.artifacts) Object.freeze(artifact);
  for (const toolRecord of result.toolRecords) Object.freeze(toolRecord);
  Object.freeze(result.candidates);
  Object.freeze(result.artifacts);
  Object.freeze(result.toolRecords);
  return Object.freeze(result);
}

function candidateMetadata(
  output: HarnessCandidateOutput,
  descriptor: EnsembleDescriptor
): Record<string, JsonValue> {
  const metadata: Record<string, JsonValue> = {
    model_id: output.model.id,
    model: output.model.model,
    endpoint_id: output.model.endpointId ?? output.model.id
  };
  if (output.transcript !== undefined) {
    metadata.transcript_hash = hashCanonicalSha256(output.transcript);
  }
  if (output.diff !== undefined) {
    metadata.diff_hash = hashCanonicalSha256(output.diff);
  }
  if (output.verification !== undefined) {
    metadata.verification = output.verification;
  }
  Object.assign(metadata, output.metadata ?? {});
  if (descriptor.reviewEvidence !== undefined) {
    metadata.review_evidence_attached = true;
  }
  return metadata;
}

export async function runEnsemble(descriptor: EnsembleDescriptor): Promise<EnsembleRunResult> {
  assertDescriptor(descriptor);
  const createdAt = new Date().toISOString();
  const capabilities = descriptor.harness.capabilities(descriptor);
  const request: HarnessRunRequestV1 = {
    ...metadata({ schema: "harness-run-request.v1", createdAt }),
    request_id: `ensemble_req_${descriptor.id}`,
    harness_kind: "generic",
    source_repo: descriptor.sourceRepo,
    base_git_sha: descriptor.baseGitSha,
    prompt: descriptor.prompt,
    prompt_hash: requestHash({
      prompt: descriptor.prompt,
      descriptor_id: descriptor.id
    }),
    allowed_tools: descriptor.policy.allowedTools,
    side_effects: descriptor.policy.sideEffects,
    requested_capabilities: capabilities,
    metadata: {
      harness_id: descriptor.harness.id,
      runtime_id: descriptor.runtime.id,
      judge_id: descriptor.judge.id,
      policy_id: descriptor.policy.id,
      ...(descriptor.metadata ?? {})
    }
  };
  assertHarnessRunRequestV1(request);

  const prepared = await descriptor.harness.prepare({ descriptor, request });
  const outputs = await Promise.all(
    descriptor.models.map((model, ordinal) =>
      descriptor.harness.run({ descriptor, request, model, ordinal, prepared })
    )
  );
  const collectedArtifacts = await descriptor.harness.collectArtifacts({
    descriptor,
    request,
    candidates: outputs,
    prepared
  });
  const verification = descriptor.harness.verificationProfile(descriptor);

  const candidates: HarnessCandidateRecordV1[] = outputs.map((output, ordinal) => {
    const id = output.candidateId ?? candidateId(descriptor, output.model.id, ordinal);
    const record: HarnessCandidateRecordV1 = {
      ...metadata({ schema: "harness-candidate-record.v1", createdAt }),
      candidate_id: id,
      request_id: request.request_id,
      harness_kind: "generic",
      model_call_id: `${id}_model_call`,
      status: output.status,
      side_effects: descriptor.policy.sideEffects,
      artifacts: output.artifacts,
      ...(output.score !== undefined ? { score: output.score } : {}),
      ...(output.error ? { error: output.error } : {}),
      metadata: candidateMetadata(output, descriptor)
    };
    assertHarnessCandidateRecordV1(record);
    return record;
  });

  const artifacts: HarnessArtifact[] = [
    ...collectedArtifacts,
    ...outputs.flatMap((output) => output.artifacts ?? [])
  ];
  const toolRecords: HarnessToolRecord[] = outputs.flatMap((output) => output.toolRecords ?? []);
  const result: HarnessRunResultV1 = {
    ...metadata({ schema: "harness-run-result.v1", createdAt }),
    result_id: `ensemble_result_${descriptor.id}`,
    request_id: request.request_id,
    harness_kind: "generic",
    status: terminalStatus(outputs),
    candidate_ids: candidates.map((candidate) => candidate.candidate_id),
    output_summary: `${outputs.length} candidate(s) produced by ${descriptor.harness.id}`,
    artifacts,
    capabilities,
    started_at: createdAt,
    finished_at: new Date().toISOString(),
    metadata: {
      descriptor_id: descriptor.id,
      ...(descriptor.reviewEvidence !== undefined
        ? { review_evidence: descriptor.reviewEvidence }
        : {})
    }
  };
  assertHarnessRunResultV1(result);

  return freezeResult({
    descriptorId: descriptor.id,
    harnessRunRequest: request,
    harnessRunResult: result,
    candidates,
    artifacts,
    toolRecords,
    verification,
    ...(descriptor.reviewEvidence ? { reviewEvidence: descriptor.reviewEvidence } : {})
  });
}

export const ensemble = {
  run: runEnsemble
} as const;
