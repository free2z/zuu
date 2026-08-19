import { useCallback, useEffect, useMemo, useRef } from "react";

export type IsCurrentAttempt = () => boolean;

/**
 * Component-owned generation fence for async authentication work.
 *
 * Native invokes and OAuth handoffs cannot always be cancelled once
 * dispatched, so every awaited continuation must prove that its component and
 * generation are still current before publishing UI or session state.
 */
export function useAttemptLease() {
  const generation = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  const begin = useCallback((): IsCurrentAttempt => {
    const attempt = ++generation.current;
    return () => mounted.current && generation.current === attempt;
  }, []);

  const invalidate = useCallback(() => {
    generation.current += 1;
  }, []);

  return useMemo(() => ({ begin, invalidate }), [begin, invalidate]);
}
