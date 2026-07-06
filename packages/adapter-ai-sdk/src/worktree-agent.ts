import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";

import { ATTR } from "@fusionkit/protocol";
import { buildChildEnv } from "@fusionkit/runtime-utils";
import { headersOf, jsonAttr, startFusionSpan } from "@fusionkit/tracing";
import type { FusionSpan, FusionTraceCarrier } from "@fusionkit/tracing";

/**
 * A uniform, real model-driven agent loop for trajectory-level fusion. One
 * panel model drives an AI SDK tool loop over a real git worktree (read/list/
 * grep/write/run), and the full reasoning/tool-call/observation/output sequence
 * is captured as a normalized trajectory (`harness-trajectory.v1` shaped). No
 * virtual filesystem and no mocks: the worktree is the isolation boundary and
 * the tools touch it directly.
 */

export type TrajectoryStepType = "reasoning" | "tool_call" | "observation" | "output";

export type TrajectoryStep = {
  index: number;
  type: TrajectoryStepType;
  text?: string;
  tool_name?: string;
  tool_call_id?: string;
  tool_input?: string;
  is_error?: boolean;
};

export type WorktreeAgentResult = {
  status: "succeeded" | "failed";
  steps: TrajectoryStep[];
  finalOutput: string;
  finishReason: string;
  toolCallCount: number;
};

export type WorktreeAgentInput = {
  /** Absolute path to the candidate's git worktree; all tools are scoped here. */
  worktree: string;
  /** The user's task/prompt for this turn. */
  prompt: string;
  /** OpenAI-compatible base URL for this candidate's model (without `/v1`). */
  baseUrl: string;
  /** Model name to request from the endpoint. */
  model: string;
  apiKey?: string;
  /**
   * Finite step-boundary budget (receding-horizon lookahead). A step boundary
   * is one generation that emitted tool calls; a generation's parallel batch
   * counts once and executes atomically. Batches 1..k-1 execute in the
   * worktree; the k-th generation's batch is captured **unexecuted** as the
   * candidate's terminal proposal. Unset = unbounded rollout (aggregate at
   * the final answer, bounded only by the internal safety cap).
   */
  k?: number;
  /** Per-`run` command timeout in ms. Defaults to 120000. */
  commandTimeoutMs?: number;
  /**
   * Extra environment variable names/patterns forwarded to `run` tool
   * commands, on top of the system baseline (PATH/HOME/locale/TLS/proxy).
   * The panel model chooses what to execute, so the parent environment —
   * provider API keys included — is never inherited wholesale; anything
   * beyond the baseline must be named here explicitly.
   */
  envAllow?: readonly (string | RegExp)[];
  abortSignal?: AbortSignal;
  /** Candidate span carrier; when set, the agent's model call is traced under it. */
  trace?: FusionTraceCarrier;
  /** Candidate id this agent run belongs to (for trace correlation). */
  candidateId?: string;
  /** Panel member id (short handle) this run belongs to. */
  modelId?: string;
  /** Called with each captured trajectory step, live (the candidate tracer). */
  onStep?: (step: TrajectoryStep) => void;
  /** User-turn index this run belongs to (stamped on model-call spans). */
  turn?: number;
};

type AgentContentPart = { type: string; [key: string]: unknown };

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Normalize one AI SDK step's content parts into trajectory steps. */
function extractSteps(content: readonly AgentContentPart[]): Array<Omit<TrajectoryStep, "index">> {
  const out: Array<Omit<TrajectoryStep, "index">> = [];
  for (const part of content) {
    const text = asString(part.text);
    if ((part.type === "reasoning" || part.type === "text") && text !== undefined && text.length > 0) {
      out.push({ type: "reasoning", text: truncate(text) });
    } else if (part.type === "tool-call") {
      out.push({
        type: "tool_call",
        ...(asString(part.toolName) !== undefined ? { tool_name: asString(part.toolName) } : {}),
        ...(asString(part.toolCallId) !== undefined ? { tool_call_id: asString(part.toolCallId) } : {}),
        tool_input: truncate(stringifyOutput(part.input), 600)
      });
    } else if (part.type === "tool-result") {
      out.push({
        type: "observation",
        ...(asString(part.toolCallId) !== undefined ? { tool_call_id: asString(part.toolCallId) } : {}),
        text: truncate(stringifyOutput(part.output), MAX_TOOL_OUTPUT)
      });
    }
  }
  return out;
}

