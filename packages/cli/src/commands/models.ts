/**
 * `fusionkit models` — manage local MLX models outside the init wizard:
 *   models list                show the curated catalog + what's downloaded
 *   models download <repo>     fetch a model's weights (live progress, resumable)
 *   models rm <repo>           remove a model's weights from the owned cache
 *
 * All of it runs against the same owned MLX env (and HF cache) the runtime uses,
 * so anything downloaded here is immediately usable by `fusionkit <tool>`.
 */
import type { Command } from "commander";

import { MlxCapabilityError } from "@fusionkit/adapter-ai-sdk";
import type { MlxEnv } from "@fusionkit/adapter-ai-sdk";

import { bold, cyan, dim, formatBytes, gray, red } from "@fusionkit/cli-ui";
import type { Presenter } from "@fusionkit/cli-ui";

import { catalogFor } from "../fusion/catalog.js";
import { catalogEntry, detectHost, recommendFor, usableRamGB } from "../fusion/local-catalog.js";
import { ownedMlxEnv } from "../fusion/mlx.js";
import { estimateModelSizing } from "../fusion/model-sizing.js";
import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import { argOrPick } from "../shared/pickers.js";

import { registerPaletteAction } from "./palette.js";

function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).trim();
}

async function runList(ctx: CommandContext): Promise<number> {
  const host = detectHost();
  const env = ownedMlxEnv();
  const downloaded = new Map<string, number>();
  try {
    for (const model of await env.scanModels()) downloaded.set(model.repo, model.sizeBytes);
  } catch {
    // best-effort; an unprovisioned/missing runtime simply shows nothing cached
  }
  const catalog = recommendFor(host);

  if (ctx.json) {
    ctx.emit({
      host: { platform: host.platform, arch: host.arch, appleSilicon: host.appleSilicon },
      downloaded: [...downloaded.entries()].map(([repo, sizeBytes]) => ({ repo, sizeBytes })),
      catalog: catalog.map((entry) => ({
        repo: entry.repo,
        label: entry.label,
        params: entry.params,
        quant: entry.quant,
        sizeGB: entry.sizeGB,
        minRamGB: entry.minRamGB,
        fits: entry.fits,
        downloaded: downloaded.has(entry.repo)
      })),
      runtimeDir: env.dir,
      diskBytes: env.info().diskBytes
    });
    return 0;
  }

  const { presenter } = ctx;
  presenter.blank();
  presenter.banner("local models");
  presenter.blank();
  if (!host.appleSilicon) {
    presenter.warn(`local MLX needs Apple Silicon (macOS arm64); this host is ${host.platform}/${host.arch}.`);
    presenter.blank();
  }

  presenter.heading("downloaded");
  if (downloaded.size === 0) {
    presenter.line(`  ${dim("none yet — pick one below and run `fusionkit models download <repo>`")}`);
  } else {
    for (const [repo, size] of downloaded) {
      presenter.status("ok", repo, formatBytes(size));
    }
  }

  presenter.blank();
  presenter.heading("catalog");
  for (const entry of catalog) {
    const have = downloaded.has(entry.repo);
    const status = have ? "downloaded" : `~${entry.sizeGB} GB`;
    const ram = entry.fits ? "" : red(` · needs ${entry.minRamGB}GB RAM`);
    presenter.status(have ? "ok" : "pending", `${entry.label} ${dim(`(${entry.repo})`)}`);
    presenter.line(`      ${dim(`${entry.params} ${entry.quant} · ${status}`)}${ram}${dim(` · ${entry.blurb}`)}`);
  }

  presenter.blank();
  presenter.line(dim(`runtime: ${env.dir} · ${formatBytes(env.info().diskBytes)} on disk`));
  return 0;
}

/** Provision the owned MLX runtime with a live task line. Exported for reuse. */
export async function provisionMlxRuntime(env: MlxEnv, presenter: Presenter): Promise<boolean> {
  const task = presenter.task("preparing the local MLX runtime");
  let phaseLabel = "preparing the local MLX runtime";
  try {
    await env.ensureProvisioned({
      onEvent: (event) => {
        if (event.type === "phase") {
          phaseLabel = event.label;
          task.update(phaseLabel);
        } else if (event.type === "log") {
          const line = event.line.trim();
          const tail = line.length > 60 ? `…${line.slice(line.length - 60)}` : line;
          task.update(`${phaseLabel} ${dim(`· ${tail}`)}`);
        }
      }
    });
    task.succeed("local MLX runtime ready");
    return true;
  } catch (error) {
    if (error instanceof MlxCapabilityError) {
      task.fail(`MLX runtime unavailable: ${firstLine(error.message)}`);
    } else {
      task.fail(
        `could not prepare the MLX runtime: ${firstLine(error instanceof Error ? error.message : String(error))}`
      );
    }
    return false;
  }
}

