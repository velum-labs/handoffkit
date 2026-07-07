"use client";

import { useState } from "react";
import { AlertTriangle, GitBranch, Wrench } from "lucide-react";

import { CodeBlock } from "@/components/scope/code-block";
import { FieldList } from "@/components/scope/field-list";
import { JsonView } from "@/components/scope/json-view";
import { CollapsibleRow, Fold } from "@/components/scope/section";
import { StatusBadge } from "@/components/scope/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { fmtNumber, statusColor, stepColor } from "@/lib/format";
import { tokensOf } from "@/lib/rollups";
import type {
  CandidateView,
  JudgeStepView,
  JudgeView,
  ModelCallView,
  TrajectoryStepView
} from "@/lib/sessions";

const STEP_PREVIEW_COUNT = 10;

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

function usageTokens(usage: Record<string, unknown> | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const total = tokensOf(usage);
  return total > 0 ? `${fmtNumber(total)} tok` : undefined;
}

// ---- grouping ----

type TurnGroup = {
  turn?: number;
  candidates: CandidateView[];
  judgeSteps: JudgeStepView[];
  gatewayCalls: ModelCallView[];
};

/**
 * Fold candidates, judge steps, and un-candidated (gateway/judge) model calls
 * into per-user-turn groups. Items without a turn share a single trailing
 * group only when the session actually has multiple turns.
 */
function groupByTurn(
  candidates: CandidateView[],
  judgeSteps: JudgeStepView[],
  gatewayCalls: ModelCallView[]
): TurnGroup[] {
  const turns = new Set<number>();
  for (const candidate of candidates) if (candidate.turn !== undefined) turns.add(candidate.turn);
  for (const step of judgeSteps) if (step.turn !== undefined) turns.add(step.turn);
  for (const call of gatewayCalls) if (call.turn !== undefined) turns.add(call.turn);

  if (turns.size <= 1) {
    return [
      {
        turn: turns.size === 1 ? [...turns][0] : undefined,
        candidates,
        judgeSteps,
        gatewayCalls
      }
    ];
  }

  const groups = new Map<number | undefined, TurnGroup>();
  const ensure = (turn: number | undefined): TurnGroup => {
    let group = groups.get(turn);
    if (group === undefined) {
      group = { turn, candidates: [], judgeSteps: [], gatewayCalls: [] };
      groups.set(turn, group);
    }
    return group;
  };
  for (const candidate of candidates) ensure(candidate.turn).candidates.push(candidate);
  for (const step of judgeSteps) ensure(step.turn).judgeSteps.push(step);
  for (const call of gatewayCalls) ensure(call.turn).gatewayCalls.push(call);

  return [...groups.values()].sort((a, b) => {
    if (a.turn === undefined) return 1;
    if (b.turn === undefined) return -1;
    return a.turn - b.turn;
  });
}

// ---- candidate rows ----

function StepRow({ step, isLast }: { step: TrajectoryStepView; isLast: boolean }) {
  const color = stepColor(step.type);
  return (
    <div className="relative pl-5">
      <span className="absolute top-1.5 left-0 size-2 rounded-full" style={{ background: color }} />
      {isLast ? null : <span className="bg-border absolute top-3.5 bottom-0 left-[3.5px] w-px" />}
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
        <pre className="text-muted-foreground mono pb-3 text-xs leading-relaxed whitespace-pre-wrap">
          {step.text}
        </pre>
      ) : null}
      {step.tool_input ? (
        <pre className="bg-muted/40 mono mb-3 rounded-md p-2 text-xs leading-relaxed whitespace-pre-wrap">
          {step.tool_input}
        </pre>
      ) : null}
    </div>
  );
}

function TrajectorySteps({ steps }: { steps: TrajectoryStepView[] }) {
  const [showAll, setShowAll] = useState(false);
  if (steps.length === 0) {
    return <p className="text-muted-foreground text-sm">No trajectory steps captured yet.</p>;
  }
  const visible = showAll ? steps : steps.slice(0, STEP_PREVIEW_COUNT);
  return (
    <div>
      {visible.map((step, index) => (
        <StepRow
          key={`${step.index}-${index}`}
          step={step}
          isLast={index === visible.length - 1 && (showAll || steps.length <= STEP_PREVIEW_COUNT)}
        />
      ))}
      {steps.length > STEP_PREVIEW_COUNT && !showAll ? (
        <Button variant="ghost" size="xs" className="mt-1" onClick={() => setShowAll(true)}>
          Show all {steps.length} steps
        </Button>
      ) : null}
    </div>
  );
}

