import { useEffect, useRef, useState } from "react";
import { consumePaidIntent, type PaidIntent } from "@/lib/auth/paid-intent";
import { safeLoginDestination } from "@/lib/auth/login-destination";
import { useSession } from "@/store/session";

/**
 * Consume a paid-action draft once after commit. The ref survives React
 * StrictMode's development effect replay, while the session-storage record is
 * still destroyed before validation and can never be consumed on a later
 * mount.
 */
export function usePaidIntent(
  returnTo: unknown,
  expectedKinds: PaidIntent["kind"] | readonly PaidIntent["kind"][],
): PaidIntent | null {
  const user = useSession((state) => state.user);
  const sessionLoading = useSession((state) => state.loading);
  const destination = safeLoginDestination(returnTo);
  const kinds = Array.isArray(expectedKinds)
    ? expectedKinds.join(",")
    : expectedKinds;
  const consumeKey = `${destination}\u0000${kinds}`;
  const consumedKey = useRef<string | null>(null);
  const [result, setResult] = useState<{
    key: string;
    intent: PaidIntent | null;
  }>({ key: "", intent: null });

  useEffect(() => {
    // A guest returning with browser Back must not restore private input. The
    // login route owns abandonment cleanup; only a completed, bootstrapped
    // session is allowed to consume the one-shot record.
    if (sessionLoading || !user) return;
    if (consumedKey.current === consumeKey) return;
    consumedKey.current = consumeKey;
    setResult({
      key: consumeKey,
      intent: consumePaidIntent(destination, expectedKinds),
    });
  }, [consumeKey, destination, expectedKinds, sessionLoading, user]);

  return result.key === consumeKey ? result.intent : null;
}
