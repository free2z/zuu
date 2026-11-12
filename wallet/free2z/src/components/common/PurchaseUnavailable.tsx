import { useTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";

export function PurchaseUnavailable() {
  const { t } = useTranslation();
  return <p role="status" data-purchase-unavailable className="rounded-lg border border-border p-3 text-sm text-muted-foreground">{t(MESSAGE_KEYS.purchaseUnavailable)}</p>;
}
