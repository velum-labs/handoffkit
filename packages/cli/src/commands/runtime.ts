import { Command } from "commander";

import {
  listWorkflows,
  registerBuiltInWorkflows
} from "@fusionkit/ensemble";

const WORKFLOW_DETAILS: Record<string, { scheduler: string; operators: string[]; description: string }> = {
  direct: {
    scheduler: "direct-fast-path",
    operators: ["model.generate"],
    description: "Degree-1 direct model call with no hidden fanout, judge, synth, or verifier work."
  },
  "execution-select-repair": {
    scheduler: "execution-select-repair",
    operators: ["panel.generate", "evidence", "select", "repair"],
    description: "Generate candidates, record public evidence, select explicitly, and run bounded repair."
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
    .action(() => {
      registerBuiltInWorkflows();
      for (const id of listWorkflows()) {
        const detail = WORKFLOW_DETAILS[id];
        console.log(detail === undefined ? id : `${id}\t${detail.scheduler}\t${detail.description}`);
      }
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
      console.log(JSON.stringify({ id: workflow, ...detail }, null, 2));
    });
}
