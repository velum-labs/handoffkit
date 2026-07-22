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
      const lines = [
        ["call", call.callId],
        ["status", call.status],
        ["effective model", call.effectiveModel],
        ...(call.nativeModel !== undefined
          ? [["native model", call.nativeModel]]
          : []),
        ["provider", call.provider],
        ["account / seat", call.account?.label ?? "not applicable"],
        ["billing mode", call.billingMode],
        [
          "retries",
          `${call.retries.total} (${call.retries.accountFailovers} account failovers, ${call.retries.attempts} attempts)`
        ],
        ["usage", usageText(call) || "not reported"],
        ["cost", costText(call)],
        ["started", call.timing.startedAt],
        ...(call.timing.finishedAt !== undefined
          ? [["finished", call.timing.finishedAt]]
          : [])
      ];
      for (const [label, value] of lines) {
        ctx.presenter.line(`${label}: ${value}`);
      }
    });
}
