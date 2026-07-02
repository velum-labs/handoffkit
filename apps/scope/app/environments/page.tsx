"use client";

import Link from "next/link";
import { ExternalLink, FolderGit2, Layers } from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { EnvironmentDetail } from "@/components/scope/environment-detail";
import { ErrorBanner } from "@/components/scope/error-banner";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { Section } from "@/components/scope/section";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEnvironments } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

export default function EnvironmentsPage() {
  const { environments, loading, error, live } = useEnvironments();

  return (
    <div>
      <PageHeader
        title="Environments"
        subtitle="Distinct stack configurations observed across sessions."
      >
        <LiveDot active={live} />
      </PageHeader>

      <div className="space-y-4 px-8 py-6">
        <ErrorBanner error={error} />

        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : environments.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-8" />}
            title="No environments observed"
            hint="Each session.started snapshot contributes a panel/stack configuration here."
          />
        ) : (
          <div>
            {environments.map((environment) => (
              <Section
                key={environment.signature}
                defaultOpen={environments.length === 1}
                title={
                  <span className="flex items-center gap-2">
                    <FolderGit2 className="text-muted-foreground size-4" />
                    <span className="mono">{environment.repo ?? "unknown repo"}</span>
                  </span>
                }
                count={`${environment.sessionCount} ${environment.sessionCount === 1 ? "session" : "sessions"}`}
                summary={[
                  environment.judgeModel !== null && environment.judgeModel !== undefined
                    ? `judge ${environment.judgeModel}`
                    : undefined,
                  `${environment.models.length} panel models`,
                  environment.lastTs > 0 ? `last ${fmtRelative(environment.lastTs)}` : undefined
                ]
                  .filter((part) => part !== undefined)
                  .join(" · ")}
                meta={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button asChild variant="ghost" size="xs">
                        <Link href={`/?q=${encodeURIComponent(environment.repo ?? "")}`}>
                          <ExternalLink className="size-3.5" /> Sessions
                        </Link>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Show sessions from this environment</TooltipContent>
                  </Tooltip>
                }
              >
                <EnvironmentDetail
                  repo={environment.repo}
                  judgeModel={environment.judgeModel}
                  harnesses={environment.harnesses}
                  fusionBackendUrl={environment.fusionBackendUrl}
                  models={environment.models.map((model) => ({
                    id: model.id,
                    model: model.model,
                    provider: model.provider,
                    endpoint: environment.modelEndpoints?.[model.id] ?? model.endpointId
                  }))}
                />
              </Section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
