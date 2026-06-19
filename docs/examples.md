# Examples

The demo suite is the fastest way to understand how the packages fit together.
It is driven by `examples/manifest.json` and shared helpers in
`packages/example-utils`.

## Running demos

```sh
pnpm build
pnpm demo        # list demos
pnpm demo 01     # run a specific demo
```

Some demos are interactive or require local services, Docker, live model keys, or
Apple Silicon MLX. The manifest labels interactive demos and the root README
documents live-model environment variables.

## Core demo path

| ID | Directory | Shows |
| --- | --- | --- |
| `01` | `examples/governed-run` | Basic governed run and receipt story. |
| `02` | `examples/dry-run` | What would move before a run is submitted. |
| `03` | `examples/offline-verify` | Verifying a receipt without trusting the online plane. |
| `04` | `examples/egress-policy` | Deny-by-default network egress policy. |
| `05` | `examples/consent-secrets` | Approval-gated secret disclosure and receipt evidence. |
| `06` | `examples/handoff` | Continue local work on a governed runner and pull results. |
| `07` | `examples/parallel-fanout` | Isolated parallel attempts and deterministic review. |
| `08` | `examples/control-panel` | Plane UI with seeded success, failure, cancellation, approval, and continuation runs. |
| `09` | `examples/ai-sdk-loop` | App-owned AI SDK loop with governed remote tools. |
| `10` | `examples/compute-sandbox` | ComputeSDK-shaped sandbox backed by governed sessions. |
| `11` | `examples/golden-interface` | Combined tools, checkpoint, continuation, compute, and summary API. |
| `12` | `examples/model-escalation` | Local-to-cloud model routing and escalation traces. |
| `13` | `examples/hermetic-session` | just-bash hermetic session backend. |
| `14` | `examples/swarm` | Cloud orchestrator dispatching governed local swarm workers. |

## Infrastructure demos

- `examples/bench` checks performance budgets from the spec with `pnpm bench`.
- `examples/microvm-isolation-bench` measures the Vercel Sandbox microVM path
  with `pnpm microvm:bench` when integration-gated environment variables are set.
- `examples/mlx` exercises managed MLX local serving with `pnpm mlx` and
  `pnpm mlx:stress` on supported machines.
- `examples/seed` provides showcase data for Docker compose and the control
  panel demo.

## Adding a demo

1. Create `examples/<name>` with its own `package.json`, `tsconfig.json`, and
   source/test files following adjacent demos.
2. Add the scenario to `examples/manifest.json` so `pnpm demo`, tests, and demo
   narration can discover it.
3. Reuse `@fusionkit/example-utils` for banners, manifests, and live-model config.
4. Run `pnpm check`, `pnpm build`, and the relevant demo/test command.
