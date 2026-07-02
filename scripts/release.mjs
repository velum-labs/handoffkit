#!/usr/bin/env node
// Cross-repo release coordinator, Terraform-style. Designed to be driven by an
// agent: every command supports `--json` for machine-readable output, surfaces
// the URLs an agent should poll/listen to (workflow runs, releases, registry
// pages), lets the caller control exactly which files land in a release commit,
// and supports non-blocking apply (`--no-wait`) plus `status`/`verify` polling.
//
//   node scripts/release.mjs plan    [-target=<unit>] [--json]
//   node scripts/release.mjs apply   [--plan <file>] [--auto-approve] [--no-wait]
//                                     [--include <path>] [--allow-dirty] [-target=<unit>] [--json]
//   node scripts/release.mjs status  [-target=<unit>] [--watch] [--json]
//   node scripts/release.mjs verify  [-target=<unit>] [--json]
//   node scripts/release.mjs refresh [--json]
//   node scripts/release.mjs graph   [--json]
//   node scripts/release.mjs bump    <unit> <version|major|minor|patch>
//
// Declarative state lives in release/: workspace.release.json (topology /
// providers), desired.json (target versions / config), state.json (last-applied
// cache). `plan` refreshes the real published versions from npm/PyPI/git tags,
// diffs them against desired in dependency order, and writes a reviewable plan
// artifact. `apply` executes that plan idempotently. Dependency-free Node ESM.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const RELEASE_DIR = join(REPO_ROOT, "release");
const TOPOLOGY_PATH = join(RELEASE_DIR, "workspace.release.json");
const DESIRED_PATH = join(RELEASE_DIR, "desired.json");
const STATE_PATH = join(RELEASE_DIR, "state.json");
const PLANS_DIR = join(RELEASE_DIR, ".plans");

const ECOSYSTEMS = ["pnpm-monorepo", "npm-single", "uv-monorepo", "python-single", "protocol-dual"];

// Global flags, parsed once in main(). In JSON mode all human-readable logs go
// to stderr so stdout carries exactly one JSON document.
const OPTIONS = {
  json: false,
  noWait: false,
  allowDirty: false,
  autoApprove: false,
  watch: false,
  targets: [],
  includes: [],
  planPath: null
};

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const log = (msg) => (OPTIONS.json ? process.stderr : process.stdout).write(`${msg}\n`);
const warn = (msg) => process.stderr.write(`warning: ${msg}\n`);

// Print the single JSON result document to stdout (json mode only).
function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

const die = (msg) => {
  if (OPTIONS.json) emit({ ok: false, error: msg });
  else process.stderr.write(`release: ${msg}\n`);
  process.exit(1);
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    status: res.status,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    ok: res.status === 0
  };
}

// best-effort stdout, or null on any failure (offline, missing binary, etc.)
function tryOut(cmd, args, opts = {}) {
  const res = run(cmd, args, opts);
  return res.ok ? res.stdout : null;
}

function httpsJson(url, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    const req = httpsGet(url, { headers: { "user-agent": "fusionkit-release" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolvePromise(null);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolvePromise(JSON.parse(body));
        } catch {
          resolvePromise(null);
        }
      });
    });
    req.on("error", () => resolvePromise(null));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolvePromise(null);
    });
  });
}

// ---------------------------------------------------------------------------
// version helpers (semver-ish, tolerant of build metadata like 0.31.3+structured.3)
// ---------------------------------------------------------------------------

function bumpVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind; // explicit version

  // Preserve a +local build segment (e.g. mlx 0.31.3+structured.3): bumping
  // patch increments the trailing local counter when present.
  const plus = current.indexOf("+");
  if (plus !== -1) {
    const base = current.slice(0, plus);
    const local = current.slice(plus + 1);
    const m = local.match(/^(.*?)(\d+)$/);
    if (m && (kind === "patch" || kind === "build")) {
      return `${base}+${m[1]}${Number(m[2]) + 1}`;
    }
    current = base;
  }

  const parts = current.split(".").map((n) => Number.parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  let [major, minor, patch] = parts;
  switch (kind) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
    case "build":
      return `${major}.${minor}.${patch + 1}`;
    default:
      die(`unknown bump kind: ${kind} (use major|minor|patch or an explicit X.Y.Z)`);
      return current;
  }
}

