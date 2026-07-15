/**
 * Live OOTB sub-agent smokes (env-gated; they spawn the real `codex` / `claude`
 * binaries).
 *
 * The gateway under test is a real dialect-aware `startGateway` +
 * `FusionBackend` with two fused ensembles (`fusion-panel`, `fusion-kimi`), a
 * stubbed panel runner (records which ensemble each turn ran on), and a mock
 * `trajectories:fuse` step. The step is deterministic: a default-ensemble turn
 * that advertises a spawn tool answers with a spawn call targeting
 * `fusion-kimi`; a turn that only advertises `tool_search` (Codex defers its
 * multi-agent tools behind typed discovery) answers with a discovery call
 * first — exercising the full typed-tool passthrough loop; every other request
 * answers plain text. The assertion is the one that matters end-to-end: the
 * spawned sub-agent's own turn reaches the gateway routed to the `fusion-kimi`
 * ensemble.
 *
 *   FUSIONKIT_SUBAGENTS_LIVE_CODEX=1  — real codex exec + spawn_agent role
 *   FUSIONKIT_SUBAGENTS_LIVE_CLAUDE=1 — real claude -p + --agents Task tool
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createKernelFuseStepRunner } from "@fusionkit/ensemble";
import { FusionBackend } from "@fusionkit/gateway";
import type { FusedModelRoute, PanelRunInput, WireTrajectory } from "@fusionkit/gateway";
import { OpenAiBackend, startGateway } from "@routekit/gateway";
import {
  codexAgentRoles,
  codexAgentRoleToml,
  codexConfigToml,
  codexLaunchConfigToml,
  codexMemberCatalogJson,
  codexModelCatalogJson,
  memberChatBackend,
  readCodexCatalogTemplate
} from "@fusionkit/tool-codex";
import { claudeAgentsJson, claudeEnv } from "@fusionkit/tool-claude";

const LIVE_CODEX =
  process.env.FUSIONKIT_SUBAGENTS_LIVE_CODEX === "1"
    ? false
    : "set FUSIONKIT_SUBAGENTS_LIVE_CODEX=1 with a working codex CLI";
const LIVE_CLAUDE =
  process.env.FUSIONKIT_SUBAGENTS_LIVE_CLAUDE === "1"
    ? false
    : "set FUSIONKIT_SUBAGENTS_LIVE_CLAUDE=1 with a working claude CLI";

const ENSEMBLES = [
  { name: "default", modelId: "fusion-panel", memberIds: ["kimi", "qwen3"] },
  { name: "kimi", modelId: "fusion-kimi", memberIds: ["kimi"] }
] as const;

const ROUTES: FusedModelRoute[] = [
  {
    modelId: "fusion-panel",
    name: "default",
    memberEndpointIds: ["kimi", "qwen3"],
    judgeEndpointId: "kimi",
    judgeModelName: "kimi-model"
  },
  {
    modelId: "fusion-kimi",
    name: "kimi",
    memberEndpointIds: ["kimi"],
    judgeEndpointId: "kimi",
    judgeModelName: "kimi-model"
  }
];

function candidate(modelId: string): WireTrajectory {
  return { trajectory_id: `t_${modelId}`, model_id: modelId, status: "succeeded", final_output: "ok" };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type ToolDef = { name?: string; function?: { name?: string; parameters?: unknown }; parameters?: unknown };

/** The flat {name, parameters} of a (possibly OpenAI-nested) tool definition. */
function flatTool(tool: ToolDef): { name: string; parameters: Record<string, unknown> } | undefined {
  const fn = tool.function ?? tool;
  const name = fn.name ?? tool.name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const parameters =
    typeof fn.parameters === "object" && fn.parameters !== null
      ? (fn.parameters as Record<string, unknown>)
      : {};
  return { name, parameters };
}

/**
 * Build arguments for a spawn-style tool from its own advertised JSON schema:
 * task/prompt-ish string properties get the sub-agent instruction, agent/role/
 * model-ish properties get the target, other required strings get the target.
 * Schema-driven so it tracks the installed CLI's exact parameter names.
 */
function spawnArgumentsFor(
  parameters: Record<string, unknown>,
  target: string,
  instruction: string
): Record<string, unknown> {
  const properties =
    typeof parameters.properties === "object" && parameters.properties !== null
      ? (parameters.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(parameters.required) ? (parameters.required as string[]) : [];
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(properties)) {
    const lower = key.toLowerCase();
    // A closed enum that doesn't admit the target can't carry it (e.g. Claude's
    // Agent `model` enum — its ensemble routing rides the agent definition).
    const options =
      typeof schema === "object" && schema !== null && Array.isArray((schema as { enum?: unknown }).enum)
        ? ((schema as { enum: unknown[] }).enum as unknown[])
        : undefined;
    const admits = (value: string): boolean => options === undefined || options.includes(value);
    if (/(task|prompt|message|instruction|description)/.test(lower) && admits(instruction)) {
      args[key] = instruction;
    } else if (/(agent|role|model|type)/.test(lower) && admits(target)) {
      args[key] = target;
    }
  }
  for (const key of required) {
    if (args[key] === undefined) args[key] = target;
  }
  return args;
}

