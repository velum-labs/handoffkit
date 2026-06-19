import { artifactHash } from "@fusionkit/protocol";
import type { JsonValue, NetworkPolicy, RunContract, RunEvent } from "@fusionkit/protocol";
import { CapabilityMismatchError, prepareExecution } from "@fusionkit/runner";
import type { SessionBackend } from "@fusionkit/runner";
import { aiSdkHarnessBackend } from "@fusionkit/session-harness";
import type { ClaudeCodeBindingOptions } from "@fusionkit/session-harness";

import type {
  CandidateHardeningMetadata,
  EnsembleDescriptor,
  HarnessAdapter,
  HarnessCandidateOutput,
  HarnessRunInput
} from "./harness.js";

const ZERO_HASH = "0".repeat(64);
const ZERO_GIT_SHA = "0".repeat(40);
const DEFAULT_POOL = "ensemble";
const DEFAULT_RUNTIME = "node24";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LOG_MAX_BYTES = 256 * 1024;
const DEFAULT_CLAUDE_NETWORK: NetworkPolicy = {
  defaultDeny: true,
  allowHosts: ["registry.npmjs.org", "api.anthropic.com", "ai-gateway.vercel.sh"]
};

const AUTH_ENV_NAMES = [
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL"
] as const;

type AuthEnvName = (typeof AUTH_ENV_NAMES)[number];
export type ClaudeCodeHarnessEnv = Record<string, string | undefined>;

export type ClaudeCodeHarnessOptions = ClaudeCodeBindingOptions & {
  id?: string;
  /** Defaults to `process.env`; tests can pass `{}` for deterministic skips. */
  env?: ClaudeCodeHarnessEnv;
  /** Already-released secret values forwarded through the session backend seam. */
  secrets?: { name: string; value: string }[];
  /** Test/extension seam. Defaults to `aiSdkHarnessBackend(...)`. */
  backend?: SessionBackend;
  pool?: string;
  network?: NetworkPolicy;
  timeoutMs?: number;
  logMaxBytes?: number;
  skipWhenUnavailable?: boolean;
};

type CredentialGate =
  | { available: true; authEnv: Record<AuthEnvName, string> }
  | { available: false; reason: string; missing: string[] };

type PreparedClaudeCodeHarness = {
  gate: CredentialGate;
  backend?: SessionBackend;
};

function candidateId(input: HarnessRunInput): string {
  return `${input.descriptor.id}_${input.model.id}_${input.ordinal}`;
}

function envValue(env: ClaudeCodeHarnessEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.length > 0 ? value : undefined;
}

function authEnvFrom(env: ClaudeCodeHarnessEnv): Record<AuthEnvName, string> {
  const authEnv = {} as Record<AuthEnvName, string>;
  for (const name of AUTH_ENV_NAMES) {
    const value = envValue(env, name);
    if (value !== undefined) authEnv[name] = value;
  }
  return authEnv;
}

function credentialGate(
  env: ClaudeCodeHarnessEnv,
  options: ClaudeCodeHarnessOptions
): CredentialGate {
  const missing: string[] = [];
  const hasProviderCredential =
    envValue(env, "AI_GATEWAY_API_KEY") ??
    envValue(env, "ANTHROPIC_API_KEY") ??
    envValue(env, "ANTHROPIC_AUTH_TOKEN");
  const hasSandboxCredential =
    options.backend !== undefined ||
    options.createSandboxProvider !== undefined ||
    options.token !== undefined ||
    envValue(env, "VERCEL_TOKEN") !== undefined;

  if (!hasSandboxCredential) missing.push("VERCEL_TOKEN");
  if (!hasProviderCredential) {
    missing.push("ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|AI_GATEWAY_API_KEY");
  }

  if (missing.length > 0) {
    return {
      available: false,
      missing,
      reason:
        "Claude Code harness skipped: missing Claude Code credential/env; set VERCEL_TOKEN and one of " +
        "ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or AI_GATEWAY_API_KEY."
    };
  }

  return { available: true, authEnv: authEnvFrom(env) };
}

