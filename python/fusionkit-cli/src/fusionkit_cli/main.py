from __future__ import annotations

# CLI startup latency policy (documented exception to the no-inline-imports
# rule): typer builds the whole command tree on EVERY invocation — including
# `fusionkit --version` and the Node CLI's warm probe / `prompts dump` — so
# module scope may only import what command *signatures* need at registration
# time (typer + fusionkit_core.config for annotated params) plus cheap stdlib.
# Everything heavy (uvicorn/fastapi, rich, the evals stack, provider clients)
# is imported inside the one subcommand that uses it, with `TYPE_CHECKING`
# imports covering the annotations.
import json
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, cast

import typer
from fusionkit_core.config import (
    EndpointAuth,
    FusionConfig,
    FusionMode,
    ModelEndpoint,
    ProviderKind,
    SubscriptionAuthMode,
    load_config,
)

# stdlib-only module; kept at module scope both for cheapness and because tests
# monkeypatch `fusionkit_cli.main.subscription_status`.
from fusionkit_core.credentials import subscription_status
from fusionkit_core.registry import (
    PROVIDER_DEFAULT_BASE_URL,
    provider_for_auth_mode,
)

from fusionkit_cli.commands.bench import register as register_bench_commands
from fusionkit_cli.onboarding import (
    API_KEY_ENVS,
    api_key_endpoint,
    default_write_path,
    detect_api_keys,
    resolve_config_path,
    subscription_endpoint,
    write_config,
)

if TYPE_CHECKING:
    from fusionkit_core.credentials import SubscriptionStatus

app = typer.Typer(
    help=(
        "FusionKit fusion engine: serve an OpenAI-compatible fusion endpoint "
        "(panel + judge + synthesis). The npm @fusionkit/cli front door drives "
        "this for coding agents."
    ),
    invoke_without_command=True,
)
DEFAULT_SERVE_PROVIDER = next(iter(API_KEY_ENVS))


def _fusionkit_distribution_version() -> str:
    try:
        return distribution_version("fusionkit")
    except PackageNotFoundError:
        return "0.0.0"


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"fusionkit {_fusionkit_distribution_version()}")
        raise typer.Exit()


@app.callback()
def _main(
    ctx: typer.Context,
    version: Annotated[
        bool | None,
        typer.Option(
            "--version",
            "-V",
            callback=_version_callback,
            is_eager=True,
            help="Show the fusionkit version and exit.",
        ),
    ] = None,
) -> None:
    if ctx.invoked_subcommand is None and version is None:
        typer.echo(ctx.get_help())
        raise typer.Exit()


prompts_app = typer.Typer(help="Inspect and export the built-in fusion prompts.")
app.add_typer(prompts_app, name="prompts")

auth_app = typer.Typer(help="Inspect and switch model authentication (API key / subscription).")
app.add_typer(auth_app, name="auth")


@prompts_app.command("dump")
def prompts_dump(
    dir: Annotated[
        Path | None,
        typer.Option("--dir", help="write each default prompt to <dir>/<id>.md instead of stdout"),
    ] = None,
) -> None:
    """Emit the built-in system prompts so a consumer can scaffold editable overrides.

    With no options this prints a JSON object mapping each prompt id (``judge``,
    ``synthesizer``) to its default text. With ``--dir`` it writes one
    ``<id>.md`` file per prompt. This keeps the CLI's scaffolded
    ``.fusionkit/prompts`` defaults in lockstep with this package's source.
    """
    from fusionkit_core.prompts import SYSTEM_PROMPT_DEFAULTS

    if dir is not None:
        dir.mkdir(parents=True, exist_ok=True)
        for prompt_id, text in SYSTEM_PROMPT_DEFAULTS.items():
            (dir / f"{prompt_id}.md").write_text(text + "\n")
        typer.echo(json.dumps({"dir": str(dir), "count": len(SYSTEM_PROMPT_DEFAULTS)}))
        return
    typer.echo(json.dumps(SYSTEM_PROMPT_DEFAULTS, indent=2))


