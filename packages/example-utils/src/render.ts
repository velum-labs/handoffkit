// Legacy Warrant receipt/trace renderer used by quarantined examples.

import type {
  DisclosureReport,
  ReceiptBundle,
  RunSummary
} from "@fusionkit/protocol";
import { buildReceiptStory } from "@fusionkit/protocol";
import type { HandoffTraceEvent } from "@fusionkit/handoff";

/** One screen, five questions. This is the product. */
export function renderReceipt(bundle: ReceiptBundle): string {
  const { contract, receipt } = bundle;
  const story = buildReceiptStory(bundle);
  const lines: string[] = [];
  const changed = bundle.events.filter((e) => e.event.type === "file.changed");
  const approvers = contract.approvedBy?.map((a) => a.id).join(", ");

  lines.push(`warrant receipt ${story.runId} [${story.status}]`);
  lines.push("");
  lines.push("1. What moved?");
  lines.push(
    `   in:  workspace @ ${story.workspace.baseRef.slice(0, 12)} (manifest ${story.workspace.manifestHash.slice(0, 12)})`
  );
  if (contract.continuation) {
    lines.push(
      `   in:  continuation of checkpoint ${contract.continuation.checkpointId} (envelope ${contract.continuation.envelopeHash.slice(0, 12)}, tier ${contract.continuation.tier})`
    );
  }
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
  lines.push(`   policy snapshot: ${story.policyHash.slice(0, 12)}`);
  lines.push("");
  lines.push("4. Which runtime, model, tools, data, and secrets saw it?");
  lines.push(
    `   runner: ${receipt.runner.runnerId} (pool ${receipt.runner.pool}, attestation: ${receipt.runner.attestationTier}, isolation: ${story.isolation})`
  );
  lines.push(`   agent: ${story.agent}${contract.agent.version ? `@${contract.agent.version}` : ""}`);
  lines.push(
    `   secrets released: ${
      story.secrets.length > 0
        ? story.secrets.join(", ")
        : "none"
    }`
  );
  lines.push(
    `   network: ${
      story.network.length > 0
        ? story.network.join(", ")
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
  lines.push(`   events: ${story.eventCount} hash-chained, head ${story.eventsHead.slice(0, 12)}`);
  lines.push(`   pull results: warrant pull ${receipt.runId}`);
  lines.push(`   verify offline: ${story.verificationCommand}`);
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
  if (report.continuation) {
    lines.push(
      `continuation: checkpoint ${report.continuation.checkpointId} (envelope ${report.continuation.envelopeHash.slice(0, 12)}, tier ${report.continuation.tier})`
    );
  }
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

export function renderRunList(runs: RunSummary[]): string {
  if (runs.length === 0) return "no runs yet";
  const lines: string[] = [];
  for (const run of runs) {
    const continuation = run.continuation ? " ↩ continuation" : "";
    const prompt =
      run.prompt.length > 56 ? `${run.prompt.slice(0, 53)}...` : run.prompt;
    lines.push(
      `${run.runId}  [${run.status}]  ${run.agentKind} @ ${run.pool}${continuation}`
    );
    lines.push(`  "${prompt}" — ${run.requestedBy.id}, ${run.createdAt}`);
  }
  return lines.join("\n");
}

export function renderTrace(events: HandoffTraceEvent[]): string {
  const lines: string[] = ["handoff trace:"];
  for (const event of events) {
    switch (event.type) {
      case "checkpoint.created":
        lines.push(
          `  ${event.ts}  checkpoint.created      ${event.checkpointId} (tier ${event.tier})`
        );
        break;
      case "continuation.planned":
        lines.push(
          `  ${event.ts}  continuation.planned    ${event.decision} → ${event.target}: ${event.reasons.join("; ")}`
        );
        break;
      case "envelope.created":
        lines.push(
          `  ${event.ts}  envelope.created        ${event.envelopeId} (${event.envelopeHash.slice(0, 12)}) → ${event.target}`
        );
        break;
      case "run.requested":
        lines.push(
          `  ${event.ts}  run.requested           ${event.runId} [${event.status}]`
        );
        break;
      case "run.terminal":
        lines.push(
          `  ${event.ts}  run.terminal            ${event.runId} [${event.status}]`
        );
        break;
      case "results.pulled":
        lines.push(
          `  ${event.ts}  results.pulled          ${event.runId} (${event.mode})`
        );
        break;
      case "tool.called":
        lines.push(
          `  ${event.ts}  tool.called             ${event.toolName} [${event.ok ? "ok" : "error"}] input ${event.inputHash.slice(0, 12)}${event.outputHash ? ` → ${event.outputHash.slice(0, 12)}` : ""} (${event.durationMs}ms)`
        );
        break;
      case "continuation.requested":
        lines.push(
          `  ${event.ts}  continuation.requested  ${event.reason ?? "(no reason given)"}`
        );
        break;
      case "model.routed":
        lines.push(
          `  ${event.ts}  model.routed            ${event.route}:${event.model}${event.escalated ? " (escalated)" : ""} — ${event.reason}`
        );
        break;
      default: {
        const exhausted: never = event;
        throw new Error(`unreachable trace event: ${String(exhausted)}`);
      }
    }
  }
  return lines.join("\n");
}
