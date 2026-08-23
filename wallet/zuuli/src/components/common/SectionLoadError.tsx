import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A retryable section failure that never masquerades as successful emptiness. */
export function SectionLoadError({
  title,
  description,
  retry,
  retrying = false,
  stale = false,
  className,
}: {
  title: string;
  description: string;
  retry: () => void;
  retrying?: boolean;
  stale?: boolean;
  className?: string;
}) {
  return (
    <div
      role={stale ? "status" : "alert"}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 sm:flex-row sm:items-center sm:justify-between",
        !stale && "py-6",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <TriangleAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 break-words">
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={retrying}
        onClick={retry}
      >
        <RefreshCw
          className={cn("h-4 w-4", retrying && "animate-spin")}
          aria-hidden
        />
        {retrying ? "Retrying" : "Retry"}
      </Button>
    </div>
  );
}