@app.command()
def serve(
    config: Annotated[Path | None, typer.Option("--config", "-c")] = None,
    host: str = "127.0.0.1",
    port: int = 8080,
) -> None:
    resolved = resolve_config_path(config)
    if resolved is None:
        typer.secho(
            "No config found. Run `fusionkit init` to create one, or pass --config.",
            fg=typer.colors.RED,
            err=True,
        )
        raise typer.Exit(code=1)
    import uvicorn
    from fusionkit_core.trace import setup_fusion_tracing
    from fusionkit_server.app import create_app

    setup_fusion_tracing("fusionkit-router")
    fusion_config = load_config(resolved)
    api = create_app(fusion_config)
    uvicorn.run(api, host=host, port=port)


def _status_label(status: SubscriptionStatus) -> str:
    if not status.available:
        return "not logged in"
    hours = status.hours_to_expiry
    if status.expired:
        return "expired (re-login)"
    if hours is not None:
        return f"logged in (expires in {hours:.1f}h)"
    return "logged in"


@app.command()
def init(
    output: Annotated[
        Path | None, typer.Option("--output", "-o", help="config path to write")
    ] = None,
    global_: Annotated[
        bool, typer.Option("--global", help="write to ~/.config/fusionkit/models.yaml")
    ] = False,
    yes: Annotated[
        bool, typer.Option("--yes", "-y", help="accept all detected sources non-interactively")
    ] = False,
    force: Annotated[bool, typer.Option("--force", help="overwrite an existing config")] = False,
) -> None:
    """Detect logged-in subscriptions + API keys and scaffold a config."""
    target = output or default_write_path(global_)
    if target.exists() and not force:
        if yes:
            typer.secho(
                f"{target} already exists; pass --force to overwrite or -o to choose another path.",
                fg=typer.colors.RED,
                err=True,
            )
            raise typer.Exit(code=1)
        if not typer.confirm(f"{target} already exists. Update it?", default=False):
            typer.echo("Keeping existing config.")
            raise typer.Exit(code=0)
        force = True

    claude = subscription_status("claude-code")
    codex = subscription_status("codex")
    api_keys = detect_api_keys()

    typer.echo("Detected:")
    typer.echo(f"  Claude Code subscription : {_status_label(claude)}")
    typer.echo(f"  Codex subscription       : {_status_label(codex)}")
    typer.echo(f"  API keys                 : {', '.join(api_keys.values()) or 'none'}")
    typer.echo("")

    def want(label: str) -> bool:
        return True if yes else typer.confirm(f"Add {label}?", default=True)

    endpoints: list[ModelEndpoint] = []
    if claude.available and want("Claude Code subscription (claude-code)"):
        endpoints.append(subscription_endpoint("claude-code"))
    if codex.available and want("Codex subscription (codex)"):
        endpoints.append(subscription_endpoint("codex"))
    for provider, env_var in api_keys.items():
        if want(f"{provider} via {env_var}"):
            endpoints.append(api_key_endpoint(provider))

    if not endpoints:
        api_key_hint = " / ".join(API_KEY_ENVS.values())
        typer.secho(
            "Nothing selected. Log in with `claude` / `codex login`, or set "
            f"{api_key_hint}, then re-run `fusionkit init`.",
            fg=typer.colors.YELLOW,
            err=True,
        )
        raise typer.Exit(code=1)

    choices = [endpoint.id for endpoint in endpoints]
    default_model = choices[0]
    mode: str = "heuristic"
    if not yes:
        default_model = typer.prompt("Default model id", default=default_model)
        if default_model not in choices:
            raise typer.BadParameter(f"default model must be one of {choices}")
        mode = typer.prompt("Default mode (single/self/panel/heuristic)", default="heuristic")

    try:
        config = FusionConfig(
            endpoints=endpoints,
            default_model=default_model,
            default_mode=cast(FusionMode, mode),
            panel_models=choices,
        )
    except Exception as exc:  # noqa: BLE001 - surface pydantic validation as a CLI error
        raise typer.BadParameter(str(exc)) from exc

    write_config(config, target)
    typer.secho(f"Wrote {target} with {len(endpoints)} endpoint(s).", fg=typer.colors.GREEN)
    discovered = resolve_config_path(None)
    serve_hint = "fusionkit serve" if discovered == target else f"fusionkit serve --config {target}"
    typer.echo(f"Next: {serve_hint}")