export function claudeCodeHarnessCredentialSkipReason(
  env: ClaudeCodeHarnessEnv = process.env,
  options: ClaudeCodeHarnessOptions = {}
): string | undefined {
  const gate = credentialGate(env, options);
  return gate.available ? undefined : gate.reason;
}

function backendFor(options: ClaudeCodeHarnessOptions, env: ClaudeCodeHarnessEnv): SessionBackend {
  return (
    options.backend ??
    aiSdkHarnessBackend({
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
      ...(options.bridgePort !== undefined ? { bridgePort: options.bridgePort } : {}),
      token: options.token ?? envValue(env, "VERCEL_TOKEN"),
      teamId: options.teamId ?? envValue(env, "VERCEL_TEAM_ID"),
      projectId: options.projectId ?? envValue(env, "VERCEL_PROJECT_ID"),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: options.startupTimeoutMs }
        : {}),
      ...(options.createHarness !== undefined ? { createHarness: options.createHarness } : {}),
      ...(options.createSandboxProvider !== undefined
        ? { createSandboxProvider: options.createSandboxProvider }
        : {})
    })
  );
}

function contractFor(input: {
  descriptor: EnsembleDescriptor;
  candidateId: string;
  options: ClaudeCodeHarnessOptions;
  gate: Extract<CredentialGate, { available: true }>;
  repoBaseSha?: string;
}): RunContract {
  const timeoutMs =
    input.options.timeoutMs ?? input.descriptor.policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    version: "warrant.contract.v1",
    runId: `ensemble_${input.candidateId}`,
    issuedAt: new Date().toISOString(),
    issuer: { keyId: "ensemble-claude-code", role: "plane" },
    requestedBy: { kind: "service", id: "handoffkit-ensemble" },
    agent: { kind: "claude-code" },
    task: { prompt: input.descriptor.prompt },
    runner: {
      pool:
        input.options.pool ??
        input.descriptor.runtime.environmentId ??
        input.descriptor.runtime.id ??
        DEFAULT_POOL
    },
    workspace: {
      version: "warrant.manifest.v1",
      baseRef: (input.repoBaseSha ?? input.descriptor.baseGitSha) || ZERO_GIT_SHA,
      bundleHash: ZERO_HASH,
      untrackedFiles: [],
      deniedPatterns: [],
      deniedPaths: []
    },
    policyHash: ZERO_HASH,
    secrets: input.options.secrets?.map((secret) => ({ name: secret.name, scope: "ensemble" })) ?? [],
    network:
      input.options.network ??
      (input.descriptor.runtime.isolation?.networkPolicy
        ? {
            defaultDeny: input.descriptor.runtime.isolation.networkPolicy.defaultDeny,
            allowHosts: [...input.descriptor.runtime.isolation.networkPolicy.allowHosts]
          }
        : DEFAULT_CLAUDE_NETWORK),
    budget: {
      ...(input.descriptor.policy.budgetUsd !== undefined
        ? { maxSpendUsd: input.descriptor.policy.budgetUsd }
        : {}),
      maxDurationMin: Math.ceil(timeoutMs / 60_000)
    },
    disclosure: "minimal-context",
    isolation: "vercel-sandbox",
    execution: {
      kind: "agent",
      agent: { kind: "claude-code" },
      prompt: input.descriptor.prompt,
      timeoutMs,
      env: { vars: input.gate.authEnv, egressProxy: false },
      log: {
        stdout: "capture",
        stderr: "merge",
        maxBytes: input.options.logMaxBytes ?? DEFAULT_LOG_MAX_BYTES
      }
    },
    expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    signatures: []
  };
}

