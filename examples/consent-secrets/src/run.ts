import { rmSync } from "node:fs";

import { renderReceipt } from "@warrant/cli/render";
import { makeRepo, startStack } from "@warrant/testkit";
import { captureWorkspace } from "@warrant/workspace";

import { banner, detail, finale, ok, step } from "@warrant/example-utils";

const SECRET_VALUE = "mock-secret-value-do-not-leak";

const DEMO_ID = "03";
const DEMO_TITLE = "consent and brokered secrets";
const DEMO_SUMMARY =
  "A run requesting a production secret blocks on human approval; the value is injected into the session and never appears in any contract, event, or receipt.";

async function main(): Promise<void> {
  banner(DEMO_ID, DEMO_TITLE, DEMO_SUMMARY);

  const stack = await startStack({
    pool: "eng-prod",
    policy: (policy) => {
      policy.secrets.releasable = [
        { name: "MOCK_SECRET", scope: "staging-deploy", pools: ["eng-prod"] }
      ];
      policy.consent = [{ when: "secret-release", approvers: ["security-lead"] }];
    },
    secrets: { MOCK_SECRET: SECRET_VALUE }
  });
  const repo = makeRepo();
  try {
    const captured = captureWorkspace(repo);
    await stack.client.putBlob(captured.bundle);

    step("request a run that needs MOCK_SECRET (policy: secret release requires consent)");
    const created = await stack.client.requestRun({
      requestedBy: { kind: "human", id: "dana@example.com" },
      agentKind: "mock",
      prompt: "deploy to staging with the scoped credential",
      pool: "eng-prod",
      secretNames: ["MOCK_SECRET"],
      workspace: captured.manifest,
      network: { defaultDeny: true, allowHosts: [] },
      budget: {},
      disclosure: "minimal-context"
    });
    ok(`run ${created.runId} [${created.status}] — blocked on: ${created.consentRequirements.join("; ")}`);

    step("the runner polls but cannot claim an unapproved run");
    const claimed = await stack.runOnce();
    if (claimed !== undefined) throw new Error("runner must not see unapproved work");
    ok("nothing to claim: no contract exists until consent is granted");

    step("the security lead approves (CLI: warrant approve, or the control panel)");
    await stack.client.approve(created.runId, { kind: "human", id: "security-lead" });
    ok("contract issued, with the approval recorded in the signed contract itself");

    step("the runner executes; the broker releases the secret into the session env only");
    await stack.runOnce();
    const bundle = await stack.client.getBundle(created.runId);
    detail(renderReceipt(bundle));

    const serialized = JSON.stringify(bundle);
    if (serialized.includes(SECRET_VALUE)) {
      throw new Error("secret value leaked into the bundle");
    }
    ok("the full decision chain is in the receipt: requested → consent → release → use");
    ok(`the literal secret value appears nowhere in ${bundle.events.length} events, the contract, or the receipt`);
    finale("secrets are runtime configuration, never prompt content or audit residue");
  } finally {
    await stack.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
