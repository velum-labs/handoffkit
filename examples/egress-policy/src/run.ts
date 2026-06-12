import { rmSync } from "node:fs";

import { PlaneClientError } from "@warrant/sdk";
import { makeRepo, startStack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { banner, detail, expectedFailure, finale, ok, step } from "@warrant/example-utils";

const DEMO_ID = "04";
const DEMO_TITLE = "deny-by-default egress";
const DEMO_SUMMARY =
  "Network policy is decided at contract time and enforced at the session boundary; every attempted connection is recorded in the receipt.";

async function main(): Promise<void> {
  banner(DEMO_ID, DEMO_TITLE, DEMO_SUMMARY);

  const stack = await startStack({ pool: "eng-prod" });
  const repo = makeRepo();
  try {
    const captured = captureWorkspace(repo);
    await stack.client.putBlob(captured.bundle);

    const baseRequest = {
      requestedBy: { kind: "human" as const, id: "dana@example.com" },
      agentKind: "mock",
      prompt: "probe the network from inside the session",
      pool: "eng-prod",
      secretNames: [],
      workspace: captured.manifest,
      budget: {},
      disclosure: "minimal-context" as const
    };

    step("ask for egress to a host the org policy does not allow");
    try {
      await stack.client.requestRun({
        ...baseRequest,
        network: { defaultDeny: true, allowHosts: ["exfil.example.com"] }
      });
      throw new Error("the plane must fail closed");
    } catch (error) {
      if (!(error instanceof PlaneClientError) || error.status !== 403) throw error;
      expectedFailure(`contract refused: ${error.message}`);
    }

    step("run with no allowlist; the agent still tries to phone home");
    const created = await stack.client.requestRun({
      ...baseRequest,
      network: { defaultDeny: true, allowHosts: [] }
    });
    await stack.runOnce();

    const bundle = await stack.client.getBundle(created.runId);
    const attempts = bundle.receipt.networkAccessed;
    if (attempts.length === 0) throw new Error("expected a recorded egress attempt");
    for (const attempt of attempts) {
      detail(`session boundary: ${attempt.host} → ${attempt.decision}`);
    }
    const blocked = attempts.filter((a) => a.decision === "blocked");
    if (blocked.length === 0) throw new Error("expected the probe to be blocked");
    ok("the probe was blocked by the session egress proxy and recorded as evidence");
    ok("the receipt proves both what was allowed and what was attempted");
    finale("egress is governed twice: fail-closed policy up front, enforcement + evidence at runtime");
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
