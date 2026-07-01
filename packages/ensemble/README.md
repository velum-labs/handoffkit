# @fusionkit/ensemble

`@fusionkit/ensemble` contains two layers:

- the legacy harness runner (`runEnsemble`) used by existing FusionKit harness flows;
- the FusionKit runtime kernel (`FusionRuntime`) for typed operator graphs under schedulers.

## Runtime kernel quick start

```ts
import {
  DirectFastPathScheduler,
  ModelGenerateOperator,
  createTaskArtifact,
  graph,
  refs
} from "@fusionkit/ensemble";

const task = createTaskArtifact({ id: "task", prompt: "Explain model fusion." });

const workflow = graph("direct")
  .task(task)
  .node(
    "model",
    new ModelGenerateOperator({
      model: "local",
      client: {
        generate: () => ({ model: "local", content: "Fusion combines model outputs under explicit policies." })
      }
    }),
    { inputs: [refs.artifact(task.id)] }
  )
  .scheduler(new DirectFastPathScheduler())
  .compile();

const result = await workflow.run();
```

## Built-in workflows

Register and inspect the built-in graph recipes:

```ts
import { listWorkflows, registerBuiltInWorkflows } from "@fusionkit/ensemble";

registerBuiltInWorkflows();
console.log(listWorkflows());
```

Built-ins:

- `direct`
- `panel-capture`
- `panel-judge-synth`
- `rank-fuse`
- `execution-select-repair`

## Subpath imports

For focused imports:

```ts
import { FusionRuntime } from "@fusionkit/ensemble/runtime";
import { graph } from "@fusionkit/ensemble/kernel";
import { RankFuseScheduler } from "@fusionkit/ensemble/schedulers";
import { EvidenceSourceOperator } from "@fusionkit/ensemble/operators/evidence";
```

## Runtime guarantees

- Artifacts are immutable and typed.
- Operators declare side effects and input/output artifact contracts.
- Schedulers choose execution order; operators do not choose global control flow.
- Private/contaminated evidence is recorded in outcomes but hidden from scheduler-visible state.
- Outcome and replay records are emitted for future learned coordination.

## More docs

- `docs/fusion/runtime-kernel.md` — full architecture and API guide.
- `docs/fusion/runtime-recipes.md` — copy-paste workflow recipes.
- `docs/fusion/MOA_IMPLEMENTATION_STATUS.md` — implementation status against the design.
- `pnpm demo 15` — runnable runtime-kernel demo.
