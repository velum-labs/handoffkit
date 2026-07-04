/**
 * `fusionkit doctor` — a proactive environment checklist with fix hints, and
 * `fusionkit status` — the effective config + a dry-run preview. Both render
 * through the presenter and support `--json` for scripting/CI.
 */
import { join } from "node:path";

import type { Command } from "commander";

import { bold, cyan, dim, formatBytes, gray, green, red } from "@fusionkit/cli-ui";
import type { Presenter, StatusKind } from "@fusionkit/cli-ui";

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
import { probeBinaryVersion, readPackageVersion } from "../shared/package-version.js";
import { contextFor } from "../shared/context.js";
import type { CommandContext } from "../shared/context.js";
import { toolRegistry } from "../tools.js";

type Check = { label: string; ok: boolean; detail?: string; hint?: string };

/** One machine-readable doctor entry. */
type DoctorEntry = {
  section: string;
  label: string;
  ok: boolean;
  detail?: string;
  hint?: string;
};

function keyPresent(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value.length > 0;
}

function statusFor(check: Check): StatusKind {
  return check.ok ? "ok" : "fail";
}

/** Report on the local MLX runtime and any downloaded models (best-effort). */
async function reportLocalMlx(presenter: Presenter, report: DoctorEntry[]): Promise<void> {
  const host = detectHost();
  presenter.blank();
  presenter.heading("local MLX (Apple Silicon)");
  if (!host.appleSilicon) {
    presenter.status("pending", dim(`not available on ${host.platform}/${host.arch} — cloud panel only`));
    report.push({
      section: "mlx",
      label: "local MLX",
      ok: false,
      detail: `not available on ${host.platform}/${host.arch}`
    });
    return;
  }

  const env = ownedMlxEnv();
  const info = env.info();
  if (info.provisioned) {
    presenter.status("ok", "runtime provisioned", `(${info.manifest?.packageSpec ?? "mlx-lm"})`);
    report.push({ section: "mlx", label: "runtime provisioned", ok: true });
  } else {
    presenter.status(
      "pending",
      "runtime not provisioned yet",
      "(set up on first run or via `fusionkit models download`)"
    );
    report.push({ section: "mlx", label: "runtime provisioned", ok: false });
  }

  let downloaded: { repo: string; sizeBytes: number }[] = [];
  try {
    downloaded = await env.scanModels();
  } catch {
    // best-effort
  }
  if (downloaded.length === 0) {
    presenter.status("pending", dim("no models downloaded — run `fusionkit models` to browse"));
  } else {
    for (const model of downloaded) {
      presenter.status("ok", model.repo, formatBytes(model.sizeBytes));
      report.push({ section: "mlx", label: model.repo, ok: true, detail: formatBytes(model.sizeBytes) });
    }
  }
  presenter.line(
    `  ${dim(`${Math.round(host.totalRamGB)}GB RAM · cache ${env.dir} · ${formatBytes(info.diskBytes)} on disk`)}`
  );
}

