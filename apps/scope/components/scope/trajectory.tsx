import { AlertTriangle, GitBranch, Wrench } from "lucide-react";

import { CodeBlock } from "@/components/scope/code-block";
import { StatusBadge } from "@/components/scope/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { stepColor } from "@/lib/format";
import type { CandidateView, TrajectoryStepView } from "@/lib/sessions";
import { cn } from "@/lib/utils";

function StepRow({ step, isLast }: { step: TrajectoryStepView; isLast: boolean }) {
  const color = stepColor(step.type);
  return (
    <div className="relative pl-5">
      <span className="absolute top-1.5 left-0 size-2 rounded-full" style={{ background: color }} />
      {isLast ? null : (
        <span className="absolute top-3.5 bottom-0 left-[3.5px] w-px bg-border" />
      )}
      <div className="flex items-center gap-2 pb-1">
        <span className="text-xs font-medium capitalize" style={{ color }}>
          {step.type.replace(/_/g, " ")}
        </span>
        <span className="text-muted-foreground mono text-[11px]">#{step.index}</span>
        {step.tool_name ? (
          <Badge variant="secondary" className="gap-1 font-normal">
            <Wrench className="size-3" /> {step.tool_name}
          </Badge>
        ) : null}
        {step.is_error ? (
          <Badge variant="destructive" className="gap-1 font-normal">
            <AlertTriangle className="size-3" /> error
          </Badge>
        ) : null}
      </div>
      {step.text ? (
        <pre className="text-muted-foreground mono pb-3 text-xs leading-relaxed">{step.text}</pre>
      ) : null}
      {step.tool_input ? (
        <pre className="bg-muted/40 mono mb-3 rounded-md p-2 text-xs leading-relaxed">{step.tool_input}</pre>
      ) : null}
    </div>
  );
}

function CandidatePanel({ candidate }: { candidate: CandidateView }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={candidate.status} />
        {candidate.model ?? candidate.modelId ? (
          <Badge variant="secondary" className="mono font-normal">
            {candidate.model ?? candidate.modelId}
          </Badge>
        ) : null}
        {candidate.branchName ? (
          <Badge variant="outline" className="gap-1 font-normal">
            <GitBranch className="size-3" /> {candidate.branchName}
          </Badge>
        ) : null}
        {candidate.finishReason ? (
          <span className="text-muted-foreground text-xs">finish: {candidate.finishReason}</span>
        ) : null}
        {candidate.verificationStatus ? (
          <span className="text-muted-foreground text-xs">verify: {candidate.verificationStatus}</span>
        ) : null}
        {typeof candidate.toolCallCount === "number" ? (
          <span className="text-muted-foreground text-xs">{candidate.toolCallCount} tool calls</span>
        ) : null}
      </div>

      {candidate.systemPrompt || candidate.prompt ? (
        <div className="space-y-2">
          {candidate.systemPrompt ? (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">System prompt</div>
              <CodeBlock value={candidate.systemPrompt} muted className="p-2" />
            </div>
          ) : null}
          {candidate.prompt ? (
            <div>
              <div className="text-muted-foreground mb-1 text-xs">Task prompt</div>
              <CodeBlock value={candidate.prompt} muted className="p-2" />
            </div>
          ) : null}
          <Separator />
        </div>
      ) : null}

      {candidate.steps.length === 0 ? (
        <p className="text-muted-foreground text-sm">No trajectory steps captured yet.</p>
      ) : (
        <ScrollArea viewportClassName="max-h-[460px] pr-3">
          <div className="space-y-0">
            {candidate.steps.map((step, index) => (
              <StepRow
                key={`${step.index}-${index}`}
                step={step}
                isLast={index === candidate.steps.length - 1}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      {candidate.finalOutput ?? candidate.finalOutputPreview ? (
        <>
          <Separator />
          <div>
            <div className="text-muted-foreground mb-1 text-xs">Final output</div>
            <CodeBlock value={candidate.finalOutput ?? candidate.finalOutputPreview ?? ""} muted className="p-3" />
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Group candidates by user turn so follow-up panels render under their own turn. */
function groupCandidatesByTurn(
  candidates: CandidateView[]
): Array<{ turn?: number; candidates: CandidateView[] }> {
  const byTurn = new Map<number, CandidateView[]>();
  const noTurn: CandidateView[] = [];
  for (const candidate of candidates) {
    if (candidate.turn === undefined) {
      noTurn.push(candidate);
      continue;
    }
    const list = byTurn.get(candidate.turn) ?? [];
    list.push(candidate);
    byTurn.set(candidate.turn, list);
  }
  const groups: Array<{ turn?: number; candidates: CandidateView[] }> = [...byTurn.entries()]
    .sort(([a], [b]) => a - b)
    .map(([turn, group]) => ({ turn, candidates: group }));
  if (noTurn.length > 0) groups.push({ turn: undefined, candidates: noTurn });
  return groups;
}

function CandidateTabs({ candidates }: { candidates: CandidateView[] }) {
  return (
    <Tabs defaultValue={candidates[0].candidateId}>
      <TabsList className={cn("mb-4 flex w-full flex-wrap")}>
        {candidates.map((candidate) => (
          <TabsTrigger key={candidate.candidateId} value={candidate.candidateId} className="gap-1.5">
            <span
              className="size-1.5 rounded-full"
              style={{
                background:
                  candidate.status === "succeeded"
                    ? "#3fb950"
                    : candidate.status === "failed"
                      ? "#f85149"
                      : "#d29922"
              }}
            />
            {candidate.modelId ?? candidate.candidateId}
          </TabsTrigger>
        ))}
      </TabsList>
      {candidates.map((candidate) => (
        <TabsContent key={candidate.candidateId} value={candidate.candidateId}>
          <CandidatePanel candidate={candidate} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

export function TrajectoryViewer({ candidates }: { candidates: CandidateView[] }) {
  const groups = groupCandidatesByTurn(candidates);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Candidate trajectories</CardTitle>
      </CardHeader>
      <CardContent>
        {candidates.length === 0 ? (
          <p className="text-muted-foreground text-sm">No candidates have started yet.</p>
        ) : groups.length <= 1 ? (
          <CandidateTabs candidates={candidates} />
        ) : (
          <div className="space-y-6">
            {groups.map((group, index) => (
              <div key={group.turn ?? `group-${index}`} className="space-y-2">
                <div className="text-muted-foreground text-xs">
                  {group.turn !== undefined ? `Turn ${group.turn}` : "Unattributed"}
                </div>
                <CandidateTabs candidates={group.candidates} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
