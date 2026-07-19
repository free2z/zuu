import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

const STEP_LABELS = ["Basic info", "Identity documents", "Tax form", "Review"];

export function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex items-center gap-2">
      {STEP_LABELS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <li key={label} className="flex flex-1 items-center gap-2 last:flex-none">
            <div
              className={cn(
                "grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                done && "border-primary bg-primary text-primary-foreground",
                active && !done && "border-primary bg-primary/15 text-primary",
                !active && !done && "border-border bg-transparent text-muted-foreground",
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
            </div>
            <span
              className={cn(
                "hidden text-xs font-medium sm:inline",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </span>
            {i < STEP_LABELS.length - 1 ? (
              <div className={cn("h-px flex-1", done ? "bg-primary" : "bg-border")} />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