/** `fusionkit doctor` — a proactive environment checklist with fix hints. */
async function runDoctor(opts: { provision?: boolean }, ctx: CommandContext): Promise<number> {
  // Match runtime: a project .env makes provider keys available without export.
  loadEnvFileInto(join(process.cwd(), ".env"), process.env);

  const { presenter } = ctx;
  const report: DoctorEntry[] = [];

  presenter.blank();
  presenter.banner("environment check");
  presenter.blank();

  presenter.heading("versions");
  const cliVersion = readPackageVersion(import.meta.url, "../../package.json");
  presenter.status("ok", `@fusionkit/cli ${cliVersion}`);
  presenter.status("ok", `synthesizer (pinned) fusionkit@${FUSIONKIT_PYPI_VERSION}`);
  presenter.line(`  ${dim(`full matrix: ${bold("fusionkit version")}`)}`);
  report.push({ section: "versions", label: "@fusionkit/cli", ok: true, detail: cliVersion });
  report.push({ section: "versions", label: "synthesizer (pinned)", ok: true, detail: FUSIONKIT_PYPI_VERSION });

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

  presenter.heading("prerequisites");
  for (const check of checks) {
    presenter.status(statusFor(check), check.label, check.detail, check.ok ? undefined : check.hint);
    report.push({ section: "prerequisites", ...check });
  }

  presenter.blank();
  presenter.heading("coding agents (install the one you use)");
  for (const tool of toolRegistry.list()) {
    const bin = tool.binary;
    if (bin === undefined) continue;
    const ok = hasBinary(bin);
    const version = ok ? probeBinaryVersion(bin) : undefined;
    const detail = version !== null && version !== undefined ? version : undefined;
    const hint = ok ? undefined : (INSTALL_HINTS[bin] ?? `install ${bin}`);
    presenter.status(ok ? "ok" : "fail", `${tool.id} (${bin})`, detail, hint);
    report.push({
      section: "agents",
      label: `${tool.id} (${bin})`,
      ok,
      ...(detail !== undefined ? { detail } : {}),
      ...(hint !== undefined ? { hint } : {})
    });
  }

  presenter.blank();
  presenter.heading("provider keys (needed by the cloud panel)");
  // The default cloud panel's providers, resolved through the provider secret
  // registry — stays in sync when the default panel composition changes.
  const panelKeyEnvs = [
    ...new Set(
      DEFAULT_CLOUD_PANEL.flatMap((spec) => {
        const keyEnv = spec.provider !== undefined ? defaultKeyEnv(spec.provider) : undefined;
        return keyEnv !== undefined ? [keyEnv] : [];
      })
    )
  ];
  for (const name of panelKeyEnvs) {
    const ok = keyPresent(name);
    presenter.status(
      ok ? "ok" : "fail",
      name,
      ok ? "set" : "not set",
      ok ? undefined : `export ${name}=... (or add it to .env)`
    );
    report.push({ section: "keys", label: name, ok, detail: ok ? "set" : "not set" });
  }

  // Per-platform capability: cloud everywhere; local MLX on Apple Silicon only.
  presenter.blank();
  presenter.heading("platform capability");
  for (const cap of platformCapabilities()) {
    presenter.status(cap.ok ? "ok" : "pending", cap.label, `— ${cap.detail}`);
    report.push({ section: "platform", label: cap.label, ok: cap.ok, detail: cap.detail });
  }

  // Is the pinned Python engine already provisioned (warmed into the uv cache)?
  // Probing it offline is fast either way and tells the user whether the first
  // real run will pay a cold start.
  presenter.blank();
  presenter.heading("fusion engine (Python synthesizer)");
  if (!runner) {
    presenter.status(
      "pending",
      dim(`fusionkit@${FUSIONKIT_PYPI_VERSION} — install uv/uvx first, then \`fusionkit setup\``)
    );
    report.push({ section: "engine", label: `fusionkit@${FUSIONKIT_PYPI_VERSION}`, ok: false, detail: "no runner" });
  } else if (await engineCached()) {
    presenter.status(
      "ok",
      `fusionkit@${FUSIONKIT_PYPI_VERSION} provisioned`,
      "(cached — first run is instant, works offline)"
    );
    report.push({ section: "engine", label: `fusionkit@${FUSIONKIT_PYPI_VERSION}`, ok: true, detail: "cached" });
  } else {
    presenter.status(
      "pending",
      `fusionkit@${FUSIONKIT_PYPI_VERSION}`,
      "not provisioned yet — the first run pulls it from PyPI",
      `run ${bold("fusionkit setup")} (or ${bold("fusionkit doctor --provision")}) to pre-warm it now`
    );
    report.push({
      section: "engine",
      label: `fusionkit@${FUSIONKIT_PYPI_VERSION}`,
      ok: false,
      detail: "not provisioned"
    });
  }

  await reportLocalMlx(presenter, report);

  // Optional: actually warm the engine now (doctor + setup in one shot).
  if (opts.provision === true && runner) {
    presenter.blank();
    presenter.heading("provisioning");
    await provisionEngineWithProgress({}, presenter);
  }

  // Config status, if any.
  if (repoRoot !== undefined) {
    presenter.blank();
    presenter.heading("repo config");
    try {
      const config = loadFusionConfig(repoRoot, (message) => presenter.note(dim(message)));
      if (config === undefined) {
        const trio = DEFAULT_CLOUD_PANEL.map((spec) => spec.id).join(", ");
        presenter.status("pending", `no ${cyan(".fusionkit/")} yet — using built-in defaults (cloud trio: ${trio})`);
        presenter.line(
          `    ${dim(`run ${bold("fusionkit init")} to scaffold one, or ${bold("fusionkit config show")} to see the effective defaults`)}`
        );
        report.push({ section: "config", label: ".fusionkit/fusion.json", ok: false, detail: "not scaffolded" });
      } else {
        const overrides = Object.keys(config.prompts ?? {});
        const ensembleNames = Object.keys(config.ensembles ?? {});
        const panelSummary =
          ensembleNames.length > 1
            ? `ensembles: ${ensembleNames.join(", ")}`
            : `panel: ${(config.ensembles?.[ensembleNames[0] ?? ""]?.panel ?? []).map((s) => s.id).join(", ") || "(unset)"}`;
        presenter.status("ok", cyan(fusionConfigPath(repoRoot)));
        presenter.line(`    ${dim(`tool: ${config.tool ?? "(unset)"}  ${panelSummary}`)}`);
        presenter.line(
          `    ${dim(`prompt overrides: ${overrides.length > 0 ? overrides.join(", ") : "(none — built-in defaults)"}`)}`
        );
        presenter.line(`    ${dim(`edit it from the CLI with ${bold("fusionkit config set")} / ${bold("fusionkit config edit")}`)}`);
        report.push({ section: "config", label: fusionConfigPath(repoRoot), ok: true, detail: panelSummary });
      }
    } catch (error) {
      const message = error instanceof FusionConfigError ? error.message : String(error);
      presenter.status("fail", message);
      report.push({ section: "config", label: "fusion.json", ok: false, detail: message });
    }
  }

  const ready = runner;
  if (ctx.json) {
    ctx.emit({ ready, checks: report });
    return ready ? 0 : 1;
  }
  presenter.blank();
  if (!ready) {
    presenter.line(red("fusionkit needs uv/uvx to run the synthesizer. Install it, then re-run `fusionkit doctor`."));
    return 1;
  }
  presenter.line(green("ready. Try: ") + bold("fusionkit codex"));
  return 0;
}

