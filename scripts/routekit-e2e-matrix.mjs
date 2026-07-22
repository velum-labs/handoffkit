#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultSubscriptionAccountDirectory,
  subscriptionProvider,
  SubscriptionAccountSet
} from "../packages/accounts/dist/index.js";
import {
  AnthropicBackend,
  CatalogBackend,
  CodexResponsesBackend,
  OpenAiBackend,
  startGateway
} from "../packages/model-gateway/dist/index.js";
import {
  DOOR_PROFILES,
  doorFrames,
  startProviderSim
} from "../packages/testkit/dist/index.js";
import {
  classifyFailure,
  makeRouteResult,
  qualificationCompleteness,
  reserveRouteBudget,
  ROUTE_CASES,
  selectedRoutes
} from "./routekit-qualification.mjs";
import {
  caseIdFor,
  loadEvidenceMap,
  mappingDigest,
  routeIdsForCase
} from "./lib/routekit-l06-evidence.mjs";
import { processAlive } from "../packages/runtime-utils/dist/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTEKIT_ENTRY = join(ROOT, "packages", "routekit-cli", "dist", "index.js");
const ROUTEKIT_VERSION = JSON.parse(
  readFileSync(join(ROOT, "packages", "routekit-cli", "package.json"), "utf8")
).version;
const EVIDENCE_MAP = loadEvidenceMap(ROOT);
const API_DOORS = DOOR_PROFILES.filter((door) =>
  ["openai-chat", "anthropic-messages", "codex-responses"].includes(door.id)
);
const CLI_DOORS = [
  { id: "claude", binary: "claude" },
  { id: "codex", binary: "codex" },
  { id: "cursor", binary: "cursor-agent" },
  { id: "opencode", binary: "opencode" }
];
const PROVIDERS = [...new Set(ROUTE_CASES.map((route) => route.provider))];
const ACTIVE_LIVE_CHILDREN = new Set();
const MODEL_CALL_PATHS = new Set([
  "/v1/chat/completions",
  "/chat/completions",
  "/v1/messages",
  "/v1/responses",
  "/backend-api/codex/responses",
  "/v1/cursor/chat/completions"
]);

function parseArgs(argv) {
  const options = {
    live: process.env.ROUTEKIT_LIVE_E2E === "1",
    providers: undefined,
    doors: undefined,
    timeoutMs: Number(process.env.ROUTEKIT_E2E_TIMEOUT_MS ?? 120_000),
    maxLiveCalls: Number(process.env.ROUTEKIT_E2E_MAX_LIVE_CALLS ?? 48),
    models: {},
    routes: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--") continue;
    if (arg === "--live") options.live = true;
    else if (arg === "--route") options.routes = csv(value());
    else if (arg === "--provider") options.providers = csv(value());
    else if (arg === "--door") options.doors = csv(value());
    else if (arg === "--timeout-ms") options.timeoutMs = positiveInteger(value(), arg);
    else if (arg === "--max-live-calls") options.maxLiveCalls = positiveInteger(value(), arg);
    else if (arg === "--model") {
      const assignment = value();
      const separator = assignment.indexOf("=");
      if (separator < 1) throw new Error("--model must be provider=namespaced/model");
      options.models[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: pnpm test:e2e:matrix -- [options]",
          "",
          "  --live                    run live cases (also ROUTEKIT_LIVE_E2E=1)",
          "  --route <ids>             comma-separated L05 route-anchor filter",
          "  --provider <ids>          comma-separated provider filter",
          "  --door <ids>              API/CLI door filter",
          "  --model <provider=id>     override one live namespaced model",
          "  --timeout-ms <ms>         per-PTY timeout",
          "  --max-live-calls <count>  hard client-to-gateway request budget",
          ""
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.providers === undefined && process.env.ROUTEKIT_E2E_PROVIDER !== undefined) {
    options.providers = csv(process.env.ROUTEKIT_E2E_PROVIDER);
  }
  if (options.doors === undefined && process.env.ROUTEKIT_E2E_DOOR !== undefined) {
    options.doors = csv(process.env.ROUTEKIT_E2E_DOOR);
  }
  if (options.routes !== undefined) {
    if (options.providers !== undefined || options.doors !== undefined) {
      throw new Error("--route cannot be combined with --provider or --door");
    }
    const routes = selectedRoutes(options.routes);
    options.providers = [...new Set(routes.map((route) => route.provider))];
    options.doors = [
      ...new Set(
        routes.flatMap((route) => {
          if (route.manual === true) return ["openai-chat"];
          return [
            route.door,
            ...(route.additionalDoors ?? []),
            ...(route.door === "cursor" ? ["openai-chat"] : [])
          ];
        })
      )
    ];
  }
  for (const provider of options.providers ?? []) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`unknown provider filter "${provider}"`);
    }
  }
  const knownDoors = new Set([
    ...API_DOORS.map((door) => door.id),
    ...CLI_DOORS.map((door) => door.id),
    "pool"
  ]);
  for (const door of options.doors ?? []) {
    if (!knownDoors.has(door)) throw new Error(`unknown door filter "${door}"`);
  }
  return options;
}

function qualificationRoutes(options) {
  return selectedRoutes(options.routes);
}

function caseSelected(provider, door, options) {
  if (options.routes === undefined) {
    return selected(provider, options.providers) && selected(door, options.doors);
  }
  return qualificationRoutes(options).some(
    (route) =>
      route.manual !== true &&
      route.provider === provider &&
      (route.door === door || (route.additionalDoors ?? []).includes(door))
  );
}

function routeIdForCase(provider, door, options) {
  if (options.routes === undefined) return undefined;
  return qualificationRoutes(options).find(
    (route) =>
      route.manual !== true &&
      route.provider === provider &&
      (route.door === door || (route.additionalDoors ?? []).includes(door))
  )?.routeId;
}

function csv(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function selected(value, filter) {
  return filter === undefined || filter.includes(value);
}

function timestamp() {
  return `${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}-${process.pid}`;
}

function sanitize(raw) {
  let value = raw;
  for (const [name, secret] of Object.entries(process.env)) {
    if (
      secret !== undefined &&
      secret.length >= 8 &&
      /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)
    ) {
      value = value.replaceAll(secret, "[REDACTED]");
    }
  }
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001bP.*?\u001b\\/gs, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replaceAll(process.env.HOME ?? "\0", "~")
    .replace(
      /("(?:authorization|proxy-authorization|x-api-key|api[_-]?key|apiKey|token|accessToken|refreshToken|secret|password)"\s*:\s*")([^"]*)(")/gi,
      "$1[REDACTED]$3"
    )
    .replace(/(authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [REDACTED]");
}

function commandAvailable(binary) {
  const result = spawnSync(binary, [binary === "tmux" ? "-V" : "--version"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "ignore", "ignore"]
  });
  return result.error === undefined && result.status === 0;
}

function writeRouterConfig(path, defaultModel) {
  writeFileSync(
    path,
    [
      "providers:",
      ...PROVIDERS.map((provider) => `  ${provider}: {}`),
      `defaultModel: ${defaultModel}`,
      ""
    ].join("\n")
  );
}

function sourceFor(simUrl, provider, nativeModels) {
  const nativeModel = nativeModels[0];
  const options = {
    baseUrl: provider === "codex" ? simUrl : `${simUrl}/v1`,
    apiKey: "simulated",
    defaultModel: nativeModel
  };
  const backend =
    provider === "codex"
      ? new CodexResponsesBackend(options)
      : provider === "claude-code" || provider === "anthropic"
        ? new AnthropicBackend(options)
        : new OpenAiBackend(options);
  return {
    sourceId: provider,
    discoverModels: async () =>
      nativeModels.map((model) => ({
        id: model,
        capabilities: {
          streaming: "supported",
          tools: "supported",
          images: "unsupported",
          reasoning_controls: "supported"
        }
      })),
    chat: async (body, signal, optionsForCall) =>
      await backend.chat(body, signal, optionsForCall),
    embeddings: async (body, signal) => await backend.embeddings(body, signal),
    close: async () => await backend.close?.()
  };
}

async function startCountingProxy(targetUrl, options = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", targetUrl);
      if (request.method === "POST" && MODEL_CALL_PATHS.has(url.pathname)) {
        if (
          options.maxCalls !== undefined &&
          calls.length >= options.maxCalls
        ) {
          response.statusCode = 429;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              error: {
                type: "routekit_e2e_budget_exhausted",
                message: `live E2E call budget ${options.maxCalls} exhausted`
              }
            })
          );
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          parsed = undefined;
        }
        const serialized = parsed === undefined ? "" : JSON.stringify(parsed);
        calls.push({
          at: new Date().toISOString(),
          method: request.method,
          path: url.pathname,
          model:
            parsed !== null &&
            typeof parsed === "object" &&
            typeof parsed.model === "string"
              ? parsed.model
              : undefined,
          tools:
            parsed !== null &&
            typeof parsed === "object" &&
            Array.isArray(parsed.tools)
              ? parsed.tools.flatMap((tool) => {
                  if (tool === null || typeof tool !== "object") return [];
                  if (typeof tool.name === "string") return [tool.name];
                  return tool.function !== null &&
                    typeof tool.function === "object" &&
                    typeof tool.function.name === "string"
                    ? [tool.function.name]
                    : [];
                })
              : [],
          hasToolResult:
            serialized.includes('"type":"tool_result"') ||
            serialized.includes('"type":"function_call_output"') ||
            serialized.includes('"role":"tool"')
        });
      }
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      if (options.upstreamAuthorization !== undefined) {
        headers.authorization = options.upstreamAuthorization;
      }
      const upstream = await fetch(url, {
        method: request.method,
        headers,
        ...(body.length > 0 ? { body } : {})
      });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!["content-encoding", "content-length", "transfer-encoding"].includes(name)) {
          response.setHeader(name, value);
        }
      }
      if (upstream.body === null) {
        response.end();
        return;
      }
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
      }
      response.end();
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.statusCode = 502;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: {
            type: "matrix_proxy_error",
            message: error instanceof Error ? error.message : String(error)
          }
        })
      );
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: async () =>
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) =>
          error === undefined ? resolveClose() : rejectClose(error)
        )
      )
  };
}

