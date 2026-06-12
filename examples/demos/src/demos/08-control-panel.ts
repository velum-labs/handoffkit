import { makeRepo, startStack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { banner, bold, detail, finale, ok, step } from "../narrate.js";
import type { Demo } from "../registry.js";
import { seedShowcase } from "../seed-lib.js";

// TODO(hardcoded): fixed demo port 7172
const PORT = 7172;
const POOL = "eng-prod";

export const demo: Demo = {
  id: "08",
  title: "control panel",
  summary:
    "Boot a plane + runner, seed realistic runs (a continuation, a success, a failure, a cancellation, and one awaiting approval), and leave the control panel up for you to explore.",
  interactive: true,
  async run() {
    banner(this.id, this.title, this.summary);

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
};
