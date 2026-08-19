import { ApiError } from "./api/http";

/**
 * The data from the last confirmed success is deliberately independent from
 * the current request. A transient refresh failure must not erase trustworthy
 * financial history (or turn any successful result into an empty state).
 */
export interface RemoteDataState<T> {
  data: T | null;
  loading: boolean;
  error: unknown | null;
}

export type RemoteView =
  | "loading"
  | "refreshing"
  | "error"
  | "stale-error"
  | "empty"
  | "ready";

export function initialRemoteData<T>(): RemoteDataState<T> {
  return { data: null, loading: true, error: null };
}

export function beginRemoteLoad<T>(
  state: RemoteDataState<T>,
  { retainData = true }: { retainData?: boolean } = {},
): RemoteDataState<T> {
  return {
    data: retainData ? state.data : null,
    loading: true,
    // A same-resource retry keeps its failure visible so the retry control can
    // report progress. A dependency/resource change clears both data and error
    // because neither may be attributed to the new key.
    error: retainData ? state.error : null,
  };
}

export function remoteSuccess<T>(data: T): RemoteDataState<T> {
  return { data, loading: false, error: null };
}

export function remoteFailure<T>(
  state: RemoteDataState<T>,
  error: unknown,
): RemoteDataState<T> {
  const normalized =
    error instanceof Error
      ? error
      : new Error(
          typeof error === "string" && error.trim()
            ? error
            : "The request failed.",
        );
  return { ...state, loading: false, error: normalized };
}

/** Resolve display truth without conflating a failed request with emptiness. */
export function remoteView<T>(
  state: RemoteDataState<T>,
  isEmpty: (data: T) => boolean,
): RemoteView {
  if (state.error !== null) {
    return state.data === null ? "error" : "stale-error";
  }
  if (state.data === null) return "loading";
  if (state.loading) return "refreshing";
  return isEmpty(state.data) ? "empty" : "ready";
}

/** Only an explicit HTTP 404 is authoritative absence. */
export function isConfirmedNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * A retained response is safe only for the resource key that produced it.
 * This prevents a failed search/profile navigation from showing another
 * query's successful data as if it belonged to the new request.
 */
export interface KeyedRemoteData<K, T> {
  key: K;
  value: T;
}

export function currentResourceData<K, T>(
  data: KeyedRemoteData<K, T> | null,
  key: K,
): T | null {
  return data !== null && Object.is(data.key, key) ? data.value : null;
}
