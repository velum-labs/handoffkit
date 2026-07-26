import {
  CONTROL_BODY_LIMIT_BYTES,
  CONTROL_PROTOCOL_VERSION
} from "@velum-labs/routekit-runtime";
import type {
  ControlFailure,
  ControlRequest,
  ControlResponse,
  ServiceRecord
} from "@velum-labs/routekit-runtime";

import { readDaemonRecord } from "./client.js";

export type ControlRelayEnvelope =
  | { kind: "health" }
  | { kind: "call"; request: ControlRequest };

export type ControlRelayResult = { status: number; body: unknown };

function failure(
  status: number,
  id: string,
  code: ControlFailure["error"]["code"],
  message: string
): ControlRelayResult {
  return {
    status,
    body: {
      protocol: CONTROL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message }
    } satisfies ControlFailure
  };
}

function controlRecord(): ServiceRecord | undefined {
  const record = readDaemonRecord();
  return record?.controlToken === undefined ? undefined : record;
}

export function parseControlRelayEnvelope(value: unknown): ControlRelayEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid control relay request");
  }
  const envelope = value as { kind?: unknown; request?: unknown };
  if (envelope.kind === "health") return { kind: "health" };
  if (
    envelope.kind !== "call" ||
    typeof envelope.request !== "object" ||
    envelope.request === null ||
    Array.isArray(envelope.request)
  ) {
    throw new Error("invalid control relay request");
  }
  const request = envelope.request as Partial<ControlRequest>;
  if (
    request.protocol !== CONTROL_PROTOCOL_VERSION ||
    typeof request.id !== "string" ||
    typeof request.method !== "string"
  ) {
    throw new Error("invalid control relay request");
  }
  return { kind: "call", request: request as ControlRequest };
}

export async function relayLocalControl(
  envelope: ControlRelayEnvelope,
  input: { fetch?: typeof fetch } = {}
): Promise<ControlRelayResult> {
  const record = controlRecord();
  if (record === undefined) {
    return envelope.kind === "health"
      ? {
          status: 503,
          body: {
            error: { code: "unavailable", message: "RouteKit daemon is not running" }
          }
        }
      : failure(503, envelope.request.id, "unavailable", "RouteKit daemon is not running");
  }
  const request = input.fetch ?? fetch;
  const response = await request(
    envelope.kind === "health"
      ? `${record.url}/control/v1/health`
      : `${record.url}/control/v1/call`,
    envelope.kind === "health"
      ? { headers: { authorization: `Bearer ${record.controlToken}` } }
      : {
          method: "POST",
          headers: {
            authorization: `Bearer ${record.controlToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(envelope.request)
        }
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = envelope.kind === "call"
      ? failure(500, envelope.request.id, "internal", "invalid local control response").body
      : { error: { code: "internal", message: "invalid local control response" } };
  }
  return { status: response.status, body: body as ControlResponse | unknown };
}

export async function readControlRelayStdin(): Promise<ControlRelayEnvelope> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    size += chunk.byteLength;
    if (size > CONTROL_BODY_LIMIT_BYTES) {
      throw new Error("control relay request is too large");
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > CONTROL_BODY_LIMIT_BYTES) {
    throw new Error("control relay request is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid control relay JSON");
  }
  return parseControlRelayEnvelope(parsed);
}