async function startDeterministicStack(tempRoot) {
  const nativeModels = {
    openai: "matrix-openai",
    anthropic: "matrix-anthropic",
    openrouter: "matrix-openrouter",
    codex: "matrix-codex",
    "claude-code": "claude-matrix"
  };
  const defaultNativeModel = nativeModels.codex;
  const defaultPublicModel = `codex/${defaultNativeModel}`;
  const publicModels = Object.fromEntries(
    Object.entries(nativeModels).map(([provider, model]) => [
      provider,
      `${provider}/${model}`
    ])
  );
  const simulator = await startProviderSim();
  const backend = await CatalogBackend.create({
    config: {
      providers: {
        openai: {},
        anthropic: {},
        openrouter: {},
        codex: {},
        "claude-code": {}
      },
      defaultModel: defaultPublicModel,
      reasoningCapabilities: {
        [publicModels.openrouter]: {
          efforts: [{ id: "quick", aliases: ["high"] }, { id: "deep" }],
          defaultEffort: "quick",
          wireShape: "openrouter"
        },
        [publicModels.openai]: {
          efforts: [{ id: "quick", aliases: ["high"] }, { id: "deep" }],
          defaultEffort: "quick",
          wireShape: "openai"
        },
        [publicModels.anthropic]: {
          efforts: [{ id: "quick" }, { id: "deep" }],
          defaultEffort: "quick",
          wireShape: "anthropic"
        },
        [publicModels.codex]: {
          efforts: [{ id: "quick", aliases: ["high"] }, { id: "deep" }],
          defaultEffort: "quick",
          wireShape: "openai-responses"
        },
        [defaultPublicModel]: {
          efforts: [{ id: "quick", aliases: ["high"] }, { id: "deep" }],
          defaultEffort: "quick",
          wireShape: "openai-responses"
        },
        [publicModels["claude-code"]]: {
          efforts: [{ id: "quick" }, { id: "deep" }, { id: "high" }],
          defaultEffort: "quick",
          wireShape: "anthropic"
        }
      }
    },
    sources: Object.fromEntries(
      Object.entries(nativeModels).map(([provider, model]) => [
        provider,
        sourceFor(
          simulator.url,
          provider,
          provider === "codex"
            ? [...new Set([model, defaultNativeModel])]
            : [model]
        )
      ])
    )
  });
  const gateway = await startGateway({ backend });
  const proxy = await startCountingProxy(gateway.url());
  const configPath = join(tempRoot, "deterministic-router.yaml");
  writeRouterConfig(configPath, defaultPublicModel);
  return {
    simulator,
    gateway,
    proxy,
    configPath,
    nativeModels,
    publicModels,
    close: async () => {
      await proxy.close();
      await gateway.close();
      await simulator.close();
    }
  };
}

function liveRequestBody(door, model, prompt, stream) {
  const body = door.buildRequest({ model, user: prompt, stream });
  if (door.id === "openai-chat") body.max_completion_tokens = 64;
  else if (door.id === "anthropic-messages") body.max_tokens = 16;
  else if (door.id === "codex-responses") body.max_output_tokens = 16;
  return body;
}

async function callApiDoor(gatewayUrl, door, model, prompt, stream = false) {
  const response = await fetch(`${gatewayUrl}${door.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(door.headers ?? {}) },
    body: JSON.stringify(liveRequestBody(door, model, prompt, stream))
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${door.id} returned ${response.status}: ${sanitize(text)}`);
  }
  if (stream) {
    const parsed = await doorFrames(new Response(text));
    assert.ok(door.streamClosed(parsed.frames), `${door.id} stream did not close`);
    return door.streamTextOf(parsed.frames);
  }
  const body = JSON.parse(text);
  return door.textOf(body);
}

async function verifyFailureNoFallback(stack, provider, door) {
  await stack.simulator.reset();
  await stack.simulator.queue(stack.nativeModels[provider], [
    {
      error: {
        status: 500,
        code: "internal_error",
        error_type: "api_error",
        message: "simulated provider error"
      }
    }
  ]);
  await assert.rejects(
    callApiDoor(
      stack.proxy.url,
      door,
      stack.publicModels[provider],
      "Deterministic failure propagation probe."
    ),
    /returned 5\d\d/
  );
  const selectedCalls = await stack.simulator.calls({
    model: stack.nativeModels[provider]
  });
  assert.equal(selectedCalls.length, 1, await stack.simulator.describeJournal());
  for (const [otherProvider, nativeModel] of Object.entries(stack.nativeModels)) {
    if (otherProvider === provider) continue;
    const calls = await stack.simulator.calls({ model: nativeModel });
    assert.equal(
      calls.length,
      0,
      `failure on ${provider} unexpectedly reached ${otherProvider}`
    );
  }
}

async function verifyToolsAndReasoning(stack, provider, door) {
  await stack.simulator.reset();
  await stack.simulator.queue(stack.nativeModels[provider], [
    {
      tool_calls: [
        {
          id: "matrix-tool-call",
          name: "read_file",
          arguments: '{"path":"qualification.txt"}'
        }
      ],
      reasoning: "deterministic qualification reasoning"
    },
    {
      reply: "CAPABILITY_OK",
      reasoning: "deterministic qualification reasoning"
    }
  ]);
  const toolResponse = await fetch(`${stack.proxy.url}${door.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(door.headers ?? {}) },
    body: JSON.stringify(
      door.buildRequest({
        model: stack.publicModels[provider],
        user: "Deterministic tool capability probe.",
        withTools: true
      })
    )
  });
  assert.equal(toolResponse.status, 200);
  const toolCall = door.toolCallOf(await toolResponse.json());
  assert.equal(toolCall?.name, "read_file");

  const reasoningResponse = await fetch(`${stack.proxy.url}${door.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(door.headers ?? {}) },
    body: JSON.stringify(
      door.buildRequest({
        model: stack.publicModels[provider],
        user: "Deterministic reasoning capability probe.",
        stream: true
      })
    )
  });
  assert.equal(reasoningResponse.status, 200);
  const parsed = await doorFrames(reasoningResponse);
  assert.ok(door.streamClosed(parsed.frames), `${door.id} capability stream did not close`);
  assert.match(door.streamTextOf(parsed.frames), /CAPABILITY_OK/);
  assert.ok(
    door.streamReasoningOf(parsed.frames).length > 0,
    `${door.id} omitted deterministic reasoning`
  );
}

