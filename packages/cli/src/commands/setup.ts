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

import { bold, dim, green, red } from "@fusionkit/cli-ui";
import type { Presenter } from "@fusionkit/cli-ui";

import { detectHost } from "../fusion/local-catalog.js";
import { platformCapabilities } from "../fusion/platform.js";
import { provisionEngineWithProgress } from "../fusion/provision.js";
import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";

import { registerPaletteAction } from "./palette.js";

type SetupOpts = { fusionkitDir?: string; force?: boolean };

function reportCapabilities(presenter: Presenter): void {
  presenter.blank();
  presenter.heading("platform capability");
  for (const cap of platformCapabilities(detectHost())) {
    presenter.status(cap.ok ? "ok" : "pending", cap.label, `— ${cap.detail}`);
  }
}

async function runSetup(opts: SetupOpts, ctx: CommandContext): Promise<number> {
  const { presenter } = ctx;
  presenter.blank();
  presenter.banner("setup");
  presenter.blank();
  presenter.line(dim("pre-provisioning the fusion engine so your first run is instant."));
  presenter.blank();

  const code = await provisionEngineWithProgress(
    {
      ...(opts.fusionkitDir !== undefined ? { fusionkitDir: opts.fusionkitDir } : {}),
      ...(opts.force === true ? { force: true } : {})
    },
    presenter
  );

  reportCapabilities(presenter);

  presenter.blank();
  if (code === 0) {
    presenter.line(
      `${dim("already-cached runs are offline-fast; re-warm any time with")} ${bold("fusionkit setup --force")}.`
    );
    presenter.line(green("ready. Try: ") + bold("fusionkit codex") + dim("  (or: claude | cursor | serve)"));
  } else {
    presenter.line(red("setup did not complete. Fix the issue above, then re-run `fusionkit setup`."));
  }
  if (ctx.json) {
    ctx.emit({ ok: code === 0, capabilities: platformCapabilities(detectHost()) });
  }
  return code;
}

export function registerSetup(program: Command): void {
  registerPaletteAction({ label: "Warm the fusion engine", hint: "fusionkit setup", argv: ["setup"] });
  program
    .command("setup")
    .description("pre-provision the fusion engine (warm the uv cache) so the first run is instant")
    .option("--fusionkit-dir <dir>", "local FusionKit checkout (dev override for the engine)")
    .option("--force", "re-warm even if the engine is already cached")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts: SetupOpts, command: Command) => {
      process.exit(await runSetup(opts, contextFor(command)));
    });
}
