from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict

from fusionkit_core.clients import ChatClient, ProviderCallError
from fusionkit_core.config import ContextPolicy, PromptOverrides, SamplingConfig
from fusionkit_core.context import (
    ContextBudget,
    estimate_messages_tokens,
    estimate_tokens,
    pack_trajectories,
)
from fusionkit_core.prompts import (
    JUDGE_SYSTEM_PROMPT,
    SYNTHESIZER_SYSTEM_PROMPT,
    FusionIdentity,
    build_fuse_system,
    build_judge_prompt,
    build_judge_system,
)
from fusionkit_core.trace import emit as trace_emit
from fusionkit_core.trace import new_span_id
from fusionkit_core.types import (
    ChatMessage,
    FusionAnalysis,
    ModelResponse,
    StreamChunk,
    ToolCall,
    Trajectory,
    TrajectorySynthesis,
    Usage,
)

_TOOL_CALL_LOGGER = logging.getLogger("fusionkit.tool_calls")


def warn_malformed_tool_calls(tool_calls: Sequence[ToolCall], *, source: str) -> None:
    """Log loudly when a finished tool call carries unparseable JSON arguments.

    The arguments still flow through unchanged — the harness owns the tool loop
    and reports its own execution error — but a reassembly bug or a model
    emitting broken JSON must be visible in the gateway logs instead of failing
    silently downstream as an inscrutable shell/tool error.
    """
    for call in tool_calls:
        try:
            json.loads(call.arguments or "{}")
        except json.JSONDecodeError as exc:
            _TOOL_CALL_LOGGER.warning(
                "malformed tool-call arguments from %s: call id=%s name=%s "
                "len=%d error=%s preview=%r",
                source,
                call.id,
                call.name,
                len(call.arguments),
                exc,
                call.arguments[:120],
            )


