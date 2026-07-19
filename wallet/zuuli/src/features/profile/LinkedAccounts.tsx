// "Linked identities" — lets a signed-in user associate a Zcash key with
// their account (independent of whichever method they used to sign in).
//
// Runs the SAME challenge → sign → verify stepper as Login with Zcash
// (`useZcashAssociate`, built on the shared `useZcashChallengeFlow`), but the
// final call attaches the current session's knox token so free2z links the
// address instead of logging in. A 409 from the backend (address already
// linked elsewhere, or this account already has an identity) surfaces as a
// clear error on the "Linking to your account" step.
//
// This card is also the obvious extension point for future social logins
// (X / Google / GitHub) — see the placeholder rows below.

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  Check,
  Github,
  Loader2,
  RotateCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LINK_STEP_META, useZcashAssociate } from "@/features/auth/useZcashAssociate";
import { STEP_ORDER, type StepStatus } from "@/features/auth/useZcashChallengeFlow";
import { SeedReveal } from "@/features/auth/SeedReveal";
import { truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AuthUser } from "@/lib/api/types";

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") {
    return (
      <span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-500/15 text-emerald-400">
        <Check className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="grid h-8 w-8 place-items-center rounded-full bg-primary/15 text-primary shadow-glow">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="grid h-8 w-8 place-items-center rounded-full bg-destructive/15 text-destructive">
        <AlertCircle className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  return (
    <span className="grid h-8 w-8 place-items-center rounded-full border border-border bg-background/60 text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}

/** The link flow's body, swapped by phase — mirrors ZcashLoginFlow but scoped to linking. */
function ZcashLinkDialogBody({ onDone }: { onDone: () => void }) {
  const flow = useZcashAssociate();
  const {
    phase,
    steps,
    address,
    seedPhrase,
    error,
    start,
    createIdentity,
    confirmSeedSaved,
    retry,
  } = flow;

  // Kick the flow off as soon as the dialog opens — the user already opted
  // in by clicking "Link Zcash key".
  useEffect(() => {
    if (phase === "idle") start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "needsWallet" || phase === "creating") {
    const creating = phase === "creating";
    return (
      <div className="animate-slide-up space-y-5">
        <div className="rounded-lg border border-border bg-background/40 p-4">
          <p className="text-sm font-medium">No Zcash identity on this device</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one now, then it can be linked to your account.
          </p>
        </div>
        <Button
          size="lg"
          className="w-full"
          onClick={() => void createIdentity()}
          disabled={creating}
        >
          {creating ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="h-5 w-5" aria-hidden />
          )}
          {creating ? "Creating your identity…" : "Create a Zcash identity"}
        </Button>
      </div>
    );
  }

  if (phase === "seedReveal" && seedPhrase) {
    return <SeedReveal seedPhrase={seedPhrase} onConfirm={confirmSeedSaved} />;
  }

  if (phase === "success") {
    return (
      <div className="animate-fade-in space-y-4 py-6 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-400 shadow-glow">
          <Check className="h-7 w-7" aria-hidden />
        </span>
        <div>
          <p className="text-lg font-semibold">Zcash key linked</p>
          {address && (
            <code
              className="mt-1 block truncate font-mono text-xs text-muted-foreground"
              title={address}
            >
              {truncateAddress(address)}
            </code>
          )}
        </div>
        <Button className="w-full" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  // idle / running / error — the four-step stepper.
  return (
    <div className="animate-slide-up space-y-5">
      {address && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-4 py-2.5">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Linking
          </span>
          <code className="font-mono text-xs text-foreground" title={address}>
            {truncateAddress(address)}
          </code>
        </div>
      )}

      <ol className="space-y-1" aria-label="Linking progress">
        {STEP_ORDER.map((key, i) => {
          const status = steps[key];
          const meta = LINK_STEP_META[key];
          const isLast = i === STEP_ORDER.length - 1;
          return (
            <li key={key} className="relative flex gap-3 pb-4">
              {!isLast && (
                <span
                  className={cn(
                    "absolute left-4 top-9 h-[calc(100%-1.5rem)] w-px -translate-x-1/2 transition-colors",
                    status === "done" ? "bg-emerald-500/40" : "bg-border",
                  )}
                  aria-hidden
                />
              )}
              <StepIcon status={status} />
              <div className="min-w-0 flex-1 pt-1">
                <p
                  className={cn(
                    "text-sm font-medium transition-colors",
                    status === "pending" && "text-muted-foreground",
                    status === "error" && "text-destructive",
                  )}
                >
                  {meta.title}
                </p>
                {(status === "active" || status === "error") && (
                  <p className="mt-0.5 text-xs text-muted-foreground animate-fade-in">
                    {status === "error" ? error : meta.detail}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {phase === "error" && (
        <div className="space-y-3 animate-fade-in">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error ?? "The link could not be completed."}</span>
          </div>
          <Button className="w-full" onClick={retry}>
            <RotateCw className="h-4 w-4" aria-hidden />
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

function ZcashLinkDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link a Zcash key</DialogTitle>
          <DialogDescription>
            Sign a one-time challenge with your Zcash key to link it to this
            account. The key never leaves this device.
          </DialogDescription>
        </DialogHeader>
        {/* Remount on every open so a prior run's state never leaks in. */}
        {open && <ZcashLinkDialogBody key="link" onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

interface IdentityRowProps {
  icon: ReactNode;
  label: string;
  detail: ReactNode;
  action: ReactNode;
}

function IdentityRow({ icon, label, detail, action }: IdentityRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-background/40 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="font-medium">{label}</div>
          <div className="truncate text-xs text-muted-foreground">{detail}</div>
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

export function LinkedAccounts({ user }: { user: AuthUser }) {
  const identity = user.zcash_identity;
  const did = identity ? `did:zcash:${identity}` : null;

  const [dialogOpen, setDialogOpen] = useState(false);

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
              <code className="font-mono" title={did}>
                did:zcash:{truncateAddress(identity, 6, 6)}
              </code>
            ) : (
              "Not linked"
            )
          }
          action={
            identity ? (
              <Badge variant="success">Linked</Badge>
            ) : (
              <Button size="sm" onClick={() => setDialogOpen(true)}>
                Link Zcash key
              </Button>
            )
          }
        />

        {/*
          Extension point: future social identities (X, Google, GitHub, …)
          render here as additional IdentityRow entries once those OAuth
          flows exist server-side. Not built yet — see SocialSoon.tsx for the
          equivalent "coming soon" treatment on the login screen.
        */}
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
      </div>

      <ZcashLinkDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </Card>
  );
}
