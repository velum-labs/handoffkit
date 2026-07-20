import { z } from "zod";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { createOpencodeServer } from "@opencode-ai/sdk/server";

import {
  HarnessError,
  DEFAULT_AUTOMATION_APPROVAL_POLICY,
  asHarnessError,
  buildChildEnv,
  createCachedHarnessDriver,
  probeCliVersion,
  resolveDriverEnv
} from "@routekit/harness-core";
import type {
  ApprovalDecision,
  ApprovalPolicy,
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
} from "@routekit/harness-core";

import { opencodeProviderConfig } from "./launch.js";

const RESUME_CURSOR_VERSION = 1;
const DEFAULT_COMMAND = "opencode";

export const opencodeDriverConfigSchema = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  /** Reuse an already-running opencode server instead of starting one. */
  serverUrl: z.string().optional(),
  /** OpenAI-compatible gateway root used by the routed provider. */
  gatewayUrl: z.string().url(),
  /** Optional bearer token forwarded as the provider API key. */
  authToken: z.string().optional(),
  /** Opaque `providerID/modelID` route the session should run. */
  model: z.string().optional(),
  providerId: z.string().optional()
});

export type OpencodeDriverConfig = z.infer<typeof opencodeDriverConfigSchema>;

/** One buffered opencode turn result, normalized from `session.prompt`. */
export type OpencodeTurnPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; tool: string; callId: string; status: "completed" | "failed" | "running" }
  | {
      type: "step-finish";
      tokens?: { input: number; output: number; reasoning: number };
    };

export type OpencodeTurnResult = {
  parts: OpencodeTurnPart[];
};

/**
 * The narrow opencode surface the driver needs, isolated so the real
 * `@opencode-ai/sdk` server+client wiring stays behind one seam and tests can
 * inject a scripted backend without standing up a server.
 */
export interface OpencodeBackend {
  createSession(input: { cwd: string; resume?: string }): Promise<{ sessionId: string }>;
  prompt(input: {
    sessionId: string;
    cwd: string;
    prompt: string;
    model?: string;
    providerId?: string;
    reasoning?: StartSessionOptions["reasoning"];
    signal?: AbortSignal;
  }): Promise<OpencodeTurnResult>;
  abort(input: { sessionId: string; cwd: string }): Promise<void>;
  dispose(): Promise<void>;
}

export type OpencodeBackendFactory = (
  config: OpencodeDriverConfig,
  context: DriverContext | undefined
) => Promise<OpencodeBackend>;

export type OpencodeDriverOptions = {
  /** Test/extension seam; defaults to the real SDK-backed server+client. */
  backendFactory?: OpencodeBackendFactory;
};

function nowIso(): string {
  return new Date().toISOString();
}

function itemTypeForTool(tool: string): HarnessItemType {
  const lower = tool.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell")) return "command_execution";
  if (lower.includes("edit") || lower.includes("write") || lower.includes("patch")) return "file_change";
  if (lower.includes("web") || lower.includes("fetch")) return "web_search";
  return "dynamic_tool_call";
}

class OpencodeSession implements SessionHandle {
  readonly #kind = "opencode" as const;
  readonly #backend: OpencodeBackend;
  readonly #cwd: string;
  readonly #model: string | undefined;
  readonly #providerId: string | undefined;
  readonly #approvalPolicy: ApprovalPolicy;
  readonly #reasoning: StartSessionOptions["reasoning"];
  #sessionId: string;
  #stopped = false;