function CallTable({ calls }: { calls: ModelCallView[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[110px]">Status</TableHead>
          <TableHead>Model</TableHead>
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
            <TableCell className="mono text-right text-sm">
              {typeof call.latencyS === "number" ? `${call.latencyS.toFixed(2)}s` : "—"}
            </TableCell>
            <TableCell className="mono text-right text-sm">
              {call.usage !== undefined ? fmtNumber(tokensOf(call.usage)) : "—"}
            </TableCell>
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
  );
}

function CandidateRow({ candidate, calls }: { candidate: CandidateView; calls: ModelCallView[] }) {
  const lastCall = calls.length > 0 ? calls[calls.length - 1] : undefined;
  const tokens = usageTokens(candidate.usage ?? lastCall?.usage);
  const finalOutput = candidate.finalOutput ?? candidate.finalOutputPreview ?? lastCall?.contentPreview;

  return (
    <CollapsibleRow
      header={
        <>
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ background: statusColor(candidate.status) }}
          />
          <span className="truncate text-sm font-medium">
            {candidate.modelId ?? candidate.candidateId}
          </span>
          {candidate.model !== undefined && candidate.model !== candidate.modelId ? (
            <span className="mono text-muted-foreground truncate text-xs">{candidate.model}</span>
          ) : null}
          {candidate.branchName ? (
            <Badge variant="outline" className="hidden gap-1 font-normal sm:inline-flex">
              <GitBranch className="size-3" /> {candidate.branchName}
            </Badge>
          ) : null}
        </>
      }
      meta={
        <>
          {typeof lastCall?.latencyS === "number" ? (
            <span className="mono">{lastCall.latencyS.toFixed(2)}s</span>
          ) : null}
          {tokens !== undefined ? <span className="mono">{tokens}</span> : null}
          {typeof candidate.toolCallCount === "number" ? (
            <span>{candidate.toolCallCount} tools</span>
          ) : null}
          {candidate.finishReason ? <span>{candidate.finishReason}</span> : null}
        </>
      }
    >
      <FieldList
        fields={[
          { label: "Candidate", value: candidate.candidateId, mono: true },
          { label: "Model", value: candidate.model ?? candidate.modelId, mono: true },
          { label: "Status", value: candidate.status },
          { label: "Branch", value: candidate.branchName, mono: true },
          { label: "Worktree", value: candidate.worktreePath, mono: true },
          { label: "Verification", value: candidate.verificationStatus },
          { label: "Finish reason", value: candidate.finishReason },
          {
            label: "Tool calls",
            value: typeof candidate.toolCallCount === "number" ? String(candidate.toolCallCount) : undefined
          },
          {
            label: "Latency",
            value: typeof lastCall?.latencyS === "number" ? `${lastCall.latencyS.toFixed(2)}s` : undefined,
            mono: true
          },
          { label: "Tokens", value: tokens, mono: true },
          {
            label: "Error",
            value: lastCall?.error ? (
              <span className="text-destructive">{lastCall.error}</span>
            ) : undefined
          }
        ]}
      />

      {candidate.systemPrompt ? (
        <Fold label="System prompt">
          <CodeBlock value={candidate.systemPrompt} muted className="p-2" viewportClassName="max-h-[300px]" />
        </Fold>
      ) : null}
      {candidate.prompt ? (
        <Fold label="Task prompt">
          <CodeBlock value={candidate.prompt} muted className="p-2" viewportClassName="max-h-[300px]" />
        </Fold>
      ) : null}

      <div>
        <div className="text-muted-foreground mb-2 text-xs">
          Trajectory{candidate.steps.length > 0 ? ` (${candidate.steps.length} steps)` : ""}
        </div>
        <TrajectorySteps steps={candidate.steps} />
      </div>

      {calls.length > 1 ? (
        <Fold label="Model calls" count={`(${calls.length})`}>
          <CallTable calls={calls} />
        </Fold>
      ) : null}

      {finalOutput ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Final output</div>
          <CodeBlock value={finalOutput} muted className="p-3" viewportClassName="max-h-[300px]" />
        </div>
      ) : null}
    </CollapsibleRow>
  );
}

