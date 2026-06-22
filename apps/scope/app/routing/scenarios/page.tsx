"use client";

import { Table2 } from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { PageHeader } from "@/components/scope/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { ScenarioTable } from "../components/scenario-table";
import { RoutingNav } from "../components/routing-nav";
import { useRoutingConfig } from "@/lib/routing/api";

export default function RoutingScenariosPage() {
  const { data, loading, error, refetch } = useRoutingConfig();
  const routing = data?.routing;

  return (
    <div>
      <PageHeader
        title="Routing scenarios"
        subtitle="Per-scenario primary targets and fallback chains from fusion.json."
      >
        <Button variant="outline" size="sm" onClick={refetch}>
          Refresh
        </Button>
      </PageHeader>

      <div className="p-8">
        <RoutingNav />

        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : error || routing === null || routing === undefined ? (
          <EmptyState
            icon={<Table2 className="size-8" />}
            title="Scenarios unavailable"
            hint={error ?? data?.error ?? "Load a routing section in fusion.json first."}
          />
        ) : (
          <Card className="overflow-hidden p-0">
            <ScenarioTable routes={routing.routes} />
          </Card>
        )}
      </div>
    </div>
  );
}
