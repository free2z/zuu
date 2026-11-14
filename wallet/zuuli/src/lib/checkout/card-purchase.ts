import { validateStripeCheckoutUrl } from "@/lib/api/checkout";
import type { CheckoutReturnMode } from "@/lib/checkout/native-return";

export interface CardPurchase {
  id: string;
  url: string;
  expires_at: number;
  status_token: string;
  quote: {
    checkout_intent_id: string;
    tuzis: number;
    amount_cents: number;
    currency: "usd";
    pricing_version: string;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validate the server's complete order; no client-side inverse or fee math. */
export function parseCardPurchase(
  value: unknown,
  quantity: number,
): CardPurchase {
  const p = value as CardPurchase | null;
  if (
    !p ||
    !/^cs_[A-Za-z0-9_]{3,252}$/.test(p.id) ||
    !Number.isSafeInteger(p.expires_at) ||
    p.expires_at <= 0 ||
    typeof p.status_token !== "string" ||
    !/^[A-Za-z0-9_.:-]{16,1024}$/.test(p.status_token) ||
    !p.quote ||
    typeof p.quote.checkout_intent_id !== "string" ||
    !UUID.test(p.quote.checkout_intent_id) ||
    p.quote.tuzis !== quantity ||
    !Number.isSafeInteger(p.quote.tuzis) ||
    quantity < 1 ||
    quantity > 1_000_000 ||
    !Number.isSafeInteger(p.quote.amount_cents) ||
    p.quote.amount_cents < 1 ||
    p.quote.currency !== "usd" ||
    typeof p.quote.pricing_version !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(p.quote.pricing_version)
  ) {
    throw new Error("The payment service returned an invalid purchase quote.");
  }
  const url = validateStripeCheckoutUrl(p.url);
  if (new URL(url).pathname !== `/c/pay/${p.id}`)
    throw new Error("The checkout link does not match the original Session.");
  return { ...p, url };
}

export interface PendingCardPurchase {
  actorId: number;
  key: string;
  quantity: number;
  returnMode: CheckoutReturnMode;
}
const slot = (actorId: number) => `zuuli.card-purchase.${actorId}`;

/** Persist BEFORE the provider request. Lost responses retain the same key.
 * There is deliberately no automatic abandon/replacement for an unresolved
 * payment. Browser returns and quote expiry cannot prove it was not paid.
 */
export function pendingCardPurchase(
  actorId: number,
  quantity: number,
  returnMode: CheckoutReturnMode,
): PendingCardPurchase {
  const stored = localStorage.getItem(slot(actorId));
  if (stored) {
    const p = JSON.parse(stored) as PendingCardPurchase;
    if (
      p.actorId !== actorId ||
      !UUID.test(p.key) ||
      !Number.isSafeInteger(p.quantity) ||
      p.quantity < 1 ||
      p.quantity > 1_000_000 ||
      !["web", "zuuli_mobile"].includes(p.returnMode)
    )
      throw new Error("The saved card purchase needs support review.");
    return p;
  }
  const p = { actorId, quantity, returnMode, key: crypto.randomUUID() };
  localStorage.setItem(slot(actorId), JSON.stringify(p));
  return p;
}

/** Only call after the backend's definite designed native preflight refusal.
 * Persist the actual terms BEFORE a web request could create a Session.
 */
export function persistWebCardPurchase(pending: PendingCardPurchase): void {
  const saved = localStorage.getItem(slot(pending.actorId));
  const original = saved ? (JSON.parse(saved) as PendingCardPurchase) : null;
  if (
    !original ||
    original.key !== pending.key ||
    original.actorId !== pending.actorId ||
    original.quantity !== pending.quantity ||
    !["web", "zuuli_mobile"].includes(original.returnMode)
  ) {
    throw new Error(
      "The original card purchase changed. Resume its saved instruction.",
    );
  }
  localStorage.setItem(
    slot(pending.actorId),
    JSON.stringify({ ...original, returnMode: "web" }),
  );
  pending.returnMode = "web";
}

export function clearCreditedCardPurchase(pending: PendingCardPurchase): void {
  const stored = localStorage.getItem(slot(pending.actorId));
  if (stored && (JSON.parse(stored) as PendingCardPurchase).key === pending.key)
    localStorage.removeItem(slot(pending.actorId));
}
