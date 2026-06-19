import { CodeBlock } from "@/components/scope/code-block";
import { JsonView } from "@/components/scope/json-view";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { fmtNumber } from "@/lib/format";
import type { JudgeStepView, JudgeView } from "@/lib/sessions";

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
      {fmtNumber(tokens)} tokens
    </Badge>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

function JudgePrompt({ prompt }: { prompt: JudgeView["prompt"] }) {
  if (prompt === undefined) {
    return <Empty>The judge prompt has not been captured yet.</Empty>;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {prompt.judgeModel ? (
          <Badge variant="secondary" className="mono font-normal">
            {prompt.judgeModel}
          </Badge>
        ) : null}
        {prompt.trajectoryIds && prompt.trajectoryIds.length > 0 ? (
          <Badge variant="outline" className="font-normal">
            {prompt.trajectoryIds.length} candidate trajectories
          </Badge>
        ) : null}
      </div>
      {prompt.messages !== undefined ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Conversation sent to the judge</div>
          <JsonView data={prompt.messages} maxHeight="300px" />
        </div>
      ) : null}
      {prompt.trajectories !== undefined ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Candidate trajectories the judge fuses</div>
          <JsonView data={prompt.trajectories} maxHeight="300px" />
        </div>
      ) : null}
      {prompt.tools !== undefined ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Tools offered to the judge</div>
          <JsonView data={prompt.tools} maxHeight="240px" />
        </div>
      ) : null}
    </div>
  );
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

function groupByTurn(steps: JudgeStepView[]): Array<{ turn?: number; steps: JudgeStepView[] }> {
  const groups: Array<{ turn?: number; steps: JudgeStepView[] }> = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.turn === step.turn) last.steps.push(step);
    else groups.push({ turn: step.turn, steps: [step] });
  }
  return groups;
}

function StepCard({ step }: { step: JudgeStepView }) {
  const text = step.final?.finalOutput ?? step.final?.content ?? step.thinking?.raw;
  const messages = step.prompt?.messages;
  const trajectoryCount = step.prompt?.trajectoryIds?.length ?? 0;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={step.kind === "final" ? "secondary" : "outline"} className="font-normal capitalize">
          {step.kind}
        </Badge>
        {step.final?.decision ? (
          <Badge variant="outline" className="font-normal capitalize">
            {step.final.decision.replace(/_/g, " ")}
          </Badge>
        ) : null}
        {trajectoryCount > 0 ? (
          <Badge variant="outline" className="font-normal">
            {trajectoryCount} trajectories
          </Badge>
        ) : null}
        <UsageChip usage={step.final?.usage ?? step.thinking?.usage} />
      </div>
      {text ? (
        <CodeBlock value={text} viewportClassName="max-h-[260px]" />
      ) : (
        <Empty>No output captured for this step.</Empty>
      )}
      {messages !== undefined ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Prompt sent this turn</div>
          <JsonView data={messages} maxHeight="200px" />
        </div>
      ) : null}
    </div>
  );
}

function JudgeTurns({ steps }: { steps: JudgeStepView[] }) {
  if (steps.length === 0) {
    return <Empty>No judge turns captured yet.</Empty>;
  }
  return (
    <div className="space-y-5">
      {groupByTurn(steps).map((group, index) => (
        <div key={index} className="space-y-2">
          <div className="text-muted-foreground text-xs">
            Turn {index + 1}
            {group.turn !== undefined ? ` · judge turn ${group.turn}` : ""} · {group.steps.length} step
            {group.steps.length === 1 ? "" : "s"}
          </div>
          {group.steps.map((step) => (
            <StepCard key={step.spanId} step={step} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function JudgeViewPanel({ judge, steps = [] }: { judge: JudgeView; steps?: JudgeStepView[] }) {
  const ranks = ranksOf(judge.scored?.metrics);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Judge</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="turns">
          <TabsList className="mb-4">
            <TabsTrigger value="turns">Turns</TabsTrigger>
            <TabsTrigger value="prompt">Prompt</TabsTrigger>
            <TabsTrigger value="thinking">Thinking</TabsTrigger>
            <TabsTrigger value="scored">Scored</TabsTrigger>
            <TabsTrigger value="synthesis">Synthesis</TabsTrigger>
            <TabsTrigger value="final">Final</TabsTrigger>
          </TabsList>

          <TabsContent value="turns" className="space-y-3">
            <JudgeTurns steps={steps} />
          </TabsContent>

          <TabsContent value="prompt" className="space-y-3">
            <JudgePrompt prompt={judge.prompt} />
          </TabsContent>

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
                <CodeBlock value={judge.thinking.raw} viewportClassName="max-h-[440px]" />
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
                <CodeBlock value={judge.synthesis.raw} viewportClassName="max-h-[440px]" />
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
                  <UsageChip usage={judge.final.usage} />
                </div>
                {judge.final.rationale ? (
                  <div>
                    <div className="text-muted-foreground mb-1 text-xs">Rationale</div>
                    <p className="text-sm leading-relaxed">{judge.final.rationale}</p>
                  </div>
                ) : null}
                <p className="text-muted-foreground text-xs">
                  The judge&apos;s final output is shown in the Final output panel below.
                </p>
              </>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