function hardeningFor(input: {
  descriptor: EnsembleDescriptor;
  options: ClaudeCodeHarnessOptions;
  repoDir: string;
  authEnvNames: readonly string[];
  finished: boolean;
}): CandidateHardeningMetadata {
  const networkPolicy =
    input.options.network ??
    input.descriptor.runtime.isolation?.networkPolicy ??
    DEFAULT_CLAUDE_NETWORK;
  const mountPolicy = input.descriptor.runtime.isolation?.mountPolicy;
  const secretPolicy = input.descriptor.runtime.isolation?.secretPolicy;
  return {
    requested_isolation: "microvm",
    actual_isolation: input.finished ? "vercel-sandbox" : "process",
    runtime: {
      provider: "vercel-sandbox",
      runtime:
        input.options.runtime ??
        (input.descriptor.runtime.isolation?.kind === "microvm"
          ? input.descriptor.runtime.isolation.runtime
          : undefined) ??
        DEFAULT_RUNTIME,
      workdir: mountPolicy?.workdir ?? input.repoDir
    },
    mount_policy: {
      worktree_writable: mountPolicy?.worktreeWritable ?? true,
      read_only_caches: [...(mountPolicy?.readOnlyCachePaths ?? [])],
      ignored_dirs: [...(mountPolicy?.ignoredDirs ?? [".git", "node_modules", ".warrant"])]
    },
    network_policy: {
      default_deny: networkPolicy.defaultDeny,
      allow_hosts: [...networkPolicy.allowHosts],
      enforced: input.finished
    },
    cleanup: input.finished
      ? { attempted: true, succeeded: true, status: "succeeded" }
      : { attempted: false, succeeded: true, status: "not_required" },
    secret_absence: {
      secret_names: [
        ...(secretPolicy?.secretNames ?? input.options.secrets?.map((secret) => secret.name) ?? [])
      ],
      secret_value_hashes: [...(secretPolicy?.secretValueHashes ?? [])],
      injected_env_names: [...(secretPolicy?.injectedEnvNames ?? input.authEnvNames)],
      scanned: false,
      leaks_found: false,
      scan_scope: [],
      leak_count: 0
    }
  };
}

function skippedOutput(input: {
  runInput: HarnessRunInput;
  reason: string;
  missing: readonly string[];
  options: ClaudeCodeHarnessOptions;
}): HarnessCandidateOutput {
  const evidenceHash = artifactHash(input.reason);
  const repoDir = input.runInput.worktree?.path ?? input.runInput.descriptor.sourceRepo;
  return {
    candidateId: candidateId(input.runInput),
    model: input.runInput.model,
    status: "skipped",
    ...(input.runInput.worktree
      ? {
          branchName: input.runInput.worktree.branchName,
          worktreePath: input.runInput.worktree.path
        }
      : {}),
    transcript: input.reason,
    summary: input.reason,
    error: {
      kind: "capability_missing",
      message: input.reason,
      retryable: false
    },
    verification: {
      status: "skipped",
      evidence: [input.reason, evidenceHash],
      exitCode: 0
    },
    metadata: {
      adapter: "claude-code",
      credential_gate: "skipped",
      missing_credentials: [...input.missing],
      hardening: hardeningFor({
        descriptor: input.runInput.descriptor,
        options: input.options,
        repoDir,
        authEnvNames: [],
        finished: false
      }) as unknown as JsonValue
    }
  };
}

function failureOutput(input: {
  runInput: HarnessRunInput;
  error: unknown;
  options: ClaudeCodeHarnessOptions;
  authEnvNames: readonly string[];
}): HarnessCandidateOutput {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const errorHash = artifactHash(message);
  const repoDir = input.runInput.worktree?.path ?? input.runInput.descriptor.sourceRepo;
  return {
    candidateId: candidateId(input.runInput),
    model: input.runInput.model,
    status: "failed",
    ...(input.runInput.worktree
      ? {
          branchName: input.runInput.worktree.branchName,
          worktreePath: input.runInput.worktree.path
        }
      : {}),
    transcript: `Claude Code harness failed: ${message}`,
    error: {
      kind: "provider_error",
      message,
      retryable: true
    },
    verification: {
      status: "failed",
      evidence: [errorHash],
      exitCode: 1
    },
    metadata: {
      adapter: "claude-code",
      credential_gate: "available",
      event_count: 0,
      auth_env_names: [...input.authEnvNames],
      hardening: hardeningFor({
        descriptor: input.runInput.descriptor,
        options: input.options,
        repoDir,
        authEnvNames: input.authEnvNames,
        finished: false
      }) as unknown as JsonValue
    }
  };
}

