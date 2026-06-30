# fusion-trace contract

Standalone observability contract for the fusion stack. It is intentionally **not**
part of the frozen `model-fusion-contract` bundle, so adding or evolving trace events
never re-stamps the model-fusion bundle hash or forces a bump of the pinned
`@velum-labs/model-fusion-protocol` package.

## What it is

A single schema, [`fusion-trace-event.v1`](schema/fusion-trace-event.v1.schema.json),
describing one observability event. Every event carries a `trace_id`; all events sharing
a `trace_id` form one observable fusion **session**. `span_id` / `parent_span_id` let a
consumer reconstruct a waterfall of the work that happened.

## Event taxonomy

| component | event_type | meaning |
| --- | --- | --- |
| `gateway` / `cursor-bridge` | `session.started` | a front-door request opened a session (payload = environment snapshot) |
| `gateway` / `cursor-bridge` | `session.finished` | session terminal status + totals |
| `ensemble` | `harness.candidate.started` / `harness.candidate.finished` | one panel model's harness run |
| `agent` | `trajectory.step` | a reasoning / tool_call / observation / output step (streamed live) |
| `panel-model` | `model.call.started` / `model.call.finished` | a single model invocation (usage, latency, finish_reason) |
| `judge` | `judge.thinking` | the judge's raw analyze response |
| `judge` | `judge.scored` | structured analysis + per-candidate ranks/contributions |
| `judge` | `judge.synthesis` | the synthesizer's raw reasoning/output |
| `judge` | `judge.final` | final fused output + decision + rationale |
| `ensemble` | `tool.execution` | a tool-execution-record outcome |
| `cursor-bridge` | `cursor.route` | a Cursor bridge route decision |
| any | `log` | free-form structured log line |

## Trace propagation headers

Components forward trace context over HTTP using:

- `x-fusion-trace-id`
- `x-fusion-span-id`
- `x-fusion-parent-span-id`
- `x-fusion-candidate-id`

## Bindings

- TypeScript: [`ts/fusion-trace-event.ts`](ts/fusion-trace-event.ts)
- Python: `fusionkit_core.trace` (`FusionTraceEvent`, `TraceEmitter`)

Per-repo emitters embed a small copy of these types alongside a fire-and-forget emitter.
Emission is a no-op unless `FUSION_TRACE_URL` or `FUSION_TRACE_DIR` is set, so normal runs
are unaffected.
