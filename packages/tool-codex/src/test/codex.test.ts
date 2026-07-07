import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createMockHarness, ensemble } from "@fusionkit/ensemble";
import type { EnsembleDescriptor } from "@fusionkit/ensemble";
import { addSpanListener, initFusionTracing, newSessionCarrier, removeSpanListener, spanTraceId } from "@fusionkit/tracing";
import type { ReadableSpan } from "@fusionkit/tracing";

import {
  codexAgentRoles,
  codexAgentRoleToml,
  codexConfigToml,
  codexHarness,
  codexLaunchConfigToml,
  codexMemberCatalogJson,
  codexModelCatalogJson,
  codexSubscriptionModels,
  defaultCodexRunner,
  isCodexConfigFailure,
  memberChatBackend,
  readCodexModelsCache
} from "../index.js";
import type { CodexExecRunner } from "../index.js";
import { OpenAiBackend } from "@fusionkit/model-gateway";

function tempOutputRoot(): { outputRoot: string; cleanup: () => void } {
  const outputRoot = mkdtempSync(join(tmpdir(), "ensemble-codex-out-"));
  return {
    outputRoot,
    cleanup: () => rmSync(outputRoot, { recursive: true, force: true })
  };
}

function descriptor(outputRoot: string, overrides: Partial<EnsembleDescriptor> = {}): EnsembleDescriptor {
  return {
    id: "codex_ensemble_test",
    harness: createMockHarness(),
    models: [{ id: "codex", model: "gpt-5.1-codex-max" }],
    runtime: { id: "local" },
    judge: { id: "judge", model: "fake-judge" },
    policy: {
      id: "policy",
      allowedTools: ["read_file", "apply_patch"],
      sideEffects: "writes_workspace",
      timeoutMs: 1_000
    },
    prompt: "Summarize Codex harness evidence.",
    sourceRepo: "handoffkit",
    baseGitSha: "b".repeat(40),
    outputRoot,
    ...overrides
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startOpenAiCompatibleServer(): Promise<{
  url: string;
  requests: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "local-model" }] }));
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        const model = typeof body.model === "string" ? body.model : "local-model";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_test",
            model,
            choices: [{ message: { role: "assistant", content: "gateway-ok" } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            provider_cost: {
              source: "provider",
              cost_usd: 0.0042,
              generation_id: "gen_test",
              lookup_status: "ok"
            }
          })
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server)
  };
}

test("codexConfigToml declares a Responses provider without requiring auth", () => {
  const toml = codexConfigToml({
    model: "local-model",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    provider: {
      baseUrl: "http://127.0.0.1:9000",
      requiresOpenAiAuth: false
    }
  });

  assert.ok(toml.includes('model = "local-model"'));
  assert.ok(toml.includes('model_provider = "fusionkit-codex"'));
  assert.ok(toml.includes("[model_providers.fusionkit-codex]"));
  assert.ok(toml.includes('base_url = "http://127.0.0.1:9000/v1"'));
  assert.ok(toml.includes('wire_api = "responses"'));
  assert.ok(toml.includes("requires_openai_auth = false"));
});

test("codexConfigToml emits danger-full-access when the panel runs at full trust", () => {
  const toml = codexConfigToml({
    model: "local-model",
    sandboxMode: "danger-full-access",
    approvalPolicy: "never"
  });
  assert.ok(toml.includes('sandbox_mode = "danger-full-access"'));
  assert.ok(toml.includes('approval_policy = "never"'));
});

test("full-trust codex harness writes danger-full-access; guarded falls back to workspace-write", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const configs: Record<string, string> = {};
  const runnerFor = (label: string): CodexExecRunner => (input) => {
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    configs[label] = readFileSync(join(codexHome, "config.toml"), "utf8");
    return { stdout: '{"type":"message","message":"codex-ok"}\n', stderr: "", exitCode: 0 };
  };

  try {
    // Full trust: the panel path passes sandboxMode: danger-full-access.
    await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({
          env: { CODEX_API_KEY: "test-key" },
          runner: runnerFor("full"),
          sandboxMode: "danger-full-access"
        })
      })
    );
    // Guarded: no override, so sandboxModeFor derives from the writes_workspace
    // policy (workspace-write), mirroring the guarded panel path.
    await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({ env: { CODEX_API_KEY: "test-key" }, runner: runnerFor("guarded") })
      })
    );

    assert.ok(configs.full?.includes('sandbox_mode = "danger-full-access"'));
    assert.ok(configs.guarded?.includes('sandbox_mode = "workspace-write"'));
  } finally {
    cleanup();
  }
});

