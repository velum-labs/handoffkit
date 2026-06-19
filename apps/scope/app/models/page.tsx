"use client";

import { Cpu } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { EmptyState } from "@/components/scope/empty-state";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { useModels } from "@/lib/api";
import { fmtNumber } from "@/lib/format";

export default function ModelsPage() {
  const { models, loading, error } = useModels();

  const chartData = models.map((model) => ({
    name: model.modelId.length > 16 ? `${model.modelId.slice(0, 15)}…` : model.modelId,
    calls: model.calls,
    tokens: model.totalTokens
  }));

  return (
    <div>
      <PageHeader title="Models" subtitle="Per-model latency, usage, and call counts across all sessions.">
        <LiveDot active={!error} />
      </PageHeader>

      <div className="space-y-6 p-8">
        {loading ? (
          <Skeleton className="h-80 w-full" />
        ) : models.length === 0 ? (
          <EmptyState
            icon={<Cpu className="size-8" />}
            title="No model calls observed"
            hint="Once a panel model server handles a request, its rollup appears here."
          />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Calls per model</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-72 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis
                        dataKey="name"
                        tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                        stroke="var(--border)"
                      />
                      <YAxis
                        allowDecimals={false}
                        tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                        stroke="var(--border)"
                      />
                      <Tooltip
                        cursor={{ fill: "var(--accent)", opacity: 0.3 }}
                        contentStyle={{
                          background: "var(--popover)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          color: "var(--popover-foreground)",
                          fontSize: 12
                        }}
                      />
                      <Bar dataKey="calls" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden p-0">
              <CardHeader className="p-6 pb-0">
                <CardTitle className="text-base">Rollups</CardTitle>
              </CardHeader>
              <CardContent className="p-6 pt-4">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Model</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">OK</TableHead>
                      <TableHead className="text-right">Failed</TableHead>
                      <TableHead className="text-right">Avg latency</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {models.map((model) => (
                      <TableRow key={model.modelId}>
                        <TableCell className="mono text-sm">{model.modelId}</TableCell>
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
                        <TableCell className="mono text-right text-emerald-500">{model.succeeded}</TableCell>
                        <TableCell className="mono text-right text-red-500">{model.failed}</TableCell>
                        <TableCell className="mono text-right">
                          {typeof model.avgLatencyS === "number" ? `${model.avgLatencyS.toFixed(2)}s` : "—"}
                        </TableCell>
                        <TableCell className="mono text-right">{fmtNumber(model.totalTokens)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
