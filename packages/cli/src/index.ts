#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { agents, handoff, targets } from "@warrant/handoff";
import type { AgentDescriptor } from "@warrant/handoff";
import { Plane, startPlaneServer } from "@warrant/plane";
import { PolicyDeniedError, verifyReceiptBundle } from "@warrant/protocol";
import type { AgentKind, ReceiptBundle, RunRequestInput } from "@warrant/protocol";
import { Runner } from "@warrant/runner";
import { PlaneClient } from "@warrant/sdk";
import { captureWorkspace, pullRun } from "@warrant/workspace";

import { initHome, loadHome, secretStoreFor } from "./config.js";
import {
  renderDisclosure,
  renderReceipt,
  renderRunList,
  renderTrace
} from "./render.js";

const USAGE = `warrant — the governed execution and provenance plane for AI agents

usage:
  warrant init [--port N] [--host H] [--plane-url URL]
                                                 initialize org keys, config, policy
  warrant plane start [--port N] [--host H]      start the control plane + control panel
  warrant runner start --pool P [--plane URL]    start an outbound-only runner
  warrant secrets set NAME VALUE                 store a secret in the org store
  warrant secrets list                           list stored secret names
  warrant run --agent KIND [opts] "task"         request a governed run
      --pool P            runner pool (default: default)
      --secret NAME       release a secret into the session (repeatable)
      --allow-host H      allow egress to host (repeatable)
      --allow-untracked G include untracked files matching glob (repeatable)
      --repo DIR          workspace repository (default: .)
      --dry-run           show what would move; move nothing
      --no-watch          do not wait for completion
  warrant continue --agent KIND [opts] "task"    hand local work to a governed runner
      --pool P            target runner pool (default: default)
      --transcript FILE   carry a session transcript as semantic state
      --reason TEXT       why the runtime boundary changes
      (plus --secret/--allow-host/--allow-untracked/--repo/--dry-run/--no-watch)
  warrant runs                                   list runs
  warrant approve RUN_ID                         grant required consent
  warrant cancel RUN_ID                          cancel an unclaimed run
  warrant watch RUN_ID                           stream run status
  warrant receipt RUN_ID                         one screen, five questions
  warrant bundle RUN_ID [--out FILE]             save offline-verifiable bundle
  warrant verify FILE                            verify a bundle offline
  warrant pull RUN_ID [--repo DIR]               divergence-safe pull of results
  warrant export [--since ISO]                   audit JSONL export
  warrant ui                                     control panel URL and login token

global:
  --dir DIR    warrant home (default: ./.warrant)
`;

const AGENT_KINDS: AgentKind[] = ["claude-code", "codex", "mock"];

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function agentDescriptorFor(kind: string): AgentDescriptor {
  switch (kind as AgentKind) {
    case "claude-code":
      return agents.claudeCode();
    case "codex":
      return agents.codex();
    case "mock":
      return agents.mock();
    default:
      fail(`unknown agent kind "${kind}" (expected ${AGENT_KINDS.join(" | ")})`);
  }
}

function clientFor(dir: string): PlaneClient {
  const home = loadHome(dir);
  return new PlaneClient(home.config.planeUrl, home.config.adminToken);
}

async function waitForTerminal(
  client: PlaneClient,
  runId: string,
  onStatus: (status: string) => void
): Promise<string> {
  let last = "";
  for (;;) {
    const view = await client.getRun(runId);
    if (view.status !== last) {
      last = view.status;
      onStatus(view.status);
    }
    if (["completed", "failed", "cancelled"].includes(view.status)) {
      return view.status;
    }
    if (view.status === "awaiting_approval") {
      onStatus(
        `awaiting approval (${view.consentRequirements.join("; ")}) — run: warrant approve ${runId}`
      );
      return view.status;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
  }
}

type RunFlags = {
  agent?: string;
  pool?: string;
  secret?: string[];
  "allow-host"?: string[];
  "allow-untracked"?: string[];
  repo?: string;
  "dry-run"?: boolean;
  "no-watch"?: boolean;
  transcript?: string;
  reason?: string;
};

function parseRunArgs(argv: string[]): { values: RunFlags; prompt: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      pool: { type: "string", default: "default" },
      secret: { type: "string", multiple: true },
      "allow-host": { type: "string", multiple: true },
      "allow-untracked": { type: "string", multiple: true },
      repo: { type: "string", default: "." },
      "dry-run": { type: "boolean", default: false },
      "no-watch": { type: "boolean", default: false },
      transcript: { type: "string" },
      reason: { type: "string" }
    },
    allowPositionals: true
  });
  return { values, prompt: positionals.join(" ").trim() };
}

