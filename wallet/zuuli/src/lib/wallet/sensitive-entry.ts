import { useCallback, useEffect, useRef, useState } from "react";
import {
  SensitiveEntrySession,
  bindSensitiveEntryLifecycle,
  type SensitiveEntryPurpose,
} from "../../../../shared/sensitive-entry-session";
import { wallet } from "./bridge";

const authority = {
  begin: (purpose: SensitiveEntryPurpose) =>
    wallet.beginSensitiveEntry(purpose).then(({ token }) => token),
  end: (token: string, purpose: SensitiveEntryPurpose) =>
    wallet.endSensitiveDisplay(token, purpose),
};

export function useSensitiveMnemonicEntry(
  purpose: SensitiveEntryPurpose,
  active: boolean,
  clearRenderer: () => void,
) {
  const [editable, setEditable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<SensitiveEntrySession | null>(null);
  if (!session.current) {
    session.current = new SensitiveEntrySession(
      authority,
      purpose,
      clearRenderer,
      setEditable,
    );
  }

  const acquire = useCallback(async () => {
    setError(null);
    try {
      await session.current!.acquire();
    } catch {
      setError("Secure recovery-phrase entry is unavailable.");
    }
  }, []);
  const clear = useCallback(() => session.current!.clear(), []);

  useEffect(() => {
    if (!active) {
      void clear();
      return;
    }
    void acquire();
    return bindSensitiveEntryLifecycle(
      window,
      document,
      () => document.visibilityState === "visible",
      clear,
      acquire,
    );
  }, [active, acquire, clear]);

  return { editable, error, retry: acquire, clear };
}
