import { join } from "node:path";

import type { Command } from "commander";

import {
  DEFAULT_CLOUD_PANEL,
  DEFAULT_TRIO,
  defaultKeyEnv,
  gitToplevel,
  loadEnvFileInto
} from "../fusion-quickstart.js";
import type { PanelModelSpec } from "../fusion-quickstart.js";
import { loadFusionConfig, fusionConfigPath, FusionConfigError } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { detectHost } from "../fusion/local-catalog.js";
import { ownedMlxEnv } from "../fusion/mlx.js";
import { FUSIONKIT_PYPI_VERSION } from "../fusion/env.js";
import { platformCapabilities } from "../fusion/platform.js";
import { engineCached, provisionEngineWithProgress } from "../fusion/provision.js";
import { hasBinary, INSTALL_HINTS } from "../shared/preflight.js";
import { formatBytes } from "../ui/progress.js";
import { bold, brandBanner, brandHeader, cyan, dim, glyph, gray, green, red, yellow } from "../ui/theme.js";

/** Report on the local MLX runtime and any downloaded models (best-effort). */
async function reportLocalMlx(): Promise<void> {
  const host = detectHost();
  console.log("");
  console.log(bold("local MLX (Apple Silicon)"));
  if (!host.appleSilicon) {
    console.log(
      `  ${gray(glyph.bullet())} ${dim(`not available on ${host.platform}/${host.arch} — cloud panel only`)}`
    );
    return;
  }

  const env = ownedMlxEnv();
  const info = env.info();
  if (info.provisioned) {
    console.log(`  ${green(glyph.tick())} runtime provisioned ${dim(`(${info.manifest?.packageSpec ?? "mlx-lm"})`)}`);
  } else {
    console.log(
      `  ${gray(glyph.bullet())} runtime not provisioned yet ${dim("(set up on first run or via `fusionkit models download`)")}`
    );
  }

  let downloaded: { repo: string; sizeBytes: number }[] = [];
  try {
    downloaded = await env.scanModels();
  } catch {
    // best-effort
  }
  if (downloaded.length === 0) {
    console.log(`  ${gray(glyph.bullet())} ${dim("no models downloaded — run `fusionkit models` to browse")}`);
  } else {
    for (const model of downloaded) {
      console.log(`  ${green(glyph.tick())} ${model.repo} ${dim(formatBytes(model.sizeBytes))}`);
    }
  }
  console.log(`  ${dim(`${Math.round(host.totalRamGB)}GB RAM · cache ${env.dir} · ${formatBytes(info.diskBytes)} on disk`)}`);
}

type Check = { label: string; ok: boolean; detail?: string; hint?: string };

function line(check: Check): string {
  const mark = check.ok ? green(glyph.tick()) : red(glyph.cross());
  const detail = check.detail !== undefined ? ` ${dim(check.detail)}` : "";
  const hint = !check.ok && check.hint !== undefined ? `\n    ${yellow(glyph.arrow())} ${check.hint}` : "";
  return `${mark} ${check.label}${detail}${hint}`;
}

function keyPresent(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.length > 0;
}

