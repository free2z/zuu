import { useCallback, useEffect, useRef, useState } from "react";

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Run an async loader on mount (and when deps change). Ignores results from
 * stale invocations. `reload()` re-runs on demand.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: React.DependencyList = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const idRef = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const id = ++idRef.current;
    setLoading(true);
    setError(null);
    loader()
      .then((res) => {
        if (idRef.current === id) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (idRef.current === id) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, loading, error, reload };
}