test("codexLaunchConfigToml pins fusion as default and adds a profile per native model", () => {
  const toml = codexLaunchConfigToml("http://127.0.0.1:9999", "fusion-panel", [
    "gpt-5.5",
    "mlx-community/Qwen3-1.7B-4bit"
  ]);
  // Default model + provider is fusion.
  assert.ok(toml.includes('model = "fusion-panel"'));
  assert.ok(toml.includes("[model_providers.fusionkit-local]"));
  // Each model is a profile; fusion first (bare key), then the natives.
  assert.ok(toml.includes("[profiles.fusion-panel]"));
  // Model ids with non-bare-key characters (a dot or a slash) are quoted keys.
  assert.ok(toml.includes('[profiles."gpt-5.5"]'));
  assert.ok(toml.includes('[profiles."mlx-community/Qwen3-1.7B-4bit"]'));
  // No catalog is wired unless a path is passed.
  assert.ok(!toml.includes("model_catalog_json"));
});

test("codexLaunchConfigToml wires model_catalog_json when a catalog path is given", () => {
  const toml = codexLaunchConfigToml("http://127.0.0.1:9999", "fusion-panel", ["gpt-5.5"], "/tmp/cat.json");
  assert.ok(toml.includes('model_catalog_json = "/tmp/cat.json"'));
});

test("codexModelCatalogJson clones the installed template and overrides identity per model", () => {
  // A stand-in for an entry from ~/.codex/models_cache.json (real schema varies
  // by Codex version; we only override identity fields and keep the rest).
  const template = {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "stock",
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    context_window: 272000
  };
  const catalog = JSON.parse(codexModelCatalogJson("fusion-panel", ["gpt-5.5", "claude-opus-4-8"], template)) as {
    models: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    catalog.models.map((entry) => entry.slug),
    ["fusion-panel", "gpt-5.5", "claude-opus-4-8"]
  );
  // Fusion is first (priority 0 = default-ish); identity overridden, schema kept.
  assert.equal(catalog.models[0]?.priority, 0);
  assert.equal(catalog.models[0]?.display_name, "fusion-panel (fusion)");
  // Version-specific schema fields from the template survive untouched.
  assert.ok(catalog.models.every((entry) => entry.context_window === 272000));
  assert.ok(catalog.models.every((entry) => entry.visibility === "list"));
  assert.ok(catalog.models.every((entry) => Array.isArray(entry.supported_reasoning_levels)));
});

test("codexLaunchConfigToml adds a profile per fused ensemble model", () => {
  const toml = codexLaunchConfigToml(
    "http://127.0.0.1:9999",
    "fusion-panel",
    ["gpt-5.5"],
    undefined,
    ["fusion-panel", "fusion-deep", "fusion-cheap"]
  );
  // The session default stays the default model; every ensemble is a profile,
  // so `codex --profile fusion-deep` spawns a session on another ensemble.
  assert.ok(toml.includes('model = "fusion-panel"'));
  assert.ok(toml.includes("[profiles.fusion-panel]"));
  assert.ok(toml.includes("[profiles.fusion-deep]"));
  assert.ok(toml.includes("[profiles.fusion-cheap]"));
  assert.ok(toml.includes('[profiles."gpt-5.5"]'));
  // Fused profiles come before the natives.
  assert.ok(toml.indexOf("[profiles.fusion-deep]") < toml.indexOf('[profiles."gpt-5.5"]'));
});

