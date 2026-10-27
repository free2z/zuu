// Provider metadata for the AI model picker.
//
// The backend (`/api/ai/models/`) returns each AIModel with a `provider`
// string field. This maps known provider values to a display label and a
// small accent color used for the badge shown next to each model. Any
// missing/unknown provider value falls back to "Other" so the UI never
// breaks if the backend adds a provider before the frontend knows about it.

export type AIProvider = "anthropic" | "openai" | "xai" | "kimi";

export interface AIProviderMeta {
    label: string;
    color: string;
}

// Display order for grouping models in the picker.
export const AI_PROVIDER_ORDER: string[] = ["anthropic", "openai", "xai", "kimi"];

const AI_PROVIDER_META: Record<string, AIProviderMeta> = {
    anthropic: { label: "Anthropic", color: "#D97757" },
    openai: { label: "OpenAI", color: "#10A37F" },
    xai: { label: "xAI", color: "#000000" },
    kimi: { label: "Kimi", color: "#5B5FFF" },
};

const OTHER_PROVIDER_META: AIProviderMeta = { label: "Other", color: "#757575" };

/** Normalize a possibly-missing/unknown provider value to a known key or "other". */
export function normalizeProvider(provider?: string | null): string {
    if (provider && AI_PROVIDER_META[provider]) {
        return provider;
    }
    return "other";
}

/** Look up display metadata (label + accent color) for a provider value. */
export function getProviderMeta(provider?: string | null): AIProviderMeta {
    if (!provider) return OTHER_PROVIDER_META;
    return AI_PROVIDER_META[provider] || OTHER_PROVIDER_META;
}

export function getProviderLabel(provider?: string | null): string {
    return getProviderMeta(provider).label;
}
