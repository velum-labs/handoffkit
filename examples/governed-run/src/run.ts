import { renderReceipt } from "@fusionkit/cli/render";
import { verifyReceiptBundle } from "@fusionkit/protocol";
import { mockRunRequest, uploadWorkspace, withStackAndRepo } from "@fusionkit/testkit";

import { demoBanner, detail, finale, ok, step } from "@fusionkit/example-utils";

async function main(): Promise<void> {
  demoBanner("01");

  step("boot a control plane and enroll an outbound-only runner (pool: eng-prod)");
  await withStackAndRepo({ pool: "eng-prod", files: {
      "README.md": "# payments-service\n",
      "src/auth.ts": "export const verify = (token: string) => token.length > 0;\n"
    } }, async ({ stack, repo }) => {
    step("capture the workspace: git bundle + dirty diff, content-addressed");
    const captured = await uploadWorkspace(stack.client, repo);

    step('request a governed run: warrant run --agent mock "fix the flaky auth test"');
    const created = await stack.client.requestRun(
      mockRunRequest({
        requestedBy: { kind: "human", id: "dana@example.com" },
        prompt: "fix the flaky auth test and run the suite",
        pool: "eng-prod",
        workspace: captured.manifest
      })
    );
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
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
