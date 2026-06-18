"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Subscribe to the collector's SSE stream and invoke a callback whenever a new
 * event lands. Used to live-refresh the sessions list and an open session.
 */
export function useTraceStream(onEvent: (event: Record<string, unknown>) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (message) => {
      try {
        handler.current(JSON.parse(message.data) as Record<string, unknown>);
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
    return () => source.close();
  }, []);
}

/** Fetch JSON, returning data + a manual refetch and loading flag. */
export function usePolling<T>(url: string, intervalMs = 0): {
  data: T | undefined;
  error: string | undefined;
  refetch: () => void;
} {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [url, tick]);

  useEffect(() => {
    if (intervalMs <= 0) return;
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return { data, error, refetch: () => setTick((value) => value + 1) };
}
