import { useCallback, useEffect, useRef, useState } from "react";

export type ResourceStatus =
  | "loading"
  | "success"
  | "empty"
  | "stale"
  | "error";
export interface ResourceState<T> {
  key: string;
  data?: T;
  status: ResourceStatus;
  error?: Error;
  refreshedAt?: number;
  refreshing: boolean;
}
export function resolvedResource<T>(key: string, data: T): ResourceState<T> {
  return {
    key,
    data,
    status: Array.isArray(data) && !data.length ? "empty" : "success",
    refreshedAt: Date.now(),
    refreshing: false,
  };
}
export function rejectedResource<T>(
  previous: ResourceState<T>,
  error: unknown,
): ResourceState<T> {
  return {
    ...previous,
    status: previous.data === undefined ? "error" : "stale",
    error: error instanceof Error ? error : new Error(String(error)),
    refreshing: false,
  };
}

/** A resource retains its own last good response; requests from old scopes cannot commit. */
export function useResource<T>(
  key: string,
  load: () => Promise<T>,
  interval = 0,
) {
  const loader = useRef(load);
  loader.current = load;
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const inFlight = useRef<{ key: string; request: number } | undefined>(
    undefined,
  );
  const [state, setState] = useState<ResourceState<T>>({
    key,
    status: "loading",
    refreshing: true,
  });
  const refresh = useCallback(async () => {
    if (inFlight.current?.key === key) return;
    const request = ++generation.current;
    inFlight.current = { key, request };
    setState((previous) =>
      previous.key === key
        ? { ...previous, refreshing: true }
        : { key, status: "loading", refreshing: true },
    );
    try {
      const data = await loader.current();
      if (request === generation.current && currentKey.current === key)
        setState(resolvedResource(key, data));
    } catch (error) {
      if (request === generation.current && currentKey.current === key)
        setState((previous) =>
          rejectedResource(
            previous.key === key
              ? previous
              : { key, status: "loading", refreshing: true },
            error,
          ),
        );
    } finally {
      if (inFlight.current?.request === request) inFlight.current = undefined;
    }
  }, [key]);
  useEffect(() => {
    void refresh();
    const timer = interval
      ? window.setInterval(() => void refresh(), interval)
      : undefined;
    return () => {
      generation.current++;
      inFlight.current = undefined;
      if (timer) window.clearInterval(timer);
    };
  }, [refresh, interval]);
  // Do not render even one frame of another repository while the effect starts.
  return {
    ...(state.key === key
      ? state
      : { key, status: "loading" as const, refreshing: true }),
    refresh,
  };
}
