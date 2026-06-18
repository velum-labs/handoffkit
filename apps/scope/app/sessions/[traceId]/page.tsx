"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { EnvironmentCard } from "@/components/scope/environment-card";
import { JudgeViewPanel } from "@/components/scope/judge-view";
import { ModelCalls } from "@/components/scope/model-calls";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { StatusBadge } from "@/components/scope/status-badge";
import { Timeline } from "@/components/scope/timeline";
import { TrajectoryViewer } from "@/components/scope/trajectory";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSessionDetail } from "@/lib/api";
import { fmtDuration } from "@/lib/format";

function shortId(traceId: string): string {
  return traceId.replace(/^trace_/, "").slice(0, 12);
}

export default function SessionDetailPage() {
  const params = useParams<{ traceId: string }>();
  const traceId = params.traceId;
  const { session, loading, error, live } = useSessionDetail(traceId);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span className="mono">{shortId(traceId)}</span>
            {session ? <StatusBadge status={session.status} /> : null}
          </span>
        }
        subtitle={session?.promptPreview ?? session?.environment?.repo ?? "Session detail"}
      >
        <LiveDot active={live} />
        {session ? (
          <span className="text-muted-foreground mono text-sm">{fmtDuration(session.durationMs)}</span>
        ) : null}
        <Button asChild variant="outline" size="sm">
          <Link href="/">
            <ArrowLeft className="size-4" /> Sessions
          </Link>
        </Button>
      </PageHeader>

      <div className="space-y-6 p-8">
        {loading && session === undefined ? (
          <div className="space-y-6">
            <div className="grid gap-6 lg:grid-cols-2">
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-64 w-full" />
            </div>
            <Skeleton className="h-80 w-full" />
          </div>
        ) : error !== undefined && session === undefined ? (
          <EmptyState title="Session not found" hint={`The collector returned: ${error}`} />
        ) : session !== undefined ? (
          <>
            <div className="grid gap-6 lg:grid-cols-2">
              <EnvironmentCard environment={session.environment} />
              <Timeline
                events={session.events}
                startedAt={session.startedAt}
                durationMs={session.durationMs}
              />
            </div>

            <ModelCalls calls={session.modelCalls} />

            <TrajectoryViewer candidates={session.candidates} />

            <JudgeViewPanel judge={session.judge} />

            {session.finalOutput ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Final output</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="bg-muted/40 mono rounded-md p-4 text-sm leading-relaxed">
                    {session.finalOutput}
                  </pre>
                </CardContent>
              </Card>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
