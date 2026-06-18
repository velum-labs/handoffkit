import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import type { JudgeView } from "@/lib/sessions";

const ANALYSIS_SECTIONS: Array<{ key: string; label: string }> = [
  { key: "consensus", label: "Consensus" },
  { key: "contradictions", label: "Contradictions" },
  { key: "unique_insights", label: "Unique insights" },
  { key: "coverage_gaps", label: "Coverage gaps" },
  { key: "likely_errors", label: "Likely errors" }
];

type Rank = { candidate_id?: string; rank?: number; score?: number };

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function ranksOf(metrics: Record<string, unknown> | undefined): Rank[] {
  const raw = metrics?.candidate_ranks;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Rank => typeof item === "object" && item !== null);
}

function UsageChip({ usage }: { usage: Record<string, unknown> | undefined }) {
  if (usage === undefined) return null;
  const tokens = usage.total_tokens ?? usage.completion_tokens;
  if (typeof tokens !== "number") return null;
  return (
    <Badge variant="outline" className="font-normal">
      {tokens} tokens
    </Badge>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function AnalysisSections({ analysis }: { analysis: Record<string, unknown> | undefined }) {
  const sections = ANALYSIS_SECTIONS.map((section) => ({
    ...section,
    items: strList(analysis?.[section.key])
  })).filter((section) => section.items.length > 0);

  if (sections.length === 0) return null;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {sections.map((section) => (
        <div key={section.key}>
          <div className="text-muted-foreground mb-1 text-xs">{section.label}</div>
          <ul className="list-disc space-y-1 pl-4 text-sm">
            {section.items.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function JudgeViewPanel({ judge }: { judge: JudgeView }) {
  const ranks = ranksOf(judge.scored?.metrics);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Judge</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="thinking">
          <TabsList className="mb-4">
            <TabsTrigger value="thinking">Thinking</TabsTrigger>
            <TabsTrigger value="scored">Scored</TabsTrigger>
            <TabsTrigger value="synthesis">Synthesis</TabsTrigger>
            <TabsTrigger value="final">Final</TabsTrigger>
          </TabsList>

          <TabsContent value="thinking" className="space-y-3">
            {judge.thinking?.raw ? (
              <>
                <div className="flex items-center gap-2">
                  {judge.thinking.fusionUnit ? (
                    <Badge variant="secondary" className="font-normal">
                      {judge.thinking.fusionUnit}
                    </Badge>
                  ) : null}
                  <UsageChip usage={judge.thinking.usage} />
                </div>
                <ScrollArea className="max-h-[440px] pr-3">
                  <pre className="mono text-xs leading-relaxed">{judge.thinking.raw}</pre>
                </ScrollArea>
              </>
            ) : (
              <Empty>The judge has not produced its analysis yet.</Empty>
            )}
          </TabsContent>

          <TabsContent value="scored" className="space-y-4">
            {judge.scored === undefined ? (
              <Empty>No scoring captured yet.</Empty>
            ) : (
              <>
                <AnalysisSections analysis={judge.scored.analysis} />
                {ranks.length > 0 ? (
                  <>
                    <Separator />
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Candidate</TableHead>
                          <TableHead className="text-right">Rank</TableHead>
                          <TableHead className="text-right">Score</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {ranks.map((rank, index) => (
                          <TableRow key={rank.candidate_id ?? index}>
                            <TableCell className="mono">{rank.candidate_id ?? "—"}</TableCell>
                            <TableCell className="mono text-right">{rank.rank ?? "—"}</TableCell>
                            <TableCell className="mono text-right">
                              {typeof rank.score === "number" ? rank.score.toFixed(2) : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                ) : null}
              </>
            )}
          </TabsContent>

          <TabsContent value="synthesis" className="space-y-3">
            {judge.synthesis?.raw ? (
              <>
                <div className="flex items-center gap-2">
                  {judge.synthesis.empty ? (
                    <Badge variant="destructive" className="font-normal">
                      empty — fell back to best candidate
                    </Badge>
                  ) : null}
                  <UsageChip usage={judge.synthesis.usage} />
                </div>
                <ScrollArea className="max-h-[440px] pr-3">
                  <pre className="mono text-xs leading-relaxed">{judge.synthesis.raw}</pre>
                </ScrollArea>
              </>
            ) : (
              <Empty>No synthesis reasoning captured yet.</Empty>
            )}
          </TabsContent>

          <TabsContent value="final" className="space-y-3">
            {judge.final === undefined ? (
              <Empty>The judge has not finalized yet.</Empty>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {judge.final.decision ? (
                    <Badge variant="secondary" className="font-normal capitalize">
                      {judge.final.decision.replace(/_/g, " ")}
                    </Badge>
                  ) : null}
                  {judge.final.selectedCandidateId ? (
                    <Badge variant="outline" className="mono font-normal">
                      {judge.final.selectedCandidateId}
                    </Badge>
                  ) : null}
                </div>
                {judge.final.rationale ? (
                  <div>
                    <div className="text-muted-foreground mb-1 text-xs">Rationale</div>
                    <p className="text-sm leading-relaxed">{judge.final.rationale}</p>
                  </div>
                ) : null}
                {judge.final.finalOutput ? (
                  <div>
                    <div className="text-muted-foreground mb-1 text-xs">Final output</div>
                    <pre className="bg-muted/40 mono rounded-md p-3 text-xs leading-relaxed">
                      {judge.final.finalOutput}
                    </pre>
                  </div>
                ) : null}
              </>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
