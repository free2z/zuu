// Shared constants + helpers for the 2Z economy feature.
//
// 2Z ("Tuzi") = 1 US cent. Buying credits the session balance; spending
// (tips/donations) debits it. The "pay with ZEC" path quotes an *estimated*
// ZEC amount from a display rate — the real app would fetch a live quote.

import {
  TUZIS_PER_USD,
  ZATOSHIS_PER_ZEC,
  tuzisToUsd,
} from "@/lib/format";
import type { TuziTransaction } from "@/lib/api/types";
import {
  CreditCard,
  Gift,
  Sparkles,
  Star,
  Video,
  Coins,
  type LucideIcon,
} from "lucide-react";
import type { BadgeProps } from "@/components/ui/badge";

/** Preset buy packs, in 2Z. */
export const BUY_PACKS = [500, 2_000, 5_000, 10_000] as const;

/** Preset tip amounts, in 2Z. */
export const TIP_PRESETS = [100, 500, 1_000, 2_500] as const;

/**
 * Estimated USD per ZEC used purely for the "pay with ZEC" quote. Treated as a
 * soft quote and always labelled "estimated" in the UI — the production flow
 * would swap this for a live rate from the pricing service.
 */
export const ZEC_USD_RATE = 42;

/** Convert a USD amount to an estimated zatoshi quote. */
export function usdToZatoshis(usd: number): number {
  return Math.round((usd / ZEC_USD_RATE) * ZATOSHIS_PER_ZEC);
}

/** Convert 2Zs to the estimated zatoshis needed to buy them. */
export function tuzisToZatoshis(tuzis: number): number {
  return usdToZatoshis(tuzisToUsd(tuzis));
}

/** Parse a possibly-messy numeric string into a non-negative whole 2Z amount. */
export function parseTuzis(raw: string): number {
  const n = Math.floor(Number(raw.replace(/[^0-9.]/g, "")));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export const MAX_TUZIS = 1_000_000; // sane cap for a single purchase / tip

// ── Transaction presentation ────────────────────────────────────────────────

type Kind = NonNullable<TuziTransaction["kind"]>;

interface KindMeta {
  label: string;
  icon: LucideIcon;
  badge: NonNullable<BadgeProps["variant"]>;
}

const KIND_META: Record<Kind, KindMeta> = {
  buy: { label: "Purchase", icon: CreditCard, badge: "success" },
  donate: { label: "Tip", icon: Gift, badge: "default" },
  ai: { label: "AI", icon: Sparkles, badge: "default" },
  ppv: { label: "Pay-per-view", icon: Video, badge: "ppv" },
  subscribe: { label: "Subscription", icon: Star, badge: "sub" },
};

export function kindMeta(kind?: Kind): KindMeta {
  return (
    (kind && KIND_META[kind]) ?? {
      label: "Activity",
      icon: Coins,
      badge: "secondary" as const,
    }
  );
}

/** ai gets a distinct violet tone even though it shares the default badge slot. */
export function kindIconClass(kind?: Kind): string {
  switch (kind) {
    case "buy":
      return "bg-emerald-500/15 text-emerald-400";
    case "donate":
      return "bg-primary/15 text-primary";
    case "ai":
      return "bg-violet-500/15 text-violet-300";
    case "ppv":
      return "bg-amber-500/15 text-amber-400";
    case "subscribe":
      return "bg-sky-500/15 text-sky-400";
    default:
      return "bg-secondary text-muted-foreground";
  }
}

/** cents → whole 2Z. tuzis_credited is already in 2Z, but keep the unit clear. */
export const TUZIS_PER_CENT = TUZIS_PER_USD / 100; // === 1
