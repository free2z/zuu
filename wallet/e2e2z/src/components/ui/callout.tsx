import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * A bordered status note.
 *
 * The same icon + heading + body block had been hand-rolled eight times across
 * auth, profile and wallet, each with its own amber shade. One component, one
 * set of semantic tones: a hairline border and a 10% tint carry the status, and
 * only the icon and heading take the tone colour so the body copy stays as
 * readable as the rest of the page.
 */
const TONES = {
  warning: {
    frame: "border-warning/30 bg-warning/10",
    mark: "text-warning",
  },
  success: {
    frame: "border-success/30 bg-success/10",
    mark: "text-success",
  },
  info: {
    frame: "border-info/30 bg-info/10",
    mark: "text-info",
  },
  destructive: {
    frame: "border-destructive/40 bg-destructive/10",
    mark: "text-destructive",
  },
} as const;

export type CalloutTone = keyof typeof TONES;

export interface CalloutProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: CalloutTone;
  icon?: LucideIcon;
  title?: React.ReactNode;
}

export function Callout({
  tone = "warning",
  icon: Icon,
  title,
  className,
  children,
  ...props
}: CalloutProps) {
  const { frame, mark } = TONES[tone];
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4 text-sm",
        frame,
        className,
      )}
      {...props}
    >
      {Icon ? (
        <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", mark)} aria-hidden />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? (
          <p className={cn("font-semibold", mark)}>{title}</p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
