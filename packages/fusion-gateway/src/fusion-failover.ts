import { decodeBufferedSse } from "@velum-labs/routekit-gateway";
import type {
  FailoverCategory,
  ProxyFailure
} from "./fusion-types.js";

export function failoverNotice(modelId: string, failure: ProxyFailure): string {
  const reason = failure.category === "quota_exhausted" ? "is out of credits/quota" : "was rate-limited";
  return `> _${modelId} ${reason}; handed off to the ensemble for this turn._\n\n`;
}

export function resumeNotice(modelId: string, fusedModel: string): string {
  return (
    `\n\n> _${modelId} was rate-limited mid-response, so this turn could not be ` +
    `continued transparently. Re-run on the "${fusedModel}" model to continue on the ensemble._`
  );
}

export function normalizeFailoverCategory(raw: unknown, status: number | undefined): FailoverCategory {
  if (
    raw === "transient" ||
    raw === "quota_exhausted" ||
    raw === "auth_permanent" ||
    raw === "context_overflow" ||
    raw === "unknown"
  ) {
    return raw;
  }
  if (status === 401 || status === 403) return "auth_permanent";
  if (status === 429) return "transient";
  if (status !== undefined && status >= 500) return "transient";
  return "unknown";
}

export function isFailoverWorthy(category: FailoverCategory): boolean {
  switch (category) {
    case "transient":
    case "quota_exhausted":
      return true;
    case "auth_permanent":
    case "context_overflow":
    case "unknown":
      return false;
    default: {
      const unreachable: never = category;
      throw new Error(`unhandled failover category: ${String(unreachable)}`);
    }
  }
}

export function failureFromErrorObject(err: Record<string, unknown>, status: number | undefined): ProxyFailure {
  const raw = err.error_category ?? err.category ?? err.code;
  const failure: ProxyFailure = {
    category: normalizeFailoverCategory(raw, status),
    message: typeof err.message === "string" ? err.message : "vendor error"
  };
  if (status !== undefined) failure.status = status;
  if (typeof err.retry_after === "number") failure.retryAfter = err.retry_after;
  if (typeof err.provider === "string") failure.provider = err.provider;
  return failure;
}

export function sseDataObjects(event: string): Array<Record<string, unknown>> {
  const objects: Array<Record<string, unknown>> = [];
  for (const sseEvent of decodeBufferedSse(event)) {
    if (sseEvent.data.length === 0 || sseEvent.data === "[DONE]") continue;
    let json: unknown;
    try {
      json = JSON.parse(sseEvent.data);
    } catch {
      // Best-effort scan over buffered text: skip a non-JSON payload.
      continue;
    }
    if (json !== null && typeof json === "object") objects.push(json as Record<string, unknown>);
  }
  return objects;
}

/** The failover error carried on a single decoded SSE data object, if any. */
export function sseObjectError(object: Record<string, unknown>): ProxyFailure | undefined {
  const err = object.error;
  if (err !== null && typeof err === "object") {
    return failureFromErrorObject(err as Record<string, unknown>, undefined);
  }
  return undefined;
}

/** Whether a single decoded SSE data object carries a non-empty content delta. */
export function sseObjectHasContent(object: Record<string, unknown>): boolean {
  if (!Array.isArray(object.choices)) return false;
  const delta = (object.choices[0] as { delta?: { content?: unknown } } | undefined)?.delta;
  return delta !== undefined && typeof delta.content === "string" && delta.content.length > 0;
}

export function sseEventError(event: string): ProxyFailure | undefined {
  for (const object of sseDataObjects(event)) {
    const failure = sseObjectError(object);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

function sseEventHasContent(event: string): boolean {
  for (const object of sseDataObjects(event)) {
    if (sseObjectHasContent(object)) return true;
  }
  return false;
}

export function firstSseSignal(text: string): { kind: "content" | "error" | "none"; error?: ProxyFailure } {
  let rest = text;
  for (;;) {
    const idx = rest.indexOf("\n\n");
    if (idx === -1) break;
    const event = rest.slice(0, idx + 2);
    rest = rest.slice(idx + 2);
    const failure = sseEventError(event);
    if (failure !== undefined) return { kind: "error", error: failure };
    if (sseEventHasContent(event)) return { kind: "content" };
  }
  return { kind: "none" };
}

export function rebuildErrorResponse(status: number, contentType: string | null, bodyText: string): Response {
  return new Response(bodyText, {
    status,
    headers: { "content-type": contentType ?? "application/json" }
  });
}