async function runDownload(repo: string, force: boolean, ctx: CommandContext): Promise<number> {
  const host = detectHost();
  const { presenter } = ctx;
  presenter.blank();
  presenter.banner("download");
  presenter.blank();
  if (!host.appleSilicon) {
    presenter.error(`local MLX needs Apple Silicon (macOS arm64); this host is ${host.platform}/${host.arch}.`);
    return 1;
  }

  // Refuse to fetch a model that can't run on this machine, unless forced. The
  // requirement is measured from the model's real files when online, with the
  // static catalog as the offline fallback; truly unknown repos aren't blocked.
  const entry = catalogEntry(repo);
  const sizing = await estimateModelSizing(repo, {
    ...(entry !== undefined ? { catalogFallbackGB: entry.minRamGB } : {})
  });
  if (!force && sizing.source !== "unknown" && sizing.requiredGB > usableRamGB(host)) {
    const measured = sizing.source === "hub" ? "measured from the model files" : "catalog estimate";
    presenter.error(
      `${repo} needs ~${sizing.requiredGB.toFixed(0)}GB to run, but this host has ${Math.round(host.totalRamGB)}GB ` +
        `(~${Math.floor(usableRamGB(host))}GB usable for models).`
    );
    presenter.line(dim(`${measured} — re-run with --force to download anyway.`));
    return 1;
  }

  const env = ownedMlxEnv();
  if (!(await provisionMlxRuntime(env, presenter))) return 1;

  if (entry !== undefined) presenter.line(dim(`${entry.label} · ${entry.params} ${entry.quant} · ~${entry.sizeGB} GB`));

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  const bar = presenter.progress(cyan(repo));
  try {
    const path = await env.downloadModel(repo, {
      onProgress: (progress) => bar.update(progress),
      signal: controller.signal
    });
    bar.succeed(cyan(repo));
    presenter.line(dim(path));
    if (ctx.json) ctx.emit({ downloaded: repo, path });
    return 0;
  } catch (error) {
    if (controller.signal.aborted) {
      bar.fail(`${repo} ${gray("— cancelled (partial download is resumable)")}`);
      return 130;
    }
    bar.fail(`${repo} ${gray(`— ${firstLine(error instanceof Error ? error.message : String(error))}`)}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
  }
}

function runRemove(repo: string, ctx: CommandContext): number {
  const env = ownedMlxEnv();
  const removed = env.removeModel(repo);
  if (ctx.json) {
    ctx.emit({ removed, repo });
    return 0;
  }
  if (removed) {
    ctx.presenter.success(`removed ${cyan(repo)} from ${dim(env.dir)}`);
  } else {
    ctx.presenter.note(`${repo} was not in the local cache`);
  }
  return 0;
}

export function registerModels(program: Command): void {
  registerPaletteAction({ label: "Manage local MLX models", hint: "fusionkit models", argv: ["models"] });
  const models = program
    .command("models")
    .description("list, download, and remove local MLX models")
    .option("--json", "emit machine-readable JSON")
    .action(async (_opts: { json?: boolean }, command: Command) => {
      process.exit(await runList(contextFor(command)));
    });

  models
    .command("list")
    .description("show the curated catalog and which models are downloaded")
    .option("--json", "emit machine-readable JSON")
    .action(async (_opts: { json?: boolean }, command: Command) => {
      process.exit(await runList(contextFor(command)));
    });

  models
    .command("download")
    .argument("[repo]", "Hugging Face repo id (e.g. mlx-community/Qwen3-1.7B-4bit); omit on a TTY to pick")
    .option("--force", "download even if the model is too large to run on this host")
    .description("download a model's weights into the owned cache (resumable)")
    .action(async (repo: string | undefined, opts: { force?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      // The curated hardware-aware catalog opens instantly (with RAM-fit
      // hints); the live mlx-community listing streams in behind it so any
      // published conversion is pickable, not just the curated few.
      const curated = (): Array<{ value: string; label: string; hint: string }> =>
        recommendFor(detectHost()).map((entry) => ({
          value: entry.repo,
          label: entry.repo,
          hint: `${entry.label} · ${entry.params} ${entry.quant} · ~${entry.sizeGB} GB${entry.fits ? "" : ` · needs ${entry.minRamGB}GB RAM`}`
        }));
      const picked = await argOrPick<string>({
        given: repo,
        message: "Which model to download?",
        placeholder: "type to filter the catalog",
        missing: "missing model repo — pass a Hugging Face repo id (see `fusionkit models`)",
        options: curated,
        refresh: async () => {
          const base = curated();
          const known = new Set(base.map((option) => option.value));
          const community = (await catalogFor("mlx"))
            .filter((model) => !known.has(model.id))
            .map((model) => ({ value: model.id, label: model.id, hint: "mlx-community" }));
          return [...base, ...community];
        },
        refreshNote: "fetching the mlx-community catalog…"
      });
      process.exit(await runDownload(picked, opts.force === true, ctx));
    });

  models
    .command("rm")
    .alias("remove")
    .argument("[repo]", "Hugging Face repo id to remove from the cache; omit on a TTY to pick")
    .description("remove a model's weights from the owned cache")
    .option("--json", "emit machine-readable JSON")
    .action(async (repo: string | undefined, _opts: { json?: boolean }, command: Command) => {
      const ctx = contextFor(command);
      let downloaded: Array<{ repo: string; sizeBytes: number }> = [];
      if (repo === undefined) {
        try {
          downloaded = (await ownedMlxEnv().scanModels()).map((model) => ({
            repo: model.repo,
            sizeBytes: model.sizeBytes
          }));
        } catch (error) {
          // An unprovisioned runtime legitimately has nothing cached, but any
          // other scan failure must be said out loud — otherwise the "nothing
          // to remove" message below would mask a broken runtime.
          if (!(error instanceof MlxCapabilityError)) {
            ctx.presenter.warn(
              `could not scan the local model cache: ${firstLine(error instanceof Error ? error.message : String(error))}`
            );
          }
        }
      }
      const picked = await argOrPick<string>({
        given: repo,
        message: "Which model to remove?",
        missing: "missing model repo — pass a Hugging Face repo id (see `fusionkit models`)",
        empty: "no downloaded models to remove",
        options: () =>
          downloaded.map((model) => ({ value: model.repo, label: model.repo, hint: formatBytes(model.sizeBytes) }))
      });
      process.exit(runRemove(picked, ctx));
    });
}
