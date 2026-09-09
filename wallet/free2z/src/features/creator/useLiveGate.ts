import { useEffect, useState } from "react";
import { live } from "@/lib/api/free2z";

/**
 * Resolve whether a creator is live, fast AND accurate:
 *
 *  1. **Instant** — seed state from `payloadIsLive` (the server-computed
 *     `is_live` on the creator payload), so the very first render gates the
 *     live marker correctly with NO network request on mount.
 *  2. **Graceful fallback** — if the payload omits the field (`undefined`,
 *     e.g. an older backend mid-deploy), probe the cheap `live.status`
 *     endpoint once on mount so nothing breaks during the deploy window.
 *  3. **Accurate over time** — a creator can go live/offline while the profile
 *     is open, so poll the same light `live.status` endpoint on a 30s interval
 *     and correct the button. We never refetch the heavy creator profile here.
 *
 * The interval is cleared and late results are ignored on unmount / username
 * change; a request already in flight may still finish.
 */
const LIVE_POLL_MS = 30_000;

export function useLiveGate(
  username: string,
  payloadIsLive: boolean | undefined,
): boolean {
  // Initialise from the payload so the first paint is already correct.
  const [isLive, setIsLive] = useState<boolean>(payloadIsLive ?? false);
  // Track whether THIS mount has ever had a definitive answer, so an initial
  // `undefined` payload triggers the fallback probe immediately.
  const hasPayload = payloadIsLive !== undefined;

  useEffect(() => {
    // Reset to the payload value whenever we switch creators (or the payload
    // arrives) — keeps the instant gate correct without waiting on a probe.
    setIsLive(payloadIsLive ?? false);

    let alive = true;
    const probe = async () => {
      const s = await live.status(username);
      if (alive) setIsLive(s.live);
    };
    const refresh = () => {
      void probe().catch(() => {
        // Keep the last known value on any failed probe rather than flicker.
      });
    };

    // Fallback: only probe on mount when the payload couldn't tell us.
    if (!hasPayload) refresh();

    // Light poll keeps the button accurate while the profile stays mounted.
    const timer = setInterval(refresh, LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [username, payloadIsLive, hasPayload]);

  return isLive;
}
