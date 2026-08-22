import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none",
  {
    variants: {
      variant: {
        default: "border-primary/30 bg-primary/10 text-link",
        secondary: "border-border bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        live: "border-live/35 bg-live/10 text-live",
        zec: "border-zec/30 bg-zec/10 text-zec",
        ppv: "border-warning/30 bg-warning/10 text-warning",
        sub: "border-info/30 bg-info/10 text-info",
        success: "border-success/30 bg-success/10 text-success",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
