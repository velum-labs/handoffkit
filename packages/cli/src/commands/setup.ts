/**
 * `fusionkit setup` — the one-install warm-up step (WS8).
 *
 * Verifies the `uv`/`uvx` runner is present, pre-provisions ("warms") the pinned
 * `fusionkit` Python engine into the local `uv` cache so the first real run
 * doesn't pay the cold-start cost, and prints the per-platform capability
 * summary (cloud everywhere; local MLX on Apple Silicon only). It is the
 * companion to `fusionkit doctor` (which checks prerequisites without changing
 * anything) and `fusionkit doctor --provision` (doctor + this warm step).
 */
import type { Command } from "commander";

import { detectHost } from "../fusion/local-catalog.js";
import { platformCapabilities } from "../fusion/platform.js";
import { provisionEngineWithProgress } from "../fusion/provision.js";
import { bold, brandBanner, dim, glyph, gray, green, red } from "../ui/theme.js";

type SetupOpts = { fusionkitDir?: string; force?: boolean };

function reportCapabilities(): void {
  console.log("");
  console.log(bold("platform capability"));
  for (const cap of platformCapabilities(detectHost())) {
    const mark = cap.ok ? green(glyph.tick()) : gray(glyph.bullet());
    console.log(`  ${mark} ${cap.label} ${dim(`— ${cap.detail}`)}`);
  }
}

async function runSetup(opts: SetupOpts): Promise<number> {
  console.log(`\n${brandBanner("setup")}\n`);
  console.log(dim("pre-provisioning the fusion engine so your first run is instant."));
  console.log("");

  const code = await provisionEngineWithProgress({
    ...(opts.fusionkitDir !== undefined ? { fusionkitDir: opts.fusionkitDir } : {}),
    ...(opts.force === true ? { force: true } : {})
  });

  reportCapabilities();

  console.log("");
  if (code === 0) {
    console.log(
      `${dim("already-cached runs are offline-fast; re-warm any time with")} ${bold("fusionkit setup --force")}.`
    );
    console.log(green("ready. Try: ") + bold("fusionkit codex") + dim("  (or: claude | cursor | serve)"));
  } else {
    console.log(red("setup did not complete. Fix the issue above, then re-run `fusionkit setup`."));
  }
  return code;
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("pre-provision the fusion engine (warm the uv cache) so the first run is instant")
    .option("--fusionkit-dir <dir>", "local FusionKit checkout (dev override for the engine)")
    .option("--force", "re-warm even if the engine is already cached")
    .action(async (opts: SetupOpts) => {
      process.exit(await runSetup(opts));
    });
}