  constructor(input: {
    backend: OpencodeBackend;
    sessionId: string;
    cwd: string;
    model?: string;
    providerId?: string;
    approvalPolicy: ApprovalPolicy;
    reasoning?: StartSessionOptions["reasoning"];
  }) {
    this.#backend = input.backend;
    this.#sessionId = input.sessionId;
    this.#cwd = input.cwd;
    this.#model = input.model;
    this.#providerId = input.providerId;
    this.#approvalPolicy = input.approvalPolicy;
    this.#reasoning = input.reasoning;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async *sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent> {
    if (this.#stopped) throw new HarnessError("session_closed", "opencode session is stopped");
    const base = { kind: this.#kind, sessionId: this.#sessionId, at: nowIso() };
    const turnId = `${this.#sessionId}:turn:${Date.now()}`;
    // A function call so TS does not narrow `aborted` to a constant across the
    // await below (the signal can fire mid-turn).
    const isAborted = (): boolean => input.signal?.aborted === true;
    yield { ...base, type: "turn.started", turnId };

    if (isAborted()) {
      yield { ...base, type: "turn.completed", turnId, endReason: "aborted" };
      return;
    }

    let result: OpencodeTurnResult;
    const reasoning = input.reasoning ?? this.#reasoning;
    if (
      reasoning !== undefined &&
      reasoning.mode !== "auto" &&
      reasoning.mode !== "effort"
    ) {
      throw new HarnessError(
        "invalid_config",
        `OpenCode variants cannot represent reasoning mode "${reasoning.mode}"`
      );
    }
    try {
      result = await this.#backend.prompt({
        sessionId: this.#sessionId,
        cwd: this.#cwd,
        prompt: input.prompt,
        ...(this.#model !== undefined ? { model: this.#model } : {}),
        ...(this.#providerId !== undefined ? { providerId: this.#providerId } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {})
      });
    } catch (error) {
      if (isAborted()) {
        yield { ...base, type: "turn.completed", turnId, endReason: "aborted" };
        return;
      }
      const harnessError = asHarnessError(error);
      yield { ...base, type: "turn.failed", turnId, errorCode: harnessError.code, message: harnessError.message };
      return;
    }

    let usage: { inputTokens: number; outputTokens: number; reasoningOutputTokens: number } | undefined;
    for (const part of result.parts) {
      const raw = { source: "opencode.sdk.part", method: part.type };
      switch (part.type) {
        case "text":
          if (part.text.length > 0) {
            yield { ...base, type: "content.delta", turnId, stream: "assistant_text", text: part.text, raw };
          }
          break;
        case "reasoning":
          if (part.text.length > 0) {
            yield { ...base, type: "content.delta", turnId, stream: "reasoning_text", text: part.text, raw };
          }
          break;
        case "tool":
          yield {
            ...base,
            type: "item.completed",
            turnId,
            itemId: part.callId,
            itemType: itemTypeForTool(part.tool),
            status: part.status === "failed" ? "failed" : "completed",
            raw
          };
          break;
        case "step-finish":
          if (part.tokens !== undefined) {
            usage = {
              inputTokens: part.tokens.input,
              outputTokens: part.tokens.output,
              reasoningOutputTokens: part.tokens.reasoning
            };
          }
          break;
        default: {
          const exhausted: never = part;
          throw new Error(`unsupported opencode part: ${String(exhausted)}`);
        }
      }
    }
    yield {
      ...base,
      type: "turn.completed",
      turnId,
      endReason: "completed",
      ...(usage !== undefined ? { usage } : {})
    };
  }

  async respondToRequest(): Promise<void> {
    // Unattended runs use an auto-approve policy applied at session
    // creation, so no interactive permission requests are surfaced.
    throw new HarnessError(
      "protocol_parse",
      "opencode driver does not surface interactive approval requests in buffered mode"
    );
  }

  async interrupt(): Promise<void> {
    await this.#backend.abort({ sessionId: this.#sessionId, cwd: this.#cwd }).catch(() => undefined);
  }

  resumeCursor(): ResumeCursor {
    return { version: RESUME_CURSOR_VERSION, kind: this.#kind, data: { sessionId: this.#sessionId } };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.#backend.abort({ sessionId: this.#sessionId, cwd: this.#cwd }).catch(() => undefined);
  }

  // Kept for symmetry with other drivers; opencode's policy is applied at
  // session creation rather than per request.
  get approvalPolicy(): ApprovalPolicy {
    return this.#approvalPolicy;
  }
}

function resumeSessionId(resume: ResumeCursor | undefined): string | undefined {
  if (resume === undefined || resume.kind !== "opencode") return undefined;
  const data = resume.data as { sessionId?: unknown };
  return typeof data.sessionId === "string" ? data.sessionId : undefined;
}

class OpencodeInstance implements HarnessInstance {
  readonly kind = "opencode" as const;
  readonly #config: OpencodeDriverConfig;
  readonly #context: DriverContext | undefined;
  readonly #status: HarnessStatus;
  readonly #backendFactory: OpencodeBackendFactory;
  #backend: OpencodeBackend | undefined;
  readonly #sessions = new Set<OpencodeSession>();

  constructor(input: {
    config: OpencodeDriverConfig;
    context: DriverContext | undefined;
    status: HarnessStatus;
    backendFactory: OpencodeBackendFactory;
  }) {
    this.#config = input.config;
    this.#context = input.context;
    this.#status = input.status;
    this.#backendFactory = input.backendFactory;
  }

  status(): HarnessStatus {
    return this.#status;
  }

  async #ensureBackend(): Promise<OpencodeBackend> {
    if (this.#backend === undefined) {
      this.#backend = await this.#backendFactory(this.#config, this.#context);
    }
    return this.#backend;
  }

  async startSession(options: StartSessionOptions): Promise<SessionHandle> {
    const backend = await this.#ensureBackend();
    const resume = resumeSessionId(options.resume);
    const created = await backend.createSession({
      cwd: options.cwd,
      ...(resume !== undefined ? { resume } : {})
    });
    const session = new OpencodeSession({
      backend,
      sessionId: created.sessionId,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy ?? DEFAULT_AUTOMATION_APPROVAL_POLICY,
      ...(options.model ?? this.#config.model !== undefined
        ? { model: options.model ?? this.#config.model }
        : {}),
      ...(this.#config.providerId !== undefined
        ? { providerId: this.#config.providerId }
        : {}),
      ...(options.reasoning !== undefined
        ? { reasoning: options.reasoning }
        : {})
    });
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.stop();
    this.#sessions.clear();
    await this.#backend?.dispose().catch(() => undefined);
    this.#backend = undefined;
  }
}

/** The default SDK-backed backend: an in-process opencode server + client. */
const defaultBackendFactory: OpencodeBackendFactory = async (config, context) => {
  let close: (() => void) | undefined;
  let baseUrl = config.serverUrl;
  if (baseUrl === undefined) {
    const server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port: 0,
      config: opencodeProviderConfig({
        gatewayUrl: config.gatewayUrl,
        models: config.model !== undefined ? [{ id: config.model }] : [],
        ...(config.authToken !== undefined ? { auth: { token: config.authToken } } : {})
      })
    });
    baseUrl = server.url;
    close = server.close;
  }
  const client = createOpencodeClient({ baseUrl });

  const partsFrom = (parts: readonly unknown[]): OpencodeTurnPart[] => {
    const out: OpencodeTurnPart[] = [];
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part.type === "text" && typeof part.text === "string") {
        out.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        out.push({ type: "reasoning", text: part.text });
      } else if (part.type === "tool") {
        const state = part.state as { status?: string } | undefined;
        out.push({
          type: "tool",
          tool: String(part.tool ?? "tool"),
          callId: String(part.callID ?? part.id ?? "call"),
          status: state?.status === "error" ? "failed" : state?.status === "completed" ? "completed" : "running"
        });
      } else if (part.type === "step-finish") {
        const tokens = part.tokens as
          | { input: number; output: number; reasoning: number }
          | undefined;
        out.push({ type: "step-finish", ...(tokens !== undefined ? { tokens } : {}) });
      }
    }
    return out;
  };

