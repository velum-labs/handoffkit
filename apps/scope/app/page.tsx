"use client";

import Link from "next/link";
import { Activity, Boxes, ChevronRight } from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { StatusBadge } from "@/components/scope/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { useSessions } from "@/lib/api";
import type { SessionSummary } from "@/lib/api";
import { fmtDuration, fmtTime } from "@/lib/format";

function shortId(traceId: string): string {
  return traceId.replace(/^trace_/, "").slice(0, 8);
}

function PanelModels({ session }: { session: SessionSummary }) {
  const models = session.environment?.models ?? [];
  if (models.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {models.slice(0, 4).map((model) => (
        <Badge key={model.id} variant="secondary" className="font-normal">
          {model.id}
        </Badge>
      ))}
      {models.length > 4 ? (
        <Badge variant="secondary" className="font-normal">
          +{models.length - 4}
        </Badge>
      ) : null}
    </div>
  );
}

export default function SessionsPage() {
  const { sessions, loading, error, refetch } = useSessions();

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle="Every fusion run observed across the stack, correlated by trace id."
      >
        <LiveDot active={!error} />
        <Button variant="outline" size="sm" onClick={refetch}>
          Refresh
        </Button>
      </PageHeader>

      <div className="p-8">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={<Boxes className="size-8" />}
            title="No sessions yet"
            hint={
              <>
                Run <code className="mono">warrant fusion --observe</code> (or point any emitter at{" "}
                <code className="mono">FUSION_TRACE_URL</code>) and live sessions will appear here.
              </>
            }
          />
        ) : (
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead>Trace</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Panel</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">Started</TableHead>
                  <TableHead className="w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.traceId} className="group cursor-pointer">
                    <TableCell>
                      <Link href={`/sessions/${session.traceId}`} className="block">
                        <StatusBadge status={session.status} />
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/sessions/${session.traceId}`} className="block">
                        <span className="mono font-medium">{shortId(session.traceId)}</span>
                        {session.dialect ? (
                          <span className="text-muted-foreground ml-2 text-xs">{session.dialect}</span>
                        ) : null}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-[220px] truncate">
                      <Link href={`/sessions/${session.traceId}`} className="block truncate">
                        {session.repo ?? session.environment?.repo ?? "—"}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/sessions/${session.traceId}`} className="block">
                        <PanelModels session={session} />
                      </Link>
                    </TableCell>
                    <TableCell className="mono text-right text-sm">
                      <Link href={`/sessions/${session.traceId}`} className="block">
                        {fmtDuration(session.durationMs)}
                      </Link>
                    </TableCell>
                    <TableCell className="mono text-muted-foreground text-right text-sm">
                      <Link href={`/sessions/${session.traceId}`} className="block">
                        {session.eventCount}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-sm">
                      <Link href={`/sessions/${session.traceId}`} className="block">
                        {fmtTime(session.startedAt)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/sessions/${session.traceId}`} className="block">
                        <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

        {error ? (
          <p className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
            <Activity className="size-4" /> collector unreachable ({error}) — retrying live.
          </p>
        ) : null}
      </div>
    </div>
  );
}
