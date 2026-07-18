import { Link } from "react-router-dom";
import { ArrowRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Section heading used across the Discover dashboard: an icon-badged eyebrow +
 * title, an optional subtitle, and an optional "view all" link on the right.
 */
export function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  to,
  linkLabel = "View all",
  accent = "text-primary",
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  to?: string;
  linkLabel?: string;
  accent?: string;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-secondary",
              accent,
            )}
            aria-hidden
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <h2 className="truncate text-lg font-semibold tracking-tight md:text-xl">
            {title}
          </h2>
        </div>
        {subtitle ? (
          <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {to ? (
        <Link
          to={to}
          className="group inline-flex shrink-0 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${linkLabel}: ${title}`}
        >
          {linkLabel}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      ) : null}
    </div>
  );
}

/** Wrapper that applies the staggered slide-up entrance animation. */
export function Section({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn("animate-slide-up [animation-fill-mode:backwards]", className)}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </section>
  );
}

/**
 * Deterministic violet→fuchsia→gold gradient derived from a seed string, so
 * every thumbnail/avatar backdrop looks intentional yet varied.
 */
export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h << 5) - h + seed.charCodeAt(i);
  const a = Math.abs(h) % 360;
  const b = (a + 48) % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 42% / 0.55), hsl(${b} 75% 50% / 0.35))`;
}
