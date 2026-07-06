"""The fklab CLI makes lab state inspectable before any paid runner exists.

Stage 0 is deliberately read-only: operators can verify the resolved config and
the pinned model registry, while later stages reuse this entry point for commands
that create lab artifacts.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from fusionkit_lab.config import DEFAULT_CYCLE_ID, LabConfig, load_lab_config
from fusionkit_lab.registry import ModelIdentity, identity_hash, load_registry


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2

    handler = getattr(args, "handler", None)
    if handler is None:
        parser.print_help(sys.stderr)
        return 1

    try:
        return int(handler(args))
    except (FileNotFoundError, KeyError, ValueError, ValidationError) as exc:
        _print_error(exc)
        return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fklab")
    subparsers = parser.add_subparsers(dest="command", required=True)

    models_parser = subparsers.add_parser("models", help="Inspect pinned model identities")
    models_subparsers = models_parser.add_subparsers(dest="models_command", required=True)

    list_parser = models_subparsers.add_parser("list", help="List models in a cycle registry")
    list_parser.add_argument("--cycle", default=DEFAULT_CYCLE_ID, help="Registry cycle id")
    list_parser.set_defaults(handler=_models_list)

    show_parser = models_subparsers.add_parser("show", help="Show one model identity")
    show_parser.add_argument("endpoint_id", help="Endpoint id to inspect")
    show_parser.set_defaults(handler=_models_show)

    config_parser = subparsers.add_parser("config", help="Print resolved lab configuration")
    config_parser.set_defaults(handler=_config_show)

    return parser


def _models_list(args: argparse.Namespace) -> int:
    config = load_lab_config()
    registry = load_registry(_registry_path(config, args.cycle))
    rows = [_model_row(model) for model in registry.models]
    _print_table(
        ["endpoint_id", "provider", "model", "generation", "hash", "price_in/out", "tokens"],
        rows,
    )
    return 0


def _models_show(args: argparse.Namespace) -> int:
    config = load_lab_config()
    registry = load_registry(_registry_path(config, config.cycle_id))
    model = registry.get(args.endpoint_id)
    payload = model.model_dump(mode="json")
    payload["identity_hash"] = identity_hash(model)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def _config_show(args: argparse.Namespace) -> int:
    del args
    config = load_lab_config()
    print(json.dumps(config.model_dump(mode="json"), indent=2, sort_keys=True))
    return 0


def _registry_path(config: LabConfig, cycle_id: str) -> Path:
    return config.registry_dir / f"{cycle_id}.yaml"


def _model_row(model: ModelIdentity) -> list[str]:
    escalated = (
        str(model.escalated_completion_tokens)
        if model.escalated_completion_tokens is not None
        else "none"
    )
    return [
        model.endpoint_id,
        model.provider,
        model.model,
        model.generation,
        identity_hash(model),
        f"{model.input_price_per_m:g}/{model.output_price_per_m:g}",
        f"{model.max_completion_tokens}/{escalated}",
    ]


def _print_table(headers: Sequence[str], rows: Sequence[Sequence[str]]) -> None:
    widths = [
        max(len(str(value)) for value in (header, *(row[index] for row in rows)))
        for index, header in enumerate(headers)
    ]
    print("  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)))


def _print_error(exc: Exception) -> None:
    if isinstance(exc, KeyError) and exc.args:
        message: Any = exc.args[0]
    else:
        message = str(exc)
    print(f"error: {message}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
