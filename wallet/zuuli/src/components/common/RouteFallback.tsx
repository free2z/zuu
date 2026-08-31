import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";

export function RouteFallback() {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-h-[40vh] w-full items-center justify-center"
      role="status"
      aria-label={t(MESSAGE_KEYS.commonLoading)}
    >
      <Loader2
        className="h-6 w-6 animate-spin text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}
