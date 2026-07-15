/**
 * Unified front-door acceptance suite — the definition of "correct and done".
 *
 * Runs the same prompt/sentinel through every configured front door and
 * produces one stable report with explicit `passed` / `failed` /
 * `skipped_with_reason` / `blocked` outcomes. The HTTP front doors (Codex
 * Responses, Claude Messages, OpenAI Chat for Cursorkit) are probed against a
 * running Fusion Harness Gateway. The generic ACP front door is exercised
 * in-process through an injected ACP runner. Cursor ACP and the registry-backed
 * Codex/Claude ACP adapters are supplied as injected outcome producers so the
 * CLI can wire real adapters while tests inject deterministic fakes.
 */

import { PassThrough } from "node:stream";

import { trimTrailingSlashes } from "@routekit/runtime";

import { runAcpAgent } from "./acp-agent.js";
import type { AcpRunner } from "./acp-agent.js";
import { FUSION_EVIDENCE_HEADER, FUSION_RUN_ID_HEADER } from "./fusion-gateway.js";

export type FrontDoorStatus = "passed" | "failed" | "skipped_with_reason" | "blocked";

export type FrontDoorOutcome = {
  id: string;
  status: FrontDoorStatus;
  request_path?: string;
  gateway_run_id?: string;
  reason?: string;
  evidence: string[];
};

export type FrontDoorAcceptanceReport = {
  sentinel: string;
  generated_at: string;
  front_doors: FrontDoorOutcome[];
};

export type FrontDoorOutcomeProducer = () => Promise<FrontDoorOutcome>;

export type FrontDoorAcceptanceOptions = {
  gatewayUrl: string;
  sentinel: string;
  /** In-process ACP runner for the generic ACP front door. */
  acpRunner?: AcpRunner;
  /** Cursor ACP outcome via Cursorkit; absent means the dependency is missing. */
  cursorAcp?: FrontDoorOutcomeProducer;
  /** Registry-backed Codex ACP adapter outcome. */
  codexAcp?: FrontDoorOutcomeProducer;
  /** Registry-backed Claude Agent ACP adapter outcome. */
  claudeAcp?: FrontDoorOutcomeProducer;
};

function normalizeGatewayUrl(value: string): string {
  return trimTrailingSlashes(value);
}

function v1Url(gatewayUrl: string, path: string): string {
  const normalized = normalizeGatewayUrl(gatewayUrl);
  const base = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  return `${base}${path}`;
}

function parseEvidenceHeader(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
  return [];
}

function textFromResponses(body: unknown): string {
  const output = (body as { output?: Array<{ content?: Array<{ text?: string }> }> }).output;
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => item.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function textFromAnthropic(body: unknown): string {
  const content = (body as { content?: Array<{ text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
}

function textFromChat(body: unknown): string {
  const choices = (body as { choices?: Array<{ message?: { content?: string } }> }).choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

async function probeHttpFrontDoor(input: {
  id: string;
  url: string;
  requestPath: string;
  body: unknown;
  headers?: Record<string, string>;
  extractText: (body: unknown) => string;
  sentinel: string;
}): Promise<FrontDoorOutcome> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(input.headers ?? {}) },
      body: JSON.stringify(input.body)
    });
  } catch (error) {
    return {
      id: input.id,
      status: "blocked",
      request_path: input.requestPath,
      reason: error instanceof Error ? error.message : String(error),
      evidence: []
    };
  }
  if (!response.ok) {
    return {
      id: input.id,
      status: "failed",
      request_path: input.requestPath,
      reason: `gateway returned ${response.status}`,
      evidence: []
    };
  }
  const runId = response.headers.get(FUSION_RUN_ID_HEADER) ?? undefined;
  const evidence = parseEvidenceHeader(response.headers.get(FUSION_EVIDENCE_HEADER));
  const text = input.extractText((await response.json()) as unknown);
  const matched = text.includes(input.sentinel);
  return {
    id: input.id,
    status: matched ? "passed" : "failed",
    request_path: input.requestPath,
    ...(runId !== undefined ? { gateway_run_id: runId } : {}),
    ...(matched ? {} : { reason: "sentinel not found in final output" }),
    evidence: matched ? ["sentinel", ...evidence] : evidence
  };
}

