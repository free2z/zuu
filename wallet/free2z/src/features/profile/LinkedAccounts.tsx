// "Linked identities" — shows which keys and accounts are associated with the
// signed-in user's free2z identity, and links the ones this surface can link.
//
// ZUULI's copy of this card also *performs* the Zcash association: it runs the
// same challenge → sign → verify stepper as Login with Zcash
// (`useZcashAssociate`, built on the shared `useZcashChallengeFlow`), reaching
// `@/lib/wallet/bridge` → `plugin:zcash|sign_message` and `@/store/wallet` for
// the identity, plus `SeedReveal` for the mandatory backup.
//
// None of that can exist here. This app registers no `invoke_handler`, links
// neither wallet plugin, and carries no `zcash:*` capability (#904, #367), so
// the whole flow is absent rather than stubbed behind a button that would throw
// — the same call #912 made for Login with Zcash. What remains is genuinely
// HTTP: the *already linked* Zcash identity is read off the session user
// (`zcash_identity`, returned by the account endpoint), and social linking is
// an OAuth round trip with no key involved.
//
// Linking a NEW Zcash key from this surface is a cross-surface grant of the
// `sign-challenge` family, which #904 deliberately does not wire first and
// which ships no transport before #461.

import { Github, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";
import { SocialButtons } from "@/components/common/SocialButtons";
import { BidiIdentifier } from "@/components/common/BidiIdentifier";
import { MESSAGE_KEYS } from "@/i18n/messages";
import {
  SOCIAL_PROVIDERS,
  type AuthUser,
  type SocialProvider,
} from "@/lib/api/types";
import type { ReactNode } from "react";

interface IdentityRowProps {
  icon: ReactNode;
  label: string;
  detail: ReactNode;
  action: ReactNode;
}

function IdentityRow({ icon, label, detail, action }: IdentityRowProps) {
  return (
    <div className="flex flex-col items-stretch gap-3 rounded-lg border border-border/60 bg-background/40 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="font-medium">{label}</div>
          <div className="break-all text-xs text-muted-foreground">
            {detail}
          </div>
        </div>
      </div>
      <div className="shrink-0 [&>*]:w-full sm:[&>*]:w-auto">{action}</div>
    </div>
  );
}

const SOCIAL_LABEL: Record<SocialProvider, string> = {
  x: "X",
  google: "Google",
  github: "GitHub",
};

/**
 * Why "Link Zcash key" is not offered here.
 *
 * Signing the association challenge requires the spending key's seed, held by
 * ZUULI's `tauri-plugin-zcash`. Stating the omission is the point: a button
 * that opens a stepper which can never reach step one is worse than its
 * absence, and hiding the row entirely would leave a user who *has* linked a
 * key unable to see it.
 */
function ZcashLinkPending() {
  const { t } = useTranslation();
  return (
    <Callout
      tone="info"
      icon={ShieldCheck}
      title={t(MESSAGE_KEYS.profileZcashLinkPendingTitle)}
      data-profile-zcash-link-pending
    >
      {t(MESSAGE_KEYS.profileZcashLinkPendingBody)}
    </Callout>
  );
}

export function LinkedAccounts({ user }: { user: AuthUser }) {
  const identity = user.zcash_identity;
  const did = identity ? `did:zcash:${identity}` : null;
  const linkedSocial = SOCIAL_PROVIDERS.filter(
    (p) => user.social_identities?.[p],
  );

  return (
    <Card className="space-y-4 rounded-xl border-border/60 bg-card/60 p-5">
      <div>
        <h2 className="font-semibold">Linked identities</h2>
        <p className="text-sm text-muted-foreground">
          Associate other keys and accounts with your free2z identity.
        </p>
      </div>

      <div className="space-y-3">
        <IdentityRow
          icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
          label="Zcash"
          detail={
            did && identity ? (
              <BidiIdentifier
                value={did}
                shorten
                head={16}
                tail={6}
                className="mono-id font-mono"
              />
            ) : (
              "Not linked"
            )
          }
          action={
            identity ? (
              <Badge variant="success">Linked</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                Soon
              </Badge>
            )
          }
        />

        {identity ? null : <ZcashLinkPending />}

        {/* Already-linked social identities, observed by this session after a
            successful `auth.socialLogin(provider, { associate: true })`. */}
        {linkedSocial.map((provider) => (
          <IdentityRow
            key={provider}
            icon={<Github className="h-4 w-4" aria-hidden />}
            label={SOCIAL_LABEL[provider]}
            detail="Linked"
            action={<Badge variant="success">Linked</Badge>}
          />
        ))}

        {/*
          Real, gated social linking (X / Google / GitHub) — a button renders
          per provider `useSocialProviders()` reports configured on the
          backend AND not already linked above. With nothing configured (the
          default, and the only state today) this falls back to the exact
          "Coming soon" row that used to be hardcoded here.
        */}
        <SocialButtons
          associate
          alreadyLinked={linkedSocial}
          emptyState={
            <IdentityRow
              icon={<Github className="h-4 w-4" aria-hidden />}
              label="X · Google · GitHub"
              detail="Coming soon"
              action={
                <Badge variant="outline" className="text-muted-foreground">
                  Soon
                </Badge>
              }
            />
          }
        />
      </div>
    </Card>
  );
}
