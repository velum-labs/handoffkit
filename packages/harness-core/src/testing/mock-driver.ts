import { randomUUID } from "node:crypto";

import { z } from "zod";

import { HarnessError } from "../errors.js";
import { PANEL_APPROVAL_POLICY, PendingRequests, decideApproval } from "../approvals.js";
import type { ApprovalDecision } from "../approvals.js";
import type {
  DriverContext,
  HarnessDriver,
  HarnessInstance,
  ResumeCursor,
  SessionHandle,
  SessionTurnInput,
  StartSessionOptions
} from "../contract.js";
import type { HarnessEvent } from "../events.js";
import type { HarnessStatus } from "../status.js";

export const mockDriverConfigSchema = z.object({
  /** Scripted assistant replies, consumed one per turn (last one repeats). */
  replies: z.array(z.string()).default(["mock reply"]),
  /** When set, every `sendTurn` opens one approval of this detail first. */
  approvalDetail: z.string().optional(),
  installed: z.boolean().default(true),
  authenticated: z.boolean().default(true)
});

export type MockDriverConfig = z.infer<typeof mockDriverConfigSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

function statusFor(config: MockDriverConfig): HarnessStatus {
  return {
    kind: "generic",
    installed: config.installed,
    ...(config.installed ? { command: "mock-cli", version: "1.0.0" } : {}),
    auth: { status: config.authenticated ? "authenticated" : "unauthenticated" },
    checkedAt: nowIso()
  };
}

class MockSession implements SessionHandle {
  readonly sessionId: string;
  readonly #config: MockDriverConfig;
  readonly #pending = new PendingRequests();
  readonly #approvalPolicy: StartSessionOptions["approvalPolicy"];
  #turnCount: number;
  #stopped = false;

  constructor(config: MockDriverConfig, options: StartSessionOptions) {
    this.#config = config;
    this.#approvalPolicy = options.approvalPolicy ?? PANEL_APPROVAL_POLICY;
    if (options.resume !== undefined) {
      const data = options.resume.data as { sessionId?: string; turnCount?: number };
      this.sessionId = data.sessionId ?? randomUUID();
      this.#turnCount = data.turnCount ?? 0;
    } else {
      this.sessionId = randomUUID();
      this.#turnCount = 0;
    }
  }

  async *sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent> {
    if (this.#stopped) {
      throw new HarnessError("session_closed", "mock session is stopped");
    }
    const base = { kind: "generic" as const, sessionId: this.sessionId, at: nowIso() };
    const turnId = `turn_${this.#turnCount + 1}`;
    yield { ...base, type: "turn.started", turnId };
    if (input.signal?.aborted === true) {
      yield { ...base, type: "turn.completed", turnId, endReason: "aborted" };
      return;
    }
    if (this.#config.approvalDetail !== undefined) {
      const auto = decideApproval(this.#approvalPolicy ?? PANEL_APPROVAL_POLICY, "exec_command_approval");
      if (auto === undefined) {
        const request = this.#pending.open({
          requestType: "exec_command_approval",
          detail: this.#config.approvalDetail
        });
        yield {
          ...base,
          type: "request.opened",
          turnId,
          requestId: request.requestId,
          requestType: request.requestType,
          ...(request.detail !== undefined ? { detail: request.detail } : {})
        };
        const decision = await Promise.race([
          request.decision,
          abortAsDecision(input.signal)
        ]);
        yield { ...base, type: "request.resolved", turnId, requestId: request.requestId, decision };
        if (decision === "decline" || decision === "cancel") {
          yield { ...base, type: "turn.completed", turnId, endReason: "aborted" };
          return;
        }
      }
    }
    const reply =
      this.#config.replies[Math.min(this.#turnCount, this.#config.replies.length - 1)] ??
      "mock reply";
    this.#turnCount += 1;
    yield { ...base, type: "content.delta", turnId, stream: "assistant_text", text: reply };
    yield { ...base, type: "turn.completed", turnId, endReason: "completed" };
  }

  async respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.#pending.resolve(requestId, decision)) {
      throw new HarnessError("protocol_parse", `unknown pending request ${requestId}`);
    }
  }

  async interrupt(): Promise<void> {
    this.#pending.settleAll("cancel");
  }

  resumeCursor(): ResumeCursor {
    return {
      version: 1,
      kind: "generic",
      data: { sessionId: this.sessionId, turnCount: this.#turnCount }
    };
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pending.settleAll("cancel");
  }
}

class MockInstance implements HarnessInstance {
  readonly kind = "generic" as const;
  readonly #config: MockDriverConfig;
  readonly #sessions = new Set<MockSession>();

  constructor(config: MockDriverConfig) {
    this.#config = config;
  }

  status(): HarnessStatus {
    return statusFor(this.#config);
  }

  async startSession(options: StartSessionOptions): Promise<SessionHandle> {
    if (!this.#config.installed) {
      throw new HarnessError("not_installed", "mock CLI is not installed");
    }
    if (!this.#config.authenticated) {
      throw new HarnessError("not_authenticated", "mock CLI is not logged in");
    }
    const session = new MockSession(this.#config, options);
    this.#sessions.add(session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.#sessions) await session.stop();
    this.#sessions.clear();
  }
}

function abortAsDecision(signal: AbortSignal | undefined): Promise<ApprovalDecision> {
  if (signal === undefined) return new Promise<never>(() => undefined);
  if (signal.aborted) return Promise.resolve("cancel");
  return new Promise<ApprovalDecision>((resolve) =>
    signal.addEventListener("abort", () => resolve("cancel"), { once: true })
  );
}

/**
 * A fully in-memory driver implementing the whole contract: scripted replies,
 * approvals, resume cursors, abort handling. The fixture for registry and
 * consumer tests, and the reference implementation drivers are held against.
 */
export function createMockDriver(): HarnessDriver<MockDriverConfig> {
  return {
    kind: "generic",
    configSchema: mockDriverConfigSchema,
    probe: async (_context?: DriverContext) =>
      statusFor(mockDriverConfigSchema.parse({})),
    createInstance: async (config, _context?: DriverContext) => new MockInstance(config)
  };
}
