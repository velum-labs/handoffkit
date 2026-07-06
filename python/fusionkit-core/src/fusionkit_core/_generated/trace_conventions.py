# GENERATED FILE - DO NOT EDIT. Source of truth: spec/fusion-trace/registry.json. Regenerate with `node scripts/generate-trace-conventions.mjs`.
# ruff: noqa: E501
from __future__ import annotations

from typing import Final

FUSION_SPAN_NAMES: Final[tuple[str, ...]] = ("fusion.run", "fusion.turn", "fusion.candidate", "fusion.judge", "fusion.fuse", "chat", "fusion.passthrough", "fusion.turn.info", "fusion.candidate.started", "fusion.candidate.step", "fusion.model_call.started", "fusion.judge.request", "fusion.judge.thinking", "fusion.judge.scored", "fusion.judge.synthesis", "fusion.cost", "fusion.narration", "fusion.tool.execution", "fusion.cursor.route",)

FUSION_MARKER_NAMES: Final[tuple[str, ...]] = ("fusion.turn.info", "fusion.candidate.started", "fusion.candidate.step", "fusion.model_call.started", "fusion.judge.request", "fusion.judge.thinking", "fusion.judge.scored", "fusion.judge.synthesis", "fusion.cost", "fusion.narration", "fusion.tool.execution", "fusion.cursor.route",)


class ATTR:
    """Attribute keys, one constant per registry attribute."""

    FUSION_TURN: Final[str] = "fusion.turn"
    FUSION_DIALECT: Final[str] = "fusion.dialect"
    FUSION_STATUS: Final[str] = "fusion.status"
    FUSION_REPO: Final[str] = "fusion.repo"
    FUSION_PROMPT_PREVIEW: Final[str] = "fusion.prompt_preview"
    FUSION_ENVIRONMENT: Final[str] = "fusion.environment"
    FUSION_EVIDENCE: Final[str] = "fusion.evidence"
    FUSION_RUN_ID: Final[str] = "fusion.run_id"
    FUSION_SESSION_ID: Final[str] = "fusion.session_id"
    FUSION_CANDIDATE_ID: Final[str] = "fusion.candidate.id"
    FUSION_TRAJECTORY_ID: Final[str] = "fusion.trajectory.id"
    FUSION_MODEL_ID: Final[str] = "fusion.model.id"
    FUSION_BRANCH_NAME: Final[str] = "fusion.branch_name"
    FUSION_WORKTREE_PATH: Final[str] = "fusion.worktree_path"
    FUSION_STEP_COUNT: Final[str] = "fusion.step_count"
    FUSION_TOOL_CALL_COUNT: Final[str] = "fusion.tool_call_count"
    FUSION_FINISH_REASON: Final[str] = "fusion.finish_reason"
    FUSION_VERIFICATION_STATUS: Final[str] = "fusion.verification_status"
    FUSION_FINAL_OUTPUT_PREVIEW: Final[str] = "fusion.final_output_preview"
    FUSION_FINAL_OUTPUT: Final[str] = "fusion.final_output"
    FUSION_CONTENT: Final[str] = "fusion.content"
    FUSION_STEP: Final[str] = "fusion.step"
    FUSION_STEP_INDEX: Final[str] = "fusion.step.index"
    FUSION_STEP_TYPE: Final[str] = "fusion.step.type"
    FUSION_PROMPT: Final[str] = "fusion.prompt"
    FUSION_SYSTEM_PROMPT: Final[str] = "fusion.system_prompt"
    FUSION_MESSAGE_COUNT: Final[str] = "fusion.message_count"
    FUSION_TOOL_COUNT: Final[str] = "fusion.tool_count"
    FUSION_JUDGE_MODEL: Final[str] = "fusion.judge.model"
    FUSION_SYNTHESIZER_MODEL: Final[str] = "fusion.synthesizer.model"
    FUSION_MESSAGES: Final[str] = "fusion.messages"
    FUSION_TRAJECTORIES: Final[str] = "fusion.trajectories"
    FUSION_TOOLS: Final[str] = "fusion.tools"
    FUSION_TRAJECTORY_IDS: Final[str] = "fusion.trajectory_ids"
    FUSION_RAW_ANALYSIS: Final[str] = "fusion.raw_analysis"
    FUSION_TOOL_CALLS: Final[str] = "fusion.tool_calls"
    FUSION_ANALYSIS: Final[str] = "fusion.analysis"
    FUSION_METRICS: Final[str] = "fusion.metrics"
    FUSION_INPUT_IDS: Final[str] = "fusion.input_ids"
    FUSION_RAW_OUTPUT: Final[str] = "fusion.raw_output"
    FUSION_SYNTHESIS_EMPTY: Final[str] = "fusion.synthesis_empty"
    FUSION_SYNTHESIS: Final[str] = "fusion.synthesis"
    FUSION_DECISION: Final[str] = "fusion.decision"
    FUSION_SELECTED_TRAJECTORY_ID: Final[str] = "fusion.selected.trajectory_id"
    FUSION_RATIONALE: Final[str] = "fusion.rationale"
    FUSION_JUDGE_DEGRADED: Final[str] = "fusion.judge.degraded"
    FUSION_TERMINAL: Final[str] = "fusion.terminal"
    FUSION_FUSION_UNIT: Final[str] = "fusion.fusion_unit"
    FUSION_ENDPOINT_ID: Final[str] = "fusion.endpoint_id"
    FUSION_USAGE: Final[str] = "fusion.usage"
    FUSION_COST_STAGE: Final[str] = "fusion.cost.stage"
    FUSION_COST_MODEL: Final[str] = "fusion.cost.model"
    FUSION_COST_TURN_USD: Final[str] = "fusion.cost.turn_usd"
    FUSION_COST_PROVIDER_USD: Final[str] = "fusion.cost.provider_usd"
    FUSION_COST_LOCAL_COMPUTE_USD: Final[str] = "fusion.cost.local_compute_usd"
    FUSION_COST_SESSION_TOTAL_USD: Final[str] = "fusion.cost.session_total_usd"
    FUSION_COST_UNKNOWN: Final[str] = "fusion.cost.unknown"
    FUSION_COST_UNKNOWN_USAGE: Final[str] = "fusion.cost.unknown_usage"
    FUSION_HEADLINE: Final[str] = "fusion.headline"
    FUSION_PROSE: Final[str] = "fusion.prose"
    FUSION_EXECUTION_ID: Final[str] = "fusion.execution_id"
    FUSION_PLAN_ID: Final[str] = "fusion.plan_id"
    FUSION_OUTPUT_HASH: Final[str] = "fusion.output_hash"
    FUSION_ERROR: Final[str] = "fusion.error"
    ERROR_TYPE: Final[str] = "error.type"
    HTTP_RESPONSE_STATUS_CODE: Final[str] = "http.response.status_code"
    GEN_AI_OPERATION_NAME: Final[str] = "gen_ai.operation.name"
    GEN_AI_PROVIDER_NAME: Final[str] = "gen_ai.provider.name"
    GEN_AI_REQUEST_MODEL: Final[str] = "gen_ai.request.model"
    GEN_AI_RESPONSE_FINISH_REASONS: Final[str] = "gen_ai.response.finish_reasons"
    GEN_AI_USAGE_INPUT_TOKENS: Final[str] = "gen_ai.usage.input_tokens"
    GEN_AI_USAGE_OUTPUT_TOKENS: Final[str] = "gen_ai.usage.output_tokens"


