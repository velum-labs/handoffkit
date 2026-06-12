import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderDisclosure } from "@warrant/cli/render";
import { mockRunRequest, withStackAndRepo } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { demoBanner, detail, finale, ok, step } from "@warrant/example-utils";

async function main(): Promise<void> {
  demoBanner("02");

  await withStackAndRepo({
    pool: "eng-prod",
    policy: (policy) => {
      policy.secrets.releasable = [
        { name: "NPM_TOKEN", scope: "read-only", pools: ["eng-prod"] }
      ];
    },
    secrets: { NPM_TOKEN: "npm_live_do_not_leak" },
    files: { "README.md": "# billing\n", "src/invoice.ts": "export {};\n" }
  }, async ({ stack, repo }) => {
    step("leave secrets lying around the workspace, as real repos do");
    writeFileSync(join(repo, ".env"), "STRIPE_KEY=sk_live_oops\n");
    writeFileSync(join(repo, "deploy.key"), "-----BEGIN PRIVATE KEY-----\n");
    writeFileSync(join(repo, "notes.md"), "untracked scratch notes\n");
    writeFileSync(join(repo, "src/invoice.ts"), "export const v2 = true;\n");

    step("capture the workspace with an untracked allowlist of *.md only");
    const captured = captureWorkspace(repo, { allowUntracked: ["*.md"] });
    ok(`denied capture (provable absence): ${captured.manifest.deniedPaths.join(", ")}`);

    step("ask the plane what a run would disclose — without creating one");
    const report = await stack.client.dryRun(
      mockRunRequest({
        requestedBy: { kind: "human", id: "dana@example.com" },
        prompt: "migrate the billing tests",
        pool: "eng-prod",
        secretNames: ["NPM_TOKEN"],
        workspace: captured.manifest,
        budget: { maxSpendUsd: 5 }
      })
    );
    detail(renderDisclosure(report));

    const { runs } = await stack.client.listRuns();
    if (runs.length !== 0) throw new Error("dry run must not create a run");
    ok("the plane holds zero runs: nothing moved, nothing executed");
    finale("a security reviewer can answer “what would move?” before anything does");
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
