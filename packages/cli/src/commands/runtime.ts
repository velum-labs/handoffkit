import { Command } from "commander";

import {
  listWorkflows,
  registerBuiltInWorkflows
} from "@fusionkit/ensemble";

import { bold, contentWidth, cyan, dim, wrapText } from "@fusionkit/cli-ui";

import { contextFor } from "../shared/context.js";
import { CliError } from "../shared/errors.js";

const WORKFLOW_DETAILS: Record<string, { scheduler: string; operators: string[]; description: string }> = {
  direct: {
    scheduler: "direct-fast-path",
    operators: ["model.generate"],
    description: "Degree-1 direct model call with no hidden fanout, judge, synth, or verifier work."
  },
  "direct-model-turn": {
    scheduler: "static-dag",
    operators: ["legacy.backend.chat"],
    description: "Compatibility workflow for local/direct model HTTP turns."
  },
  "fusion-frontdoor-request": {
    scheduler: "frontdoor-request",
    operators: [
      "frontdoor.budget-gate",
      "frontdoor.budget-stop",
      "frontdoor.resolve-model",
      "frontdoor.vendor-proxy",
      "frontdoor.dispatch.fusion"
    ],
    description: "Top-level request graph: budget gate + requested-model resolution are first-class operators, and a routing scheduler dispatches to budget-stop, the fusion turn, or the vendor proxy (whose pre-stream failover re-enters the fusion turn)."
  },
  "fusion-frontdoor-turn": {
    scheduler: "static-dag",
    operators: ["frontdoor.panel", "frontdoor.fuse", "frontdoor.fuse.stream", "frontdoor.finalize"],
    description: "Native fusion front-door turn: panel -> fuse -> finalize (buffered), or panel -> fuse.stream (streamed via the streaming runtime + SSE adapter)."
  },
  "native-passthrough-turn": {
    scheduler: "static-dag",
    operators: ["legacy.backend.chat"],
    description: "Compatibility workflow for direct native provider passthrough (Codex/MLX harness leaves) wrapped through KernelBackend."
  },
  "execution-select-repair": {
    scheduler: "execution-select-repair",
    operators: ["panel.generate", "evidence", "select", "repair"],
    description: "Generate candidates, record public evidence, select explicitly, and run bounded repair."
  },
  "execution-select": {
    scheduler: "execution-select-repair",
    operators: ["panel.generate", "evidence", "select"],
    description: "Generate candidates, record public evidence, and select without a repair branch."
  },
  "legacy-ensemble-run": {
    scheduler: "static-dag",
    operators: ["legacy.ensemble.run"],
    description: "Compatibility workflow that routes runEnsemble through the runtime kernel."
  },
  "legacy-trajectory-fuse-step": {
    scheduler: "static-dag",
    operators: ["legacy.python.trajectories_fuse"],
    description: "Compatibility workflow for the Python trajectories:fuse sidecar step."
  },
  "panel-capture": {
    scheduler: "static-dag",
    operators: ["panel.generate"],
    description: "Current production panel capture workflow; emits candidate trajectories for the gateway fuse step."
  },
  "panel-judge-synth": {
    scheduler: "static-dag",
    operators: ["panel.generate", "judge.compare", "synthesize"],
    description: "OpenRouter-style panel -> judge -> synthesize graph."
  },
  "rank-fuse": {
    scheduler: "rank-fuse",
    operators: ["panel.generate", "rank", "select", "fuse"],
    description: "LLM-Blender-style sample/panel -> rank -> select -> fuse graph."
  }
};

function runtimeWorkflowIds(): string[] {
  registerBuiltInWorkflows();
  return [...new Set([...listWorkflows(), ...Object.keys(WORKFLOW_DETAILS)])].sort();
}

export function registerRuntime(program: Command): void {
  const runtime = program
    .command("runtime")
    .description("advanced/maintainer: inspect runtime-kernel workflows and composition primitives");

  runtime
    .command("list")
    .description("list built-in runtime workflows")
    .option("--json", "emit machine-readable JSON")
    .action((_opts: { json?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const ids = runtimeWorkflowIds();
      if (ctx.json) {
        ctx.emit({
          workflows: ids.map((id) => ({ id, ...(WORKFLOW_DETAILS[id] ?? {}) }))
        });
        return;
      }
      const { presenter } = ctx;
      presenter.header();
      presenter.heading("runtime workflows");
      const width = contentWidth();
      for (const id of ids) {
        const detail = WORKFLOW_DETAILS[id];
        presenter.blank();
        presenter.line(
          detail === undefined ? `  ${bold(id)}` : `  ${bold(id)}  ${dim(`(${detail.scheduler})`)}`
        );
        for (const line of wrapText(detail?.description ?? "", width - 4)) {
          if (line.length > 0) presenter.line(dim(`    ${line}`));
        }
      }
      presenter.blank();
      presenter.note(`inspect one with ${bold("fusionkit runtime explain <workflow>")}`);
    });

  runtime
    .command("explain")
    .argument("<workflow>", "built-in workflow id")
    .description("explain a built-in workflow's scheduler and operator kinds")
    .option("--json", "emit machine-readable JSON")
    .action((workflow: string, _opts: { json?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      const ids = runtimeWorkflowIds();
      if (!ids.includes(workflow)) {
        throw new CliError({
          code: "unknown-workflow",
          message: `unknown built-in workflow "${workflow}"`,
          hint: "workflow ids come from the runtime kernel's built-in registry",
          tryCommand: "fusionkit runtime list"
        });
      }
      const detail = WORKFLOW_DETAILS[workflow];
      if (detail === undefined) {
        throw new CliError({
          code: "unknown-workflow",
          message: `workflow "${workflow}" is registered but has no explain metadata yet`,
          tryCommand: "fusionkit runtime list"
        });
      }
      if (ctx.json) {
        ctx.emit({ id: workflow, ...detail });
        return;
      }
      const { presenter } = ctx;
      presenter.header();
      presenter.keyValue([
        { label: "workflow", value: bold(workflow) },
        { label: "scheduler", value: detail.scheduler }
      ]);
      presenter.blank();
      presenter.heading("operators");
      for (const operator of detail.operators) presenter.line(`  ${cyan(operator)}`);
      presenter.blank();
      const width = contentWidth();
      for (const line of wrapText(detail.description, width)) presenter.line(dim(line));
    });
}
