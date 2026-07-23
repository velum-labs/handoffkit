import { rmSync } from "node:fs";

import { z } from "zod";

import { Codex } from "@openai/codex-sdk";
import type {
  ModelReasoningEffort,
  CodexOptions,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Thread
} from "@openai/codex-sdk";

import {
  HarnessError,
  asHarnessError,
  buildChildEnv,
  createCachedHarnessDriver,
  probeCliVersion,
  resolveDriverEnv
} from "@velum-labs/routekit-harness-core";
import type {
  DriverContext,
  HarnessDriver,
  HarnessEvent,
  HarnessInstance,
  HarnessItemType,
  HarnessStatus,
  ResumeCursor,
  SessionHandle,
  SessionTurnInput,
  StartSessionOptions
} from "@velum-labs/routekit-harness-core";
import { registerCleanup } from "@velum-labs/routekit-runtime";

import { createIsolatedCodexHome } from "./launch.js";

const RESUME_CURSOR_VERSION = 1;
const DEFAULT_COMMAND = "codex";

/**
 * Gateway-routed sessions run in an isolated `CODEX_HOME`: the user's own
 * `~/.codex/config.toml` (model, reasoning effort, MCP servers, profiles) must
 * not leak into requests routed through the gateway, and codex must not
 * overwrite the user's real models cache with gateway catalog entries. The
 * home is shared per process (not per instance) because codex thread rollouts
 * live inside it and resume cursors must survive across panel turns, each of
 * which builds a fresh driver instance.
 */
let sharedIsolatedHome: string | undefined;

function isolatedCodexHome(env: Record<string, string | undefined>): string {
  if (sharedIsolatedHome === undefined) {
    const home = createIsolatedCodexHome("routekit-codex-driver-", env);
    sharedIsolatedHome = home;
    registerCleanup(() => {
      rmSync(home, { recursive: true, force: true });
      if (sharedIsolatedHome === home) sharedIsolatedHome = undefined;
    });
  }
  return sharedIsolatedHome;
}

const providerSchema = z.object({
  /** OpenAI-compatible base URL the codex model calls go to (e.g. the gateway). */
  baseUrl: z.string().optional(),
  /** Inline API key (prefer apiKeyEnvName for anything long-lived). */
  apiKey: z.string().optional(),
  /** Env var name holding the API key; read from the driver's env at spawn. */
  apiKeyEnvName: z.string().optional()
});

export const codexDriverConfigSchema = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  model: z.string().optional(),
  sandboxMode: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  approvalPolicy: z
    .enum(["never", "on-request", "on-failure", "untrusted"])
    .default("never"),
  provider: providerSchema.default({}),
  /** Extra credential env var names forwarded into the codex child. */
  credentialEnvNames: z.array(z.string()).default([])
});

export type CodexDriverConfig = z.infer<typeof codexDriverConfigSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

function itemTypeFor(item: ThreadItem): HarnessItemType {
  switch (item.type) {
    case "agent_message":
      return "assistant_message";
    case "reasoning":
      return "reasoning";
    case "command_execution":
      return "command_execution";
    case "file_change":
      return "file_change";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
    case "todo_list":
    case "error":
      return "dynamic_tool_call";
    default: {
      const exhausted: never = item;
      throw new Error(`unsupported codex item: ${String(exhausted)}`);
    }
  }
}

function itemText(item: ThreadItem): string | undefined {
  switch (item.type) {
    case "agent_message":
    case "reasoning":
      return item.text;
    case "command_execution":
      return item.aggregated_output;
    case "error":
      return item.message;
    default:
      return undefined;
  }
}

