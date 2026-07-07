import { z } from "zod";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage
} from "@anthropic-ai/claude-agent-sdk";

import {
  HarnessError,
  PANEL_APPROVAL_POLICY,
  PendingRequests,
  asHarnessError,
  buildChildEnv,
  decideApproval,
  readCachedStatus,
  runCliCapture,
  writeCachedStatus
} from "@fusionkit/harness-core";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  DriverContext,
  HarnessDriver,
  HarnessEvent,
  HarnessInstance,
  HarnessRequestType,
  HarnessStatus,
  ResumeCursor,
  SessionHandle,
  SessionTurnInput,
  StartSessionOptions
} from "@fusionkit/harness-core";

const RESUME_CURSOR_VERSION = 1;
const DEFAULT_COMMAND = "claude";
const VERSION_PROBE_TIMEOUT_MS = 10_000;

const AUTH_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL"
] as const;

export const claudeDriverConfigSchema = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  model: z.string().optional(),
  /** Anthropic-dialect base URL claude's model calls route to (the gateway). */
  baseUrl: z.string().optional(),
  /** Extra credential env var names forwarded into the claude child. */
  credentialEnvNames: z.array(z.string()).default([])
});

export type ClaudeDriverConfig = z.infer<typeof claudeDriverConfigSchema>;

/**
 * The Agent SDK `query` function shape, isolated as a seam so tests can inject
 * a scripted transport instead of spawning the real `claude` binary (whose
 * control protocol is impractical to fake).
 */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => Query;

export type ClaudeDriverOptions = {
  queryFn?: ClaudeQueryFn;
};

function nowIso(): string {
  return new Date().toISOString();
}

function resolveEnv(context: DriverContext | undefined): Record<string, string | undefined> {
  return context?.env ?? process.env;
}

/**
 * The canonical approval request type for a claude tool name. Note `Task`
 * (Claude's sub-agent tool) deliberately lands in the generic `tool_approval`
 * bucket: under the panel default policy (`autoApprove: "all"`) it is
 * auto-accepted, so panel members can parallelize with same-model sub-agents,
 * while stricter policies (`edits`/`none`) still surface it like any tool.
 */
function requestTypeForTool(toolName: string): HarnessRequestType {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("execute")) return "exec_command_approval";
  if (lower.includes("edit") || lower.includes("write")) return "file_change_approval";
  if (lower.includes("read")) return "file_read_approval";
  return "tool_approval";
}

type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
};

class ClaudeSession implements SessionHandle {
  readonly #kind = "claude_code" as const;
  readonly #config: ClaudeDriverConfig;
  readonly #context: DriverContext | undefined;
  readonly #cwd: string;
  readonly #model: string | undefined;
  readonly #approvalPolicy: ApprovalPolicy;
  readonly #pending = new PendingRequests();
  #sessionId: string;
  #activeQuery: Query | undefined;
  #stopped = false;

  readonly #queryFn: ClaudeQueryFn;

