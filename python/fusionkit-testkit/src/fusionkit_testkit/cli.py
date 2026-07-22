"""Standalone entry point: run the simulator as a child process.

Prints a single ``listening`` JSON line on stdout (so a spawning test — e.g.
the Node ``stack-e2e`` suite — can read the bound port), then serves until
terminated. Scripting happens over the HTTP control plane (``/__sim/*``).
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import threading

from fusionkit_testkit.server import RouteKitSimulator


def main() -> None:
    parser = argparse.ArgumentParser(description="FusionKit RouteKit gateway simulator")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()

    simulator = RouteKitSimulator(host=args.host, port=args.port).start()
    print(
        json.dumps(
            {
                "event": "listening",
                "host": args.host,
                "port": simulator.port,
                "url": simulator.url,
            }
        ),
        flush=True,
    )

    stop = threading.Event()

    def _terminate(signum: int, frame: object) -> None:
        del signum, frame
        stop.set()

    signal.signal(signal.SIGINT, _terminate)
    signal.signal(signal.SIGTERM, _terminate)
    stop.wait()
    simulator.stop()
    sys.exit(0)


if __name__ == "__main__":
    main()
