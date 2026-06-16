from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_ROOT = REPO_ROOT / "spec" / "model-fusion-contract"
PYTHON_PACKAGE_ROOT = CONTRACT_ROOT / "python"
PACKAGE_SRC = "velum_model_fusion_protocol"


def main() -> None:
    dist_dir = PYTHON_PACKAGE_ROOT / "dist"
    if dist_dir.exists():
        shutil.rmtree(dist_dir)
    dist_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="model-fusion-protocol-python-") as temp_dir:
        build_root = Path(temp_dir) / "python"
        shutil.copytree(
            PYTHON_PACKAGE_ROOT,
            build_root,
            ignore=shutil.ignore_patterns("dist", "*.egg-info", "__pycache__"),
        )
        package_root = build_root / "src" / PACKAGE_SRC
        shutil.copytree(CONTRACT_ROOT / "schema", package_root / "schema")
        shutil.copytree(CONTRACT_ROOT / "openapi", package_root / "openapi")
        shutil.copy2(
            CONTRACT_ROOT / "protocol-package.json",
            package_root / "protocol-package.json",
        )

        subprocess.run(
            [
                *_uv_command(),
                "build",
                str(build_root),
                "--out-dir",
                str(dist_dir),
            ],
            check=True,
        )


def _uv_command() -> list[str]:
    uv_executable = shutil.which("uv")
    if uv_executable is not None:
        return [uv_executable]
    system_python = Path("/usr/bin/python3")
    python_executable = str(system_python) if system_python.exists() else sys.executable
    return [python_executable, "-m", "uv"]


if __name__ == "__main__":
    main()
