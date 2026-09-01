import type { StreamKind } from "@/lib/api/types";

export type ViewerEntryState = "checking-session" | "creator-blocked" | "allowed";

/**
 * The public backend route is intentionally overloaded for host start and
 * viewer join. Until session hydration proves who is clicking, issuing its
 * POST would risk treating the creator's viewer-page click as host authority.
 */
export function viewerEntryState(options: {
  sessionLoading: boolean;
  viewerUsername?: string;
  creatorUsername: string;
  kind: StreamKind;
}): ViewerEntryState {
  if (options.sessionLoading) return "checking-session";
  if (
    options.kind !== "private" &&
    options.viewerUsername?.toLowerCase() ===
      options.creatorUsername.toLowerCase()
  ) {
    return "creator-blocked";
  }
  return "allowed";
}
