import { useCallback, useEffect, useRef, useState } from "react";
import {
  beginRemoteLoad,
  initialRemoteData,
  remoteFailure,
  remoteSuccess,
  type RemoteDataState,
} from "@/lib/remote-data";

interface AsyncState<T> extends RemoteDataState<T> {
  reload: () => void;
}

function sameDependencies(
  previous: React.DependencyList,
  current: React.DependencyList,
): boolean {
  return (
    previous.length === current.length &&
    previous.every((value, index) => Object.is(value, current[index]))
  );
}

/**
 * Run an async loader on mount (and when deps change). Ignores results from
 * stale invocations. `reload()` re-runs on demand.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: React.DependencyList = [],
): AsyncState<T> {
  const [state, setState] = useState<RemoteDataState<T>>(() =>
    initialRemoteData<T>(),
  );
  const [nonce, setNonce] = useState(0);
  const idRef = useRef(0);
  const committedDepsRef = useRef<React.DependencyList>([...deps]);

  // Effects run after render. Hide the prior resource synchronously so a route
  // or search-key change cannot briefly attribute its data or error (including
  // an authoritative 404) to the new key.
  const dependencyChanged = !sameDependencies(committedDepsRef.current, deps);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const resourceChanged = !sameDependencies(committedDepsRef.current, deps);
    committedDepsRef.current = [...deps];
    const id = ++idRef.current;
    let active = true;
    setState((current) =>
      beginRemoteLoad(current, { retainData: !resourceChanged }),
    );
    loader()
      .then((res) => {
        if (active && idRef.current === id) {
          setState(remoteSuccess(res));
        }
      })
      .catch((e: unknown) => {
        if (active && idRef.current === id) {
          setState((current) => remoteFailure(current, e));
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const visibleState = dependencyChanged
    ? beginRemoteLoad(state, { retainData: false })
    : state;

  return { ...visibleState, reload };
}
