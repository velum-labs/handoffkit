import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  artifactHash,
  assertArtifactRefV1,
  assertBenchmarkTaskRecordV1,
  assertEnsembleReceiptV1,
  assertHarnessCandidateRecordV1,
  assertHarnessRunRequestV1,
  assertHarnessRunResultV1,
  assertJudgeSynthesisRecordV1,
  assertModelCallRecordV1,
  assertModelFusionRecord,
  assertToolCallPlanV1,
  assertToolExecutionRecordV1,
  hashCanonicalSha256,
  executeHarnessTask,
  MODEL_FUSION_SCHEMA_BUNDLE_HASH,
  MODEL_FUSION_OPENAPI_SOURCE_HASH,
  MODEL_FUSION_SCHEMA_NAMES,
  requestHash,
  responseHash,
  schemaBundleHash,
  sha256PrefixedHex
} from "../index.js";
import type { ModelFusionOpenApiHarnessExecutionRequest } from "../index.js";

const FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "fixtures",
  "model-fusion-contract"
);

const SCHEMAS = [
  "model-call-record.v1",
  "harness-run-request.v1",
  "harness-run-result.v1",
  "harness-candidate-record.v1",
  "judge-synthesis-record.v1",
  "benchmark-task-record.v1",
  "artifact-ref.v1",
  "tool-call-plan.v1",
  "tool-execution-record.v1",
  "ensemble-receipt.v1"
] as const;

type SchemaName = (typeof SCHEMAS)[number];
type Validator = (value: unknown) => void;

const VALIDATORS: Record<SchemaName, Validator> = {
  "model-call-record.v1": assertModelCallRecordV1,
  "harness-run-request.v1": assertHarnessRunRequestV1,
  "harness-run-result.v1": assertHarnessRunResultV1,
  "harness-candidate-record.v1": assertHarnessCandidateRecordV1,
  "judge-synthesis-record.v1": assertJudgeSynthesisRecordV1,
  "benchmark-task-record.v1": assertBenchmarkTaskRecordV1,
  "artifact-ref.v1": assertArtifactRefV1,
  "tool-call-plan.v1": assertToolCallPlanV1,
  "tool-execution-record.v1": assertToolExecutionRecordV1,
  "ensemble-receipt.v1": assertEnsembleReceiptV1
};

function readFixture(schema: SchemaName, variant: "minimal" | "realistic"): unknown {
  return JSON.parse(
    readFileSync(join(FIXTURE_ROOT, schema, `${variant}.json`), "utf8")
  );
}

test("model-fusion schema constants include the MF-02 record set", () => {
  assert.deepEqual([...MODEL_FUSION_SCHEMA_NAMES], [...SCHEMAS]);
});

test("model-fusion fixtures carry the exported schema bundle hash", () => {
  assert.match(MODEL_FUSION_SCHEMA_BUNDLE_HASH, /^sha256:[0-9a-f]{64}$/);
  for (const schema of SCHEMAS) {
    for (const variant of ["minimal", "realistic"] as const) {
      const fixture = readFixture(schema, variant) as { schema_bundle_hash?: string };
      assert.equal(fixture.schema_bundle_hash, MODEL_FUSION_SCHEMA_BUNDLE_HASH);
    }
  }
});

test("specific validators accept copied MF-00 minimal and realistic fixtures", () => {
  for (const schema of SCHEMAS) {
    const validate = VALIDATORS[schema];
    validate(readFixture(schema, "minimal"));
    validate(readFixture(schema, "realistic"));
  }
});

test("union validator accepts every copied model-fusion fixture", () => {
  for (const schema of SCHEMAS) {
    assertModelFusionRecord(readFixture(schema, "minimal"));
    assertModelFusionRecord(readFixture(schema, "realistic"));
  }
});

test("model-fusion validators reject wrong schema and missing required fields", () => {
  const call = readFixture("model-call-record.v1", "minimal");
  assertModelCallRecordV1(call);
  assert.throws(
    () => assertModelCallRecordV1({ ...call, schema: "artifact-ref.v1" }),
    /schema must be model-call-record.v1/
  );
  const { call_id: _callId, ...missingCallId } = call as Record<string, unknown>;
  assert.throws(() => assertModelCallRecordV1(missingCallId), /call_id/);
  assert.throws(() => assertModelFusionRecord({ schema: "unknown.v1" }), /unsupported/);
});

test("model-fusion validators reject bad enum and hash values", () => {
  const plan = readFixture("tool-call-plan.v1", "minimal") as Record<string, unknown>;
  assert.throws(
    () => assertToolCallPlanV1({ ...plan, status: "done" }),
    /status/
  );
  assert.throws(
    () => assertToolCallPlanV1({ ...plan, arguments_hash: "not-a-hash" }),
    /arguments_hash/
  );
});

test("model-fusion validators reject unsupported fields", () => {
  const call = readFixture("model-call-record.v1", "minimal") as Record<string, unknown>;
  assert.throws(
    () => assertModelCallRecordV1({ ...call, extra_field: true }),
    /unsupported field/
  );
  const messages = call.messages as Record<string, unknown>[];
  assert.throws(
    () =>
      assertModelCallRecordV1({
        ...call,
        messages: [{ ...messages[0], hidden: true }]
      }),
    /unsupported field/
  );

  const result = readFixture("harness-run-result.v1", "realistic") as Record<
    string,
    unknown
  >;
  const artifacts = result.artifacts as Record<string, unknown>[];
  assert.throws(
    () =>
      assertHarnessRunResultV1({
        ...result,
        artifacts: [{ ...artifacts[0], schema: "artifact-ref.v1" }]
      }),
    /unsupported field/
  );
});

