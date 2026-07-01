import {
  DirectFastPathScheduler,
  ModelGenerateOperator,
  PanelGenerateOperator,
  PairRankOperator,
  GenFuserOperator,
  RankFuseScheduler,
  SelectOperator,
  createRuntimeReplayRecord,
  createTaskArtifact,
  graph,
  refs
} from "@fusionkit/ensemble";
import type { CandidateArtifactValue } from "@fusionkit/ensemble";

import {
  demoBanner,
  detail,
  finale,
  ok,
  step
} from "@fusionkit/example-utils";

async function main(): Promise<void> {
  demoBanner("15");

  step("compose a degree-1 workflow: task artifact -> model.generate under DirectFastPathScheduler");
  const task = createTaskArtifact({
    id: "task",
    prompt: "Explain why runtime kernels are useful."
  });
  const direct = graph("demo-direct")
    .task(task)
    .node(
      "model",
      new ModelGenerateOperator({
        id: "model",
        model: "demo-direct-model",
        client: {
          generate: ({ prompt }) => ({
            model: "demo-direct-model",
            content: `Direct answer for: ${prompt}`
          })
        }
      }),
      { inputs: [refs.artifact(task.id)] }
    )
    .scheduler(new DirectFastPathScheduler())
    .compile();
  const directResult = await direct.run({ runId: "runtime-kernel-direct" });
  ok(`direct final artifact: ${directResult.finalArtifacts[0]?.type}`);
  detail(`trace events: ${directResult.trace.length}`);

  step("compose a rank/fuse workflow: panel.generate -> rank -> select -> fuse");
  const rankFuse = graph("demo-rank-fuse")
    .task(task)
    .node(
      "panel",
      new PanelGenerateOperator({
        id: "panel",
        models: [
          { id: "brief", model: "demo-brief" },
          { id: "complete", model: "demo-complete" }
        ],
        runner: () => [
          { candidateId: "brief", modelId: "brief", model: "demo-brief", content: "A kernel runs graphs." },
          {
            candidateId: "complete",
            modelId: "complete",
            model: "demo-complete",
            content: "A runtime kernel executes typed operator graphs under explicit schedulers."
          }
        ]
      }),
      { inputs: [refs.artifact(task.id)] }
    )
    .node(
      "rank",
      new PairRankOperator({
        id: "rank",
        rank: ({ candidates }) => ({
          rankings: candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            score: candidate.candidateId === "complete" ? 1 : 0.4,
            reason: candidate.candidateId === "complete" ? "mentions typed graphs and schedulers" : "too terse"
          }))
        })
      }),
      { inputs: [refs.artifact(task.id), refs.node("panel", "candidate")] }
    )
    .node(
      "select",
      new SelectOperator({ id: "select" }),
      { inputs: [refs.artifact(task.id), refs.node("panel", "candidate"), refs.node("rank", "rank_matrix")] }
    )
    .node(
      "fuse",
      new GenFuserOperator({
        id: "fuse",
        fuse: ({ selected }) => ({
          content: selected?.candidate.content ?? "no selected candidate",
          selectedCandidateId: selected?.candidate.candidateId,
          rationale: selected?.reason
        })
      }),
      {
        inputs: [
          refs.artifact(task.id),
          refs.node("panel", "candidate"),
          refs.node("rank", "rank_matrix"),
          refs.node("select", "selected_candidate")
        ]
      }
    )
    .scheduler(new RankFuseScheduler())
    .compile();
  const rankFuseResult = await rankFuse.run({ runId: "runtime-kernel-rank-fuse" });
  const final = rankFuseResult.finalArtifacts[0]?.value as { content?: string; selectedCandidateId?: string };
  ok(`rank/fuse selected ${final.selectedCandidateId}: ${final.content ?? ""}`);

  step("export a replayable runtime record for future learned schedulers");
  const replay = createRuntimeReplayRecord(rankFuseResult);
  detail(`replay schema: ${replay.schema}`);
  detail(`outcome scheduler: ${replay.outcome.schedulerFamily}`);

  const candidates = rankFuseResult.artifacts
    .filter((artifact) => artifact.type === "candidate")
    .map((artifact) => artifact.value as CandidateArtifactValue)
    .map((candidate) => `${candidate.candidateId}:${candidate.model}`);
  detail(`candidates: ${candidates.join(", ")}`);

  finale("runtime-kernel workflows compose explicit graphs, schedulers, budgets, traces, and outcomes");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