class FuseResult(BaseModel):
    """The result of one :meth:`JudgeSynthesizer.fuse` step.

    ``response`` is the synthesizer's model turn (content + any tool calls).
    ``terminal`` is true when the step produced the final answer (no tool calls);
    only then is ``trajectory`` set - the consolidated output trajectory whose
    ``synthesis`` metadata carries the fusion decision/rationale/metrics.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    response: ModelResponse
    terminal: bool
    analysis: FusionAnalysis
    trajectory: Trajectory | None = None
    #: True when the synthesizer returned empty content and the final output
    #: fell back to the best candidate's own answer (see _build_fuse_result).
    synthesis_empty: bool = False


# Rough token cost of the fixed prompt scaffolding (section headers, labels)
# that the per-part estimates below do not count.
_PROMPT_SCAFFOLD_TOKENS = 256


@dataclass
class _TurnDiagnostics:
    """Context-management outcomes of one fuse turn, folded into metrics.

    Mutable and created per turn (the synthesizer instance is shared across
    requests, so nothing here may live on ``self``).
    """

    judge_pack: dict[str, Any] | None = None
    synth_pack: dict[str, Any] | None = None
    judge_degraded: str | None = None
    synth_fallback: str | None = None
    analysis_response: ModelResponse | None = None

    def to_metrics(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.judge_pack is not None:
            out["judge_pack"] = self.judge_pack
        if self.synth_pack is not None:
            out["synth_pack"] = self.synth_pack
        if self.judge_degraded is not None:
            out["judge_degraded"] = self.judge_degraded
        if self.synth_fallback is not None:
            out["synth_fallback"] = self.synth_fallback
        return out


@dataclass
class _PreparedTurn:
    """Everything :meth:`JudgeSynthesizer._prepare_conversation` resolved.

    Keeps the pieces needed to *rebuild* the synthesizer conversation with
    reduced evidence when the model still overflows (the overflow ladder).
    """

    conversation: list[ChatMessage]
    analysis: FusionAnalysis
    harness_system: str | None
    body: list[ChatMessage]
    identity: FusionIdentity | None
    packed: list[Trajectory]
    tools_present: bool
    diagnostics: _TurnDiagnostics = field(default_factory=_TurnDiagnostics)


class JudgeSynthesizer:
    def __init__(
        self,
        prompts: PromptOverrides | None = None,
        *,
        harness_passthrough: bool = True,
        select_best: bool = False,
        context_policy: ContextPolicy | None = None,
    ) -> None:
        overrides = prompts or PromptOverrides()
        self._judge_system = overrides.judge_system or JUDGE_SYSTEM_PROMPT
        self._synthesizer_system = overrides.synthesizer_system or SYNTHESIZER_SYSTEM_PROMPT
        self._synthesizer_overridden = overrides.synthesizer_system is not None
        # When on, a coding-harness system prompt arriving in the conversation is
        # treated as the primary base for the judge/synthesizer (fusion framing
        # rides on top), instead of being demoted beneath the fusion prompt.
        self._harness_passthrough = harness_passthrough
        # When on (and no tools), return the judge-selected best candidate verbatim
        # rather than letting the synthesizer rewrite the answer (best-of-N selection).
        self._select_best = select_best
        # How judge/synthesizer prompts are budgeted against each model's
        # context window (trajectory evidence is packed to fit; see context.py).
        self._context_policy = context_policy or ContextPolicy()

    def _selected_verbatim(
        self,
        trajectories: Sequence[Trajectory],
        analysis: FusionAnalysis,
        synth_client: ChatClient,
    ) -> ModelResponse | None:
        """The judge-selected candidate's content as a terminal response, or None.

        Returns None (fall back to composition) when select-best is off, the judge
        named no best candidate, or the named id is not a succeeded trajectory.
        """
        if not self._select_best or not analysis.best_trajectory:
            return None
        chosen = next(
            (
                trajectory
                for trajectory in trajectories
                if trajectory.id == analysis.best_trajectory
                and trajectory.status == "succeeded"
                and trajectory.content.strip()
            ),
            None,
        )
        if chosen is None:
            return None
        return ModelResponse(
            model_id=synth_client.model_id,
            content=chosen.content,
            finish_reason="stop",
            usage=Usage(),
        )

    async def fuse(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        synthesizer_client: ChatClient | None = None,
        sampling: SamplingConfig,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        analysis: FusionAnalysis | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> FuseResult:
        """One fusion step: produce the next step, or the final answer.

        This is the single fusion operation. With ``tools=None`` the synthesizer
        is necessarily terminal on its first turn - the old one-shot text fusion,
        where "produce an answer" is just a zero-tool-round trajectory. With tools
        present it may emit tool calls and the harness drives the loop, calling
        back with the observed results.

        The judge ``analyze`` runs once; pass ``analysis`` to reuse a cached result
        across a turn's tool loop (avoids re-analyzing the unchanged candidates).
        On a terminal step the consolidated output :class:`Trajectory` is built and
        its ``synthesis`` is populated (decision/selected/rationale/metrics) - the
        fusion result lives on the trajectory, not in a separate record.
        """
        synth_client = synthesizer_client or judge_client
        judge_span = span_id or new_span_id()
        prepared = await self._prepare_conversation(
            messages,
            trajectories,
            judge_client=judge_client,
            synth_client=synth_client,
            identity=self._identity(trajectories, judge_client, synth_client),
            sampling=sampling,
            tools=tools,
            analysis=analysis,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        resolved_analysis = prepared.analysis
        # Best-of-N selection (no tools): return the judge-picked candidate verbatim
        # instead of an LLM rewrite, skipping the synthesizer call entirely.
        selected = (
            self._selected_verbatim(trajectories, resolved_analysis, synth_client)
            if tools is None
            else None
        )
        if selected is not None:
            response = selected
        else:
            try:
                response = await synth_client.chat(
                    prepared.conversation,
                    sampling,
                    tools=tools,
                    tool_choice=tool_choice,
                )
            except ProviderCallError as exc:
                if exc.category != "context_overflow":
                    raise
                # Overflow ladder step 1: retry once with the evidence reduced
                # to final outputs only.
                reduced = self._rebuild_reduced_conversation(prepared)
                try:
                    response = await synth_client.chat(
                        reduced,
                        sampling,
                        tools=tools,
                        tool_choice=tool_choice,
                    )
                    prepared.diagnostics.synth_fallback = "reduced_evidence_retry"
                except ProviderCallError as retry_exc:
                    if retry_exc.category != "context_overflow":
                        raise
                    # Step 2: no synthesizer call fits; fall back to a candidate
                    # answer so the turn still produces a fused response.
                    response = self._overflow_fallback_response(
                        trajectories, resolved_analysis, synth_client, prepared.diagnostics
                    )
        result = self._build_fuse_result(
            response, trajectories, resolved_analysis, prepared.diagnostics
        )
        result.response = _with_analysis_provider_cost(
            result.response, prepared.diagnostics.analysis_response
        )
        if result.terminal:
            # Parity with fuse_stream's Act III: surface the judge's analysis on
            # the reasoning channel of the terminal response (ahead of any of
            # the synthesizer model's own reasoning). The stream path instead
            # yields it as a reasoning_delta before content, so this stays
            # non-stream only.
            judged = analysis_reasoning_markdown(resolved_analysis, trajectories)
            if judged is not None:
                combined = (judged + (result.response.reasoning or "")).rstrip()
                result.response.reasoning = combined
        self._emit_step(trace_id, judge_span, result, trajectories)
        return result

    async def fuse_stream(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        synthesizer_client: ChatClient | None = None,
        sampling: SamplingConfig,
        tools: Sequence[Mapping[str, Any]] | None = None,
        tool_choice: str | Mapping[str, Any] | None = None,
        analysis: FusionAnalysis | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> AsyncIterator[StreamChunk | FuseResult]:
        """Streaming counterpart of :meth:`fuse`: the synthesizer turn streams.

        Yields the synthesizer's :class:`StreamChunk`s as real tokens arrive
        (true streaming, not buffer-then-rechunk), then a final
        :class:`FuseResult` as the last item so the caller can attach the fused
        trajectory metadata to the terminal SSE chunk. The judge ``analyze`` is
        still a single up-front non-streaming call.
        """
        synth_client = synthesizer_client or judge_client
        judge_span = span_id or new_span_id()
        prepared = await self._prepare_conversation(
            messages,
            trajectories,
            judge_client=judge_client,
            synth_client=synth_client,
            identity=self._identity(trajectories, judge_client, synth_client),
            sampling=sampling,
            tools=tools,
            analysis=analysis,
            trace_id=trace_id,
            judge_span=judge_span,
        )
        resolved_analysis = prepared.analysis
        # Act III of the narrated turn: surface the judge's real analysis on the
        # reasoning channel before any answer tokens stream.
        reasoning = analysis_reasoning_markdown(resolved_analysis, trajectories)
        if reasoning is not None:
            yield StreamChunk(reasoning_delta=reasoning)
        # Best-of-N selection (no tools): emit the judge-picked candidate verbatim as
        # a single chunk and skip the synthesizer stream.
        selected = (
            self._selected_verbatim(trajectories, resolved_analysis, synth_client)
            if tools is None
            else None
        )
        if selected is not None:
            yield StreamChunk(delta=selected.content)
            result = self._build_fuse_result(
                selected, trajectories, resolved_analysis, prepared.diagnostics
            )
            result.response = _with_analysis_provider_cost(
                result.response, prepared.diagnostics.analysis_response
            )
            self._emit_step(trace_id, judge_span, result, trajectories)
            yield result
            return
        accumulator = _StreamAccumulator()
        response: ModelResponse | None = None
        # Overflow ladder, streaming shape: an overflow surfaces before the
        # first token by construction (the request is rejected wholesale), so a
        # pre-yield failure can be retried with reduced evidence and, failing
        # that, replaced by a candidate answer emitted as one chunk. A failure
        # after content has streamed is not recoverable and propagates.
        for attempt, conversation in enumerate(
            (prepared.conversation, self._rebuild_reduced_conversation(prepared))
        ):
            try:
                async for chunk in synth_client.stream_chat(
                    conversation,
                    sampling,
                    tools=tools,
                    tool_choice=tool_choice,
                ):
                    accumulator.add(chunk)
                    yield chunk
                response = accumulator.response(synth_client.model_id)
                if attempt == 1:
                    prepared.diagnostics.synth_fallback = "reduced_evidence_retry"
                break
            except ProviderCallError as exc:
                if exc.category != "context_overflow" or accumulator.yielded:
                    raise
        if response is None:
            response = self._overflow_fallback_response(
                trajectories, resolved_analysis, synth_client, prepared.diagnostics
            )
            yield StreamChunk(delta=response.content)
        result = self._build_fuse_result(
            response, trajectories, resolved_analysis, prepared.diagnostics
        )
        result.response = _with_analysis_provider_cost(
            result.response, prepared.diagnostics.analysis_response
        )
        self._emit_step(trace_id, judge_span, result, trajectories)
        yield result

    def _identity(
        self,
        trajectories: Sequence[Trajectory],
        judge_client: ChatClient,
        synth_client: ChatClient,
    ) -> FusionIdentity:
        """Factual run identity (panel/judge/synthesizer) for prompt disclosure."""
        return FusionIdentity(
            panel=tuple(trajectory.model_id for trajectory in trajectories),
            judge=getattr(judge_client, "model_id", None),
            synthesizer=getattr(synth_client, "model_id", None),
        )

    def _split_harness_system(
        self, messages: Sequence[ChatMessage]
    ) -> tuple[str | None, list[ChatMessage]]:
        """Split inbound system messages (the harness prompt) from the body.

        With pass-through on, the coding-harness system prompt (Codex/Claude Code
        put their full agent prompt in the system role) is lifted out so it can
        become the primary base of the composed system message - and dropped from
        the forwarded body so it is not duplicated. With pass-through off, the
        messages are returned unchanged (the prior behavior: the harness prompt
        stays in the body, demoted beneath the fusion system prompt).
        """
        if not self._harness_passthrough:
            return None, list(messages)
        system_parts = [
            message.content
            for message in messages
            if message.role == "system" and message.content
        ]
        body = [message for message in messages if message.role != "system"]
        harness = "\n\n".join(system_parts) if system_parts else None
        return harness, body

    async def _prepare_conversation(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        synth_client: ChatClient,
        identity: FusionIdentity | None,
        sampling: SamplingConfig,
        tools: Sequence[Mapping[str, Any]] | None,
        analysis: FusionAnalysis | None,
        trace_id: str | None,
        judge_span: str | None,
    ) -> _PreparedTurn:
        """Build the synthesizer conversation (judge analysis + system + history).

        Shared by :meth:`fuse` and :meth:`fuse_stream` so the streaming and
        non-streaming paths cannot drift in how they ground the synthesizer.
        Trajectory evidence is packed to the synthesizer's context budget; the
        conversation body is never touched (the caller owns its history — a
        body that alone exceeds the window is the caller's overflow, and the
        evidence just packs down to its floor).
        """
        diagnostics = _TurnDiagnostics()
        harness_system, body = self._split_harness_system(messages)
        resolved_analysis = analysis
        if resolved_analysis is None and trajectories:
            resolved_analysis = await self.analyze(
                messages,
                trajectories,
                judge_client=judge_client,
                judge_sampling=sampling.model_copy(update={"temperature": 0.0}),
                trace_id=trace_id,
                judge_span=judge_span,
                diagnostics=diagnostics,
            )
        if resolved_analysis is None:
            resolved_analysis = FusionAnalysis()
        packed = list(trajectories)
        if trajectories:
            budget = ContextBudget.for_model(
                getattr(synth_client, "max_context", None), sampling, self._context_policy
            )
            # Everything in the prompt that is not trajectory evidence: the
            # composed system blocks, the analysis JSON, and the conversation.
            overhead = (
                estimate_tokens(
                    build_fuse_system(
                        [],
                        synthesizer_system=self._synthesizer_system,
                        harness_system=harness_system,
                        synthesizer_overridden=self._synthesizer_overridden,
                        identity=None,
                        analysis=None,
                        tools_present=tools is not None,
                    )
                )
                + estimate_tokens(json.dumps(resolved_analysis.model_dump()))
                + estimate_messages_tokens(body)
                + _PROMPT_SCAFFOLD_TOKENS
            )
            packed, report = pack_trajectories(
                trajectories, budget.evidence_tokens(overhead), policy=self._context_policy
            )
            if report.changed:
                diagnostics.synth_pack = report.to_metrics()
        system = build_fuse_system(
            packed,
            synthesizer_system=self._synthesizer_system,
            harness_system=harness_system,
            synthesizer_overridden=self._synthesizer_overridden,
            identity=identity if packed else None,
            analysis=resolved_analysis if packed else None,
            tools_present=tools is not None,
        )
        return _PreparedTurn(
            conversation=[ChatMessage(role="system", content=system), *body],
            analysis=resolved_analysis,
            harness_system=harness_system,
            body=body,
            identity=identity,
            packed=packed,
            tools_present=tools is not None,
            diagnostics=diagnostics,
        )

    def _rebuild_reduced_conversation(self, prepared: _PreparedTurn) -> list[ChatMessage]:
        """The prepared conversation with evidence reduced to final outputs only.

        The overflow ladder's step-1 retry: the packing estimate was too
        optimistic, so drop every trajectory's items and keep just the answers.
        """
        reduced = [
            trajectory.model_copy(update={"items": []}) if trajectory.items else trajectory
            for trajectory in prepared.packed
        ]
        system = build_fuse_system(
            reduced,
            synthesizer_system=self._synthesizer_system,
            harness_system=prepared.harness_system,
            synthesizer_overridden=self._synthesizer_overridden,
            identity=prepared.identity if reduced else None,
            analysis=prepared.analysis if reduced else None,
            tools_present=prepared.tools_present,
        )
        return [ChatMessage(role="system", content=system), *prepared.body]

    def _overflow_fallback_response(
        self,
        trajectories: Sequence[Trajectory],
        analysis: FusionAnalysis,
        synth_client: ChatClient,
        diagnostics: _TurnDiagnostics,
    ) -> ModelResponse:
        """A candidate answer as the terminal response when no synth call fits.

        Prefers the judge-selected best candidate verbatim (permitted here even
        when ``synthesis_select_best`` is off — this is a failure fallback, not
        the selection mode), then the best trajectory's own output.
        """
        chosen = next(
            (
                trajectory
                for trajectory in trajectories
                if trajectory.id == analysis.best_trajectory
                and trajectory.status == "succeeded"
                and trajectory.content.strip()
            ),
            None,
        )
        if chosen is not None:
            diagnostics.synth_fallback = "select_best_verbatim"
            content = chosen.content
        else:
            diagnostics.synth_fallback = "best_output"
            content = _best_trajectory_output(trajectories)
        return ModelResponse(
            model_id=synth_client.model_id,
            content=content,
            finish_reason="stop",
            usage=Usage(),
        )

    def _build_fuse_result(
        self,
        response: ModelResponse,
        trajectories: Sequence[Trajectory],
        resolved_analysis: FusionAnalysis,
        diagnostics: _TurnDiagnostics | None = None,
    ) -> FuseResult:
        terminal = not response.tool_calls
        output_trajectory: Trajectory | None = None
        synthesis_empty = False
        if terminal:
            final_output = response.content
            if not final_output.strip() and trajectories:
                # The synthesizer returned nothing (e.g. a reasoning model spent
                # its budget on reasoning). Fall back to the best trajectory's own
                # answer so a fused response is always produced.
                synthesis_empty = True
                final_output = _best_trajectory_output(trajectories)
                response = response.model_copy(update={"content": final_output})
            output_trajectory = _consolidated_trajectory(
                final_output, trajectories, resolved_analysis, diagnostics=diagnostics
            )
        return FuseResult(
            response=response,
            terminal=terminal,
            analysis=resolved_analysis,
            trajectory=output_trajectory,
            synthesis_empty=synthesis_empty,
        )

    async def analyze(
        self,
        messages: Sequence[ChatMessage],
        trajectories: Sequence[Trajectory],
        *,
        judge_client: ChatClient,
        judge_sampling: SamplingConfig,
        trace_id: str | None = None,
        judge_span: str | None = None,
        diagnostics: _TurnDiagnostics | None = None,
    ) -> FusionAnalysis:
        """The judge's gap analysis, packed to its budget and degrade-not-fail.

        The analysis is advisory input to synthesis, so a judge provider
        failure must never fail the fusion turn: a ``context_overflow`` is
        retried once at half the evidence budget, and any remaining
        :class:`ProviderCallError` degrades to an empty analysis with a
        sentinel consensus (mirroring the JSON parse-failure path).
        """
        harness_system, _ = self._split_harness_system(messages)
        system_content = build_judge_system(self._judge_system, harness_system=harness_system)
        user_request = _last_user_text(messages)
        budget = ContextBudget.for_model(
            getattr(judge_client, "max_context", None), judge_sampling, self._context_policy
        )
        overhead = (
            estimate_tokens(system_content)
            + estimate_tokens(user_request)
            + _PROMPT_SCAFFOLD_TOKENS
        )
        evidence_budget = budget.evidence_tokens(overhead)

        async def call(budget_tokens: int) -> ModelResponse:
            packed, report = pack_trajectories(
                trajectories, budget_tokens, policy=self._context_policy
            )
            if diagnostics is not None and report.changed:
                diagnostics.judge_pack = report.to_metrics()
            return await judge_client.chat(
                [
                    ChatMessage(role="system", content=system_content),
                    ChatMessage(
                        role="user",
                        content=build_judge_prompt(user_request, packed),
                    ),
                ],
                judge_sampling,
            )

        try:
            response = await call(evidence_budget)
        except ProviderCallError as exc:
            if exc.category == "context_overflow":
                try:
                    response = await call(evidence_budget // 2)
                except ProviderCallError as retry_exc:
                    return _degraded_analysis(retry_exc, trace_id, judge_span, diagnostics)
            else:
                return _degraded_analysis(exc, trace_id, judge_span, diagnostics)
        _emit_judge(
            trace_id,
            judge_span,
            "judge.thinking",
            payload={
                "fusion_unit": "trajectory",
                "raw_analysis": response.content,
                "usage": _usage_payload(response),
            },
        )
        if diagnostics is not None:
            diagnostics.analysis_response = response
        analysis = parse_analysis(response.content)
        # The structured verdict behind the raw thinking: what the judge found
        # per candidate. Emitted separately so observers can render the parsed
        # analysis without re-parsing raw_analysis.
        _emit_judge(
            trace_id,
            judge_span,
            "judge.scored",
            payload={
                "fusion_unit": "trajectory",
                "analysis": {
                    "consensus": analysis.consensus,
                    "contradictions": analysis.contradictions,
                    "unique_insights": analysis.unique_insights,
                    "coverage_gaps": analysis.coverage_gaps,
                    "likely_errors": analysis.likely_errors,
                },
                "metrics": {
                    "best_trajectory": analysis.best_trajectory,
                    "recommended_final_structure": analysis.recommended_final_structure,
                },
                "input_ids": [trajectory.id for trajectory in trajectories],
                "usage": _usage_payload(response),
            },
        )
        return analysis

    def _emit_step(
        self,
        trace_id: str | None,
        judge_span: str | None,
        result: FuseResult,
        trajectories: Sequence[Trajectory],
    ) -> None:
        response = result.response
        terminal = result.terminal
        output_trajectory = result.trajectory
        payload: dict[str, Any] = {
            "fusion_unit": "trajectory_step",
            "terminal": terminal,
            "content_preview": response.content[:500],
            "tool_calls": [
                {"id": call.id, "name": call.name, "arguments": call.arguments}
                for call in response.tool_calls
            ],
            "input_trajectory_ids": [trajectory.id for trajectory in trajectories],
            "usage": _usage_payload(response),
        }
        synthesis = output_trajectory.synthesis if output_trajectory is not None else None
        if terminal and output_trajectory is not None:
            payload["final_output"] = response.content
            if synthesis is not None:
                payload["decision"] = synthesis.decision
                payload["selected_trajectory_id"] = synthesis.selected_trajectory_id
                payload["rationale"] = synthesis.rationale
                payload["synthesis"] = synthesis.model_dump(mode="json")
        if terminal and (
            (synthesis is not None and synthesis.decision == "synthesize")
            or result.synthesis_empty
        ):
            # The synthesizer's own terminal turn (select-verbatim steps skip
            # it): the raw fused output, and whether it came back empty and
            # fell back to the best candidate's answer.
            _emit_judge(
                trace_id,
                judge_span,
                "judge.synthesis",
                payload={
                    "raw_output": response.content,
                    "empty": result.synthesis_empty,
                    "usage": _usage_payload(response),
                },
            )
        _emit_judge(
            trace_id,
            judge_span,
            "judge.final" if terminal else "judge.thinking",
            payload=payload,
        )


# Sentinel consensus written when the judge response is not valid JSON. Shared
# between the producer (parse_analysis) and the detector (_judge_parse_failed)
# so the two cannot silently drift apart.
_PARSE_FAILURE_CONSENSUS = "Judge did not return valid structured JSON."

# Sentinel consensus written when the judge provider call itself failed and the
# turn proceeded without an analysis (degrade-not-fail; see analyze()).
_JUDGE_DEGRADED_CONSENSUS = "Judge analysis unavailable: the judge model call failed."


def _degraded_analysis(
    exc: ProviderCallError,
    trace_id: str | None,
    judge_span: str | None,
    diagnostics: _TurnDiagnostics | None,
) -> FusionAnalysis:
    """An empty analysis carrying the judge failure, so synthesis proceeds."""
    if diagnostics is not None:
        diagnostics.judge_degraded = exc.category
    _emit_judge(
        trace_id,
        judge_span,
        "judge.thinking",
        payload={
            "fusion_unit": "trajectory",
            "judge_degraded": exc.category,
            "error": str(exc)[:500],
        },
    )
    return FusionAnalysis(
        consensus=[_JUDGE_DEGRADED_CONSENSUS],
        likely_errors=[f"judge {exc.category}: {str(exc)[:200]}"],
    )


class _StreamAccumulator:
    """Folds synthesizer stream chunks into a terminal :class:`ModelResponse`."""

    def __init__(self) -> None:
        self.yielded = False
        self._content_parts: list[str] = []
        self._reasoning_parts: list[str] = []
        self._tool_accumulator: list[dict[str, str]] = []
        self._seen_tool_ids: set[str] = set()
        self._finish_reason: str | None = None
        self._usage = Usage()
        self._provider_cost = None

    def add(self, chunk: StreamChunk) -> None:
        self.yielded = True
        if chunk.delta:
            self._content_parts.append(chunk.delta)
        if chunk.model_reasoning_delta:
            # The synthesizer model's own reasoning tokens: fold them so the
            # terminal record matches what the non-stream path captures.
            self._reasoning_parts.append(chunk.model_reasoning_delta)
        if chunk.tool_call_delta is not None:
            accumulate_tool_call(self._tool_accumulator, self._seen_tool_ids, chunk.tool_call_delta)
        if chunk.finish_reason is not None:
            self._finish_reason = chunk.finish_reason
        if chunk.usage is not None:
            self._usage = chunk.usage
        if chunk.provider_cost is not None:
            self._provider_cost = chunk.provider_cost

    def response(self, model_id: str) -> ModelResponse:
        tool_calls = [
            ToolCall(id=item["id"], name=item["name"], arguments=item["arguments"] or "{}")
            for item in self._tool_accumulator
        ]
        warn_malformed_tool_calls(tool_calls, source=f"judge stream ({model_id})")
        return ModelResponse(
            model_id=model_id,
            content="".join(self._content_parts),
            finish_reason=self._finish_reason or ("tool_calls" if tool_calls else "stop"),
            usage=self._usage,
            tool_calls=tool_calls,
            provider_cost=self._provider_cost,
            reasoning="".join(self._reasoning_parts) or None,
        )


def accumulate_tool_call(
    accumulator: list[dict[str, str]],
    seen_ids: set[str],
    delta: ToolCall,
) -> None:
    """Fold a streamed tool-call fragment into the in-progress accumulator.

    Fragments carrying a stream-local ``index`` (OpenAI Chat streaming) are
    folded by that index: continuation fragments arrive with empty ids and
    parallel calls interleave, so the index — not the id, and not arrival
    order — identifies which call a fragment belongs to. Folding by
    ``accumulator[-1]`` here is exactly what corrupts large multi-fragment
    arguments when a provider interleaves slots or batches several entries
    into one chunk.

    Index-less fragments keep the id-based behavior: OpenAI Chat's opening
    fragment carries id+name with argument text following on empty-id
    fragments, while Codex/Responses repeats the same non-empty ``call_id``
    on every fragment. A new, previously unseen id starts a fresh call;
    anything else appends argument text (and a late name) to the call already
    in flight.
    """
    if delta.index is not None:
        slot = f"idx:{delta.index}"
        current = next(
            (item for item in accumulator if item.get("_slot") == slot),
            None,
        )
        if current is None:
            current = {"_slot": slot, "id": "", "name": "", "arguments": ""}
            accumulator.append(current)
        if delta.id:
            current["id"] = delta.id
            seen_ids.add(delta.id)
        if delta.name:
            current["name"] = delta.name
        current["arguments"] += delta.arguments
        return
    if delta.id and delta.id not in seen_ids:
        seen_ids.add(delta.id)
        accumulator.append({"id": delta.id, "name": delta.name, "arguments": delta.arguments})
        return
    if not accumulator:
        accumulator.append({"id": delta.id, "name": delta.name, "arguments": delta.arguments})
        return
    current = accumulator[-1]
    if delta.name:
        current["name"] = delta.name
    current["arguments"] += delta.arguments


def parse_analysis(content: str) -> FusionAnalysis:
    try:
        return FusionAnalysis.model_validate_json(_extract_json(content))
    except (ValueError, TypeError, json.JSONDecodeError):
        return FusionAnalysis(
            consensus=[_PARSE_FAILURE_CONSENSUS],
            likely_errors=[content[:500]],
        )


def _consolidated_trajectory(
    final_output: str,
    trajectories: Sequence[Trajectory],
    analysis: FusionAnalysis,
    *,
    diagnostics: _TurnDiagnostics | None = None,
) -> Trajectory:
    """Build the fused output trajectory with its ``synthesis`` metadata."""
    selected_trajectory_id = _selected_trajectory_id(final_output, trajectories)
    synthesis = TrajectorySynthesis(
        decision="select_trajectory" if selected_trajectory_id else "synthesize",
        selected_trajectory_id=selected_trajectory_id,
        rationale=_rationale(analysis),
        input_trajectory_ids=[trajectory.id for trajectory in trajectories],
        metrics=_synthesis_metrics(trajectories, analysis, diagnostics=diagnostics),
    )
    return Trajectory(
        id=_synthesis_id(),
        model_id="fusionkit/synthesizer",
        content=final_output,
        items=[],
        status="succeeded",
        synthesis=synthesis,
    )


def _synthesis_metrics(
    trajectories: Sequence[Trajectory],
    analysis: FusionAnalysis,
    *,
    final_output_artifact_id: str | None = None,
    diagnostics: _TurnDiagnostics | None = None,
) -> dict[str, Any]:
    contributions = [
        {
            "trajectory_id": trajectory.id,
            "model_id": trajectory.model_id,
            "status": trajectory.status,
            "item_count": len(trajectory.items),
            "reason": "included as judge synthesis evidence",
        }
        for trajectory in trajectories
    ]
    rejections = [
        {"trajectory_id": _trajectory_id_for_reason(reason, trajectories), "reason": reason}
        for reason in analysis.likely_errors
    ]
    metrics: dict[str, Any] = {
        "trajectory_contributions": contributions,
        "trajectory_rejections": rejections,
        "judge_structured_parse_status": _judge_parse_status(analysis),
        "fusion_unit": "trajectory",
    }
    if _judge_parse_failed(analysis):
        metrics["judge_structured_parse_error"] = "invalid_json"
    if final_output_artifact_id is not None:
        metrics["final_output_artifact_id"] = final_output_artifact_id
    if diagnostics is not None:
        context_metrics = diagnostics.to_metrics()
        if context_metrics:
            metrics["context"] = context_metrics
    return metrics


def _best_trajectory_output(trajectories: Sequence[Trajectory]) -> str:
    """Pick a non-empty answer: prefer a succeeded trajectory, then any with text."""

    def _rank(trajectory: Trajectory) -> int:
        return 0 if trajectory.status == "succeeded" else 1

    ordered = sorted(trajectories, key=_rank)
    for trajectory in ordered:
        if trajectory.content.strip():
            return trajectory.content.strip()
    return "No candidate produced a usable result."


def _selected_trajectory_id(final_output: str, trajectories: Sequence[Trajectory]) -> str | None:
    stripped = final_output.strip()
    for trajectory in trajectories:
        if stripped == trajectory.content.strip():
            return trajectory.id
    return None


def _trajectory_id_for_reason(reason: str, trajectories: Sequence[Trajectory]) -> str | None:
    lower_reason = reason.lower()
    for trajectory in trajectories:
        if trajectory.id.lower() in lower_reason or trajectory.model_id.lower() in lower_reason:
            return trajectory.id
    ordinal_words = ("one", "two", "three", "four", "five")
    for index, word in enumerate(ordinal_words):
        if index < len(trajectories) and f"candidate {word}" in lower_reason:
            return trajectories[index].id
    return None


def _rationale(analysis: FusionAnalysis) -> str:
    rationale_parts = [
        *analysis.consensus,
        *analysis.contradictions,
        *analysis.unique_insights,
        *analysis.coverage_gaps,
    ]
    return "; ".join(rationale_parts[:6])


def _judge_parse_status(analysis: FusionAnalysis) -> str:
    return "failed" if _judge_parse_failed(analysis) else "parsed"


def _judge_parse_failed(analysis: FusionAnalysis) -> bool:
    return analysis.consensus == [_PARSE_FAILURE_CONSENSUS]


def _judge_unavailable(analysis: FusionAnalysis) -> bool:
    """True when the analysis is a sentinel (parse failure or degraded judge)."""
    return _judge_parse_failed(analysis) or analysis.consensus == [_JUDGE_DEGRADED_CONSENSUS]


def _reasoning_line(text: str, limit: int = 160) -> str:
    """One safe prose line from judge-model text: markdown stripped, collapsed, capped."""
    collapsed = re.sub(r"\s+", " ", text.replace("`", "").replace("*", "")).strip()
    return collapsed if len(collapsed) <= limit else collapsed[: limit - 1] + "…"


def analysis_reasoning_markdown(
    analysis: FusionAnalysis, trajectories: Sequence[Trajectory]
) -> str | None:
    """The judge's analysis as a reasoning-channel markdown block, or None.

    Rendered under a bold ``Weighing the candidates`` headline (coding agents —
    Codex in particular — promote the latest bold segment to their live status
    header and hide unbolded reasoning). Content is the judge's *real* analysis:
    strongest candidate, consensus, disagreements, likely errors. Skipped
    entirely when the judge's structured output failed to parse or the judge
    call degraded (sentinel text must not leak into the reasoning channel).
    """
    if _judge_unavailable(analysis):
        return None
    model_by_id = {trajectory.id: trajectory.model_id for trajectory in trajectories}
    sentences: list[str] = []
    if analysis.best_trajectory:
        best = model_by_id.get(analysis.best_trajectory, analysis.best_trajectory)
        sentences.append(f"{_reasoning_line(best)} looks strongest.")
    if analysis.consensus:
        sentences.append(
            "Consensus: "
            + "; ".join(_reasoning_line(item) for item in analysis.consensus[:2])
            + "."
        )
    if analysis.contradictions:
        sentences.append(
            "They disagree on: "
            + "; ".join(_reasoning_line(item) for item in analysis.contradictions[:2])
            + "."
        )
    if analysis.likely_errors:
        sentences.append(
            "Possible issues: "
            + "; ".join(_reasoning_line(item) for item in analysis.likely_errors[:2])
            + "."
        )
    if analysis.coverage_gaps:
        sentences.append(
            "Gaps to close: "
            + "; ".join(_reasoning_line(item) for item in analysis.coverage_gaps[:2])
            + "."
        )
    if not sentences:
        return None
    return "**Weighing the candidates**\n\n" + " ".join(sentences) + "\n\n"


def _synthesis_id() -> str:
    return f"synthesis_{uuid.uuid4().hex}"


def _last_user_text(messages: Sequence[ChatMessage]) -> str:
    for message in reversed(messages):
        if message.role == "user":
            return message.content
    return ""


def _extract_json(content: str) -> str:
    stripped = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", stripped, flags=re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    return stripped


def _emit_judge(
    trace_id: str | None,
    span_id: str | None,
    event_type: str,
    *,
    payload: dict[str, Any],
) -> None:
    trace_emit(
        component="judge",
        event_type=event_type,
        trace_id=trace_id,
        span_id=span_id,
        payload=payload,
    )


def _usage_payload(response: Any) -> dict[str, Any]:
    usage = getattr(response, "usage", None)
    out: dict[str, Any] = {}
    if usage is not None:
        out = {
            "prompt_tokens": getattr(usage, "prompt_tokens", None),
            "completion_tokens": getattr(usage, "completion_tokens", None),
            "total_tokens": getattr(usage, "total_tokens", None),
        }
    latency = getattr(response, "latency_s", None)
    if latency is not None:
        out["latency_s"] = latency
    model_id = getattr(response, "model_id", None)
    if model_id is not None:
        out["model_id"] = model_id
    return out


def _usage_is_empty(usage: Usage) -> bool:
    return (
        usage.prompt_tokens is None
        and usage.completion_tokens is None
        and usage.total_tokens is None
    )


def _with_analysis_provider_cost(
    response: ModelResponse,
    analysis_response: ModelResponse | None,
) -> ModelResponse:
    if response.provider_cost is not None or analysis_response is None:
        return response
    update: dict[str, Any] = {"provider_cost": analysis_response.provider_cost}
    if _usage_is_empty(response.usage):
        update["usage"] = analysis_response.usage
    return response.model_copy(update=update)


__all__ = [
    "FuseResult",
    "JudgeSynthesizer",
    "accumulate_tool_call",
    "parse_analysis",
    "warn_malformed_tool_calls",
]
