import type { Command } from "commander";

import { dim } from "@fusionkit/cli-ui";

import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import { collectVersionMatrix } from "../shared/package-version.js";

async function runVersion(ctx: CommandContext): Promise<number> {
  const matrix = await collectVersionMatrix();

  if (ctx.json) {
    ctx.emit(matrix);
    return 0;
  }

  const { presenter } = ctx;
  presenter.blank();
  presenter.header("versions");
  presenter.blank();
  presenter.keyValue([
    { label: "@fusionkit/cli", value: matrix.cli },
    { label: "synthesizer (pinned)", value: `fusionkit@${matrix.synthesizerPinned}` },
    { label: "synthesizer (cached)", value: matrix.synthesizerCached ?? dim("not provisioned") }
  ]);

  presenter.blank();
  presenter.line(dim("runners"));
  presenter.keyValue(
    Object.entries(matrix.runners).map(([name, version]) => ({
      label: name,
      value: version ?? dim("not installed")
    }))
  );

  presenter.blank();
  presenter.line(dim("coding agents"));
  presenter.keyValue(
    Object.entries(matrix.agents).map(([name, version]) => ({
      label: name,
      value: version ?? dim("not installed")
    }))
  );

  presenter.blank();
  presenter.line(dim("tool integrations"));
  presenter.keyValue(
    Object.entries(matrix.tools).map(([name, version]) => ({
      label: `@fusionkit/tool-${name}`,
      value: version ?? dim("unknown")
    }))
  );

  return 0;
}

export function registerVersion(program: Command): void {
  program
    .command("version")
    .description("show versions for fusionkit, the synthesizer, runners, agents, and tool packages")
    .option("--json", "emit machine-readable JSON")
    .action(async (_opts: { json?: boolean }, command: Command) => {
      process.exit(await runVersion(contextFor(command)));
    });
}