/** Build the codex-sdk options from the driver config and its allowlisted env. */
function codexOptionsFor(
  config: CodexDriverConfig,
  context: DriverContext | undefined,
  isolatedHome: string | undefined
): CodexOptions {
  const sourceEnv = resolveDriverEnv(context);
  const apiKey =
    config.provider.apiKey ??
    (config.provider.apiKeyEnvName !== undefined
      ? sourceEnv[config.provider.apiKeyEnvName]
      : undefined);
  const childEnv = buildChildEnv({
    base: sourceEnv,
    allow: [
      ...config.credentialEnvNames,
      ...(config.provider.apiKeyEnvName !== undefined ? [config.provider.apiKeyEnvName] : []),
      "CODEX_HOME",
      "CODEX_API_KEY",
      "OPENAI_API_KEY"
    ]
  });
  if (isolatedHome !== undefined) childEnv.CODEX_HOME = isolatedHome;
  return {
    codexPathOverride: config.command,
    ...(config.provider.baseUrl !== undefined
      ? {
          config: {
            model_provider: "routekit",
            model_providers: {
              routekit: {
                name: "RouteKit gateway",
                base_url: config.provider.baseUrl,
                wire_api: "responses",
                requires_openai_auth: false,
                supports_websockets: false
              }
            }
          }
        }
      : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    env: childEnv
  };
}

class CodexSession implements SessionHandle {
  #sessionId: string;
  readonly #thread: Thread;
  readonly #kind = "codex" as const;
  readonly #reasoning: StartSessionOptions["reasoning"];

  constructor(
    thread: Thread,
    resumedThreadId: string | undefined,
    reasoning?: StartSessionOptions["reasoning"]
  ) {
    this.#thread = thread;
    // Codex assigns the real thread id on the first turn; until then we track
    // a resumed id if we have one, else a placeholder that firms up on start.
    this.#sessionId = resumedThreadId ?? "codex:pending";
    this.#reasoning = reasoning;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async *sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent> {
    if (
      input.reasoning !== undefined &&
      JSON.stringify(input.reasoning) !== JSON.stringify(this.#reasoning)
    ) {
      throw new HarnessError(
        "invalid_config",
        "Codex SDK reasoning must be selected before the session starts"
      );
    }
    const base = { kind: this.#kind, sessionId: this.#sessionId, at: nowIso() };
    let turnId: string | undefined;
    let streamed;
    try {
      streamed = await this.#thread.runStreamed(input.prompt, {
        ...(input.signal !== undefined ? { signal: input.signal } : {})
      });
    } catch (error) {
      throw asHarnessError(error);
    }
    try {
      for await (const event of streamed.events) {
        yield* this.#mapEvent(event, () => {
          turnId ??= `${this.#sessionId}:turn`;
          return turnId;
        });
      }
    } catch (error) {
      if (input.signal?.aborted === true) {
        yield {
          ...base,
          type: "turn.completed",
          ...(turnId !== undefined ? { turnId } : {}),
          endReason: "aborted"
        };
        return;
      }
      const harnessError = asHarnessError(error);
      yield {
        ...base,
        type: "turn.failed",
        ...(turnId !== undefined ? { turnId } : {}),
        errorCode: harnessError.code,
        message: harnessError.message
      };
    }
  }

  *#mapEvent(event: ThreadEvent, turnId: () => string): Generator<HarnessEvent> {
    const raw = { source: "codex.exec.json", method: event.type };
    switch (event.type) {
      case "thread.started": {
        this.#sessionId = event.thread_id;
        yield {
          kind: this.#kind,
          sessionId: this.#sessionId,
          at: nowIso(),
          type: "session.started",
          resumed: false,
          raw: { ...raw, payload: { thread_id: event.thread_id } }
        };
        return;
      }
      case "turn.started":
        yield {
          kind: this.#kind,
          sessionId: this.#sessionId,
          at: nowIso(),
          type: "turn.started",
          turnId: turnId(),
          raw
        };
        return;
      case "item.started": {
        yield {
          kind: this.#kind,
          sessionId: this.#sessionId,
          at: nowIso(),
          type: "item.started",
          turnId: turnId(),
          itemId: event.item.id,
          itemType: itemTypeFor(event.item),
          raw
        };
        return;
      }
      case "item.updated":
        // Codex item.updated carries cumulative text; the authoritative text
        // is emitted once on item.completed, so no delta is produced here.
        return;
      case "item.completed": {
        // Assistant / reasoning text is delivered as one content delta from
        // the terminal item (codex reports final text on completion).
        if (event.item.type === "agent_message" && event.item.text.length > 0) {
          yield {
            kind: this.#kind,
            sessionId: this.#sessionId,
            at: nowIso(),
            type: "content.delta",
            turnId: turnId(),
            itemId: event.item.id,
            stream: "assistant_text",
            text: event.item.text,
            raw
          };
        } else if (event.item.type === "reasoning" && event.item.text.length > 0) {
          yield {
            kind: this.#kind,
            sessionId: this.#sessionId,
            at: nowIso(),
            type: "content.delta",
            turnId: turnId(),
            itemId: event.item.id,
            stream: "reasoning_text",
            text: event.item.text,
            raw
          };
        }
        yield {
          kind: this.#kind,
          sessionId: this.#sessionId,
          at: nowIso(),
          type: "item.completed",
          turnId: turnId(),
          itemId: event.item.id,
          itemType: itemTypeFor(event.item),
          status: event.item.type === "error" ? "failed" : "completed",
          ...(itemText(event.item) !== undefined ? { detail: itemText(event.item) } : {}),
          raw
        };
        return;
      }
      case "turn.completed":
        yield {
          kind: this.#kind,
          sessionId: this.#sessionId,
          at: nowIso(),
          type: "turn.completed",
          turnId: turnId(),
          endReason: "completed",
          usage: {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens
          },
          raw
        };
        return;
      case "turn.failed":
        yield {
          kind: this.#kind,
          sessionId: this.#sessionId,
          at: nowIso(),
          type: "turn.failed",
          turnId: turnId(),
          errorCode: "provider_error",
          message: event.error.message,
          raw
        };
        return;
      case "error":
        yield {
          kind: this.#kind,
          sessionId: this.#sessionId,
          at: nowIso(),
          type: "turn.failed",
          turnId: turnId(),
          errorCode: "provider_error",
          message: event.message,
          raw
        };
        return;
      default: {
        const exhausted: never = event;
        throw new Error(`unsupported codex event: ${String(exhausted)}`);
      }
    }
  }

  async respondToRequest(): Promise<void> {
    // Codex exec runs with a fixed approval policy (never/on-request set at
    // thread start); it does not surface interactive approvals over this
    // transport, so there are no pending requests to answer.
    throw new HarnessError(
      "protocol_parse",
      "codex exec does not surface interactive approval requests"
    );
  }

  async interrupt(): Promise<void> {
    // The turn is interrupted by aborting the signal passed to sendTurn; the
    // codex-sdk kills the child on abort. Nothing extra to do here.
  }

  resumeCursor(): ResumeCursor | undefined {
    if (this.#sessionId === "codex:pending") return undefined;
    return { version: RESUME_CURSOR_VERSION, kind: this.#kind, data: { threadId: this.#sessionId } };
  }

  async stop(): Promise<void> {
    // A completed/aborted turn already released the child; there is no
    // long-lived process to stop between turns for codex exec.
  }
}

function resumeThreadId(resume: ResumeCursor | undefined): string | undefined {
  if (resume === undefined || resume.kind !== "codex") return undefined;
  const data = resume.data as { threadId?: unknown };
  return typeof data.threadId === "string" ? data.threadId : undefined;
}

class CodexInstance implements HarnessInstance {
  readonly kind = "codex" as const;
  readonly #config: CodexDriverConfig;
  readonly #context: DriverContext | undefined;
  readonly #status: HarnessStatus;

  constructor(config: CodexDriverConfig, context: DriverContext | undefined, status: HarnessStatus) {
    this.#config = config;
    this.#context = context;
    this.#status = status;
  }

  status(): HarnessStatus {
    return this.#status;
  }

  /** An explicit `CODEX_HOME` in the driver env wins over the isolation. */
  #homeFor(): string | undefined {
    if (this.#config.provider.baseUrl === undefined) return undefined;
    const env = resolveDriverEnv(this.#context);
    if (env.CODEX_HOME !== undefined) return undefined;
    return isolatedCodexHome(env);
  }

  async startSession(options: StartSessionOptions): Promise<SessionHandle> {
    if (
      options.reasoning !== undefined &&
      options.reasoning.mode !== "auto" &&
      options.reasoning.mode !== "effort"
    ) {
      throw new HarnessError(
        "invalid_config",
        `Codex SDK cannot represent reasoning mode "${options.reasoning.mode}"`
      );
    }
    const codex = new Codex(codexOptionsFor(this.#config, this.#context, this.#homeFor()));
    const threadOptions: ThreadOptions = {
      sandboxMode: this.#config.sandboxMode,
      approvalPolicy: this.#config.approvalPolicy,
      workingDirectory: options.cwd,
      skipGitRepoCheck: true,
      ...(options.model ?? this.#config.model !== undefined
        ? { model: options.model ?? this.#config.model }
        : {}),
      ...(options.reasoning?.mode === "effort"
        ? {
            modelReasoningEffort:
              options.reasoning.effort as ModelReasoningEffort
          }
        : {})
    };
    const resumedId = resumeThreadId(options.resume);
    const thread =
      resumedId !== undefined
        ? codex.resumeThread(resumedId, threadOptions)
        : codex.startThread(threadOptions);
    return new CodexSession(thread, resumedId, options.reasoning);
  }

  async dispose(): Promise<void> {
    // Sessions own their (short-lived) child processes; the shared isolated
    // home outlives the instance so resumable thread rollouts stay available.
  }
}

/**
 * Probe the codex CLI: version via `codex --version`, and treat a present
 * `CODEX_HOME/auth.json` or a configured provider credential as authenticated.
 * Full account detail requires the app-server protocol; this is the cheap,
 * offline-friendly signal launchers and readiness checks need.
 */
async function probeCodex(
  config: CodexDriverConfig,
  context: DriverContext | undefined
): Promise<HarnessStatus> {
  const sourceEnv = resolveDriverEnv(context);
  const env = buildChildEnv({ base: sourceEnv });
  const hasCredential =
    config.provider.apiKey !== undefined ||
    (config.provider.apiKeyEnvName !== undefined &&
      (sourceEnv[config.provider.apiKeyEnvName]?.length ?? 0) > 0) ||
    config.credentialEnvNames.some((name) => (sourceEnv[name]?.length ?? 0) > 0);
  return probeCliVersion({
    kind: "codex",
    command: config.command,
    cliName: "codex",
    env,
    auth: {
      status: hasCredential ? "authenticated" : "unknown",
      ...(hasCredential ? {} : { detail: "No API key configured; codex may use its own login." })
    },
    notInstalledAuth: { status: "unknown" },
    notInstalledMessage: `Codex CLI "${config.command}" was not found on PATH.`
  });
}

export function createCodexDriver(): HarnessDriver<CodexDriverConfig> {
  return createCachedHarnessDriver({
    kind: "codex",
    configSchema: codexDriverConfigSchema,
    probeConfig: () => codexDriverConfigSchema.parse({}),
    probeStatus: probeCodex,
    createInstance: (config, context, status) =>
      new CodexInstance(config, context, status)
  });
}
