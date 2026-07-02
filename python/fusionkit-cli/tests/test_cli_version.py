"""CLI surface tests for the PyPI fusionkit distribution."""

from __future__ import annotations

from fusionkit_cli.main import app
from typer.testing import CliRunner

runner = CliRunner()


def test_version_flag_prints_distribution_version() -> None:
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0
    assert result.stdout.strip().startswith("fusionkit ")
    assert result.stdout.strip() != "fusionkit 0.0.0"
