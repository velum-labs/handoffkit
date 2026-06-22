"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { FusionRoutingConfig, ProviderStatus, RoutingDecisionEvent } from "./types";

export type RoutingConfigResponse = {
  repoRoot: string;
  configPath: string;
  routing: FusionRoutingConfig | null;
  error?: string;
};

/** Fetch routing config from the API. */
export function useRoutingConfig(): {
  data: RoutingConfigResponse | undefined;
  loading: boolean;
  error: string | undefined;
  refetch: () => void;
} {
  const [data, setData] = useState<RoutingConfigResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/routing/config")
      .then(async (response) => {
        const body = (await response.json()) as RoutingConfigResponse & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body;
      })
      .then((value) => {
        if (!cancelled) {
          setData(value);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refetch: () => setTick((value) => value + 1) };
}

/** Fetch provider status rows. */
export function useRoutingProviders(): {
  providers: ProviderStatus[];
  loading: boolean;
  error: string | undefined;
  refetch: () => void;
} {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch("/api/routing/providers")
      .then(async (response) => {
        const body = (await response.json()) as { providers?: ProviderStatus[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body.providers ?? [];
      })
      .then((rows) => {
        if (!cancelled) {
          setProviders(rows);
          setError(undefined);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { providers, loading, error, refetch: () => setTick((value) => value + 1) };
}

const MAX_DECISIONS = 100;

/**
 * Subscribe to `/api/routing/decisions` SSE and maintain a newest-first list of
 * routing decisions for the overview page.
 */
export function useRoutingDecisions(): {
  decisions: RoutingDecisionEvent[];
  connected: boolean;
  error: string | undefined;
} {
  const [decisions, setDecisions] = useState<RoutingDecisionEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const seen = useRef(new Set<string>());

  const push = useCallback((event: RoutingDecisionEvent) => {
    if (seen.current.has(event.id)) return;
    seen.current.add(event.id);
    setDecisions((prev) => [event, ...prev].slice(0, MAX_DECISIONS));
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/routing/decisions");
    source.addEventListener("routing.decision", (message) => {
      try {
        push(JSON.parse(message.data) as RoutingDecisionEvent);
        setConnected(true);
        setError(undefined);
      } catch {
        // ignore malformed frames
      }
    });
    source.onopen = () => setConnected(true);
    source.onerror = () => {
      setConnected(false);
      setError("decision stream disconnected — reconnecting");
    };
    return () => source.close();
  }, [push]);

  return { decisions, connected, error };
}
