/**
 * `fusionkit doctor` — a proactive environment checklist with fix hints, and
 * `fusionkit status` — the effective config + a dry-run preview. Both render
 * through the presenter and support `--json` for scripting/CI.
 */
import { existsSync, realpathSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

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

import { registerPaletteAction } from "./palette.js";

type Check = { label: string; ok: boolean; detail?: string; hint?: string };
type CredentialCheck = { env: string; present: boolean; members: string[] };
type FusionkitPathEntry = { path: string; realpath: string };

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

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function keyEnvFor(spec: PanelModelSpec): string | undefined {
  const provider = spec.provider ?? "mlx";
  return spec.keyEnv ?? defaultKeyEnv(provider);
}

function credentialChecks(panel: readonly PanelModelSpec[]): CredentialCheck[] {
  const byEnv = new Map<string, string[]>();
  for (const spec of panel) {
    if (spec.auth !== undefined) continue;
    const env = keyEnvFor(spec);
    if (env === undefined) continue;
    byEnv.set(env, [...(byEnv.get(env) ?? []), spec.id]);
  }
  return [...byEnv.entries()]
    .map(([env, members]) => ({ env, present: keyPresent(env), members }))
    .sort((left, right) => left.env.localeCompare(right.env));
}

function configuredPanels(config: FusionConfig | undefined): PanelModelSpec[] {
  const panels: PanelModelSpec[] = [];
  for (const ensemble of Object.values(config?.ensembles ?? {})) {
    panels.push(...(ensemble.panel ?? []));
  }
  return panels;
}

function acceptedCredentialEnvs(config: FusionConfig | undefined): string[] {
  const defaultEnvs = DEFAULT_CLOUD_PANEL.map((spec) => keyEnvFor(spec)).filter((env): env is string => env !== undefined);
  const configuredEnvs = configuredPanels(config)
    .map((spec) => keyEnvFor(spec))
    .filter((env): env is string => env !== undefined);
  return unique([...defaultEnvs, "OPENROUTER_API_KEY", ...configuredEnvs]);
}

function scanFusionkitPath(pathValue: string | undefined = process.env.PATH): FusionkitPathEntry[] {
  const entries: FusionkitPathEntry[] = [];
  for (const dir of pathValue?.split(delimiter) ?? []) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "fusionkit");
    if (!existsSync(candidate)) continue;
    let realpath = candidate;
    try {
      realpath = realpathSync(candidate);
    } catch {
      // best-effort: a broken entry is still useful to show in doctor output.
    }
    entries.push({ path: candidate, realpath });
  }
  return entries;
}

function currentCliRealpath(): string {
  const current = resolve(process.argv[1] ?? "");
  try {
    return realpathSync(current);
  } catch {
    return current;
  }
}

