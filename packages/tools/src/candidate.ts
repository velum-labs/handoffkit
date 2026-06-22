import { artifactHash } from "@fusionkit/protocol";
import type { JsonValue } from "@fusionkit/protocol";
import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessCandidateOutput
} from "@fusionkit/ensemble";

/**
 * Build the standard "skipped" candidate output shared by the per-tool harness
 * adapters (a capability gate failed, the binary was missing, the runner threw,
 * ...). Each adapter supplies its lowercase `adapter` id, the human transcript,
 * and any adapter-specific metadata.
 */
export function buildSkippedCandidate(input: {
  descriptor: EnsembleDescriptor;
  model: EnsembleModel;
  ordinal: number;
  reason: string;
  adapter: string;
  transcript: string;
  metadata?: Record<string, JsonValue>;
}): HarnessCandidateOutput {
  const { descriptor, model, ordinal, reason, adapter, transcript } = input;
  const hash = artifactHash(transcript);
  return {
    candidateId: `${descriptor.id}_${model.id}_${ordinal}`,
    model,
    status: "skipped",
    transcript,
    log: transcript,
    artifacts: [
      {
        artifact_id: `artifact_${descriptor.id}_${model.id}_${adapter}_skip`,
        kind: "log",
        hash,
        redaction_status: "synthetic"
      }
    ],
    error: {
      kind: "capability_missing",
      message: reason,
      retryable: false
    },
    metadata: {
      adapter,
      ...input.metadata,
      skip_reason: reason
    }
  };
}
