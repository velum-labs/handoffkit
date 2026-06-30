from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MlxServerCommand:
    model: str
    port: int
    host: str = "127.0.0.1"

    def argv(self) -> list[str]:
        return [
            "mlx_lm.server",
            "--model",
            self.model,
            "--host",
            self.host,
            "--port",
            str(self.port),
        ]


def build_mlx_lm_server_command(model: str, port: int, host: str = "127.0.0.1") -> list[str]:
    return MlxServerCommand(model=model, port=port, host=host).argv()