test("codexModelCatalogJson lists every fused ensemble as a fusion entry", () => {
  const template = { slug: "x", display_name: "x", description: "stock", priority: 9 };
  const catalog = JSON.parse(
    codexModelCatalogJson("fusion-panel", ["gpt-5.5"], template, ["fusion-panel", "fusion-deep"])
  ) as { models: Array<Record<string, unknown>> };
  assert.deepEqual(
    catalog.models.map((entry) => entry.slug),
    ["fusion-panel", "fusion-deep", "gpt-5.5"]
  );
  assert.equal(catalog.models[0]?.display_name, "fusion-panel (fusion)");
  assert.equal(catalog.models[1]?.display_name, "fusion-deep (fusion)");
  assert.equal(catalog.models[2]?.display_name, "gpt-5.5");
  assert.match(String(catalog.models[1]?.description), /ensemble/);
});

// Regression (ENG-620): `model_catalog_json` REPLACES Codex's own catalog, so
// the launcher must merge the stock model list back in — fusion augments the
// picker instead of replacing it.
test("codexModelCatalogJson preserves the stock Codex catalog behind the fusion entries", () => {
  const stock = [
    {
      slug: "gpt-5.3-codex",
      display_name: "GPT-5.3 Codex",
      description: "Fast agentic coding model",
      context_window: 272000,
      visibility: "list",
      priority: 0
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Flagship model",
      context_window: 400000,
      visibility: "list",
      priority: 1
    }
  ];
  const catalog = JSON.parse(
    codexModelCatalogJson("fusion-panel", [], stock[0] as Record<string, unknown>, ["fusion-panel"], stock)
  ) as { models: Array<Record<string, unknown>> };
  // Nothing from the stock catalog disappears: fused first, then every stock model.
  assert.deepEqual(
    catalog.models.map((entry) => entry.slug),
    ["fusion-panel", "gpt-5.3-codex", "gpt-5.5"]
  );
  // Stock entries keep their own identity/metadata (not overwritten by the
  // fusion template) and are renumbered behind the fusion entries.
  assert.equal(catalog.models[1]?.display_name, "GPT-5.3 Codex");
  assert.equal(catalog.models[1]?.context_window, 272000);
  assert.equal(catalog.models[1]?.priority, 1);
  assert.equal(catalog.models[2]?.display_name, "GPT-5.5");
  assert.equal(catalog.models[2]?.context_window, 400000);
  assert.equal(catalog.models[2]?.priority, 2);
  // The description names the actual route, so the source is disambiguated.
  assert.match(String(catalog.models[1]?.description), /Fast agentic coding model/);
  assert.match(String(catalog.models[1]?.description), /Codex login through the FusionKit gateway/);
});

test("codexModelCatalogJson dedupes a native panel model against its stock twin without losing either source", () => {
  const stock = [
    {
      slug: "gpt-5.3-codex",
      display_name: "GPT-5.3 Codex",
      description: "Fast agentic coding model",
      context_window: 272000,
      visibility: "list",
      priority: 0
    },
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      description: "Flagship model",
      context_window: 400000,
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      visibility: "list",
      priority: 1
    }
  ];
  // gpt-5.5 is BOTH a panel native (API-key endpoint) and a stock Codex model.
  const catalog = JSON.parse(
    codexModelCatalogJson(
      "fusion-panel",
      ["gpt-5.5"],
      stock[0] as Record<string, unknown>,
      ["fusion-panel"],
      stock
    )
  ) as { models: Array<Record<string, unknown>> };
  // One entry per slug — no duplicate rows in the picker.
  assert.deepEqual(
    catalog.models.map((entry) => entry.slug),
    ["fusion-panel", "gpt-5.5", "gpt-5.3-codex"]
  );
  // The merged native entry keeps the stock schema metadata (same model)...
  const native = catalog.models[1];
  assert.equal(native?.context_window, 400000);
  assert.deepEqual(native?.supported_reasoning_levels, [{ effort: "high", description: "High" }]);
  // ...while its description names the gateway route (the panel source).
  assert.match(String(native?.description), /FusionKit gateway/);
});

