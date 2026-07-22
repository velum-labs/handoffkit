import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { z } from "zod";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream
} from "@zed-industries/agent-client-protocol";
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from "@zed-industries/agent-client-protocol";

import {
  AsyncChannel,
  HarnessError,
  DEFAULT_AUTOMATION_APPROVAL_POLICY,
  PendingRequests,
  asHarnessError,
  buildChildEnv,
  createCachedHarnessDriver,
  decideApproval,
  probeCliVersion,
  resolveDriverEnv,
  terminate
} from "@routekit/harness-core";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  DriverContext,
  HarnessDriver,
  HarnessEvent,
  HarnessInstance,
  HarnessItemType,
  HarnessRequestType,
  HarnessStatus,
  ResumeCursor,
  SessionHandle,
  SessionTurnInput,
  StartSessionOptions
} from "@routekit/harness-core";

const RESUME_CURSOR_VERSION = 1;
const DEFAULT_COMMAND = "cursor-agent";
const AUTH_METHOD_ID = "cursor_login";

export const cursorDriverConfigSchema = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  /** OpenAI-compatible endpoint cursor-agent's model calls route to (the gateway/bridge). */
  endpoint: z.string().optional(),
  model: z.string().optional()
});

export type CursorDriverConfig = z.infer<typeof cursorDriverConfigSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

function cursorReasoningEffort(
  reasoning: StartSessionOptions["reasoning"]
): string | undefined {
  if (reasoning === undefined || reasoning.mode === "auto") return undefined;
  if (reasoning.mode === "effort") return reasoning.effort;
  throw new HarnessError(
    "invalid_config",
    `Cursor ACP cannot represent reasoning mode "${reasoning.mode}"`
  );
}

/** Map an ACP tool kind onto the canonical item type. */
function itemTypeForToolKind(kind: string | null | undefined): HarnessItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

/** Map an ACP permission option kind onto our approval decision. */
function decisionForOptionKind(kind: string): ApprovalDecision {
  switch (kind) {
    case "allow_always":
      return "acceptForSession";
    case "allow_once":
      return "accept";
    case "reject_always":
    case "reject_once":
      return "decline";
    default:
      return "decline";
  }
}

/** The request type an ACP permission maps to, from its tool-call kind. */
function requestTypeForToolKind(kind: string | null | undefined): HarnessRequestType {
  switch (kind) {
    case "execute":
      return "exec_command_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    default:
      return "tool_approval";
  }
}

class CursorSession implements SessionHandle {
  readonly #kind = "cursor" as const;
  readonly #child: ChildProcess;
  readonly #connection: ClientSideConnection;
  readonly #pending = new PendingRequests();
  readonly #approvalPolicy: ApprovalPolicy;
  #reasoning: StartSessionOptions["reasoning"];
  readonly #optionKindById = new Map<string, string>();
  #sessionId: string;
  #channel: AsyncChannel<HarnessEvent> | undefined;
  #turnId: string | undefined;
  #openItems = new Set<string>();
  #stopped = false;