/** `fusionkit doctor` — a proactive environment checklist with fix hints. */
async function runDoctor(opts: { provision?: boolean } = {}): Promise<number> {
  // Match runtime: a project .env makes provider keys available without export.
  loadEnvFileInto(join(process.cwd(), ".env"), process.env);

  console.log(`\n${brandBanner("environment check")}\n`);

  const runner = hasBinary("uvx") || hasBinary("uv");
  const checks: Check[] = [];
  checks.push({
    label: "uv / uvx (Python runner for the synthesizer)",
    ok: runner,
    ...(runner ? {} : { hint: INSTALL_HINTS.uvx })
  });
  checks.push({ label: "git (repo detection)", ok: hasBinary("git"), hint: "install git" });

  const repoRoot = gitToplevel(process.cwd());
  checks.push({
    label: "inside a git repository",
    ok: repoRoot !== undefined,
    ...(repoRoot !== undefined ? { detail: repoRoot } : { hint: "cd into your project, or run `git init`" })
  });

  console.log(bold("prerequisites"));
  for (const check of checks) console.log(`  ${line(check)}`);

  console.log("");
  console.log(bold("coding agents (install the one you use)"));
  for (const [bin, tool] of [
    ["codex", "codex"],
    ["claude", "claude"],
    ["cursor-agent", "cursor"]
  ] as const) {
    const ok = hasBinary(bin);
    console.log(
      `  ${line({ label: `${tool} (${bin})`, ok, ...(ok ? {} : { hint: INSTALL_HINTS[bin] ?? `install ${bin}` }) })}`
    );
  }

  console.log("");
  console.log(bold("provider keys (needed by the cloud panel)"));
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
    const ok = keyPresent(name);
    console.log(
      `  ${line({ label: name, ok, detail: ok ? "set" : "not set", ...(ok ? {} : { hint: `export ${name}=... (or add it to .env)` })})}`
    );
  }

  // Per-platform capability: cloud everywhere; local MLX on Apple Silicon only.
  console.log("");
  console.log(bold("platform capability"));
  for (const cap of platformCapabilities()) {
    const mark = cap.ok ? green(glyph.tick()) : gray(glyph.bullet());
    console.log(`  ${mark} ${cap.label} ${dim(`— ${cap.detail}`)}`);
  }

  // Is the pinned Python engine already provisioned (warmed into the uv cache)?
  // Probing it offline is fast either way and tells the user whether the first
  // real run will pay a cold start.
  console.log("");
  console.log(bold("fusion engine (Python synthesizer)"));
  if (!runner) {
    console.log(
      `  ${gray(glyph.bullet())} ${dim(`fusionkit@${FUSIONKIT_PYPI_VERSION} — install uv/uvx first, then \`fusionkit setup\``)}`
    );
  } else if (await engineCached()) {
    console.log(`  ${green(glyph.tick())} fusionkit@${FUSIONKIT_PYPI_VERSION} provisioned ${dim("(cached — first run is instant, works offline)")}`);
  } else {
    console.log(
      `  ${gray(glyph.bullet())} fusionkit@${FUSIONKIT_PYPI_VERSION} ${dim("not provisioned yet — the first run pulls it from PyPI")}`
    );
    console.log(`    ${yellow(glyph.arrow())} run ${bold("fusionkit setup")} (or ${bold("fusionkit doctor --provision")}) to pre-warm it now`);
  }

  await reportLocalMlx();

  // Optional: actually warm the engine now (doctor + setup in one shot).
  if (opts.provision === true && runner) {
    console.log("");
    console.log(bold("provisioning"));
    await provisionEngineWithProgress({});
  }

  // Config status, if any.
  if (repoRoot !== undefined) {
    console.log("");
    console.log(bold("repo config"));
    try {
      const config = loadFusionConfig(repoRoot, (message) =>
        console.log(`  ${gray(glyph.bullet())} ${dim(message)}`)
      );
      if (config === undefined) {
        const trio = DEFAULT_CLOUD_PANEL.map((spec) => spec.id).join(", ");
        console.log(
          `  ${gray(glyph.bullet())} no ${cyan(".fusionkit/")} yet — using built-in defaults (cloud trio: ${trio})`
        );
        console.log(`    ${dim(`run ${bold("fusionkit init")} to scaffold one, or ${bold("fusionkit config show")} to see the effective defaults`)}`);
      } else {
        const overrides = Object.keys(config.prompts ?? {});
        console.log(`  ${green(glyph.tick())} ${cyan(fusionConfigPath(repoRoot))}`);
        console.log(`    ${dim(`tool: ${config.tool ?? "(unset)"}  panel: ${(config.panel ?? []).map((s) => s.id).join(", ") || "(unset)"}`)}`);
        console.log(
          `    ${dim(`prompt overrides: ${overrides.length > 0 ? overrides.join(", ") : "(none — built-in defaults)"}`)}`
        );
        console.log(`    ${dim(`see the merged config + provenance with ${bold("fusionkit config show")}`)}`);
      }
    } catch (error) {
      const message = error instanceof FusionConfigError ? error.message : String(error);
      console.log(`  ${red(glyph.cross())} ${message}`);
    }
  }

  console.log("");
  if (!runner) {
    console.log(red("fusionkit needs uv/uvx to run the synthesizer. Install it, then re-run `fusionkit doctor`."));
    return 1;
  }
  console.log(green("ready. Try: ") + bold("fusionkit codex"));
  return 0;
}

function panelLabel(spec: PanelModelSpec): string {
  const provider = spec.provider ?? "mlx";
  const key = spec.keyEnv ?? defaultKeyEnv(provider);
  const keyNote = key !== undefined ? ` ${gray(`[${key}]`)}` : "";
  return `${spec.id} = ${provider}:${spec.model}${keyNote}`;
}

/** `fusionkit status` — show the effective config and a dry-run preview. */
function runStatus(): number {
  const repoRoot = gitToplevel(process.cwd());
  console.log(`\n${brandHeader("status")}\n`);
  if (repoRoot === undefined) {
    console.log(gray("not inside a git repository; run from your project."));
    return 0;
  }

  let config: FusionConfig | undefined;
  try {
    config = loadFusionConfig(repoRoot, (message) => console.log(dim(message)));
  } catch (error) {
    console.log(`${red("config error:")} ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const local = config?.local === true;
  const panel = config?.panel ?? (local ? [...DEFAULT_TRIO] : [...DEFAULT_CLOUD_PANEL]);
  const tool = config?.tool ?? "codex";
  const judge = config?.judgeModel ?? panel[0]?.model ?? "(first panel model)";
  const source = config !== undefined ? cyan(fusionConfigPath(repoRoot)) : dim("(built-in defaults; run `fusionkit init`)");

  console.log(`${dim("config:")} ${source}`);
  console.log(`${dim("repo:")}   ${repoRoot}`);
  console.log(`${dim("tool:")}   ${bold(tool)}`);
  console.log(`${dim("judge:")}  ${judge}`);
  console.log(`${dim("observe:")} ${config?.observe === true ? "on" : "off"}`);
  const overrides = Object.keys(config?.prompts ?? {});
  console.log(`${dim("prompts:")} ${overrides.length > 0 ? overrides.join(", ") : dim("(built-in defaults)")}`);
  console.log(bold("\npanel"));
  for (const spec of panel) console.log(`  ${glyph.bullet()} ${panelLabel(spec)}`);

  const spawnsCloud = panel.some((spec) => (spec.provider ?? "mlx") !== "mlx");
  console.log("");
  console.log(dim(`a run will: spawn ${panel.length} model server(s), a synthesizer, and the gateway, then launch ${tool}.`));
  if (spawnsCloud) console.log(yellow(`${glyph.warn()} cloud panel: each prompt fans out across the panel + judge (provider usage applies).`));
  return 0;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check that prerequisites (uv, agents, keys, git) are ready")
    .option("--provision", "also pre-provision (warm) the fusion engine into the uv cache")
    .action(async (opts: { provision?: boolean }) => {
      process.exit(await runDoctor({ provision: opts.provision === true }));
    });

  program
    .command("status")
    .description("show the effective fusion config and a dry-run preview")
    .action(() => {
      process.exit(runStatus());
    });
}
