// X and Google as peer login methods — rendered but clearly not yet available.
// No desktop OAuth transport exists yet (X is web-cookie-redirect only; Google
// has no backend), so these are deliberately inert "coming soon" affordances.
// A tooltip explains why; nothing is wired to any OAuth flow.

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Monogram tile standing in for a brand mark (no external brand assets). */
function Monogram({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="grid h-5 w-5 shrink-0 place-items-center rounded bg-muted-foreground/20 text-[11px] font-bold text-muted-foreground"
      aria-hidden
    >
      {children}
    </span>
  );
}

function ComingSoonMethod({
  label,
  mark,
}: {
  label: string;
  mark: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Intentionally not a real `disabled` button so the tooltip still
            fires on hover/focus; `aria-disabled` + no handler keep it inert. */}
        <button
          type="button"
          aria-disabled="true"
          aria-label={`${label} — coming soon`}
          onClick={(e) => e.preventDefault()}
          className="flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-md border border-border bg-transparent px-4 py-2 text-sm font-medium text-muted-foreground opacity-70"
        >
          {mark}
          {label}
          <span className="ml-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
            Soon
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>Coming soon on desktop</TooltipContent>
    </Tooltip>
  );
}

export function SocialSoon() {
  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-3">
        <ComingSoonMethod label="Continue with X" mark={<Monogram>X</Monogram>} />
        <ComingSoonMethod
          label="Continue with Google"
          mark={<Monogram>G</Monogram>}
        />
      </div>
    </TooltipProvider>
  );
}
