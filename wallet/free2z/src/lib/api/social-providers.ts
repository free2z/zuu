import {
  SOCIAL_PROVIDERS,
  type SocialProvider,
  type SocialProvidersStatus,
} from "./types";

const PROVIDER_SET = new Set<string>(SOCIAL_PROVIDERS);

export class SocialProvidersContractError extends Error {
  constructor(detail: string) {
    super(`Invalid social-provider response: ${detail}`);
    this.name = "SocialProvidersContractError";
  }
}

function contractError(detail: string): never {
  throw new SocialProvidersContractError(detail);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isSocialProvider(value: unknown): value is SocialProvider {
  return typeof value === "string" && PROVIDER_SET.has(value);
}

/**
 * Validate the production discovery wire shape and normalize it into a total
 * internal map. Legacy object maps are deliberately rejected. The backend may
 * send optional boolean `web_reauthentication` metadata; it is validated but
 * never used as sign-in readiness. Any ambiguity rejects the entire response
 * so one valid entry cannot enable OAuth alongside malformed or unknown data.
 */
export function parseSocialProvidersStatus(
  value: unknown,
): SocialProvidersStatus {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["providers"])) {
    return contractError("expected exactly a `providers` array.");
  }
  if (!Array.isArray(value.providers)) {
    return contractError("`providers` must be an array.");
  }

  const status: SocialProvidersStatus = {
    x: false,
    google: false,
    github: false,
  };
  const seen = new Set<SocialProvider>();

  for (const entry of value.providers) {
    if (
      !isPlainRecord(entry) ||
      !(
        hasExactKeys(entry, ["provider", "configured"]) ||
        hasExactKeys(entry, ["provider", "configured", "web_reauthentication"])
      )
    ) {
      return contractError(
        "each entry must contain `provider`, boolean `configured`, and only optional boolean `web_reauthentication` metadata.",
      );
    }
    if (!isSocialProvider(entry.provider)) {
      return contractError("an entry named an unsupported provider.");
    }
    if (typeof entry.configured !== "boolean") {
      return contractError("an entry's `configured` field was not boolean.");
    }
    if (
      Object.prototype.hasOwnProperty.call(entry, "web_reauthentication") &&
      typeof entry.web_reauthentication !== "boolean"
    ) {
      return contractError(
        "an entry's `web_reauthentication` field was not boolean.",
      );
    }
    if (seen.has(entry.provider)) {
      return contractError("a provider appeared more than once.");
    }
    seen.add(entry.provider);
    status[entry.provider] = entry.configured;
  }

  if (seen.size !== SOCIAL_PROVIDERS.length) {
    return contractError("every supported provider must appear exactly once.");
  }

  return status;
}

export function configuredSocialProviders(
  status: SocialProvidersStatus,
): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((provider) => status[provider] === true);
}