async function cmdRun(dir: string, argv: string[]): Promise<void> {
  const { values, prompt } = parseRunArgs(argv);
  if (!values.agent) fail(`--agent is required (${AGENT_KINDS.join(" | ")})`);
  if (!prompt) fail("a task prompt is required");

  const home = loadHome(dir);
  const client = new PlaneClient(home.config.planeUrl, home.config.adminToken);
  const repoDir = resolve(values.repo ?? ".");

  const captured = captureWorkspace(repoDir, {
    allowUntracked: values["allow-untracked"] ?? []
  });

  const request: RunRequestInput = {
    requestedBy: { kind: "human", id: home.config.requestedBy },
    agentKind: values.agent,
    prompt,
    pool: values.pool ?? "default",
    secretNames: values.secret ?? [],
    workspace: captured.manifest,
    network: {
      defaultDeny: home.policy.network.defaultDeny,
      allowHosts: values["allow-host"] ?? []
    },
    budget: {},
    disclosure: "minimal-context"
  };

  if (values["dry-run"]) {
    const report = await client.dryRun(request);
    console.log(renderDisclosure(report));
    return;
  }

  await client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await client.putBlob(captured.dirtyDiff);
  for (const file of captured.untracked) await client.putBlob(file.content);

  const created = await client.requestRun(request);
  console.log(`run ${created.runId} [${created.status}]`);

  if (values["no-watch"]) return;
  const status = await waitForTerminal(client, created.runId, (s) =>
    console.log(`  ${s}`)
  );
  if (status === "completed" || status === "failed") {
    const bundle = await client.getBundle(created.runId);
    console.log("");
    console.log(renderReceipt(bundle));
  }
}

