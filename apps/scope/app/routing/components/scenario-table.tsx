"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { parseRouteTarget } from "@/lib/routing/parse";
import type { RoutingScenario, ScenarioRoutes } from "@/lib/routing/types";
import { ROUTING_SCENARIOS } from "@/lib/routing/types";

function formatTarget(spec: string): string {
  try {
    const parsed = parseRouteTarget(spec);
    return parsed.providerId !== undefined ? `${parsed.providerId},${parsed.model}` : parsed.model;
  } catch {
    return spec;
  }
}

function fallbacksFor(scenario: RoutingScenario, routes: ScenarioRoutes): string[] {
  const chain = routes.fallbacks?.[scenario];
  return chain !== undefined ? [...chain] : [];
}

/** Per-scenario routing table with primary targets and fallback chains. */
export function ScenarioTable({ routes }: { routes: ScenarioRoutes }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Scenario</TableHead>
          <TableHead>Primary</TableHead>
          <TableHead>Fallbacks</TableHead>
          <TableHead className="text-right">Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ROUTING_SCENARIOS.map((scenario) => {
          const primary = scenario === "default" ? routes.default : routes[scenario];
          const fallbacks = fallbacksFor(scenario, routes);
          return (
            <TableRow key={scenario}>
              <TableCell>
                <Badge variant="outline" className="font-medium capitalize">
                  {scenario}
                </Badge>
              </TableCell>
              <TableCell className="mono text-sm">
                {primary !== undefined ? formatTarget(primary) : (
                  <span className="text-muted-foreground">inherits default</span>
                )}
              </TableCell>
              <TableCell>
                {fallbacks.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {fallbacks.map((target) => (
                      <Badge key={target} variant="secondary" className="mono font-normal">
                        {formatTarget(target)}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">—</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-right text-xs">
                {scenario === "longContext" && routes.longContextThreshold !== undefined
                  ? `threshold ${routes.longContextThreshold.toLocaleString()} tokens`
                  : "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