// Order two semver-ish versions numerically (build/pre metadata ignored).
// Returns -1 | 0 | 1, or null when either side cannot be parsed as X.Y.Z.
function compareSemver(a, b) {
  const norm = (v) => {
    const base = String(v).split("+")[0].split("-")[0];
    const parts = base.split(".").map((n) => Number.parseInt(n, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    while (parts.length < 3) parts.push(0);
    return parts;
  };
  const pa = norm(a);
  const pb = norm(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// version-source read/write (package.json#field, pyproject#project.version, _version.py)
// ---------------------------------------------------------------------------

function parseSource(spec) {
  const hash = spec.indexOf("#");
  if (hash === -1) return { file: spec, field: null };
  return { file: spec.slice(0, hash), field: spec.slice(hash + 1) };
}

function getNested(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function readVersionSource(repoAbs, spec) {
  const { file, field } = parseSource(spec);
  const path = join(repoAbs, file);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  if (file.endsWith(".json")) {
    const json = JSON.parse(text);
    return field ? getNested(json, field) ?? null : null;
  }
  if (file.endsWith(".toml")) {
    // `version = "X"` inside the first [project] table.
    const m = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  }
  if (file.endsWith(".py")) {
    const name = field ?? "__version__";
    const re = new RegExp(`${name}\\s*=\\s*"([^"]+)"`);
    const m = text.match(re);
    return m ? m[1] : null;
  }
  return null;
}

function writeVersionSource(repoAbs, spec, version) {
  const { file, field } = parseSource(spec);
  const path = join(repoAbs, file);
  if (!existsSync(path)) return false;
  let text = readFileSync(path, "utf8");
  if (file.endsWith(".json")) {
    const json = JSON.parse(text);
    const keys = (field ?? "version").split(".");
    let node = json;
    for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]];
    node[keys[keys.length - 1]] = version;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
    return true;
  }
  if (file.endsWith(".toml")) {
    text = text.replace(/^(\s*version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
    writeFileSync(path, text);
    return true;
  }
  if (file.endsWith(".py")) {
    const name = field ?? "__version__";
    const re = new RegExp(`(${name}\\s*=\\s*")[^"]+(")`);
    text = text.replace(re, `$1${version}$2`);
    writeFileSync(path, text);
    return true;
  }
  if (file.endsWith(".ts")) {
    text = text.replace(
      /(export const FUSIONKIT_PYPI_VERSION = ")[^"]+(")/,
      `$1${version}$2`
    );
    writeFileSync(path, text);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// topology / desired / state loading and the dependency graph
// ---------------------------------------------------------------------------

function loadWorkspace() {
  if (!existsSync(TOPOLOGY_PATH)) die(`missing ${TOPOLOGY_PATH}`);
  if (!existsSync(DESIRED_PATH)) die(`missing ${DESIRED_PATH}`);
  const topology = readJson(TOPOLOGY_PATH);
  const desired = readJson(DESIRED_PATH);
  const state = existsSync(STATE_PATH) ? readJson(STATE_PATH) : { lastApply: null, units: {} };
  const workspaceRoot = resolve(REPO_ROOT, topology.workspaceRoot ?? "..");
  for (const unit of topology.units) {
    unit.absRepo = isAbsolute(unit.repo) ? unit.repo : join(workspaceRoot, unit.repo);
    unit.present = existsSync(unit.absRepo);
    unit.desired = desired.versions?.[unit.key] ?? null;
    if (!ECOSYSTEMS.includes(unit.ecosystem)) {
      die(`unit ${unit.key} has unknown ecosystem ${unit.ecosystem}`);
    }
  }
  return { topology, desired, state, workspaceRoot };
}

function topoOrder(units) {
  const byKey = new Map(units.map((u) => [u.key, u]));
  const indeg = new Map(units.map((u) => [u.key, 0]));
  const adj = new Map(units.map((u) => [u.key, []]));
  for (const u of units) {
    for (const dep of u.dependsOn ?? []) {
      if (!byKey.has(dep)) die(`unit ${u.key} depends on unknown unit ${dep}`);
      adj.get(dep).push(u.key);
      indeg.set(u.key, indeg.get(u.key) + 1);
    }
  }
  const queue = units.filter((u) => indeg.get(u.key) === 0).map((u) => u.key);
  const order = [];
  while (queue.length) {
    queue.sort();
    const key = queue.shift();
    order.push(key);
    for (const next of adj.get(key)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== units.length) die("dependency cycle detected in release graph");
  return order;
}

// owner/repo from the unit's git remote, for `gh -R`.
function remoteSlug(unit) {
  if (!unit.present) return null;
  const url = tryOut("git", ["-C", unit.absRepo, "remote", "get-url", "origin"]);
  if (!url) return null;
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

function tagFor(unit, version) {
  return unit.tagPattern.replace("{version}", version);
}

// --- URL helpers (the things an agent listens to / reports) --------------

const GH_BASE = "https://github.com";

function repoUrl(slug) {
  return slug ? `${GH_BASE}/${slug}` : null;
}

function releaseUrl(slug, tag) {
  return slug && tag ? `${GH_BASE}/${slug}/releases/tag/${encodeURIComponent(tag)}` : null;
}

function workflowUrl(slug, workflow) {
  return slug && workflow ? `${GH_BASE}/${slug}/actions/workflows/${workflow}` : null;
}

function registryUrl(reg) {
  switch (reg.kind) {
    case "npm":
      return `https://www.npmjs.com/package/${reg.package}`;
    case "pypi":
      return `https://pypi.org/project/${reg.package}/`;
    case "private-pypi":
      return null;
    default:
      return null;
  }
}

// All the URLs an agent might want for a unit, resolved from its git remote.
function unitUrls(unit, version) {
  const slug = remoteSlug(unit);
  const tag = version ? tagFor(unit, version) : null;
  return {
    slug,
    repo: repoUrl(slug),
    actions: workflowUrl(slug, unit.publishWorkflow),
    release: releaseUrl(slug, tag),
    registries: (unit.registries ?? []).map((reg) => ({
      kind: reg.kind,
      package: reg.package,
      url: registryUrl(reg)
    }))
  };
}

// ---------------------------------------------------------------------------
// refresh: declared (local) + published (registry) + latest git tag
// ---------------------------------------------------------------------------

async function refreshUnit(unit) {
  const declared = unit.present ? readVersionSource(unit.absRepo, unit.versionSources[0]) : null;

  let published = null;
  for (const reg of unit.registries ?? []) {
    if (reg.kind === "npm") {
      published = tryOut("npm", ["view", reg.package, "version"]);
    } else if (reg.kind === "pypi") {
      const data = await httpsJson(`https://pypi.org/pypi/${reg.package}/json`);
      published = data?.info?.version ?? null;
    }
    // private-pypi: not queryable here; fall back to git tags below.
    if (published) break;
  }

  let latestTag = null;
  if (unit.present) {
    const prefix = unit.tagPattern.replace("{version}", "");
    const tags = tryOut("git", ["-C", unit.absRepo, "tag", "--list", `${prefix}*`]);
    if (tags) {
      const list = tags.split("\n").filter(Boolean);
      latestTag = list.sort()[list.length - 1] ?? null;
    }
  }

  return { declared, published, latestTag };
}

// ---------------------------------------------------------------------------
// plan: build the typed, ordered action graph
// ---------------------------------------------------------------------------

async function buildPlan(targets) {
  const { topology, state, workspaceRoot } = loadWorkspace();
  const allUnits = topology.units;
  const order = topoOrder(allUnits);
  const byKey = new Map(allUnits.map((u) => [u.key, u]));

  const targetSet = targets.length ? new Set(targets) : null;
  if (targetSet) {
    for (const t of targetSet) if (!byKey.has(t)) die(`unknown -target unit: ${t}`);
  }

  // Determine which units actually change (desired != published/declared).
  const refreshed = new Map();
  for (const key of order) {
    refreshed.set(key, await refreshUnit(byKey.get(key)));
  }

  const protocolUnit = byKey.get("fusionkit-protocol");
  const protocolChanging =
    protocolUnit &&
    protocolUnit.desired &&
    protocolUnit.desired !== (refreshed.get("fusionkit-protocol")?.published ?? refreshed.get("fusionkit-protocol")?.declared);

  const planUnits = {};
  for (const key of order) {
    const unit = byKey.get(key);
    const { declared, published, latestTag } = refreshed.get(key);
    const desired = unit.desired;
    const inTarget = !targetSet || targetSet.has(key);

    const actions = [];
    let changeKind = "noop";

    if (!unit.present) {
      changeKind = "absent";
    } else if (!desired) {
      changeKind = "no-desired";
    } else {
      const needsBump = declared !== desired;
      // The version we can prove is already released (registry, then latest git
      // tag, then recorded state). Null when nothing is observable.
      const releasedRef = published ?? latestTagVersion(unit, latestTag) ?? state.units?.[key]?.published ?? null;
      // Best-known reference for change detection: fall back to the declared
      // baseline when nothing is observable.
      const reference = releasedRef ?? declared;
      const needsPublish = desired !== reference;
      // Refuse to publish a version older than what is already released.
      const isDowngrade = releasedRef != null && compareSemver(desired, releasedRef) === -1;
      const releasing = !isDowngrade && (needsBump || needsPublish) && inTarget;
      const consumesProtocol =
        unit.key !== "fusionkit-protocol" && (unit.dependsOn ?? []).includes("fusionkit-protocol");

      if (isDowngrade) {
        changeKind = "downgrade";
      } else if (releasing) {
        // Pin propagation only applies to consumers that are themselves being
        // released, so the new pin ships (no dangling uncommitted edits). It
        // runs before the commit so it is included in the release commit.
        if (consumesProtocol && protocolChanging) {
          actions.push({ type: "propagate-pin", from: "fusionkit-protocol", version: protocolUnit.desired });
        }
        if (needsBump) {
          actions.push({ type: "bump", to: desired });
          if (unit.key === "handoffkit") actions.push({ type: "changelog", version: desired });
        }
        actions.push({ type: "commit", message: `release(${unit.key}): v${desired}` });
        actions.push({ type: "push" });
        const tag = tagFor(unit, desired);
        if (unit.releaseTrigger === "tag-push") {
          actions.push({ type: "tag", tag });
          actions.push({ type: "push-tag", tag });
        } else {
          actions.push({ type: "gh-release", tag });
        }
        actions.push({ type: "wait-workflow", workflow: unit.publishWorkflow });
        changeKind = needsBump ? "bump+publish" : "publish";
      } else if (!inTarget) {
        changeKind = "skipped-target";
      } else if (consumesProtocol && protocolChanging) {
        // Protocol is changing but this consumer is not being released; flag the
        // lag so the operator can choose to bump it too.
        changeKind = "pin-lag";
      }
    }

    planUnits[key] = {
      key,
      ecosystem: unit.ecosystem,
      repo: unit.repo,
      present: unit.present,
      releaseTrigger: unit.releaseTrigger,
      publishWorkflow: unit.publishWorkflow,
      declared,
      published,
      latestTag,
      desired,
      tag: desired ? tagFor(unit, desired) : null,
      changeKind,
      actions,
      urls: unit.present ? unitUrls(unit, desired) : null
    };
  }

  return {
    createdAt: new Date().toISOString(),
    workspaceRoot,
    targets: targets.length ? targets : "all",
    order,
    protocolChanging: Boolean(protocolChanging),
    units: planUnits,
    previousApply: state.lastApply
  };
}

function latestTagVersion(unit, latestTag) {
  if (!latestTag) return null;
  const prefix = unit.tagPattern.replace("{version}", "");
  return latestTag.startsWith(prefix) ? latestTag.slice(prefix.length) : null;
}

// ---------------------------------------------------------------------------
// plan rendering + artifact
// ---------------------------------------------------------------------------

function writePlanArtifact(plan) {
  mkdirSync(PLANS_DIR, { recursive: true });
  const stamp = plan.createdAt.replace(/[:.]/g, "-");
  const path = join(PLANS_DIR, `${stamp}.plan.json`);
  writeJson(path, plan);
  return path;
}

function symbolFor(changeKind) {
  switch (changeKind) {
    case "bump+publish":
      return "~";
    case "publish":
      return "+";
    case "noop":
      return " ";
    case "absent":
      return "?";
    case "no-desired":
      return "!";
    case "skipped-target":
      return "-";
    case "pin-lag":
      return "!";
    case "downgrade":
      return "x";
    default:
      return " ";
  }
}

function printPlan(plan) {
  log("");
  log("Cross-repo release plan");
  log(`  workspace: ${plan.workspaceRoot}`);
  log(`  targets:   ${plan.targets === "all" ? "all units" : plan.targets.join(", ")}`);
  if (plan.protocolChanging) log("  note:      protocol version is changing; consumer pins will be propagated");
  log("");
  log("  order (dependency-topological):");
  for (const key of plan.order) {
    const u = plan.units[key];
    const sym = symbolFor(u.changeKind);
    const versions =
      u.changeKind === "absent"
        ? "(repo not present in workspace)"
        : `declared=${u.declared ?? "?"} published=${u.published ?? "?"} -> desired=${u.desired ?? "?"}`;
    log(`   ${sym} ${key.padEnd(20)} ${versions}`);
    for (const action of u.actions) {
      log(`        - ${describeAction(action)}`);
    }
  }
  const changing = plan.order.filter((k) => ["bump+publish", "publish"].includes(plan.units[k].changeKind));
  const pinLag = plan.order.filter((k) => plan.units[k].changeKind === "pin-lag");
  log("");
  log(
    changing.length
      ? `Plan: ${changing.length} unit(s) to release: ${changing.join(", ")}.`
      : "Plan: no changes. All units already at their desired versions."
  );
  if (pinLag.length) {
    log(
      `Warning: protocol is changing but these consumers are not being released and will keep the old pin: ${pinLag.join(", ")}. Bump them too to ship the new contract.`
    );
  }
  const downgrades = plan.order.filter((k) => plan.units[k].changeKind === "downgrade");
  if (downgrades.length) {
    log("");
    for (const key of downgrades) {
      const u = plan.units[key];
      log(`ERROR: ${key} desired ${u.desired} is older than the released ${u.published ?? u.latestTag}. Refusing to downgrade.`);
    }
    process.exitCode = 1;
  }
  log("Legend: ~ bump+publish   + publish   (blank) no-op   ? absent   ! pin-lag/no desired   x downgrade");
  log("");
}

function describeAction(action) {
  switch (action.type) {
    case "propagate-pin":
      return `propagate ${action.from} pin -> ${action.version}`;
    case "bump":
      return `bump version -> ${action.to}`;
    case "changelog":
      return `update CHANGELOG.md for ${action.version}`;
    case "commit":
      return `git commit "${action.message}"`;
    case "push":
      return "git push";
    case "tag":
      return `git tag ${action.tag}`;
    case "push-tag":
      return `git push ${action.tag}`;
    case "gh-release":
      return `gh release create ${action.tag} (publishes -> triggers workflow)`;
    case "wait-workflow":
      return `wait for ${action.workflow}`;
    default:
      return JSON.stringify(action);
  }
}

// ---------------------------------------------------------------------------
// command entry points
// ---------------------------------------------------------------------------

async function cmdPlan() {
  const plan = await buildPlan(OPTIONS.targets);
  const path = writePlanArtifact(plan);
  plan.planPath = path;
  if (OPTIONS.json) {
    const hasDowngrade = plan.order.some((k) => plan.units[k].changeKind === "downgrade");
    emit({ ok: !hasDowngrade, ...plan });
    if (hasDowngrade) process.exitCode = 1;
    return;
  }
  printPlan(plan);
  log(`Saved plan: ${path}`);
  log("Apply with: node scripts/release.mjs apply --auto-approve");
}

async function cmdRefresh() {
  const { topology, state } = loadWorkspace();
  const order = topoOrder(topology.units);
  const byKey = new Map(topology.units.map((u) => [u.key, u]));
  log("Refreshing actual release state from registries + git tags...");
  const units = {};
  for (const key of order) {
    const unit = byKey.get(key);
    const r = await refreshUnit(unit);
    state.units[key] = {
      declared: r.declared,
      published: r.published,
      latestTag: r.latestTag,
      refreshedAt: new Date().toISOString()
    };
    units[key] = { ...state.units[key], urls: unit.present ? unitUrls(unit, r.declared) : null };
    log(`  ${key.padEnd(20)} declared=${r.declared ?? "?"} published=${r.published ?? "?"} tag=${r.latestTag ?? "-"}`);
  }
  writeJson(STATE_PATH, state);
  if (OPTIONS.json) {
    emit({ ok: true, units });
    return;
  }
  log(`Wrote ${STATE_PATH}`);
}

async function cmdGraph() {
  const { topology } = loadWorkspace();
  const order = topoOrder(topology.units);
  if (OPTIONS.json) {
    emit({
      ok: true,
      order,
      units: topology.units.map((u) => ({
        key: u.key,
        repo: u.repo,
        ecosystem: u.ecosystem,
        dependsOn: u.dependsOn ?? [],
        tagPattern: u.tagPattern,
        publishWorkflow: u.publishWorkflow,
        releaseTrigger: u.releaseTrigger
      })),
      tracked: topology.tracked ?? []
    });
    return;
  }
  log("Release dependency graph (topological order):");
  for (const key of order) {
    const unit = topology.units.find((u) => u.key === key);
    const deps = (unit.dependsOn ?? []).join(", ") || "(roots)";
    log(`  ${key.padEnd(20)} <- ${deps}`);
  }
}

function cmdBump(args) {
  const [unitKey, version] = args.filter((a) => !a.startsWith("-"));
  if (!unitKey || !version) die("usage: release bump <unit> <version|major|minor|patch>");
  const desired = readJson(DESIRED_PATH);
  if (!(unitKey in (desired.versions ?? {}))) die(`unknown unit ${unitKey}`);
  const current = desired.versions[unitKey];
  const next = bumpVersion(current, version);
  desired.versions[unitKey] = next;
  writeJson(DESIRED_PATH, desired);
  log(`${unitKey}: ${current} -> ${next} (in release/desired.json)`);
  log("Run `node scripts/release.mjs plan` to preview the release.");
}

// ---------------------------------------------------------------------------
// apply: execute a saved plan idempotently, in dependency order
// ---------------------------------------------------------------------------

function latestPlanPath() {
  if (!existsSync(PLANS_DIR)) return null;
  const files = readdirSync(PLANS_DIR)
    .filter((f) => f.endsWith(".plan.json"))
    .sort();
  return files.length ? join(PLANS_DIR, files[files.length - 1]) : null;
}

async function cmdApply() {
  const autoApprove = OPTIONS.autoApprove;
  const targetSet = OPTIONS.targets.length ? new Set(OPTIONS.targets) : null;

  const planPath = OPTIONS.planPath ?? latestPlanPath();
  if (!planPath || !existsSync(planPath)) {
    die("no plan found. Run `node scripts/release.mjs plan` first (or pass --plan <file>).");
  }
  const plan = readJson(planPath);
  log(`Applying plan: ${planPath}`);

  const { topology, state } = loadWorkspace();
  const byKey = new Map(topology.units.map((u) => [u.key, u]));

  const fullActionable = plan.order.filter((k) => (plan.units[k]?.actions ?? []).length > 0);

  // -target dependency closure: pull in any actionable dependency so we never
  // release a unit against an upstream that this run leaves unpublished.
  let actionable = fullActionable;
  if (targetSet) {
    const expanded = new Set(targetSet);
    let changed = true;
    while (changed) {
      changed = false;
      for (const key of [...expanded]) {
        for (const dep of byKey.get(key)?.dependsOn ?? []) {
          if (fullActionable.includes(dep) && !expanded.has(dep)) {
            expanded.add(dep);
            changed = true;
          }
        }
      }
    }
    const pulledIn = [...expanded].filter((k) => !targetSet.has(k));
    if (pulledIn.length) {
      log(`Pulled in actionable dependencies of the target(s): ${pulledIn.join(", ")}`);
    }
    actionable = fullActionable.filter((k) => expanded.has(k));
  }

  if (!actionable.length) {
    log("Nothing to apply: plan has no actions for the selected units.");
    return;
  }

  if (!autoApprove) {
    log("");
    log("This apply would execute the following (re-run with --auto-approve to proceed):");
    for (const key of actionable) {
      log(`  ${key}:`);
      for (const action of plan.units[key].actions) log(`    - ${describeAction(action)}`);
    }
    log("");
    log("Refusing to mutate without --auto-approve.");
    return;
  }

  const results = {};
  for (const key of actionable) {
    const unit = byKey.get(key);
    const planUnit = plan.units[key];
    if (!unit || !unit.present) {
      warn(`skipping ${key}: repo not present`);
      results[key] = { status: "skipped-absent" };
      continue;
    }
    log("");
    log(`== ${key} (${unit.absRepo}) ==`);
    const ctx = { touched: new Set(), sha: null, releaseUrl: null, run: null };
    try {
      await assertReleasable(unit, planUnit);
      for (const action of planUnit.actions) {
        await executeAction(unit, action, planUnit, ctx);
      }
      const triggered = OPTIONS.noWait && ctx.run && ctx.run.conclusion == null;
      results[key] = {
        status: triggered ? "triggered" : "released",
        version: planUnit.desired,
        tag: planUnit.tag,
        sha: ctx.sha,
        releaseUrl: ctx.releaseUrl,
        run: ctx.run,
        urls: unitUrls(unit, planUnit.desired)
      };
      state.units[key] = {
        declared: planUnit.desired,
        published: triggered ? state.units[key]?.published ?? null : planUnit.desired,
        latestTag: planUnit.tag,
        runUrl: ctx.run?.url ?? null,
        releaseUrl: ctx.releaseUrl,
        refreshedAt: new Date().toISOString()
      };
    } catch (err) {
      results[key] = { status: "failed", error: String(err.message ?? err) };
      warn(`${key} failed: ${err.message ?? err}`);
      warn("Stopping: dependent units will not be released. Fix, re-plan, and re-apply.");
      break;
    }
  }

  state.lastApply = { at: new Date().toISOString(), plan: planPath, results };
  writeJson(STATE_PATH, state);

  const ok = !Object.values(results).some((r) => r.status === "failed");
  if (OPTIONS.json) {
    emit({ ok, plan: planPath, waited: !OPTIONS.noWait, results });
    if (!ok) process.exitCode = 1;
    return;
  }

  log("");
  log("Apply summary:");
  for (const key of plan.order) {
    const r = results[key];
    if (!r) continue;
    const extra = r.run?.url ? `  run: ${r.run.url}` : r.releaseUrl ? `  release: ${r.releaseUrl}` : "";
    log(`  ${key.padEnd(20)} ${r.status}${r.version ? ` v${r.version}` : ""}${r.error ? ` (${r.error})` : ""}${extra}`);
  }
  if (OPTIONS.noWait) log("\nReleases triggered. Poll with: node scripts/release.mjs status --json");
}

// Verify the repo is in a releasable state and that reality still matches the
// plan (Terraform-style drift detection) before mutating anything.
async function assertReleasable(unit, planUnit) {
  const expectedBranch = unit.branch ?? "main";
  const branch = tryOut("git", ["-C", unit.absRepo, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== expectedBranch) {
    throw new Error(`on branch ${branch}, expected ${expectedBranch}`);
  }

  // Clean working tree: no staged/unstaged/deleted tracked changes (untracked
  // files are allowed; the commit only stages files this tool touches). The
  // agent can opt out with --allow-dirty when it has deliberately staged extra
  // files it intends to ship via --include.
  const status = run("git", ["-C", unit.absRepo, "status", "--porcelain"]);
  if (status.ok) {
    const dirty = status.stdout.split("\n").filter((line) => line && !line.startsWith("??"));
    if (dirty.length && !OPTIONS.allowDirty) {
      throw new Error(`working tree has uncommitted changes (${dirty.length} file(s)); commit, stash, or pass --allow-dirty`);
    }
    if (dirty.length) warn(`  --allow-dirty: ${dirty.length} uncommitted file(s) present; only tool-touched + --include files will be committed`);
  }

  // Up to date with the remote: refuse if behind upstream.
  run("git", ["-C", unit.absRepo, "fetch", "--quiet"]);
  const counts = tryOut("git", ["-C", unit.absRepo, "rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (counts) {
    const [behind] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (behind > 0) throw new Error(`local is ${behind} commit(s) behind ${expectedBranch}; pull first`);
  }

  // Drift: the released/declared versions must still match what the plan saw.
  const fresh = await refreshUnit(unit);
  if (fresh.declared !== planUnit.declared || fresh.published !== planUnit.published) {
    throw new Error(
      `state drifted since plan (declared ${fresh.declared}/${planUnit.declared}, published ${fresh.published}/${planUnit.published}); re-run plan`
    );
  }
  log("  preconditions ok (branch, clean tree, up-to-date, no drift)");
}

async function executeAction(unit, action, planUnit, ctx) {
  switch (action.type) {
    case "propagate-pin":
      for (const f of propagateProtocolPin(unit, action.version)) ctx.touched.add(f);
      return;
    case "bump":
      for (const f of applyBump(unit, action.to)) ctx.touched.add(f);
      return;
    case "changelog":
      for (const f of updateChangelog(unit, action.version)) ctx.touched.add(f);
      return;
    case "commit":
      // Stage tool-touched files plus any unit-declared or agent-supplied
      // extras, so the agent has full control over what the release commits.
      for (const f of unit.extraCommitPaths ?? []) ctx.touched.add(f);
      for (const f of OPTIONS.includes) ctx.touched.add(f);
      ctx.sha = gitCommit(unit, action.message, ctx.touched);
      return;
    case "push":
      gitPush(unit);
      return;
    case "tag":
      gitTag(unit, action.tag);
      return;
    case "push-tag":
      gitPushTag(unit, action.tag);
      return;
    case "gh-release":
      ctx.releaseUrl = ghRelease(unit, action.tag);
      return;
    case "wait-workflow":
      ctx.run = await waitForWorkflow(unit, action.workflow, ctx.sha);
      return;
    default:
      throw new Error(`unknown action type: ${action.type}`);
  }
}

// --- bump adapters (the "providers") -------------------------------------

// Returns the repo-relative files it modified, so the commit can stage exactly
// those (never `git add -A`).
function applyBump(unit, version) {
  let touched = [];
  switch (unit.ecosystem) {
    case "pnpm-monorepo":
      touched = bumpPnpmMonorepo(unit, version);
      break;
    case "npm-single":
    case "python-single":
    case "protocol-dual":
    case "uv-monorepo":
      for (const source of unit.versionSources) {
        if (writeVersionSource(unit.absRepo, source, version)) {
          touched.push(parseSource(source).file);
        } else {
          warn(`${unit.key}: could not write version source ${source}`);
        }
      }
      if (unit.ecosystem === "uv-monorepo") {
        touched.push(...repinUvInternalDeps(unit, version));
        touched.push(...regenerateUvLock(unit));
        touched.push(...bumpFusionkitPypiPin(unit.absRepo, version));
      }
      break;
    default:
      throw new Error(`no bump adapter for ecosystem ${unit.ecosystem}`);
  }
  log(`  bumped ${unit.key} -> ${version}`);
  return touched;
}

// Keep the npm CLI's uvx pin aligned with the PyPI distribution version.
function bumpFusionkitPypiPin(repoAbs, version) {
  const rel = "packages/cli/src/fusion/env.ts";
  if (writeVersionSource(repoAbs, `${rel}#FUSIONKIT_PYPI_VERSION`, version)) {
    return [rel];
  }
  return [];
}

// handoffkit: root + all publishable @fusionkit/* + release/npm-packages.json protocol.version.
function bumpPnpmMonorepo(unit, version) {
  const touched = ["package.json"];
  writeVersionSource(unit.absRepo, "package.json#version", version);
  const manifestPath = join(unit.absRepo, "release", "npm-packages.json");
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (manifest.protocol) manifest.protocol.version = version;
    for (const entry of manifest.packages ?? []) {
      writeVersionSource(unit.absRepo, `${entry.path}/package.json#version`, version);
      touched.push(`${entry.path}/package.json`);
    }
    writeJson(manifestPath, manifest);
    touched.push("release/npm-packages.json");
  }
  // check-model-fusion-protocol.mjs requires publishedProtocolMetadata.version
  // to equal the root package version, so keep it in lockstep on every bump.
  const bindingsPath = join(unit.absRepo, "packages", "protocol", "model-fusion-bindings.json");
  if (existsSync(bindingsPath)) {
    const bindings = readJson(bindingsPath);
    if (bindings.publishedProtocolMetadata?.version !== undefined) {
      bindings.publishedProtocolMetadata.version = version;
      writeJson(bindingsPath, bindings);
      touched.push("packages/protocol/model-fusion-bindings.json");
    }
  }
  touched.push(...bumpFusionkitPypiPin(unit.absRepo, version));
  return touched;
}

// fusionkit-pypi: keep every member's internal `fusionkit-*==X` pins in lockstep
// (not just fusionkit-cli's) so the published wheels resolve against each other.
function repinUvInternalDeps(unit, version) {
  const touched = [];
  const rels = new Set((unit.versionSources ?? []).map((source) => parseSource(source).file));
  for (const rel of rels) {
    const pyproject = join(unit.absRepo, rel);
    if (!existsSync(pyproject)) continue;
    const text = readFileSync(pyproject, "utf8");
    const updated = text.replace(/("(?:fusionkit(?:-[a-z]+)?)==)[^"]+(")/g, `$1${version}$2`);
    if (updated !== text) {
      writeFileSync(pyproject, updated);
      touched.push(rel);
    }
  }
  return touched;
}

// fusionkit-pypi: bumping the member pyproject versions makes uv.lock stale, so
// the release workflow's `uv lock --check` would fail (it has, every release).
// Regenerate the lockfile in lockstep so the release commit carries a current
// uv.lock. Plain `uv lock` only resolves what the bump changed (no --upgrade).
function regenerateUvLock(unit) {
  const lockPath = join(unit.absRepo, "uv.lock");
  if (!existsSync(lockPath)) return [];
  const res = run("uv", ["lock"], { cwd: unit.absRepo });
  if (!res.ok) {
    die(
      `${unit.key}: \`uv lock\` failed while refreshing the lockfile after the ` +
        `version bump:\n${res.stderr || res.stdout}`
    );
  }
  return ["uv.lock"];
}

// --- protocol pin propagation into consumers ------------------------------

function propagateProtocolPin(unit, version) {
  const touched = [];
  const pkgPath = join(unit.absRepo, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    let changed = false;
    if (pkg.devDependencies?.["@velum-labs/model-fusion-protocol"]) {
      pkg.devDependencies["@velum-labs/model-fusion-protocol"] = version;
      changed = true;
    }
    if (pkg.dependencies?.["@velum-labs/model-fusion-protocol"]) {
      pkg.dependencies["@velum-labs/model-fusion-protocol"] = version;
      changed = true;
    }
    if (pkg.modelFusionProtocol?.version) {
      pkg.modelFusionProtocol.version = version;
      changed = true;
    }
    if (changed) {
      writeJson(pkgPath, pkg);
      touched.push("package.json");
    }
  }
  // handoffkit pins it in a second place: the trusted-dependency allowlist.
  const rel = "scripts/check-repo.mjs";
  const checkRepo = join(unit.absRepo, rel);
  if (existsSync(checkRepo)) {
    const text = readFileSync(checkRepo, "utf8");
    const next = text.replace(/(\["@velum-labs\/model-fusion-protocol",\s*")[^"]+("\])/, `$1${version}$2`);
    if (next !== text) {
      writeFileSync(checkRepo, next);
      touched.push(rel);
    }
  }
  log(`  propagated @velum-labs/model-fusion-protocol pin -> ${version} in ${unit.key}`);
  return touched;
}

function updateChangelog(unit, version) {
  const path = join(unit.absRepo, "CHANGELOG.md");
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## ${version} - ${date}\n\n- Release cut via the cross-repo coordinator (\`scripts/release.mjs\`).\n\n`;
  let text = existsSync(path) ? readFileSync(path, "utf8") : "# Changelog\n\n";
  text = text.replace(/^(# Changelog\n\n)/, `$1${entry}`);
  if (!text.includes(entry)) text = `# Changelog\n\n${entry}${text.replace(/^# Changelog\n\n/, "")}`;
  writeFileSync(path, text);
  log(`  updated CHANGELOG.md`);
  return ["CHANGELOG.md"];
}

// --- git / gh actions -----------------------------------------------------

// Stages exactly the files this run touched (never `git add -A`) and returns
// the new HEAD sha for SHA-matched workflow waiting.
function gitCommit(unit, message, touched) {
  const files = [...touched];
  if (!files.length) {
    warn("  no files to commit");
    return tryOut("git", ["-C", unit.absRepo, "rev-parse", "HEAD"]);
  }
  const add = run("git", ["-C", unit.absRepo, "add", "--", ...files]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr || add.stdout}`);
  const res = run("git", ["-C", unit.absRepo, "commit", "-m", message]);
  if (!res.ok && !/nothing to commit/i.test(res.stdout + res.stderr)) {
    throw new Error(`git commit failed: ${res.stderr || res.stdout}`);
  }
  log(`  committed ${files.length} file(s): ${message}`);
  return tryOut("git", ["-C", unit.absRepo, "rev-parse", "HEAD"]);
}

function gitPush(unit) {
  const res = run("git", ["-C", unit.absRepo, "push"]);
  if (!res.ok) throw new Error(`git push failed: ${res.stderr || res.stdout}`);
  log("  pushed");
}

function gitTag(unit, tag) {
  const exists = tryOut("git", ["-C", unit.absRepo, "tag", "--list", tag]);
  if (exists) {
    log(`  tag ${tag} already exists locally`);
    return;
  }
  const res = run("git", ["-C", unit.absRepo, "tag", tag]);
  if (!res.ok) throw new Error(`git tag failed: ${res.stderr || res.stdout}`);
  log(`  tagged ${tag}`);
}

function gitPushTag(unit, tag) {
  const res = run("git", ["-C", unit.absRepo, "push", "origin", tag]);
  if (!res.ok) throw new Error(`git push tag failed: ${res.stderr || res.stdout}`);
  log(`  pushed tag ${tag} (triggers ${unit.publishWorkflow})`);
}

// Returns the GitHub Release URL (the agent can report/listen to it).
function ghRelease(unit, tag) {
  const slug = remoteSlug(unit);
  const baseArgs = slug ? ["-R", slug] : [];
  const already = run("gh", ["release", "view", tag, ...baseArgs, "--json", "url", "-q", ".url"]);
  if (already.ok) {
    log(`  GitHub Release ${tag} already exists`);
    return already.stdout || releaseUrl(slug, tag);
  }
  const res = run("gh", [
    "release",
    "create",
    tag,
    ...baseArgs,
    "--title",
    tag,
    "--notes",
    `Automated release of ${unit.key} ${tag} via the cross-repo coordinator.`,
    "--target",
    unit.branch ?? "main"
  ]);
  if (!res.ok) throw new Error(`gh release create failed: ${res.stderr || res.stdout}`);
  log(`  created (published) GitHub Release ${tag} -> triggers ${unit.publishWorkflow}`);
  return res.stdout || releaseUrl(slug, tag);
}

// Locate the workflow run for the commit/tag we pushed and return its identity
// (id, html url, status, conclusion). With --no-wait it returns as soon as the
// run is located (so the agent gets a URL to listen to); otherwise it blocks on
// `gh run watch` until the run is terminal.
async function waitForWorkflow(unit, workflow, sha) {
  const slug = remoteSlug(unit);
  const baseArgs = slug ? ["-R", slug] : [];

  let runMatch = null;
  for (let attempt = 0; attempt < 6 && !runMatch; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 4000 : 5000));
    const listed = tryOut("gh", [
      "run",
      "list",
      "--workflow",
      workflow,
      ...baseArgs,
      "--limit",
      "20",
      "--json",
      "databaseId,headSha,status,conclusion,url,event"
    ]);
    if (!listed) continue;
    let runs = [];
    try {
      runs = JSON.parse(listed);
    } catch {
      runs = [];
    }
    runMatch = sha ? runs.find((r) => r.headSha === sha) : runs[0];
    if (!runMatch && sha) log(`  waiting for a ${workflow} run on ${sha.slice(0, 8)}...`);
  }

  if (!runMatch) {
    warn(`  could not locate a ${workflow} run${sha ? ` for ${sha.slice(0, 8)}` : ""}; verify the publish manually`);
    return { id: null, url: workflowUrl(slug, workflow), status: "unknown", conclusion: null };
  }

  const result = {
    id: runMatch.databaseId,
    url: runMatch.url,
    status: runMatch.status,
    conclusion: runMatch.conclusion ?? null
  };

  if (OPTIONS.noWait) {
    log(`  triggered ${workflow} run ${result.id}: ${result.url} (not waiting)`);
    return result;
  }

  log(`  watching ${workflow} run ${result.id}: ${result.url}`);
  const watch = run("gh", ["run", "watch", String(result.id), ...baseArgs, "--exit-status"], {
    stdio: OPTIONS.json ? "ignore" : "inherit"
  });
  const view = tryOut("gh", ["run", "view", String(result.id), ...baseArgs, "--json", "status,conclusion"]);
  if (view) {
    try {
      const parsed = JSON.parse(view);
      result.status = parsed.status;
      result.conclusion = parsed.conclusion;
    } catch {
      // keep prior values
    }
  }
  if (!watch.ok) throw new Error(`${workflow} run ${result.id} did not succeed (${result.conclusion ?? "failed"}): ${result.url}`);
  log(`  ${workflow} succeeded`);
  return result;
}

// Find the workflow run for a unit (matching a known head sha when available).
function runForUnit(unit, sha) {
  const slug = remoteSlug(unit);
  const baseArgs = slug ? ["-R", slug] : [];
  const listed = tryOut("gh", [
    "run",
    "list",
    "--workflow",
    unit.publishWorkflow,
    ...baseArgs,
    "--limit",
    "20",
    "--json",
    "databaseId,headSha,status,conclusion,url"
  ]);
  if (!listed) return null;
  let runs = [];
  try {
    runs = JSON.parse(listed);
  } catch {
    return null;
  }
  const m = sha ? runs.find((r) => r.headSha === sha) : runs[0];
  return m ? { id: m.databaseId, url: m.url, status: m.status, conclusion: m.conclusion ?? null, headSha: m.headSha } : null;
}

// status: per-unit published version, latest workflow run (status/conclusion/url),
// and all the URLs an agent would poll. Optionally --watch in-flight runs.
async function cmdStatus() {
  const { topology, state } = loadWorkspace();
  const order = topoOrder(topology.units);
  const byKey = new Map(topology.units.map((u) => [u.key, u]));
  const targetSet = OPTIONS.targets.length ? new Set(OPTIONS.targets) : null;
  const lastResults = state.lastApply?.results ?? {};
  const out = {};

  for (const key of order) {
    if (targetSet && !targetSet.has(key)) continue;
    const unit = byKey.get(key);
    if (!unit.present) {
      out[key] = { present: false };
      continue;
    }
    const sha = lastResults[key]?.sha ?? null;
    let latestRun = runForUnit(unit, sha);
    if (OPTIONS.watch && latestRun?.id && latestRun.status !== "completed") {
      const slug = remoteSlug(unit);
      const baseArgs = slug ? ["-R", slug] : [];
      log(`watching ${key} run ${latestRun.id}: ${latestRun.url}`);
      run("gh", ["run", "watch", String(latestRun.id), ...baseArgs, "--exit-status"], {
        stdio: OPTIONS.json ? "ignore" : "inherit"
      });
      latestRun = runForUnit(unit, sha);
    }
    const r = await refreshUnit(unit);
    out[key] = {
      present: true,
      declared: r.declared,
      published: r.published,
      desired: unit.desired,
      latestTag: r.latestTag,
      run: latestRun,
      urls: unitUrls(unit, unit.desired)
    };
  }

  const ok = !Object.values(out).some((u) => u.run?.conclusion && u.run.conclusion !== "success");
  if (OPTIONS.json) {
    emit({ ok, lastApply: state.lastApply?.at ?? null, units: out });
    if (!ok) process.exitCode = 1;
    return;
  }
  log("Release status:");
  for (const [key, u] of Object.entries(out)) {
    if (u.present === false) {
      log(`  ${key.padEnd(20)} absent`);
      continue;
    }
    const runStr = u.run ? `${u.run.status}/${u.run.conclusion ?? "-"} ${u.run.url}` : "no run";
    log(`  ${key.padEnd(20)} published=${u.published ?? "?"} desired=${u.desired}  ${runStr}`);
  }
}

// verify: confirm each unit's published version is at least the desired version.
async function cmdVerify() {
  const { topology } = loadWorkspace();
  const order = topoOrder(topology.units);
  const byKey = new Map(topology.units.map((u) => [u.key, u]));
  const targetSet = OPTIONS.targets.length ? new Set(OPTIONS.targets) : null;
  const out = {};
  let allOk = true;

  for (const key of order) {
    if (targetSet && !targetSet.has(key)) continue;
    const unit = byKey.get(key);
    if (!unit.present) {
      out[key] = { present: false };
      continue;
    }
    const r = await refreshUnit(unit);
    const desired = unit.desired;
    let ok;
    if (r.published != null) {
      ok = r.published === desired || compareSemver(r.published, desired) >= 0;
    } else {
      // Unobservable registry (private PyPI): fall back to the git tag.
      ok = r.latestTag === tagFor(unit, desired);
    }
    if (!ok) allOk = false;
    out[key] = { present: true, desired, published: r.published, latestTag: r.latestTag, ok, urls: unitUrls(unit, desired) };
  }

  if (OPTIONS.json) {
    emit({ ok: allOk, units: out });
    if (!allOk) process.exitCode = 1;
    return;
  }
  log("Verify (published vs desired):");
  for (const [key, u] of Object.entries(out)) {
    if (u.present === false) {
      log(`  ${key.padEnd(20)} absent`);
      continue;
    }
    log(`  ${key.padEnd(20)} ${u.ok ? "OK " : "NO "} published=${u.published ?? "?"} desired=${u.desired}`);
  }
  if (!allOk) process.exitCode = 1;
}

// Parse global flags shared across commands into OPTIONS.
function parseGlobalFlags(args) {
  OPTIONS.json = args.includes("--json");
  OPTIONS.noWait = args.includes("--no-wait");
  OPTIONS.allowDirty = args.includes("--allow-dirty");
  OPTIONS.autoApprove = args.includes("--auto-approve");
  OPTIONS.watch = args.includes("--watch");
  OPTIONS.targets = [];
  OPTIONS.includes = [];
  OPTIONS.planPath = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-target=")) OPTIONS.targets.push(a.slice("-target=".length));
    else if (a === "--target") OPTIONS.targets.push(args[++i]);
    else if (a === "--include") OPTIONS.includes.push(args[++i]);
    else if (a.startsWith("--include=")) OPTIONS.includes.push(a.slice("--include=".length));
    else if (a === "--plan") OPTIONS.planPath = args[++i];
  }
}

main();

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  parseGlobalFlags(rest);
  switch (command) {
    case "plan":
      await cmdPlan();
      break;
    case "apply":
      await cmdApply();
      break;
    case "status":
      await cmdStatus();
      break;
    case "verify":
      await cmdVerify();
      break;
    case "refresh":
      await cmdRefresh();
      break;
    case "graph":
      await cmdGraph();
      break;
    case "bump":
      cmdBump(rest);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      die(`unknown command: ${command} (try: plan | apply | status | verify | refresh | graph | bump)`);
  }
}

function printUsage() {
  log("Cross-repo release coordinator (Terraform-style plan/apply). All commands accept --json.");
  log("");
  log("  plan    [-target=<unit>] [--json]                 preview + write a plan artifact");
  log("  apply   [--plan <f>] [--auto-approve] [--no-wait] execute a plan in dependency order");
  log("          [--include <path>] [--allow-dirty] [-target=<unit>] [--json]");
  log("  status  [-target=<unit>] [--watch] [--json]       published versions + workflow run URLs");
  log("  verify  [-target=<unit>] [--json]                 confirm published >= desired");
  log("  refresh [--json]                                  reconcile state.json with reality");
  log("  graph   [--json]                                  print the dependency DAG");
  log("  bump    <unit> <version|major|minor|patch>        edit desired.json");
}
