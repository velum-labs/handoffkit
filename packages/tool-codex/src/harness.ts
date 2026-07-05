import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { artifactHash } from "@fusionkit/protocol";
import type { JsonValue, ModelCallRecordV1 } from "@fusionkit/protocol";
import {
  createTrajectoryCapture,
  ModelRoutedBackend,
  OpenAiBackend,
  PANEL_DEPTH_HEADER,
  startGateway
} from "@fusionkit/model-gateway";
import type { Backend, CapturedTrajectory } from "@fusionkit/model-gateway";
import { KernelBackend, panelMemberPreamble, traceCandidate } from "@fusionkit/ensemble";
import type { FusedSubagentAccess } from "@fusionkit/ensemble";
import { PROVIDERS, SUBSCRIPTIONS } from "@fusionkit/registry";
import {
  buildChildEnv,
  buildSkippedCandidate,
  definedEnv,
  normalizeApiBaseUrl,
  readEnv,
  runCliCapture
} from "@fusionkit/tools";

import type {
  EnsembleDescriptor,
  EnsembleModel,
  HarnessAdapter,
  HarnessCandidateOutput,
  HarnessEndReason
} from "@fusionkit/ensemble";

import { readCodexCatalogTemplate } from "./launch.js";
import type { CodexModelPreset } from "./launch.js";

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_PROVIDER_ID = "fusionkit-codex";
const DEFAULT_PROVIDER_NAME = "FusionKit Codex";
/** Codex credential env names, from the provider secret registry. */
const DEFAULT_CREDENTIAL_ENV_NAMES: readonly string[] =
  PROVIDERS.codex?.credentialEnvNames ?? [];
const INLINE_PROVIDER_API_KEY_ENV = "FUSIONKIT_CODEX_PROVIDER_API_KEY";
/** The Codex CLI auth store file name, from the subscription registry. */
const CODEX_AUTH_FILE = SUBSCRIPTIONS.codex.authFileName ?? "auth.json";

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
  /** Written to the child's stdin (the prompt; `codex exec -` reads it there). */
  stdin?: string;
  /**
   * Aborts the codex child process (panel cancellation / straggler policy).
   * The abort reason's message is surfaced as the result's `abortReason`.
   */
  signal?: AbortSignal;
};

export type CodexExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  /** True when the run was stopped via the input's abort signal. */
  aborted?: boolean;
  /** The abort reason's message (e.g. `straggler_abandoned`). */
  abortReason?: string;
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
  /**
   * Enable Codex's native sub-agent tools for this panel member so it can
   * parallelize its own work. Spawned children inherit the member's model and
   * provider (its own router endpoint) by default; with `fusedSubagents` set
   * the fused ensemble models are also spawnable. Default on; the repo-wide
   * `subagents: false` / `--no-subagents` switch turns it off.
   */
  subagents?: boolean;
  /**
   * Fused sub-agent access: the member's model catalog additionally lists the
   * fused ensemble models, and the member's capture gateway routes requests
   * for them to the front-door fusion gateway (stamped with the panel depth),
   * so `spawn_agent(model: "fusion-<name>")` works from inside the panel.
   */
  fusedSubagents?: FusedSubagentAccess;
};

export type CodexHarnessEnv = Record<string, string | undefined>;