// ---- judge rows ----

function AnalysisSections({ analysis }: { analysis: Record<string, unknown> | undefined }) {
  const sections = ANALYSIS_SECTIONS.map((section) => ({
    ...section,
    items: strList(analysis?.[section.key])
  })).filter((section) => section.items.length > 0);

  if (sections.length === 0) return null;
  return (
    <div className="space-y-3">
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

/** Terminal judge detail: decision, rationale, ranks, analysis, synthesis. */
function JudgeDecision({ judge }: { judge: JudgeView }) {
  const ranks = ranksOf(judge.scored?.metrics);
  return (
    <>
      <FieldList
        fields={[
          {
            label: "Decision",
            value: judge.final?.decision ? (
              <span className="capitalize">{judge.final.decision.replace(/_/g, " ")}</span>
            ) : undefined
          },
          { label: "Selected candidate", value: judge.final?.selectedCandidateId, mono: true },
          {
            label: "Synthesis fallback",
            value: judge.synthesis?.empty === true ? (
              <span className="text-destructive">empty — fell back to best candidate</span>
            ) : undefined
          }
        ]}
      />
      {judge.final?.rationale ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Rationale</div>
          <p className="text-sm leading-relaxed">{judge.final.rationale}</p>
        </div>
      ) : null}
      {ranks.length > 0 ? (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Candidate ranks</div>
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
        </div>
      ) : null}
      <AnalysisSections analysis={judge.scored?.analysis} />
      {judge.synthesis?.raw ? (
        <Fold label="Synthesis reasoning">
          <CodeBlock value={judge.synthesis.raw} viewportClassName="max-h-[400px]" />
        </Fold>
      ) : null}
      {judge.scored !== undefined || judge.final?.record !== undefined ? (
        <Fold label="Details">
          <FieldList
            fields={[
              { label: "Fusion unit", value: judge.scored?.fusionUnit, mono: true },
              {
                label: "Input trajectories",
                value:
                  judge.scored?.inputIds !== undefined ? judge.scored.inputIds.join(", ") : undefined,
                mono: true
              }
            ]}
          />
          {judge.scored?.metrics !== undefined ? (
            <div className="mt-2">
              <div className="text-muted-foreground mb-1 text-xs">Metrics</div>
              <JsonView data={judge.scored.metrics} maxHeight="240px" />
            </div>
          ) : null}
          {judge.final?.record !== undefined ? (
            <div className="mt-2">
              <div className="text-muted-foreground mb-1 text-xs">Fusion record</div>
              <JsonView data={judge.final.record} maxHeight="240px" />
            </div>
          ) : null}
        </Fold>
      ) : null}
    </>
  );
}

function JudgeStepRow({
  step,
  judge,
  isTerminal
}: {
  step: JudgeStepView;
  /** Session-level judge view; its decision detail renders on the terminal step. */
  judge: JudgeView;
  isTerminal: boolean;
}) {
  const output = step.final?.finalOutput ?? step.final?.content ?? step.thinking?.raw;
  const tokens = usageTokens(step.final?.usage ?? step.thinking?.usage);
  const trajectoryCount = step.prompt?.trajectoryIds?.length ?? 0;
  return (
    <CollapsibleRow
      header={
        <>
          <span
            className="size-2 shrink-0 rounded-full"
            style={{
              background:
                step.kind === "final"
                  ? statusColor("succeeded")
                  : step.kind === "pending"
                    ? statusColor("running")
                    : "var(--muted-foreground)"
            }}
          />
          <span className="text-sm font-medium capitalize">{step.kind}</span>
          {step.final?.decision ? (
            <Badge variant="outline" className="font-normal capitalize">
              {step.final.decision.replace(/_/g, " ")}
            </Badge>
          ) : null}
          {trajectoryCount > 0 ? (
            <span className="text-muted-foreground text-xs">{trajectoryCount} trajectories</span>
          ) : null}
        </>
      }
      meta={tokens !== undefined ? <span className="mono">{tokens}</span> : undefined}
    >
      {output ? (
        <CodeBlock value={output} viewportClassName="max-h-[320px]" />
      ) : (
        <p className="text-muted-foreground text-sm">No output captured for this step.</p>
      )}
      {step.thinking?.toolCalls !== undefined ? (
        <Fold label="Tool calls">
          <JsonView data={step.thinking.toolCalls} maxHeight="240px" />
        </Fold>
      ) : null}
      {step.prompt?.messages !== undefined ? (
        <Fold label="Prompt messages">
          <JsonView data={step.prompt.messages} maxHeight="300px" />
        </Fold>
      ) : null}
      {step.prompt?.trajectories !== undefined ? (
        <Fold label="Candidate trajectories sent to the judge">
          <JsonView data={step.prompt.trajectories} maxHeight="300px" />
        </Fold>
      ) : null}
      {step.prompt?.tools !== undefined ? (
        <Fold label="Tools offered">
          <JsonView data={step.prompt.tools} maxHeight="240px" />
        </Fold>
      ) : null}
      {isTerminal ? <JudgeDecision judge={judge} /> : null}
    </CollapsibleRow>
  );
}

// ---- the flow ----

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
      {children}
    </div>
  );
}

