import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { artifactHash } from "@fusionkit/protocol";
import type { JsonValue, ModelCallRecordV1 } from "@fusionkit/protocol";
import { createTrajectoryCapture, OpenAiBackend, startGateway } from "@fusionkit/model-gateway";
import type { CapturedTrajectory } from "@fusionkit/model-gateway";
import { KernelBackend, panelMemberPreamble, traceCandidate } from "@fusionkit/ensemble";
import {
  buildSkippedCandidate,
  definedEnv,
  normalizeApiBaseUrl,
  readEnv
} from "@fusionkit/tools";

import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessAdapter,
  HarnessCandidateOutput
} from "@fusionkit/ensemble";

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_PROVIDER_ID = "fusionkit-codex";
const DEFAULT_PROVIDER_NAME = "FusionKit Codex";
const DEFAULT_CREDENTIAL_ENV_NAMES = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;
const INLINE_PROVIDER_API_KEY_ENV = "FUSIONKIT_CODEX_PROVIDER_API_KEY";
const CODEX_AUTH_FILE = "auth.json";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export type CodexAmbientProvider = {
  kind: "ambient";
  credentialEnvNames?: readonly string[];
};

export type CodexResponsesProvider = {
  kind: "responses";
  baseUrl: string;
  apiKey?: string;
  apiKeyEnvName?: string;
  requiresOpenAiAuth?: boolean;
  providerId?: string;
  name?: string;
};

export type CodexOpenAiCompatibleProvider = {
  kind: "openai-compatible";
  baseUrl: string;
  apiKey?: string;
  apiKeyEnvName?: string;
  defaultModel?: string;
  providerId?: string;
  name?: string;
};

export type CodexProvider =
  | CodexAmbientProvider
  | CodexResponsesProvider
  | CodexOpenAiCompatibleProvider;

export type CodexExecInput = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
};

export type CodexExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
};

export type CodexExecRunner = (
  input: CodexExecInput
) => Promise<CodexExecResult> | CodexExecResult;

export type CodexHarnessOptions = {
  id?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  provider?: CodexProvider;
  runner?: CodexExecRunner;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  keepCodexHome?: boolean;
  /**
   * Per-model router endpoints keyed by `EnsembleModel.id`. When a candidate's
   * model id is present, Codex is pointed at that endpoint and requests the
   * endpoint id as its model (so the router routes to that panel member).
   */
  modelEndpoints?: Record<string, string>;
  /** Observability correlation for per-candidate trace events. */
  traceId?: string;
  parentSpanId?: string;
  turn?: number;
  /**
   * When true, a per-member identity line (which panel member this model is) is
   * prepended to the prompt. Gated because it makes members' prompts differ from
   * each other; see `panelMemberPreamble`.
   */
  panelIdentity?: boolean;
};

export type CodexHarnessEnv = Record<string, string | undefined>;

export type CodexConfigTomlInput = {
  model: string;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  provider?: {
    providerId?: string;
    name?: string;
    baseUrl: string;
    apiKeyEnvName?: string;
    requiresOpenAiAuth: boolean;
  };
};

type PreparedCodexHarness = {
  tempRoot: string;
  env: Record<string, string>;
  provider: CodexProvider;
};

type CodexRunProvider = {
  provider: CodexProvider;
  configBaseUrl?: string;
  modelCallRecords: ModelCallRecordV1[];
  /** Reconstruct the native trajectory from the captured gateway wire traffic. */
  reconstruct?: () => CapturedTrajectory;
  close(): Promise<void>;
};

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function stripResponsesRoute(baseUrl: string): string {
  return baseUrl.replace(/\/responses\/?$/, "");
}

function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function firstPresentEnv(
  env: Record<string, string>,
  names: readonly string[]
): string | undefined {
  return names.find((name) => env[name] !== undefined && env[name].length > 0);
}

function codexHome(env: Record<string, string>): string {
  return env.CODEX_HOME && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME
    : join(homedir(), ".codex");
}

function codexAuthFile(env: Record<string, string>): string | undefined {
  const path = join(codexHome(env), CODEX_AUTH_FILE);
  return existsSync(path) ? path : undefined;
}

