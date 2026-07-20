import type {
  AccountLimits,
  SubscriptionMemberStatus,
  SubscriptionUsageResponse
} from "@routekit/accounts";
import { dim, renderTableLines, supportsUnicode } from "@routekit/cli-ui";

function boundedUtilization(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function formatUtilizationBar(utilization: number, width = 10): string {
  const bounded = boundedUtilization(utilization);
  const filled = Math.round(bounded * width);
  const full = supportsUnicode() ? "▓" : "#";
  const empty = supportsUnicode() ? "░" : "-";
  return `${full.repeat(filled)}${empty.repeat(width - filled)} ${Math.round(bounded * 100)}%`;
}

export function formatResetCountdown(resetsAt: number | undefined, now = Date.now()): string {
  if (resetsAt === undefined) return "reset unknown";
  let seconds = Math.max(0, Math.round(resetsAt - now / 1000));
  if (seconds === 0) return "resets now";
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && parts.length < 2) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${seconds}s`);
  return `resets in ${parts.slice(0, 2).join(" ")}`;
}

function observedAge(observedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round(now / 1000 - observedAt));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function creditsLabel(limits: AccountLimits): string | undefined {
  const credits = limits.credits;
  if (credits === undefined) return undefined;
  if (credits.unlimited === true) return "credits unlimited";
  if (credits.balance !== undefined) return `credits ${credits.balance}`;
  if (credits.hasCredits !== undefined) return credits.hasCredits ? "credits available" : "no credits";
  return undefined;
}

export function formatRateLimitWindowName(name: string): string {
  if (name === "five_hour") return "5 hour";
  if (name.startsWith("five_hour_")) {
    return `5 hour · ${name.slice("five_hour_".length).replaceAll("_", " ")}`;
  }
  if (name === "seven_day") return "7 day";
  if (name.startsWith("seven_day_")) {
    return `7 day · ${name.slice("seven_day_".length).replaceAll("_", " ")}`;
  }
  if (name === "extra_usage") return "extra usage";
  return name;
}

function memberLines(member: SubscriptionMemberStatus, now: number): string[] {
  const marker = member.active ? " (active)" : "";
  const lines = [`  ${member.label}${marker}`];
  if (member.limits === undefined || Object.keys(member.limits.windows).length === 0) {
    lines.push("    no usage data available yet");
    lines.push(dim("    check the account with `routekit doctor` if this persists"));
    return lines;
  }
  const metadata = [
    member.limits.planType !== undefined ? `plan ${member.limits.planType}` : undefined,
    creditsLabel(member.limits)
  ].filter((value): value is string => value !== undefined);
  if (metadata.length > 0) lines.push(dim(`    ${metadata.join(" · ")}`));
  const rows = Object.entries(member.limits.windows)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, window]) => [
      window.limitName ?? formatRateLimitWindowName(name),
      formatUtilizationBar(window.utilization),
      window.status ?? "ok",
      formatResetCountdown(window.resetsAt, now)
    ]);
  lines.push(...renderTableLines(rows, { head: ["window", "used", "status", "reset"], indent: 4 }));
  lines.push(
    dim(`    observed ${observedAge(member.limits.observedAt, now)} via ${member.limits.source}`)
  );
  return lines;
}

export function renderUsageLines(
  usage: SubscriptionUsageResponse,
  now = Date.now()
): string[] {
  const lines: string[] = ["RouteKit usage"];
  if (usage.accountSets.length === 0) {
    return [...lines, "  no account pools are serving"];
  }
  for (const accountSet of usage.accountSets) {
    lines.push("");
    lines.push(
      `${accountSet.mode} · ${accountSet.strategy} · switch at ${Math.round(accountSet.switchThreshold * 100)}%`
    );
    if (accountSet.members.length === 0) lines.push("  no enrolled accounts");
    for (const member of accountSet.members) lines.push(...memberLines(member, now));
  }
  return lines;
}

export function limitsSummary(
  usage: SubscriptionUsageResponse | undefined,
  mode: string,
  label: string,
  now = Date.now()
): string | undefined {
  const member = usage?.accountSets
    .find((accountSet) => accountSet.mode === mode)
    ?.members.find((entry) => entry.label === label);
  if (member?.limits === undefined) return undefined;
  const top = Object.entries(member.limits.windows).sort(
    ([, left], [, right]) => right.utilization - left.utilization
  )[0];
  if (top === undefined) return undefined;
  const [name, window] = top;
  return `${name} ${Math.round(boundedUtilization(window.utilization) * 100)}% · ${formatResetCountdown(window.resetsAt, now)}`;
}