async function verifyCancellationPropagation() {
  let cancelled = false;
  let upstreamController;
  const backend = {
    defaultModel: "matrix-cancellation",
    chat: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            upstreamController = controller;
            controller.enqueue(
              Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
            );
          },
          cancel() {
            cancelled = true;
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      ),
    models: async () =>
      Response.json({ object: "list", data: [{ id: "matrix-cancellation" }] }),
    embeddings: async () => Response.json({ data: [] })
  };
  const gateway = await startGateway({ backend });
  const aborter = new AbortController();
  try {
    const response = await fetch(`${gateway.url()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "matrix-cancellation",
        stream: true,
        messages: [{ role: "user", content: "cancellation probe" }]
      }),
      signal: aborter.signal
    });
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    await reader.read();
    aborter.abort();
    const deadline = Date.now() + 1_000;
    while (!cancelled && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (!cancelled) upstreamController?.close();
    assert.equal(cancelled, true, "client disconnect did not cancel the upstream body");
  } finally {
    try {
      upstreamController?.close();
    } catch {
      // The stream was already cancelled.
    }
    await gateway.close();
  }
}

async function nativePickerAliases(gatewayUrl, nativeModels, publicModels) {
  let claudeIds = [];
  if (publicModels["claude-code"] !== undefined) {
    const claudeResponse = await fetch(`${gatewayUrl}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01" }
    });
    assert.equal(claudeResponse.status, 200);
    const claudePayload = await claudeResponse.json();
    claudeIds = claudePayload.data.map((model) => model.id);
    assert.ok(claudeIds.includes(nativeModels["claude-code"]));
    assert.ok(!claudeIds.includes(publicModels["claude-code"]));
  }

  let codexIds = [];
  if (publicModels.codex !== undefined) {
    const codexResponse = await fetch(`${gatewayUrl}/v1/models`);
    assert.equal(codexResponse.status, 200);
    const codexPayload = await codexResponse.json();
    codexIds = codexPayload.models.map((model) => model.slug);
    assert.ok(codexIds.includes(nativeModels.codex));
    assert.ok(!codexIds.includes(publicModels.codex));
    assert.ok(
      codexPayload.data.every((model) => model.id.includes("/")),
      "the global OpenAI catalog remains strictly namespaced"
    );
  }
  return { claude: claudeIds, codex: codexIds };
}

async function verifyLosslessAnthropicThinking(stack) {
  const behavior = {
    reply: "THINKING_OK",
    reasoning: "native matrix thought",
    reasoning_signature: "sig-matrix",
    redacted_thinking: "opaque-matrix",
    chunk_bytes: 2
  };
  await stack.simulator.reset();
  await stack.simulator.queue(stack.nativeModels["claude-code"], [
    behavior,
    behavior
  ]);
  const request = {
    model: stack.publicModels["claude-code"],
    max_tokens: 4096,
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: "first" },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "prior matrix thought",
            signature: "sig-prior-matrix"
          },
          { type: "redacted_thinking", data: "opaque-prior-matrix" },
          {
            type: "tool_use",
            id: "tool_matrix",
            name: "read_file",
            input: { path: "README.md" }
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_matrix",
            content: "source"
          }
        ]
      }
    ],
    tools: [
      {
        name: "read_file",
        input_schema: { type: "object", properties: { path: { type: "string" } } }
      }
    ]
  };
  const buffered = await fetch(`${stack.proxy.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(request)
  });
  assert.equal(buffered.status, 200);
  const payload = await buffered.json();
  assert.deepEqual(
    payload.content.map((block) => block.type),
    ["thinking", "redacted_thinking", "text"]
  );
  assert.equal(payload.content[0].signature, "sig-matrix");
  assert.equal(payload.content[1].data, "opaque-matrix");

  const streamed = await fetch(`${stack.proxy.url}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({ ...request, stream: true })
  });
  assert.equal(streamed.status, 200);
  const parsed = await doorFrames(streamed);
  assert.ok(
    parsed.frames.some(
      (frame) => {
        const data =
          typeof frame.data === "object" && frame.data !== null
            ? frame.data
            : {};
        return (
          data.type === "content_block_delta" &&
          data.delta?.type === "signature_delta" &&
          data.delta.signature === "sig-matrix"
        );
      }
    )
  );
  assert.ok(
    parsed.frames.some(
      (frame) => {
        const data =
          typeof frame.data === "object" && frame.data !== null
            ? frame.data
            : {};
        return (
          data.type === "content_block_start" &&
          data.content_block?.type === "redacted_thinking" &&
          data.content_block.data === "opaque-matrix"
        );
      }
    )
  );
  const calls = await stack.simulator.calls({
    model: stack.nativeModels["claude-code"]
  });
  assert.equal(calls.length, 2, await stack.simulator.describeJournal());
  for (const call of calls) {
    assert.deepEqual(call.request.thinking, {
      type: "adaptive",
      display: "omitted"
    });
    assert.deepEqual(call.request.output_config, { effort: "high" });
    assert.equal(
      call.request.messages[1].content[0].signature,
      "sig-prior-matrix"
    );
  }
}

async function verifyDynamicReasoningCapabilities(stack) {
  const model = stack.publicModels.openrouter;
  const catalogResponse = await fetch(`${stack.gateway.url()}/v1/models`);
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  const discovered = catalog.data?.find((entry) => entry.id === model);
  assert.deepEqual(
    discovered?.reasoning?.efforts?.map((effort) => effort.id),
    ["quick", "deep"]
  );
  assert.equal(discovered?.reasoning?.provenance, "config");

  const accepted = await fetch(`${stack.gateway.url()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "dynamic effort matrix" }],
      reasoning_effort: "deep"
    })
  });
  assert.equal(accepted.status, 200);

  const rejected = await fetch(`${stack.gateway.url()}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "unsupported effort matrix" }],
      reasoning_effort: "maximum"
    })
  });
  assert.equal(rejected.status, 400);
}

function tmux(...args) {
  return spawnSync("tmux", args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TERM: "xterm-256color"
    }
  });
}

function cleanupMatrixTmuxSessions() {
  for (const session of tmux("list-sessions", "-F", "#{session_name}").stdout
    .split("\n")
    .filter((name) => name.startsWith(`routekit-e2e-${process.pid}-`))) {
    tmux("kill-session", "-t", session);
  }
}

function capturePane(session) {
  const alternate = tmux("capture-pane", "-p", "-e", "-a", "-t", session);
  if (alternate.status === 0 && alternate.stdout.trim().length > 0) {
    return sanitize(alternate.stdout);
  }
  const history = tmux("capture-pane", "-p", "-e", "-S", "-", "-t", session);
  if (history.status !== 0) return "";
  return sanitize(history.stdout);
}

async function waitForPane(session, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = capturePane(session);
    if (predicate(last)) return last;
    const alive = tmux("has-session", "-t", session);
    if (alive.status !== 0) {
      throw new Error(`${label}: PTY exited before the expected output\n${last}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${label}: timed out after ${timeoutMs}ms\n${last}`);
}

function cliArgs(door) {
  switch (door) {
    case "claude":
      return ["--dangerously-skip-permissions"];
    case "codex":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "cursor":
      return ["--force", "--sandbox", "disabled"];
    case "opencode":
      return [];
    default:
      throw new Error(`unsupported CLI door: ${door}`);
  }
}

function nativeDoorModel(door, model) {
  if (door === "codex" && model.startsWith("codex/")) {
    return model.slice("codex/".length);
  }
  if (door !== "claude") return model;
  const pickerId = model.startsWith("claude-code/")
    ? model.slice("claude-code/".length)
    : model;
  return pickerId.startsWith("claude") || pickerId.startsWith("anthropic")
    ? pickerId
    : `claude-${pickerId}`;
}

function modelVisible(transcript, door, model) {
  const candidates = [model, nativeDoorModel(door, model)];
  if (
    candidates.some(
    (candidate) =>
      transcript.includes(candidate) ||
      transcript.includes(`${candidate.slice(0, 24)}…`)
    )
  ) {
    return true;
  }
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  const native = model.slice(separator + 1);
  return (
    transcript.includes(door === "claude" ? `claude-${provider}/` : `${provider}/`) &&
    transcript.includes(native.slice(0, 8))
  );
}

function modelMatchesRequest(requested, door, expected) {
  return requested === expected || requested === nativeDoorModel(door, expected);
}

function toolBehavior(door, proofPath) {
  const command = `printf ROUTEKIT_TOOL_OK > ${JSON.stringify(proofPath)}`;
  if (door === "claude") {
    return {
      tool_calls: [
        { id: "routekit_matrix_bash", name: "Bash", arguments: JSON.stringify({ command }) }
      ]
    };
  }
  if (door === "codex") {
    return {
      tool_calls: [
        {
          id: "routekit_matrix_exec",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: command })
        }
      ]
    };
  }
  return undefined;
}