function providerFromEnv(env: Record<string, string>): CodexProvider {
  const responsesBaseUrl =
    readEnv(env, "FUSIONKIT_CODEX_RESPONSES_BASE_URL") ?? env.CODEX_RESPONSES_BASE_URL;
  if (responsesBaseUrl !== undefined && responsesBaseUrl.length > 0) {
    const apiKeyEnvName = firstPresentEnv(env, [
      "FUSIONKIT_CODEX_API_KEY",
      "WARRANT_CODEX_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_API_KEY"
    ]);
    return {
      kind: "responses",
      baseUrl: responsesBaseUrl,
      ...(apiKeyEnvName ? { apiKeyEnvName } : {}),
      requiresOpenAiAuth: !isLoopbackUrl(responsesBaseUrl)
    };
  }

  const openAiBaseUrl = readEnv(env, "FUSIONKIT_CODEX_OPENAI_BASE_URL") ?? env.OPENAI_BASE_URL;
  if (openAiBaseUrl !== undefined && openAiBaseUrl.length > 0) {
    const apiKeyEnvName = firstPresentEnv(env, [
      "FUSIONKIT_CODEX_OPENAI_API_KEY",
      "WARRANT_CODEX_OPENAI_API_KEY",
      "OPENAI_API_KEY"
    ]);
    return {
      kind: "openai-compatible",
      baseUrl: openAiBaseUrl,
      ...(apiKeyEnvName ? { apiKeyEnvName } : {})
    };
  }

  return { kind: "ambient" };
}

function credentialEnvName(
  provider: CodexResponsesProvider,
  env: Record<string, string>
): string | undefined {
  if (provider.apiKey !== undefined) return INLINE_PROVIDER_API_KEY_ENV;
  if (provider.apiKeyEnvName !== undefined) return provider.apiKeyEnvName;
  return firstPresentEnv(env, DEFAULT_CREDENTIAL_ENV_NAMES);
}

function missingCredentialReason(
  provider: CodexProvider,
  env: Record<string, string>
): string | undefined {
  switch (provider.kind) {
    case "ambient": {
      const names = provider.credentialEnvNames ?? DEFAULT_CREDENTIAL_ENV_NAMES;
      return firstPresentEnv(env, names) === undefined && codexAuthFile(env) === undefined
        ? `Codex credentials are absent; set ${names.join(" or ")} or configure a Responses/OpenAI-compatible provider.`
        : undefined;
    }
    case "responses": {
      if (provider.requiresOpenAiAuth === false || provider.apiKey !== undefined) return undefined;
      const envName = credentialEnvName(provider, env);
      return envName === undefined || env[envName] === undefined || env[envName].length === 0
        ? `Codex Responses provider credentials are absent; set ${provider.apiKeyEnvName ?? DEFAULT_CREDENTIAL_ENV_NAMES.join(" or ")} or mark the provider requiresOpenAiAuth=false for local endpoints.`
        : undefined;
    }
    case "openai-compatible":
      return undefined;
    default: {
      const exhausted: never = provider;
      throw new Error(`unsupported Codex provider: ${String(exhausted)}`);
    }
  }
}

export function codexHarnessCredentialSkipReason(
  env: CodexHarnessEnv = process.env,
  options: Pick<CodexHarnessOptions, "provider"> = {}
): string | undefined {
  const defined = definedEnv(env);
  return missingCredentialReason(options.provider ?? providerFromEnv(defined), defined);
}

function sandboxModeFor(
  descriptor: EnsembleDescriptor,
  override: CodexSandboxMode | undefined
): CodexSandboxMode {
  if (override !== undefined) return override;
  switch (descriptor.policy.sideEffects) {
    case "none":
    case "read_only":
      return "read-only";
    case "writes_workspace":
    case "network":
    case "tool_execution":
    case "unknown":
      return "workspace-write";
    default: {
      const exhausted: never = descriptor.policy.sideEffects;
      throw new Error(`unsupported side effects policy: ${String(exhausted)}`);
    }
  }
}