type LiveStack = {
  gatewayUrl: string;
  panelEnsembles: () => string[];
  panelRuns: () => Array<{ ensemble: string; depth: number }>;
  close: () => Promise<void>;
};


/**
 * The live-gateway fixture: FusionBackend with both ensembles, a panel stub
 * recording each turn's resolved ensemble, and a scripted mock fuse step:
 * - a default-ensemble turn that advertises a spawn tool (`spawnToolNames`)
 *   answers with one spawn call targeting `target`;
 * - otherwise, if the turn advertises `tool_search` (Codex defers its
 *   multi-agent tools behind typed discovery, which the gateway projects
 *   through under that name), it answers with a `tool_search` call — the CLI
 *   executes it client-side and the follow-up turn advertises the spawn tool;
 * - everything else answers plain text.
 */
async function startLiveStack(spawnToolNames: readonly string[], target: string): Promise<LiveStack> {
  const panelRuns: Array<{ ensemble: string; depth: number }> = [];
  let spawned = false;
  let searched = false;

  const step = createServer((req, res) => {
    void (async () => {
      const body = JSON.parse(await readBody(req)) as {
        model?: string;
        stream?: boolean;
        tools?: ToolDef[];
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const tools = (body.tools ?? []).map(flatTool).filter((tool) => tool !== undefined);
      // After a tool_search execution the gateway advertises the discovered
      // tools (spawn_agent et al.) on the follow-up fused turn's tool list.
      const spawnTool = tools.find((tool) => spawnToolNames.includes(tool.name));
      const discoveryTool = tools.find((tool) => tool.name === "tool_search");
      let message: Record<string, unknown>;
      let finish = "stop";
      if (!spawned && body.model === "fusion-panel" && spawnTool !== undefined) {
        spawned = true;
        message = {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_spawn_1",
              type: "function",
              function: {
                name: spawnTool.name,
                arguments: JSON.stringify(
                  spawnArgumentsFor(spawnTool.parameters, target, "Reply with exactly OK and stop.")
                )
              }
            }
          ]
        };
        finish = "tool_calls";
      } else if (!searched && !spawned && body.model === "fusion-panel" && discoveryTool !== undefined) {
        searched = true;
        message = {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_search_1",
              type: "function",
              function: {
                name: discoveryTool.name,
                arguments: JSON.stringify({ query: "spawn sub-agent multi-agent" })
              }
            }
          ]
        };
        finish = "tool_calls";
      } else {
        message = { role: "assistant", content: "OK" };
      }
      const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
      if (body.stream === true) {
        // The gateway's streaming fuse path pipes SSE bytes verbatim, so a
        // streamed step must answer in chat.completion.chunk SSE.
        const delta: Record<string, unknown> = { role: "assistant" };
        if (typeof message.content === "string" && message.content.length > 0) delta.content = message.content;
        if (Array.isArray(message.tool_calls)) {
          delta.tool_calls = (message.tool_calls as Array<{ id: string; function: unknown }>).map(
            (call, index) => ({ index, ...call })
          );
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl_live", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        );
        res.write(
          `data: ${JSON.stringify({ id: "chatcmpl_live", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`
        );
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl_live",
          model: body.model ?? "fusion-panel",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage
        })
      );
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => step.listen(0, "127.0.0.1", resolve));
  const stepAddress = step.address();
  const stepPort = typeof stepAddress === "object" && stepAddress !== null ? stepAddress.port : 0;

  const backend = new FusionBackend({
    stepUrl: `http://127.0.0.1:${stepPort}/v1/fusion/trajectories:fuse`,
    runPanels: async (input: PanelRunInput) => {
      panelRuns.push({ ensemble: input.ensembleModelId ?? "(none)", depth: input.panelDepth ?? 0 });
      return [candidate("kimi")];
    },
    runFuseStep: createKernelFuseStepRunner(),
    defaultModel: "fusion-panel",
    fusedModels: ROUTES
  });
  const gateway = await startGateway({ backend, host: "127.0.0.1", port: 0 });
  return {
    gatewayUrl: gateway.url(),
    panelEnsembles: () => panelRuns.map((run) => run.ensemble),
    panelRuns: () => panelRuns,
    close: async () => {
      await gateway.close();
      await new Promise<void>((resolve) => step.close(() => resolve()));
    }
  };
}

function runCli(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs: number;
}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    if (input.stdin !== undefined) child.stdin.write(input.stdin);
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), input.timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