  return {
    createSession: async ({ cwd, resume }) => {
      if (resume !== undefined) return { sessionId: resume };
      const created = await client.session.create({ query: { directory: cwd }, body: {} });
      const data = created.data as { id?: string } | undefined;
      if (data?.id === undefined) throw new HarnessError("provider_error", "opencode session.create returned no id");
      return { sessionId: data.id };
    },
    prompt: async ({
      sessionId,
      cwd,
      prompt,
      model,
      providerId,
      reasoning,
      signal
    }) => {
      const modelBody =
        model !== undefined && providerId !== undefined
          ? { model: { providerID: providerId, modelID: model } }
          : {};
      const response = await client.session.prompt({
        path: { id: sessionId },
        query: { directory: cwd },
        body: {
          parts: [{ type: "text", text: prompt }],
          ...modelBody,
          ...(reasoning?.mode === "effort"
            ? { variant: reasoning.effort }
            : {})
        },
        ...(signal !== undefined ? { signal } : {})
      });
      const data = response.data as { parts?: unknown[] } | undefined;
      return { parts: partsFrom(data?.parts ?? []) };
    },
    abort: async ({ sessionId, cwd }) => {
      await client.session.abort({ path: { id: sessionId }, query: { directory: cwd } });
    },
    dispose: async () => {
      close?.();
    }
  };
};

/** Probe the opencode CLI: version + semver floor. */
async function probeOpencode(
  config: OpencodeDriverConfig,
  context: DriverContext | undefined
): Promise<HarnessStatus> {
  const env = buildChildEnv({ base: resolveDriverEnv(context) });
  return probeCliVersion({
    kind: "opencode",
    command: config.command,
    cliName: "opencode",
    env,
    // Auth is per-provider inside opencode; the server inventory reports it.
    auth: { status: "unknown" },
    notInstalledMessage: `opencode CLI "${config.command}" was not found on PATH.`
  });
}

export function createOpencodeDriver(
  options: OpencodeDriverOptions = {}
): HarnessDriver<OpencodeDriverConfig> {
  const backendFactory = options.backendFactory ?? defaultBackendFactory;
  return createCachedHarnessDriver({
    kind: "opencode",
    configSchema: opencodeDriverConfigSchema,
    probeConfig: () =>
      opencodeDriverConfigSchema.parse({ gatewayUrl: "http://127.0.0.1" }),
    probeStatus: probeOpencode,
    createInstance: (config, context, status) =>
      new OpencodeInstance({ config, context, status, backendFactory })
  });
}
