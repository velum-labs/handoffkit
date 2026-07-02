"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";

import { CodeBlock } from "@/components/scope/code-block";
import { CopyButton } from "@/components/scope/copy-button";
import { EmptyState } from "@/components/scope/empty-state";
import { EnvironmentDetail } from "@/components/scope/environment-detail";
import { ErrorBanner } from "@/components/scope/error-banner";
import { EventInspector } from "@/components/scope/event-inspector";
import { EventTable } from "@/components/scope/event-table";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { RunFlow } from "@/components/scope/run-flow";
import { Section } from "@/components/scope/section";
import { StatStrip } from "@/components/scope/stat-strip";
import { StatusBadge } from "@/components/scope/status-badge";
import { Timeline } from "@/components/scope/timeline";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionDetail } from "@/lib/api";
import type { SessionSummary } from "@/lib/api";
import { fmtDateTime, fmtDuration, fmtNumber, fmtRelative } from "@/lib/format";
import { tokensOf } from "@/lib/rollups";
import type { SessionDetail } from "@/lib/sessions";
import type { StoredEvent } from "@/lib/types";

function shortId(traceId: string): string {
  return traceId.replace(/^trace_/, "").slice(0, 12);
}

/** One-shot fetch of the session list to compute prev/next neighbors. */
function useNeighbors(traceId: string): { prev?: string; next?: string } {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/sessions")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { sessions: SessionSummary[] };
      })
      .then((data) => {
        if (!cancelled) setSessions(data.sessions);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [traceId]);

  return useMemo(() => {
    const ordered = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
    const index = ordered.findIndex((session) => session.traceId === traceId);
    if (index === -1) return {};
    return {
      prev: ordered[index - 1]?.traceId,
      next: ordered[index + 1]?.traceId
    };
  }, [sessions, traceId]);
}

function sessionTokens(session: SessionDetail): number {
  let total = 0;
  for (const call of session.modelCalls) {
    if (call.usage !== undefined) total += tokensOf(call.usage);
  }
  for (const step of session.judgeSteps) {
    const usage = step.final?.usage ?? step.thinking?.usage;
    if (usage !== undefined) total += tokensOf(usage);
  }
  return total;
}