async function runPtyCase(input) {
  const session = `routekit-e2e-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const caseDir = mkdtempSync(join(input.tempRoot, `${input.door}-${input.provider}-`));
  const routekitHome = join(caseDir, "routekit-home");
  const xdgData = join(caseDir, "xdg-data");
  const xdgCache = join(caseDir, "xdg-cache");
  const xdgState = join(caseDir, "xdg-state");
  const proofPath = join(caseDir, "routekit-tool-proof.txt");
  const workingDir = input.door === "claude" ? ROOT : caseDir;
  mkdirSync(routekitHome);
  mkdirSync(xdgData);
  mkdirSync(xdgCache);
  mkdirSync(xdgState);
  const marker = `MATRIX_RESPONSE_${input.provider.replaceAll("-", "_").toUpperCase()}_${input.door.toUpperCase()}`;
  const prompt = input.live
    ? input.toolCase
      ? "Use one safe shell tool to run `printf '%s%s%s%s' ROUTE KIT _ OK`, then reply only with its output."
      : "Reply only with the concatenation of ROUTE, KIT, underscore, and OK."
    : input.toolCase
      ? "Use the available safe shell tool to create the requested proof file, then report completion."
      : "Give one short deterministic response to this RouteKit matrix probe.";
  if (input.simulator !== undefined) {
    const behaviors = [];
    if (input.door === "claude") behaviors.push("RouteKit Claude session ready");
    const tool = input.toolCase ? toolBehavior(input.door, proofPath) : undefined;
    if (tool !== undefined) behaviors.push(tool);
    behaviors.push(marker);
    await input.simulator.queue(input.nativeModel, behaviors);
  }
  const beforeCalls = input.proxy.calls.length;
  const command = [
    process.execPath,
    ROUTEKIT_ENTRY,
    "--config",
    input.configPath,
    input.door,
    input.model,
    "--gateway-url",
    input.proxy.url,
    "--cwd",
    workingDir,
    "--",
    ...cliArgs(input.door)
  ];
  const started = tmux(
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    "220",
    "-y",
    "60",
    "-c",
    workingDir,
    "-e",
    `ROUTEKIT_HOME=${routekitHome}`,
    "-e",
    `XDG_DATA_HOME=${xdgData}`,
    "-e",
    `XDG_CACHE_HOME=${xdgCache}`,
    "-e",
    `XDG_STATE_HOME=${xdgState}`,
    "-e",
    "DISABLE_AUTOUPDATER=1",
    "-e",
    "DISABLE_UPDATES=1",
    "--",
    "sleep",
    "3600"
  );
  if (started.status !== 0) {
    throw new Error(`failed to start PTY: ${sanitize(started.stderr)}`);
  }
  const retained = tmux("set-option", "-t", session, "remain-on-exit", "on");
  assert.equal(retained.status, 0, sanitize(retained.stderr));
  const respawned = tmux("respawn-pane", "-k", "-t", session, ...command);
  assert.equal(respawned.status, 0, sanitize(respawned.stderr));
  let transcript = "";
  try {
    transcript = await waitForPane(
      session,
      (value) =>
        modelVisible(value, input.door, input.model) ||
        /trust|press enter|what can i help|type a message|ask anything|RouteKit matrix session/i.test(value),
      Math.min(input.timeoutMs, 45_000),
      `${input.provider}/${input.door} startup`
    );
    if (
      input.door === "opencode" &&
      /Update Complete|Successfully updated to OpenCode/i.test(transcript)
    ) {
      tmux("send-keys", "-t", session, "Escape");
      transcript = await waitForPane(
        session,
        (value) =>
          !/Update Complete|Successfully updated to OpenCode/i.test(value) &&
          (modelVisible(value, input.door, input.model) ||
            /Ask anything/i.test(value)),
        Math.min(input.timeoutMs, 30_000),
        `${input.provider}/${input.door} update notice`
      );
    }
    if (
      /Workspace Trust Required|Do you trust|trust this folder|project you created/i.test(
        transcript
      )
    ) {
      await new Promise((resolveWait) =>
        setTimeout(resolveWait, input.door === "claude" ? 1_500 : 500)
      );
      if (input.door === "cursor") {
        tmux("send-keys", "-l", "-t", session, "a");
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
      tmux("send-keys", "-t", session, "Enter");
      if (input.door === "cursor") {
        await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
        if (/Trusting workspace/i.test(capturePane(session))) {
          tmux("send-keys", "-l", "-t", session, "a");
          tmux("send-keys", "-t", session, "Enter");
        }
      }
      transcript = await waitForPane(
        session,
        (value) =>
          modelVisible(value, input.door, input.model) &&
          !/Workspace Trust Required/i.test(value.slice(-2_000)),
        Math.min(input.timeoutMs, 30_000),
        `${input.provider}/${input.door} workspace trust`
      );
    }
    const promptCallCount = input.proxy.calls.length;
    const buffered = tmux("set-buffer", "-b", session, prompt);
    assert.equal(buffered.status, 0, sanitize(buffered.stderr));
    const pasted = tmux("paste-buffer", "-b", session, "-t", session, "-d");
    assert.equal(pasted.status, 0, sanitize(pasted.stderr));
    tmux("send-keys", "-t", session, "Enter");
    await new Promise((resolveWait) => setTimeout(resolveWait, 750));
    if (input.proxy.calls.length === promptCallCount) {
      tmux("send-keys", "-t", session, "Enter");
    }
    const expected = input.live ? "ROUTEKIT_OK" : marker;
    try {
      transcript = await waitForPane(
        session,
        (value) =>
          input.live && input.toolCase
            ? /Ran 1 shell command/i.test(value)
            : input.live
              ? /ROUTE_?KIT_OK/.test(value)
            : value.includes(expected),
        input.timeoutMs,
        `${input.provider}/${input.door} response`
      );
    } catch (error) {
      const calls = input.proxy.calls.slice(beforeCalls);
      const journal =
        input.simulator === undefined
          ? "(live simulator journal unavailable)"
          : await input.simulator.describeJournal();
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nclient calls=${JSON.stringify(calls)}\n${journal}`
      );
    }
    const caseCalls = input.proxy.calls.slice(beforeCalls);
    assert.ok(caseCalls.length > 0, "the real CLI made no RouteKit model request");
    assert.ok(
      caseCalls.some((call) =>
        modelMatchesRequest(call.model, input.door, input.model)
      ),
      `requested model was ignored; expected ${input.model}, saw ${caseCalls
        .map((call) => call.model ?? "(default)")
        .join(", ")}`
    );
    assert.ok(
      modelVisible(transcript, input.door, input.model),
      `PTY never displayed selected model ${input.model}`
    );
    if (input.live && input.toolCase) {
      assert.ok(
        caseCalls.some((call) => call.hasToolResult),
        `${input.door} did not return the safe tool result through RouteKit`
      );
    }
    if (input.toolCase && input.simulator !== undefined) {
      const journal = await input.simulator.describeJournal();
      const entries = await input.simulator.journal();
      const declaredTools = entries.map((entry) => {
        const tools = entry.request.tools;
        return Array.isArray(tools)
          ? tools.map((tool) =>
              tool !== null &&
              typeof tool === "object" &&
              typeof tool.function === "object" &&
              tool.function !== null
                ? tool.function.name
                : undefined
            )
          : [];
      });
      assert.ok(
        existsSync(proofPath),
        `${input.door} did not execute the safe tool call; client tools=${JSON.stringify(caseCalls.map((call) => call.tools))}; declared tools=${JSON.stringify(declaredTools)}\n${journal}\n${transcript}`
      );
      assert.equal(readFileSync(proofPath, "utf8"), "ROUTEKIT_TOOL_OK");
    }
    return { transcript, gatewayRequests: caseCalls.length };
  } finally {
    tmux("send-keys", "-t", session, "C-c");
    tmux("send-keys", "-t", session, "C-c");
    tmux("kill-session", "-t", session);
  }
}

function accountStoreSnapshot(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const stat = statSync(path);
      return {
        name,
        size: stat.size,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
      };
    });
}

function stageSubscriptionAccounts(isolatedStateHome, providers) {
  const snapshots = {};
  for (const provider of ["codex", "claude-code"]) {
    if (!providers.includes(provider)) continue;
    const source = defaultSubscriptionAccountDirectory(provider);
    const before = accountStoreSnapshot(source);
    const destination = join(isolatedStateHome, "subscriptions", provider);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const { name } of before) {
      const destinationPath = join(destination, name);
      copyFileSync(join(source, name), destinationPath);
      chmodSync(destinationPath, 0o600);
    }
    snapshots[provider] = { source, before, stagedCount: before.length };
  }
  return snapshots;
}

function subscriptionStoresUnchanged(snapshots) {
  return Object.fromEntries(
    Object.entries(snapshots).map(([provider, snapshot]) => [
      provider,
      JSON.stringify(accountStoreSnapshot(snapshot.source)) ===
        JSON.stringify(snapshot.before)
    ])
  );
}