async function probeGenericAcp(acpRunner: AcpRunner, sentinel: string): Promise<FrontDoorOutcome> {
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });

  const done = runAcpAgent({ runner: acpRunner, input, output });

  const write = (message: unknown): void => {
    input.write(`${JSON.stringify(message)}\n`);
  };
  write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  write({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: process.cwd(), mcpServers: [] } });
  write({
    jsonrpc: "2.0",
    id: 3,
    method: "session/prompt",
    params: { sessionId: "sess_1", prompt: [{ type: "text", text: "front-door acceptance" }] }
  });
  input.end();
  await done;

  const updates = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; result?: unknown; params?: unknown });
  const updateText = updates
    .filter((message) => message.method === "session/update")
    .map((message) => {
      const params = message.params as
        | { update?: { content?: { text?: string } } }
        | undefined;
      return params?.update?.content?.text ?? "";
    })
    .join("");
  const promptResult = updates.find(
    (message) => message.result !== undefined && typeof message.result === "object"
  )?.result as { _meta?: { runId?: string; evidence?: string[] } } | undefined;
  const matched = updateText.includes(sentinel);
  const evidence = promptResult?._meta?.evidence ?? [];
  return {
    id: "generic-acp",
    status: matched ? "passed" : "failed",
    request_path: "session/prompt",
    ...(promptResult?._meta?.runId !== undefined ? { gateway_run_id: promptResult._meta.runId } : {}),
    ...(matched ? {} : { reason: "sentinel not found in session/update" }),
    evidence: matched ? ["sentinel", ...evidence] : evidence
  };
}

export async function runFrontDoorAcceptance(
  options: FrontDoorAcceptanceOptions
): Promise<FrontDoorAcceptanceReport> {
  const frontDoors: FrontDoorOutcome[] = [];

  frontDoors.push(
    await probeHttpFrontDoor({
      id: "codex-responses",
      url: v1Url(options.gatewayUrl, "/responses"),
      requestPath: "/v1/responses",
      body: {
        model: "fusion-panel",
        input: [{ role: "user", content: [{ type: "input_text", text: "front-door acceptance" }] }]
      },
      extractText: textFromResponses,
      sentinel: options.sentinel
    })
  );

  frontDoors.push(
    await probeHttpFrontDoor({
      id: "claude-messages",
      url: v1Url(options.gatewayUrl, "/messages"),
      requestPath: "/v1/messages",
      headers: { "anthropic-version": "2023-06-01" },
      body: {
        model: "fusion-panel",
        max_tokens: 512,
        messages: [{ role: "user", content: "front-door acceptance" }]
      },
      extractText: textFromAnthropic,
      sentinel: options.sentinel
    })
  );

  frontDoors.push(
    await probeHttpFrontDoor({
      id: "openai-chat",
      url: v1Url(options.gatewayUrl, "/chat/completions"),
      requestPath: "/v1/chat/completions",
      body: {
        model: "fusion-panel",
        messages: [{ role: "user", content: "front-door acceptance" }]
      },
      extractText: textFromChat,
      sentinel: options.sentinel
    })
  );

  if (options.acpRunner !== undefined) {
    frontDoors.push(await probeGenericAcp(options.acpRunner, options.sentinel));
  } else {
    frontDoors.push({
      id: "generic-acp",
      status: "blocked",
      request_path: "session/prompt",
      reason: "acp_runner_not_configured",
      evidence: []
    });
  }

  frontDoors.push(
    options.codexAcp !== undefined
      ? await options.codexAcp()
      : {
          id: "codex-acp",
          status: "blocked",
          reason: "codex_acp_adapter_not_installed",
          evidence: []
        }
  );

  frontDoors.push(
    options.claudeAcp !== undefined
      ? await options.claudeAcp()
      : {
          id: "claude-acp",
          status: "blocked",
          reason: "claude_acp_adapter_not_installed",
          evidence: []
        }
  );

  frontDoors.push(
    options.cursorAcp !== undefined
      ? await options.cursorAcp()
      : {
          id: "cursor-acp",
          status: "blocked",
          reason: "cursorkit_backend_not_running",
          evidence: []
        }
  );

  return {
    sentinel: options.sentinel,
    generated_at: new Date().toISOString(),
    front_doors: frontDoors
  };
}
