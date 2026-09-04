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