function killProcessGroup(child, signal) {
  if (child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function terminateChild(child) {
  try {
    if (child.exitCode !== null) return;
    killProcessGroup(child, "SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
    ]);
    if (child.exitCode === null) killProcessGroup(child, "SIGKILL");
  } finally {
    ACTIVE_LIVE_CHILDREN.delete(child);
  }
}

async function startLiveRoutekit(configPath, tempRoot, providers) {
  const isolatedStateHome = join(tempRoot, "live-routekit-state");
  const authTokenFile = join(isolatedStateHome, "data-token");
  mkdirSync(isolatedStateHome, { recursive: true, mode: 0o700 });
  const subscriptionSnapshots = stageSubscriptionAccounts(
    isolatedStateHome,
    providers
  );
  const dataToken = randomBytes(32).toString("hex");
  writeFileSync(authTokenFile, `${dataToken}\n`, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      ROUTEKIT_ENTRY,
      "daemon",
      "run",
      "--config-path",
      configPath,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-portless",
      "--auth-token-file",
      authTokenFile,
      "--json"
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ROUTEKIT_HOME: isolatedStateHome,
        ROUTEKIT_PORTLESS: "0"
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  ACTIVE_LIVE_CHILDREN.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const readiness = JSON.parse(stdout.trim());
      if (readiness.event === "listening" && typeof readiness.dataUrl === "string") {
        return {
          url: readiness.dataUrl,
          dataToken,
          stagedAccounts: Object.fromEntries(
            Object.entries(subscriptionSnapshots).map(([provider, snapshot]) => [
              provider,
              snapshot.stagedCount
            ])
          ),
          verifySubscriptionStores: () =>
            subscriptionStoresUnchanged(subscriptionSnapshots),
          close: async () => {
            await terminateChild(child);
          }
        };
      }
    } catch {
      // Readiness JSON is pretty-printed; keep waiting for the closing brace.
    }
    if (child.exitCode !== null) {
      ACTIVE_LIVE_CHILDREN.delete(child);
      throw new Error(
        `routekit live gateway exited ${child.exitCode}\n${sanitize(stdout)}\n${sanitize(stderr)}`
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await terminateChild(child);
  throw new Error(
    `timed out starting live RouteKit gateway\n${sanitize(stdout)}\n${sanitize(stderr)}`
  );
}

async function catalogModels(gatewayUrl) {
  const response = await fetch(`${gatewayUrl}/v1/models`);
  if (!response.ok) throw new Error(`model catalog returned ${response.status}`);
  const body = await response.json();
  return (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id) => typeof id === "string");
}

function chooseLiveModels(models, overrides, providers = PROVIDERS) {
  const preferences = {
    openai: [
      "openai/gpt-5.5",
      "openai/gpt-4.1-mini",
      "openai/gpt-4.1-nano",
      "openai/gpt-4o-mini"
    ],
    anthropic: [
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-3-5-haiku-latest"
    ],
    openrouter: [
      "openrouter/openai/gpt-4o-mini",
      "openrouter/openai/gpt-4.1-nano"
    ],
    codex: ["codex/gpt-5.5"],
    "claude-code": [
      "claude-code/claude-fable-5",
      "claude-code/claude-sonnet-4-6"
    ]
  };
  return Object.fromEntries(
    providers.map((provider) => {
      const available = models.filter((model) => model.startsWith(`${provider}/`));
      const override = overrides[provider];
      if (override !== undefined) {
        if (!available.includes(override)) {
          throw new Error(
            `live model override ${override} is absent from ${provider} catalog`
          );
        }
        return [provider, override];
      }
      const preferred = (preferences[provider] ?? []).find((model) =>
        available.includes(model)
      );
      const fallback = preferred ?? available[0];
      if (fallback === undefined) {
        throw new Error(`configured provider ${provider} discovered no models`);
      }
      return [provider, fallback];
    })
  );
}

function assertNoConfiguredSecrets(value) {
  for (const [name, secret] of Object.entries(process.env)) {
    if (
      secret !== undefined &&
      secret.length >= 8 &&
      /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)
    ) {
      assert.ok(!value.includes(secret), `route info exposed ${name}`);
    }
  }
}

function liveRouteInfo(configPath, chosen, tempRoot) {
  const home = join(tempRoot, "route-info-home");
  const stateHome = join(tempRoot, "route-info-state");
  const canonicalConfig = join(home, ".config", "routekit", "router.yaml");
  mkdirSync(dirname(canonicalConfig), { recursive: true });
  writeFileSync(canonicalConfig, readFileSync(configPath, "utf8"));
  for (const provider of ["codex", "claude-code"]) {
    if (chosen[provider] === undefined) continue;
    const source = defaultSubscriptionAccountDirectory(provider, process.env);
    if (!existsSync(source)) {
      throw new Error(`live route info account directory is missing: ${source}`);
    }
    const target = join(stateHome, "subscriptions", provider);
    mkdirSync(dirname(target), { recursive: true });
    // Discovery and token refresh may persist account state. Copy credentials
    // into the private temporary root so a verification run cannot mutate the
    // operator's enrolled accounts.
    cpSync(source, target, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true
    });
  }
  const env = {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_PORTLESS: "0",
    ROUTEKIT_DAEMON_PORT: "0",
    ROUTEKIT_NO_SUPERVISOR: "1",
    NO_COLOR: "1"
  };
  delete env.ROUTEKIT_CONFIG;
  const records = {};
  try {
    for (const [provider, model] of Object.entries(chosen)) {
      const result = spawnSync(
        process.execPath,
        [ROUTEKIT_ENTRY, "--json", "models", "info", model],
        { cwd: ROOT, env, encoding: "utf8", timeout: 90_000 }
      );
      if (result.status !== 0) {
        throw new Error(
          `route info failed for ${model}\n${sanitize(result.stdout)}\n${sanitize(result.stderr)}`
        );
      }
      assertNoConfiguredSecrets(`${result.stdout}\n${result.stderr}`);
      const info = JSON.parse(result.stdout);
      assert.equal(info.id, model);
      assert.equal(info.provider, provider);
      assert.equal(info.nativeModel, model.slice(provider.length + 1));
      for (const field of [
        "accountClass",
        "billingMode",
        "default",
        "capabilities",
        "reasoning"
      ]) {
        assert.ok(Object.hasOwn(info, field), `${model} route info is missing ${field}`);
      }
      records[provider] = {
        id: info.id,
        provider: info.provider,
        nativeModel: info.nativeModel,
        accountClass: info.accountClass,
        billingMode: info.billingMode,
        default: info.default,
        capabilities: info.capabilities,
        reasoning: info.reasoning
      };
    }
    return records;
  } finally {
    const stopped = spawnSync(
      process.execPath,
      [ROUTEKIT_ENTRY, "--json", "stop", "--force"],
      {
        cwd: ROOT,
        env,
        encoding: "utf8",
        timeout: 90_000
      }
    );
    if (stopped.status !== 0) {
      throw new Error(
        `route info daemon cleanup failed\n${sanitize(stopped.stdout)}\n${sanitize(stopped.stderr)}`
      );
    }
    const recordPath = join(stateHome, "services", "daemon.json");
    if (existsSync(recordPath)) {
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      assert.equal(
        typeof record.pid === "number" && processAlive(record.pid),
        false,
        "route info daemon remained alive after cleanup"
      );
    }
  }
}

function poolCasesEnabled(options) {
  return selected("pool", options.doors);
}

function runPoolCoverage() {
  const file = join(
    ROOT,
    "packages",
    "accounts",
    "dist",
    "test",
    "subscription-pool.test.js"
  );
  const result = spawnSync(process.execPath, ["--test", file], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (result.status !== 0) {
    throw new Error(
      `subscription pool coverage failed\n${sanitize(result.stdout)}\n${sanitize(result.stderr)}`
    );
  }
}

async function runLivePoolFailover(tempRoot) {
  const directory = defaultSubscriptionAccountDirectory("claude-code");
  const sourceSnapshot = accountStoreSnapshot(directory);
  const stagedDirectory = join(tempRoot, "live-pool-credentials");
  mkdirSync(stagedDirectory, { recursive: true, mode: 0o700 });
  const paths = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => {
      const target = join(stagedDirectory, name);
      copyFileSync(join(directory, name), target);
      chmodSync(target, 0o600);
      return target;
    });
  assert.ok(paths.length >= 2, "live pool failover needs at least two enrolled Claude accounts");
  const accounts = await SubscriptionAccountSet.open(
    subscriptionProvider("claude-code"),
    {
      mode: "claude-code",
      source: {
        kind: "paths",
        paths,
        stateDirectory: join(tempRoot, "live-pool-state")
      },
      strategy: "sticky",
      switchThreshold: 0.9
    }
  );
  try {
    await accounts.discoverModels();
    const before = accounts.snapshot();
    assert.ok(before.members.length >= 2, "fewer than two Claude credentials loaded");
    assert.ok(
      before.members.every((member) => member.models.length > 0),
      "not every Claude account discovered models"
    );
    const sharedModel = before.members[0]?.models.find((model) =>
      before.members.slice(1).every((member) => member.models.includes(model))
    );
    assert.ok(sharedModel !== undefined, "Claude accounts have no shared model");

    const attempts = [];
    const response = await accounts.execute(sharedModel, async (credential) => {
      attempts.push(basename(credential.sourcePath, ".json"));
      if (attempts.length === 1) {
        return Response.json(
          {
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "five hour usage limit reached"
            }
          },
          {
            status: 429,
            headers: {
              "anthropic-ratelimit-unified-5h-utilization": "1",
              "anthropic-ratelimit-unified-5h-status": "rejected",
              "anthropic-ratelimit-unified-5h-reset": String(
                Math.floor(Date.now() / 1000) + 300
              ),
              "retry-after": "300"
            }
          }
        );
      }
      return Response.json({ reply: "POOL_FAILOVER_OK" });
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reply: "POOL_FAILOVER_OK" });
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0], attempts[1]);
    const active = accounts.snapshot().members.find((member) => member.active);
    assert.equal(active?.id, attempts[1]);
    const memberOrdinals = new Map(
      before.members.map((member, index) => [member.id, `member-${index + 1}`])
    );
    return {
      model: sharedModel,
      memberCount: before.members.length,
      attempts: attempts.map((member) => memberOrdinals.get(member)),
      active: memberOrdinals.get(active?.id)
    };
  } finally {
    await accounts.close();
    assert.deepEqual(
      accountStoreSnapshot(directory),
      sourceSnapshot,
      "live pool qualification mutated the enrolled Claude account store"
    );
  }
}

