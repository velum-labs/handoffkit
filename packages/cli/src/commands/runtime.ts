import { Command } from "commander";

import {
  listWorkflows,
  registerBuiltInWorkflows
} from "@fusionkit/ensemble";

import { dim } from "@fusionkit/cli-ui";

import { contextFor } from "../shared/context.js";

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

export function registerRuntime(program: Command): void {
  const runtime = program
    .command("runtime")
    .description("inspect FusionKit runtime-kernel workflows and composition primitives");

  runtime
    .command("list")
    .description("list built-in runtime workflows")
    .option("--json", "emit machine-readable JSON")
    .action((_opts: { json?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      registerBuiltInWorkflows();
      const ids = [...new Set([...listWorkflows(), ...Object.keys(WORKFLOW_DETAILS)])].sort();
      if (ctx.json) {
        ctx.emit({
          workflows: ids.map((id) => ({ id, ...(WORKFLOW_DETAILS[id] ?? {}) }))
        });
        return;
      }
      ctx.presenter.table(
        ids.map((id) => {
          const detail = WORKFLOW_DETAILS[id];
          return detail === undefined ? [id] : [id, detail.scheduler, dim(detail.description)];
        })
      );
    });

  runtime
    .command("explain")
    .argument("<workflow>", "built-in workflow id")
    .description("explain a built-in workflow's scheduler and operator kinds")
    .action((workflow: string) => {
      registerBuiltInWorkflows();
      const detail = WORKFLOW_DETAILS[workflow];
      if (detail === undefined) {
        throw new Error(`unknown built-in workflow ${workflow}; run 'fusionkit runtime list'`);
      }
      // The explanation is a machine payload by design (stdout JSON).
      process.stdout.write(JSON.stringify({ id: workflow, ...detail }, null, 2) + "\n");
    });
}
