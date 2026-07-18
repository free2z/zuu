// Shared building blocks for the Zcash wallet feature.
import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Copy-to-clipboard helper that surfaces a toast. */
export function useClipboard() {
  return useCallback(async (text: string, label = "Copied to clipboard") => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(label);
      return true;
    } catch {
      toast.error("Couldn't copy — clipboard unavailable");
      return false;
    }
  }, []);
}

interface CopyButtonProps {
  value: string;
  label?: string;
  ariaLabel?: string;
  className?: string;
  size?: "icon" | "sm";
}

/** Icon (or small) button that copies a value and flashes a check. */
export function CopyButton({
  value,
  label = "Copied to clipboard",
  ariaLabel = "Copy",
  className,
  size = "icon",
}: CopyButtonProps) {
  const copy = useClipboard();
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    const ok = await copy(value, label);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  }, [copy, value, label]);

  const Icon = copied ? Check : Copy;

  if (size === "sm") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onCopy}
        className={className}
      >
        <Icon className={cn("h-4 w-4", copied && "text-emerald-400")} />
        {copied ? "Copied" : "Copy"}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={ariaLabel}
          onClick={onCopy}
          className={className}
        >
          <Icon className={cn("h-4 w-4", copied && "text-emerald-400")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : ariaLabel}</TooltipContent>
    </Tooltip>
  );
}

/** The Zcash-gold "ZEC" unit tag used alongside amounts. */
export function ZecTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "text-[#f4b728] font-semibold tracking-wide",
        className,
      )}
    >
      ZEC
    </span>
  );
}

/** Big split-amount display: bold whole part, faded decimals, ZEC tag. */
export function AmountDisplay({
  whole,
  decimal,
  size = "lg",
  sign,
}: {
  whole: string;
  decimal: string;
  size?: "lg" | "md" | "sm";
  sign?: "+" | "−";
}) {
  const sizes = {
    lg: "text-5xl md:text-6xl",
    md: "text-3xl",
    sm: "text-2xl",
  } as const;
  return (
    <div
      className={cn(
        "flex items-baseline gap-1.5 font-bold tabular-nums leading-none",
        sizes[size],
      )}
    >
      {sign ? <span className="text-foreground/80">{sign}</span> : null}
      <span className="text-foreground">{whole}</span>
      <span className="text-muted-foreground/70">{decimal}</span>
      <ZecTag className={size === "lg" ? "ml-1 text-base md:text-lg" : "ml-0.5 text-xs"} />
    </div>
  );
}