const AGENT_SYSTEM_PROMPT =
  "You are a coding agent working in a real repository checkout. Use the tools to inspect " +
  "the repository and, when the task requires it, modify files and run commands or tests. " +
  "Answer questions directly from what you read. For code changes, make the edit with " +
  "write_file and verify with run (e.g. the test command). When you are done, stop and give " +
  "a concise final message describing the answer or the change you made.";

const MAX_FILE_BYTES = 24_000;
const MAX_TOOL_OUTPUT = 4_000;

function truncate(text: string, limit = 2_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...[truncated]`;
}

/** Resolve a tool-supplied path inside the worktree, refusing escapes. */
function safeResolve(root: string, candidate: string): string {
  const resolved = resolve(root, candidate);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || resolve(root, rel) !== resolved) {
    throw new Error(`path escapes the worktree: ${candidate}`);
  }
  return resolved;
}

function listDir(root: string, dir: string): string {
  const target = safeResolve(root, dir || ".");
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
  return entries.join("\n") || "(empty)";
}

function grepRepo(root: string, pattern: string): string {
  const result = spawnSync("git", ["grep", "-n", "-I", "-e", pattern], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return truncate(output || "(no matches)", MAX_TOOL_OUTPUT);
}

/** Exported for tests: the `run` tool's command execution (env-allowlisted). */
export function runWorktreeCommand(
  root: string,
  command: string,
  timeoutMs: number,
  envAllow: readonly (string | RegExp)[]
): string {
  // The model picks the command, so the child env is allowlist-built rather
  // than inherited: a `run("env")` must not surface the parent's API keys
  // into the trajectory (which is persisted and traced).
  const env = buildChildEnv({ allow: envAllow });
  const result = spawnSync(command, { cwd: root, encoding: "utf8", timeout: timeoutMs, shell: true, env });
  const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return truncate(`exit_code=${result.status ?? "null"}\n${body}`, MAX_TOOL_OUTPUT);
}

function worktreeTools(root: string, commandTimeoutMs: number, envAllow: readonly (string | RegExp)[]) {
  return {
    read_file: tool({
      description: "Read a UTF-8 text file from the repository.",
      inputSchema: jsonSchema<{ path: string }>({
        type: "object",
        properties: { path: { type: "string", description: "Path relative to the repo root." } },
        required: ["path"],
        additionalProperties: false
      }),
      execute: async ({ path }): Promise<string> => {
        const target = safeResolve(root, path);
        if (!existsSync(target)) return `(no such file: ${path})`;
        if (statSync(target).size > MAX_FILE_BYTES) return `(file too large: ${path})`;
        return readFileSync(target, "utf8");
      }
    }),
    list_dir: tool({
      description: "List the entries of a directory in the repository.",
      inputSchema: jsonSchema<{ path?: string }>({
        type: "object",
        properties: { path: { type: "string", description: "Directory relative to the repo root." } },
        additionalProperties: false
      }),
      execute: async ({ path }): Promise<string> => listDir(root, path ?? ".")
    }),
    grep: tool({
      description: "Search the repository for a pattern (git grep).",
      inputSchema: jsonSchema<{ pattern: string }>({
        type: "object",
        properties: { pattern: { type: "string", description: "Regex/text to search for." } },
        required: ["pattern"],
        additionalProperties: false
      }),
      execute: async ({ pattern }): Promise<string> => grepRepo(root, pattern)
    }),
    write_file: tool({
      description: "Create or overwrite a file in the repository with the given contents.",
      inputSchema: jsonSchema<{ path: string; contents: string }>({
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the repo root." },
          contents: { type: "string", description: "Full file contents to write." }
        },
        required: ["path", "contents"],
        additionalProperties: false
      }),
      execute: async ({ path, contents }): Promise<string> => {
        const target = safeResolve(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
        return `wrote ${contents.length} bytes to ${path}`;
      }
    }),
    run: tool({
      description: "Run a shell command (e.g. the test command) in the repository root.",
      inputSchema: jsonSchema<{ command: string }>({
        type: "object",
        properties: { command: { type: "string", description: "Shell command to run." } },
        required: ["command"],
        additionalProperties: false
      }),
      execute: async ({ command }): Promise<string> => runWorktreeCommand(root, command, commandTimeoutMs, envAllow)
    })
  };
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Sentinel returned instead of executing a tool call at the k-th step
 * boundary: the call is the candidate's terminal *proposal* (judged, maybe
 * adopted by the caller), never executed here. Sentinel observations are
 * stripped from the captured trajectory so candidates end at their proposed
 * `function_call` items.
 */
const PROPOSAL_SENTINEL = "[proposal boundary: call captured for judging, not executed]";

/**
 * Internal safety cap on an unbounded (k = ∞) rollout so a looping model
 * cannot run forever. Not a tuning knob: bounded rollouts are expressed with
 * `k`, never by adjusting this.
 */
const UNBOUNDED_ROLLOUT_CAP = 12;

type AnyTool = { execute?: (args: never, options: never) => unknown };

/**
 * Wrap a toolset so calls at or past the k-th step boundary are captured as
 * proposals instead of executing. `currentGeneration` reads the live 1-based
 * generation ordinal (a generation's whole parallel batch shares one ordinal,
 * so a batch is proposed atomically).
 */
function withProposalBoundary<T extends Record<string, AnyTool>>(
  tools: T,
  k: number,
  currentGeneration: () => number
): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, entry]) => [
      name,
      {
        ...entry,
        execute: async (args: never, options: never): Promise<unknown> => {
          if (currentGeneration() >= k) return PROPOSAL_SENTINEL;
          return await entry.execute?.(args, options);
        }
      }
    ])
  ) as T;
}

/** Run one panel model as a real agent over the worktree and capture its trajectory. */
export async function runWorktreeAgent(input: WorktreeAgentInput): Promise<WorktreeAgentResult> {
  const identity = {
    [ATTR.GEN_AI_OPERATION_NAME]: "chat",
    [ATTR.GEN_AI_REQUEST_MODEL]: input.model,
    [ATTR.FUSION_CANDIDATE_ID]: input.candidateId,
    [ATTR.FUSION_TRAJECTORY_ID]: input.candidateId,
    [ATTR.FUSION_MODEL_ID]: input.modelId,
    [ATTR.FUSION_TURN]: input.turn
  };
  // One `chat` span covers the whole agent tool loop (the panel model server
  // adds its own per-request chat spans as children via traceparent).
  const callSpan: FusionSpan | undefined =
    input.trace !== undefined
      ? startFusionSpan("panel-model", `chat ${input.model}`, input.trace, identity)
      : undefined;
  const traceHeaders = callSpan !== undefined ? headersOf(callSpan.carrier) : undefined;
  let baseUrlEnd = input.baseUrl.length;
  while (baseUrlEnd > 0 && input.baseUrl[baseUrlEnd - 1] === "/") baseUrlEnd -= 1;
  // The worktree agent talks to a local OpenAI-compatible server, so the
  // provider name, /v1 prefix, and dummy key stay tied to this launch path.
  const provider = createOpenAICompatible({
    name: "fusion-panel-agent",
    baseURL: `${input.baseUrl.slice(0, baseUrlEnd)}/v1`,
    apiKey: input.apiKey ?? "not-needed",
    ...(traceHeaders !== undefined ? { headers: traceHeaders } : {})
  });
  const model = provider(input.model);
  const steps: TrajectoryStep[] = [];
  let index = 0;
  const push = (step: Omit<TrajectoryStep, "index">): TrajectoryStep => {
    const full = { index: index++, ...step };
    steps.push(full);
    return full;
  };
  const emitStep = (step: TrajectoryStep): void => {
    input.onStep?.(step);
  };

  // Finite k: 1-based generation ordinal; the batch of the k-th generation is
  // captured unexecuted (the candidate's terminal proposal) and the loop stops
  // at that boundary. Observations count nothing extra — every tool call
  // conservatively marks a step boundary, per-generation, batch-atomic.
  let generation = 1;
  const rawTools = worktreeTools(input.worktree, input.commandTimeoutMs ?? 120_000, input.envAllow ?? []);
  const tools =
    input.k !== undefined
      ? withProposalBoundary(rawTools, input.k, () => generation)
      : rawTools;
  callSpan?.marker("panel-model", "fusion.model_call.started", {
    ...identity,
    [ATTR.FUSION_SYSTEM_PROMPT]: AGENT_SYSTEM_PROMPT,
    [ATTR.FUSION_PROMPT]: input.prompt,
    [ATTR.FUSION_TOOL_COUNT]: Object.keys(tools).length
  });
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model,
      system: AGENT_SYSTEM_PROMPT,
      prompt: input.prompt,
      tools,
      stopWhen: stepCountIs(input.k ?? UNBOUNDED_ROLLOUT_CAP),
      onStepFinish: (step) => {
        for (const normalized of extractSteps(step.content as AgentContentPart[])) {
          // Sentinel observations are bookkeeping, not evidence: the captured
          // trajectory must end at the proposed function_call items.
          if (normalized.type === "observation" && normalized.text === PROPOSAL_SENTINEL) continue;
          emitStep(push(normalized));
        }
        generation += 1;
      },
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {})
    });

    const toolCallCount = steps.filter((step) => step.type === "tool_call").length;
    const finalOutput = result.text ?? "";
    emitStep(push({ type: "output", text: finalOutput }));
    const usage = normalizeUsage(result.usage);
    callSpan?.end({
      status: "succeeded",
      attributes: {
        [ATTR.GEN_AI_RESPONSE_FINISH_REASONS]: [result.finishReason ?? "stop"],
        [ATTR.GEN_AI_USAGE_INPUT_TOKENS]: usage?.prompt_tokens,
        [ATTR.GEN_AI_USAGE_OUTPUT_TOKENS]: usage?.completion_tokens,
        [ATTR.FUSION_USAGE]: jsonAttr(
          usage !== undefined ? { ...usage, latency_s: (Date.now() - startedAt) / 1000 } : { latency_s: (Date.now() - startedAt) / 1000 }
        ),
        [ATTR.FUSION_FINISH_REASON]: result.finishReason ?? "stop",
        [ATTR.FUSION_STEP_COUNT]: steps.length,
        [ATTR.FUSION_TOOL_CALL_COUNT]: toolCallCount,
        [ATTR.FUSION_FINAL_OUTPUT]: finalOutput
      }
    });
    return {
      status: "succeeded",
      steps,
      finalOutput,
      finishReason: result.finishReason ?? "stop",
      toolCallCount
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitStep(push({ type: "output", text: `agent failed: ${message}` }));
    callSpan?.end({
      status: "failed",
      error: message,
      attributes: {
        [ATTR.FUSION_FINISH_REASON]: "error",
        [ATTR.FUSION_USAGE]: jsonAttr({ latency_s: (Date.now() - startedAt) / 1000 })
      }
    });
    return { status: "failed", steps, finalOutput: `agent failed: ${message}`, finishReason: "error", toolCallCount: 0 };
  }
}

/** Map AI SDK usage (field names vary by version) to OpenAI-style token counts. */
function normalizeUsage(usage: unknown): Record<string, number> | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const source = usage as Record<string, unknown>;
  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      if (typeof source[key] === "number") return source[key] as number;
    }
    return undefined;
  };
  const prompt = pick("promptTokens", "inputTokens", "prompt_tokens", "input_tokens");
  const completion = pick("completionTokens", "outputTokens", "completion_tokens", "output_tokens");
  const total = pick("totalTokens", "total_tokens") ?? (prompt ?? 0) + (completion ?? 0);
  const out: Record<string, number> = {};
  if (prompt !== undefined) out.prompt_tokens = prompt;
  if (completion !== undefined) out.completion_tokens = completion;
  if (total > 0 || prompt !== undefined || completion !== undefined) out.total_tokens = total;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Compute the worktree's staged diff against a base ref (for patch evidence). */
export function worktreeDiff(root: string, baseGitSha: string): string {
  try {
    execFileSync("git", ["add", "-A"], { cwd: root });
    return execFileSync("git", ["diff", "--cached", "--binary", baseGitSha], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
  } catch {
    return "";
  }
}