  constructor(input: {
    config: ClaudeDriverConfig;
    context: DriverContext | undefined;
    options: StartSessionOptions;
    queryFn: ClaudeQueryFn;
  }) {
    this.#config = input.config;
    this.#context = input.context;
    this.#cwd = input.options.cwd;
    this.#model = input.options.model ?? input.config.model;
    this.#approvalPolicy = input.options.approvalPolicy ?? PANEL_APPROVAL_POLICY;
    this.#sessionId = resumeSessionId(input.options.resume) ?? "claude:pending";
    this.#queryFn = input.queryFn;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  #canUseTool(): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const requestType = requestTypeForTool(toolName);
      const auto = decideApproval(this.#approvalPolicy, requestType);
      const decision = auto ?? (await this.#surface(toolName, requestType, options.signal));
      if (decision === "decline" || decision === "cancel") {
        return { behavior: "deny", message: `denied by approval policy: ${toolName}` };
      }
      return {
        behavior: "allow",
        updatedInput: input,
        ...(decision === "acceptForSession" && options.suggestions !== undefined
          ? { updatedPermissions: options.suggestions }
          : {})
      };
    };
  }

  #channel: ((event: HarnessEvent) => void) | undefined;

  async #surface(
    toolName: string,
    requestType: HarnessRequestType,
    signal: AbortSignal
  ): Promise<ApprovalDecision> {
    const request = this.#pending.open({ requestType, detail: toolName });
    this.#emit({
      kind: this.#kind,
      sessionId: this.#sessionId,
      at: nowIso(),
      type: "request.opened",
      requestId: request.requestId,
      requestType,
      detail: toolName,
      raw: { source: "claude.canUseTool" }
    });
    const decision = await Promise.race([
      request.decision,
      new Promise<ApprovalDecision>((resolve) => {
        if (signal.aborted) resolve("cancel");
        else signal.addEventListener("abort", () => resolve("cancel"), { once: true });
      })
    ]);
    this.#emit({
      kind: this.#kind,
      sessionId: this.#sessionId,
      at: nowIso(),
      type: "request.resolved",
      requestId: request.requestId,
      decision,
      raw: { source: "claude.canUseTool" }
    });
    return decision;
  }

  #emit(event: HarnessEvent): void {
    this.#channel?.(event);
  }

  async *sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent> {
    if (this.#stopped) throw new HarnessError("session_closed", "claude session is stopped");
    const controller = new AbortController();
    if (input.signal !== undefined) {
      if (input.signal.aborted) controller.abort(input.signal.reason);
      else input.signal.addEventListener("abort", () => controller.abort(input.signal?.reason), { once: true });
    }
    const resume = this.#sessionId !== "claude:pending" ? this.#sessionId : undefined;
    const options: Options = {
      cwd: this.#cwd,
      pathToClaudeCodeExecutable: this.#config.command,
      permissionMode: "default",
      canUseTool: this.#canUseTool(),
      abortController: controller,
      env: this.#childEnv(),
      ...(this.#model !== undefined ? { model: this.#model } : {}),
      ...(resume !== undefined ? { resume } : {})
    };

    const queued: HarnessEvent[] = [];
    let notify: (() => void) | undefined;
    this.#channel = (event) => {
      queued.push(event);
      notify?.();
    };
    const turnId = `${this.#sessionId}:turn:${Date.now()}`;
    // turn.started is emitted from mapMessage once system/init fixes the real
    // session id, so it (and every later event) carries the final id.
    const q = this.#queryFn({ prompt: input.prompt, options });
    this.#activeQuery = q;
    let done = false;
    let failure: unknown;
    const pump = (async (): Promise<void> => {
      try {
        for await (const message of q) {
          for (const event of this.#mapMessage(message, turnId)) queued.push(event);
          notify?.();
        }
      } catch (error) {
        failure = error;
      } finally {
        done = true;
        notify?.();
      }
    })();

    try {
      for (;;) {
        if (queued.length > 0) {
          yield queued.shift() as HarnessEvent;
          continue;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          notify = () => {
            notify = undefined;
            resolve();
          };
        });
      }
      await pump;
      if (failure !== undefined) {
        const base = { kind: this.#kind, sessionId: this.#sessionId, at: nowIso(), turnId };
        if (controller.signal.aborted) {
          yield { ...base, type: "turn.completed", endReason: "aborted" };
        } else {
          const harnessError = asHarnessError(failure);
          yield { ...base, type: "turn.failed", errorCode: harnessError.code, message: harnessError.message };
        }
      }
    } finally {
      this.#channel = undefined;
      this.#activeQuery = undefined;
    }
  }

  *#mapMessage(message: SDKMessage, turnId: string): Generator<HarnessEvent> {
    const base = { kind: this.#kind, sessionId: this.#sessionId, at: nowIso(), turnId };
    const raw = { source: "claude.sdk.message", method: message.type };
    if (message.type === "system" && message.subtype === "init") {
      const resumed = this.#sessionId !== "claude:pending" && this.#sessionId === message.session_id;
      this.#sessionId = message.session_id;
      yield {
        kind: this.#kind,
        sessionId: this.#sessionId,
        at: nowIso(),
        type: "session.started",
        resumed,
        raw
      };
      // Bracket the turn now that the real session id is known, so turn.started
      // and every subsequent event carry the final id.
      yield {
        kind: this.#kind,
        sessionId: this.#sessionId,
        at: nowIso(),
        turnId,
        type: "turn.started"
      };
      return;
    }
    if (message.type === "assistant") {
      const content = (message.message as { content?: ContentBlock[] }).content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text !== undefined && block.text.length > 0) {
          yield { ...base, type: "content.delta", stream: "assistant_text", text: block.text, raw };
        } else if (block.type === "thinking" && block.thinking !== undefined) {
          yield { ...base, type: "content.delta", stream: "reasoning_text", text: block.thinking, raw };
        } else if (block.type === "tool_use") {
          yield {
            ...base,
            type: "tool.call",
            name: block.name ?? "tool",
            ...(block.input !== undefined ? { input: block.input as never } : {}),
            raw
          };
        }
      }
      return;
    }
    if (message.type === "result") {
      const endReason = message.subtype === "success" ? "completed" : "error";
      yield {
        ...base,
        type: "turn.completed",
        endReason,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens
        },
        raw
      };
      return;
    }
  }

  #childEnv(): Record<string, string> {
    return buildChildEnv({
      base: resolveEnv(this.#context),
      allow: [...AUTH_ENV_NAMES, ...this.#config.credentialEnvNames, /^CLAUDE_/],
      ...(this.#config.baseUrl !== undefined ? { extra: { ANTHROPIC_BASE_URL: this.#config.baseUrl } } : {})
    });
  }

  async respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.#pending.resolve(requestId, decision)) {
      throw new HarnessError("protocol_parse", `unknown pending request ${requestId}`);
    }
  }

  async interrupt(): Promise<void> {
    this.#pending.settleAll("cancel");
    await this.#activeQuery?.interrupt().catch(() => undefined);
  }

  resumeCursor(): ResumeCursor | undefined {
    if (this.#sessionId === "claude:pending") return undefined;
    return { version: RESUME_CURSOR_VERSION, kind: this.#kind, data: { sessionId: this.#sessionId } };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pending.settleAll("cancel");
    await this.#activeQuery?.interrupt().catch(() => undefined);
  }
}

function resumeSessionId(resume: ResumeCursor | undefined): string | undefined {
  if (resume === undefined || resume.kind !== "claude_code") return undefined;
  const data = resume.data as { sessionId?: unknown };
  return typeof data.sessionId === "string" ? data.sessionId : undefined;
}

class ClaudeInstance implements HarnessInstance {
  readonly kind = "claude_code" as const;
  readonly #config: ClaudeDriverConfig;
  readonly #context: DriverContext | undefined;
  readonly #status: HarnessStatus;
  readonly #queryFn: ClaudeQueryFn;
  readonly #sessions = new Set<ClaudeSession>();

  constructor(input: {
    config: ClaudeDriverConfig;
    context: DriverContext | undefined;
    status: HarnessStatus;
    queryFn: ClaudeQueryFn;
  }) {
    this.#config = input.config;
    this.#context = input.context;
    this.#status = input.status;
    this.#queryFn = input.queryFn;
  }

  status(): HarnessStatus {
    return this.#status;
  }

  async startSession(options: StartSessionOptions): Promise<SessionHandle> {
    const session = new ClaudeSession({
      config: this.#config,
      context: this.#context,
      options,
      queryFn: this.#queryFn
    });
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.stop();
    this.#sessions.clear();
  }
}

/** Probe the claude CLI: version via `claude --version`, auth from credential env. */
async function probeClaude(
  config: ClaudeDriverConfig,
  context: DriverContext | undefined
): Promise<HarnessStatus> {
  const env = buildChildEnv({ base: resolveEnv(context), allow: [...AUTH_ENV_NAMES, /^CLAUDE_/] });
  try {
    const result = await runCliCapture(config.command, ["--version"], {
      env,
      timeoutMs: VERSION_PROBE_TIMEOUT_MS
    });
    if (result.exitCode !== 0) {
      return {
        kind: "claude_code",
        installed: false,
        auth: { status: "unknown" },
        checkedAt: nowIso(),
        probeError: result.stderr.trim() || `claude --version exited ${result.exitCode}`
      };
    }
    const sourceEnv = resolveEnv(context);
    const hasCredential = AUTH_ENV_NAMES.some((name) => (sourceEnv[name]?.length ?? 0) > 0);
    return {
      kind: "claude_code",
      installed: true,
      command: config.command,
      version: result.stdout.trim().split(/\s+/).at(-1),
      auth: {
        status: hasCredential ? "authenticated" : "unknown",
        ...(hasCredential ? {} : { detail: "No API key in env; claude may use its own login." })
      },
      checkedAt: nowIso()
    };
  } catch (error) {
    const harnessError = asHarnessError(error);
    return {
      kind: "claude_code",
      installed: false,
      auth: { status: "unknown" },
      checkedAt: nowIso(),
      probeError:
        harnessError.code === "not_installed"
          ? `Claude CLI "${config.command}" was not found on PATH.`
          : harnessError.message
    };
  }
}

export function createClaudeDriver(options: ClaudeDriverOptions = {}): HarnessDriver<ClaudeDriverConfig> {
  const queryFn = options.queryFn ?? (query as ClaudeQueryFn);
  return {
    kind: "claude_code",
    configSchema: claudeDriverConfigSchema,
    probe: async (context?: DriverContext) => {
      const status = await probeClaude(claudeDriverConfigSchema.parse({}), context);
      if (context?.statusCacheDir !== undefined) writeCachedStatus(status, context.statusCacheDir);
      return status;
    },
    createInstance: async (config, context?: DriverContext) => {
      const cached =
        context?.statusCacheDir !== undefined
          ? readCachedStatus("claude_code", context.statusCacheDir)
          : undefined;
      const status = cached ?? (await probeClaude(config, context));
      return new ClaudeInstance({ config, context, status, queryFn });
    }
  };
}
