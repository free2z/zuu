// Which social providers (X / Google / GitHub) the backend currently has
// OAuth credentials configured for — shared by the login chooser
// (`SocialButtons` in features/auth) and the profile "Linked identities"
// card (features/profile/LinkedAccounts), both of which gate their buttons
// on this instead of assuming a provider works.

import { useMemo } from "react";
import { useAsync } from "./useAsync";
import { auth } from "@/lib/api/free2z";
import type { SocialProvider } from "@/lib/api/types";
import { SOCIAL_PROVIDERS } from "@/lib/api/types";

export interface SocialProvidersResult {
  /** Providers the backend reports as configured, in display order. Empty
   * (not just loading) until at least one provider is actually usable —
   * today that's always empty, since nothing is configured yet. */
  providers: SocialProvider[];
  loading: boolean;
}

export function useSocialProviders(): SocialProvidersResult {
  const { data, loading } = useAsync(() => auth.socialProviders(), []);

  const providers = useMemo(
    () => SOCIAL_PROVIDERS.filter((p) => data?.[p]),
    [data],
  );

  return { providers, loading };
}
