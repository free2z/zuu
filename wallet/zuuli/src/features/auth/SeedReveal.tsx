// Recovery-phrase backup gate.
//
// The phrase is the identity — whoever holds it *is* the account. So we blur it
// until the user deliberately reveals it, surface a hard-to-miss warning, and
// only allow continuing after they confirm they have written it down. The
// phrase is never copied to the clipboard automatically and never logged.

import { useState } from "react";
import { AlertTriangle, Check, Eye, EyeOff, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface SeedRevealProps {
  seedPhrase: string;
  onConfirm: () => void;
}

export function SeedReveal({ seedPhrase, onConfirm }: SeedRevealProps) {
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const words = seedPhrase.trim().split(/\s+/);

  return (
    <div className="animate-slide-up space-y-5">
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <ShieldAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
          aria-hidden
        />
        <div className="space-y-1 text-sm">
          <p className="font-semibold text-amber-300">
            This recovery phrase is your identity.
          </p>
          <p className="text-amber-200/80">
            Write these {words.length} words down in order and keep them
            offline. Anyone who sees them controls your account. We cannot
            recover them for you — there is no reset.
          </p>
        </div>
      </div>

      <div className="relative">
        <ol
          className={cn(
            "grid grid-cols-2 gap-2 sm:grid-cols-3",
            !revealed && "pointer-events-none select-none blur-md",
          )}
          aria-hidden={!revealed}
        >
          {words.map((word, i) => (
            <li
              key={`${i}-${word}`}
              className="flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-2"
            >
              <span className="w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {i + 1}
              </span>
              <span className="truncate font-mono text-sm">{word}</span>
            </li>
          ))}
        </ol>

        {!revealed && (
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="absolute inset-0 grid place-items-center rounded-lg bg-background/40 backdrop-blur-[2px] transition-colors hover:bg-background/25"
            aria-label="Reveal recovery phrase"
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-medium shadow-glow">
              <Eye className="h-4 w-4" aria-hidden />
              Tap to reveal
            </span>
          </button>
        )}
      </div>

      {revealed && (
        <div className="flex items-center justify-between animate-fade-in">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            Never share this. No one from 2Z will ever ask for it.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRevealed(false)}
          >
            <EyeOff className="h-4 w-4" aria-hidden />
            Hide
          </Button>
        </div>
      )}

      <Separator />

      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          disabled={!revealed}
          className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))] disabled:opacity-40"
        />
        <span className={cn(!revealed && "text-muted-foreground")}>
          I have written down my recovery phrase and stored it somewhere safe. I
          understand it cannot be recovered.
        </span>
      </label>

      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={!acknowledged}
        onClick={onConfirm}
      >
        <Check className="h-4 w-4" aria-hidden />
        I saved it — continue
      </Button>
    </div>
  );
}
