import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, jsonSchema, stepCountIs, tool } from "ai";

import {
  emitTrace,
  modelCallFinishedPayload,
  modelCallStartedPayload,
  newSpanId,
  TRACE_CANDIDATE_HEADER,
  TRACE_ID_HEADER,
  TRACE_SPAN_HEADER
} from "@warrant/protocol";

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
  /** Max agent steps (tool round-trips) before stopping. Defaults to 12. */
  maxSteps?: number;
  /** Per-`run` command timeout in ms. Defaults to 120000. */
  commandTimeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Observability correlation id; when set, steps and model calls are traced. */
  traceId?: string;
  /** Candidate id this agent run belongs to (for trace correlation). */
  candidateId?: string;
  /** Parent span (e.g. the ensemble candidate span) for waterfall linking. */
  parentSpanId?: string;
  /** User-turn index this run belongs to (stamped on model.call events). */
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

function runCommand(root: string, command: string, timeoutMs: number): string {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command, { cwd: root, encoding: "utf8", timeout: timeoutMs, shell: true, env });
  const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return truncate(`exit_code=${result.status ?? "null"}\n${body}`, MAX_TOOL_OUTPUT);
}

function worktreeTools(root: string, commandTimeoutMs: number) {
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
      execute: async ({ command }): Promise<string> => runCommand(root, command, commandTimeoutMs)
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

/** Run one panel model as a real agent over the worktree and capture its trajectory. */
export async function runWorktreeAgent(input: WorktreeAgentInput): Promise<WorktreeAgentResult> {
  const agentSpan = newSpanId();
  const traceHeaders: Record<string, string> | undefined =
    input.traceId !== undefined
      ? {
          [TRACE_ID_HEADER]: input.traceId,
          [TRACE_SPAN_HEADER]: agentSpan,
          ...(input.candidateId !== undefined ? { [TRACE_CANDIDATE_HEADER]: input.candidateId } : {})
        }
      : undefined;
  const provider = createOpenAICompatible({
    name: "fusion-panel-agent",
    baseURL: `${input.baseUrl.replace(/\/+$/, "")}/v1`,
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
    if (input.traceId === undefined) return;
    emitTrace({
      component: "panel-model",
      event_type: "trajectory.step",
      traceId: input.traceId,
      spanId: agentSpan,
      ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
      ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
      modelId: input.model,
      payload: { step }
    });
  };
  const emitModelCall = (eventType: "model.call.started" | "model.call.finished", payload: Record<string, unknown>): void => {
    if (input.traceId === undefined) return;
    emitTrace({
      component: "panel-model",
      event_type: eventType,
      traceId: input.traceId,
      spanId: agentSpan,
      ...(input.parentSpanId !== undefined ? { parentSpanId: input.parentSpanId } : {}),
      ...(input.candidateId !== undefined ? { candidateId: input.candidateId } : {}),
      modelId: input.model,
      payload
    });
  };

  const tools = worktreeTools(input.worktree, input.commandTimeoutMs ?? 120_000);
  emitModelCall(
    "model.call.started",
    modelCallStartedPayload({
      model: input.model,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      prompt: input.prompt,
      tools: Object.keys(tools),
      ...(input.turn !== undefined ? { turn: input.turn } : {})
    })
  );
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model,
      system: AGENT_SYSTEM_PROMPT,
      prompt: input.prompt,
      tools,
      stopWhen: stepCountIs(input.maxSteps ?? 12),
      onStepFinish: (step) => {
        for (const normalized of extractSteps(step.content as AgentContentPart[])) {
          emitStep(push(normalized));
        }
      },
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {})
    });

    const toolCallCount = steps.filter((step) => step.type === "tool_call").length;
    const finalOutput = result.text ?? "";
    emitStep(push({ type: "output", text: finalOutput }));
    emitModelCall(
      "model.call.finished",
      modelCallFinishedPayload({
        model: input.model,
        finalOutput,
        finishReason: result.finishReason ?? "stop",
        stepCount: steps.length,
        toolCallCount,
        latencyS: (Date.now() - startedAt) / 1000,
        ...(input.turn !== undefined ? { turn: input.turn } : {}),
        ...(normalizeUsage(result.usage) !== undefined ? { usage: normalizeUsage(result.usage) } : {})
      })
    );
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
    emitModelCall(
      "model.call.finished",
      modelCallFinishedPayload({
        model: input.model,
        finishReason: "error",
        latencyS: (Date.now() - startedAt) / 1000,
        error: message,
        ...(input.turn !== undefined ? { turn: input.turn } : {})
      })
    );
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
