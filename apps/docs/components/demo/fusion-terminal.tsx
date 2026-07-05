"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Terminal, type TerminalHandle } from "@wterm/react";
import "@wterm/react/css";

/** PTY start parameters, provided by the session API. */
type PtyStart = {
  command: string;
  args: string[];
  cwd: string;
  env: string[];
};

type SessionResponse = {
  url?: string;
  token?: string;
  sandboxName?: string;
  expiresAt?: number;
  start?: PtyStart;
  busy?: boolean;
  fallback?: boolean;
  reason?: string;
};

type ReplayData = {
  /** `[delayMs, base64Chunk]` pairs captured from a real session. */
  frames: [number, string][];
};

type Phase = "idle" | "launching" | "live" | "replay" | "ended";

const SUGGESTIONS = [
  "Fix the bug in stats.js so `node test.js` passes",
  "Explain what this repo does",
  "Add an average() function to stats.js with a test"
];

const REPLAY_URL = "/demo/replay.json";
/** Cap recorded pauses so the replay stays watchable. */
const REPLAY_MAX_DELAY_MS = 1200;

function decodeBase64(chunk: string): Uint8Array {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function FusionTerminal() {
  const termRef = useRef<TerminalHandle>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dimsRef = useRef({ cols: 80, rows: 24 });
  const sandboxRef = useRef<string | null>(null);
  const replayAbortRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<Phase>("idle");

  const [phase, setPhaseState] = useState<Phase>("idle");
  const [note, setNote] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<string | null>(null);

  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const write = useCallback((data: string | Uint8Array) => {
    termRef.current?.write(data);
  }, []);

  const stopSandbox = useCallback(() => {
    const sandbox = sandboxRef.current;
    sandboxRef.current = null;
    if (sandbox === null) return;
    void fetch(`/api/demo/session?sandbox=${encodeURIComponent(sandbox)}`, {
      method: "DELETE",
      keepalive: true
    }).catch(() => undefined);
  }, []);

  const endSession = useCallback(
    (message?: string) => {
      replayAbortRef.current?.abort();
      wsRef.current?.close();
      wsRef.current = null;
      stopSandbox();
      setExpiresAt(null);
      if (message !== undefined) write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
      setPhase("ended");
    },
    [setPhase, stopSandbox, write]
  );

  const startReplay = useCallback(
    async (reason: string) => {
      setPhase("replay");
      setNote(reason);
      const abort = new AbortController();
      replayAbortRef.current = abort;
      try {
        const res = await fetch(REPLAY_URL, { signal: abort.signal });
        if (!res.ok) throw new Error(`replay fetch failed: ${res.status}`);
        const data = (await res.json()) as ReplayData;
        write("\x1b[2J\x1b[H");
        for (const [delay, chunk] of data.frames) {
          if (abort.signal.aborted) return;
          await new Promise((r) => setTimeout(r, Math.min(delay, REPLAY_MAX_DELAY_MS)));
          if (abort.signal.aborted) return;
          write(decodeBase64(chunk));
        }
        if (!abort.signal.aborted) {
          write("\r\n\x1b[2m── recorded session ended — launch a live one to try it yourself ──\x1b[0m\r\n");
          setPhase("ended");
        }
      } catch {
        if (!abort.signal.aborted) {
          write("\r\n\x1b[31mdemo unavailable right now — try the quickstart instead.\x1b[0m\r\n");
          setPhase("ended");
        }
      }
    },
    [setPhase, write]
  );

  const connect = useCallback(
    (session: Required<Pick<SessionResponse, "url" | "token" | "start">> & SessionResponse) => {
      const ws = new WebSocket(`${session.url}?token=${encodeURIComponent(session.token)}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: "start",
            command: session.start.command,
            args: session.start.args,
            env: session.start.env,
            cwd: session.start.cwd,
            cols: dimsRef.current.cols,
            rows: dimsRef.current.rows
          })
        );
        setPhase("live");
        setNote(null);
        if (session.expiresAt !== undefined) setExpiresAt(session.expiresAt);
        termRef.current?.focus();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          write(new Uint8Array(event.data));
          return;
        }
        try {
          const msg = JSON.parse(event.data as string) as { type?: string; code?: number };
          if (msg.type === "exit") {
            endSession(`process exited${typeof msg.code === "number" ? ` (code ${msg.code})` : ""}.`);
          }
        } catch {
          write(event.data as string);
        }
      };

      ws.onclose = () => {
        if (phaseRef.current === "live") endSession("session closed.");
      };
      ws.onerror = () => {
        if (phaseRef.current === "live") {
          endSession("connection lost.");
        } else {
          void startReplay("live session failed to connect — showing a recording");
        }
      };
    },
    [endSession, setPhase, startReplay, write]
  );

  const launch = useCallback(async () => {
    replayAbortRef.current?.abort();
    setPhase("launching");
    setNote(null);
    write("\x1b[2J\x1b[H\x1b[2mbooting a fresh sandbox vm (this takes a few seconds)...\x1b[0m\r\n");
    try {
      const res = await fetch("/api/demo/session", { method: "POST" });
      const body = (await res.json()) as SessionResponse;
      if (body.url !== undefined && body.token !== undefined && body.start !== undefined) {
        sandboxRef.current = body.sandboxName ?? null;
        write("\x1b[2m─ attaching terminal ─\x1b[0m\r\n");
        connect({ ...body, url: body.url, token: body.token, start: body.start });
        return;
      }
      if (body.busy === true) {
        void startReplay("all live seats are taken right now — showing a recording");
        return;
      }
      void startReplay("live demo is offline — showing a recording");
    } catch {
      void startReplay("live demo is unreachable — showing a recording");
    }
  }, [connect, setPhase, startReplay, write]);

  const sendSuggestion = useCallback((text: string) => {
    const ws = wsRef.current;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(new TextEncoder().encode(text));
    termRef.current?.focus();
  }, []);

  const onData = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data));
    }
  }, []);

  const onResize = useCallback((cols: number, rows: number) => {
    dimsRef.current = { cols, rows };
    const ws = wsRef.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }, []);

  // Session countdown.
  useEffect(() => {
    if (expiresAt === null) {
      setRemaining(null);
      return;
    }
    const tick = () => {
      const ms = expiresAt - Date.now();
      if (ms <= 0) {
        setRemaining("0:00");
        return;
      }
      const totalSeconds = Math.floor(ms / 1000);
      setRemaining(`${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  // Release the sandbox when the visitor navigates away.
  useEffect(() => {
    const onPageHide = () => stopSandbox();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      replayAbortRef.current?.abort();
      wsRef.current?.close();
      stopSandbox();
    };
  }, [stopSandbox]);

  const live = phase === "live";

  return (
    <div className="overflow-hidden rounded-xl border bg-[#0d1117] text-left shadow-lg">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-2 truncate font-mono text-xs text-white/60">
          fusionkit codex — vercel sandbox
        </span>
        <span className="ml-auto flex items-center gap-3">
          {live && remaining !== null && (
            <span className="font-mono text-xs text-white/50">{remaining}</span>
          )}
          {live && (
            <button
              type="button"
              onClick={() => endSession("session ended.")}
              className="rounded-md border border-white/15 px-2 py-0.5 text-xs text-white/70 transition-colors hover:bg-white/10"
            >
              End session
            </button>
          )}
        </span>
      </div>

      <div className="relative h-[26rem]">
        <Terminal
          ref={termRef}
          autoResize
          cursorBlink
          onData={onData}
          onResize={onResize}
          className="h-full w-full [--wterm-bg:#0d1117]"
          style={{ height: "100%" }}
        />
        {(phase === "idle" || phase === "ended") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[#0d1117]/85 backdrop-blur-[2px]">
            {phase === "ended" && (
              <p className="px-6 text-center text-sm text-white/60">
                Session over. Boot another sandbox to keep exploring.
              </p>
            )}
            <button
              type="button"
              onClick={() => void launch()}
              className="rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-black transition-transform hover:scale-[1.02]"
            >
              {phase === "ended" ? "Relaunch demo" : "Launch live demo"}
            </button>
            <p className="max-w-md px-6 text-center text-xs text-white/40">
              Boots a real VM running <code className="text-white/60">fusionkit codex</code> over a
              tiny repo with a planted bug — a panel of open models answers every turn.
            </p>
          </div>
        )}
        {phase === "launching" && (
          <div className="pointer-events-none absolute right-3 top-2 rounded-md bg-white/10 px-2 py-1 font-mono text-xs text-white/70">
            starting…
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-2.5">
        {live ? (
          <>
            <span className="text-xs text-white/40">Try:</span>
            {SUGGESTIONS.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => sendSuggestion(text)}
                className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70 transition-colors hover:bg-white/10"
              >
                {text}
              </button>
            ))}
            <span className="text-xs text-white/30">…then press Enter</span>
          </>
        ) : (
          <span className="text-xs text-white/40">
            {note ??
              "Interactive: type into the terminal once the session starts. Sessions run on Vercel Sandbox with OpenRouter free models."}
          </span>
        )}
      </div>
    </div>
  );
}
