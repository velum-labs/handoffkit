from __future__ import annotations

import json
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import Annotated

import typer
import uvicorn
from fusionkit_core.config import load_config
from fusionkit_core.prompts import SYSTEM_PROMPT_DEFAULTS
from fusionkit_core.trace import setup_fusion_tracing
from fusionkit_server.app import create_app

app = typer.Typer(
    help="Internal FusionKit synthesis sidecar.",
    invoke_without_command=True,
)


def _distribution_version() -> str:
    try:
        return distribution_version("fusionkit")
    except PackageNotFoundError:
        return "0.0.0"


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"fusionkit-sidecar {_distribution_version()}")
        raise typer.Exit()


@app.callback()
def main(
    ctx: typer.Context,
    version: Annotated[
        bool | None,
        typer.Option(
            "--version",
            "-V",
            callback=_version_callback,
            is_eager=True,
            help="Show the sidecar version and exit.",
        ),
    ] = None,
) -> None:
    if ctx.invoked_subcommand is None and version is None:
        typer.echo(ctx.get_help())
        raise typer.Exit()


@app.command()
def serve(
    config: Annotated[Path, typer.Option("--config", "-c")],
    host: Annotated[str, typer.Option("--host")] = "127.0.0.1",
    port: Annotated[int, typer.Option("--port")] = 8080,
) -> None:
    """Run the internal RouteKit-backed synthesis sidecar."""
    setup_fusion_tracing("fusionkit-sidecar")
    api = create_app(load_config(config))
    uvicorn.run(api, host=host, port=port)


prompts_app = typer.Typer(help="Inspect the built-in synthesis prompts.")
app.add_typer(prompts_app, name="prompts")


@prompts_app.command("dump")
def prompts_dump(
    directory: Annotated[
        Path | None,
        typer.Option(
            "--dir",
            help="write each prompt to <dir>/<id>.md instead of stdout",
        ),
    ] = None,
) -> None:
    if directory is not None:
        directory.mkdir(parents=True, exist_ok=True)
        for prompt_id, text in SYSTEM_PROMPT_DEFAULTS.items():
            (directory / f"{prompt_id}.md").write_text(text + "\n")
        typer.echo(
            json.dumps(
                {"dir": str(directory), "count": len(SYSTEM_PROMPT_DEFAULTS)}
            )
        )
        return
    typer.echo(json.dumps(SYSTEM_PROMPT_DEFAULTS, indent=2))


__all__ = ["app", "main", "prompts_dump", "serve"]
