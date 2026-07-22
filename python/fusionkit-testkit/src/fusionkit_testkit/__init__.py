"""Scriptable RouteKit-upstream testing tooling for FusionKit.

Three composable layers (see ``docs/testing.md``):

- :class:`RouteKitSimulator` — a real HTTP server with native OpenAI Chat,
  Anthropic Messages, Google GenAI, and OpenAI Responses surfaces, all
  scripted through shared :class:`Behavior` queues (in-process or over
  ``/__sim/*``) and observed through one request journal.
- :mod:`fusionkit_testkit.endpoints` — builders that point ``FusionConfig`` at
  the simulator.
- :class:`EngineProcess` — the real ``fusionkit-sidecar serve`` CLI as a child
  process, for process-level end-to-end tests.
"""

from fusionkit_testkit.behaviors import Behavior, SimError, SimToolCall
from fusionkit_testkit.endpoints import panel_config, sim_model
from fusionkit_testkit.engine import EngineProcess, EngineProcessError, free_port
from fusionkit_testkit.scenarios import as_behavior, judge_analysis, script_fused_turn
from fusionkit_testkit.server import RouteKitSimulator
from fusionkit_testkit.sse import parse_sse, sse_done, sse_reasoning, sse_text

__all__ = [
    "Behavior",
    "EngineProcess",
    "EngineProcessError",
    "RouteKitSimulator",
    "SimError",
    "SimToolCall",
    "as_behavior",
    "free_port",
    "judge_analysis",
    "panel_config",
    "parse_sse",
    "script_fused_turn",
    "sim_model",
    "sse_done",
    "sse_reasoning",
    "sse_text",
]
