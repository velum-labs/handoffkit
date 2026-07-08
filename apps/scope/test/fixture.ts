import { FUSION_SCOPES } from "../lib/generated/trace-conventions";
import type { IncomingEvent, IncomingSpan, StoredEvent, StoredSpan } from "../lib/types";

/**
 * A realistic synthetic session as spans + events: turn info, two candidates
 * (with live step events and a model call), cost events, the judge flow
 * (request -> thinking -> scored -> synthesis events), and the terminal judge
 * span. Mirrors what one fused turn through the gateway actually emits, with
 * unit spans on the traces signal and fusion events on the logs signal.
 */

const BASE_TS = 1_750_000_000_000;

type SpanInput = {
  name: string;
  component: string;
  spanId: string;
  parentSpanId?: string;
  /** Offsets from the session base, in ms. */
  start: number;
  end: number;
  status?: "ok" | "error";
  attributes?: Record<string, unknown>;
};

type EventInput = {
  name: string;
  component: string;
  /** The owning unit span. */
  spanId: string;
  /** Offset from the session base, in ms. */
  ts: number;
  attributes?: Record<string, unknown>;
};

export type SyntheticSession = {
  spans: IncomingSpan[];
  events: IncomingEvent[];
};

let uniq = 0;

export function syntheticSession(traceId = "1111111111111111111111111111aaaa"): SyntheticSession {
  uniq += 1;
  // Deterministic, label-distinct 16-hex span ids (labels hex-encode first).
  const sid = (label: string): string =>
    (Buffer.from(label).toString("hex") + String(uniq).padStart(4, "0")).padEnd(16, "0").slice(0, 16);
  const environment = {
    repo: "/tmp/fusion-sample",
    fusion_backend_url: "http://127.0.0.1:8080",
    harnesses: ["agent"],
    judge_model: "gpt-5.5",
    models: [
      { id: "gpt", model: "gpt-5.5", provider: "openai" },
      { id: "opus", model: "claude-opus-4-6", provider: "anthropic" }
    ],
    model_endpoints: { gpt: "http://127.0.0.1:8081", opus: "http://127.0.0.1:8082" }
  };

  const events: EventInput[] = [
    {
      name: "fusion.turn.info",
      component: "gateway",
      spanId: sid("00"),
      ts: 0,
      attributes: {
        "fusion.dialect": "codex",
        "fusion.turn": 1,
        "fusion.prompt_preview": "Fix the add() sign bug so npm test passes.",
        "fusion.repo": "/tmp/fusion-sample",
        "fusion.environment": JSON.stringify(environment)
      }
    },
    // Candidate gpt: started event, steps, a model-call start event.
    {
      name: "fusion.candidate.started",
      component: "panel-model",
      spanId: sid("c1"),
      ts: 40,
      attributes: {
        "fusion.candidate.id": "cand_gpt",
        "fusion.model.id": "gpt",
        "gen_ai.request.model": "gpt-5.5",
        "fusion.turn": 1,
        "fusion.branch_name": "fusion/cand-gpt",
        "fusion.worktree_path": "/tmp/worktrees/cand-gpt"
      }
    },
    {
      name: "fusion.model_call.started",
      component: "panel-model",
      spanId: sid("d1"),
      ts: 60,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "fusion.candidate.id": "cand_gpt",
        "fusion.model.id": "gpt",
        "fusion.turn": 1,
        "fusion.system_prompt": "You are a coding agent working in a real repository checkout.",
        "fusion.prompt": "Fix the add() sign bug so npm test passes.",
        "fusion.tool_count": 5
      }
    },
    {
      name: "fusion.candidate.step",
      component: "panel-model",
      spanId: sid("c1"),
      ts: 80,
      attributes: {
        "fusion.candidate.id": "cand_gpt",
        "fusion.model.id": "gpt",
        "fusion.turn": 1,
        "fusion.step.index": 0,
        "fusion.step.type": "reasoning",
        "fusion.step": JSON.stringify({ index: 0, type: "reasoning", text: "The regression test asserts add(2,3)=5." })
      }
    },
    {
      name: "fusion.candidate.step",
      component: "panel-model",
      spanId: sid("c1"),
      ts: 120,
      attributes: {
        "fusion.candidate.id": "cand_gpt",
        "fusion.model.id": "gpt",
        "fusion.turn": 1,
        "fusion.step.index": 1,
        "fusion.step.type": "tool_call",
        "fusion.step": JSON.stringify({
          index: 1,
          type: "tool_call",
          tool_name: "apply_patch",
          tool_input: "*** Update File: calculator.js"
        })
      }
    },
    {
      name: "fusion.candidate.step",
      component: "panel-model",
      spanId: sid("c1"),
      ts: 200,
      attributes: {
        "fusion.candidate.id": "cand_gpt",
        "fusion.model.id": "gpt",
        "fusion.turn": 1,
        "fusion.step.index": 2,
        "fusion.step.type": "output",
        "fusion.step": JSON.stringify({ index: 2, type: "output", text: "Changed `l - r` to `l + r`; tests pass." })
      }
    },
    // Candidate opus: started + two steps.
    {
      name: "fusion.candidate.started",
      component: "panel-model",
      spanId: sid("c2"),
      ts: 45,
      attributes: {
        "fusion.candidate.id": "cand_opus",
        "fusion.model.id": "opus",
        "gen_ai.request.model": "claude-opus-4-6",
        "fusion.turn": 1,
        "fusion.branch_name": "fusion/cand-opus"
      }
    },
    {
      name: "fusion.candidate.step",
      component: "panel-model",
      spanId: sid("c2"),
      ts: 150,
      attributes: {
        "fusion.candidate.id": "cand_opus",
        "fusion.model.id": "opus",
        "fusion.turn": 1,
        "fusion.step.index": 0,
        "fusion.step.type": "reasoning",
        "fusion.step": JSON.stringify({ index: 0, type: "reasoning", text: "The subtraction is a typo." })
      }
    },
    {
      name: "fusion.candidate.step",
      component: "panel-model",
      spanId: sid("c2"),
      ts: 260,
      attributes: {
        "fusion.candidate.id": "cand_opus",
        "fusion.model.id": "opus",
        "fusion.turn": 1,
        "fusion.step.index": 1,
        "fusion.step.type": "output",
        "fusion.step": JSON.stringify({ index: 1, type: "output", text: "Patched calculator.js." })
      }
    },
    // Cost events: two panel entries + one judge entry.
    {
      name: "fusion.cost",
      component: "gateway",
      spanId: sid("00"),
      ts: 430,
      attributes: {
        "fusion.session_id": "session_1",
        "fusion.turn": 1,
        "fusion.cost.stage": "panel",
        "fusion.cost.model": "gpt-5.5",
        "gen_ai.usage.input_tokens": 800,
        "gen_ai.usage.output_tokens": 120,
        "fusion.usage": JSON.stringify({ promptTokens: 800, completionTokens: 120, totalTokens: 920 }),
        "fusion.cost.turn_usd": 0.0056,
        "fusion.cost.session_total_usd": 0.0056,
        "fusion.cost.unknown": false
      }
    },
    {
      name: "fusion.cost",
      component: "gateway",
      spanId: sid("00"),
      ts: 510,
      attributes: {
        "fusion.session_id": "session_1",
        "fusion.turn": 1,
        "fusion.cost.stage": "panel",
        "fusion.cost.model": "claude-opus-4-6",
        "gen_ai.usage.input_tokens": 700,
        "gen_ai.usage.output_tokens": 90,
        "fusion.usage": JSON.stringify({ promptTokens: 700, completionTokens: 90, totalTokens: 790 }),
        "fusion.cost.turn_usd": 0.0033,
        "fusion.cost.session_total_usd": 0.0089,
        "fusion.cost.unknown": false
      }
    },
    // The judge phase: request under the judge span, thinking/scored/synthesis
    // under the Python fuse span.
    {
      name: "fusion.judge.request",
      component: "judge",
      spanId: sid("j1"),
      ts: 520,
      attributes: {
        "fusion.judge.model": "gpt-5.5",
        "fusion.turn": 1,
        "fusion.messages": JSON.stringify([{ role: "user", content: "Fix the add() sign bug so npm test passes." }]),
        "fusion.trajectories": JSON.stringify([
          { trajectory_id: "cand_gpt", model_id: "gpt", status: "succeeded" },
          { trajectory_id: "cand_opus", model_id: "opus", status: "succeeded" }
        ]),
        "fusion.trajectory_ids": ["cand_gpt", "cand_opus"]
      }
    },
    {
      name: "fusion.judge.thinking",
      component: "judge",
      spanId: sid("g1"),
      ts: 600,
      attributes: {
        "fusion.fusion_unit": "trajectory",
        "fusion.raw_analysis": "Both candidates fixed the sign; gpt also ran the regression test.",
        "fusion.usage": JSON.stringify({ prompt_tokens: 1200, completion_tokens: 260, total_tokens: 1460 })
      }
    },
    {
      name: "fusion.judge.scored",
      component: "judge",
      spanId: sid("g1"),
      ts: 640,
      attributes: {
        "fusion.fusion_unit": "trajectory",
        "fusion.analysis": JSON.stringify({
          consensus: ["both fixed add"],
          contradictions: [],
          unique_insights: ["gpt verified with npm test"],
          coverage_gaps: [],
          likely_errors: []
        }),
        "fusion.metrics": JSON.stringify({ best_trajectory: "cand_gpt" }),
        "fusion.input_ids": ["cand_gpt", "cand_opus"],
        "fusion.usage": JSON.stringify({ total_tokens: 1460 })
      }
    },
    {
      name: "fusion.judge.synthesis",
      component: "judge",
      spanId: sid("g1"),
      ts: 800,
      attributes: {
        "fusion.raw_output": "Change `exports.add = (l, r) => l - r` to use `left + right`.",
        "fusion.synthesis_empty": false,
        "fusion.usage": JSON.stringify({ prompt_tokens: 1800, completion_tokens: 560, total_tokens: 2360 })
      }
    },
    {
      name: "fusion.cost",
      component: "gateway",
      spanId: sid("00"),
      ts: 905,
      attributes: {
        "fusion.session_id": "session_1",
        "fusion.turn": 1,
        "fusion.cost.stage": "judge_synth",
        "fusion.cost.model": "gpt-5.5",
        "gen_ai.usage.input_tokens": 1800,
        "gen_ai.usage.output_tokens": 560,
        "fusion.usage": JSON.stringify({ promptTokens: 1800, completionTokens: 560, totalTokens: 2360 }),
        "fusion.cost.turn_usd": 0.0104,
        "fusion.cost.session_total_usd": 0.0193,
        "fusion.cost.unknown": false
      }
    },
    // Narration beats mirrored by the gateway narrator.
    {
      name: "fusion.narration",
      component: "gateway",
      spanId: sid("00"),
      ts: 50,
      attributes: {
        "fusion.turn": 1,
        "fusion.headline": "Fanning out to 2 models",
        "fusion.prose": "gpt-5.5 and claude-opus-4-6 are each taking a shot in isolated worktrees."
      }
    },
    {
      name: "fusion.narration",
      component: "gateway",
      spanId: sid("00"),
      ts: 530,
      attributes: {
        "fusion.turn": 1,
        "fusion.headline": "Judging 2 candidates"
      }
    }
  ];

  const spans: SpanInput[] = [
    {
      name: "chat gpt-5.5",
      component: "panel-model",
      spanId: sid("d1"),
      parentSpanId: sid("c1"),
      start: 55,
      end: 405,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.5",
        "gen_ai.usage.input_tokens": 800,
        "gen_ai.usage.output_tokens": 120,
        "gen_ai.response.finish_reasons": ["stop"],
        "fusion.candidate.id": "cand_gpt",
        "fusion.model.id": "gpt",
        "fusion.turn": 1,
        "fusion.finish_reason": "stop",
        "fusion.final_output": "Fixed add() to use left + right.",
        "fusion.content": "Fixed add() to use left + right.",
        "fusion.usage": JSON.stringify({ prompt_tokens: 800, completion_tokens: 120, total_tokens: 920, latency_s: 0.35 })
      }
    },
    {
      name: "fusion.candidate",
      component: "panel-model",
      spanId: sid("c1"),
      parentSpanId: sid("00"),
      start: 40,
      end: 420,
      attributes: {
        "fusion.candidate.id": "cand_gpt",
        "fusion.model.id": "gpt",
        "gen_ai.request.model": "gpt-5.5",
        "fusion.turn": 1,
        "fusion.status": "succeeded",
        "fusion.step_count": 3,
        "fusion.tool_call_count": 2,
        "fusion.finish_reason": "stop",
        "fusion.verification_status": "passed",
        "fusion.final_output_preview": "Fixed add() to use left + right."
      }
    },
    {
      name: "fusion.candidate",
      component: "panel-model",
      spanId: sid("c2"),
      parentSpanId: sid("00"),
      start: 45,
      end: 500,
      attributes: {
        "fusion.candidate.id": "cand_opus",
        "fusion.model.id": "opus",
        "gen_ai.request.model": "claude-opus-4-6",
        "fusion.turn": 1,
        "fusion.status": "succeeded",
        "fusion.step_count": 2,
        "fusion.tool_call_count": 2,
        "fusion.verification_status": "passed"
      }
    },
    // The Python fuse span (server-side), child of the gateway judge span.
    {
      name: "fusion.fuse",
      component: "synthesis",
      spanId: sid("g1"),
      parentSpanId: sid("j1"),
      start: 540,
      end: 880,
      attributes: {
        "fusion.judge.model": "gpt-5.5",
        "fusion.synthesizer.model": "gpt-5.5",
        "fusion.fusion_unit": "trajectory",
        "fusion.terminal": true,
        "fusion.decision": "synthesize",
        "fusion.final_output": "Change add() to use left + right; both candidates agree and tests pass.",
        "fusion.synthesis_empty": false
      }
    },
    // The gateway judge span, terminal for the turn.
    {
      name: "fusion.judge",
      component: "judge",
      spanId: sid("j1"),
      parentSpanId: sid("00"),
      start: 520,
      end: 900,
      attributes: {
        "fusion.turn": 1,
        "fusion.judge.model": "gpt-5.5",
        "fusion.decision": "synthesize",
        "fusion.rationale": "gpt's patch is verified; opus agrees on the fix.",
        "fusion.final_output": "Change add() to use left + right; both candidates agree and tests pass.",
        "fusion.synthesis": JSON.stringify({ decision: "synthesize", selected_trajectory_id: null }),
        "fusion.usage": JSON.stringify({ prompt_tokens: 1800, completion_tokens: 560, total_tokens: 2360 })
      }
    },
    // The bounded run wrapper (one-shot front-door runs end the session).
    {
      name: "fusion.run",
      component: "gateway",
      spanId: sid("00"),
      start: 0,
      end: 950,
      attributes: {
        "fusion.dialect": "codex",
        "fusion.prompt_preview": "Fix the add() sign bug so npm test passes.",
        "fusion.repo": "/tmp/fusion-sample",
        "fusion.environment": JSON.stringify(environment),
        "fusion.status": "succeeded",
        "fusion.final_output_preview": "Change add() to use left + right; both candidates agree and tests pass.",
        "fusion.evidence": JSON.stringify(["npm test passed on fused output"])
      }
    }
  ];

  return {
    spans: spans.map(
      (span): IncomingSpan => ({
        trace_id: traceId,
        span_id: span.spanId,
        ...(span.parentSpanId !== undefined ? { parent_span_id: span.parentSpanId } : {}),
        name: span.name,
        component: span.component,
        service: "scope-fixture",
        start_ms: BASE_TS + span.start,
        end_ms: BASE_TS + span.end,
        status: span.status ?? "ok",
        attributes: span.attributes ?? {}
      })
    ),
    events: events.map(
      (event): IncomingEvent => ({
        trace_id: traceId,
        span_id: event.spanId,
        name: event.name,
        component: event.component,
        service: "scope-fixture",
        ts_ms: BASE_TS + event.ts,
        attributes: event.attributes ?? {}
      })
    )
  };
}