test("readCodexModelsCache + codexSubscriptionModels read the stock catalog behind a Codex login", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-stock-home-"));
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "gpt-5.3-codex", display_name: "GPT-5.3 Codex", visibility: "list" },
          { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
          // Hidden entries never reach the subscription list.
          { slug: "gpt-internal", display_name: "internal", visibility: "hide" },
          // Duplicates and malformed entries are dropped, not crashed on.
          { slug: "gpt-5.5", display_name: "dupe", visibility: "list" },
          { display_name: "no slug" },
          null
        ]
      })
    );
    // No login yet: the models cannot be served, so none are advertised.
    assert.deepEqual(codexSubscriptionModels(home), []);
    writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":{"access_token":"redacted"}}');
    assert.equal(readCodexModelsCache(home).length, 5);
    assert.deepEqual(codexSubscriptionModels(home), [
      { model: "gpt-5.3-codex", auth: "codex" },
      { model: "gpt-5.5", auth: "codex" }
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readCodexModelsCache returns [] for a missing or malformed cache", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-no-cache-home-"));
  try {
    assert.deepEqual(readCodexModelsCache(home), []);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "models_cache.json"), "not json");
    assert.deepEqual(readCodexModelsCache(home), []);
    writeFileSync(join(home, ".codex", "models_cache.json"), '{"models": "nope"}');
    assert.deepEqual(readCodexModelsCache(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("codexLaunchConfigToml pins multi_agent and emits one role per ensemble", () => {
  const roles = [
    {
      name: "fusion-panel",
      modelId: "fusion-panel",
      description: 'Fused answer from the default "default" ensemble (kimi, qwen3).',
      developerInstructions: 'You run on the fused "default" ensemble.',
      configPath: "/tmp/home/agents/fusion-panel.toml"
    },
    {
      name: "fusion-deep",
      modelId: "fusion-deep",
      description: 'Fused answer from the "deep" ensemble (opus, gpt).',
      developerInstructions: 'You run on the fused "deep" ensemble.',
      configPath: "/tmp/home/agents/fusion-deep.toml"
    }
  ];
  const toml = codexLaunchConfigToml(
    "http://127.0.0.1:9999",
    "fusion-panel",
    ["gpt-5.5"],
    undefined,
    ["fusion-panel", "fusion-deep"],
    roles
  );
  // The feature pin makes sub-agents OOTB even under managed/older defaults.
  assert.ok(toml.includes("[features]"));
  assert.ok(toml.includes("multi_agent = true"));
  // Conservative fan-out ceiling: a fused sub-agent is a whole panel run.
  assert.ok(toml.includes("[agents]"));
  assert.ok(toml.includes("max_depth = 1"));
  // One role per ensemble, pinned to its role config file.
  assert.ok(toml.includes("[agents.fusion-panel]"));
  assert.ok(toml.includes("[agents.fusion-deep]"));
  assert.ok(toml.includes('config_file = "/tmp/home/agents/fusion-deep.toml"'));
  assert.ok(toml.includes('description = "Fused answer from the \\"deep\\" ensemble (opus, gpt)."'));
});

test("codexLaunchConfigToml omits features/agents sections without roles", () => {
  const toml = codexLaunchConfigToml("http://127.0.0.1:9999", "fusion-panel", ["gpt-5.5"]);
  assert.ok(!toml.includes("[features]"));
  assert.ok(!toml.includes("[agents"));
});

test("codex exits classify as config failures only on config-shaped stderr (WS9.3)", () => {
  // Config-load rejections (the reason the degraded relaunch ladder exists).
  assert.ok(isCodexConfigFailure(1, "error: duplicate agent role name `fusion-deep` declared in the same config layer"));
  assert.ok(isCodexConfigFailure(1, "Error reading config file at /tmp/x/config.toml: unknown field `slug`"));
  assert.ok(isCodexConfigFailure(2, "failed to deserialize model_catalog_json: missing field `display_name`"));
  // Genuine failures keep their exit code: no relaunch with degraded config.
  assert.ok(!isCodexConfigFailure(1, "error: unexpected argument '--frobnicate' found"));
  assert.ok(!isCodexConfigFailure(1, "connection refused (os error 61)"));
  assert.ok(!isCodexConfigFailure(130, ""));
  // A clean exit is never a config failure, whatever stderr said.
  assert.ok(!isCodexConfigFailure(0, "warning: config.toml uses a deprecated key"));
});

test("codexAgentRoles + codexAgentRoleToml pin each role to its ensemble model", () => {
  const roles = codexAgentRoles(
    "/tmp/home",
    [
      { name: "default", modelId: "fusion-panel", memberIds: ["kimi", "qwen3"] },
      { name: "deep", modelId: "fusion-deep", memberIds: ["opus"], judgeModel: "opus-4" }
    ],
    "fusion-panel"
  );
  assert.deepEqual(
    roles.map((role) => role.name),
    ["fusion-panel", "fusion-deep"]
  );
  // Deliberately NOT under a directory named "agents": Codex auto-discovers
  // *.toml files there as role definitions in their own right, so a file also
  // referenced by [agents.<key>].config_file gets registered twice and Codex
  // rejects it as "duplicate agent role name ... declared in the same config
  // layer". See codexAgentRoles' AGENT_ROLES_DIR comment.
  assert.equal(roles[0]?.configPath, join("/tmp/home", "agent-roles", "fusion-panel.toml"));
  assert.doesNotMatch(roles[0]?.configPath ?? "", /[\\/]agents[\\/]/);
  assert.match(roles[0]?.description ?? "", /default "default" ensemble \(kimi, qwen3\)/);
  assert.match(roles[1]?.description ?? "", /"deep" ensemble \(opus\)/);
  assert.match(roles[1]?.developerInstructions ?? "", /fused "deep" ensemble/);
  const toml = codexAgentRoleToml("fusion-deep", "fusion-deep", roles[1]?.developerInstructions ?? "");
  assert.ok(toml.includes('name = "fusion-deep"'));
  assert.ok(toml.includes('model = "fusion-deep"'));
  assert.ok(toml.includes('model_provider = "fusionkit-local"'));
  assert.ok(toml.includes('developer_instructions = "You run on the fused \\"deep\\" ensemble.'));
});

test("codexModelCatalogJson preserves unknown template fields (multi-agent gating survives)", () => {
  const template = {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "stock",
    multi_agent_version: "v1",
    experimental_supported_tools: ["spawn_agent"],
    context_window: 272000
  };
  const catalog = JSON.parse(codexModelCatalogJson("fusion-panel", [], template)) as {
    models: Array<Record<string, unknown>>;
  };
  // Cloned wholesale: fields our code does not know about survive untouched,
  // so per-model multi-agent enablement metadata carries over.
  assert.equal(catalog.models[0]?.multi_agent_version, "v1");
  assert.deepEqual(catalog.models[0]?.experimental_supported_tools, ["spawn_agent"]);
  assert.equal(catalog.models[0]?.context_window, 272000);
});

test("codexConfigToml (harness) wires the member catalog and sub-agent blocks", () => {
  const toml = codexConfigToml({
    model: "kimi",
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    modelCatalogPath: "/tmp/candidate/model-catalog.json",
    subagents: true,
    provider: {
      baseUrl: "http://127.0.0.1:8080",
      requiresOpenAiAuth: false
    }
  });
  assert.ok(toml.includes('model_catalog_json = "/tmp/candidate/model-catalog.json"'));
  assert.ok(toml.includes("[features]"));
  assert.ok(toml.includes("multi_agent = true"));
  assert.ok(toml.includes("max_depth = 1"));
  assert.ok(toml.includes("max_threads = 3"));
});

test("codexConfigToml (harness) stays minimal without sub-agent inputs", () => {
  const toml = codexConfigToml({
    model: "kimi",
    sandboxMode: "read-only",
    approvalPolicy: "never"
  });
  assert.ok(!toml.includes("model_catalog_json"));
  assert.ok(!toml.includes("[features]"));
  assert.ok(!toml.includes("[agents]"));
});

test("codexMemberCatalogJson names the member's model on a cloned template entry", () => {
  const catalog = JSON.parse(
    codexMemberCatalogJson("kimi", {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      multi_agent_version: "v1",
      context_window: 272000
    })
  ) as { models: Array<Record<string, unknown>> };
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0]?.slug, "kimi");
  assert.equal(catalog.models[0]?.display_name, "kimi");
  // Unknown template fields survive (the multi-agent gating metadata).
  assert.equal(catalog.models[0]?.multi_agent_version, "v1");
  assert.equal(catalog.models[0]?.context_window, 272000);
});

