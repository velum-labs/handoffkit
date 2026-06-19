import { verifyReceiptBundle } from "@fusionkit/protocol";
import type { ReceiptBundle } from "@fusionkit/protocol";
import { mockRunRequest, uploadWorkspace, withStackAndRepo } from "@fusionkit/testkit";

import { demoBanner, detail, expectedFailure, finale, ok, step } from "@fusionkit/example-utils";

async function main(): Promise<void> {
  demoBanner("05");

  await withStackAndRepo({
    pool: "eng-prod",
    policy: (policy) => {
      policy.secrets.releasable = [
        { name: "MOCK_SECRET", scope: "demo", pools: ["eng-prod"] }
      ];
    },
    secrets: { MOCK_SECRET: "verify-demo-secret" }
  }, async ({ stack, repo }) => {
    const captured = await uploadWorkspace(stack.client, repo);
    const created = await stack.client.requestRun(
      mockRunRequest({
        requestedBy: { kind: "human", id: "dana@example.com" },
        prompt: "produce something worth auditing",
        pool: "eng-prod",
        secretNames: ["MOCK_SECRET"],
        workspace: captured.manifest
      })
    );
    await stack.runOnce();
    const bundle = await stack.client.getBundle(created.runId);

    step("verify the bundle offline: signatures, hash chain, and linkage");
    const honest = verifyReceiptBundle(bundle);
    if (!honest.ok) throw new Error(honest.problems.join("; "));
    ok(`VERIFIED — ${bundle.events.length} events, runner + plane signatures, contract linkage`);

    step("attack 1: strip the secret.released event and renumber the chain");
    const tampered = structuredClone(bundle) as ReceiptBundle;
    tampered.events = tampered.events.filter(
      (e) => e.event.type !== "secret.released"
    );
    tampered.events.forEach((e, i) => {
      e.seq = i;
    });
    const attack1 = verifyReceiptBundle(tampered);
    if (attack1.ok) throw new Error("tampering must be detected");
    expectedFailure("detected:");
    for (const problem of attack1.problems) detail(`- ${problem}`);

    step("attack 2: forge the receipt to claim no secrets were released");
    const forged = structuredClone(bundle) as ReceiptBundle;
    forged.receipt.secretsReleased = [];
    const attack2 = verifyReceiptBundle(forged);
    if (attack2.ok) throw new Error("forgery must be detected");
    expectedFailure("detected:");
    for (const problem of attack2.problems) detail(`- ${problem}`);

    finale("trust comes from verification, not from the plane, the runner, or us");
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
