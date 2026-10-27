/**
 * Which top-up tab the billing page opens on.
 *
 * Zcash is offered first and is the default. `?tab=stripe` (or its alias
 * `?tab=card`) opens the card tab and `?tab=zcash` the Zcash one; both are an
 * explicit choice the page keeps even when Zcash turns out to be
 * unavailable, so its "unavailable / Retry" state stays visible to whoever
 * asked for it. Anything else is no choice: the page opens on Zcash and
 * falls back to Card once Zcash is known to be unavailable.
 */
export type PaymentTab = "stripe" | "zcash";

export function requestedPaymentTab(url: URL): PaymentTab | null {
  const tab = url.searchParams.get("tab");
  if (tab === "stripe" || tab === "card") return "stripe";
  if (tab === "zcash") return "zcash";
  return null;
}
