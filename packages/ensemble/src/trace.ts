/**
 * Ensemble-facing surface for the fusion-trace emitter. The canonical
 * implementation lives in `@fusionkit/protocol` (a dependency-free leaf) so the
 * gateway, the AI SDK worktree agent, and the CLI can share it without import
 * cycles; this module simply re-exports it for ensemble call sites.
 */

export {
  ambientTraceId,
  emitTrace,
  getTraceEmitter,
  newSpanId,
  newTraceId,
  TRACE_CANDIDATE_HEADER,
  TRACE_ID_HEADER,
  TRACE_PARENT_SPAN_HEADER,
  TRACE_SPAN_HEADER,
  TraceEmitter
} from "@fusionkit/protocol";
export type {
  EmitInput,
  FusionTraceComponent,
  FusionTraceEvent,
  FusionTraceEventType
} from "@fusionkit/protocol";