export type CodexConfigTomlInput = {
  model: string;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  /**
   * Path to a `ModelsResponse` catalog naming the member's model. Codex only
   * registers its multi-agent tools for models it can resolve in a catalog, so
   * custom-provider members need this one-entry file for sub-agents to work
   * (its absence was the "unsupported call: multi_agent_v1" failure mode).
   */
  modelCatalogPath?: string;
  /** Pin the multi-agent tools on and emit conservative `[agents]` limits. */
  subagents?: boolean;
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

/** The subscription registry's ordered env override chains for the Codex harness. */
const CODEX_OVERRIDE_ENV = SUBSCRIPTIONS.codex.overrideEnv ?? {};

function firstEnvValue(env: Record<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(env, name) ?? env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function providerFromEnv(env: Record<string, string>): CodexProvider {
  // The provider override env chains (canonical + legacy aliases) come from the
  // subscription registry, shared with onboarding docs and the Python side.
  const responsesBaseUrl = firstEnvValue(env, CODEX_OVERRIDE_ENV.responsesBaseUrl ?? []);
  if (responsesBaseUrl !== undefined) {
    const apiKeyEnvName = firstPresentEnv(env, CODEX_OVERRIDE_ENV.responsesApiKey ?? []);
    return {
      kind: "responses",
      baseUrl: responsesBaseUrl,
      ...(apiKeyEnvName ? { apiKeyEnvName } : {}),
      requiresOpenAiAuth: !isLoopbackUrl(responsesBaseUrl)
    };
  }

  const openAiBaseUrl = firstEnvValue(env, CODEX_OVERRIDE_ENV.openaiCompatibleBaseUrl ?? []);
  if (openAiBaseUrl !== undefined) {
    const apiKeyEnvName = firstPresentEnv(env, CODEX_OVERRIDE_ENV.openaiCompatibleApiKey ?? []);
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
    `sandbox_mode = ${tomlString(input.sandboxMode)}`
  ];
  if (input.modelCatalogPath !== undefined) {
    lines.push(`model_catalog_json = ${tomlString(input.modelCatalogPath)}`);
  }
  lines.push("");

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

  if (input.subagents === true) {
    lines.push("[features]", "multi_agent = true", "");
    // Same-model parallelization only, with a tight budget: a panel member is
    // already one of several candidates, so deep/wide fan-out multiplies cost.
    lines.push("[agents]", "max_depth = 1", "max_threads = 3", "");
  }

  return lines.join("\n");
}

/**
 * `-` makes `codex exec` read the prompt from stdin instead of argv, so large
 * prompts cannot hit the OS argv limit and the prompt is not visible in `ps`.
 */
function codexArgs(): string[] {
  return ["exec", "--json", "--skip-git-repo-check", "-"];
}

/**
 * The panel member's `ModelsResponse` catalog: its own model plus (with fused
 * sub-agent access) every fused ensemble model, each cloned from the installed
 * Codex's own catalog entry so the schema matches that version. Codex only
 * registers its multi-agent tools for models it can resolve in a catalog, and
 * `spawn_agent` validates its `model` argument against it — so the fused
 * entries are exactly what make "spawn a sub-agent on fusion-<name>" work from
 * inside the panel ("Unknown model 'fusion-*' for spawn_agent" otherwise).
 */
export function codexMemberCatalogJson(
  model: string,
  template: CodexModelPreset,
  fusedModelIds: readonly string[] = []
): string {
  const ids = [model, ...fusedModelIds.filter((id) => id !== model)];
  const models = ids.map((id, index) => ({
    ...template,
    slug: id,
    display_name: id,
    description:
      id === model
        ? "FusionKit panel member model (routed via the fusion router)."
        : "Fused ensemble model (sub-agent turns route to the fusion front door).",
    visibility: "list",
    priority: index,
    availability_nux: null,
    upgrade: null
  }));
  return JSON.stringify({ models }, null, 2);
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
  subagents?: boolean;
  fusedSubagents?: FusedSubagentAccess;
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
  // Sub-agents (default on): pin the multi-agent tools and give the member's
  // model a catalog entry so Codex registers them; with fused sub-agent access
  // the fused ensemble models get entries too, so `spawn_agent` accepts them
  // (the member's capture gateway routes those turns to the front door).
  // Without the installed Codex's catalog template (schema varies per release)
  // the member runs without sub-agents rather than risking a config-load failure.
  const template = input.subagents !== false ? readCodexCatalogTemplate() : undefined;
  let modelCatalogPath: string | undefined;
  if (input.subagents !== false && template !== undefined) {
    modelCatalogPath = join(codexHome, "model-catalog.json");
    writeFileSync(
      modelCatalogPath,
      codexMemberCatalogJson(
        input.model.model,
        template,
        input.fusedSubagents?.ensembles.map((ensemble) => ensemble.modelId) ?? []
      )
    );
  }
  writeFileSync(
    join(codexHome, "config.toml"),
    codexConfigToml({
      model: input.model.model,
      sandboxMode: sandboxModeFor(input.descriptor, input.sandboxMode),
      approvalPolicy: input.approvalPolicy,
      ...(modelCatalogPath !== undefined ? { modelCatalogPath, subagents: true } : {}),
      ...(providerConfig ? { provider: providerConfig } : {})
    })
  );
  if (
    input.provider.kind === "ambient" &&
    firstPresentEnv(input.env, input.provider.credentialEnvNames ?? DEFAULT_CREDENTIAL_ENV_NAMES) === undefined
  ) {
    const authFile = codexAuthFile(input.env);
    if (authFile !== undefined) {
      // Symlink (never copy) the CLI auth store into the ephemeral home:
      // removing the temp dir removes only the link, so live credentials are
      // never left behind in /tmp, and token refreshes land in the real store.
      symlinkSync(authFile, join(codexHome, CODEX_AUTH_FILE));
    }
  }
  return codexHome;
}

/**
 * Why the candidate's `codex exec --json` run ended, derived from its own
 * event stream: a `turn.completed` event means the model genuinely finished
 * its turn; a clean exit *without* one means the CLI was stopped mid-turn
 * (interrupt/abort) even though the exit code is 0. Persisted into the session
 * record so early stops are attributable from the trace UI.
 */
export function codexEndReason(result: CodexExecResult): HarnessEndReason {
  let sawTurnCompleted = false;
  let failureDetail: string | undefined;
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = event as { type?: unknown; message?: unknown; error?: { message?: unknown } };
    if (typeof record.type !== "string") continue;
    // `turn.completed` is the current codex exec event; `task_complete` covers
    // older CLIs whose exec stream mirrored the rollout event names.
    if (record.type === "turn.completed" || record.type === "task_complete") sawTurnCompleted = true;
    if (record.type === "turn.failed" || record.type === "error") {
      const message = record.error?.message ?? record.message;
      if (typeof message === "string" && message.length > 0) failureDetail = message;
    }
  }
  if (result.timedOut === true) {
    return { kind: "timeout", exitCode: result.exitCode, timedOut: true };
  }
  if (result.aborted === true) {
    return {
      kind: "aborted",
      exitCode: result.exitCode,
      detail: result.abortReason ?? "aborted"
    };
  }
  if (result.exitCode !== 0) {
    return {
      kind: "exit_error",
      exitCode: result.exitCode,
      ...(failureDetail !== undefined ? { detail: failureDetail } : {})
    };
  }
  if (sawTurnCompleted) return { kind: "completed", exitCode: result.exitCode };
  return {
    kind: "aborted",
    exitCode: result.exitCode,
    detail: failureDetail ?? "process exited without reporting a completed turn"
  };
}

export async function defaultCodexRunner(input: CodexExecInput): Promise<CodexExecResult> {
  const result = await runCliCapture(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.stdin !== undefined ? { stdin: input.stdin } : {})
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.aborted ? { aborted: true, ...(result.abortReason !== undefined ? { abortReason: result.abortReason } : {}) } : {})
  };
}

