"use client";

import { FolderGit2, Layers } from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { useEnvironments } from "@/lib/api";

export default function EnvironmentsPage() {
  const { environments, loading, error } = useEnvironments();

  return (
    <div>
      <PageHeader
        title="Environments"
        subtitle="Distinct stack configurations observed across sessions."
      >
        <LiveDot active={!error} />
      </PageHeader>

      <div className="p-8">
        {loading ? (
          <div className="grid gap-6 md:grid-cols-2">
            <Skeleton className="h-56 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        ) : environments.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-8" />}
            title="No environments observed"
            hint="Each session.started snapshot contributes a panel/stack configuration here."
          />
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {environments.map((environment) => (
              <Card key={environment.signature}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <FolderGit2 className="text-muted-foreground size-4" />
                      <span className="mono truncate">{environment.repo ?? "unknown repo"}</span>
                    </CardTitle>
                    <Badge variant="secondary" className="font-normal">
                      {environment.sessionCount} {environment.sessionCount === 1 ? "session" : "sessions"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <div className="text-muted-foreground text-xs">Judge</div>
                      <div className="mono truncate">{environment.judgeModel ?? "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground text-xs">Harness</div>
                      <div className="mono truncate">
                        {environment.harnesses && environment.harnesses.length > 0
                          ? environment.harnesses.join(", ")
                          : "—"}
                      </div>
                    </div>
                  </div>

                  {environment.fusionBackendUrl ? (
                    <div className="text-sm">
                      <div className="text-muted-foreground text-xs">Synthesis backend</div>
                      <div className="mono truncate">{environment.fusionBackendUrl}</div>
                    </div>
                  ) : null}

                  <Separator />

                  <div>
                    <div className="text-muted-foreground mb-2 text-xs">
                      Panel ({environment.models.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {environment.models.map((model) => (
                        <Badge key={model.id} variant="outline" className="gap-1 font-normal">
                          <span className="font-medium">{model.id}</span>
                          <span className="text-muted-foreground mono">{model.model}</span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
