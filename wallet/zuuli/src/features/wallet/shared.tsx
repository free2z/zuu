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
        <Icon className={cn("h-4 w-4", copied && "text-success")} />
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
          <Icon className={cn("h-4 w-4", copied && "text-success")} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : ariaLabel}</TooltipContent>
    </Tooltip>
  );
}

/** The Zcash-gold "ZEC" unit tag used alongside amounts. */
export function ZecTag({ className }: { className?: string }) {
  return (
    <span className={cn("font-semibold tracking-[0.06em] text-zec", className)}>
      ZEC
    </span>
  );
}

/**
 * The amount readout.
 *
 * Money is the characteristic material of a wallet, so it is set the way a
 * precision instrument sets a readout: fixed-width figures on a stable digit
 * grid, tracking pulled in, the whole part carrying the weight and the
 * fractional part stepped down so the eye lands on the magnitude first. The
 * unit stays small and gold. This is the one place in ZUULI that is allowed to
 * be loud.
 */
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
    lg: {
      whole: "text-4xl min-[360px]:text-5xl md:text-6xl",
      fraction: "text-xl min-[360px]:text-2xl md:text-3xl",
      unit: "ms-2 text-sm md:text-base",
    },
    md: {
      whole: "text-3xl",
      fraction: "text-lg",
      unit: "ms-1.5 text-xs",
    },
    sm: {
      whole: "text-2xl",
      fraction: "text-base",
      unit: "ms-1 text-xs",
    },
  } as const;
  const step = sizes[size];

  return (
    <div className="bidi-number numeral flex min-w-0 items-baseline leading-none">
      {sign ? (
        <span className={cn("me-1 text-muted-foreground", step.fraction)}>
          {sign}
        </span>
      ) : null}
      <span className={cn("font-semibold text-foreground", step.whole)}>
        {whole}
      </span>
      <span className={cn("text-muted-foreground", step.fraction)}>
        {decimal}
      </span>
      <ZecTag className={step.unit} />
    </div>
  );
}
