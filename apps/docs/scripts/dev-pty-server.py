"""Local stand-in for the Vercel Sandbox interactive PTY endpoint.

Speaks the same WebSocket protocol as `sandbox.openInteractive()`:
  - client sends a text JSON frame {type:"start", command, args, env, cwd, cols, rows}
  - client binary frames are PTY stdin; {type:"resize", cols, rows} resizes
  - server sends PTY output as binary frames and {type:"exit", code} on exit

Dev only — binds loopback. Point the docs app at it with
`DEMO_LOCAL_PTY_URL=ws://127.0.0.1:8991` and run:

    uv run --with websockets python scripts/dev-pty-server.py \
        --port 8991 -- bash /path/to/local-demo-shell.sh

When `-- command...` is given it overrides whatever the start frame asks for
(the browser requests the in-sandbox wrapper path, which doesn't exist locally).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import fcntl
import json
import os
import pty
import signal
import struct
import termios
import time

import websockets


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


async def handle(ws: websockets.ServerConnection, override_cmd: list[str], record: str | None) -> None:
    print(f"client connected: {ws.remote_address}")
    start_raw = await ws.recv()
    start = json.loads(start_raw)
    if start.get("type") != "start":
        await ws.close(code=1002, reason="expected start frame")
        return

    command = override_cmd or [start["command"], *start.get("args", [])]
    env = dict(os.environ)
    for pair in start.get("env", []):
        key, _, value = pair.partition("=")
        env[key] = value
    cwd = start.get("cwd") if not override_cmd else None
    cols = int(start.get("cols", 80))
    rows = int(start.get("rows", 24))

    pid, master = pty.fork()
    if pid == 0:  # child
        if cwd and os.path.isdir(cwd):
            os.chdir(cwd)
        os.execvpe(command[0], command, env)
        os._exit(127)

    set_winsize(master, rows, cols)
    print(f"spawned pid={pid}: {' '.join(command)}")
    loop = asyncio.get_running_loop()

    async def pump_output() -> None:
        while True:
            try:
                data = await loop.run_in_executor(None, os.read, master, 65536)
            except OSError:
                break
            if not data:
                break
            if record:
                capture(data)
            await ws.send(data)

    frames: list[tuple[int, str]] = []
    last = time.monotonic()

    def capture(data: bytes) -> None:
        nonlocal last
        now = time.monotonic()
        frames.append((int((now - last) * 1000), base64.b64encode(data).decode()))
        last = now

    output_task = asyncio.create_task(pump_output())
    try:
        async for message in ws:
            if isinstance(message, bytes):
                os.write(master, message)
                continue
            msg = json.loads(message)
            if msg.get("type") == "resize":
                set_winsize(master, int(msg["rows"]), int(msg["cols"]))
    except websockets.ConnectionClosed:
        pass
    finally:
        output_task.cancel()
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status) if status >= 0 else -1
        try:
            await ws.send(json.dumps({"type": "exit", "code": code}))
            await ws.close()
        except websockets.ConnectionClosed:
            pass
        os.close(master)
        if record and frames:
            with open(record, "w") as fh:
                json.dump({"frames": frames}, fh)
            print(f"recorded {len(frames)} frames to {record}")
        print(f"pid={pid} exited with {code}")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8991)
    parser.add_argument("--record", default=None, help="write a replay.json of PTY output to this path")
    parser.add_argument("command", nargs="*", help="override command (after --)")
    args = parser.parse_args()

    async with websockets.serve(
        lambda ws: handle(ws, args.command, args.record), args.host, args.port, max_size=None
    ):
        print(f"dev PTY server on ws://{args.host}:{args.port}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