EXPORTABLE_ATTRIBUTES: Final[frozenset[str]] = frozenset({"fusion.turn", "fusion.dialect", "fusion.status", "fusion.run_id", "fusion.session_id", "fusion.candidate.id", "fusion.trajectory.id", "fusion.model.id", "fusion.step_count", "fusion.tool_call_count", "fusion.finish_reason", "fusion.verification_status", "fusion.step.index", "fusion.step.type", "fusion.message_count", "fusion.tool_count", "fusion.judge.model", "fusion.synthesizer.model", "fusion.trajectory_ids", "fusion.input_ids", "fusion.synthesis_empty", "fusion.decision", "fusion.selected.trajectory_id", "fusion.judge.degraded", "fusion.terminal", "fusion.fusion_unit", "fusion.endpoint_id", "fusion.cost.stage", "fusion.cost.model", "fusion.cost.turn_usd", "fusion.cost.provider_usd", "fusion.cost.local_compute_usd", "fusion.cost.session_total_usd", "fusion.cost.unknown", "fusion.cost.unknown_usage", "fusion.execution_id", "fusion.plan_id", "fusion.output_hash", "error.type", "http.response.status_code", "gen_ai.operation.name", "gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.finish_reasons", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"})

FUSION_SCOPES: Final[dict[str, str]] = {"gateway": "fusionkit.gateway", "ensemble": "fusionkit.ensemble", "panel-model": "fusionkit.panel-model", "judge": "fusionkit.judge", "synthesis": "fusionkit.synthesis", "cli": "fusionkit.cli", "cursor-bridge": "fusionkit.cursor-bridge"}

FUSION_CONVENTIONS_VERSION: Final[str] = "1.0.0"