test(
  "live: codex spawn_agent on a fusion role runs the sub-agent turn on that ensemble",
  { skip: LIVE_CODEX },
  async () => {
    const stack = await startLiveStack(["spawn_agent"], "fusion-kimi");
    const repo = mkdtempSync(join(tmpdir(), "subagents-live-repo-"));
    const home = mkdtempSync(join(tmpdir(), "subagents-live-codex-"));
    try {
      // The exact ephemeral CODEX_HOME the launcher produces: catalog + role
      // files + config with the feature pin and one role per ensemble.
      const template = readCodexCatalogTemplate();
      assert.ok(template, "codex models_cache.json template is required for the live smoke");
      const catalogPath = join(home, "model-catalog.json");
      writeFileSync(
        catalogPath,
        codexModelCatalogJson("fusion-panel", [], template, ["fusion-panel", "fusion-kimi"])
      );
      const roles = codexAgentRoles(home, ENSEMBLES, "fusion-panel");
      const roleDir = dirname(roles[0]?.configPath ?? join(home, "agent-roles", "x"));
      mkdirSync(roleDir, { recursive: true });
      for (const role of roles) {
        writeFileSync(role.configPath, codexAgentRoleToml(role.name, role.modelId, role.developerInstructions));
      }
      writeFileSync(
        join(home, "config.toml"),
        codexLaunchConfigToml(stack.gatewayUrl, "fusion-panel", catalogPath, roles)
      );

      const result = await runCli({
        command: "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "-"],
        cwd: repo,
        env: { CODEX_HOME: home },
        stdin: "Spawn a sub-agent on the fusion-kimi role, ask it to reply OK, then report.",
        timeoutMs: 120_000
      });
      assert.equal(result.code, 0, result.stderr);
      // The one assertion that matters: the sub-agent's own turn reached the
      // gateway routed to the kimi-only ensemble.
      assert.ok(
        stack.panelEnsembles().includes("fusion-kimi"),
        `expected a fusion-kimi panel turn; saw ${JSON.stringify(stack.panelEnsembles())}\n${result.stdout}`
      );
    } finally {
      await stack.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test(
  "live: a codex PANEL MEMBER spawns a fusion-kimi sub-agent through its capture gateway",
  { skip: LIVE_CODEX },
  async () => {
    const stack = await startLiveStack(["spawn_agent"], "fusion-kimi");
    const repo = mkdtempSync(join(tmpdir(), "subagents-live-repo-"));
    const home = mkdtempSync(join(tmpdir(), "subagents-live-member-"));

    // The member's model: an OpenAI chat mock playing the panel member's LLM.
    // Codex defers its multi-agent tools behind tool_search for members too,
    // so the mock discovers first (the member's capture gateway runs the same
    // typed-tool passthrough as the front door), then spawns on fusion-kimi;
    // codex itself (the real binary) executes both and drives the sub-agent
    // thread on the fused model.
    let memberSpawned = false;
    let memberSearched = false;
    let memberWaited = false;
    const memberModel = createServer((req, res) => {
      void (async () => {
        const body = JSON.parse(await readBody(req)) as {
          model?: string;
          stream?: boolean;
          tools?: ToolDef[];
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        const tools = (body.tools ?? []).map(flatTool).filter((tool) => tool !== undefined);
        const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
        const discoveryTool = tools.find((tool) => tool.name === "tool_search");
        // After the spawn result arrives ({"agent_id": ...}), wait on it —
        // otherwise `codex exec` ends the parent turn before the sub-agent's
        // first fused model call ever leaves the process.
        const spawnedAgentId = (body.messages ?? [])
          .filter((entry) => entry.role === "tool" && typeof entry.content === "string")
          .map((entry) => {
            try {
              return (JSON.parse(entry.content as string) as { agent_id?: string }).agent_id;
            } catch {
              return undefined;
            }
          })
          .find((id): id is string => typeof id === "string");
        let message: Record<string, unknown>;
        let finish = "stop";
        if (spawnTool !== undefined && memberSpawned && !memberWaited && spawnedAgentId !== undefined) {
          memberWaited = true;
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_member_wait",
                type: "function",
                function: {
                  name: "wait_agent",
                  arguments: JSON.stringify({ targets: [spawnedAgentId], timeout_ms: 60000 })
                }
              }
            ]
          };
          finish = "tool_calls";
        } else if (!memberSpawned && spawnTool !== undefined) {
          memberSpawned = true;
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_member_spawn",
                type: "function",
                function: {
                  name: "spawn_agent",
                  // A member has no agent roles — the fused ensemble is chosen
                  // via the `model` override (validated against the member's
                  // catalog, which now lists the fused ids).
                  arguments: JSON.stringify({
                    model: "fusion-kimi",
                    message: "Reply with exactly OK and stop."
                  })
                }
              }
            ]
          };
          finish = "tool_calls";
        } else if (!memberSearched && !memberSpawned && discoveryTool !== undefined) {
          memberSearched = true;
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_member_search",
                type: "function",
                function: {
                  name: "tool_search",
                  arguments: JSON.stringify({ query: "spawn sub-agent multi-agent" })
                }
              }
            ]
          };
          finish = "tool_calls";
        } else {
          message = { role: "assistant", content: "OK" };
        }
        const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
        if (body.stream === true) {
          const delta: Record<string, unknown> = { role: "assistant" };
          if (typeof message.content === "string" && message.content.length > 0) delta.content = message.content;
          if (Array.isArray(message.tool_calls)) {
            delta.tool_calls = (message.tool_calls as Array<{ id: string; function: unknown }>).map(
              (call, index) => ({ index, ...call })
            );
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({ id: "chatcmpl_member", model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({ id: "chatcmpl_member", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`
          );
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl_member",
            model: body.model ?? "qwen3",
            choices: [{ index: 0, message, finish_reason: finish }],
            usage
          })
        );
      })().catch(() => {
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => memberModel.listen(0, "127.0.0.1", resolve));
    const memberAddress = memberModel.address();
    const memberPort = typeof memberAddress === "object" && memberAddress !== null ? memberAddress.port : 0;

    // The member's capture gateway, exactly as the codex panel harness builds
    // it: own-model traffic to the member endpoint, fused ids routed to the
    // front door with the panel-depth header.
    const captureGateway = await startGateway({
      backend: memberChatBackend(
        new OpenAiBackend({ baseUrl: `http://127.0.0.1:${memberPort}/v1`, defaultModel: "qwen3" }),
        {
          gatewayUrl: stack.gatewayUrl,
          ensembles: ENSEMBLES,
          defaultModelId: "fusion-panel",
          depth: 1
        }
      ),
      host: "127.0.0.1",
      port: 0
    });

    try {
      const template = readCodexCatalogTemplate();
      assert.ok(template, "codex models_cache.json template is required for the live smoke");
      const catalogPath = join(home, "model-catalog.json");
      writeFileSync(
        catalogPath,
        codexMemberCatalogJson("qwen3", template, ["fusion-panel", "fusion-kimi"])
      );
      writeFileSync(
        join(home, "config.toml"),
        codexConfigToml({
          model: "qwen3",
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
          modelCatalogPath: catalogPath,
          subagents: true,
          provider: { baseUrl: captureGateway.url(), requiresOpenAiAuth: false }
        })
      );

      const result = await runCli({
        command: "codex",
        args: ["exec", "--json", "--skip-git-repo-check", "-"],
        cwd: repo,
        env: { CODEX_HOME: home },
        stdin: "Spawn a sub-agent on the fusion-kimi model, ask it to reply OK, then report.",
        timeoutMs: 120_000
      });
      assert.equal(result.code, 0, result.stderr);
      // The member's fused sub-agent turn reached the front door on the
      // kimi-only ensemble, carrying panel depth 1 (so its own panel members
      // will NOT get fused access — one level of delegation only).
      const kimiRun = stack.panelRuns().find((run) => run.ensemble === "fusion-kimi");
      assert.ok(
        kimiRun !== undefined,
        `expected a fusion-kimi panel turn; saw ${JSON.stringify(stack.panelRuns())}\n${result.stdout}`
      );
      assert.equal(kimiRun.depth, 1, "the member's fused turn must carry panel depth 1");
    } finally {
      await captureGateway.close();
      await new Promise<void>((resolve) => memberModel.close(() => resolve()));
      await stack.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
);

test(
  "live: claude Task on a fusion agent runs the sub-agent turn on that ensemble",
  { skip: LIVE_CLAUDE },
  async () => {
    // Claude Code's sub-agent tool: `Task` historically, `Agent` in newer CLIs.
    const stack = await startLiveStack(["Task", "Agent"], "fusion-kimi");
    const repo = mkdtempSync(join(tmpdir(), "subagents-live-repo-"));
    try {
      const result = await runCli({
        command: "claude",
        args: [
          "-p",
          "Use the fusion-kimi agent to reply OK, then report its reply.",
          "--output-format",
          "text",
          "--permission-mode",
          "bypassPermissions",
          "--model",
          "claude-fusion-panel",
          "--agents",
          claudeAgentsJson(ENSEMBLES, "fusion-panel")
        ],
        cwd: repo,
        env: claudeEnv(stack.gatewayUrl),
        timeoutMs: 120_000
      });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(
        stack.panelEnsembles().includes("fusion-kimi"),
        `expected a fusion-kimi panel turn; saw ${JSON.stringify(stack.panelEnsembles())}\n${result.stdout}`
      );
    } finally {
      await stack.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }
);