@auth_app.command("status")
def auth_status(
    config: Annotated[Path | None, typer.Option("--config", "-c")] = None,
) -> None:
    """Show subscription logins, API keys, and how the config authenticates."""
    from rich.console import Console
    from rich.table import Table

    console = Console()
    subs = Table(title="Subscriptions")
    subs.add_column("mode")
    subs.add_column("state")
    subs.add_column("account")
    for status in (subscription_status("claude-code"), subscription_status("codex")):
        subs.add_row(status.mode, _status_label(status), status.account_id or "-")
    console.print(subs)

    api_keys = detect_api_keys()
    console.print(
        "API keys: "
        + (", ".join(f"{p} ({env})" for p, env in api_keys.items()) if api_keys else "none")
    )

    resolved = resolve_config_path(config)
    if resolved is None:
        console.print("Config: none found (run `fusionkit init`).")
        return
    cfg = load_config(resolved)
    endpoints_table = Table(title=f"Config endpoints ({resolved})")
    endpoints_table.add_column("id")
    endpoints_table.add_column("provider")
    endpoints_table.add_column("model")
    endpoints_table.add_column("auth")
    for endpoint in cfg.endpoints:
        marker = " (default)" if endpoint.id == cfg.default_model else ""
        endpoints_table.add_row(
            endpoint.id + marker, endpoint.provider, endpoint.model, endpoint.auth.mode
        )
    console.print(endpoints_table)


def _switch_endpoint(
    endpoint: ModelEndpoint, mode: SubscriptionAuthMode, api_key_env: str | None
) -> ModelEndpoint:
    """Return a copy of an endpoint with its auth mode changed (keeping provider coherent)."""
    provider: ProviderKind = endpoint.provider
    base_url = endpoint.base_url
    resolved_key_env = endpoint.api_key_env
    if mode in ("claude-code", "codex"):
        provider = cast(ProviderKind, provider_for_auth_mode(mode))
        if endpoint.provider != provider:
            base_url = ""
        resolved_key_env = None
    else:  # api_key
        if provider == "codex":
            # The codex provider only speaks the subscription Responses API; an
            # API key means standard OpenAI chat completions.
            provider = "openai"
        resolved_key_env = api_key_env or endpoint.api_key_env or API_KEY_ENVS.get(provider)
        if not base_url:
            base_url = PROVIDER_DEFAULT_BASE_URL.get(provider, base_url)
    return endpoint.model_copy(
        update={
            "provider": provider,
            "base_url": base_url,
            "api_key_env": resolved_key_env,
            "auth": EndpointAuth(mode=mode),
        }
    )


@auth_app.command("switch")
def auth_switch(
    endpoint_id: Annotated[str, typer.Argument(help="endpoint id to change")],
    mode: Annotated[
        str, typer.Option("--mode", help="api_key, claude-code, or codex")
    ],
    api_key_env: Annotated[
        str | None, typer.Option("--api-key-env", help="env var for api_key mode")
    ] = None,
    config: Annotated[Path | None, typer.Option("--config", "-c")] = None,
) -> None:
    """Switch one endpoint between API key and a subscription."""
    if mode not in ("api_key", "claude-code", "codex"):
        raise typer.BadParameter("mode must be api_key, claude-code, or codex")
    resolved = resolve_config_path(config)
    if resolved is None:
        raise typer.BadParameter("No config found; run `fusionkit init` or pass --config.")
    cfg = load_config(resolved)
    try:
        endpoint = cfg.endpoint_for(endpoint_id)
    except KeyError:
        raise typer.BadParameter(
            f"unknown endpoint {endpoint_id!r}; known: {[e.id for e in cfg.endpoints]}"
        ) from None
    updated = _switch_endpoint(endpoint, cast(SubscriptionAuthMode, mode), api_key_env)
    new_endpoints = [updated if e.id == endpoint_id else e for e in cfg.endpoints]
    write_config(cfg.model_copy(update={"endpoints": new_endpoints}), resolved)
    typer.secho(
        f"{endpoint_id}: auth -> {mode} (provider {updated.provider}) in {resolved}",
        fg=typer.colors.GREEN,
    )