function reportFusionkitBinary(presenter: Presenter, report: DoctorEntry[]): void {
  const entries = scanFusionkitPath();
  const current = currentCliRealpath();
  presenter.blank();
  presenter.heading("fusionkit binary on PATH");
  if (entries.length === 0) {
    presenter.status("pending", "fusionkit", "not found on PATH (running this CLI by path)");
    report.push({ section: "binaries", label: "fusionkit on PATH", ok: true, detail: "not found on PATH" });
    return;
  }

  const first = entries[0];
  if (first === undefined) {
    presenter.status("pending", "fusionkit", "not found on PATH (running this CLI by path)");
    report.push({ section: "binaries", label: "fusionkit on PATH", ok: true, detail: "not found on PATH" });
    return;
  }
  const firstIsCurrent = first?.realpath === current;
  const other = entries.find((entry) => entry.realpath !== current);
  if (firstIsCurrent && other === undefined) {
    presenter.status("ok", "fusionkit", first.path, "@fusionkit/cli npm front door");
    report.push({ section: "binaries", label: "fusionkit on PATH", ok: true, detail: first.path });
    return;
  }

  const detail =
    firstIsCurrent && other !== undefined
      ? `${other.path} is later on PATH (shadowed by this npm CLI)`
      : `${first?.path ?? "fusionkit"} resolves before this npm CLI`;
  presenter.status(
    "warn",
    "fusionkit",
    detail,
    "npm @fusionkit/cli is the front door; PyPI fusionkit is the Python engine and also installs `fusionkit`"
  );
  report.push({
    section: "binaries",
    label: "fusionkit on PATH",
    ok: false,
    detail,
    hint: "ensure your shell resolves the npm @fusionkit/cli binary first"
  });
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
  presenter.header("environment check");
  presenter.blank();

  presenter.heading("versions");
  const cliVersion = readPackageVersion(import.meta.url, "../../package.json");
  presenter.status("ok", `@fusionkit/cli ${cliVersion}`);
  presenter.status("ok", `synthesizer (pinned) fusionkit@${FUSIONKIT_PYPI_VERSION}`);
  presenter.line(`  ${dim(`full matrix: ${bold("fusionkit version")}`)}`);
  report.push({ section: "versions", label: "@fusionkit/cli", ok: true, detail: cliVersion });
  report.push({ section: "versions", label: "synthesizer (pinned)", ok: true, detail: FUSIONKIT_PYPI_VERSION });
  reportFusionkitBinary(presenter, report);

  const runner = hasBinary("uvx") || hasBinary("uv");
  const checks: Check[] = [];
  checks.push({
    label: "uv / uvx (Python runner for the synthesizer)",
    ok: runner,
    ...(runner ? {} : { hint: INSTALL_HINTS.uvx })
  });
  checks.push({ label: "git (repo detection)", ok: hasBinary("git"), hint: "install git" });

  const repoRoot = gitToplevel(process.cwd());
  let config: FusionConfig | undefined;
  let configError: string | undefined;
  const configNotes: string[] = [];
  if (repoRoot !== undefined) {
    try {
      config = loadFusionConfig(repoRoot, (message) => configNotes.push(message));
    } catch (error) {
      configError = error instanceof FusionConfigError ? error.message : String(error);
    }
  }
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
  const defaultCredentialChecks = credentialChecks(DEFAULT_CLOUD_PANEL);
  const acceptedKeyEnvs = acceptedCredentialEnvs(config);
  for (const name of acceptedKeyEnvs) {
    const ok = keyPresent(name);
    const defaultMembers = defaultCredentialChecks.find((check) => check.env === name)?.members ?? [];
    const memberDetail = defaultMembers.length > 0 ? ` (${defaultMembers.join(", ")})` : "";
    presenter.status(
      ok ? "ok" : "fail",
      name,
      `${ok ? "set" : "not set"}${memberDetail}`,
      ok ? undefined : `export ${name}=... (or add it to .env)`
    );
    report.push({ section: "keys", label: name, ok, detail: ok ? "set" : "not set" });
  }
  const anyCredentials = acceptedKeyEnvs.some((name) => keyPresent(name));
  const missingDefaultKeys = defaultCredentialChecks.filter((check) => !check.present);
  const presentDefaultKeys = defaultCredentialChecks.filter((check) => check.present);

  // Per-platform capability: cloud everywhere; local MLX on Apple Silicon only.
  presenter.blank();
  presenter.heading("platform capability");
  const host = detectHost();
  for (const cap of platformCapabilities()) {
    presenter.status(cap.ok ? "ok" : "pending", cap.label, `— ${cap.detail}`);
    report.push({ section: "platform", label: cap.label, ok: cap.ok, detail: cap.detail });
  }
  const localCapable = host.appleSilicon;

  // Is the pinned Python engine already provisioned (warmed into the uv cache)?
  // Probing it offline is fast either way and tells the user whether the first
  // real run will pay a cold start.
  presenter.blank();
  presenter.heading("fusion engine (Python synthesizer)");
  let engineWarm = false;
  if (!runner) {
    presenter.status(
      "pending",
      dim(`fusionkit@${FUSIONKIT_PYPI_VERSION} — install uv/uvx first, then \`fusionkit setup\``)
    );
    report.push({ section: "engine", label: `fusionkit@${FUSIONKIT_PYPI_VERSION}`, ok: false, detail: "no runner" });
  } else if (await engineCached()) {
    engineWarm = true;
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
    for (const message of configNotes) presenter.note(dim(message));
    if (configError !== undefined) {
      presenter.status("fail", configError);
      report.push({ section: "config", label: "fusion.json", ok: false, detail: configError });
    } else {
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
    }
  }

  const ready = runner && (anyCredentials || localCapable);
  if (ctx.json) {
    ctx.emit({
      ready,
      credentials: {
        any: anyCredentials,
        acceptedKeyEnvs,
        defaultPanel: {
          present: presentDefaultKeys.map((check) => check.env),
          missing: missingDefaultKeys.map((check) => check.env)
        },
        localCapable
      },
      checks: report
    });
    return ready ? 0 : 1;
  }
  presenter.blank();
  if (!ready) {
    if (!runner) {
      presenter.line(red("fusionkit needs uv/uvx to run the synthesizer. Install it, then re-run `fusionkit doctor`."));
      return 1;
    }
    const setupHint = engineWarm ? "" : ` Then run ${bold("fusionkit setup")} to pre-warm the engine.`;
    presenter.line(
      red("almost ready — no provider credentials found and local MLX is not available on this host.") +
        ` Export one of ${bold(acceptedKeyEnvs.join(", "))}.${setupHint}`
    );
    return 1;
  }
  const setupHint = engineWarm ? "" : ` Run ${bold("fusionkit setup")} to pre-warm the engine.`;
  if (presentDefaultKeys.length > 0 && missingDefaultKeys.length > 0) {
    const skipped = missingDefaultKeys
      .flatMap((check) => check.members.map((member) => `${member} (${check.env})`))
      .join(", ");
    presenter.line(
      green("ready with a partial cloud panel.") +
        `${setupHint} Missing panel members will be skipped: ${skipped}. Try: ${bold("fusionkit codex")}`
    );
    return 0;
  }
  if (presentDefaultKeys.length === 0 && missingDefaultKeys.length > 0) {
    const missing = missingDefaultKeys.map((check) => check.env).join(", ");
    presenter.line(
      green("ready with alternate credentials or local MLX.") +
        `${setupHint} Built-in cloud trio keys not set (${missing}); those members will be skipped. Try: ${bold("fusionkit codex")}`
    );
    return 0;
  }
  presenter.line(green("ready.") + `${setupHint} Try: ${bold("fusionkit codex")}`);
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
  registerPaletteAction(
    { label: "Check my environment", hint: "fusionkit doctor", argv: ["doctor"] },
    { label: "Show the effective config", hint: "fusionkit status", argv: ["status"] }
  );
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
