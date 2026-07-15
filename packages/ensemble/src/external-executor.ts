import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import {
  assertToolCallPlanV1,
  toolArgumentsHash,
  toolSideEffectClassFromModelFusion
} from "@fusionkit/protocol";
import type {
  ToolCallPlanV1,
  ToolExecutionRecordV1,
  ToolExecutionResult,
  ToolPolicyDecision
} from "@fusionkit/protocol";
import type { JsonValue } from "@routekit/contracts";

import type { ToolExecutor } from "./tool-executor.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const HEALTH_RESPONSE = { ok: true, service: "fusionkit-tool-executor" } as const;

export type FusionKitToolExecutionRequest = {
  candidate_id: string;
  tool_call_id: string;
  plan: ToolCallPlanV1;
  arguments: JsonValue;
  environment_id: string;
  tool_policy_id: string;
};

export type FusionKitToolExecutionBatch = {
  requests: FusionKitToolExecutionRequest[];
};

export type FusionKitToolExecutionResult = {
  candidate_id: string;
  tool_call_id: string;
  record: ToolExecutionRecordV1;
  output?: JsonValue;
  deduped: boolean;
  decision: ToolPolicyDecision;
};

export type FusionKitToolExecutionResponse = {
  results: FusionKitToolExecutionResult[];
};

export type FusionKitToolExecutorServerOptions = {
  executor: ToolExecutor;
  port: number;
  host?: string;
  authToken?: string;
  maxBodyBytes?: number;
};

export type FusionKitToolExecutorServer = {
  server: Server;
  host: string;
  port: number;
  url: string;
};

export class FusionKitToolExecutorError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "FusionKitToolExecutorError";
    this.status = status;
    this.code = code;
  }
}

export class FusionKitToolExecutorClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `tool executor request failed with status ${status}`;
    super(message);
    this.name = "FusionKitToolExecutorClientError";
    this.status = status;
    this.body = body;
  }
}

export class FusionKitToolExecutorClient {
  readonly baseUrl: string;
  private readonly authToken?: string;

  constructor(baseUrl: string, authToken?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authToken = authToken;
  }

  async execute(
    batch: FusionKitToolExecutionBatch
  ): Promise<FusionKitToolExecutionResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    const response = await fetch(`${this.baseUrl}/v1/fusionkit/tool-executions`, {
      method: "POST",
      headers,
      body: JSON.stringify(batch)
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw new FusionKitToolExecutorClientError(response.status, payload);
    }
    return parseFusionKitToolExecutionResponse(payload);
  }
}

export async function executeFusionKitToolBatch(
  executor: ToolExecutor,
  batch: unknown
): Promise<FusionKitToolExecutionResponse> {
  const parsed = parseFusionKitToolExecutionBatch(batch);
  const results: FusionKitToolExecutionResult[] = [];
  for (const request of parsed.requests) {
    validateRequestPolicy(executor, request);
    validatePlanArguments(request);
    const sideEffects = sideEffectsForPlan(request.plan);
    const result: ToolExecutionResult = await executor.execute({
      candidate_id: request.candidate_id,
      plan_id: request.plan.plan_id,
      tool_name: request.plan.tool_name,
      arguments: request.arguments,
      side_effects: sideEffects
    });
    results.push({
      candidate_id: request.candidate_id,
      tool_call_id: request.tool_call_id,
      record: result.record,
      ...(result.output !== undefined ? { output: result.output } : {}),
      deduped: result.deduped,
      decision: result.decision
    });
  }
  return { results };
}

export function startFusionKitToolExecutorServer(
  options: FusionKitToolExecutorServerOptions
): Promise<FusionKitToolExecutorServer> {
  const { executor, port, host = "127.0.0.1" } = options;
  const context = {
    executor,
    authToken: options.authToken,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  };
  const server = createServer((req, res) => {
    handleRequest(context, req, res).catch((error: unknown) => {
      if (error instanceof FusionKitToolExecutorError) {
        sendJson(res, error.status, { error: error.message, code: error.code });
        return;
      }
      sendJson(res, 500, { error: "internal server error", code: "internal_error" });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        url: `http://${host}:${boundPort}`
      });
    });
  });
}

type ServerContext = {
  executor: ToolExecutor;
  authToken?: string;
  maxBodyBytes: number;
};

