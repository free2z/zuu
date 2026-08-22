import { cn } from "@/lib/utils";

/**
 * ZUULI mark — a shielded "Z" in a violet→fuchsia tile.
 *
 * The gradient is NOT decoration here: `scripts/brand-assets.mjs --check`
 * asserts that this component carries the same `from-primary` / `to-fuchsia-600`
 * endpoints as `assets/brand/logo.svg`, so the in-app mark and the installed
 * app icon can never drift apart. Flattening it is a brand decision, not a
 * styling one. The glow shadow that used to sit behind it was decoration, and
 * that is gone.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative grid place-items-center rounded-xl bg-gradient-to-br from-primary to-fuchsia-600 text-primary-foreground",
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-3/5 w-3/5" fill="none">
        <path
          d="M6 6h12L8 18h12"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className="h-9 w-9" />
      <div className="leading-none">
        <div className="text-lg font-semibold leading-6 tracking-[0.12em]">ZUULI</div>
        <div className="eyebrow text-muted-foreground">by 2Z Inc</div>
      </div>
    </div>
  );
}
