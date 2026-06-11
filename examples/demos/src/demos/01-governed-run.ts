import { rmSync } from "node:fs";

import { renderReceipt } from "@warrant/cli/render";
import { verifyReceiptBundle } from "@warrant/protocol";
import { makeRepo, startStack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { banner, detail, finale, ok, step } from "../narrate.js";
import type { Demo } from "../registry.js";

export const demo: Demo = {
  id: "01",
  title: "governed run",
  summary:
    "Run an agent harness on a runner you control, under a signed contract, and get a receipt that answers the five questions.",
  async run() {
    banner(this.id, this.title, this.summary);

    step("boot a control plane and enroll an outbound-only runner (pool: eng-prod)");
    const stack = await startStack({ pool: "eng-prod" });
    const repo = makeRepo({
      files: {
        "README.md": "# payments-service\n",
        "src/auth.ts": "export const verify = (token: string) => token.length > 0;\n"
      }
    });
    try {
      step("capture the workspace: git bundle + dirty diff, content-addressed");
      const captured = captureWorkspace(repo);
      await stack.client.putBlob(captured.bundle);
      if (captured.dirtyDiff) await stack.client.putBlob(captured.dirtyDiff);

      step('request a governed run: warrant run --agent mock "fix the flaky auth test"');
      const created = await stack.client.requestRun({
        requestedBy: { kind: "human", id: "dana@example.com" },
        agentKind: "mock",
        prompt: "fix the flaky auth test and run the suite",
        pool: "eng-prod",
        secretNames: [],
        workspace: captured.manifest,
        network: { defaultDeny: true, allowHosts: [] },
        budget: {},
        disclosure: "minimal-context"
      });
      ok(`contract issued and signed by the plane — run ${created.runId} [${created.status}]`);

      step("the runner claims the contract, materializes the workspace, and executes");
      await stack.runOnce();
      const view = await stack.client.getRun(created.runId);
      ok(`run finished [${view.status}] with ${view.events.length} hash-chained events`);

      step("the receipt is the product: one screen, five questions");
      const bundle = await stack.client.getBundle(created.runId);
      detail(renderReceipt(bundle));

      const verification = verifyReceiptBundle(bundle);
      if (!verification.ok) throw new Error(verification.problems.join("; "));
      finale("governed run complete; receipt verified offline without trusting the plane");
    } finally {
      await stack.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }
};
