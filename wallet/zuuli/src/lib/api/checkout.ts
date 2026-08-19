import { STRIPE_CHECKOUT_CUSTOM_HOSTS } from "../env";

const DEFAULT_STRIPE_CHECKOUT_HOST = "checkout.stripe.com";
const DNS_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type CheckoutLinkFailure =
  | "missing"
  | "malformed"
  | "insecure"
  | "credentials"
  | "port"
  | "untrusted-host";

export class CheckoutLinkError extends Error {
  constructor(public readonly reason: CheckoutLinkFailure) {
    super(`Stripe Checkout URL rejected: ${reason}`);
    this.name = "CheckoutLinkError";
  }
}

/**
 * Build the exact-host allowlist. Invalid custom entries are ignored instead
 * of widening trust through a wildcard, URL, path, userinfo or port.
 */
export function stripeCheckoutHosts(config: string): ReadonlySet<string> {
  const hosts = new Set([DEFAULT_STRIPE_CHECKOUT_HOST]);
  for (const entry of config.split(",")) {
    const host = entry.trim().toLowerCase();
    if (DNS_NAME.test(host)) hosts.add(host);
  }
  return hosts;
}

export const ALLOWED_STRIPE_CHECKOUT_HOSTS = stripeCheckoutHosts(
  STRIPE_CHECKOUT_CUSTOM_HOSTS,
);

/**
 * Validate a backend-provided hosted Checkout URL before handing it to the OS.
 * Matching is an exact normalized hostname comparison; suffixes, credentials,
 * explicit ports, fragments and non-HTTPS schemes are rejected.
 */
export function validateStripeCheckoutUrl(
  value: unknown,
  allowedHosts: ReadonlySet<string> = ALLOWED_STRIPE_CHECKOUT_HOSTS,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CheckoutLinkError("missing");
  }
  if (value !== value.trim()) throw new CheckoutLinkError("malformed");

  // Inspect the raw authority as well as URL's parsed fields. URL normalizes
  // `:443` away, so parsed `url.port` alone cannot enforce the no-port policy.
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority) throw new CheckoutLinkError("insecure");
  if (authority.includes("@")) throw new CheckoutLinkError("credentials");
  if (authority.includes(":")) throw new CheckoutLinkError("port");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CheckoutLinkError("malformed");
  }
  if (url.protocol !== "https:") throw new CheckoutLinkError("insecure");
  if (url.username || url.password) throw new CheckoutLinkError("credentials");
  if (url.port) throw new CheckoutLinkError("port");
  if (url.hash) throw new CheckoutLinkError("malformed");
  if (authority.toLowerCase() !== url.hostname.toLowerCase()) {
    throw new CheckoutLinkError("malformed");
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new CheckoutLinkError("untrusted-host");
  }
  return value;
}