function resultEntry(input) {
  const identity = {
    phase: input.phase,
    routeId: input.routeId ?? null,
    provider: input.provider ?? null,
    door: input.door
  };
  return {
    caseId: caseIdFor(identity),
    routeIds: routeIdsForCase(EVIDENCE_MAP, identity),
    ...identity,
    status: input.status,
    reasonCode:
      input.status === "pass"
        ? "qualified"
        : input.reasonCode ?? classifyFailure(input.reason ?? "provider request failed"),
    durationMs: input.durationMs,
    gatewayRequests: input.gatewayRequests ?? 0,
    artifact: input.artifact ?? null,
    model: input.model ?? null,
    setupRestore: input.setupRestore ?? null
  };
}

async function observeGatewayRequests(proxy, run) {
  const before = proxy.calls.length;
  try {
    return {
      ...(await run()),
      gatewayRequests: proxy.calls.length - before
    };
  } catch (error) {
    const observed = proxy.calls.length - before;
    if (error instanceof Error) {
      error.gatewayRequests = observed;
      throw error;
    }
    const wrapped = new Error(String(error));
    wrapped.gatewayRequests = observed;
    throw wrapped;
  }
}

async function recordCase(results, input, run) {
  const started = Date.now();
  try {
    const output = await run();
    const entry = resultEntry({
      ...input,
      status: "pass",
      durationMs: Date.now() - started,
      ...(output ?? {})
    });
    results.push(entry);
    process.stdout.write(`PASS ${input.phase} ${input.provider ?? "-"} ${input.door}\n`);
    return entry;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const entry = resultEntry({
      ...input,
      status: "fail",
      reasonCode: classifyFailure(reason),
      durationMs: Date.now() - started,
      gatewayRequests:
        error instanceof Error && Number.isInteger(error.gatewayRequests)
          ? error.gatewayRequests
          : 0
    });
    results.push(entry);
    process.stderr.write(
      `FAIL ${input.phase} ${input.provider ?? "-"} ${input.door}: ${entry.reasonCode} (${sanitize(reason)})\n`
    );
    return entry;
  }
}

function skipCase(results, input, reason) {
  const entry = resultEntry({
    ...input,
    status: "skip",
    reasonCode: classifyFailure(reason),
    durationMs: 0
  });
  results.push(entry);
  process.stdout.write(`SKIP ${input.phase} ${input.provider ?? "-"} ${input.door}: ${reason}\n`);
}

function gitSourceState() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (revision.status !== 0 || !/^[0-9a-f]{40}$/.test(revision.stdout.trim())) {
    throw new Error("cannot determine the matrix source revision");
  }
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (status.status !== 0) throw new Error("cannot determine whether matrix sources are clean");
  return {
    revision: revision.stdout.trim(),
    dirty: status.stdout.trim().length > 0
  };
}

async function runDeterministic(options, results, artifactDir, tempRoot) {
  const stack = await startDeterministicStack(tempRoot);
  try {
    await recordCase(
      results,
      { phase: "deterministic", door: "cancellation" },
      async () => {
        await verifyCancellationPropagation();
        return {};
      }
    );
    const failureCases = new Map();
    for (const route of qualificationRoutes(options)) {
      if (!selected(route.provider, options.providers)) continue;
      const protocolDoorId =
        route.door === "cursor" || route.door === "cursor-ide"
          ? "openai-chat"
          : route.door;
      if (!selected(protocolDoorId, options.doors)) continue;
      failureCases.set(`${route.provider}:${protocolDoorId}`, {
        provider: route.provider,
        door: API_DOORS.find((candidate) => candidate.id === protocolDoorId)
      });
    }
    for (const { provider, door } of failureCases.values()) {
      assert.ok(door !== undefined, `missing deterministic door for ${provider}`);
      await recordCase(
        results,
        {
          phase: "deterministic",
          provider,
          door: `failure-no-fallback-${door.id}`
        },
        async () => {
          await verifyFailureNoFallback(stack, provider, door);
          return {};
        }
      );
      await recordCase(
        results,
        {
          phase: "deterministic",
          provider,
          door: `tools-reasoning-${door.id}`
        },
        async () => {
          await verifyToolsAndReasoning(stack, provider, door);
          return {};
        }
      );
    }
    await recordCase(
      results,
      { phase: "deterministic", door: "native-pickers" },
      async () => {
        const aliases = await nativePickerAliases(
          stack.proxy.url,
          stack.nativeModels,
          stack.publicModels
        );
        writeFileSync(
          join(artifactDir, "deterministic-native-pickers.json"),
          `${JSON.stringify(aliases, null, 2)}\n`
        );
        return { artifact: "deterministic-native-pickers.json" };
      }
    );
    if (
      selected("claude-code", options.providers) &&
      selected("anthropic-messages", options.doors)
    ) {
      await recordCase(
        results,
        {
          phase: "deterministic",
          provider: "claude-code",
          door: "anthropic-thinking"
        },
        async () => {
          await verifyLosslessAnthropicThinking(stack);
          return {};
        }
      );
    }
    if (selected("openrouter", options.providers)) {
      await recordCase(
        results,
        {
          phase: "deterministic",
          provider: "openrouter",
          door: "dynamic-reasoning-capabilities"
        },
        async () => {
          await verifyDynamicReasoningCapabilities(stack);
          return {};
        }
      );
    }
    for (const provider of PROVIDERS) {
      if (!selected(provider, options.providers)) continue;
      for (const door of API_DOORS) {
        if (!caseSelected(provider, door.id, options)) continue;
        await recordCase(
          results,
          {
            phase: "deterministic",
            routeId: routeIdForCase(provider, door.id, options),
            provider,
            door: door.id
          },
          async () => {
            await stack.simulator.reset();
            const marker = `API_${provider.replaceAll("-", "_").toUpperCase()}_${door.id
              .replaceAll("-", "_")
              .toUpperCase()}`;
            await stack.simulator.queue(stack.nativeModels[provider], [marker]);
            const answer = await callApiDoor(
              stack.proxy.url,
              door,
              stack.publicModels[provider],
              "Deterministic RouteKit API matrix probe."
            );
            assert.match(answer, new RegExp(marker));
            const calls = await stack.simulator.calls({
              model: stack.nativeModels[provider]
            });
            assert.equal(calls.length, 1, await stack.simulator.describeJournal());
            return {};
          }
        );
      }
    }
    for (const provider of PROVIDERS) {
      if (!selected(provider, options.providers)) continue;
      for (const door of CLI_DOORS) {
        if (!caseSelected(provider, door.id, options)) continue;
        if (!commandAvailable(door.binary)) {
          skipCase(
            results,
            {
              phase: "deterministic",
              routeId: routeIdForCase(provider, door.id, options),
              provider,
              door: door.id
            },
            `${door.binary} is not installed`
          );
          continue;
        }
        await stack.simulator.reset();
        const transcriptPath = join(
          artifactDir,
          `deterministic-${provider}-${door.id}.txt`
        );
        const entry = await recordCase(
          results,
          {
            phase: "deterministic",
            routeId: routeIdForCase(provider, door.id, options),
            provider,
            door: door.id
          },
          async () => {
            const toolCase =
              provider === "openrouter" &&
              (door.id === "claude" || door.id === "codex");
            const output = await runPtyCase({
              tempRoot,
              provider,
              door: door.id,
              model: stack.publicModels[provider],
              nativeModel: stack.nativeModels[provider],
              configPath: stack.configPath,
              proxy: stack.proxy,
              simulator: stack.simulator,
              timeoutMs: options.timeoutMs,
              toolCase,
              live: false
            });
            writeFileSync(transcriptPath, `${sanitize(output.transcript).trim()}\n`);
            const nativeCalls = await stack.simulator.calls({
              model: stack.nativeModels[provider]
            });
            assert.ok(
              nativeCalls.length > 0,
              `selected provider ${provider} received no simulator call`
            );
            return {
              gatewayRequests: 0,
              artifact: relative(ROOT, transcriptPath)
            };
          }
        );
        if (entry.status === "pass") entry.gatewayRequests = 0;
      }
    }
    if (poolCasesEnabled(options)) {
      await recordCase(
        results,
        { phase: "deterministic", door: "pool" },
        async () => {
          runPoolCoverage();
          return {};
        }
      );
    }
  } finally {
    await stack.close();
  }
}

