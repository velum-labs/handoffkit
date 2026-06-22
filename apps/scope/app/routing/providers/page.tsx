"use client";

import { Server } from "lucide-react";

import { EmptyState } from "@/components/scope/empty-state";
import { LiveDot, PageHeader } from "@/components/scope/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";

import { ProviderRow } from "../components/provider-row";
import { RoutingNav } from "../components/routing-nav";
import { useRoutingProviders } from "@/lib/routing/api";

export default function RoutingProvidersPage() {
  const { providers, loading, error, refetch } = useRoutingProviders();

  return (
    <div>
      <PageHeader
        title="Routing providers"
        subtitle="Provider backends from fusion.json — key env presence and connectivity."
      >
        <LiveDot active={!error} />
        <Button variant="outline" size="sm" onClick={refetch}>
          Re-ping
        </Button>
      </PageHeader>

      <div className="p-8">
        <RoutingNav />

        {loading ? (
          <Skeleton className="h-64 w-full" />
        ) : error ? (
          <EmptyState
            icon={<Server className="size-8" />}
            title="Providers unavailable"
            hint={error}
          />
        ) : providers.length === 0 ? (
          <EmptyState title="No providers configured" hint="Add routing.providers to fusion.json." />
        ) : (
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>ID</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>Key env</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead className="text-right">Connectivity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => (
                  <ProviderRow key={provider.id} provider={provider} />
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>
    </div>
  );
}