test("model-call metadata accepts sanitized RouteKit request attribution", () => {
  const call = readFixture("model-call-record.v1", "minimal") as Record<
    string,
    unknown
  >;
  const attributed = {
    ...call,
    metadata: {
      attribution: {
        effective_model: "codex/gpt-5.3-codex",
        native_model: "gpt-5.3-codex",
        provider: "codex",
        billing_mode: "subscription",
        account: { label: "work" },
        attempts: 3,
        retries: 2,
        account_failovers: 1
      },
      unknown_usage: false,
      unknown_cost: false,
      cost_estimate_usd: 0
    }
  };
  assertModelCallRecordV1(attributed);
  assertModelFusionRecord(attributed);
});

test("harness candidate metadata accepts nested microVM hardening evidence", () => {
  const candidate = readFixture("harness-candidate-record.v1", "minimal") as Record<
    string,
    unknown
  >;
  const withHardeningMetadata = {
    ...candidate,
    metadata: {
      hardening: {
        requested_isolation: "microvm",
        actual_isolation: "vercel-sandbox",
        provider: "vercel-sandbox",
        runtime: {
          engine: "firecracker",
          node_version: "22.x"
        },
        sandbox: {
          sandbox_id: "sbx_microvm_fixture",
          snapshot_id: "snap_microvm_fixture",
          persistent: false
        },
        network: {
          default_deny: true,
          allowed_hosts: []
        },
        cleanup: {
          status: "succeeded",
          duration_ms: 17
        },
        secrets: {
          mounted: false
        }
      }
    }
  };

  assertHarnessCandidateRecordV1(withHardeningMetadata);
  assertModelFusionRecord(withHardeningMetadata);
  assert.throws(
    () =>
      assertHarnessCandidateRecordV1({
        ...candidate,
        microvm: withHardeningMetadata.metadata
      }),
    /unsupported field/
  );
});

test("harness candidate metadata accepts disclosure joins without top-level schema changes", () => {
  const candidate = readFixture("harness-candidate-record.v1", "minimal") as Record<
    string,
    unknown
  >;
  const withDisclosureMetadata = {
    ...candidate,
    metadata: {
      disclosures: [
        {
          candidate_id: "candidate_a",
          tool_call_id: "tool_call_readme",
          plan_id: "tool_plan_readme",
          execution_id: "tool_exec_readme",
          run_id: "run_secret_disclosure",
          content_hash: "sha256:" + "a".repeat(64),
          data_class: "session-log",
          direction: "out",
          policy_id: "policy_readonly",
          environment_id: "env_local",
          secret_names: ["API_TOKEN"],
          injected_env_names: ["API_TOKEN"],
          redaction_status: "redacted"
        }
      ]
    }
  };

  assertHarnessCandidateRecordV1(withDisclosureMetadata);
  assertModelFusionRecord(withDisclosureMetadata);
  assert.throws(
    () =>
      assertHarnessCandidateRecordV1({
        ...candidate,
        disclosures: withDisclosureMetadata.metadata
      }),
    /unsupported field/
  );
});

test("model-fusion hash helpers return sha256-prefixed hashes", () => {
  assert.match(sha256PrefixedHex("hello"), /^sha256:[0-9a-f]{64}$/);
  assert.match(artifactHash(Buffer.from("artifact")), /^sha256:[0-9a-f]{64}$/);
  assert.match(requestHash({ b: 2, a: 1 }), /^sha256:[0-9a-f]{64}$/);
  assert.equal(requestHash({ b: 2, a: 1 }), responseHash({ a: 1, b: 2 }));
  assert.equal(hashCanonicalSha256({ z: true }), requestHash({ z: true }));
  assert.match(
    schemaBundleHash({
      "b.schema.json": { b: true },
      "a.schema.json": { a: true }
    }),
    /^sha256:[0-9a-f]{64}$/
  );
});

test("model-fusion exports are available from the protocol package entrypoint", () => {
  assert.equal(typeof assertModelFusionRecord, "function");
  assert.equal(typeof assertHarnessRunRequestV1, "function");
  assert.equal(typeof requestHash, "function");
});

test("generated OpenAPI client and service models are exported", async () => {
  assert.match(MODEL_FUSION_OPENAPI_SOURCE_HASH, /^sha256:[0-9a-f]{64}$/);
  const request: ModelFusionOpenApiHarnessExecutionRequest = {
    request_id: "req_generated",
    task_id: "task_generated",
    source_repo: "handoffkit",
    base_git_sha: "0".repeat(40),
    harness_kind: "generic",
    prompt_hash: requestHash("generated"),
    allowed_tools: ["read_file"],
    side_effects: "read_only",
    harness_run_request: {
      schema: "harness-run-request.v1",
      schema_version: "v1",
      schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
      persisted_json: {}
    }
  };
  const result = await executeHarnessTask(
    {
      baseUrl: "https://executor.example",
      fetch: async (url, init) => {
        assert.equal(String(url), "https://executor.example/v1/harness-executions");
        assert.equal(init?.method, "POST");
        assert.match(String(init?.body), /req_generated/);
        return new Response(
          JSON.stringify({
            request_id: request.request_id,
            result_id: "result_generated",
            status: "succeeded",
            candidate_ids: [],
            harness_run_result: {
              schema: "harness-run-result.v1",
              schema_version: "v1",
              schema_bundle_hash: MODEL_FUSION_SCHEMA_BUNDLE_HASH,
              persisted_json: {}
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    },
    request
  );

  assert.equal(result.result_id, "result_generated");
});
