"use client";

import { GitBranch, Route } from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JsonTree } from "@/components/ui/json-tree";
import { Skeleton } from "@/components/ui/skeleton";

import { DecisionCard } from "./components/decision-card";
import { RoutingNav } from "./components/routing-nav";
import { useRoutingConfig, useRoutingDecisions } from "@/lib/routing/api";

export default function RoutingOverviewPage() {
  const { data, loading, error, refetch } = useRoutingConfig();
  const { decisions, connected, error: streamError } = useRoutingDecisions();

  const routing = data?.routing;

  return (
    <div>
      <PageHeader
        title="Routing"
        subtitle="Live Claude Code Router decisions and committed fusion.json routing config."
      >
        <LiveDot active={connected && !streamError} label={connected ? "live" : "connecting"} />
        <Button variant="outline" size="sm" onClick={refetch}>
          Refresh config
        </Button>
      </PageHeader>

      <div className="p-8">
        <RoutingNav />

        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : error ? (
          <EmptyState
            icon={<Route className="size-8" />}
            title="No routing config"
            hint={
              <>
                {error}. Add a <code className="mono">routing</code> section to{" "}
                <code className="mono">.fusionkit/fusion.json</code> or set{" "}
                <code className="mono">SCOPE_REPO_ROOT</code>.
              </>
            }
          />
        ) : routing === null || routing === undefined ? (
          <EmptyState
            icon={<GitBranch className="size-8" />}
            title="No routing section"
            hint={
              data?.error ??
              "fusion.json exists but has no routing block — run fusionkit init or add routing.providers + routes."
            }
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Config summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2 text-sm">
                  <Badge variant="outline" className="font-normal">
                    {data?.configPath}
                  </Badge>
                  <Badge variant="secondary" className="font-normal">
                    {routing.providers.length} providers
                  </Badge>
                </div>
                <div className="max-h-80 overflow-auto rounded-lg border p-3">
                  <JsonTree data={routing} />
                </div>
              </CardContent>
            </Card>

            <div className="space-y-3">
              <h2 className="text-sm font-medium">Live decisions</h2>
              {decisions.length === 0 ? (
                <EmptyState
                  title="No decisions yet"
                  hint={
                    <>
                      Start <code className="mono">fusionkit fusion claude --route</code> or POST a
                      decision to <code className="mono">/api/routing/decisions</code> to populate the
                      stream.
                    </>
                  }
                />
              ) : (
                <div className="space-y-3">
                  {decisions.map((decision) => (
                    <DecisionCard key={decision.id} decision={decision} />
                  ))}
                </div>
              )}
              {streamError ? (
                <p className="text-muted-foreground text-xs">{streamError}</p>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