test("codexMemberCatalogJson lists the fused ensemble models behind the member's own", () => {
  const catalog = JSON.parse(
    codexMemberCatalogJson(
      "qwen3",
      { slug: "gpt-5.5", display_name: "GPT-5.5", multi_agent_version: "v1" },
      ["fusion-panel", "fusion-kimi", "qwen3"]
    )
  ) as { models: Array<Record<string, unknown>> };
  // The member's own id is deduped; fused ids follow in order.
  assert.deepEqual(
    catalog.models.map((entry) => entry.slug),
    ["qwen3", "fusion-panel", "fusion-kimi"]
  );
  assert.equal(catalog.models[0]?.priority, 0);
  assert.equal(catalog.models[1]?.multi_agent_version, "v1");
  assert.match(String(catalog.models[1]?.description), /fusion front door/);
});

test("memberChatBackend routes fused model requests to the front door with the depth header", async () => {
  const calls: Array<{ url: string; model: string; depth: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    calls.push({
      url: String(input),
      model: body.model ?? "",
      depth: headers.get("x-fusionkit-panel-depth")
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const backend = memberChatBackend(
      new OpenAiBackend({ baseUrl: "http://127.0.0.1:1111/v1", defaultModel: "qwen3" }),
      {
        gatewayUrl: "http://127.0.0.1:2222",
        ensembles: [
          { name: "default", modelId: "fusion-panel", memberIds: ["kimi", "qwen3"] },
          { name: "kimi", modelId: "fusion-kimi", memberIds: ["kimi"] }
        ],
        defaultModelId: "fusion-panel",
        depth: 1
      }
    );
    await backend.chat({ model: "qwen3", messages: [] });
    await backend.chat({ model: "fusion-kimi", messages: [] });
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? "", /127\.0\.0\.1:1111/);
    assert.equal(calls[0]?.depth, null);
    assert.match(calls[1]?.url ?? "", /127\.0\.0\.1:2222\/v1\/chat\/completions/);
    assert.equal(calls[1]?.depth, "1");
    // The member's model + the fused ids are all advertised/resolvable.
    assert.deepEqual([...backend.listModelIds?.() ?? []], ["qwen3", "fusion-panel", "fusion-kimi"]);
    assert.equal(backend.resolveModel?.("fusion-kimi"), "fusion-kimi");
    assert.equal(backend.resolveModel?.("unknown"), "qwen3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("codex adapter skips clearly when credentials are absent", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const emptyCodexHome = mkdtempSync(join(tmpdir(), "ensemble-codex-empty-home-"));
  let invoked = false;
  const runner: CodexExecRunner = () => {
    invoked = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({ env: { CODEX_HOME: emptyCodexHome }, runner })
      })
    );

    assert.equal(invoked, false);
    assert.equal(result.harnessRunResult.status, "skipped");
    assert.equal(result.candidates[0]?.status, "skipped");
    assert.equal(result.candidates[0]?.error?.kind, "capability_missing");
    assert.match(result.candidates[0]?.error?.message ?? "", /CODEX_API_KEY|OPENAI_API_KEY/);
  } finally {
    cleanup();
    rmSync(emptyCodexHome, { recursive: true, force: true });
  }
});

