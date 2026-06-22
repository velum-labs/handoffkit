"use client";

import { ArrowRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { fmtRelative } from "@/lib/format";
import type { RoutingDecisionEvent } from "@/lib/routing/types";

/** Render one live routing decision in the overview stream. */
export function DecisionCard({ decision }: { decision: RoutingDecisionEvent }) {
  const target =
    decision.target.providerId !== undefined
      ? `${decision.target.providerId},${decision.target.model}`
      : decision.target.model;

  return (
    <Card className="overflow-hidden p-0">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-medium capitalize">
              {decision.scenario}
            </Badge>
            {decision.fallbackIndex > 0 ? (
              <Badge variant="outline" className="font-normal">
                fallback {decision.fallbackIndex}
              </Badge>
            ) : null}
          </div>
          <span className="text-muted-foreground text-xs">{fmtRelative(decision.ts * 1000)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">target</span>
          <span className="mono font-medium">{target}</span>
          <ArrowRight className="text-muted-foreground size-3.5" aria-hidden />
          <span className="text-muted-foreground mono text-xs">{decision.tokenCount} tokens</span>
        </div>

        <p className="text-muted-foreground text-sm">{decision.reason}</p>
      </CardContent>
    </Card>
  );
}
