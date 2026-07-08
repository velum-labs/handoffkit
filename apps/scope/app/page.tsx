"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Boxes,
  ChevronRight,
  Search,
  Unplug
} from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { ErrorBanner } from "@/components/scope/error-banner";
import { TableSkeleton } from "@/components/scope/loading";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { StatusBadge } from "@/components/scope/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessions } from "@/lib/api";
import type { SessionSummary } from "@/lib/api";
import { fmtDateTime, fmtDuration, fmtRelative, shortTraceId } from "@/lib/format";
import { replaceSearchParams } from "@/lib/url-state";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = ["all", "running", "succeeded", "failed", "skipped"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

type SortKey = "started" | "duration" | "events";
type SortDir = "asc" | "desc";

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

function SortableHead({
  label,
  sortKey,
  active,
  dir,
  onSort,
  className
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "ml-auto inline-flex items-center gap-1 transition-colors hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-50" />
        )}
      </button>
    </TableHead>
  );
}

function statusFromParam(value: string | null): StatusFilter {
  return STATUS_FILTERS.includes(value as StatusFilter) ? (value as StatusFilter) : "all";
}

function sortFromParam(value: string | null): SortKey {
  return value === "duration" || value === "events" ? value : "started";
}

function SessionsPageBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { sessions, loading, error, live, refetch } = useSessions();

  // Filter/sort state lives in the URL (?q=&status=&sort=&dir=) so filtered
  // views are shareable and survive reload/back navigation.
  const [query, setQueryState] = useState(searchParams.get("q") ?? "");
  const [statusFilter, setStatusFilterState] = useState<StatusFilter>(
    statusFromParam(searchParams.get("status"))
  );
  const [sortKey, setSortKey] = useState<SortKey>(sortFromParam(searchParams.get("sort")));
  const [sortDir, setSortDir] = useState<SortDir>(
    searchParams.get("dir") === "asc" ? "asc" : "desc"
  );

  const setQuery = (value: string): void => {
    setQueryState(value);
    replaceSearchParams({ q: value });
  };

  const setStatusFilter = (status: StatusFilter): void => {
    setStatusFilterState(status);
    replaceSearchParams({ status: status === "all" ? undefined : status });
  };

  const onSort = (key: SortKey): void => {
    let nextDir: SortDir = "desc";
    if (key === sortKey) nextDir = sortDir === "asc" ? "desc" : "asc";
    setSortKey(key);
    setSortDir(nextDir);
    replaceSearchParams({
      sort: key === "started" ? undefined : key,
      dir: nextDir === "desc" ? undefined : nextDir
    });
  };

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: sessions.length };
    for (const session of sessions) map[session.status] = (map[session.status] ?? 0) + 1;
    return map;
  }, [sessions]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = sessions;
    if (statusFilter !== "all") rows = rows.filter((session) => session.status === statusFilter);
    if (q.length > 0) {
      rows = rows.filter((session) => {
        const models = (session.environment?.models ?? [])
          .flatMap((model) => [model.id, model.model])
          .join(" ");
        const haystack = [
          session.traceId,
          session.repo ?? session.environment?.repo ?? "",
          session.dialect ?? "",
          session.promptPreview ?? "",
          models
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case "duration":
          return (a.durationMs - b.durationMs) * dir;
        case "events":
          return (a.spanCount - b.spanCount) * dir;
        case "started":
          return (a.startedAt - b.startedAt) * dir;
        default:
          return 0;
      }
    });
  }, [sessions, statusFilter, query, sortKey, sortDir]);

  return (
    <div>
      <PageHeader
        title="Sessions"
        subtitle="Every fusion run observed across the stack, correlated by trace id."
      >
        <LiveDot active={live} />
        <Button variant="outline" size="sm" onClick={refetch}>
          Refresh
        </Button>
      </PageHeader>

      <div className="space-y-4 px-8 py-6">
        {/* When the list is empty AND the collector fetch failed, the dedicated
            connection empty state below carries the error; the banner would
            only duplicate it. It still shows alongside stale-but-present rows. */}
        <ErrorBanner error={sessions.length === 0 ? undefined : error} />

        {loading ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-8 w-72" />
              <Skeleton className="h-8 w-72" />
            </div>
            <TableSkeleton rows={5} />
          </div>
        ) : sessions.length === 0 ? (
          error !== undefined ? (
            // "No sessions yet" would be a lie here: the dashboard simply
            // cannot reach its own collector, so say that instead.
            <EmptyState
              icon={<Unplug className="size-8" />}
              title="Cannot reach the session collector"
              hint={
                <>
                  Loading sessions failed ({error}). The dashboard retries automatically and live
                  sessions will appear as soon as the collector is reachable again.
                </>
              }
            />
          ) : (
            <EmptyState
              icon={<Boxes className="size-8" />}
              title="No sessions yet"
              hint={
                <>
                  Run <code className="mono">fusionkit codex --observe</code> (or point any OTLP
                  emitter at <code className="mono">OTEL_EXPORTER_OTLP_TRACES_ENDPOINT</code>) and
                  live sessions will appear here.
                </>
              }
            />
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {STATUS_FILTERS.map((status) => (
                  <Button
                    key={status}
                    variant={statusFilter === status ? "secondary" : "ghost"}
                    size="xs"
                    onClick={() => setStatusFilter(status)}
                    className="capitalize"
                  >
                    {status}
                    {counts[status] ? (
                      <span className="text-muted-foreground ml-1">{counts[status]}</span>
                    ) : null}
                  </Button>
                ))}
              </div>
              <div className="relative w-full sm:w-72">
                <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter by trace, repo, model, prompt…"
                  aria-label="Filter sessions"
                  className="border-input bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border pr-2.5 pl-8 text-sm outline-none focus-visible:ring-3"
                />
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState title="No matching sessions" hint="Try a different filter or search term." />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[120px]">Status</TableHead>
                    <TableHead>Trace</TableHead>
                    <TableHead>Repo</TableHead>
                    <TableHead>Panel</TableHead>
                    <SortableHead
                      label="Duration"
                      sortKey="duration"
                      active={sortKey === "duration"}
                      dir={sortDir}
                      onSort={onSort}
                      className="text-right"
                    />
                    <SortableHead
                      label="Events"
                      sortKey="events"
                      active={sortKey === "events"}
                      dir={sortDir}
                      onSort={onSort}
                      className="text-right"
                    />
                    <SortableHead
                      label="Started"
                      sortKey="started"
                      active={sortKey === "started"}
                      dir={sortDir}
                      onSort={onSort}
                      className="text-right"
                    />
                    <TableHead className="w-[40px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((session) => (
                    <TableRow
                      key={session.traceId}
                      className="group cursor-pointer"
                      onClick={() => router.push(`/sessions/${session.traceId}`)}
                    >
                      <TableCell>
                        <StatusBadge status={session.status} />
                      </TableCell>
                      <TableCell className="max-w-[320px]">
                        <div>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Link
                                href={`/sessions/${session.traceId}`}
                                onClick={(event) => event.stopPropagation()}
                                className="mono font-medium hover:underline"
                              >
                                {shortTraceId(session.traceId)}
                              </Link>
                            </TooltipTrigger>
                            <TooltipContent className="mono">{session.traceId}</TooltipContent>
                          </Tooltip>
                          {session.dialect ? (
                            <span className="text-muted-foreground ml-2 text-xs">{session.dialect}</span>
                          ) : null}
                        </div>
                        {session.promptPreview ?? session.finalOutput ? (
                          <div className="text-muted-foreground mt-0.5 truncate text-xs">
                            {session.promptPreview ?? session.finalOutput}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-[220px] truncate">
                        {session.repo ?? session.environment?.repo ?? "—"}
                      </TableCell>
                      <TableCell>
                        <PanelModels session={session} />
                      </TableCell>
                      <TableCell className="mono text-right text-sm">
                        {fmtDuration(session.durationMs)}
                      </TableCell>
                      <TableCell className="mono text-muted-foreground text-right text-sm">
                        {session.spanCount}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-right text-sm">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>{fmtRelative(session.startedAt)}</span>
                          </TooltipTrigger>
                          <TooltipContent>{fmtDateTime(session.startedAt)}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="text-muted-foreground size-4 transition-transform group-hover:translate-x-0.5" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function SessionsPage() {
  return (
    <Suspense>
      <SessionsPageBody />
    </Suspense>
  );
}