test("codex adapter accepts local CLI auth without exported API keys", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const sourceHome = mkdtempSync(join(tmpdir(), "ensemble-codex-source-home-"));
  writeFileSync(join(sourceHome, "auth.json"), "{\"auth\":\"redacted-test-token\"}\n");
  let seenAuthFile = false;
  const runner: CodexExecRunner = (input) => {
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    assert.notEqual(codexHome, sourceHome);
    assert.equal(input.env.CODEX_API_KEY, undefined);
    assert.equal(input.env.OPENAI_API_KEY, undefined);
    seenAuthFile = existsSync(join(codexHome, "auth.json"));
    return { stdout: "codex local auth ok", stderr: "", exitCode: 0 };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({ env: { CODEX_HOME: sourceHome }, runner })
      })
    );

    assert.equal(seenAuthFile, true);
    assert.equal(result.harnessRunResult.status, "succeeded");
    assert.equal(result.candidates[0]?.metadata?.provider_kind, "ambient");
  } finally {
    cleanup();
    rmSync(sourceHome, { recursive: true, force: true });
  }
});

test("generic ensemble descriptor swaps mock harness for Codex harness", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  let seenArgs: string[] | undefined;
  let seenStdin: string | undefined;
  let seenConfig = "";
  const runner: CodexExecRunner = (input) => {
    seenArgs = input.args;
    seenStdin = input.stdin;
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    seenConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
    assert.equal(input.env.CODEX_API_KEY, "test-key");
    return { stdout: '{"type":"message","message":"codex-ok"}\n', stderr: "", exitCode: 0 };
  };

  try {
    const base = descriptor(outputRoot);
    const mock = await ensemble.run(base);
    const codex = await ensemble.run({
      ...base,
      harness: codexHarness({ env: { CODEX_API_KEY: "test-key" }, runner })
    });

    assert.equal(mock.harnessRunResult.status, "succeeded");
    assert.equal(codex.harnessRunResult.status, "succeeded");
    assert.deepEqual(seenArgs?.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
    // The prompt travels via stdin (`codex exec -`), never argv.
    assert.equal(seenArgs?.at(-1), "-");
    assert.equal(seenStdin, base.prompt);
    assert.ok(seenConfig.includes('model = "gpt-5.1-codex-max"'));
    assert.equal(codex.candidates[0]?.metadata?.provider_kind, "ambient");
  } finally {
    cleanup();
  }
});

