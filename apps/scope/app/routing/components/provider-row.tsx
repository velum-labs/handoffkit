"use client";

import { KeyRound, Wifi, WifiOff } from "lucide-react";

import { StatusBadge } from "@/components/scope/status-badge";
import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import type { ProviderStatus } from "@/lib/routing/types";

function connectivityLabel(provider: ProviderStatus): string {
  if (!provider.hasKey) return "key missing";
  if (provider.reachable === null) return "skipped";
  if (provider.reachable) return provider.pingMs !== null ? `${provider.pingMs}ms` : "ok";
  return provider.pingError ?? "unreachable";
}

/** One provider row in the providers status table. */
export function ProviderRow({ provider }: { provider: ProviderStatus }) {
  const reachable = provider.reachable === true;
  const unknown = provider.reachable === null;

  return (
    <TableRow>
      <TableCell className="mono font-medium">{provider.id}</TableCell>
      <TableCell>
        <Badge variant="secondary" className="font-normal">
          {provider.kind}
        </Badge>
      </TableCell>
      <TableCell className="mono text-muted-foreground max-w-[280px] truncate text-xs">
        {provider.baseUrl}
      </TableCell>
      <TableCell>
        <span className="mono text-xs">{provider.keyEnv ?? "—"}</span>
      </TableCell>
      <TableCell>
        {provider.hasKey ? (
          <StatusBadge status="succeeded" className="text-xs" />
        ) : (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <KeyRound className="size-3.5" aria-hidden />
            missing
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <span className="inline-flex items-center justify-end gap-1.5 text-sm">
          {unknown ? (
            <span className="text-muted-foreground">—</span>
          ) : reachable ? (
            <Wifi className="size-3.5 text-emerald-500" aria-hidden />
          ) : (
            <WifiOff className="size-3.5 text-red-500" aria-hidden />
          )}
          <span className={reachable ? "text-emerald-500" : unknown ? "text-muted-foreground" : "text-red-500"}>
            {connectivityLabel(provider)}
          </span>
        </span>
      </TableCell>
    </TableRow>
  );
}
