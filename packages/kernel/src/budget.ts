import type { BudgetLedger, BudgetPolicy, BudgetUsage, CostEstimate, OperatorSpec, RetryPolicy } from "./types.js";
export { BudgetExceededError } from "./types.js";
export type { BudgetLedger, BudgetPolicy, BudgetUsage, CostEstimate } from "./types.js";

export function cloneBudgetLedger(ledger: BudgetLedger): BudgetLedger {
  return { ...ledger };
}

export function costOf(spec: OperatorSpec): CostEstimate {
  return spec.expectedCost ?? {};
}

export function budgetMessage(limit: string, policy: BudgetPolicy): string {
  return `budget ${policy.id ?? "default"} exceeded: ${limit}`;
}

export function usageWithDefaults(usage: BudgetUsage): Required<CostEstimate> {
  return {
    usd: usage.usd ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    candidates: usage.candidates ?? 0,
    toolCalls: usage.toolCalls ?? 0
  };
}

export function isRetryable(error: unknown, retry: RetryPolicy): boolean {
  if (retry.retryableErrors === undefined || retry.retryableErrors.length === 0) return true;
  const message = error instanceof Error ? error.message : String(error);
  return retry.retryableErrors.some((needle) => message.includes(needle));
}
