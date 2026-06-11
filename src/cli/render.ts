import type { DisclosureReport } from "../plane/plane.js";
import type { ReceiptBundle } from "../protocol/types.js";

/** One screen, five questions. This is the product. */
export function renderReceipt(bundle: ReceiptBundle): string {
  const { contract, receipt } = bundle;
  const lines: string[] = [];
  const changed = bundle.events.filter((e) => e.event.type === "file.changed");
  const approvers = contract.approvedBy?.map((a) => a.id).join(", ");

  lines.push(`warrant receipt ${receipt.runId} [${receipt.status}]`);
  lines.push("");
  lines.push("1. What moved?");
  lines.push(
    `   in:  workspace @ ${contract.workspace.baseRef.slice(0, 12)} (manifest ${receipt.workspaceIn.manifestHash.slice(0, 12)})`
  );
  lines.push(
    `   out: ${changed.length} file(s) changed, diff ${receipt.workspaceOut.diffHash ? receipt.workspaceOut.diffHash.slice(0, 12) : "none"}, ${receipt.workspaceOut.artifactHashes.length} artifact(s)`
  );
  for (const disclosure of receipt.boundaryDisclosures) {
    lines.push(
      `   boundary ${disclosure.direction}: ${disclosure.dataClass} ${disclosure.contentHash.slice(0, 12)}`
    );
  }
  lines.push("");
  lines.push("2. Why did it move?");
  lines.push(`   task: ${contract.task.prompt}`);
  lines.push(`   requested by: ${contract.requestedBy.id}`);
  lines.push("");
  lines.push("3. Who or what approved it?");
  lines.push(
    approvers
      ? `   approved by: ${approvers}`
      : "   policy: auto-allowed (no consent rule matched)"
  );
  lines.push(`   policy snapshot: ${contract.policyHash.slice(0, 12)}`);
  lines.push("");
  lines.push("4. Which runtime, model, tools, data, and secrets saw it?");
  lines.push(
    `   runner: ${receipt.runner.runnerId} (pool ${receipt.runner.pool}, attestation: ${receipt.runner.attestationTier})`
  );
  lines.push(
    `   agent: ${contract.agent.kind}${contract.agent.version ? `@${contract.agent.version}` : ""}`
  );
  lines.push(
    `   secrets released: ${
      receipt.secretsReleased.length > 0
        ? receipt.secretsReleased.map((s) => `${s.name} (${s.scope})`).join(", ")
        : "none"
    }`
  );
  lines.push(
    `   network: ${
      receipt.networkAccessed.length > 0
        ? receipt.networkAccessed
            .map((n) => `${n.host} [${n.decision}]`)
            .join(", ")
        : "no egress attempted"
    }`
  );
  lines.push(
    `   models: ${
      receipt.modelsUsed.length > 0
        ? receipt.modelsUsed.map((m) => `${m.provider}/${m.model}`).join(", ")
        : "not observable at session boundary (vendor harness)"
    }`
  );
  lines.push("");
  lines.push("5. How can you resume, inspect, revoke, or reproduce it?");
  lines.push(`   contract: ${receipt.contractHash.slice(0, 16)} (signed, expires ${contract.expiresAt})`);
  lines.push(`   events: ${receipt.eventCount} hash-chained, head ${receipt.eventsHead.slice(0, 12)}`);
  lines.push(`   pull results: warrant pull ${receipt.runId}`);
  lines.push(`   verify offline: warrant verify <bundle.json>`);
  return lines.join("\n");
}

export function renderDisclosure(report: DisclosureReport): string {
  const lines: string[] = [];
  lines.push("warrant dry run: nothing moved. This is what would:");
  lines.push("");
  lines.push(`agent: ${report.agent.kind} on pool "${report.pool}"`);
  lines.push(`workspace: base ${report.workspace.baseRef.slice(0, 12)}`);
  lines.push(`  bundle ${report.workspace.bundleHash.slice(0, 12)}`);
  if (report.workspace.dirtyDiffHash) {
    lines.push(`  uncommitted diff ${report.workspace.dirtyDiffHash.slice(0, 12)}`);
  }
  lines.push(
    `  untracked included: ${
      report.workspace.untrackedPaths.length > 0
        ? report.workspace.untrackedPaths.join(", ")
        : "none"
    }`
  );
  lines.push(
    `  denied capture: ${
      report.workspace.deniedPaths.length > 0
        ? report.workspace.deniedPaths.join(", ")
        : "none"
    }`
  );
  lines.push(
    `secrets that would be released: ${
      report.secrets.length > 0
        ? report.secrets.map((s) => `${s.name} (${s.scope})`).join(", ")
        : "none"
    }`
  );
  lines.push(
    `network egress: ${
      report.network.defaultDeny
        ? `deny-by-default, allowlist [${report.network.allowHosts.join(", ")}]`
        : "allow-all (policy permits)"
    }`
  );
  lines.push(
    `budget: $${report.budget.maxSpendUsd ?? "policy-default"} / ${report.budget.maxDurationMin ?? "policy-default"}m`
  );
  lines.push(`disclosure mode: ${report.disclosure}`);
  lines.push(
    `policy decision: ${report.policyDecision.decision} (${report.policyDecision.reason})`
  );
  return lines.join("\n");
}