export function createClaudeCodeHarness(options: ClaudeCodeHarnessOptions = {}): HarnessAdapter {
  const id = options.id ?? "claude-code";
  const env = options.env ?? process.env;
  const skipWhenUnavailable = options.skipWhenUnavailable ?? true;
  return {
    id,
    harnessKind: "claude_code",
    prepare: (): PreparedClaudeCodeHarness => {
      const gate = credentialGate(env, options);
      if (!gate.available) {
        if (skipWhenUnavailable) return { gate };
        throw new CapabilityMismatchError(gate.reason);
      }
      return { gate, backend: backendFor(options, env) };
    },
    capabilities: () => {
      const gate = credentialGate(env, options);
      return {
        workspace_read: gate.available ? "supported" : "degraded",
        workspace_write: gate.available ? "supported" : "degraded",
        apply_patch: gate.available ? "supported" : "degraded",
        tool_records: "supported",
        verification: gate.available ? "supported" : "degraded",
        microvm_isolation: gate.available ? "supported" : "degraded",
        credential_gate: gate.available ? "supported" : "degraded"
      };
    },
    verificationProfile: () => ({
      id: `${id}-verification`,
      requiredEvidence: ["structured transcript", "exit code", "worktree diff or skip reason"]
    }),
    run: async (runInput): Promise<HarnessCandidateOutput> => {
      const state = runInput.prepared as PreparedClaudeCodeHarness;
      if (!state.gate.available) {
        return skippedOutput({
          runInput,
          reason: state.gate.reason,
          missing: state.gate.missing,
          options
        });
      }

      const id = candidateId(runInput);
      const repoDir =
        runInput.worktree?.path ?? runInput.descriptor.workspace ?? runInput.descriptor.sourceRepo;
      const backend = state.backend ?? backendFor(options, env);
      const contract = contractFor({
        descriptor: runInput.descriptor,
        candidateId: id,
        options,
        gate: state.gate,
        ...(runInput.worktree ? { repoBaseSha: runInput.worktree.baseGitSha } : {})
      });
      const events: RunEvent[] = [];
      const authEnvNames = Object.keys(state.gate.authEnv);

      try {
        const result = await backend.execute({
          contract,
          repoDir,
          secrets: options.secrets ?? [],
          execution: prepareExecution({ contract, mockScriptPath: "/tmp/mock-agent.js" }),
          emit: (event: RunEvent) => {
            events.push(event);
          }
        });
        const transcript = result.log.toString("utf8");
        const outputHash = artifactHash(transcript);
        const status: HarnessCandidateOutput["status"] =
          result.exitCode === 0 ? "succeeded" : "failed";
        return {
          candidateId: id,
          model: runInput.model,
          status,
          ...(runInput.worktree
            ? {
                branchName: runInput.worktree.branchName,
                worktreePath: runInput.worktree.path
              }
            : {}),
          transcript,
          toolRecords: [
            {
              execution_id: `exec_${id}`,
              plan_id: `plan_${id}`,
              status,
              output_hash: outputHash
            }
          ],
          verification: {
            status,
            evidence: [`exit_code=${result.exitCode}`, outputHash],
            exitCode: result.exitCode
          },
          ...(status === "failed"
            ? {
                error: {
                  kind: "provider_error" as const,
                  message: "Claude Code harness exited non-zero",
                  retryable: true
                }
              }
            : {}),
          metadata: {
            adapter: "claude-code",
            backend_isolation: backend.isolation,
            credential_gate: "available",
            event_count: events.length,
            auth_env_names: authEnvNames,
            hardening: hardeningFor({
              descriptor: runInput.descriptor,
              options,
              repoDir,
              authEnvNames,
              finished: true
            }) as unknown as JsonValue
          }
        };
      } catch (error) {
        if (skipWhenUnavailable && error instanceof CapabilityMismatchError) {
          return skippedOutput({
            runInput,
            reason: error.message,
            missing: ["capability_mismatch"],
            options
          });
        }
        return failureOutput({ runInput, error, options, authEnvNames });
      }
    },
    collectArtifacts: () => []
  };
}

export function claudeCodeHarness(options: ClaudeCodeHarnessOptions = {}): HarnessAdapter {
  return createClaudeCodeHarness(options);
}
