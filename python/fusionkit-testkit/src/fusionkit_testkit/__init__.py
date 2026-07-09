"""Realistic, scriptable testing tooling for FusionKit.

Three composable layers (see ``docs/testing.md``):

- :class:`ProviderSimulator` — a real HTTP server speaking the OpenAI Chat
  Completions and Anthropic Messages wire dialects, scripted per model via
  :class:`Behavior` queues (in-process or over ``/__sim/*``) and observed via
  its request journal.
- :mod:`fusionkit_testkit.endpoints` — builders that point real
  ``ModelEndpoint`` / ``FusionConfig`` objects at the simulator.
- :class:`EngineProcess` — the real ``fusionkit serve`` CLI as a child
  process, for process-level end-to-end tests.
"""

from fusionkit_testkit.behaviors import Behavior, SimError, SimToolCall
from fusionkit_testkit.endpoints import panel_config, sim_endpoint
from fusionkit_testkit.engine import EngineProcess, EngineProcessError, free_port
from fusionkit_testkit.server import ProviderSimulator
from fusionkit_testkit.sse import parse_sse, sse_done, sse_reasoning, sse_text

__all__ = [
    "Behavior",
    "EngineProcess",
    "EngineProcessError",
    "ProviderSimulator",
    "SimError",
    "SimToolCall",
    "free_port",
    "panel_config",
    "parse_sse",
    "sim_endpoint",
    "sse_done",
    "sse_reasoning",
    "sse_text",
]
