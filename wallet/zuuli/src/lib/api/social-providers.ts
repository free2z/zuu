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
 * internal map. Any ambiguity rejects the entire response so one valid-looking
 * entry cannot enable OAuth alongside malformed or unknown data.
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
  let seenApple = false;

  for (const entry of value.providers) {
    if (
      !isPlainRecord(entry) ||
      !Reflect.ownKeys(entry).every((key) =>
        ["provider", "configured", "web_reauthentication", "web_only"].includes(
          String(key),
        ),
      ) ||
      (isPlainRecord(entry) &&
        (("web_reauthentication" in entry &&
          typeof entry.web_reauthentication !== "boolean") ||
          ("web_only" in entry && typeof entry.web_only !== "boolean")))
    ) {
      return contractError(
        "entries require `provider`, boolean `configured`, and only known boolean web metadata.",
      );
    }
    // Apple uses a registered HTTPS web callback and is deliberately not a
    // native loopback/PKCE provider. Accept its discovery row without enabling
    // a button or rejecting the other providers. Old servers may omit it.
    if (entry.provider === "apple") {
      if (
        seenApple ||
        typeof entry.configured !== "boolean" ||
        (entry.configured && entry.web_only !== true)
      ) {
        return contractError("invalid or duplicate web-only Apple provider.");
      }
      seenApple = true;
      continue;
    }
    if (!isSocialProvider(entry.provider)) {
      return contractError("an entry named an unsupported provider.");
    }
    if (typeof entry.configured !== "boolean") {
      return contractError("an entry's `configured` field was not boolean.");
    }
    if (seen.has(entry.provider)) {
      return contractError("a provider appeared more than once.");
    }
    seen.add(entry.provider);
    status[entry.provider] = entry.configured && entry.web_only !== true;
  }

  if (seen.size !== SOCIAL_PROVIDERS.length) {
    return contractError("every supported provider must appear exactly once.");
  }

  return status;
}

export function configuredSocialProviders(
  status: SocialProvidersStatus,
): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((provider) => status[provider]);
}