@auth_app.command("set-default")
def auth_set_default(
    endpoint_id: Annotated[str, typer.Argument(help="endpoint id to make the default model")],
    config: Annotated[Path | None, typer.Option("--config", "-c")] = None,
) -> None:
    """Change the config's default_model."""
    resolved = resolve_config_path(config)
    if resolved is None:
        raise typer.BadParameter("No config found; run `fusionkit init` or pass --config.")
    cfg = load_config(resolved)
    if endpoint_id not in {endpoint.id for endpoint in cfg.endpoints}:
        raise typer.BadParameter(
            f"unknown endpoint {endpoint_id!r}; known: {[e.id for e in cfg.endpoints]}"
        )
    write_config(cfg.model_copy(update={"default_model": endpoint_id}), resolved)
    typer.secho(f"default_model -> {endpoint_id} in {resolved}", fg=typer.colors.GREEN)


@auth_app.command("login")
def auth_login(
    provider: Annotated[str, typer.Argument(help="claude-code or codex")],
) -> None:
    """Show how to log in (FusionKit reuses the official CLI logins; it does not own OAuth)."""
    if provider not in ("claude-code", "codex"):
        raise typer.BadParameter("provider must be claude-code or codex")
    command = "claude" if provider == "claude-code" else "codex login"
    typer.echo(f"FusionKit reuses the {provider} CLI login read-only. To (re)authenticate, run:")
    typer.secho(f"  {command}", fg=typer.colors.CYAN)
    status = subscription_status(cast(SubscriptionAuthMode, provider))
    typer.echo(f"Current status: {_status_label(status)}")


@app.command("serve-endpoint")
def serve_endpoint(
    id: Annotated[str, typer.Option("--id", help="endpoint id exposed via /v1/models")],
    model: Annotated[str, typer.Option("--model", help="provider model name (e.g. gpt-5.5)")],
    port: Annotated[int, typer.Option("--port")],
    provider: Annotated[str, typer.Option("--provider")] = DEFAULT_SERVE_PROVIDER,
    base_url: Annotated[
        str | None, typer.Option("--base-url", help="override the provider base URL")
    ] = None,
    api_key_env: Annotated[
        str | None, typer.Option("--api-key-env", help="env var holding the API key")
    ] = None,
    auth_mode: Annotated[
        str,
        typer.Option(
            "--auth-mode",
            help="credential source: api_key, claude-code, or codex (reuse the CLI login)",
        ),
    ] = "api_key",
    credentials_path: Annotated[
        str | None,
        typer.Option("--credentials-path", help="override the CLI credential file path"),
    ] = None,
    timeout_s: Annotated[float, typer.Option("--timeout-s")] = 120.0,
    host: Annotated[str, typer.Option("--host")] = "127.0.0.1",
) -> None:
    """Front a single provider model as an OpenAI Chat Completions endpoint."""
    import uvicorn
    from fusionkit_core.trace import setup_fusion_tracing
    from fusionkit_server.app import create_app
    from fusionkit_server.openai_endpoint import build_endpoint

    setup_fusion_tracing("fusionkit-panel-model")
    endpoint = build_endpoint(
        id=id,
        model=model,
        provider=provider,
        base_url=base_url,
        api_key_env=api_key_env,
        timeout_s=timeout_s,
        auth_mode=auth_mode,
        credentials_path=credentials_path,
    )
    print(
        json.dumps(
            {
                "event": "starting",
                "id": endpoint.id,
                "provider": endpoint.provider,
                "model": endpoint.model,
            }
        ),
        flush=True,
    )
    fusion_config = FusionConfig(endpoints=[endpoint], default_model=endpoint.id)
    api = create_app(fusion_config)
    print(json.dumps({"event": "listening", "host": host, "port": port}), flush=True)
    uvicorn.run(api, host=host, port=port)


register_bench_commands(app)