/** Assign ids for pure-derivation tests (as the collector would). */
export function stored(spans: IncomingSpan[]): StoredSpan[] {
  return spans.map((span, index) => ({ ...span, id: index + 1 }));
}

/** Assign ids for pure-derivation tests (as the collector would). */
export function storedEvents(events: IncomingEvent[]): StoredEvent[] {
  return events.map((event, index) => ({ ...event, id: index + 1 }));
}

// ---- OTLP encoding (for API round-trip tests and seeding) ----

type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: number }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpAnyValue[] } };

function encodeValue(value: unknown): OtlpAnyValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { stringValue: JSON.stringify(value) };
}

function encodeAttributes(attributes: Record<string, unknown>): Array<{ key: string; value: OtlpAnyValue }> {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: encodeValue(value) }));
}

const COMPONENT_TO_SCOPE = FUSION_SCOPES as Record<string, string>;

/** Encode spans as a spec-shaped OTLP `ExportTraceServiceRequest` (JSON). */
export function toOtlpExport(spans: IncomingSpan[]): Record<string, unknown> {
  const byComponent = new Map<string, IncomingSpan[]>();
  for (const span of spans) {
    const list = byComponent.get(span.component) ?? [];
    list.push(span);
    byComponent.set(span.component, list);
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: spans[0]?.service ?? "scope-fixture" } }]
        },
        scopeSpans: [...byComponent.entries()].map(([component, componentSpans]) => ({
          scope: { name: COMPONENT_TO_SCOPE[component] ?? `fusionkit.${component}` },
          spans: componentSpans.map((span) => ({
            traceId: span.trace_id,
            spanId: span.span_id,
            ...(span.parent_span_id !== undefined ? { parentSpanId: span.parent_span_id } : {}),
            name: span.name,
            kind: 1,
            startTimeUnixNano: String(Math.round(span.start_ms * 1e6)),
            endTimeUnixNano: String(Math.round(span.end_ms * 1e6)),
            attributes: encodeAttributes(span.attributes),
            status: { code: span.status === "error" ? 2 : 1 }
          }))
        }))
      }
    ]
  };
}

/** Encode events as a spec-shaped OTLP `ExportLogsServiceRequest` (JSON). */
export function toOtlpLogsExport(events: IncomingEvent[]): Record<string, unknown> {
  const byComponent = new Map<string, IncomingEvent[]>();
  for (const event of events) {
    const list = byComponent.get(event.component) ?? [];
    list.push(event);
    byComponent.set(event.component, list);
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: events[0]?.service ?? "scope-fixture" } }]
        },
        scopeLogs: [...byComponent.entries()].map(([component, componentEvents]) => ({
          scope: { name: COMPONENT_TO_SCOPE[component] ?? `fusionkit.${component}` },
          logRecords: componentEvents.map((event) => ({
            timeUnixNano: String(Math.round(event.ts_ms * 1e6)),
            observedTimeUnixNano: String(Math.round(event.ts_ms * 1e6)),
            severityNumber: 9,
            eventName: event.name,
            traceId: event.trace_id,
            ...(event.span_id !== undefined ? { spanId: event.span_id } : {}),
            attributes: encodeAttributes(event.attributes)
          }))
        }))
      }
    ]
  };
}
