import { StatusBadge } from "@/components/scope/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { fmtNumber } from "@/lib/format";
import type { ModelCallView } from "@/lib/sessions";

function tokens(usage: Record<string, unknown> | undefined): string {
  if (usage === undefined) return "—";
  const total = usage.total_tokens;
  if (typeof total === "number") return fmtNumber(total);
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  if (prompt === undefined && completion === undefined) return "—";
  return `${fmtNumber(prompt ?? 0)}+${fmtNumber(completion ?? 0)}`;
}

export function ModelCalls({ calls }: { calls: ModelCallView[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <CardHeader className="p-6 pb-0">
        <CardTitle className="text-base">Model calls</CardTitle>
      </CardHeader>
      <CardContent className="p-6 pt-4">
        {calls.length === 0 ? (
          <p className="text-muted-foreground text-sm">No model calls observed yet.</p>
        ) : (
          <ScrollArea viewportClassName="max-h-[340px]">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Candidate</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead>Finish</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls.map((call) => (
                <TableRow key={call.spanId}>
                  <TableCell>
                    <StatusBadge status={call.status} />
                  </TableCell>
                  <TableCell className="mono text-sm">{call.model ?? call.modelId ?? "—"}</TableCell>
                  <TableCell className="mono text-muted-foreground text-xs">
                    {call.candidateId ?? "—"}
                  </TableCell>
                  <TableCell className="mono text-right text-sm">
                    {typeof call.latencyS === "number" ? `${call.latencyS.toFixed(2)}s` : "—"}
                  </TableCell>
                  <TableCell className="mono text-right text-sm">{tokens(call.usage)}</TableCell>
                  <TableCell className="text-xs">
                    {call.error ? (
                      <Badge variant="destructive" className="max-w-[280px] truncate font-normal" title={call.error}>
                        {call.error}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">{call.finishReason ?? "—"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
