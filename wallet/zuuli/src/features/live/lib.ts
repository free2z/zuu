import type { StreamKind } from "@/lib/api/types";

/** Badge variants used across the Live feature for each stream kind. */
export type KindVariant = "default" | "sub" | "ppv" | "secondary";

export const KIND_META: Record<
  StreamKind,
  { label: string; short: string; variant: KindVariant; blurb: string }
> = {
  broadcast: {
    label: "Broadcast",
    short: "Broadcast",
    variant: "default",
    blurb: "Open to everyone, free to join.",
  },
  subscriber: {
    label: "Subscribers",
    short: "Subscriber",
    variant: "sub",
    blurb: "For your 2Z subscribers.",
  },
  ppv: {
    label: "Pay-per-view",
    short: "PPV",
    variant: "ppv",
    blurb: "Viewers spend 2Zs to join.",
  },
  private: {
    label: "Private",
    short: "Private",
    variant: "secondary",
    blurb: "Secret-gated, invite only.",
  },
};

export const KIND_ORDER: StreamKind[] = [
  "broadcast",
  "subscriber",
  "ppv",
  "private",
];

/**
 * Deterministic cinematic gradient seeded from a stream's identity, so every
 * card/stage gets a stable, premium violet→rose backdrop without any assets.
 */
export function gradientFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h << 5) - h + seed.charCodeAt(i);
    h |= 0;
  }
  const base = Math.abs(h) % 360;
  const a = 250 + (base % 40); // violet family
  const b = (a + 60 + (Math.abs(h >> 3) % 40)) % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 22%) 0%, hsl(${b} 65% 16%) 55%, hsl(${(b + 30) % 360} 60% 10%) 100%)`;
}