export function codexConfigToml(input: CodexConfigTomlInput): string {
  const lines = [
    `model = ${tomlString(input.model)}`,
    input.provider
      ? `model_provider = ${tomlString(input.provider.providerId ?? DEFAULT_PROVIDER_ID)}`
      : `model_provider = "openai"`,
    `approval_policy = ${tomlString(input.approvalPolicy)}`,
    `sandbox_mode = ${tomlString(input.sandboxMode)}`,
    ""
  ];

  if (input.provider !== undefined) {
    const providerId = input.provider.providerId ?? DEFAULT_PROVIDER_ID;
    lines.push(
      `[model_providers.${providerId}]`,
      `name = ${tomlString(input.provider.name ?? DEFAULT_PROVIDER_NAME)}`,
      `base_url = ${tomlString(normalizeApiBaseUrl(stripResponsesRoute(input.provider.baseUrl)))}`,
      `wire_api = "responses"`,
      `requires_openai_auth = ${input.provider.requiresOpenAiAuth ? "true" : "false"}`
    );
    if (input.provider.apiKeyEnvName !== undefined) {
      lines.push(`env_key = ${tomlString(input.provider.apiKeyEnvName)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function codexArgs(prompt: string): string[] {
  return ["exec", "--json", "--skip-git-repo-check", prompt];
}

function writeCodexHome(input: {
  tempRoot: string;
  model: EnsembleModel;
  providerBaseUrl?: string;
  provider: CodexProvider;
  env: Record<string, string>;
  descriptor: EnsembleDescriptor;
  sandboxMode?: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
}): string {
  const codexHome = mkdtempSync(join(input.tempRoot, "candidate-"));
  const providerConfig =
    input.provider.kind === "ambient"
      ? undefined
      : {
          providerId: input.provider.providerId,
          name: input.provider.name,
          baseUrl: input.providerBaseUrl ?? input.provider.baseUrl,
          apiKeyEnvName:
            input.provider.kind === "responses"
              ? credentialEnvName(input.provider, input.env)
              : undefined,
          requiresOpenAiAuth:
            input.provider.kind === "responses"
              ? input.provider.requiresOpenAiAuth ?? true
              : false
        };
  writeFileSync(
    join(codexHome, "config.toml"),
    codexConfigToml({
      model: input.model.model,
      sandboxMode: sandboxModeFor(input.descriptor, input.sandboxMode),
      approvalPolicy: input.approvalPolicy,
      ...(providerConfig ? { provider: providerConfig } : {})
    })
  );
  if (
    input.provider.kind === "ambient" &&
    firstPresentEnv(input.env, input.provider.credentialEnvNames ?? DEFAULT_CREDENTIAL_ENV_NAMES) === undefined
  ) {
    const authFile = codexAuthFile(input.env);
    if (authFile !== undefined) {
      copyFileSync(authFile, join(codexHome, CODEX_AUTH_FILE));
    }
  }
  return codexHome;
}

export async function defaultCodexRunner(input: CodexExecInput): Promise<CodexExecResult> {
  return await new Promise<CodexExecResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (input.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, input.timeoutMs);
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: timedOut ? 124 : code ?? 0,
        ...(timedOut ? { timedOut } : {})
      });
    });
  });
}

async function runProvider(input: {
  provider: CodexProvider;
  env: Record<string, string>;
  model: EnsembleModel;
  onCapturedTrajectory?: (trajectory: CapturedTrajectory) => void;
}): Promise<CodexRunProvider> {
  switch (input.provider.kind) {
    case "ambient":
    case "responses":
      return {
        provider: input.provider,
        modelCallRecords: [],
        close: async () => undefined
      };
    case "openai-compatible": {
      const records: ModelCallRecordV1[] = [];
      const capture = createTrajectoryCapture();
      const apiKey =
        input.provider.apiKey ??
        (input.provider.apiKeyEnvName !== undefined
          ? input.env[input.provider.apiKeyEnvName]
          : input.env.OPENAI_API_KEY);
      const gateway = await startGateway({
        backend: new KernelBackend(new OpenAiBackend({
          baseUrl: normalizeApiBaseUrl(input.provider.baseUrl),
          ...(apiKey !== undefined ? { apiKey } : {}),
          defaultModel: input.provider.defaultModel ?? input.model.model
        }), {
          workflowIds: { chat: "native-passthrough-turn", models: "native-passthrough-models", embeddings: "native-passthrough-embeddings" }
        }),
        provenance: {
          onModelCall(record) {
            records.push(record);
          },
          onModelCallRaw(context, result) {
            capture.sink.onModelCallRaw?.(context, result);
            input.onCapturedTrajectory?.(capture.reconstruct());
          }
        }
      });
      return {
        provider: input.provider,
        configBaseUrl: gateway.url(),
        modelCallRecords: records,
        reconstruct: capture.reconstruct,
        close: () => gateway.close()
      };
    }
    default: {
      const exhausted: never = input.provider;
      throw new Error(`unsupported Codex provider: ${String(exhausted)}`);
    }
  }
}

function metadataFor(input: {
  command: string;
  args: string[];
  provider: CodexProvider;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  modelCallRecords: readonly ModelCallRecordV1[];
}): Record<string, JsonValue> {
  return {
    adapter: "codex",
    command: input.command,
    args: input.args,
    provider_kind: input.provider.kind,
    stdout_bytes: Buffer.byteLength(input.stdout),
    stderr_bytes: Buffer.byteLength(input.stderr),
    timed_out: input.timedOut === true,
    model_call_count: input.modelCallRecords.length
  };
}

function skippedCandidate(input: {
  descriptor: EnsembleDescriptor;
  model: EnsembleModel;
  ordinal: number;
  reason: string;
  provider: CodexProvider;
}): HarnessCandidateOutput {
  return buildSkippedCandidate({
    descriptor: input.descriptor,
    model: input.model,
    ordinal: input.ordinal,
    reason: input.reason,
    adapter: "codex",
    transcript: `Codex adapter skipped: ${input.reason}`,
    metadata: { provider_kind: input.provider.kind }
  });
}

function failedToSpawnCandidate(input: {
  descriptor: EnsembleDescriptor;
  model: EnsembleModel;
  ordinal: number;
  error: unknown;
  provider: CodexProvider;
}): HarnessCandidateOutput {
  const errno = input.error as NodeJS.ErrnoException;
  const reason =
    errno.code === "ENOENT"
      ? "Codex CLI binary was not found on PATH."
      : input.error instanceof Error
        ? input.error.message
        : String(input.error);
  return skippedCandidate({
    descriptor: input.descriptor,
    model: input.model,
    ordinal: input.ordinal,
    reason,
    provider: input.provider
  });
}

export function createCodexHarness(options: CodexHarnessOptions = {}): HarnessAdapter {
  const id = options.id ?? "codex";
  const command = options.command ?? DEFAULT_CODEX_COMMAND;
  const runner = options.runner ?? defaultCodexRunner;
  const approvalPolicy = options.approvalPolicy ?? "never";
  return {
    id,
    harnessKind: "codex",
    prepare: () => {
      const env = definedEnv(options.env ?? process.env);
      return {
        tempRoot: mkdtempSync(join(tmpdir(), "warrant-codex-")),
        env,
        provider: options.provider ?? providerFromEnv(env)
      } satisfies PreparedCodexHarness;
    },
    capabilities: () => ({
      workspace_read: "supported",
      apply_patch: "supported",
      // TODO(@000alen): why degraded?
      shell_command: "degraded",
      artifact_capture: "supported",
      model_gateway_responses: "supported",
      openai_compatible_gateway: "supported"
    }),
    verificationProfile: () => ({
      id: `${id}-evidence`,
      requiredEvidence: ["codex transcript", "exit code", "optional model-call record"]
    }),
    run: async ({ descriptor, model, ordinal, prepared, worktree }) => {
      const state = prepared as PreparedCodexHarness;
      const missing = missingCredentialReason(state.provider, state.env);
      if (missing !== undefined) {
        return skippedCandidate({ descriptor, model, ordinal, reason: missing, provider: state.provider });
      }

      const candidateId = `${descriptor.id}_${model.id}_${ordinal}`;
      // Emit per-candidate trace events so the companion app shows this
      // candidate's trajectory live (started now, finished when the run completes).
      const tracer = traceCandidate(
        {
          ...(options.traceId !== undefined ? { traceId: options.traceId } : {}),
          ...(options.parentSpanId !== undefined ? { parentSpanId: options.parentSpanId } : {}),
          ...(options.turn !== undefined ? { turn: options.turn } : {})
        },
        {
          candidateId,
          modelId: model.id,
          model: model.model,
          ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {})
        }
      );

      // When a per-model router endpoint is configured, point Codex at it and
      // request the endpoint id (model.id) as its model so the router routes to
      // this panel member. Otherwise behave exactly as before.
      const endpointUrl = options.modelEndpoints?.[model.id];
      const effectiveModel: EnsembleModel =
        endpointUrl !== undefined ? { ...model, model: model.id } : model;
      const effectiveProvider: CodexProvider =
        endpointUrl !== undefined && state.provider.kind === "openai-compatible"
          ? { ...state.provider, baseUrl: endpointUrl }
          : state.provider;

      const provider = await runProvider({
        provider: effectiveProvider,
        env: state.env,
        model: effectiveModel,
        onCapturedTrajectory: (trajectory) => {
          for (const step of trajectory.steps) tracer.step(step);
        }
      });
      try {
        const env = { ...state.env };
        if (provider.provider.kind === "responses" && provider.provider.apiKey !== undefined) {
          env[INLINE_PROVIDER_API_KEY_ENV] = provider.provider.apiKey;
        }
        const codexHome = writeCodexHome({
          tempRoot: state.tempRoot,
          model: effectiveModel,
          providerBaseUrl: provider.configBaseUrl,
          provider: provider.provider,
          env,
          descriptor,
          sandboxMode: options.sandboxMode,
          approvalPolicy
        });
        env.CODEX_HOME = codexHome;
        const prompt =
          options.panelIdentity === true
            ? `${panelMemberPreamble(model.id, ordinal, descriptor.models.length)}\n\n${descriptor.prompt}`
            : descriptor.prompt;
        const args = codexArgs(prompt);
        const cwd = worktree?.path ?? options.cwd ?? descriptor.workspace ?? process.cwd();
        const timeoutMs = options.timeoutMs ?? descriptor.policy.timeoutMs;
        let result: CodexExecResult;
        try {
          result = await runner({ command, args, cwd, env, timeoutMs });
        } catch (error) {
          tracer.finished({ status: "failed", steps: [], finishReason: "spawn_error" });
          return failedToSpawnCandidate({
            descriptor,
            model,
            ordinal,
            error,
            provider: provider.provider
          });
        }

        const transcript = [result.stdout, result.stderr].filter(Boolean).join("\n");
        const status: HarnessCandidateOutput["status"] =
          result.exitCode === 0 && result.timedOut !== true ? "succeeded" : "failed";
        const outputHash = artifactHash(transcript);
        const modelCallRecord = provider.modelCallRecords.at(-1);
        const reconstructed = provider.reconstruct?.();
        const trajectory =
          reconstructed !== undefined && reconstructed.steps.length > 0
            ? {
                trajectoryId: candidateId,
                modelId: model.id,
                model: model.model,
                candidateId,
                harnessKind: "codex" as const,
                status,
                steps: reconstructed.steps,
                finalOutput:
                  reconstructed.finalOutput.length > 0 ? reconstructed.finalOutput : transcript
              }
            : undefined;
        tracer.finished({
          status,
          steps: reconstructed?.steps ?? [],
          ...(trajectory !== undefined ? { finalOutput: trajectory.finalOutput } : {}),
          ...(result.timedOut === true ? { finishReason: "timeout" } : {})
        });
        return {
          candidateId,
          model,
          status,
          ...(modelCallRecord ? { modelCallId: modelCallRecord.call_id, modelCallRecord } : {}),
          ...(worktree ? { branchName: worktree.branchName, worktreePath: worktree.path } : {}),
          ...(trajectory !== undefined ? { trajectory } : {}),
          transcript,
          log: transcript,
          artifacts: [
            {
              artifact_id: `artifact_${descriptor.id}_${model.id}_codex_output`,
              kind: "log",
              hash: outputHash,
              redaction_status: "synthetic"
            }
          ],
          toolRecords: [
            {
              execution_id: `exec_${descriptor.id}_${model.id}_${ordinal}_codex`,
              plan_id: `plan_${descriptor.id}_${model.id}_${ordinal}_codex`,
              status,
              output_hash: outputHash,
              ...(status === "failed"
                ? {
                    error: {
                      kind: result.timedOut === true ? "timeout" : "provider_error",
                      message: result.timedOut === true ? "Codex CLI timed out." : result.stderr.slice(0, 500),
                      retryable: result.timedOut === true
                    }
                  }
                : {})
            }
          ],
          ...(status === "failed"
            ? {
                error: {
                  kind: result.timedOut === true ? "timeout" : "provider_error",
                  message: result.timedOut === true ? "Codex CLI timed out." : result.stderr.slice(0, 500),
                  retryable: result.timedOut === true
                }
              }
            : {}),
          metadata: metadataFor({
            command,
            args,
            provider: provider.provider,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
            modelCallRecords: provider.modelCallRecords
          })
        };
      } finally {
        await provider.close();
      }
    },
    collectArtifacts: () => [],
    cleanup: ({ prepared }) => {
      if (options.keepCodexHome === true) return;
      const state = prepared as PreparedCodexHarness | undefined;
      if (state !== undefined) rmSync(state.tempRoot, { recursive: true, force: true });
    }
  };
}

export const codexHarness = createCodexHarness;
