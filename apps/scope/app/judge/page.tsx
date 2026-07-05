"use client";

import Link from "next/link";
import { Scale } from "lucide-react";

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
import { useJudge } from "@/lib/api";
import { fmtDateTime, fmtNumber, fmtRelative, shortTraceId } from "@/lib/format";

function pct(part: number, total: number): string | undefined {
  if (total === 0) return undefined;
  return `${((part / total) * 100).toFixed(0)}%`;
}

function DecisionBadge({ decision }: { decision: string | undefined }) {
  if (decision === undefined) return <span className="text-muted-foreground">—</span>;
  const label = decision.replace(/_/g, " ").replace("select trajectory", "select");
  return (
    <Badge
      variant="outline"
      className="gap-1.5 font-medium capitalize"
    >
      <span
        className="size-1.5 rounded-full"
        style={{
          background: decision === "synthesize" ? "var(--trace-synthesis)" : "var(--trace-judge)"
        }}
      />
      {label}
    </Badge>
  );
}

export default function JudgePage() {
  const { judge, loading, error, live } = useJudge();
  const total = judge?.totalDecisions ?? 0;

  return (
    <div>
      <PageHeader
        title="Judge"
        subtitle="Fusion decisions across sessions: synthesize vs. select, and which panel models win."
      >
        <LiveDot active={live} />
      </PageHeader>

      <div className="space-y-4 px-8 py-6">
        <ErrorBanner error={error} />

        {loading ? (
          <div className="space-y-4">
            <StatStripSkeleton stats={4} />
            <TableSkeleton rows={4} />
          </div>
        ) : judge === undefined || total === 0 ? (
          <EmptyState
            icon={<Scale className="size-8" />}
            title="No judge decisions observed"
            hint="Once a fusion turn reaches a terminal judge step, its decision is tallied here."
          />
        ) : (
          <>
            <StatStrip
              className="border-b pb-5"
              stats={[
                { label: "Decisions", value: fmtNumber(total), mono: true },
                {
                  label: "Synthesized",
                  value: `${fmtNumber(judge.synthesizeCount)}${
                    pct(judge.synthesizeCount, total) !== undefined
                      ? ` (${pct(judge.synthesizeCount, total)})`
                      : ""
                  }`,
                  mono: true
                },
                {
                  label: "Selected verbatim",
                  value: `${fmtNumber(judge.selectCount)}${
                    pct(judge.selectCount, total) !== undefined
                      ? ` (${pct(judge.selectCount, total)})`
                      : ""
                  }`,
                  mono: true
                },
                {
                  label: "Empty synthesis fallbacks",
                  value: fmtNumber(judge.emptySynthesisCount),
                  mono: true
                }
              ]}
            />

            {judge.models.length > 0 ? (
              <Section
                title="Model standings"
                count={fmtNumber(judge.models.length)}
                summary="which panel models the judge picks when it selects verbatim"
              >
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Model</TableHead>
                      <TableHead className="text-right">On panel</TableHead>
                      <TableHead className="text-right">Selected</TableHead>
                      <TableHead className="text-right">Selection rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {judge.models.map((standing) => (
                      <TableRow key={standing.modelId}>
                        <TableCell className="mono text-sm">
                          <Link
                            href={`/?q=${encodeURIComponent(standing.modelId)}`}
                            className="hover:underline"
                          >
                            {standing.modelId}
                          </Link>
                        </TableCell>
                        <TableCell className="mono text-right">{standing.onPanel}</TableCell>
                        <TableCell className="mono text-right">{standing.selected}</TableCell>
                        <TableCell className="mono text-right">
                          {pct(standing.selected, standing.onPanel) ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-muted-foreground mt-2 text-xs">
                  Synthesized decisions blend candidates, so they do not credit a single model.
                </p>
              </Section>
            ) : null}

            <Section title="Recent decisions" count={fmtNumber(judge.decisions.length)}>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[140px]">Session</TableHead>
                    <TableHead className="w-[130px]">Decision</TableHead>
                    <TableHead>Selected model</TableHead>
                    <TableHead>Rationale</TableHead>
                    <TableHead className="w-[100px] text-right">When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {judge.decisions.map((decision) => (
                    <TableRow key={decision.traceId}>
                      <TableCell className="mono text-sm">
                        <Link href={`/sessions/${decision.traceId}`} className="hover:underline">
                          {shortTraceId(decision.traceId)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <DecisionBadge decision={decision.decision} />
                          {decision.synthesisEmpty ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge variant="destructive" className="font-normal">
                                  empty
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                Synthesis returned empty — fell back to the best candidate
                              </TooltipContent>
                            </Tooltip>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="mono text-sm">
                        {decision.selectedModelId ?? decision.selectedId ?? (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[380px] truncate text-sm">
                        <span title={decision.rationale}>{decision.rationale ?? "—"}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-sm">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>{fmtRelative(decision.ts)}</span>
                          </TooltipTrigger>
                          <TooltipContent>{fmtDateTime(decision.ts)}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
