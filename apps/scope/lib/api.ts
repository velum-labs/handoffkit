"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CostRollup, EnvironmentRollup, JudgeRollup, ModelRollup } from "./rollups";
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
  promptPreview: string | null;
  finalOutput: string | null;
  spanCount: number;
  durationMs: number;
};

const REFRESH_DEBOUNCE_MS = 300;

export function useSessions(): {
  sessions: SessionSummary[];
  loading: boolean;
  error?: string;
  live: boolean;
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
  const live = useTraceStream(
    useCallback(() => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
    }, [refetch])
  );

  return { sessions, loading, error, live, refetch };
}

function useLiveResource<T>(url: string, key: string, initial: T): { data: T; loading: boolean; error?: string; live: boolean; refetch: () => void } {
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
  const live = useTraceStream(
    useCallback(() => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
    }, [refetch])
  );

  return { data, loading, error, live, refetch };
}

const EMPTY_COSTS: CostRollup = {
  totalUsd: 0,
  entries: 0,
  unknownEntries: 0,
  sessionsWithCost: 0,
  perModel: [],
  perStage: []
};

export function useModels(): {
  models: ModelRollup[];
  costs: CostRollup;
  loading: boolean;
  error?: string;
  live: boolean;
} {
  const [models, setModels] = useState<ModelRollup[]>([]);
  const [costs, setCosts] = useState<CostRollup>(EMPTY_COSTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const refetch = useCallback(() => {
    fetch("/api/models")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { models: ModelRollup[]; costs?: CostRollup };
      })
      .then((payload) => {
        setModels(payload.models);
        setCosts(payload.costs ?? EMPTY_COSTS);
        setError(undefined);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => refetch(), [refetch]);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useTraceStream(
    useCallback(() => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
    }, [refetch])
  );

  return { models, costs, loading, error, live };
}

export function useJudge(): { judge: JudgeRollup | undefined; loading: boolean; error?: string; live: boolean } {
  const { data, loading, error, live } = useLiveResource<JudgeRollup | undefined>(
    "/api/judge",
    "judge",
    undefined
  );
  return { judge: data, loading, error, live };
}

export function useEnvironments(): {
  environments: EnvironmentRollup[];
  loading: boolean;
  error?: string;
  live: boolean;
} {
  const { data, loading, error, live } = useLiveResource<EnvironmentRollup[]>(
    "/api/environments",
    "environments",
    []
  );
  return { environments: data, loading, error, live };
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
  const live = useTraceStream(
    useCallback(
      (event: Record<string, unknown>) => {
        if (event.trace_id !== traceId) return;
        if (timer.current !== undefined) clearTimeout(timer.current);
        timer.current = setTimeout(refetch, REFRESH_DEBOUNCE_MS);
      },
      [traceId, refetch]
    )
  );

  return { session, loading, error, live };
}
