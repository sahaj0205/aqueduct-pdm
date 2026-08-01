/**
 * Runs a read against the data layer and re-runs it whenever a mutation lands.
 *
 * WHY IT SUBSCRIBES TO THE STORE. A screen showing the worklist has to update the
 * moment another screen dismisses an advisory, without either screen knowing the other
 * exists. Subscribing to `store`'s version counter is how — every mutation bumps it,
 * every mounted `useData` call re-fetches. When the backend arrives this becomes a
 * polling or websocket hook instead; nothing that calls it changes.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "./store.ts";

interface Result<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useData<T>(fn: () => Promise<T>, deps: unknown[] = []): Result<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fnRef.current().then(
      (result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      },
      (cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);

  useEffect(() => store.subscribe(run), [run]);

  return { data, loading, error, reload: run };
}
