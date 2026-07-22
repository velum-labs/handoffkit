#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTEKIT_ENTRY = join(ROOT, "packages", "routekit-cli", "dist", "index.js");
const API_DOORS = DOOR_PROFILES.filter((door) =>
  ["openai-chat", "anthropic-messages", "codex-responses"].includes(door.id)
);
const CLI_DOORS = [
  { id: "claude", binary: "claude" },
  { id: "codex", binary: "codex" },
  { id: "cursor", binary: "cursor-agent" },
  { id: "opencode", binary: "opencode" }
];
const PROVIDERS = ["openrouter", "codex", "claude-code"];
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
    maxLiveCalls: Number(process.env.ROUTEKIT_E2E_MAX_LIVE_CALLS ?? 32),
    models: {}
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
          "  --live                    run billed cases (also ROUTEKIT_LIVE_E2E=1)",
          "  --provider <ids>          comma-separated provider filter",
          "  --door <ids>              API/CLI door filter",
          "  --model <provider=id>     override one live namespaced model",
          "  --timeout-ms <ms>         per-PTY timeout",
          "  --max-live-calls <count>  hard billed-request budget",
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
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
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
    .replace(/(authorization|x-api-key|api[_-]?key|token)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
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
      "  openrouter: {}",
      "  codex: {}",
      "  claude-code: {}",
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
      : provider === "claude-code"
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
  if (door.id === "openai-chat") body.max_tokens = 16;
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
    return { transcript, billedCalls: caseCalls.length };
  } finally {
    tmux("send-keys", "-t", session, "C-c");
    tmux("send-keys", "-t", session, "C-c");
    tmux("kill-session", "-t", session);
  }
}

async function startLiveRoutekit(configPath) {
  const child = spawn(
    process.execPath,
    [
      ROUTEKIT_ENTRY,
      "--config",
      configPath,
      "gateway",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-portless",
      "--json"
    ],
    {
      cwd: ROOT,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
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
      if (typeof readiness.url === "string") {
        return {
          url: readiness.url,
          close: async () => {
            if (child.exitCode !== null) return;
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              child.kill("SIGTERM");
            }
            await Promise.race([
              new Promise((resolveExit) => child.once("exit", resolveExit)),
              new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
            ]);
            if (child.exitCode === null) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }
        };
      }
    } catch {
      // Readiness JSON is pretty-printed; keep waiting for the closing brace.
    }
    if (child.exitCode !== null) {
      throw new Error(
        `routekit live gateway exited ${child.exitCode}\n${sanitize(stdout)}\n${sanitize(stderr)}`
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
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
      const preferred = preferences[provider].find((model) =>
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
    // Keep the isolated daemon's service/config state separate while reading
    // the same enrolled accounts as the already-qualified live gateway.
    symlinkSync(source, target, "dir");
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
      records[provider] = info;
    }
    return records;
  } finally {
    spawnSync(process.execPath, [ROUTEKIT_ENTRY, "--json", "stop"], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 90_000
    });
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
  const paths = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .map((name) => join(directory, name));
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
    return {
      model: sharedModel,
      members: before.members.map((member) => member.id),
      attempts,
      active: active?.id
    };
  } finally {
    await accounts.close();
  }
}

function resultEntry(input) {
  return {
    phase: input.phase,
    provider: input.provider ?? null,
    door: input.door,
    status: input.status,
    reason: input.reason ?? null,
    durationMs: input.durationMs,
    billedCalls: input.billedCalls ?? 0,
    artifact: input.artifact ?? null
  };
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
      reason: sanitize(reason),
      durationMs: Date.now() - started
    });
    results.push(entry);
    process.stderr.write(
      `FAIL ${input.phase} ${input.provider ?? "-"} ${input.door}: ${entry.reason}\n`
    );
    return entry;
  }
}

function skipCase(results, input, reason) {
  const entry = resultEntry({
    ...input,
    status: "skip",
    reason,
    durationMs: 0
  });
  results.push(entry);
  process.stdout.write(`SKIP ${input.phase} ${input.provider ?? "-"} ${input.door}: ${reason}\n`);
}

