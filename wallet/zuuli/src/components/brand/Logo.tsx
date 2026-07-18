import { cn } from "@/lib/utils";

/** ZUULI mark — a shielded "Z" in a rounded violet tile. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative grid place-items-center rounded-xl bg-gradient-to-br from-primary to-fuchsia-600 text-primary-foreground shadow-glow",
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
        <div className="text-lg font-bold tracking-tight">ZUULI</div>
        <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          by 2Z Inc
        </div>
      </div>
    </div>
  );
}
