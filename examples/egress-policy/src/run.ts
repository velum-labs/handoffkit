import { PlaneClientError } from "@warrant/sdk";
import { mockRunRequest, uploadWorkspace, withStackAndRepo } from "@warrant/testkit";

import { demoBanner, detail, expectedFailure, finale, ok, step } from "@warrant/example-utils";

async function main(): Promise<void> {
  demoBanner("04");

  await withStackAndRepo({ pool: "eng-prod" }, async ({ stack, repo }) => {
    const captured = await uploadWorkspace(stack.client, repo);

    const baseRequest = mockRunRequest({
      requestedBy: { kind: "human", id: "dana@example.com" },
      prompt: "probe the network from inside the session",
      pool: "eng-prod",
      workspace: captured.manifest
    });

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
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
