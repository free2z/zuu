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
          <h2 className="text-lg font-semibold tracking-tight md:text-xl">
            {title}
          </h2>
        </div>
        {subtitle ? (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {to ? (
        <Link
          to={to}
          className="min-tap group inline-flex shrink-0 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`${linkLabel}: ${title}`}
        >
          {linkLabel}
          <ArrowRight className="rtl:-scale-x-100 h-4 w-4 transition-transform ltr:group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
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