async function runLive(options, results, artifactDir, tempRoot) {
  const routes = options.routes === undefined ? [] : qualificationRoutes(options);
  if (routes.length > 0) reserveRouteBudget(routes, options.maxLiveCalls);
  const configuredPath = join(ROOT, ".routekit", "router.yaml");
  if (!existsSync(configuredPath)) {
    throw new Error(`live RouteKit config not found: ${configuredPath}`);
  }
  const configPath =
    options.providers === undefined
      ? configuredPath
      : join(tempRoot, "live-filtered-router.yaml");
  if (options.providers !== undefined) {
    writeFileSync(
      configPath,
      [
        "providers:",
        ...options.providers.map((provider) => `  ${provider}: {}`),
        ""
      ].join("\n")
    );
  }
  const routekit = await startLiveRoutekit(
    configPath,
    tempRoot,
    options.providers ?? ["codex", "claude-code"]
  );
  let proxy;
  let gatewayRequests = 0;
  try {
    proxy = await startCountingProxy(routekit.url, {
      maxCalls: options.maxLiveCalls,
      upstreamAuthorization: `Bearer ${routekit.dataToken}`
    });
    const models = await catalogModels(proxy.url);
    const activeProviders = PROVIDERS.filter(
      (provider) =>
        selected(provider, options.providers) &&
        (options.providers !== undefined ||
          models.some((model) => model.startsWith(`${provider}/`)))
    );
    const chosen = chooseLiveModels(models, options.models, activeProviders);
    await recordCase(
      results,
      { phase: "live", door: "route-info" },
      async () => {
        const routeInfo = liveRouteInfo(configPath, chosen, tempRoot);
        const artifact = "live-route-info.json";
        writeFileSync(
          join(artifactDir, artifact),
          `${JSON.stringify(routeInfo, null, 2)}\n`
        );
        return { billedCalls: 0, artifact };
      }
    );
    const pickerPublicModels = Object.fromEntries(
      ["codex", "claude-code"].flatMap((provider) =>
        chosen[provider] === undefined ? [] : [[provider, chosen[provider]]]
      )
    );
    if (Object.keys(pickerPublicModels).length > 0) {
      await recordCase(
        results,
        { phase: "live", door: "native-pickers" },
        async () => {
          const pickerNativeModels = Object.fromEntries(
            Object.entries(pickerPublicModels).map(([provider, model]) => [
              provider,
              model.slice(provider.length + 1)
            ])
          );
          const aliases = await nativePickerAliases(
            proxy.url,
            pickerNativeModels,
            pickerPublicModels
          );
          writeFileSync(
            join(artifactDir, "live-native-pickers.json"),
            `${JSON.stringify(aliases, null, 2)}\n`
          );
          return { gatewayRequests: 0, artifact: "live-native-pickers.json" };
        }
      );
    }
    const estimatedMinimum =
      activeProviders.flatMap((provider) =>
        [...API_DOORS, ...CLI_DOORS].filter((door) =>
          caseSelected(provider, door.id, options)
        )
      ).length;
    if (estimatedMinimum > options.maxLiveCalls) {
      throw new Error(
        `selected live matrix needs at least ${estimatedMinimum} calls, above budget ${options.maxLiveCalls}`
      );
    }
    for (const provider of activeProviders) {
      for (const door of API_DOORS) {
        if (!caseSelected(provider, door.id, options)) continue;
        await recordCase(
          results,
          {
            phase: "live",
            routeId: routeIdForCase(provider, door.id, options),
            provider,
            door: door.id
          },
          async () =>
            await observeGatewayRequests(proxy, async () => {
              const answer = await callApiDoor(
                proxy.url,
                door,
                chosen[provider],
                "Reply exactly with ROUTEKIT_OK.",
                true
              );
              assert.match(answer, /ROUTEKIT_OK/i);
              return {
                model: chosen[provider]
              };
            })
        );
      }
    }
    for (const provider of activeProviders) {
      for (const door of CLI_DOORS) {
        if (!caseSelected(provider, door.id, options)) continue;
        if (!commandAvailable(door.binary)) {
          skipCase(
            results,
            {
              phase: "live",
              routeId: routeIdForCase(provider, door.id, options),
              provider,
              door: door.id
            },
            `${door.binary} is not installed`
          );
          continue;
        }
        const transcriptPath = join(artifactDir, `live-${provider}-${door.id}.txt`);
        await recordCase(
          results,
          {
            phase: "live",
            routeId: routeIdForCase(provider, door.id, options),
            provider,
            door: door.id
          },
          async () =>
            await observeGatewayRequests(proxy, async () => {
              const output = await runPtyCase({
                tempRoot,
                provider,
                door: door.id,
                model: chosen[provider],
                nativeModel: chosen[provider].slice(provider.length + 1),
                configPath,
                proxy,
                timeoutMs: options.timeoutMs,
                toolCase: provider === "openrouter" && door.id === "claude",
                live: true
              });
              writeFileSync(
                transcriptPath,
                `${sanitize(output.transcript).trim()}\n`
              );
              return {
                artifact: relative(ROOT, transcriptPath),
                model: chosen[provider]
              };
            })
        );
      }
    }
    if (
      poolCasesEnabled(options) &&
      selected("claude-code", options.providers)
    ) {
      const artifactPath = join(artifactDir, "live-claude-code-pool.json");
      await recordCase(
        results,
        { phase: "live", provider: "claude-code", door: "pool" },
        async () => {
          const result = await runLivePoolFailover(tempRoot);
          writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`);
          return {
            gatewayRequests: 0,
            artifact: relative(ROOT, artifactPath)
          };
        }
      );
    }
  } catch (error) {
    const observed = proxy?.calls.length ?? 0;
    if (error instanceof Error) {
      error.gatewayRequests = observed;
      throw error;
    }
    const wrapped = new Error(String(error));
    wrapped.gatewayRequests = observed;
    throw wrapped;
  } finally {
    gatewayRequests = proxy?.calls.length ?? 0;
    try {
      await proxy?.close();
    } finally {
      await routekit.close();
    }
    const unchangedStores = routekit.verifySubscriptionStores();
    for (const entry of results.filter(
      (candidate) =>
        candidate.phase === "live" &&
        (candidate.provider === "codex" || candidate.provider === "claude-code")
    )) {
      entry.setupRestore = {
        setup: (routekit.stagedAccounts[entry.provider] ?? 0) > 0 ? "pass" : "fail",
        restore: unchangedStores[entry.provider] === true ? "pass" : "fail"
      };
    }
  }
  return gatewayRequests;
}

function commandVersion(binary) {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.error !== undefined || result.status !== 0) return "unavailable";
  return result.stdout.trim().replaceAll(/[\r\n\t]/g, " ").slice(0, 160) || "unavailable";
}

function repositoryMetadata() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  const dirty = spawnSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, "packages", "routekit-cli", "package.json"), "utf8")
  );
  return {
    routekitVersion: packageJson.version,
    routekitGitSha:
      revision.status === 0 ? revision.stdout.trim() : "unavailable",
    gitDirty: dirty.status !== 0 || dirty.stdout.trim() !== "",
    nodeVersion: process.version,
    platform: platform(),
    architecture: arch(),
    clients: {
      claude: commandVersion("claude"),
      codex: commandVersion("codex"),
      cursorAgent: commandVersion("cursor-agent"),
      cursorIde: commandVersion("cursor")
    }
  };
}

function deterministicCheck(results, provider, protocolDoor, prefix) {
  return results.find(
    (entry) =>
      entry.phase === "deterministic" &&
      entry.provider === provider &&
      entry.door === `${prefix}-${protocolDoor}`
  );
}

function buildQualification(options, results, topLevelError, liveGatewayRequestsObserved) {
  if (!options.live || options.routes === undefined) {
    return {
      status: "not-run",
      expectedRouteIds: [],
      routes: []
    };
  }
  const cancellation = results.find(
    (entry) => entry.phase === "deterministic" && entry.door === "cancellation"
  );
  const routes = qualificationRoutes(options).map((route) => {
    if (route.manual === true) {
      return makeRouteResult(
        route,
        {
          status: "fail",
          reasonCode: "manual-evidence-unavailable",
          credentialAvailable: false,
          clientVersion: commandVersion("cursor"),
          protocol: {
            streaming: "fail",
            tools: "fail",
            reasoning: "fail"
          },
          behavior: {
            cancellation: cancellation?.status === "pass" ? "pass" : "fail",
            failurePropagation: "fail",
            routekitFallback: "unverified"
          },
          setupRestore: { setup: "fail", restore: "fail" },
          evidence: ["manual-evidence-unavailable"]
        }
      );
    }
    const live = results.find(
      (entry) => entry.phase === "live" && entry.routeId === route.routeId
    );
    const protocolDoor =
      route.door === "cursor" ? "openai-chat" : route.door;
    const failure = deterministicCheck(
      results,
      route.provider,
      protocolDoor,
      "failure-no-fallback"
    );
    const capabilities = deterministicCheck(
      results,
      route.provider,
      protocolDoor,
      "tools-reasoning"
    );
    const livePassed = live?.status === "pass";
    const deterministicPassed =
      cancellation?.status === "pass" &&
      failure?.status === "pass" &&
      capabilities?.status === "pass";
    const requiredClientAvailable =
      route.client === "routekit-http" || commandVersion(route.client) !== "unavailable";
    const passed = livePassed && deterministicPassed && requiredClientAvailable;
    const clientVersion =
      route.client === "routekit-http"
        ? repositoryMetadata().routekitVersion
        : commandVersion(route.client);
    return makeRouteResult(route, {
      status: passed ? "pass" : "fail",
      reasonCode:
        topLevelError !== undefined
          ? classifyFailure(topLevelError)
          : live === undefined
            ? "matrix-case-missing"
            : live.status === "skip" || !requiredClientAvailable
              ? "client-unavailable"
              : !livePassed
                ? live.reasonCode
                : !deterministicPassed
                  ? "provider-request-failed"
                  : "setup-restore-failed",
      durationMs: live?.durationMs,
      model: live?.model,
      apiRevision: route.provider === "anthropic" ? "2023-06-01" : "not-advertised",
      credentialAvailable: livePassed,
      clientVersion,
      protocol: {
        streaming: livePassed ? "pass" : "fail",
        tools: capabilities?.status === "pass" ? "pass" : "fail",
        reasoning: capabilities?.status === "pass" ? "pass" : "fail"
      },
      behavior: {
        cancellation: cancellation?.status === "pass" ? "pass" : "fail",
        failurePropagation: failure?.status === "pass" ? "pass" : "fail",
        routekitFallback: failure?.status === "pass" ? "none" : "unverified"
      },
      attributionBasis:
        livePassed && (live?.gatewayRequests ?? 0) > 0
          ? "namespaced-route-success"
          : "not-observed",
      gatewayRequestsObserved: live?.gatewayRequests ?? 0,
      setupRestore:
        route.setupRestore === "not-applicable"
          ? { setup: "not-applicable", restore: "not-applicable" }
          : live?.setupRestore ?? { setup: "fail", restore: "fail" },
      evidence: [
        `deterministic-failure-no-fallback-${route.provider}-${protocolDoor}`,
        `deterministic-tools-reasoning-${route.provider}-${protocolDoor}`,
        "deterministic-cancellation",
        live?.artifact
      ].filter(Boolean)
    });
  });
  const completeness = qualificationCompleteness(
    routes,
    qualificationRoutes(options).map((route) => route.routeId)
  );
  const totalGatewayRequests = liveGatewayRequestsObserved;
  return {
    status: completeness.allPassed ? "pass" : "fail",
    completeness,
    budget: {
      authorizedMaximum: options.maxLiveCalls,
      plannedMaximum: qualificationRoutes(options).reduce(
        (sum, route) => sum + route.maxGatewayRequests,
        0
      ),
      gatewayRequestsObserved: totalGatewayRequests,
      remaining: Math.max(0, options.maxLiveCalls - totalGatewayRequests),
      exhausted: totalGatewayRequests >= options.maxLiveCalls
    },
    routes
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceState = gitSourceState();
  if (!existsSync(ROUTEKIT_ENTRY)) {
    throw new Error("RouteKit is not built; run pnpm build:routekit");
  }
  if (!commandAvailable("tmux")) {
    throw new Error("tmux is required for RouteKit PTY matrix coverage");
  }
  const startedAt = new Date().toISOString();
  const runTimestamp = timestamp();
  const artifactDir = join(ROOT, ".artifacts", "routekit-e2e", runTimestamp);
  const tempRoot = mkdtempSync(join(tmpdir(), "routekit-e2e-matrix-"));
  mkdirSync(artifactDir, { recursive: true });
  let signalCleanupStarted = false;
  const cleanupForSignal = async (signal) => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    removeSignalHandlers();
    try {
      await Promise.all(
        [...ACTIVE_LIVE_CHILDREN].map(async (child) => await terminateChild(child))
      );
    } finally {
      cleanupMatrixTmuxSessions();
      rmSync(tempRoot, { recursive: true, force: true });
      process.kill(process.pid, signal);
    }
  };
  const onSigint = () => void cleanupForSignal("SIGINT");
  const onSigterm = () => void cleanupForSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
  const results = [];
  let topLevelError;
  let liveGatewayRequestsObserved = 0;
  try {
    await runDeterministic(options, results, artifactDir, tempRoot);
    if (options.live) {
      liveGatewayRequestsObserved = await runLive(
        options,
        results,
        artifactDir,
        tempRoot
      );
    } else {
      process.stdout.write(
        "LIVE SKIPPED: set ROUTEKIT_LIVE_E2E=1 to authorize live account calls\n"
      );
    }
  } catch (error) {
    topLevelError = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && Number.isInteger(error.gatewayRequests)) {
      liveGatewayRequestsObserved = error.gatewayRequests;
    }
    process.stderr.write(`MATRIX ERROR: ${sanitize(topLevelError)}\n`);
  } finally {
    removeSignalHandlers();
    cleanupMatrixTmuxSessions();
    rmSync(tempRoot, { recursive: true, force: true });
  }
  const caseCounts = {
    pass: results.filter((entry) => entry.status === "pass").length,
    fail: results.filter((entry) => entry.status === "fail").length,
    skip: results.filter((entry) => entry.status === "skip").length
  };
  const qualification = buildQualification(
    options,
    results,
    topLevelError,
    liveGatewayRequestsObserved
  );
  const routeCounts = {
    pass: qualification.routes.filter((route) => route.status === "pass").length,
    fail: qualification.routes.filter((route) => route.status === "fail").length
  };
  const summary = {
    status:
      topLevelError === undefined &&
      caseCounts.fail === 0 &&
      (!options.live ||
        options.routes === undefined ||
        qualification.status === "pass")
        ? "pass"
        : "fail",
    caseCounts,
    topLevelFailures: topLevelError === undefined ? 0 : 1,
    routeCounts
  };
  const report = {
    schemaVersion: 4,
    routekitVersion: ROUTEKIT_VERSION,
    evidenceMappingSchemaVersion: EVIDENCE_MAP.schemaVersion,
    evidenceMappingDigest: mappingDigest(EVIDENCE_MAP),
    sourceRevision: sourceState.revision,
    sourceDirty: sourceState.dirty,
    startedAt,
    finishedAt: new Date().toISOString(),
    metadata: repositoryMetadata(),
    liveAuthorized: options.live,
    filters: {
      routes:
        options.routes === undefined
          ? []
          : qualificationRoutes(options).map((route) => route.routeId),
      providers: options.providers ?? PROVIDERS,
      doors:
        options.doors ??
        [...API_DOORS.map((door) => door.id), ...CLI_DOORS.map((door) => door.id), "pool"],
      timeoutMs: options.timeoutMs,
      maxLiveCalls: options.maxLiveCalls
    },
    summary,
    liveGatewayRequestsObserved,
    results,
    qualification,
    topLevelError:
      topLevelError === undefined ? null : classifyFailure(topLevelError)
  };
  const reportPath = join(artifactDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `RESULT status=${summary.status} cases_pass=${caseCounts.pass} cases_fail=${caseCounts.fail} cases_skip=${caseCounts.skip} top_level_failures=${summary.topLevelFailures} routes_pass=${routeCounts.pass} routes_fail=${routeCounts.fail} gateway_requests=${report.liveGatewayRequestsObserved}\n`
  );
  process.stdout.write(`REPORT ${relative(ROOT, reportPath)}\n`);
  if (
    caseCounts.fail > 0 ||
    topLevelError !== undefined ||
    (options.live &&
      options.routes !== undefined &&
      qualification.status !== "pass")
  ) {
    process.exitCode = 1;
  }
}

await main();
