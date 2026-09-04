import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { MESSAGE_KEYS } from "@/i18n/messages";

/**
 * free2z mark — an open page in a violet→fuchsia tile.
 *
 * Deliberately not ZUULI's shielded "Z": the two apps ship side by side on the
 * same device (#904), and a user picking one from a launcher has only the icon
 * and the wordmark to tell a content reader from a wallet holding a seed.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative grid place-items-center rounded-xl bg-gradient-to-br from-primary to-fuchsia-600 text-primary-foreground",
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-3/5 w-3/5" fill="none">
        <path
          d="M12 6.5C10 5 7.5 4.7 5 5.2v12.1c2.5-.5 5-.2 7 1.3 2-1.5 4.5-1.8 7-1.3V5.2c-2.5-.5-5-.2-7 1.3Zm0 0v12.1"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function Wordmark({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className="h-9 w-9" />
      <div className="leading-none">
        <div className="text-lg font-semibold leading-6 tracking-[0.12em]">
          {t(MESSAGE_KEYS.appName)}
        </div>
        <div className="eyebrow text-muted-foreground">
          {t(MESSAGE_KEYS.appTagline)}
        </div>
      </div>
    </div>
  );
}