async function runDeterministic(options, results, artifactDir, tempRoot) {
  const stack = await startDeterministicStack(tempRoot);
  try {
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
        if (!selected(door.id, options.doors)) continue;
        await recordCase(
          results,
          { phase: "deterministic", provider, door: door.id },
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
        if (!selected(door.id, options.doors)) continue;
        if (!commandAvailable(door.binary)) {
          skipCase(
            results,
            { phase: "deterministic", provider, door: door.id },
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
          { phase: "deterministic", provider, door: door.id },
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
              billedCalls: 0,
              artifact: relative(ROOT, transcriptPath)
            };
          }
        );
        if (entry.status === "pass") entry.billedCalls = 0;
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
  const routekit = await startLiveRoutekit(configPath);
  let proxy;
  let billedCalls = 0;
  try {
    proxy = await startCountingProxy(routekit.url, {
      maxCalls: options.maxLiveCalls
    });
    const models = await catalogModels(proxy.url);
    const activeProviders = PROVIDERS.filter((provider) =>
      selected(provider, options.providers)
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
          return { billedCalls: 0, artifact: "live-native-pickers.json" };
        }
      );
    }
    const estimatedMinimum =
      activeProviders.length *
      (API_DOORS.filter((door) => selected(door.id, options.doors)).length +
        CLI_DOORS.filter((door) => selected(door.id, options.doors)).length);
    if (estimatedMinimum > options.maxLiveCalls) {
      throw new Error(
        `selected live matrix needs at least ${estimatedMinimum} calls, above budget ${options.maxLiveCalls}`
      );
    }
    for (const provider of PROVIDERS) {
      if (!selected(provider, options.providers)) continue;
      for (const door of API_DOORS) {
        if (!selected(door.id, options.doors)) continue;
        await recordCase(
          results,
          { phase: "live", provider, door: door.id },
          async () => {
            const before = proxy.calls.length;
            const answer = await callApiDoor(
              proxy.url,
              door,
              chosen[provider],
              "Reply exactly with ROUTEKIT_OK.",
              true
            );
            assert.match(answer, /ROUTEKIT_OK/i);
            return { billedCalls: proxy.calls.length - before };
          }
        );
      }
    }
    for (const provider of PROVIDERS) {
      if (!selected(provider, options.providers)) continue;
      for (const door of CLI_DOORS) {
        if (!selected(door.id, options.doors)) continue;
        if (!commandAvailable(door.binary)) {
          skipCase(
            results,
            { phase: "live", provider, door: door.id },
            `${door.binary} is not installed`
          );
          continue;
        }
        const transcriptPath = join(artifactDir, `live-${provider}-${door.id}.txt`);
        await recordCase(
          results,
          { phase: "live", provider, door: door.id },
          async () => {
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
            writeFileSync(transcriptPath, `${sanitize(output.transcript).trim()}\n`);
            return {
              billedCalls: output.billedCalls,
              artifact: relative(ROOT, transcriptPath)
            };
          }
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
            billedCalls: 0,
            artifact: relative(ROOT, artifactPath)
          };
        }
      );
    }
  } finally {
    billedCalls = proxy?.calls.length ?? 0;
    await proxy?.close();
    await routekit.close();
  }
  return billedCalls;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
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
  const results = [];
  let topLevelError;
  let billedLiveCallsMade = 0;
  try {
    await runDeterministic(options, results, artifactDir, tempRoot);
    if (options.live) {
      billedLiveCallsMade = await runLive(
        options,
        results,
        artifactDir,
        tempRoot
      );
    } else {
      process.stdout.write(
        "LIVE SKIPPED: set ROUTEKIT_LIVE_E2E=1 to authorize billed provider calls\n"
      );
    }
  } catch (error) {
    topLevelError = error instanceof Error ? error.message : String(error);
    process.stderr.write(`MATRIX ERROR: ${sanitize(topLevelError)}\n`);
  } finally {
    for (const session of tmux("list-sessions", "-F", "#{session_name}").stdout
      .split("\n")
      .filter((name) => name.startsWith(`routekit-e2e-${process.pid}-`))) {
      tmux("kill-session", "-t", session);
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
  const counts = {
    pass: results.filter((entry) => entry.status === "pass").length,
    fail: results.filter((entry) => entry.status === "fail").length,
    skip: results.filter((entry) => entry.status === "skip").length
  };
  const report = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    liveAuthorized: options.live,
    filters: {
      providers: options.providers ?? PROVIDERS,
      doors:
        options.doors ??
        [...API_DOORS.map((door) => door.id), ...CLI_DOORS.map((door) => door.id), "pool"],
      timeoutMs: options.timeoutMs,
      maxLiveCalls: options.maxLiveCalls
    },
    counts,
    billedLiveCallsMade,
    results,
    topLevelError: topLevelError === undefined ? null : sanitize(topLevelError)
  };
  const reportPath = join(artifactDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `RESULT pass=${counts.pass} fail=${counts.fail} skip=${counts.skip} billed=${report.billedLiveCallsMade}\n`
  );
  process.stdout.write(`REPORT ${relative(ROOT, reportPath)}\n`);
  if (counts.fail > 0 || topLevelError !== undefined) process.exitCode = 1;
}

await main();
