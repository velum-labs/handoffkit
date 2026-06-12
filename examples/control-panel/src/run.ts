import { makeRepo, startStack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { banner, bold, detail, finale, ok, step } from "@warrant/example-utils";
import { seedShowcase } from "@warrant/seed-example";

// This demo intentionally binds the canonical Warrant port so the printed
// URL matches the docs and docker-compose; override when 7172 is taken.
const PORT = Number(process.env.WARRANT_DEMO_PORT ?? 7172);
const POOL = "eng-prod";

const DEMO_ID = "08";
const DEMO_TITLE = "control panel";
const DEMO_SUMMARY =
  "Boot a plane + runner, seed realistic runs (a continuation, a success, a failure, a cancellation, and one awaiting approval), and leave the control panel up for you to explore.";

async function main(): Promise<void> {
  banner(DEMO_ID, DEMO_TITLE, DEMO_SUMMARY);

  step(`boot a plane on port ${PORT} with a polling runner (pool: ${POOL})`);
  const stack = await startStack({
    pool: POOL,
    port: PORT,
    startRunner: true,
    policy: (policy) => {
      policy.secrets.releasable = [
        { name: "MOCK_SECRET", scope: "staging-deploy", pools: [POOL] }
      ];
      policy.consent = [{ when: "secret-release", approvers: ["security-lead"] }];
    },
    secrets: { MOCK_SECRET: "panel-demo-secret" }
  });

  step("seed a representative mix of runs");
  const seeded = await seedShowcase({
    planeUrl: stack.planeUrl,
    adminToken: stack.adminToken,
    pool: POOL
  });
  ok(`seeded ${seeded.runIds.length} runs (continuation, success, failure, cancellation)`);

  step("plus one run blocked on consent, so you can approve it from the UI");
  const repo = makeRepo();
  const captured = captureWorkspace(repo);
  await stack.client.putBlob(captured.bundle);
  const pending = await stack.client.requestRun({
    requestedBy: { kind: "human", id: "dana@example.com" },
    agentKind: "mock",
    prompt: "deploy to staging with the scoped credential",
    pool: POOL,
    secretNames: ["MOCK_SECRET"],
    workspace: captured.manifest,
    network: { defaultDeny: true, allowHosts: [] },
    budget: {},
    disclosure: "minimal-context"
  });
  ok(`run ${pending.runId} is awaiting approval — approve it in the panel and watch it execute`);

  console.log("");
  detail(bold(`control panel: ${stack.planeUrl}/ui/`));
  detail(bold(`login token:   ${stack.adminToken}`));
  console.log("");
  detail("things to try:");
  detail("  - open the pending run and click Approve; the runner picks it up live");
  detail("  - open a completed run: the receipt answers the five questions");
  detail("  - the continuation run carries an ↩ continuation badge and checkpoint event");
  detail("  - download a bundle and check it with: warrant verify <bundle.json>");
  detail("  - export the audit log as JSONL from the top bar");
  console.log("");
  finale("Ctrl+C to stop the plane and the runner");

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
  await stack.stop();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
