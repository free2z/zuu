// Which social providers (X / Google / GitHub) the backend reports ready for
// this exact web/desktop/mobile callback transport — used by the login chooser
// (`SocialButtons` in features/auth) to gate its buttons instead of assuming a
// provider works. The profile "Linked identities" card was the second consumer
// until #904 phase 4 moved it to `wallet/free2z`.

import { useMemo } from "react";
import { useAsync } from "./useAsync";
import { auth } from "@/lib/api/free2z";
import type { SocialProvider } from "@/lib/api/types";
import { configuredSocialProviders } from "@/lib/api/social-providers";

export interface SocialProvidersResult {
  /** Providers the backend reports ready for this transport, in display order. */
  providers: SocialProvider[];
  loading: boolean;
  /** Transport and contract failures stay distinct from valid all-unconfigured. */
  error: unknown | null;
  reload: () => void;
}

export function useSocialProviders(): SocialProvidersResult {
  const { data, loading, error, reload } = useAsync(
    () => auth.socialProviders(),
    [],
  );

  const providers = useMemo(
    () => (data ? configuredSocialProviders(data) : []),
    [data],
  );

  return { providers, loading, error, reload };
}
