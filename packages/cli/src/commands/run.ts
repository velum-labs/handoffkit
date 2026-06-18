import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Command } from "commander";

import { agents, handoff, targets } from "@warrant/handoff";
import { AGENT_KINDS } from "@warrant/protocol";
import type { AgentKind, AgentSpec, RunRequestInput } from "@warrant/protocol";
import { captureWorkspace } from "@warrant/workspace";

import { loadHome } from "../config.js";
import { renderDisclosure, renderReceipt, renderTrace } from "../render.js";
import { fail } from "../shared/errors.js";
import { collect, isolationFlag } from "../shared/options.js";
import {
  CONTINUE_WAIT_TIMEOUT_MS,
  clientFor,
  resolveDir,
  waitForTerminal
} from "../shared/plane.js";

type RunOpts = {
  agent?: string;
  pool: string;
  secret?: string[];
  allowHost?: string[];
  allowUntracked?: string[];
  repo: string;
  isolation?: string;
  dryRun?: boolean;
  watch: boolean;
  transcript?: string;
  reason?: string;
};

function agentSpecFor(kind: string): AgentSpec {
  switch (kind as AgentKind) {
    case "claude-code":
      return agents.claudeCode();
    case "codex":
      return agents.codex();
    case "pi":
      return agents.pi();
    case "mock":
      return agents.mock();
    case "command":
      return agents.command();
    default:
      fail(`unknown agent kind "${kind}" (expected ${AGENT_KINDS.join(" | ")})`);
  }
}

function addRunOptions(cmd: Command): Command {
  return cmd
    .option("--agent <kind>", `agent kind (${AGENT_KINDS.join(" | ")})`)
    .option("--pool <pool>", "runner pool", "default")
    .option("--secret <name>", "release a secret into the session (repeatable)", collect)
    .option("--allow-host <host>", "allow egress to host (repeatable)", collect)
    .option(
      "--allow-untracked <glob>",
      "include untracked files matching glob (repeatable)",
      collect
    )
    .option("--repo <dir>", "workspace repository", ".")
    .option("--isolation <tier>", "session isolation: process | hermetic | vercel-sandbox")
    .option("--dry-run", "show what would move; move nothing")
    .option("--no-watch", "do not wait for completion");
}

export function registerRun(program: Command): void {
  addRunOptions(
    program
      .command("run")
      .description("request a governed run")
      .argument("[task...]", "task prompt")
  ).action(async (task: string[], opts: RunOpts) => {
    const dir = resolveDir(program.opts().dir);
    if (!opts.agent) fail(`--agent is required (${AGENT_KINDS.join(" | ")})`);
    const prompt = task.join(" ").trim();
    if (!prompt) fail("a task prompt is required");

    const home = loadHome(dir);
    const client = clientFor(dir);
    const repoDir = resolve(opts.repo);

    const captured = captureWorkspace(repoDir, {
      allowUntracked: opts.allowUntracked ?? []
    });

    const isolation = isolationFlag(opts.isolation);
    const request: RunRequestInput = {
      requestedBy: { kind: "human", id: home.config.requestedBy },
      agentKind: opts.agent,
      prompt,
      pool: opts.pool,
      secretNames: opts.secret ?? [],
      workspace: captured.manifest,
      network: {
        defaultDeny: home.policy.network.defaultDeny,
        allowHosts: opts.allowHost ?? []
      },
      budget: {},
      disclosure: "minimal-context",
      ...(isolation ? { isolation } : {})
    };

    if (opts.dryRun) {
      const report = await client.dryRun(request);
      console.log(renderDisclosure(report));
      return;
    }

    await client.putBlob(captured.bundle);
    if (captured.dirtyDiff) await client.putBlob(captured.dirtyDiff);
    for (const file of captured.untracked) await client.putBlob(file.content);

    const created = await client.requestRun(request);
    console.log(`run ${created.runId} [${created.status}]`);

    if (!opts.watch) return;
    const status = await waitForTerminal(client, created.runId, (s) => console.log(`  ${s}`));
    if (status === "completed" || status === "failed") {
      const bundle = await client.getBundle(created.runId);
      console.log("");
      console.log(renderReceipt(bundle));
    }
  });

  addRunOptions(
    program
      .command("continue")
      .description("hand local work to a governed runner")
      .argument("[task...]", "task prompt")
  )
    .option("--transcript <file>", "carry a session transcript as semantic state")
    .option("--reason <text>", "why the runtime boundary changes")
    .action(async (task: string[], opts: RunOpts) => {
      const dir = resolveDir(program.opts().dir);
      if (!opts.agent) fail(`--agent is required (${AGENT_KINDS.join(" | ")})`);
      const prompt = task.join(" ").trim();
      if (!prompt) fail("a task prompt is required");

      const home = loadHome(dir);
      const repoDir = resolve(opts.repo);
      const target = targets.pool(opts.pool);
      const transcript = opts.transcript ? readFileSync(opts.transcript, "utf8") : undefined;

      const h = handoff({
        workspace: repoDir,
        plane: { url: home.config.planeUrl, adminToken: home.config.adminToken },
        actor: { kind: "human", id: home.config.requestedBy },
        agent: agentSpecFor(opts.agent),
        secrets: opts.secret ?? [],
        allowHosts: opts.allowHost ?? [],
        allowUntracked: opts.allowUntracked ?? []
      });

      const isolation = isolationFlag(opts.isolation);
      const continueOptions = {
        task: prompt,
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(transcript !== undefined ? { transcript } : {}),
        ...(isolation ? { session: isolation } : {})
      };

      if (opts.dryRun) {
        const { report } = await h.dryRun(target, continueOptions);
        console.log(renderDisclosure(report));
        return;
      }

      const run = await h.continueIn(target, continueOptions);
      console.log(
        `continuation ${run.envelope.envelopeId} → ${target.id} as run ${run.runId}`
      );

      if (!opts.watch) return;
      const outcome = await run.wait({ timeoutMs: CONTINUE_WAIT_TIMEOUT_MS });
      if (outcome.status === "awaiting_approval") {
        console.log(
          `awaiting approval (${outcome.consentRequirements.join("; ")}) — run: warrant approve ${run.runId}`
        );
        return;
      }
      console.log("");
      console.log(renderTrace(h.trace()));
      if (outcome.status === "completed" || outcome.status === "failed") {
        console.log("");
        console.log(renderReceipt(await run.receipt()));
        console.log("");
        console.log(`pull results: warrant pull ${run.runId}`);
      }
    });
}
