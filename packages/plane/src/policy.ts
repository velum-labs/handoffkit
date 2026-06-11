import { PolicyDeniedError } from "@warrant/protocol";
import type { AgentKind, Policy, PolicyDecision } from "@warrant/protocol";

export type PolicyRequest = {
  agentKind: AgentKind;
  pool: string;
  secretNames: string[];
  allowHosts: string[];
  maxSpendUsd?: number;
  maxDurationMin?: number;
};

export type { PolicyDecision };

/**
 * Evaluate a run request against policy at contract time. Fail closed:
 * anything not allowed throws PolicyDeniedError; anything allowed but
 * matching a consent rule returns "ask" with the named requirements.
 */
export function evaluatePolicy(
  policy: Policy,
  request: PolicyRequest
): PolicyDecision {
  const denials: string[] = [];

  if (!policy.agents.allow.includes(request.agentKind)) {
    denials.push(`agent kind "${request.agentKind}" is not allowed`);
  }
  if (!policy.runners.allowPools.includes(request.pool)) {
    denials.push(`runner pool "${request.pool}" is not allowed`);
  }

  for (const name of request.secretNames) {
    const rule = policy.secrets.releasable.find((r) => r.name === name);
    if (!rule) {
      denials.push(`secret "${name}" is not releasable under policy`);
    } else if (!rule.pools.includes(request.pool)) {
      denials.push(`secret "${name}" is not releasable to pool "${request.pool}"`);
    }
  }

  if (policy.network.defaultDeny) {
    const allowed = new Set(policy.network.allowHosts);
    for (const host of request.allowHosts) {
      if (!allowed.has(host)) {
        denials.push(`network host "${host}" is not in the policy allowlist`);
      }
    }
  }

  const spend = request.maxSpendUsd ?? policy.budget.maxSpendUsd;
  if (spend > policy.budget.maxSpendUsd) {
    denials.push(
      `requested budget $${spend} exceeds policy ceiling $${policy.budget.maxSpendUsd}`
    );
  }
  const duration = request.maxDurationMin ?? policy.budget.maxDurationMin;
  if (duration > policy.budget.maxDurationMin) {
    denials.push(
      `requested duration ${duration}m exceeds policy ceiling ${policy.budget.maxDurationMin}m`
    );
  }

  if (denials.length > 0) {
    throw new PolicyDeniedError(denials);
  }

  const consentRequirements: string[] = [];
  for (const rule of policy.consent) {
    switch (rule.when) {
      case "any-run":
        consentRequirements.push("any-run");
        break;
      case "secret-release":
        if (request.secretNames.length > 0) {
          consentRequirements.push(
            `secret-release:${request.secretNames.join(",")}`
          );
        }
        break;
      case "agent-kind":
        if (rule.match === request.agentKind) {
          consentRequirements.push(`agent-kind:${request.agentKind}`);
        }
        break;
      default: {
        const exhausted: never = rule.when;
        throw new Error(`unreachable consent rule: ${String(exhausted)}`);
      }
    }
  }

  if (consentRequirements.length > 0) {
    return {
      decision: "ask",
      reason: `consent required: ${consentRequirements.join("; ")}`,
      consentRequirements
    };
  }
  return { decision: "allow", reason: "policy allows this run", consentRequirements: [] };
}

export function defaultPolicy(): Policy {
  return {
    version: "warrant.policy.v1",
    runners: { allowPools: ["default"] },
    agents: { allow: ["claude-code", "codex", "mock", "command"] },
    dataClasses: [],
    network: { defaultDeny: true, allowHosts: [] },
    secrets: { releasable: [] },
    budget: { maxSpendUsd: 25, maxDurationMin: 60 },
    consent: [],
    retention: { receiptsDays: 365, artifactsDays: 90 }
  };
}
