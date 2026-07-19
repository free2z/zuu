// The showpiece — Login with Zcash, rendered as an animated stepper.
//
// One <ZcashLoginFlow> owns the whole primary panel and swaps its body by
// phase: an initial call-to-action, the four-step crypto stepper, the
// create-identity + seed-backup detour, and success / error terminals.

import {
  AlertCircle,
  ArrowRight,
  Check,
  Fingerprint,
  Loader2,
  RotateCw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SeedReveal } from "./SeedReveal";
import {
  STEP_META,
  STEP_ORDER,
  useZcashLogin,
  type StepStatus,
} from "./useZcashLogin";

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

export function ZcashLoginFlow() {
  const flow = useZcashLogin();
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

  // ── Initial call-to-action ────────────────────────────────────────────────
  if (phase === "idle") {
    return (
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-lg border border-border bg-background/40 p-4">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
            <Fingerprint className="h-5 w-5" aria-hidden />
          </span>
          <p className="text-sm text-muted-foreground">
            Sign a one-time challenge with your Zcash key to prove it is yours.
            No password, no email, no third party — the key never leaves this
            device.
          </p>
        </div>
        <Button
          size="xl"
          className="w-full"
          onClick={start}
          aria-label="Login with Zcash"
        >
          <Sparkles className="h-5 w-5" aria-hidden />
          Login with Zcash
          <ArrowRight className="h-5 w-5" aria-hidden />
        </Button>
      </div>
    );
  }

  // ── No wallet yet — offer to mint an identity ─────────────────────────────
  if (phase === "needsWallet" || phase === "creating") {
    const creating = phase === "creating";
    return (
      <div className="animate-slide-up space-y-5">
        <div className="rounded-lg border border-border bg-background/40 p-4">
          <p className="text-sm font-medium">No Zcash identity on this device</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create one now. We generate a Zcash key that becomes your DID — your
            login, owned entirely by you.
          </p>
        </div>
        <Button
          size="xl"
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

  // ── Freshly created — back up the recovery phrase before continuing ───────
  if (phase === "seedReveal" && seedPhrase) {
    return <SeedReveal seedPhrase={seedPhrase} onConfirm={confirmSeedSaved} />;
  }

  // ── Success terminal ──────────────────────────────────────────────────────
  if (phase === "success") {
    return (
      <div className="animate-fade-in space-y-4 py-6 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-400 shadow-glow">
          <Check className="h-7 w-7" aria-hidden />
        </span>
        <div>
          <p className="text-lg font-semibold">Identity verified</p>
          <p className="text-sm text-muted-foreground">
            Signing you in to ZUULI…
          </p>
        </div>
      </div>
    );
  }

  // ── Running / error: the four-step stepper ────────────────────────────────
  return (
    <div className="animate-slide-up space-y-5">
      {address && (
        <div className="flex items-center justify-between rounded-lg border border-border bg-background/40 px-4 py-2.5">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Signing as
          </span>
          <code className="font-mono text-xs text-foreground" title={address}>
            {truncateAddress(address)}
          </code>
        </div>
      )}

      <ol className="space-y-1" aria-label="Login progress">
        {STEP_ORDER.map((key, i) => {
          const status = steps[key];
          const meta = STEP_META[key];
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
              {status === "active" && (
                <Badge variant="default" className="h-fit self-start">
                  working
                </Badge>
              )}
            </li>
          );
        })}
      </ol>

      {phase === "error" && (
        <div className="space-y-3 animate-fade-in">
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{error ?? "The login could not be completed."}</span>
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