function panelLabel(spec: PanelModelSpec): string {
  const provider = spec.provider ?? "mlx";
  const key = spec.keyEnv ?? defaultKeyEnv(provider);
  const keyNote = key !== undefined ? ` ${gray(`[${key}]`)}` : "";
  return `${spec.id} = ${provider}:${spec.model}${keyNote}`;
}

/** `fusionkit status` — show the effective config and a dry-run preview. */
function runStatus(ctx: CommandContext): number {
  const { presenter } = ctx;
  const repoRoot = gitToplevel(process.cwd());
  if (repoRoot === undefined) {
    if (ctx.json) {
      ctx.emit({ error: { code: "no-repo", message: "not inside a git repository" } });
      return 0;
    }
    presenter.blank();
    presenter.header("status");
    presenter.blank();
    presenter.line(gray("not inside a git repository; run from your project."));
    return 0;
  }

  let config: FusionConfig | undefined;
  try {
    config = loadFusionConfig(repoRoot, (message) => presenter.note(dim(message)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.json) {
      ctx.emit({ error: { code: "config", message } });
      return 1;
    }
    presenter.blank();
    presenter.header("status");
    presenter.blank();
    presenter.line(`${red("config error:")} ${message}`);
    return 1;
  }

  const local = config?.local === true;
  const ensembleNames = Object.keys(config?.ensembles ?? {});
  const defaultName =
    config?.defaultEnsemble ?? (ensembleNames.includes("default") ? "default" : ensembleNames[0]);
  const defaultEnsemble = defaultName !== undefined ? config?.ensembles?.[defaultName] : undefined;
  const configPanel = defaultEnsemble?.panel;
  const panel =
    configPanel !== undefined && configPanel.length > 0
      ? configPanel
      : local
        ? [...DEFAULT_TRIO]
        : [...DEFAULT_CLOUD_PANEL];
  const tool = config?.tool ?? "codex";
  const judge = defaultEnsemble?.judgeModel ?? panel[0]?.model ?? "(first panel model)";
  const spawnsCloud = panel.some((spec) => (spec.provider ?? "mlx") !== "mlx");

  if (ctx.json) {
    ctx.emit({
      repo: repoRoot,
      configPath: config !== undefined ? fusionConfigPath(repoRoot) : null,
      tool,
      judge,
      observe: config?.observe === true,
      panel,
      ensembles: ensembleNames,
      defaultEnsemble: defaultName ?? null,
      spawnsCloud
    });
    return 0;
  }

  presenter.blank();
  presenter.header("status");
  presenter.blank();
  const source =
    config !== undefined ? cyan(fusionConfigPath(repoRoot)) : dim("(built-in defaults; run `fusionkit init`)");
  const overrides = Object.keys(config?.prompts ?? {});
  presenter.keyValue([
    { label: "config", value: source },
    { label: "repo", value: repoRoot },
    { label: "tool", value: bold(tool) },
    { label: "judge", value: judge },
    { label: "observe", value: config?.observe === true ? "on" : "off" },
    { label: "prompts", value: overrides.length > 0 ? overrides.join(", ") : dim("(built-in defaults)") }
  ]);
  presenter.blank();
  presenter.heading("panel");
  for (const spec of panel) presenter.line(`  ${gray("•")} ${panelLabel(spec)}`);
  if (ensembleNames.length > 1) {
    presenter.line(
      dim(`ensembles: ${ensembleNames.join(", ")} (default: ${defaultName}) — see \`fusionkit config show\``)
    );
  }

  presenter.blank();
  presenter.line(
    dim(`a run will: spawn ${panel.length} model server(s), a synthesizer, and the gateway, then launch ${tool}.`)
  );
  if (spawnsCloud) {
    presenter.warn("cloud panel: each prompt fans out across the panel + judge (provider usage applies).");
  }
  return 0;
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("check that prerequisites (uv, agents, keys, git) are ready")
    .option("--provision", "also pre-provision (warm) the fusion engine into the uv cache")
    .option("--json", "emit machine-readable JSON")
    .action(async (opts: { provision?: boolean; json?: boolean }, command: Command) => {
      process.exit(await runDoctor({ provision: opts.provision === true }, contextFor(command)));
    });

  program
    .command("status")
    .description("show the effective fusion config and a dry-run preview")
    .option("--json", "emit machine-readable JSON")
    .action((_opts: { json?: boolean }, command: Command) => {
      process.exit(runStatus(contextFor(command)));
    });
}
