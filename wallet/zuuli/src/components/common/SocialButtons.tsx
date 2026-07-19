// Real social login (X / Google / GitHub) — desktop RFC 8252 loopback
// transport on Tauri, a popup fallback on the web (see
// `@/lib/oauth/transport.ts`), wired to `dj.apps.social` on the backend.
//
// A button renders ONLY for a provider `useSocialProviders()` reports as
// configured (GET /api/auth/social/providers/). With nothing configured —
// the default, and the only state today — the list is empty and this shows
// nothing but a subtle "more coming" line: fully inert until the backend
// owner sets up provider credentials.
//
// Used both as a login method (`associate: false`, the login chooser,
// features/auth) and to link a provider identity to the current account
// (`associate: true`, the profile "Linked identities" card,
// features/profile/LinkedAccounts) — same component, same gating, mirroring
// how `useZcashLogin`/`useZcashAssociate` share one stepper. Lives in
// `components/common` (not a feature) so both can use it without crossing
// the feature-isolation boundary.

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSocialProviders } from "@/hooks/useSocialProviders";
import { auth } from "@/lib/api/free2z";
import { useSession } from "@/store/session";
import type { SocialProvider } from "@/lib/api/types";

const PROVIDER_NAME: Record<SocialProvider, string> = {
  x: "X",
  google: "Google",
  github: "GitHub",
};

/** Monogram tile standing in for a brand mark (no external brand assets). */
function Monogram({ children }: { children: ReactNode }) {
  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded bg-muted-foreground/20 text-[11px] font-bold text-muted-foreground"
      aria-hidden
    >
      {children}
    </span>
  );
}

const PROVIDER_MARK: Record<SocialProvider, ReactNode> = {
  x: <Monogram>X</Monogram>,
  google: <Monogram>G</Monogram>,
  github: <Monogram>gh</Monogram>,
};

export interface SocialButtonsProps {
  /** Link to the signed-in account instead of signing in fresh. */
  associate?: boolean;
  /** Providers to skip a button for (already linked — profile view only). */
  alreadyLinked?: SocialProvider[];
  /** Called after a successful associate (e.g. close a dialog, refresh a badge). */
  onLinked?: (provider: SocialProvider) => void;
  /** Shown when every configured provider is already linked / none configured. */
  emptyState?: ReactNode;
}

const DEFAULT_EMPTY_STATE = (
  <p className="text-center text-xs text-muted-foreground">
    More sign-in options coming soon.
  </p>
);

export function SocialButtons({
  associate = false,
  alreadyLinked,
  onLinked,
  emptyState = DEFAULT_EMPTY_STATE,
}: SocialButtonsProps) {
  const { providers: configured, loading } = useSocialProviders();
  const navigate = useNavigate();
  const setUser = useSession((s) => s.setUser);
  const [pending, setPending] = useState<SocialProvider | null>(null);

  const providers = configured.filter((p) => !alreadyLinked?.includes(p));

  if (loading) return null;
  if (providers.length === 0) return <>{emptyState}</>;

  async function handleClick(provider: SocialProvider) {
    if (pending) return;
    setPending(provider);
    try {
      const user = await auth.socialLogin(provider, { associate });
      setUser(user);
      const name = PROVIDER_NAME[provider];
      if (associate) {
        toast.success(`${name} linked`, {
          description: `This ${name} identity is now linked to your account.`,
        });
        onLinked?.(provider);
      } else {
        toast.success("Welcome to ZUULI", {
          description: `Signed in with ${name}.`,
        });
        navigate("/");
      }
    } catch (e) {
      toast.error(associate ? "Couldn't link that account" : "Couldn't sign in", {
        description: e instanceof Error ? e.message : "Please try again.",
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          className="w-full justify-center gap-2"
          disabled={pending !== null}
          onClick={() => void handleClick(provider)}
        >
          {pending === provider ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            PROVIDER_MARK[provider]
          )}
          {associate
            ? `Link ${PROVIDER_NAME[provider]}`
            : `Continue with ${PROVIDER_NAME[provider]}`}
        </Button>
      ))}
    </div>
  );
}
