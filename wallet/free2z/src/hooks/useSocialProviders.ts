// Which social providers (X / Google / GitHub) the backend reports ready for
// this exact web/desktop/mobile callback transport — shared by the login chooser
// (`SocialButtons` in features/auth) and the profile "Linked identities"
// card (features/profile/LinkedAccounts), both of which gate their buttons
// on this instead of assuming a provider works.

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
