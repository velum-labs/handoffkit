import type { Command } from "commander";

import { collectVersionMatrix } from "../shared/package-version.js";
import { brandHeader, dim } from "../ui/theme.js";

type VersionOpts = { json?: boolean };

async function runVersion(opts: VersionOpts): Promise<number> {
  const matrix = await collectVersionMatrix();

  if (opts.json === true) {
    console.log(JSON.stringify(matrix, null, 2));
    return 0;
  }

  console.log(`\n${brandHeader("versions")}\n`);
  console.log(`  ${"@fusionkit/cli".padEnd(22)} ${matrix.cli}`);
  console.log(`  ${"synthesizer (pinned)".padEnd(22)} fusionkit@${matrix.synthesizerPinned}`);
  console.log(
    `  ${"synthesizer (cached)".padEnd(22)} ${matrix.synthesizerCached ?? dim("not provisioned")}`
  );

  console.log("");
  console.log(dim("runners"));
  for (const [name, version] of Object.entries(matrix.runners)) {
    console.log(`  ${name.padEnd(22)} ${version ?? dim("not installed")}`);
  }

  console.log("");
  console.log(dim("coding agents"));
  for (const [name, version] of Object.entries(matrix.agents)) {
    console.log(`  ${name.padEnd(22)} ${version ?? dim("not installed")}`);
  }

  console.log("");
  console.log(dim("tool integrations"));
  for (const [name, version] of Object.entries(matrix.tools)) {
    const label = `@fusionkit/tool-${name}`;
    console.log(`  ${label.padEnd(22)} ${version ?? dim("unknown")}`);
  }

  return 0;
}

export function registerVersion(program: Command): void {
  program
    .command("version")
    .description("show versions for fusionkit, the synthesizer, runners, agents, and tool packages")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts: VersionOpts) => {
      process.exit(await runVersion(opts));
    });
}
