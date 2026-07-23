import {
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  assertModelCallRecordV1
} from "@fusionkit/protocol";
import type { ModelCallRecordV1 } from "@fusionkit/protocol";
import type { ModelCallContract } from "@velum-labs/routekit-contracts";
import {
  readProducerVersion,
  resolveProducerGitSha
} from "@velum-labs/routekit-gateway";

const PRODUCER = "fusionkit-gateway";
const PRODUCER_VERSION = readProducerVersion();
const PRODUCER_GIT_SHA = resolveProducerGitSha();

export function toFusionModelCallRecord(record: ModelCallContract): ModelCallRecordV1 {
  const wrapped: ModelCallRecordV1 = {
    schema: "model-call-record.v1",
    schema_version: "v1",
    schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
    producer: PRODUCER,
    producer_version: PRODUCER_VERSION,
    producer_git_sha: PRODUCER_GIT_SHA,
    created_at: record.started_at,
    ...record
  };
  assertModelCallRecordV1(wrapped);
  return wrapped;
}