// Regression: a candidate that dies with a blank stderr (e.g. a straggler
// aborted after the grace window, killed via SIGINT) used to produce
// error.message = "" and fail the whole run at contract validation with
// "error.message must be a non-empty string".
test("a failed run with empty stderr still yields a valid candidate record", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const runner: CodexExecRunner = () => ({
    stdout: "",
    stderr: "",
    exitCode: 130,
    aborted: true,
    abortReason: "straggler_abandoned"
  });

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({ env: { CODEX_API_KEY: "test-key" }, runner })
      })
    );

    assert.equal(result.candidates[0]?.status, "failed");
    assert.equal(result.candidates[0]?.error?.kind, "provider_error");
    assert.equal(
      result.candidates[0]?.error?.message,
      "Codex CLI run aborted (straggler_abandoned)."
    );
  } finally {
    cleanup();
  }
});

test("defaultCodexRunner captures stdout/stderr and exit code from a real process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-runner-"));
  const stubCli = join(workdir, "codex-stub");
  writeFileSync(
    stubCli,
    '#!/bin/sh\necho "codex-stdout-ok"\necho "codex-stderr-ok" 1>&2\nexit 0\n'
  );
  chmodSync(stubCli, 0o755);

  try {
    const result = await defaultCodexRunner({
      command: stubCli,
      args: ["exec", "hello"],
      cwd: workdir,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /codex-stdout-ok/);
    assert.match(result.stderr, /codex-stderr-ok/);
    assert.notEqual(result.timedOut, true);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("defaultCodexRunner reports a non-zero exit code from the process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "codex-runner-fail-"));
  const stubCli = join(workdir, "codex-stub");
  writeFileSync(stubCli, '#!/bin/sh\necho "boom" 1>&2\nexit 3\n');
  chmodSync(stubCli, 0o755);

  try {
    const result = await defaultCodexRunner({
      command: stubCli,
      args: ["exec"],
      cwd: workdir,
      env: { PATH: process.env.PATH ?? "" }
    });

    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /boom/);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("Codex OpenAI-compatible provider goes through Responses gateway records", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const upstream = await startOpenAiCompatibleServer();
  initFusionTracing({ serviceName: "codex-test" });
  const session = newSessionCarrier();
  const traceSpans: ReadableSpan[] = [];
  const listener = (span: ReadableSpan): void => {
    if (spanTraceId(span) === session.traceId) traceSpans.push(span);
  };
  addSpanListener(listener);
  let gatewayBaseUrl: string | undefined;
  const runner: CodexExecRunner = async (input) => {
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    const match = /base_url = "([^"]+)"/.exec(config);
    assert.ok(match);
    gatewayBaseUrl = match[1];
    assert.ok(gatewayBaseUrl);
    const response = await fetch(`${gatewayBaseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hello from fake codex",
        stream: false
      })
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.ok(
      traceSpans.some((span) => span.name === "fusion.candidate.step"),
      "gateway capture emits a live trajectory step before Codex exits"
    );
    return { stdout: "codex gateway ok", stderr: "", exitCode: 0 };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({
          env: {},
          provider: {
            kind: "openai-compatible",
            baseUrl: `${upstream.url}/v1`,
            defaultModel: "local-model"
          },
          trace: session.carrier,
          runner
        })
      })
    );

    assert.match(gatewayBaseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(upstream.requests.length, 1);
    assert.equal(result.harnessRunResult.status, "succeeded");
    assert.equal(result.modelCallRecords.length, 1);
    assert.equal(result.modelCallRecords[0]?.metadata?.dialect, "openai-responses");
    assert.equal(result.modelCallRecords[0]?.model, "local-model");
    assert.equal(result.candidates[0]?.metadata?.model_call_count, 1);
    const stepIndex = traceSpans.findIndex((span) => span.name === "fusion.candidate.step");
    const finishedIndex = traceSpans.findIndex((span) => span.name === "fusion.candidate");
    assert.ok(stepIndex >= 0 && finishedIndex >= 0 && stepIndex < finishedIndex);
  } finally {
    removeSpanListener(listener);
    await upstream.close();
    cleanup();
  }
});

test("Codex Responses provider is wrapped for provenance and provider cost capture", async () => {
  const { outputRoot, cleanup } = tempOutputRoot();
  const upstream = await startOpenAiCompatibleServer();
  let gatewayBaseUrl: string | undefined;
  const runner: CodexExecRunner = async (input) => {
    const codexHome = input.env.CODEX_HOME;
    assert.ok(codexHome);
    const config = readFileSync(join(codexHome, "config.toml"), "utf8");
    const match = /base_url = "([^"]+)"/.exec(config);
    assert.ok(match);
    gatewayBaseUrl = match[1];
    const response = await fetch(`${gatewayBaseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "hello from fake codex",
        stream: false
      })
    });
    assert.equal(response.status, 200);
    await response.text();
    return { stdout: "codex gateway ok", stderr: "", exitCode: 0 };
  };

  try {
    const result = await ensemble.run(
      descriptor(outputRoot, {
        harness: codexHarness({
          env: {},
          provider: {
            kind: "responses",
            baseUrl: `${upstream.url}/v1/responses`,
            requiresOpenAiAuth: false
          },
          runner
        })
      })
    );

    assert.match(gatewayBaseUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(upstream.requests.length, 1);
    assert.equal(result.modelCallRecords.length, 1);
    const record = result.modelCallRecords[0];
    assert.equal(record?.metadata?.dialect, "openai-responses");
    const providerCost = record?.metadata?.provider_cost;
    assert.ok(typeof providerCost === "object" && providerCost !== null && !Array.isArray(providerCost));
    assert.equal((providerCost as Record<string, unknown>).generation_id, "gen_test");
    assert.equal(record?.metadata?.cost_estimate, 0.0042);
    assert.equal(result.candidates[0]?.metadata?.model_call_count, 1);
  } finally {
    await upstream.close();
    cleanup();
  }
});
