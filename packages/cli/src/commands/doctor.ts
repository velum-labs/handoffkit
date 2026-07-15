/**
 * `fusionkit doctor` — a proactive environment checklist with fix hints. It
 * renders through the presenter and supports `--json` for scripting/CI. The
 * effective config + run preview live in `fusionkit config show`.
 */
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";

import type { Command } from "commander";

import { bold, cyan, dim, formatBytes, green, red } from "@routekit/cli-ui";
import { contextFor, probeBinaryVersion, readPackageVersion } from "@routekit/cli-core";
import type { CommandContext } from "@routekit/cli-core";
import type { Presenter, StatusKind } from "@routekit/cli-ui";
import { resolveWebSearchExecutor } from "@routekit/gateway";

import {
  cliproxyBaseUrl,
  DEFAULT_CLOUD_PANEL,
  defaultKeyEnv,
  gitToplevel,
  loadEnvFileInto
} from "../fusion-quickstart.js";
import type { PanelModelSpec } from "../fusion-quickstart.js";
import { loadFusionConfig, fusionConfigPath, FusionConfigError } from "../fusion-config.js";
import type { FusionConfig } from "../fusion-config.js";
import { detectHost } from "../fusion/local-catalog.js";
import { ownedMlxEnv } from "../fusion/mlx.js";
import { probeOpenAiCompatibleModels } from "../fusion/openai-models.js";
import { FUSIONKIT_PYPI_VERSION } from "../fusion/env.js";
import { platformCapabilities } from "../fusion/platform.js";
import { engineCached } from "../fusion/provision.js";
import { hasBinary, INSTALL_HINTS } from "../shared/preflight.js";
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
async function reportLocalMlx(
  presenter: Presenter,
  report: DoctorEntry[]
): Promise<{ modelsDownloaded: number }> {
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
    return { modelsDownloaded: 0 };
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
  return { modelsDownloaded: downloaded.length };
}

/**
 * Report on a configured CLIProxyAPI upstream (the local OpenAI-compatible
 * proxy fronting OAuth subscription accounts). Only shown when the user has
 * opted in — the ingress key env is set or a panel member uses the provider —
 * so machines that never touch cliproxy see nothing.
 */
async function reportCliproxy(
  presenter: Presenter,
  report: DoctorEntry[],
  config: FusionConfig | undefined
): Promise<void> {
  const keyEnv = defaultKeyEnv("cliproxy") ?? "CLIPROXY_API_KEY";
  const referenced = configuredPanels(config).some((spec) => spec.provider === "cliproxy");
  if (!keyPresent(keyEnv) && !referenced) return;

  presenter.blank();
  presenter.heading("CLIProxyAPI (subscription proxy upstream)");
  const base = cliproxyBaseUrl();
  const push = (entry: Omit<DoctorEntry, "section">): void => {
    report.push({ section: "cliproxy", ...entry });
  };
  const probe = await probeOpenAiCompatibleModels({
    baseUrl: base,
    apiKey: process.env[keyEnv] ?? "",
    timeoutMs: 2500
  });
  switch (probe.kind) {
    case "ok": {
      const count = probe.models.length;
      const detail = `${count} model${count === 1 ? "" : "s"} available`;
      presenter.status("ok", `reachable at ${base}`, detail);
      push({ label: "cliproxy reachable", ok: true, detail });
      return;
    }
    case "unauthorized": {
      const hint = keyPresent(keyEnv)
        ? `the proxy rejected ${keyEnv} — make sure it matches an api-keys entry in the proxy's config`
        : `export ${keyEnv}=... with one of the proxy's api-keys values`;
      presenter.status("fail", `key rejected at ${base}`, `HTTP ${probe.status}`, hint);
      push({ label: "cliproxy key", ok: false, detail: `HTTP ${probe.status}`, hint });
      return;
    }
    case "http-error": {
      presenter.status("warn", `unexpected answer from ${base}`, `HTTP ${probe.status}`);
      push({ label: "cliproxy reachable", ok: false, detail: `HTTP ${probe.status}` });
      return;
    }
    case "unreachable": {
      const hint = "start CLIProxyAPI (see docs/cliproxy-upstream.md), or point CLIPROXY_BASE_URL at it";
      presenter.status("fail", `not reachable at ${base}`, undefined, hint);
      push({ label: "cliproxy reachable", ok: false, detail: "unreachable", hint });
      return;
    }
    default: {
      const exhaustive: never = probe;
      throw new Error(`unknown probe outcome: ${String(exhaustive)}`);
    }
  }
}