/**
 * The chronological run flow: for each user turn, the panel candidates that
 * ran, then the judge steps that fused them. Absorbs the old candidate
 * trajectories, model calls, and tabbed judge views.
 */
export function RunFlow({
  candidates,
  judgeSteps,
  judge,
  modelCalls
}: {
  candidates: CandidateView[];
  judgeSteps: JudgeStepView[];
  judge: JudgeView;
  modelCalls: ModelCallView[];
}) {
  const callsByCandidate = new Map<string, ModelCallView[]>();
  const gatewayCalls: ModelCallView[] = [];
  for (const call of modelCalls) {
    if (call.candidateId === undefined) {
      gatewayCalls.push(call);
      continue;
    }
    const list = callsByCandidate.get(call.candidateId) ?? [];
    list.push(call);
    callsByCandidate.set(call.candidateId, list);
  }

  const groups = groupByTurn(candidates, judgeSteps, gatewayCalls);
  const lastFinalStep = [...judgeSteps].reverse().find((step) => step.kind === "final");

  if (candidates.length === 0 && judgeSteps.length === 0 && modelCalls.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing has started yet.</p>;
  }

  return (
    <div className="space-y-6">
      {groups.map((group, index) => (
        <div key={group.turn ?? `group-${index}`} className="space-y-3">
          {groups.length > 1 ? (
            <div className="text-sm font-semibold">
              {group.turn !== undefined ? `Turn ${group.turn}` : "Unattributed"}
            </div>
          ) : null}

          {group.candidates.length > 0 ? (
            <div className="space-y-1">
              <GroupLabel>Candidates ({group.candidates.length})</GroupLabel>
              <div className="divide-border/60 divide-y">
                {group.candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.candidateId}
                    candidate={candidate}
                    calls={callsByCandidate.get(candidate.candidateId) ?? []}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {group.judgeSteps.length > 0 || group.gatewayCalls.length > 0 ? (
            <div className="space-y-1">
              <GroupLabel>
                Judge{group.judgeSteps.length > 1 ? ` (${group.judgeSteps.length} steps)` : ""}
              </GroupLabel>
              <div className="divide-border/60 divide-y">
                {group.judgeSteps.map((step) => (
                  <JudgeStepRow
                    key={step.spanId}
                    step={step}
                    judge={judge}
                    isTerminal={lastFinalStep !== undefined && step.spanId === lastFinalStep.spanId}
                  />
                ))}
              </div>
              {group.gatewayCalls.length > 0 ? (
                <Fold label="Gateway model calls" count={`(${group.gatewayCalls.length})`}>
                  <CallTable calls={group.gatewayCalls} />
                </Fold>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}

      {judgeSteps.length === 0 && (judge.thinking !== undefined || judge.final !== undefined) ? (
        // Older traces without per-step judge spans: still show the decision.
        <div className="space-y-3">
          <GroupLabel>Judge</GroupLabel>
          {judge.thinking?.raw ? (
            <Fold label="Thinking" defaultOpen>
              <CodeBlock value={judge.thinking.raw} viewportClassName="max-h-[400px]" />
            </Fold>
          ) : null}
          <JudgeDecision judge={judge} />
        </div>
      ) : null}
    </div>
  );
}
