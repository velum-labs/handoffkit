/**
 * The uniform approval model, regardless of transport: a CLI's approval
 * mechanism (blocked JSON-RPC request, SDK callback, SSE permission event)
 * becomes a canonical pending request holding a deferred; the answer resolves
 * the deferred, which unblocks the original protocol response. Teardown paths
 * settle every pending deferred so nothing can hang forever.
 */
import { randomUUID } from "node:crypto";

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

/** Canonical approval/user-input request categories across all providers. */
export type HarnessRequestType =
  | "exec_command_approval"
  | "file_change_approval"
  | "file_read_approval"
  | "tool_approval"
  | "tool_user_input";

/**
 * What the session auto-approves without surfacing a request. `all` is the
 * headless panel default (the historical `--force --trust` /
 * `bypassPermissions` behavior, now an explicit policy instead of a baked-in
 * flag); `edits` approves workspace writes but surfaces command execution;
 * `none` surfaces everything.
 */
export type ApprovalPolicy = { autoApprove: "all" | "edits" | "none" };

export const PANEL_APPROVAL_POLICY: ApprovalPolicy = { autoApprove: "all" };

/** The policy's verdict for a request type, or undefined to surface it. */
export function decideApproval(
  policy: ApprovalPolicy,
  requestType: HarnessRequestType
): ApprovalDecision | undefined {
  switch (policy.autoApprove) {
    case "all":
      return requestType === "tool_user_input" ? undefined : "accept";
    case "edits":
      return requestType === "file_change_approval" || requestType === "file_read_approval"
        ? "accept"
        : undefined;
    case "none":
      return undefined;
    default: {
      const exhausted: never = policy.autoApprove;
      throw new Error(`unsupported approval policy: ${String(exhausted)}`);
    }
  }
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type PendingRequest = {
  requestId: string;
  requestType: HarnessRequestType;
  detail?: string;
  decision: Promise<ApprovalDecision>;
};

/**
 * Per-session pending approval map. Requests are keyed by a server-generated
 * UUID (never the provider's own id — drivers keep their own correlation map
 * when the provider re-references requests by its ids).
 */
export class PendingRequests {
  readonly #pending = new Map<
    string,
    { request: PendingRequest; deferred: Deferred<ApprovalDecision> }
  >();

  open(input: { requestType: HarnessRequestType; detail?: string }): PendingRequest {
    const requestId = randomUUID();
    const deferred = createDeferred<ApprovalDecision>();
    const request: PendingRequest = {
      requestId,
      requestType: input.requestType,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      decision: deferred.promise
    };
    this.#pending.set(requestId, { request, deferred });
    return request;
  }

  /** Resolve one pending request. Returns false when the id is unknown/settled. */
  resolve(requestId: string, decision: ApprovalDecision): boolean {
    const entry = this.#pending.get(requestId);
    if (entry === undefined) return false;
    this.#pending.delete(requestId);
    entry.deferred.resolve(decision);
    return true;
  }

  /** Settle every pending request (teardown paths call this with "cancel"). */
  settleAll(decision: ApprovalDecision): number {
    let settled = 0;
    for (const [requestId, entry] of this.#pending) {
      this.#pending.delete(requestId);
      entry.deferred.resolve(decision);
      settled += 1;
    }
    return settled;
  }

  get size(): number {
    return this.#pending.size;
  }
}