/** `fusionkit doctor` — a proactive environment checklist with fix hints. */
async function runDoctor(ctx: CommandContext): Promise<number> {
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
  if (repoRoot !== undefined) {
    let hasCommit = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot, stdio: "ignore" });
      hasCommit = true;
    } catch {
      hasCommit = false;
    }
    checks.push({
      label: "repository has at least one commit",
      ok: hasCommit,
      ...(hasCommit ? { detail: repoRoot } : { hint: "make an initial commit (`git add . && git commit -m \"init\"`)" })
    });
  }

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

  await reportCliproxy(presenter, report, config);

  // Gateway-executed web search: which provider serves each caller dialect.
  presenter.blank();
  presenter.heading("web search (gateway-executed, server-tool parity)");
  for (const dialect of ["responses", "anthropic"] as const) {
    const label = dialect === "responses" ? "codex (responses)" : "claude code (anthropic)";
    const executor = resolveWebSearchExecutor(dialect);
    const disabled = process.env.FUSIONKIT_WEB_SEARCH === "0";
    const detail =
      executor !== undefined
        ? `via ${executor.provider} (${executor.model})`
        : disabled
          ? "disabled (FUSIONKIT_WEB_SEARCH=0)"
          : "no provider key";
    const hint =
      executor !== undefined || disabled
        ? undefined
        : "set OPENAI_API_KEY or ANTHROPIC_API_KEY to enable web search";
    presenter.status(executor !== undefined ? "ok" : disabled ? "pending" : "fail", label, detail, hint);
    report.push({
      section: "web-search",
      label,
      ok: executor !== undefined,
      detail,
      ...(hint !== undefined ? { hint } : {})
    });
  }

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
      `run ${bold("fusionkit setup")} to pre-warm it now`
    );
    report.push({
      section: "engine",
      label: `fusionkit@${FUSIONKIT_PYPI_VERSION}`,
      ok: false,
      detail: "not provisioned"
    });
  }

  const localMlx = await reportLocalMlx(presenter, report);

  // Config status, if any. The effective config + run preview live in
  // `fusionkit config show`; doctor only flags broken or missing files.
  if (repoRoot !== undefined) {
    presenter.blank();
    presenter.heading("repo config");
    for (const message of configNotes) presenter.note(dim(message));
    if (configError !== undefined) {
      presenter.status("fail", configError);
      report.push({ section: "config", label: "fusion.json", ok: false, detail: configError });
    } else if (config === undefined) {
      const trio = DEFAULT_CLOUD_PANEL.map((spec) => spec.id).join(", ");
      presenter.status("pending", `no ${cyan(".fusionkit/")} yet — using built-in defaults (cloud trio: ${trio})`);
      presenter.line(
        `    ${dim(`run ${bold("fusionkit init")} to scaffold one, or ${bold("fusionkit config show")} to see the effective defaults`)}`
      );
      report.push({ section: "config", label: ".fusionkit/fusion.json", ok: false, detail: "not scaffolded" });
    } else {
      presenter.status("ok", cyan(fusionConfigPath(repoRoot)));
      presenter.line(
        `    ${dim(`effective config + run preview: ${bold("fusionkit config show")}`)}`
      );
      report.push({ section: "config", label: fusionConfigPath(repoRoot), ok: true });
    }
  }

  // A "local path" means a model is actually on disk, not merely that the
  // hardware could host one — a bare Apple Silicon machine with no keys and no
  // downloads still cannot serve a request.
  const localReady = localCapable && localMlx.modelsDownloaded > 0;
  const ready = runner && (anyCredentials || localReady);
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
        localCapable,
        localReady
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
    const localHint = localCapable
      ? ` Or download a local model with ${bold("fusionkit models")}.`
      : "";
    presenter.line(
      red("almost ready — no provider credentials found and no local model is downloaded.") +
        ` Export one of ${bold(acceptedKeyEnvs.join(", "))}.${localHint}${setupHint}`
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

export function registerDoctor(program: Command): void {
  registerPaletteAction(
    { label: "Check my environment", hint: "fusionkit doctor", argv: ["doctor"] },
    { label: "Show the effective config", hint: "fusionkit config show", argv: ["config", "show"] }
  );
  program
    .command("doctor")
    .description("check that prerequisites (uv, agents, keys, git) are ready")
    .option("--json", "emit machine-readable JSON")
    .action(async (_opts: { json?: boolean }, command: Command) => {
      process.exitCode = await runDoctor(contextFor(command));
    });
}