async function cmdContinue(dir: string, argv: string[]): Promise<void> {
  const { values, prompt } = parseRunArgs(argv);
  if (!values.agent) fail(`--agent is required (${AGENT_KINDS.join(" | ")})`);
  if (!prompt) fail("a task prompt is required");

  const home = loadHome(dir);
  const repoDir = resolve(values.repo ?? ".");
  const target = targets.pool(values.pool ?? "default");
  const transcript = values.transcript
    ? readFileSync(values.transcript, "utf8")
    : undefined;

  const h = handoff({
    workspace: repoDir,
    plane: { url: home.config.planeUrl, adminToken: home.config.adminToken },
    actor: { kind: "human", id: home.config.requestedBy },
    agent: agentDescriptorFor(values.agent),
    secrets: values.secret ?? [],
    allowHosts: values["allow-host"] ?? [],
    allowUntracked: values["allow-untracked"] ?? []
  });

  const continueOptions = {
    task: prompt,
    ...(values.reason ? { reason: values.reason } : {}),
    ...(transcript !== undefined ? { transcript } : {})
  };

  if (values["dry-run"]) {
    const { report } = await h.dryRun(target, continueOptions);
    console.log(renderDisclosure(report));
    return;
  }

  const run = await h.continueIn(target, continueOptions);
  console.log(
    `continuation ${run.envelope.envelopeId} → ${target.id} as run ${run.runId}`
  );

  if (values["no-watch"]) return;
  const outcome = await run.wait({ timeoutMs: 10 * 60 * 1000 });
  if (outcome.status === "awaiting_approval") {
    console.log(
      `awaiting approval (${outcome.consentRequirements.join("; ")}) — run: warrant approve ${run.runId}`
    );
    return;
  }
  console.log("");
  console.log(renderTrace(h.trace()));
  if (outcome.status === "completed" || outcome.status === "failed") {
    console.log("");
    console.log(renderReceipt(await run.receipt()));
    console.log("");
    console.log(`pull results: warrant pull ${run.runId}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirFlagIndex = args.indexOf("--dir");
  let dir = resolve(process.env.WARRANT_HOME ?? ".warrant");
  if (dirFlagIndex !== -1) {
    const value = args[dirFlagIndex + 1];
    if (!value) fail("--dir requires a value");
    dir = resolve(value);
    args.splice(dirFlagIndex, 2);
  }

  const [command, sub, ...rest] = args;

  switch (command) {
    case "init": {
      const { values } = parseArgs({
        args: sub ? [sub, ...rest] : rest,
        options: {
          port: { type: "string" },
          host: { type: "string" },
          "plane-url": { type: "string" }
        }
      });
      const home = initHome(dir, {
        ...(values.port ? { port: Number(values.port) } : {}),
        ...(values.host ? { host: values.host } : {}),
        ...(values["plane-url"] ? { planeUrl: values["plane-url"] } : {})
      });
      console.log(`initialized warrant home at ${home.dir}`);
      console.log(`plane url: ${home.config.planeUrl}`);
      console.log(`policy: ${join(home.dir, "policy.json")}`);
      console.log(`enroll token (for runners): ${home.config.enrollToken}`);
      console.log(`admin token (for the control panel): ${home.config.adminToken}`);
      return;
    }
    case "plane": {
      if (sub !== "start") fail(`unknown plane subcommand: ${sub ?? ""}`);
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string" }, host: { type: "string" } }
      });
      const home = loadHome(dir);
      const plane = new Plane({
        dataDir: join(dir, "data"),
        policy: home.policy,
        planePrivateKeyPem: home.planePrivateKeyPem,
        planePublicKeyPem: home.planePublicKeyPem,
        adminToken: home.config.adminToken,
        enrollToken: home.config.enrollToken,
        secretStore: secretStoreFor(home)
      });
      const port = values.port ? Number(values.port) : home.config.port;
      const host = values.host ?? home.config.host;
      const started = await startPlaneServer(plane, { port, host });
      console.log(`warrant plane listening on http://${started.host}:${started.port}`);
      console.log(`control panel: http://${started.host}:${started.port}/ui/`);
      return;
    }
    case "runner": {
      if (sub !== "start") fail(`unknown runner subcommand: ${sub ?? ""}`);
      const { values } = parseArgs({
        args: rest,
        options: {
          pool: { type: "string", default: "default" },
          plane: { type: "string" },
          "enroll-token": { type: "string" },
          "data-dir": { type: "string" }
        }
      });
      let planeUrl = values.plane;
      let enrollToken = values["enroll-token"];
      if (!planeUrl || !enrollToken) {
        const home = loadHome(dir);
        planeUrl = planeUrl ?? home.config.planeUrl;
        enrollToken = enrollToken ?? home.config.enrollToken;
      }
      const runner = new Runner({
        planeUrl,
        pool: values.pool ?? "default",
        dataDir: resolve(values["data-dir"] ?? ".warrant-runner"),
        enrollToken
      });
      const identity = await runner.ensureEnrolled();
      console.log(
        `runner ${identity.runnerId} polling pool "${identity.pool}" (outbound-only)`
      );
      await runner.start();
      return;
    }
    case "secrets": {
      const home = loadHome(dir);
      if (sub === "set") {
        const [name, value] = rest;
        if (!name || value === undefined) fail("usage: warrant secrets set NAME VALUE");
        secretStoreFor(home).set(name, value);
        console.log(`secret "${name}" stored (value encrypted at rest)`);
        return;
      }
      if (sub === "list") {
        const names = secretStoreFor(home).names();
        console.log(names.length > 0 ? names.join("\n") : "no secrets stored");
        return;
      }
      fail(`unknown secrets subcommand: ${sub ?? ""}`);
      return;
    }
    case "run": {
      await cmdRun(dir, sub ? [sub, ...rest] : rest);
      return;
    }
    case "continue": {
      await cmdContinue(dir, sub ? [sub, ...rest] : rest);
      return;
    }
    case "runs": {
      const client = clientFor(dir);
      const { runs } = await client.listRuns();
      console.log(renderRunList(runs));
      return;
    }
    case "approve": {
      if (!sub) fail("usage: warrant approve RUN_ID");
      const home = loadHome(dir);
      const client = clientFor(dir);
      const result = await client.approve(sub, {
        kind: "human",
        id: home.config.requestedBy
      });
      console.log(`run ${result.runId} [${result.status}]`);
      return;
    }
    case "cancel": {
      if (!sub) fail("usage: warrant cancel RUN_ID");
      const home = loadHome(dir);
      const client = clientFor(dir);
      const result = await client.cancel(sub, {
        kind: "human",
        id: home.config.requestedBy
      });
      console.log(`run ${result.runId} [${result.status}]`);
      return;
    }
    case "watch": {
      if (!sub) fail("usage: warrant watch RUN_ID");
      const client = clientFor(dir);
      const status = await waitForTerminal(client, sub, (s) => console.log(s));
      console.log(`final: ${status}`);
      return;
    }
    case "receipt": {
      if (!sub) fail("usage: warrant receipt RUN_ID");
      const client = clientFor(dir);
      console.log(renderReceipt(await client.getBundle(sub)));
      return;
    }
    case "bundle": {
      if (!sub) fail("usage: warrant bundle RUN_ID [--out FILE]");
      const { values } = parseArgs({
        args: rest,
        options: { out: { type: "string" } }
      });
      const client = clientFor(dir);
      const bundle = await client.getBundle(sub);
      const out = values.out ?? `${sub}.bundle.json`;
      writeFileSync(out, JSON.stringify(bundle, null, 2));
      console.log(`bundle written to ${out}`);
      return;
    }
    case "verify": {
      if (!sub) fail("usage: warrant verify FILE");
      const bundle = JSON.parse(readFileSync(sub, "utf8")) as ReceiptBundle;
      const result = verifyReceiptBundle(bundle);
      if (result.ok) {
        console.log("VERIFIED: signatures, event chain, and linkage all check out");
        return;
      }
      console.error("VERIFICATION FAILED:");
      for (const problem of result.problems) console.error(`  - ${problem}`);
      process.exit(1);
      return;
    }
    case "pull": {
      if (!sub) fail("usage: warrant pull RUN_ID [--repo DIR]");
      const { values } = parseArgs({
        args: rest,
        options: { repo: { type: "string", default: "." } }
      });
      const client = clientFor(dir);
      const bundle = await client.getBundle(sub);
      const diffHash = bundle.receipt.workspaceOut.diffHash;
      if (!diffHash) {
        console.log("run produced no workspace changes; nothing to pull");
        return;
      }
      const diff = await client.getBlob(diffHash);
      const result = pullRun(
        resolve(values.repo ?? "."),
        sub,
        bundle.contract.workspace.baseRef,
        diff
      );
      switch (result.mode) {
        case "applied":
          console.log("applied run output to the working tree (clean fast path)");
          break;
        case "branch":
          console.log(
            `local workspace diverged from the contract base; results are on branch ${result.branch}`
          );
          break;
        case "empty":
          console.log("run produced no workspace changes; nothing to pull");
          break;
        default: {
          const exhausted: never = result;
          throw new Error(`unreachable: ${String(exhausted)}`);
        }
      }
      return;
    }
    case "export": {
      const { values } = parseArgs({
        args: sub ? [sub, ...rest] : rest,
        options: { since: { type: "string" } }
      });
      const client = clientFor(dir);
      process.stdout.write(await client.exportJsonl(values.since));
      return;
    }
    case "ui": {
      const home = loadHome(dir);
      console.log(`control panel: ${home.config.planeUrl}/ui/`);
      console.log(`login token:   ${home.config.adminToken}`);
      return;
    }
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof PolicyDeniedError) {
    console.error(`POLICY DENIED (fail closed):`);
    for (const reason of error.reasons) console.error(`  - ${reason}`);
    process.exit(2);
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
