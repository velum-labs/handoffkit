import type { Command } from "commander";

import { dim } from "@velum-labs/routekit-cli-ui";
import { contextFor, formatPackageVersion } from "@velum-labs/routekit-cli-core";
import type { CommandContext } from "@velum-labs/routekit-cli-core";

import { collectVersionMatrix } from "../package-version.js";

import { registerPaletteAction } from "./palette.js";

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
    {
      label: "synthesizer (pinned)",
      value: formatPackageVersion("fusionkit", matrix.synthesizerPinned)
    },
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
      label: `@velum-labs/routekit-tool-${name}`,
      value: version ?? dim("unknown")
    }))
  );

  return 0;
}

export function registerVersion(program: Command): void {
  registerPaletteAction({ label: "Show versions", hint: "fusionkit version", argv: ["version"] });
  program
    .command("version")
    .description("show versions for fusionkit, the synthesizer, runners, agents, and tool packages")
    .option("--json", "emit machine-readable JSON")
    .action(async (_opts: { json?: boolean }, command: Command) => {
      process.exitCode = await runVersion(contextFor(command));
    });
}
