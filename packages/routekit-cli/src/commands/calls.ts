import { CliError, contextFor } from "@routekit/cli-core";
import type { RouteKitCallInspection } from "@routekit/control";
import { formatUsd } from "@routekit/gateway";
import type { Command } from "commander";

import { routekitClient } from "../client.js";

function usageText(call: RouteKitCallInspection): string {
  const usage = call.usage;
  if (usage === undefined) return "not reported";
  return [
    usage.prompt_tokens !== undefined ? `input=${usage.prompt_tokens}` : undefined,
    usage.completion_tokens !== undefined
      ? `output=${usage.completion_tokens}`
      : undefined,
    usage.total_tokens !== undefined ? `total=${usage.total_tokens}` : undefined
  ].filter((value): value is string => value !== undefined).join(", ");
}

function costText(call: RouteKitCallInspection): string {
  if (call.cost.estimateUsd !== undefined) {
    return `${formatUsd(call.cost.estimateUsd)} estimated`;
  }
  return call.cost.unknownCost ? "unknown" : "$0.00 estimated";
}

export function registerCalls(program: Command): void {
  const calls = program
    .command("calls")
    .description("inspect recent model calls");

  calls
    .command("inspect <call-id>")
    .description("show routing, billing, retry, usage, and cost attribution")
    .action(async (callId: string, _options: unknown, command: Command) => {
      const ctx = contextFor(command);
      let call: RouteKitCallInspection;
      try {
        call = await (await routekitClient()).call("calls.inspect", { callId });
      } catch {
        throw new CliError({
          code: "call_not_found",
          message: `model call is unknown or expired: ${callId}`,
          hint: "Call attribution is retained by the current daemon for a bounded period.",
          tryCommand: "routekit status"
        });
      }
      if (ctx.json) {
        ctx.emit(call);
        return;
      }
      ctx.presenter.heading(call.callId);
      ctx.presenter.keyValue([
        { label: "status", value: call.status },
        { label: "effective model", value: call.effectiveModel },
        ...(call.nativeModel !== undefined
          ? [{ label: "native model", value: call.nativeModel }]
          : []),
        { label: "provider", value: call.provider },
        { label: "account / seat", value: call.account?.label ?? "not applicable" },
        { label: "billing mode", value: call.billingMode },
        {
          label: "retries",
          value: `${call.retries.total} (${call.retries.accountFailovers} account failovers, ${call.retries.attempts} attempts)`
        },
        { label: "usage", value: usageText(call) || "not reported" },
        { label: "cost", value: costText(call) },
        { label: "started", value: call.timing.startedAt },
        ...(call.timing.finishedAt !== undefined
          ? [{ label: "finished", value: call.timing.finishedAt }]
          : [])
      ]);
    });
}
