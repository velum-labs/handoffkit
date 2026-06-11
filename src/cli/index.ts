#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { Plane } from "../plane/plane.js";
import { startPlaneServer } from "../plane/server.js";
import { PolicyDeniedError } from "../protocol/types.js";
import type { ReceiptBundle } from "../protocol/types.js";
import { verifyReceiptBundle } from "../protocol/receipt.js";
import { Runner } from "../runner/runner.js";
import { captureWorkspace, pullRun } from "../runner/workspace.js";
import { PlaneClient } from "../sdk/client.js";
import type { RunRequestInput } from "../sdk/client.js";
import { initHome, loadHome, secretStoreFor } from "./config.js";
import { renderDisclosure, renderReceipt } from "./render.js";

const USAGE = `warrant — the governed execution and provenance plane for AI agents

usage:
  warrant init                                   initialize org keys, config, policy
  warrant plane start [--port N]                 start the control plane
  warrant runner start --pool P [--plane URL]    start an outbound-only runner
  warrant secrets set NAME VALUE                 store a secret in the org store
  warrant run --agent KIND [opts] "task"         request a governed run
      --pool P            runner pool (default: default)
      --secret NAME       release a secret into the session (repeatable)
      --allow-host H      allow egress to host (repeatable)
      --allow-untracked G include untracked files matching glob (repeatable)
      --repo DIR          workspace repository (default: .)
      --dry-run           show what would move; move nothing
      --no-watch          do not wait for completion
  warrant approve RUN_ID                         grant required consent
  warrant watch RUN_ID                           stream run status
  warrant receipt RUN_ID                         one screen, five questions
  warrant bundle RUN_ID [--out FILE]             save offline-verifiable bundle
  warrant verify FILE                            verify a bundle offline
  warrant pull RUN_ID [--repo DIR]               divergence-safe pull of results
  warrant export [--since ISO]                   audit JSONL export

global:
  --dir DIR    warrant home (default: ./.warrant)
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
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

async function cmdRun(dir: string, argv: string[]): Promise<void> {
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
      "no-watch": { type: "boolean", default: false }
    },
    allowPositionals: true
  });
  const prompt = positionals.join(" ").trim();
  if (!values.agent) fail("--agent is required (claude-code | codex | mock)");
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirFlagIndex = args.indexOf("--dir");
  let dir = resolve(".warrant");
  if (dirFlagIndex !== -1) {
    const value = args[dirFlagIndex + 1];
    if (!value) fail("--dir requires a value");
    dir = resolve(value);
    args.splice(dirFlagIndex, 2);
  }

  const [command, sub, ...rest] = args;

  switch (command) {
    case "init": {
      const home = initHome(dir);
      console.log(`initialized warrant home at ${home.dir}`);
      console.log(`plane url: ${home.config.planeUrl}`);
      console.log(`policy: ${join(home.dir, "policy.json")}`);
      console.log(`enroll token (for runners): ${home.config.enrollToken}`);
      return;
    }
    case "plane": {
      if (sub !== "start") fail(`unknown plane subcommand: ${sub ?? ""}`);
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string" } }
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
      const started = await startPlaneServer(plane, port);
      console.log(`warrant plane listening on http://127.0.0.1:${started.port}`);
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
      if (sub !== "set") fail(`unknown secrets subcommand: ${sub ?? ""}`);
      const [name, value] = rest;
      if (!name || value === undefined) fail("usage: warrant secrets set NAME VALUE");
      const home = loadHome(dir);
      secretStoreFor(home).set(name, value);
      console.log(`secret "${name}" stored (value encrypted at rest)`);
      return;
    }
    case "run": {
      await cmdRun(dir, sub ? [sub, ...rest] : rest);
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
