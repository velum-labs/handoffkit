import { rmSync } from "node:fs";

import { verifyReceiptBundle } from "@warrant/protocol";
import type { ReceiptBundle } from "@warrant/protocol";
import { makeRepo, startStack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { banner, detail, expectedFailure, finale, ok, step } from "../narrate.js";
import type { Demo } from "../registry.js";

export const demo: Demo = {
  id: "05",
  title: "offline verification and tamper evidence",
  summary:
    "Receipts verify against nothing but published schemas and keys. Rewriting history — or quietly dropping a secret release — breaks the math.",
  async run() {
    banner(this.id, this.title, this.summary);

    const stack = await startStack({
      pool: "eng-prod",
      policy: (policy) => {
        policy.secrets.releasable = [
          { name: "MOCK_SECRET", scope: "demo", pools: ["eng-prod"] }
        ];
      },
      secrets: { MOCK_SECRET: "verify-demo-secret" }
    });
    const repo = makeRepo();
    try {
      const captured = captureWorkspace(repo);
      await stack.client.putBlob(captured.bundle);
      const created = await stack.client.requestRun({
        requestedBy: { kind: "human", id: "dana@example.com" },
        agentKind: "mock",
        prompt: "produce something worth auditing",
        pool: "eng-prod",
        secretNames: ["MOCK_SECRET"],
        workspace: captured.manifest,
        network: { defaultDeny: true, allowHosts: [] },
        budget: {},
        disclosure: "minimal-context"
      });
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
    } finally {
      await stack.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }
};
