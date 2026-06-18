"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { EnvironmentRollup, ModelRollup } from "./rollups";
import type { SessionDetail } from "./sessions";
import type { RawEnvironment } from "./types";
import { useTraceStream } from "./useLive";

/**
 * Client-side data layer for the dashboard. Both hooks render an initial fetch
 * and then live-refresh off the collector's SSE stream (debounced), so an open
 * page tails trajectory + judge events as a run unfolds.
 */

export type { RawEnvironment };

export type SessionSummary = {
  traceId: string;
  startedAt: number;
  lastTs: number;
  status: string;
  dialect: string | null;
  repo: string | null;
  environment: RawEnvironment | null;
  finalOutput: string | null;
  eventCount: number;
  durationMs: number;
};

const REFRESH_DEBOUNCE_MS = 300;

export function useSessions(): {
  sessions: SessionSummary[];
  loading: boolean;
  error?: string;
  refetch: () => void;
} {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const refetch = useCallback(() => {
    fetch("/api/sessions")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { sessions: SessionSummary[] };
      })
      .then((data) => {
        setSessions(data.sessions);
        setError(undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => refetch(), [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTraceStream(
    useCallback(() => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
    }, [refetch])
  );

  return { sessions, loading, error, refetch };
}

function useLiveResource<T>(url: string, key: string, initial: T): { data: T; loading: boolean; error?: string; refetch: () => void } {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const refetch = useCallback(() => {
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as Record<string, T>;
      })
      .then((payload) => {
        setData(payload[key]);
        setError(undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [url, key]);

  useEffect(() => refetch(), [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTraceStream(
    useCallback(() => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
    }, [refetch])
  );

  return { data, loading, error, refetch };
}

export function useModels(): { models: ModelRollup[]; loading: boolean; error?: string } {
  const { data, loading, error } = useLiveResource<ModelRollup[]>("/api/models", "models", []);
  return { models: data, loading, error };
}

export function useEnvironments(): { environments: EnvironmentRollup[]; loading: boolean; error?: string } {
  const { data, loading, error } = useLiveResource<EnvironmentRollup[]>(
    "/api/environments",
    "environments",
    []
  );
  return { environments: data, loading, error };
}

export function useSessionDetail(traceId: string): {
  session: SessionDetail | undefined;
  loading: boolean;
  error?: string;
  live: boolean;
} {
  const [session, setSession] = useState<SessionDetail | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [live, setLive] = useState(false);

  const refetch = useCallback(() => {
    fetch(`/api/sessions/${encodeURIComponent(traceId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { session: SessionDetail };
      })
      .then((data) => {
        setSession(data.session);
        setError(undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [traceId]);

  useEffect(() => refetch(), [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useTraceStream(
    useCallback(
      (event: Record<string, unknown>) => {
        if (event.trace_id !== traceId) return;
        setLive(true);
        if (timer.current !== undefined) clearTimeout(timer.current);
        timer.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
      },
      [traceId, refetch]
    )
  );

  return { session, loading, error, live };
}