function NeighborLink({
  traceId,
  direction
}: {
  traceId: string | undefined;
  direction: "prev" | "next";
}) {
  const icon = direction === "prev" ? <ChevronLeft /> : <ChevronRight />;
  const label = direction === "prev" ? "Newer session" : "Older session";
  if (traceId === undefined) {
    return (
      <Button variant="outline" size="icon-sm" disabled aria-label={label}>
        {icon}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="icon-sm" aria-label={label}>
          <Link href={`/sessions/${traceId}`}>{icon}</Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export default function SessionDetailPage() {
  const params = useParams<{ traceId: string }>();
  const traceId = params.traceId;
  const { session, loading, error, live } = useSessionDetail(traceId);
  const neighbors = useNeighbors(traceId);
  const [inspected, setInspected] = useState<StoredEvent[] | undefined>(undefined);

  const turnCount = useMemo(() => {
    if (session === undefined) return 0;
    const turns = new Set<number>();
    for (const candidate of session.candidates) if (candidate.turn !== undefined) turns.add(candidate.turn);
    for (const step of session.judgeSteps) if (step.turn !== undefined) turns.add(step.turn);
    return Math.max(turns.size, session.candidates.length > 0 || session.judgeSteps.length > 0 ? 1 : 0);
  }, [session]);

  const totalTokens = session !== undefined ? sessionTokens(session) : 0;
  const prompt = session?.prompt ?? session?.promptPreview;
  const environment = session?.environment;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="mono">{shortId(traceId)}</span>
            <CopyButton value={traceId} label="Copy trace id" />
            {session ? <StatusBadge status={session.status} /> : null}
          </span>
        }
        subtitle={session?.promptPreview ?? session?.environment?.repo ?? "Session detail"}
      >
        <LiveDot active={live} />
        <NeighborLink traceId={neighbors.prev} direction="prev" />
        <NeighborLink traceId={neighbors.next} direction="next" />
        <Button asChild variant="outline" size="sm">
          <Link href="/">
            <ArrowLeft className="size-4" /> Sessions
          </Link>
        </Button>
      </PageHeader>

      <div className="px-8 py-6">
        {loading && session === undefined ? (
          <div className="space-y-6">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-80 w-full" />
          </div>
        ) : error !== undefined && session === undefined ? (
          <EmptyState title="Session not found" hint={`The collector returned: ${error}`} />
        ) : session !== undefined ? (
          <>
            <ErrorBanner error={error} />

            <StatStrip
              className="border-b pb-5"
              stats={[
                { label: "Duration", value: fmtDuration(session.durationMs), mono: true },
                {
                  label: "Started",
                  value: (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>{fmtRelative(session.startedAt)}</span>
                      </TooltipTrigger>
                      <TooltipContent>{fmtDateTime(session.startedAt)}</TooltipContent>
                    </Tooltip>
                  )
                },
                { label: "Dialect", value: session.dialect, mono: true },
                { label: "Repo", value: session.environment?.repo, mono: true },
                { label: "Turns", value: turnCount > 0 ? String(turnCount) : undefined, mono: true },
                {
                  label: "Candidates",
                  value: session.candidates.length > 0 ? String(session.candidates.length) : undefined,
                  mono: true
                },
                {
                  label: "Tokens",
                  value: totalTokens > 0 ? fmtNumber(totalTokens) : undefined,
                  mono: true
                },
                { label: "Events", value: fmtNumber(session.events.length), mono: true }
              ]}
            />

            {prompt !== undefined ? (
              <Section title="Prompt" summary={session.promptPreview}>
                <CodeBlock value={prompt} muted className="p-3" viewportClassName="max-h-[300px]" />
              </Section>
            ) : null}

            <Section
              title="Environment"
              defaultOpen={false}
              summary={
                environment !== undefined
                  ? [
                      environment.repo,
                      environment.judgeModel !== null && environment.judgeModel !== undefined
                        ? `judge ${environment.judgeModel}`
                        : undefined,
                      environment.models !== undefined
                        ? `${environment.models.length} panel models`
                        : undefined
                    ]
                      .filter((part) => part !== undefined)
                      .join(" · ")
                  : "no snapshot captured"
              }
            >
              {environment !== undefined ? (
                <EnvironmentDetail
                  repo={environment.repo}
                  judgeModel={environment.judgeModel}
                  harnesses={environment.harnesses}
                  fusionBackendUrl={environment.fusionBackendUrl}
                  models={(environment.models ?? []).map((model) => ({
                    id: model.id,
                    model: model.model,
                    provider: model.provider,
                    endpoint: environment.modelEndpoints?.[model.id] ?? model.endpoint_id
                  }))}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  No environment snapshot was captured for this session.
                </p>
              )}
            </Section>

            <Section title="Timeline" count={`${session.events.length} events`}>
              <Timeline
                events={session.events}
                startedAt={session.startedAt}
                durationMs={session.durationMs}
                onInspect={setInspected}
              />
            </Section>

            {session.narration.length > 0 ? (
              <Section
                title="Narration"
                count={`${session.narration.length} beats`}
                summary="the reasoning trace streamed to the coding agent"
              >
                <ol className="space-y-3">
                  {session.narration.map((beat, index) => (
                    <li key={index} className="flex gap-3">
                      <span className="mono text-muted-foreground w-14 shrink-0 pt-0.5 text-right text-xs">
                        {fmtDuration(Math.max(0, beat.ts - session.startedAt))}
                      </span>
                      <div>
                        <div className="text-sm font-semibold">{beat.headline}</div>
                        {beat.prose !== undefined ? (
                          <div className="text-muted-foreground text-sm">{beat.prose}</div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </Section>
            ) : null}

            <Section
              title="Run flow"
              count={
                session.candidates.length > 0
                  ? `${session.candidates.length} candidates${turnCount > 1 ? ` · ${turnCount} turns` : ""}`
                  : undefined
              }
            >
              <RunFlow
                candidates={session.candidates}
                judgeSteps={session.judgeSteps}
                judge={session.judge}
                modelCalls={session.modelCalls}
              />
            </Section>

            {session.finalOutput !== undefined || (session.evidence?.length ?? 0) > 0 ? (
              <Section title="Final answer">
                {session.finalOutput !== undefined ? (
                  <CodeBlock value={session.finalOutput} muted className="p-4" />
                ) : null}
                {session.evidence !== undefined && session.evidence.length > 0 ? (
                  <div className="mt-4">
                    <div className="text-muted-foreground mb-1 text-xs">Evidence</div>
                    <ul className="list-disc space-y-1 pl-4 text-sm">
                      {session.evidence.map((item, index) => (
                        <li key={index} className="break-words">
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Section>
            ) : null}

            <Section
              title="Raw events"
              defaultOpen={false}
              summary={Object.entries(session.eventCounts)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 4)
                .map(([type, count]) => `${count} ${type}`)
                .join(" · ")}
              count={fmtNumber(session.events.length)}
            >
              <EventTable
                events={session.events}
                startedAt={session.startedAt}
                onInspect={setInspected}
              />
            </Section>

            <EventInspector
              events={inspected}
              startedAt={session.startedAt}
              onClose={() => setInspected(undefined)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
