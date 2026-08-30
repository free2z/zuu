import { Switch } from "@/components/ui/switch";
import {
  setStrictImagePrivacy,
  useStrictImagePrivacy,
} from "@/lib/media/image-privacy";
import { cn } from "@/lib/utils";

export function ImagePrivacySetting({ className }: { className?: string }) {
  const strict = useStrictImagePrivacy();

  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/60 px-4 py-3",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <label
          id="strict-image-privacy-label"
          htmlFor="strict-image-privacy"
          className="text-sm font-medium"
        >
          Strict image privacy
        </label>
        <p id="strict-image-privacy-help" className="text-xs text-muted-foreground">
          Ask before loading images.
        </p>
      </div>
      <Switch
        id="strict-image-privacy"
        className="min-tap h-11 w-14 p-2.5"
        checked={strict}
        onCheckedChange={setStrictImagePrivacy}
        aria-labelledby="strict-image-privacy-label"
        aria-describedby="strict-image-privacy-help"
      />
    </div>
  );
}