async function handleRequest(
  context: ServerContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  if (method === "GET" && url.pathname === "/v1/health") {
    sendJson(res, 200, HEALTH_RESPONSE);
    return;
  }
  if (method === "POST" && url.pathname === "/v1/fusionkit/tool-executions") {
    requireAuth(context, req);
    const body = await readJson(req, context.maxBodyBytes);
    const response = await executeFusionKitToolBatch(context.executor, body);
    sendJson(res, 200, response);
    return;
  }
  sendJson(res, 404, { error: "not found", code: "not_found" });
}

function validateRequestPolicy(
  executor: ToolExecutor,
  request: FusionKitToolExecutionRequest
): void {
  if (request.environment_id !== executor.contract.environment_id) {
    throw new FusionKitToolExecutorError(
      403,
      "environment_mismatch",
      "request environment_id does not match executor environment"
    );
  }
  if (request.tool_policy_id !== executor.contract.tool_policy_id) {
    throw new FusionKitToolExecutorError(
      403,
      "policy_mismatch",
      "request tool_policy_id does not match executor policy"
    );
  }
}

function validatePlanArguments(request: FusionKitToolExecutionRequest): void {
  const argumentsHash = toolArgumentsHash(request.arguments);
  if (request.plan.arguments_hash !== argumentsHash) {
    throw new FusionKitToolExecutorError(
      400,
      "arguments_hash_mismatch",
      "tool-call-plan arguments_hash does not match request arguments"
    );
  }
}

function parseFusionKitToolExecutionBatch(value: unknown): FusionKitToolExecutionBatch {
  const object = assertRecord(value, "batch");
  assertKnownKeys(object, ["requests"], "batch");
  if (!Array.isArray(object.requests)) {
    throw invalid("batch.requests must be an array");
  }
  return {
    requests: object.requests.map((request, index) =>
      parseFusionKitToolExecutionRequest(request, `batch.requests[${index}]`)
    )
  };
}

function parseFusionKitToolExecutionRequest(
  value: unknown,
  context: string
): FusionKitToolExecutionRequest {
  const object = assertRecord(value, context);
  assertKnownKeys(
    object,
    ["candidate_id", "tool_call_id", "plan", "arguments", "environment_id", "tool_policy_id"],
    context
  );
  assertString(object.candidate_id, `${context}.candidate_id`);
  assertString(object.tool_call_id, `${context}.tool_call_id`);
  assertString(object.environment_id, `${context}.environment_id`);
  assertString(object.tool_policy_id, `${context}.tool_policy_id`);
  assertJsonValue(object.arguments, `${context}.arguments`);
  try {
    assertToolCallPlanV1(object.plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(`${context}.plan invalid: ${message}`);
  }
  return {
    candidate_id: object.candidate_id,
    tool_call_id: object.tool_call_id,
    plan: object.plan,
    arguments: object.arguments,
    environment_id: object.environment_id,
    tool_policy_id: object.tool_policy_id
  };
}

function parseFusionKitToolExecutionResponse(
  value: unknown
): FusionKitToolExecutionResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FusionKitToolExecutorClientError(500, {
      error: "tool executor response must be an object"
    });
  }
  const object = value as Record<string, unknown>;
  if (!Array.isArray(object.results)) {
    throw new FusionKitToolExecutorClientError(500, {
      error: "tool executor response results must be an array"
    });
  }
  return value as FusionKitToolExecutionResponse;
}

function sideEffectsForPlan(plan: ToolCallPlanV1) {
  try {
    return toolSideEffectClassFromModelFusion(plan.side_effects);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(message);
  }
}

function assertRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  context: string
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw invalid(`${context}.${key} is not supported`);
    }
  }
}

function assertString(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(`${context} must be a non-empty string`);
  }
}

function assertJsonValue(value: unknown, context: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`${context} must be JSON-safe`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${context}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(item, `${context}.${key}`);
    }
    return;
  }
  throw invalid(`${context} must be JSON-safe`);
}

function invalid(message: string): FusionKitToolExecutorError {
  return new FusionKitToolExecutorError(400, "invalid_request", message);
}

function readBody(req: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new FusionKitToolExecutorError(413, "body_too_large", "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const raw = (await readBody(req, maxBodyBytes)).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new FusionKitToolExecutorError(400, "invalid_json", "request body is not valid JSON");
  }
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function requireAuth(context: ServerContext, req: IncomingMessage): void {
  if (context.authToken === undefined) return;
  const header = req.headers.authorization;
  if (header !== `Bearer ${context.authToken}`) {
    throw new FusionKitToolExecutorError(401, "unauthorized", "invalid bearer token");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}
