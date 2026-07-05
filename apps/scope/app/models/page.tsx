"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Cpu } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";

import { EmptyState } from "@/components/scope/empty-state";
import { ErrorBanner } from "@/components/scope/error-banner";
import { StatStripSkeleton, TableSkeleton } from "@/components/scope/loading";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { Section } from "@/components/scope/section";
import { StatStrip } from "@/components/scope/stat-strip";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModels } from "@/lib/api";
import { fmtDateTime, fmtNumber, fmtRelative } from "@/lib/format";

const chartTooltipStyle = {
  background: "var(--popover)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--popover-foreground)",
  fontSize: 12
} as const;

const axisTick = { fill: "var(--muted-foreground)", fontSize: 12 } as const;

function ModelChart({
  data,
  dataKey,
  color
}: {
  data: Array<Record<string, unknown>>;
  dataKey: string;
  color: string;
}) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="name" tick={axisTick} stroke="var(--border)" />
          <YAxis allowDecimals={false} tick={axisTick} stroke="var(--border)" />
          <ChartTooltip cursor={{ fill: "var(--accent)", opacity: 0.3 }} contentStyle={chartTooltipStyle} />
          <Bar dataKey={dataKey} fill={color} radius={[4, 4, 0, 0]} maxBarSize={56} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ModelsPage() {
  const router = useRouter();
  const { models, loading, error, live } = useModels();

  const chartData = models.map((model) => ({
    name: model.modelId.length > 16 ? `${model.modelId.slice(0, 15)}…` : model.modelId,
    calls: model.calls,
    tokens: model.totalTokens
  }));

  const totals = useMemo(() => {
    const calls = models.reduce((sum, model) => sum + model.calls, 0);
    const succeeded = models.reduce((sum, model) => sum + model.succeeded, 0);
    const failed = models.reduce((sum, model) => sum + model.failed, 0);
    const running = models.reduce((sum, model) => sum + model.running, 0);
    const tokens = models.reduce((sum, model) => sum + model.totalTokens, 0);
    const finished = succeeded + failed;
    return {
      calls,
      running,
      tokens,
      successRate: finished > 0 ? (succeeded / finished) * 100 : undefined
    };
  }, [models]);

  return (
    <div>
      <PageHeader title="Models" subtitle="Per-model latency, usage, and call counts across all sessions.">
        <LiveDot active={live} />
      </PageHeader>

      <div className="space-y-4 px-8 py-6">
        <ErrorBanner error={error} />

        {loading ? (
          <div className="space-y-4">
            <StatStripSkeleton />
            <TableSkeleton rows={4} />
          </div>
        ) : models.length === 0 ? (
          <EmptyState
            icon={<Cpu className="size-8" />}
            title="No model calls observed"
            hint="Once a panel model server handles a request, its rollup appears here."
          />
        ) : (
          <>
            <StatStrip
              className="border-b pb-5"
              stats={[
                { label: "Models", value: fmtNumber(models.length), mono: true },
                { label: "Calls", value: fmtNumber(totals.calls), mono: true },
                {
                  label: "Success rate",
                  value:
                    totals.successRate !== undefined ? `${totals.successRate.toFixed(1)}%` : undefined,
                  mono: true
                },
                {
                  label: "Active now",
                  value: totals.running > 0 ? fmtNumber(totals.running) : "0",
                  mono: true
                },
                { label: "Tokens", value: fmtNumber(totals.tokens), mono: true }
              ]}
            />

            <Section title="Charts" defaultOpen={false} summary="calls and tokens per model">
              <div className="space-y-6">
                <div>
                  <div className="text-muted-foreground mb-2 text-xs">Calls per model</div>
                  <ModelChart data={chartData} dataKey="calls" color="var(--chart-1)" />
                </div>
                <div>
                  <div className="text-muted-foreground mb-2 text-xs">Tokens per model</div>
                  <ModelChart data={chartData} dataKey="tokens" color="var(--chart-2)" />
                </div>
              </div>
            </Section>

            <Section title="Per-model stats" count={fmtNumber(models.length)}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Model</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Running</TableHead>
                    <TableHead className="text-right">OK</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Avg latency</TableHead>
                    <TableHead className="text-right">Tokens (in + out)</TableHead>
                    <TableHead className="text-right">Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map((model) => {
                    const finished = model.succeeded + model.failed;
                    const successRate = finished > 0 ? (model.succeeded / finished) * 100 : undefined;
                    const split =
                      model.promptTokens > 0 || model.completionTokens > 0
                        ? ` (${fmtNumber(model.promptTokens)} + ${fmtNumber(model.completionTokens)})`
                        : "";
                    return (
                      <TableRow
                        key={model.modelId}
                        className="cursor-pointer"
                        onClick={() => router.push(`/?q=${encodeURIComponent(model.modelId)}`)}
                        title={`Show sessions using ${model.modelId}`}
                      >
                        <TableCell className="mono text-sm">
                          <Link
                            href={`/?q=${encodeURIComponent(model.modelId)}`}
                            onClick={(event) => event.stopPropagation()}
                            className="hover:underline"
                          >
                            {model.modelId}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {model.provider ? (
                            <Badge variant="secondary" className="font-normal">
                              {model.provider}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="mono text-right">{model.calls}</TableCell>
                        <TableCell className="mono text-muted-foreground text-right">
                          {model.running > 0 ? model.running : "—"}
                        </TableCell>
                        <TableCell className="mono text-(--status-success) text-right">{model.succeeded}</TableCell>
                        <TableCell className="mono text-(--status-danger) text-right">{model.failed}</TableCell>
                        <TableCell className="mono text-right">
                          {successRate !== undefined ? `${successRate.toFixed(0)}%` : "—"}
                        </TableCell>
                        <TableCell className="mono text-right">
                          {typeof model.avgLatencyS === "number" ? `${model.avgLatencyS.toFixed(2)}s` : "—"}
                        </TableCell>
                        <TableCell className="mono text-right">
                          {fmtNumber(model.totalTokens)}
                          <span className="text-muted-foreground">{split}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right text-sm">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>{model.lastTs > 0 ? fmtRelative(model.lastTs) : "—"}</span>
                            </TooltipTrigger>
                            <TooltipContent>{fmtDateTime(model.lastTs)}</TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
