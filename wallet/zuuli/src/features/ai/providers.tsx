import { Bot, Boxes, Cpu, Feather, Globe, Sparkles, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { estimateTuzis } from "@/lib/api/free2z";
import type { AIModel } from "@/lib/api/types";
import { formatTuzis } from "@/lib/format";

export type Provider = NonNullable<AIModel["provider"]>;

interface ProviderMeta {
  label: string;
  icon: LucideIcon;
  /** Foreground accent color for icons/labels. */
  color: string;
  /** Subtle background tint for icon chips. */
  tint: string;
}

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  anthropic: {
    label: "Anthropic",
    icon: Sparkles,
    color: "text-orange-400",
    tint: "bg-orange-400/10",
  },
  openai: {
    label: "OpenAI",
    icon: Bot,
    color: "text-emerald-400",
    tint: "bg-emerald-400/10",
  },
  xai: { label: "xAI", icon: Zap, color: "text-sky-400", tint: "bg-sky-400/10" },
  kimi: {
    label: "Moonshot",
    icon: Feather,
    color: "text-fuchsia-400",
    tint: "bg-fuchsia-400/10",
  },
  google: {
    label: "Google",
    icon: Globe,
    color: "text-blue-400",
    tint: "bg-blue-400/10",
  },
  local: {
    label: "On our hardware",
    icon: Cpu,
    color: "text-primary",
    tint: "bg-primary/15",
  },
  other: {
    label: "Other",
    icon: Boxes,
    color: "text-muted-foreground",
    tint: "bg-muted",
  },
};

export function providerOf(model: AIModel): Provider {
  return model.provider ?? "other";
}

export function providerMeta(model: AIModel): ProviderMeta {
  return PROVIDER_META[providerOf(model)];
}

/**
 * A representative price hint: the 2Z cost of a typical ~500-in / 500-out
 * exchange, cost-plus and rounded up — the same math the backend bills.
 */
export function pricePerMessage(model: AIModel): string {
  return `${formatTuzis(estimateTuzis(model, 500, 500))}/msg`;
}