  constructor(input: {
    child: ChildProcess;
    connection: ClientSideConnection;
    sessionId: string;
    approvalPolicy: ApprovalPolicy;
    reasoning?: StartSessionOptions["reasoning"];
  }) {
    this.#child = input.child;
    this.#connection = input.connection;
    this.#sessionId = input.sessionId;
    this.#approvalPolicy = input.approvalPolicy;
    this.#reasoning = input.reasoning;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** Fed by the ACP Client handler (see makeClient) for every session update. */
  ingestUpdate(params: SessionNotification): void {
    const channel = this.#channel;
    if (channel === undefined) return;
    const update = params.update;
    const base = {
      kind: this.#kind,
      sessionId: this.#sessionId,
      at: nowIso(),
      ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {})
    };
    const raw = { source: "acp.session.update", method: update.sessionUpdate };
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          channel.push({ ...base, type: "content.delta", stream: "assistant_text", text: update.content.text, raw });
        }
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") {
          channel.push({ ...base, type: "content.delta", stream: "reasoning_text", text: update.content.text, raw });
        }
        return;
      case "tool_call": {
        const itemType = itemTypeForToolKind(update.kind);
        this.#openItems.add(update.toolCallId);
        channel.push({
          ...base,
          type: "item.started",
          itemId: update.toolCallId,
          itemType,
          ...(update.title !== undefined ? { title: update.title } : {}),
          raw
        });
        return;
      }
      case "tool_call_update": {
        if (update.status === "completed" || update.status === "failed") {
          if (this.#openItems.delete(update.toolCallId)) {
            channel.push({
              ...base,
              type: "item.completed",
              itemId: update.toolCallId,
              itemType: itemTypeForToolKind(update.kind),
              status: update.status === "failed" ? "failed" : "completed",
              raw
            });
          }
        }
        return;
      }
      case "user_message_chunk":
      case "plan":
      case "available_commands_update":
      case "current_mode_update":
        return;
      default: {
        const exhausted: never = update;
        throw new Error(`unsupported ACP session update: ${String(exhausted)}`);
      }
    }
  }

  /** Fed by the ACP Client handler for permission requests. */
  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const kind = params.toolCall.kind;
    const requestType = requestTypeForToolKind(kind);
    for (const option of params.options) this.#optionKindById.set(option.optionId, option.kind);

    const auto = decideApproval(this.#approvalPolicy, requestType);
    const decision = auto ?? (await this.#surface(params, requestType));
    if (decision === "decline" || decision === "cancel") {
      const reject = params.options.find(
        (option) => option.kind === "reject_once" || option.kind === "reject_always"
      );
      return reject !== undefined
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    const preferredKind = decision === "acceptForSession" ? "allow_always" : "allow_once";
    const option =
      params.options.find((entry) => entry.kind === preferredKind) ??
      params.options.find((entry) => entry.kind === "allow_once" || entry.kind === "allow_always");
    return option !== undefined
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async #surface(
    params: RequestPermissionRequest,
    requestType: HarnessRequestType
  ): Promise<ApprovalDecision> {
    const channel = this.#channel;
    const request = this.#pending.open({
      requestType,
      ...(params.toolCall.title !== undefined && params.toolCall.title !== null
        ? { detail: params.toolCall.title }
        : {})
    });
    if (channel !== undefined) {
      channel.push({
        kind: this.#kind,
        sessionId: this.#sessionId,
        at: nowIso(),
        ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
        type: "request.opened",
        requestId: request.requestId,
        requestType,
        ...(request.detail !== undefined ? { detail: request.detail } : {}),
        raw: { source: "acp.request.permission" }
      });
    }
    const decision = await request.decision;
    if (channel !== undefined) {
      channel.push({
        kind: this.#kind,
        sessionId: this.#sessionId,
        at: nowIso(),
        ...(this.#turnId !== undefined ? { turnId: this.#turnId } : {}),
        type: "request.resolved",
        requestId: request.requestId,
        decision,
        raw: { source: "acp.request.permission" }
      });
    }
    return decision;
  }

  async *sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent> {
    if (this.#stopped) throw new HarnessError("session_closed", "cursor session is stopped");
    const channel = new AsyncChannel<HarnessEvent>();
    this.#channel = channel;
    this.#turnId = `${this.#sessionId}:turn:${Date.now()}`;
    const turnId = this.#turnId;
    const base = { kind: this.#kind, sessionId: this.#sessionId, at: nowIso(), turnId };

    channel.push({ ...base, type: "turn.started" });

    // An already-aborted turn never reaches the agent: settle it directly so
    // it cannot resolve as completed off a prompt the agent ignored.
    if (input.signal?.aborted === true) {
      channel.push({ ...base, type: "turn.completed", endReason: "aborted" });
      channel.close();
      try {
        yield* channel;
      } finally {
        this.#channel = undefined;
        this.#turnId = undefined;
      }
      return;
    }

    if (
      input.reasoning !== undefined &&
      JSON.stringify(input.reasoning) !== JSON.stringify(this.#reasoning)
    ) {
      const effort = cursorReasoningEffort(input.reasoning);
      if (effort !== undefined) {
        await this.#connection.extMethod("session/set_config_option", {
          sessionId: this.#sessionId,
          configId: "reasoning",
          value: effort
        });
      }
      this.#reasoning = input.reasoning;
    }

    const onAbort = (): void => {
      this.#pending.settleAll("cancel");
      void this.#connection.cancel({ sessionId: this.#sessionId }).catch(() => undefined);
    };
    if (input.signal !== undefined) {
      input.signal.addEventListener("abort", onAbort, { once: true });
    }

    this.#connection
      .prompt({
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text: input.prompt }]
      })
      .then((response) => {
        channel.push({
          ...base,
          type: "turn.completed",
          endReason: response.stopReason === "cancelled" ? "aborted" : "completed",
          raw: { source: "acp.prompt.response", payload: { stopReason: response.stopReason } }
        });
        channel.close();
      })
      .catch((error) => {
        const harnessError = asHarnessError(error);
        channel.push({
          ...base,
          type: "turn.failed",
          errorCode: harnessError.code,
          message: harnessError.message
        });
        channel.close();
      });

    try {
      yield* channel;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.#channel = undefined;
      this.#turnId = undefined;
      this.#openItems.clear();
    }
  }

  async respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.#pending.resolve(requestId, decision)) {
      throw new HarnessError("protocol_parse", `unknown pending request ${requestId}`);
    }
  }

  async interrupt(): Promise<void> {
    this.#pending.settleAll("cancel");
    await this.#connection.cancel({ sessionId: this.#sessionId }).catch(() => undefined);
  }

  resumeCursor(): ResumeCursor {
    return {
      version: RESUME_CURSOR_VERSION,
      kind: this.#kind,
      data: { sessionId: this.#sessionId }
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#pending.settleAll("cancel");
    this.#channel?.close();
    terminate(this.#child);
  }
}

function resumeSessionId(resume: ResumeCursor | undefined): string | undefined {
  if (resume === undefined || resume.kind !== "cursor") return undefined;
  const data = resume.data as { sessionId?: unknown };
  return typeof data.sessionId === "string" ? data.sessionId : undefined;
}

class CursorInstance implements HarnessInstance {
  readonly kind = "cursor" as const;
  readonly #config: CursorDriverConfig;
  readonly #context: DriverContext | undefined;
  readonly #status: HarnessStatus;
  readonly #sessions = new Set<CursorSession>();

  constructor(config: CursorDriverConfig, context: DriverContext | undefined, status: HarnessStatus) {
    this.#config = config;
    this.#context = context;
    this.#status = status;
  }

  status(): HarnessStatus {
    return this.#status;
  }

  async startSession(options: StartSessionOptions): Promise<SessionHandle> {
    const args = this.#config.endpoint !== undefined ? ["-e", this.#config.endpoint, "acp"] : ["acp"];
    const child = spawn(this.#config.command, args, {
      cwd: options.cwd,
      env: buildChildEnv({ base: resolveDriverEnv(this.#context), allow: [/^CURSOR_/] }),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.stdin === null || child.stdout === null) {
      terminate(child);
      throw new HarnessError("session_closed", "cursor-agent has no stdio");
    }
    let session: CursorSession | undefined;
    const client: Client = {
      sessionUpdate: async (params: SessionNotification) => {
        session?.ingestUpdate(params);
      },
      requestPermission: async (params) => {
        if (session === undefined) return { outcome: { outcome: "cancelled" } };
        return session.requestPermission(params);
      }
    };
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = new ClientSideConnection(() => client, stream);

    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
      });
      await connection.authenticate({ methodId: AUTH_METHOD_ID }).catch(() => undefined);

      const resumedId = resumeSessionId(options.resume);
      let sessionId: string;
      if (resumedId !== undefined) {
        await connection.loadSession({ sessionId: resumedId, cwd: options.cwd, mcpServers: [] });
        sessionId = resumedId;
      } else {
        const created = await connection.newSession({ cwd: options.cwd, mcpServers: [] });
        sessionId = created.sessionId;
      }
      if (options.model ?? this.#config.model) {
        await connection
          .setSessionModel({ sessionId, modelId: (options.model ?? this.#config.model) as string })
          .catch(() => undefined);
      }
      const reasoningEffort = cursorReasoningEffort(options.reasoning);
      if (reasoningEffort !== undefined) {
        await connection.extMethod("session/set_config_option", {
          sessionId,
          configId: "reasoning",
          value: reasoningEffort
        });
      }
      session = new CursorSession({
        child,
        connection,
        sessionId,
        approvalPolicy:
          options.approvalPolicy ?? DEFAULT_AUTOMATION_APPROVAL_POLICY,
        reasoning: options.reasoning
      });
      this.#sessions.add(session);
      return session;
    } catch (error) {
      terminate(child);
      throw asHarnessError(error);
    }
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.stop();
    this.#sessions.clear();
  }
}

/** Probe cursor-agent: version via `cursor-agent --version`. */
async function probeCursor(
  config: CursorDriverConfig,
  context: DriverContext | undefined
): Promise<HarnessStatus> {
  const env = buildChildEnv({ base: resolveDriverEnv(context), allow: [/^CURSOR_/] });
  return probeCliVersion({
    kind: "cursor",
    command: config.command,
    cliName: "cursor-agent",
    env,
    // Auth is verified by the ACP handshake at session start; the version
    // probe cannot see login state cheaply.
    auth: { status: "unknown" },
    notInstalledMessage: `Cursor CLI "${config.command}" was not found on PATH.`
  });
}

export function createCursorDriver(): HarnessDriver<CursorDriverConfig> {
  return createCachedHarnessDriver({
    kind: "cursor",
    configSchema: cursorDriverConfigSchema,
    probeConfig: () => cursorDriverConfigSchema.parse({}),
    probeStatus: probeCursor,
    createInstance: (config, context, status) =>
      new CursorInstance(config, context, status)
  });
}
