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

import { catalogEntry, detectHost, recommendFor, usableRamGB } from "../fusion/local-catalog.js";
import { ownedMlxEnv } from "../fusion/mlx.js";
import { estimateModelSizing } from "../fusion/model-sizing.js";
import { ProgressBar, formatBytes } from "../ui/progress.js";
import { Spinner } from "../ui/spinner.js";
import { bold, brandBanner, cyan, dim, glyph, gray, green, red, yellow } from "../ui/theme.js";

function firstLine(message: string): string {
  return (message.split("\n")[0] ?? message).trim();
}

async function runList(): Promise<number> {
  const host = detectHost();
  console.log(`\n${brandBanner("local models")}\n`);
  if (!host.appleSilicon) {
    console.log(
      yellow(`${glyph.warn()} local MLX needs Apple Silicon (macOS arm64); this host is ${host.platform}/${host.arch}.`)
    );
    console.log("");
  }

  const env = ownedMlxEnv();
  const downloaded = new Map<string, number>();
  try {
    for (const model of await env.scanModels()) downloaded.set(model.repo, model.sizeBytes);
  } catch {
    // best-effort; an unprovisioned/missing runtime simply shows nothing cached
  }

  console.log(bold("downloaded"));
  if (downloaded.size === 0) {
    console.log(`  ${dim("none yet — pick one below and run `fusionkit models download <repo>`")}`);
  } else {
    for (const [repo, size] of downloaded) {
      console.log(`  ${green(glyph.tick())} ${repo} ${dim(formatBytes(size))}`);
    }
  }

  console.log("");
  console.log(bold("catalog"));
  for (const entry of recommendFor(host)) {
    const have = downloaded.has(entry.repo);
    const mark = have ? green(glyph.tick()) : gray(glyph.bullet());
    const status = have ? "downloaded" : `~${entry.sizeGB} GB`;
    const ram = entry.fits ? "" : red(` · needs ${entry.minRamGB}GB RAM`);
    console.log(
      `  ${mark} ${entry.label} ${dim(`(${entry.repo})`)}\n      ${dim(`${entry.params} ${entry.quant} · ${status}`)}${ram}${dim(` · ${entry.blurb}`)}`
    );
  }

  console.log("");
  console.log(dim(`runtime: ${env.dir} · ${formatBytes(env.info().diskBytes)} on disk`));
  return 0;
}

async function provision(env: MlxEnv): Promise<boolean> {
  const spinner = new Spinner("preparing the local MLX runtime").start();
  let phaseLabel = "preparing the local MLX runtime";
  try {
    await env.ensureProvisioned({
      onEvent: (event) => {
        if (event.type === "phase") {
          phaseLabel = event.label;
          spinner.update(phaseLabel);
        } else if (event.type === "log") {
          const line = event.line.trim();
          const tail = line.length > 60 ? `…${line.slice(line.length - 60)}` : line;
          spinner.update(`${phaseLabel} ${dim(`· ${tail}`)}`);
        }
      }
    });
    spinner.succeed("local MLX runtime ready");
    return true;
  } catch (error) {
    if (error instanceof MlxCapabilityError) {
      spinner.fail(`MLX runtime unavailable: ${firstLine(error.message)}`);
    } else {
      spinner.fail(`could not prepare the MLX runtime: ${firstLine(error instanceof Error ? error.message : String(error))}`);
    }
    return false;
  }
}

async function runDownload(repo: string, force: boolean): Promise<number> {
  const host = detectHost();
  console.error(`\n${brandBanner("download")}\n`);
  if (!host.appleSilicon) {
    console.error(red(`local MLX needs Apple Silicon (macOS arm64); this host is ${host.platform}/${host.arch}.`));
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
    console.error(
      red(
        `${repo} needs ~${sizing.requiredGB.toFixed(0)}GB to run, but this host has ${Math.round(host.totalRamGB)}GB ` +
          `(~${Math.floor(usableRamGB(host))}GB usable for models).`
      )
    );
    console.error(dim(`${measured} — re-run with --force to download anyway.`));
    return 1;
  }

  const env = ownedMlxEnv();
  if (!(await provision(env))) return 1;

  if (entry !== undefined) console.error(dim(`${entry.label} · ${entry.params} ${entry.quant} · ~${entry.sizeGB} GB`));

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  const bar = new ProgressBar(cyan(repo)).start();
  try {
    const path = await env.downloadModel(repo, {
      onProgress: (progress) => bar.update(progress),
      signal: controller.signal
    });
    bar.succeed(cyan(repo));
    console.error(dim(path));
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

function runRemove(repo: string): number {
  const env = ownedMlxEnv();
  const removed = env.removeModel(repo);
  if (removed) {
    console.log(`${green(glyph.tick())} removed ${cyan(repo)} from ${dim(env.dir)}`);
  } else {
    console.log(`${gray(glyph.bullet())} ${repo} was not in the local cache`);
  }
  return 0;
}

export function registerModels(program: Command): void {
  const models = program
    .command("models")
    .description("list, download, and remove local MLX models")
    .action(async () => {
      process.exit(await runList());
    });

  models
    .command("list")
    .description("show the curated catalog and which models are downloaded")
    .action(async () => {
      process.exit(await runList());
    });

  models
    .command("download")
    .argument("<repo>", "Hugging Face repo id (e.g. mlx-community/Qwen3-1.7B-4bit)")
    .option("--force", "download even if the model is too large to run on this host")
    .description("download a model's weights into the owned cache (resumable)")
    .action(async (repo: string, opts: { force?: boolean }) => {
      process.exit(await runDownload(repo, opts.force === true));
    });

  models
    .command("rm")
    .alias("remove")
    .argument("<repo>", "Hugging Face repo id to remove from the cache")
    .description("remove a model's weights from the owned cache")
    .action((repo: string) => {
      process.exit(runRemove(repo));
    });
}
