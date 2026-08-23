import type { SocialProvider } from "../api/types";

export const MOBILE_REDIRECT_URI = "cash.free2z.zuuli://oauth/callback";
const MOBILE_RELAY_HOSTS = new Set([
  "free2z.cash",
  "new.free2z.cash",
  "stage.free2z.cash",
  "test.free2z.cash",
]);

export interface OAuthStartResponse {
  authorize_url: string;
  state: string;
  authorization_state?: string;
  provider_redirect_uri?: string;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

const PROVIDER_AUTHORIZATION_ENDPOINT: Record<
  SocialProvider,
  { host: string; path: string }
> = {
  x: { host: "twitter.com", path: "/i/oauth2/authorize" },
  google: { host: "accounts.google.com", path: "/o/oauth2/v2/auth" },
  github: { host: "github.com", path: "/login/oauth/authorize" },
};

function oneQuery(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new Error(`The authorization URL repeated \`${name}\`.`);
  }
  return values[0] ?? null;
}

function validState(state: string): boolean {
  return (
    state.length >= 16 &&
    state.length <= 512 &&
    [...state].every((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e && char !== '"' && char !== "\\";
    })
  );
}

function validateMobileProviderRedirect(value: string | undefined): string {
  if (!value) throw new Error("free2z did not return its mobile OAuth relay URI.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("free2z returned an invalid mobile OAuth relay URI.");
  }
  if (
    url.protocol !== "https:" ||
    !MOBILE_RELAY_HOSTS.has(url.hostname) ||
    url.pathname !== "/api/auth/social/mobile/callback" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("free2z returned a mobile OAuth relay outside its allowlist.");
  }
  return url.toString();
}

/**
 * Treat the backend's authorization URL as untrusted structured input. This
 * prevents a compromised/misconfigured API response from turning the system
 * browser opener into an arbitrary-URL launcher or swapping callback state.
 */
export function validateAuthorizationStart(
  provider: SocialProvider,
  start: OAuthStartResponse,
  redirectUri: string,
  mobile: boolean,
  expectedCodeChallenge?: string,
): string {
  if (!validState(start.state)) {
    throw new Error("free2z returned an invalid OAuth state.");
  }
  const authorizationState = mobile ? start.authorization_state : start.state;
  if (
    !authorizationState ||
    !validState(authorizationState) ||
    (mobile && authorizationState === start.state)
  ) {
    throw new Error("free2z returned an invalid provider-facing OAuth state.");
  }
  let url: URL;
  try {
    url = new URL(start.authorize_url);
  } catch {
    throw new Error("free2z returned an invalid authorization URL.");
  }
  const endpoint = PROVIDER_AUTHORIZATION_ENDPOINT[provider];
  if (
    url.protocol !== "https:" ||
    url.hostname !== endpoint.host ||
    url.pathname !== endpoint.path ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error("free2z returned an authorization URL outside the provider allowlist.");
  }
  if (oneQuery(url, "response_type") !== "code") {
    throw new Error("The provider authorization response type is not \`code\`.");
  }
  if (oneQuery(url, "state") !== authorizationState) {
    throw new Error("The provider authorization URL does not match its OAuth state.");
  }
  const providerRedirect = mobile
    ? validateMobileProviderRedirect(start.provider_redirect_uri)
    : redirectUri;
  if (oneQuery(url, "redirect_uri") !== providerRedirect) {
    throw new Error("The provider authorization URL changed the callback URI.");
  }

  // Native apps are public OAuth clients. X and Google support RFC 7636 S256;
  // GitHub OAuth Apps currently do not, so GitHub stays desktop/web-only rather
  // than shipping a weaker mobile exception.
  if (mobile && provider === "github") {
    throw new Error("GitHub sign-in on mobile is waiting for a PKCE-capable provider configuration.");
  }
  if (provider !== "github") {
    const challenge = oneQuery(url, "code_challenge");
    if (
      oneQuery(url, "code_challenge_method") !== "S256" ||
      !challenge ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    ) {
      throw new Error("The provider authorization URL is missing PKCE S256.");
    }
    if (expectedCodeChallenge && challenge !== expectedCodeChallenge) {
      throw new Error("The provider authorization URL changed the app's PKCE challenge.");
    }
  }
  return url.toString();
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate the verifier inside the app; only its S256 challenge leaves it. */
export async function generatePkcePair(): Promise<PkcePair> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(random);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export async function buildSessionBinding(
  associate: boolean,
  token: string | null,
): Promise<string> {
  if (!associate) {
    if (token) {
      throw new Error("Sign out before starting a different social login.");
    }
    return "login:none";
  }
  if (!token) {
    throw new Error("Your session expired before account linking started.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `associate:${hex}`;
}

/** Recompute and compare the exact initiating session before OAuth exchange.
 * Returns the verified token so callers can pin the authenticated request to
 * it instead of consulting mutable global state a second time. */
export async function assertSessionBinding(
  expectedBinding: string,
  associate: boolean,
  token: string | null,
): Promise<string | null> {
  const currentBinding = await buildSessionBinding(associate, token);
  if (currentBinding !== expectedBinding) {
    throw new Error(
      associate
        ? "Your account session changed while linking this identity. Start again."
        : "Your sign-in session changed while the provider was open. Start again.",
    );
  }
  return associate ? token : null;
}

/** Whether the current auth mode can still complete the pending OAuth flow. */
export function canResumeMobileOAuth(
  associate: boolean,
  token: string | null,
): boolean {
  return associate ? token !== null : token === null;
}