/**
 * The member capture gateway's chat core: the member's own router endpoint,
 * plus — with fused sub-agent access — a routed branch that sends the fused
 * ensemble models' requests to the front-door fusion gateway, stamped with the
 * panel depth so the front door never re-provisions fused access downstream.
 */
export function memberChatBackend(primary: Backend, fused: FusedSubagentAccess | undefined): Backend {
  if (fused === undefined || fused.ensembles.length === 0) return primary;
  const routed = new OpenAiBackend({
    baseUrl: normalizeApiBaseUrl(fused.gatewayUrl),
    ...(fused.authToken !== undefined ? { apiKey: fused.authToken } : {}),
    headers: { [PANEL_DEPTH_HEADER]: String(fused.depth) }
  });
  return new ModelRoutedBackend({
    routedModelIds: fused.ensembles.map((ensemble) => ensemble.modelId),
    routed,
    primary
  });
}

async function runProvider(input: {
  provider: CodexProvider;
  env: Record<string, string>;
  model: EnsembleModel;
  fusedSubagents?: FusedSubagentAccess;
  onCapturedTrajectory?: (trajectory: CapturedTrajectory) => void;
}): Promise<CodexRunProvider> {
  switch (input.provider.kind) {
    case "ambient":
      return {
        provider: input.provider,
        modelCallRecords: [],
        close: async () => undefined
      };
    case "responses": {
      const records: ModelCallRecordV1[] = [];
      const capture = createTrajectoryCapture();
      const apiKey =
        input.provider.apiKey ??
        (input.provider.apiKeyEnvName !== undefined
          ? input.env[input.provider.apiKeyEnvName]
          : input.env.OPENAI_API_KEY);
      const gateway = await startGateway({
        backend: new KernelBackend(
          memberChatBackend(
            new OpenAiBackend({
              baseUrl: normalizeApiBaseUrl(stripResponsesRoute(input.provider.baseUrl)),
              ...(apiKey !== undefined ? { apiKey } : {}),
              defaultModel: input.model.model
            }),
            input.fusedSubagents
          ),
          {
            workflowIds: { chat: "native-passthrough-turn", models: "native-passthrough-models", embeddings: "native-passthrough-embeddings" }
          }
        ),
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
    case "openai-compatible": {
      const records: ModelCallRecordV1[] = [];
      const capture = createTrajectoryCapture();
      const apiKey =
        input.provider.apiKey ??
        (input.provider.apiKeyEnvName !== undefined
          ? input.env[input.provider.apiKeyEnvName]
          : input.env.OPENAI_API_KEY);
      const gateway = await startGateway({
        backend: new KernelBackend(
          memberChatBackend(
            new OpenAiBackend({
              baseUrl: normalizeApiBaseUrl(input.provider.baseUrl),
              ...(apiKey !== undefined ? { apiKey } : {}),
              defaultModel: input.provider.defaultModel ?? input.model.model
            }),
            input.fusedSubagents
          ),
          {
            workflowIds: { chat: "native-passthrough-turn", models: "native-passthrough-models", embeddings: "native-passthrough-embeddings" }
          }
        ),
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
  return {
    ...skippedCandidate({
      descriptor: input.descriptor,
      model: input.model,
      ordinal: input.ordinal,
      reason,
      provider: input.provider
    }),
    endReason: { kind: "spawn_error", detail: reason }
  };
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
      // Codex shell execution is available, but dashboard metadata still treats
      // it as constrained because policy and sandbox settings can narrow access.
      shell_command: "degraded",
      artifact_capture: "supported",
      model_gateway_responses: "supported",
      openai_compatible_gateway: "supported"
    }),
    verificationProfile: () => ({
      id: `${id}-evidence`,
      requiredEvidence: ["codex transcript", "exit code", "optional model-call record"]
    }),
    run: async ({ descriptor, model, ordinal, prepared, worktree, signal }) => {
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
        ...(options.subagents !== false && options.fusedSubagents !== undefined
          ? { fusedSubagents: options.fusedSubagents }
          : {}),
        onCapturedTrajectory: (trajectory) => {
          for (const step of trajectory.steps) tracer.step(step);
        }
      });
      try {
        // The child gets an allowlisted environment, never the parent's full
        // env: baseline system vars plus exactly the credential names this
        // provider mode can legitimately consume.
        const providerApiKeyEnvNames =
          provider.provider.kind === "ambient"
            ? provider.provider.credentialEnvNames ?? []
            : provider.provider.apiKeyEnvName !== undefined
              ? [provider.provider.apiKeyEnvName]
              : [];
        const env = buildChildEnv({
          base: state.env,
          allow: [
            ...DEFAULT_CREDENTIAL_ENV_NAMES,
            ...Object.values(CODEX_OVERRIDE_ENV).flat(),
            ...providerApiKeyEnvNames,
            INLINE_PROVIDER_API_KEY_ENV,
            "CODEX_HOME"
          ]
        });
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
          approvalPolicy,
          ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
          ...(options.subagents !== false && options.fusedSubagents !== undefined
            ? { fusedSubagents: options.fusedSubagents }
            : {})
        });
        env.CODEX_HOME = codexHome;
        const prompt =
          options.panelIdentity === true
            ? `${panelMemberPreamble(model.id, ordinal, descriptor.models.length)}\n\n${descriptor.prompt}`
            : descriptor.prompt;
        const args = codexArgs();
        const cwd = worktree?.path ?? options.cwd ?? descriptor.workspace ?? process.cwd();
        const timeoutMs = options.timeoutMs ?? descriptor.policy.timeoutMs;
        let result: CodexExecResult;
        try {
          result = await runner({
            command,
            args,
            cwd,
            env,
            timeoutMs,
            stdin: prompt,
            ...(signal !== undefined ? { signal } : {})
          });
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
        const endReason = codexEndReason(result);
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
                  reconstructed.finalOutput.length > 0 ? reconstructed.finalOutput : transcript,
                endReason
              }
            : undefined;
        tracer.finished({
          status,
          steps: reconstructed?.steps ?? [],
          ...(trajectory !== undefined ? { finalOutput: trajectory.finalOutput } : {}),
          // The end-reason kind ("completed" | "aborted" | "timeout" | ...)
          // surfaces live in the trace UI, matching the persisted end_reason.
          // A straggler drop keeps its distinct reason so the narrator can say
          // "dropped after the grace window" instead of a generic failure.
          finishReason:
            endReason.kind === "aborted" && endReason.detail === "straggler_abandoned"
              ? "straggler_abandoned"
              : endReason.kind
        });
        return {
          candidateId,
          model,
          status,
          endReason,
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
