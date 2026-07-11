from __future__ import annotations

import ast
from pathlib import Path

CORE = Path(__file__).resolve().parents[1] / "src" / "hyperkit" / "core"


def test_hyperkit_core_imports_no_fusionkit_modules() -> None:
    offenders: list[str] = []
    for path in CORE.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [node.module or ""]
            else:
                continue
            for name in names:
                if name.startswith("fusionkit"):
                    offenders.append(f"{path.name}:{node.lineno}:{name}")
    message = "hyperkit core -> fusionkit imports violate the SUT boundary: " + ", ".join(
        offenders
    )
    assert offenders == [], message

