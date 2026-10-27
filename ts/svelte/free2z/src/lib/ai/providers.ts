import { ProviderEnum, type AIModel } from "$lib/api/f2z.schemas";

/**
 * Display metadata for an AI provider. Kept intentionally tiny: a label for
 * badges/dropdowns and a short label for tight spaces (e.g. inline chips).
 */
export interface ProviderDisplay {
  readonly value: string;
  readonly label: string;
  readonly shortLabel: string;
}

const PROVIDER_DISPLAY: Record<ProviderEnum, ProviderDisplay> = {
  [ProviderEnum.anthropic]: {
    value: ProviderEnum.anthropic,
    label: "Anthropic",
    shortLabel: "Anthropic",
  },
  [ProviderEnum.openai]: {
    value: ProviderEnum.openai,
    label: "OpenAI",
    shortLabel: "OpenAI",
  },
  [ProviderEnum.xai]: {
    value: ProviderEnum.xai,
    label: "xAI",
    shortLabel: "xAI",
  },
  [ProviderEnum.kimi]: {
    value: ProviderEnum.kimi,
    label: "Kimi (Moonshot)",
    shortLabel: "Kimi",
  },
};

const OTHER_PROVIDER: ProviderDisplay = {
  value: "other",
  label: "Other",
  shortLabel: "Other",
};

/**
 * Preferred display/grouping order for provider-aware model lists:
 * Anthropic -> OpenAI -> xAI -> Kimi, with anything unrecognized last.
 */
export const PROVIDER_ORDER: readonly ProviderEnum[] = [
  ProviderEnum.anthropic,
  ProviderEnum.openai,
  ProviderEnum.xai,
  ProviderEnum.kimi,
];

/** Resolve display metadata for a provider value, falling back to "Other". */
export function getProviderDisplay(provider?: string | null): ProviderDisplay {
  if (provider && provider in PROVIDER_DISPLAY) {
    return PROVIDER_DISPLAY[provider as ProviderEnum];
  }
  return OTHER_PROVIDER;
}

/** Short convenience accessor for just the human-readable label. */
export function providerLabel(provider?: string | null): string {
  return getProviderDisplay(provider).label;
}

function providerRank(provider?: string | null): number {
  const index = provider
    ? PROVIDER_ORDER.indexOf(provider as ProviderEnum)
    : -1;
  return index === -1 ? PROVIDER_ORDER.length : index;
}

/**
 * Sort models by provider (Anthropic -> OpenAI -> xAI -> Kimi -> Other),
 * preserving relative order within a provider.
 */
export function sortModelsByProvider<T extends { provider?: string | null }>(
  models: readonly T[],
): T[] {
  return [...models]
    .map((model, index) => ({ model, index }))
    .sort((a, b) => {
      const rankDiff =
        providerRank(a.model.provider) - providerRank(b.model.provider);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ model }) => model);
}

/**
 * Group models by provider in the preferred display order. Providers with
 * no models are omitted.
 */
export function groupModelsByProvider<T extends { provider?: string | null }>(
  models: readonly T[],
): Array<{ provider: ProviderDisplay; models: T[] }> {
  const groups = new Map<string, T[]>();
  for (const model of models) {
    const key = getProviderDisplay(model.provider).value;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(model);
    } else {
      groups.set(key, [model]);
    }
  }

  const orderedKeys = [
    ...PROVIDER_ORDER.map((p) => p as string),
    OTHER_PROVIDER.value,
  ];
  return orderedKeys
    .filter((key) => groups.has(key))
    .map((key) => ({
      provider: PROVIDER_DISPLAY[key as ProviderEnum] ?? OTHER_PROVIDER,
      models: groups.get(key)!,
    }));
}

export type { AIModel };
