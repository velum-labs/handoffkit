from __future__ import annotations

import json
import time

import fusionkit_cli.main as cli
from fusionkit_cli.main import app
from fusionkit_cli.onboarding import resolve_config_path, write_config
from fusionkit_core.config import EndpointAuth, FusionConfig, ModelEndpoint, load_config
from fusionkit_core.credentials import (
    SubscriptionStatus,
    clear_credential_cache,
    subscription_status,
)
from typer.testing import CliRunner

runner = CliRunner()


def _available(mode, path=None) -> SubscriptionStatus:
    return SubscriptionStatus(mode=mode, available=True)


def _write_claude(path, token: str, expires_at_ms: float) -> None:
    path.write_text(
        json.dumps({"claudeAiOauth": {"accessToken": token, "expiresAt": expires_at_ms}})
    )


def _write_codex(path, token: str, account_id: str) -> None:
    path.write_text(json.dumps({"tokens": {"access_token": token, "account_id": account_id}}))


# --- subscription_status (non-raising detection) ---------------------------


def test_subscription_status_available(tmp_path) -> None:
    clear_credential_cache()
    creds = tmp_path / "credentials.json"
    _write_claude(creds, "sk-ant-oat01-x", (time.time() + 3600) * 1000)

    status = subscription_status("claude-code", path=str(creds))

    assert status.available is True
    assert status.expired is False
    assert status.hours_to_expiry and status.hours_to_expiry > 0


def test_subscription_status_expired(tmp_path) -> None:
    clear_credential_cache()
    creds = tmp_path / "credentials.json"
    _write_claude(creds, "sk-ant-oat01-x", (time.time() - 60) * 1000)

    status = subscription_status("claude-code", path=str(creds))

    assert status.available is True
    assert status.expired is True


def test_subscription_status_missing_codex(tmp_path) -> None:
    clear_credential_cache()
    status = subscription_status("codex", path=str(tmp_path / "absent.json"))

    assert status.available is False
    assert "codex login" in status.detail


# --- config discovery ------------------------------------------------------


def test_resolve_config_path_prefers_explicit_then_env_then_project(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("FUSIONKIT_CONFIG", raising=False)

    assert resolve_config_path(None) is None  # nothing present

    (tmp_path / "fusionkit.yaml").write_text("endpoints: []\ndefault_model: x\n")
    project = resolve_config_path(None)
    assert project is not None and project.name == "fusionkit.yaml"

    env_target = tmp_path / "from-env.yaml"
    env_target.write_text("x")
    monkeypatch.setenv("FUSIONKIT_CONFIG", str(env_target))
    assert resolve_config_path(None) == env_target

    explicit = tmp_path / "explicit.yaml"
    assert resolve_config_path(explicit) == explicit


# --- init wizard -----------------------------------------------------------


def test_init_yes_writes_loadable_config(tmp_path, monkeypatch) -> None:
    clear_credential_cache()
    monkeypatch.setattr(cli, "subscription_status", _available)
    monkeypatch.setattr(cli, "detect_api_keys", lambda: {})
    target = tmp_path / "fusionkit.yaml"

    result = runner.invoke(app, ["init", "--yes", "-o", str(target)])

    assert result.exit_code == 0, result.output
    config = load_config(target)
    by_mode = {endpoint.auth.mode for endpoint in config.endpoints}
    assert {"claude-code", "codex"} <= by_mode
    assert config.default_model in {endpoint.id for endpoint in config.endpoints}


def test_init_refuses_overwrite_without_force(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "subscription_status", _available)
    monkeypatch.setattr(cli, "detect_api_keys", lambda: {})
    target = tmp_path / "fusionkit.yaml"
    target.write_text("existing")

    result = runner.invoke(app, ["init", "--yes", "-o", str(target)])

    assert result.exit_code == 1
    assert "already exists" in result.output


# --- auth switch / set-default ---------------------------------------------


def _seed_config(tmp_path):
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(
                id="claude",
                provider="anthropic",
                model="claude-sonnet-4-5",
                base_url="https://api.anthropic.com",
                api_key_env="ANTHROPIC_API_KEY",
            ),
        ],
        default_model="claude",
    )
    target = tmp_path / "fusionkit.yaml"
    write_config(config, target)
    return target


def test_auth_switch_to_subscription_round_trips(tmp_path) -> None:
    target = _seed_config(tmp_path)

    result = runner.invoke(
        app, ["auth", "switch", "claude", "--mode", "claude-code", "--config", str(target)]
    )

    assert result.exit_code == 0, result.output
    config = load_config(target)
    endpoint = config.endpoint_for("claude")
    assert endpoint.auth.mode == "claude-code"
    assert endpoint.provider == "anthropic"


def test_auth_switch_codex_to_api_key_switches_provider(tmp_path) -> None:
    config = FusionConfig(
        endpoints=[
            ModelEndpoint(
                id="cx", provider="codex", model="gpt-5.5", auth=EndpointAuth(mode="codex")
            ),
        ],
        default_model="cx",
    )
    target = tmp_path / "fusionkit.yaml"
    write_config(config, target)

    result = runner.invoke(
        app, ["auth", "switch", "cx", "--mode", "api_key", "--config", str(target)]
    )

    assert result.exit_code == 0, result.output
    endpoint = load_config(target).endpoint_for("cx")
    assert endpoint.auth.mode == "api_key"
    assert endpoint.provider == "openai"
    assert endpoint.api_key_env == "OPENAI_API_KEY"


def test_auth_set_default(tmp_path) -> None:
    target = _seed_config(tmp_path)

    result = runner.invoke(app, ["auth", "set-default", "claude", "--config", str(target)])

    assert result.exit_code == 0, result.output
    assert load_config(target).default_model == "claude"


def test_auth_status_runs(tmp_path) -> None:
    target = _seed_config(tmp_path)

    result = runner.invoke(app, ["auth", "status", "--config", str(target)])

    assert result.exit_code == 0, result.output
    assert "Subscriptions" in result.output
