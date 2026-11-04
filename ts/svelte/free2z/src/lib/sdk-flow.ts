/**
 * Every Free2Z page an SDK app opens is commerce-free: "the line" (zuu
 * docs/free2z/sdk/INTEGRATION.md, "Manage Free2Z account: the URL contract").
 *
 * An app opens Free2Z for a few jobs: sign in (or sign up) and approve the
 * app, and later "Manage Free2Z account" in the system browser. App stores
 * treat those pages as reachable from the app. Google Play bans sign-in and
 * sign-up flows that lead to a non-Play payment method and allows an
 * account-management page only if it does not eventually lead to one;
 * outside the US storefront Apple bans steering. So these pages render
 * without the site navigation and footer (the account menu reaches Credits),
 * link to no purchase, and offer no sign-in method that leaves the flow
 * (X returns to the dashboard, not to the request). The rest of the site
 * sells 2Z normally.
 *
 * The SDK-facing pages:
 *
 * - `/oauth/*`: consent and its sign-in return;
 * - `/account/apps?client_id=…`: the Manage landing page (with the
 *   parameter only; the plain Connected apps list is an ordinary page);
 * - `/account/delete`: account deletion, linked from the Manage page;
 * - `/login` whose (safe) `next` returns to any of the above.
 *
 * Deliberately NOT on that list: `/buy-2z?client_id=…`. It is the
 * one link an app may open in order to get 2Z, it lands on the ordinary
 * billing page (Zcash first, card second), and an app shows it only where
 * the store allows it (web, direct-download desktop, Apple's US storefront).
 * The pages above never link to it.
 *
 * The decision is made from the URL alone, so the server render and the
 * browser agree and nothing has to be threaded through stores.
 */
import { getSafeNextPath } from "./safe-next";

/** The OAuth/OIDC pages: consent and its sign-in return. */
const OAUTH_PATH = /^\/oauth(\/|$)/;

const MANAGE_PATH = "/account/apps";
const DELETE_PATH = "/account/delete";
// "Keep my account?" (deletion grace period): reached from a sign-in that may
// be an SDK app's, so it gets the same commerce-free chrome as DELETE_PATH.
const KEEP_PATH = "/account/keep";

/** `/login` is SDK-facing when it returns to an SDK-facing page. */
const LOGIN_PATH = "/login";

function trimSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/** An SDK-facing page other than `/login`. */
function isSdkPage(url: URL): boolean {
  const pathname = trimSlash(url.pathname);
  if (OAUTH_PATH.test(pathname)) return true;
  if (pathname === DELETE_PATH || pathname === KEEP_PATH) return true;
  return pathname === MANAGE_PATH && url.searchParams.has("client_id");
}

/** True when this URL is a page an SDK app opens (see above). */
export function isSdkFlow(url: URL): boolean {
  if (isSdkPage(url)) return true;
  if (trimSlash(url.pathname) !== LOGIN_PATH) return false;
  const next = getSafeNextPath(url.searchParams.get("next"));
  if (!next) return false;
  try {
    // Resolved against a throwaway origin: `next` is a same-site path by
    // construction (getSafeNextPath).
    return isSdkPage(new URL(next, "https://next.invalid"));
  } catch (error) {
    console.error("sdk-flow: unparseable next", error);
    return false;
  }
}

/** The longest `client_id` the account page will carry or look up. */
const MAX_CLIENT_ID_LENGTH = 255;

/**
 * The app a "Manage Free2Z account" link points at:
 * `/account/apps?client_id=<id>`.
 *
 * `null` when the URL names no app: the ordinary Connected apps list.
 * Otherwise the page is focused, and `clientId` is the app to show — or
 * `null` when the value is unusable (oversized, control characters), which
 * the page shows exactly like an app that is not connected: calm, never an
 * error, and never the full list with its purchase link. The value only
 * selects which of the visitor's own grants to show; it is never rendered
 * and never written anywhere.
 */
export function manageAppFocus(url: URL): { clientId: string | null } | null {
  if (!url.searchParams.has("client_id")) return null;
  return { clientId: usableClientId(url.searchParams.get("client_id")) };
}

/**
 * A `client_id` (or the `app` it becomes on the billing page) as a URL
 * carries it: trimmed, non-empty, at most {@link MAX_CLIENT_ID_LENGTH}
 * characters and free of control characters — otherwise `null`. The one
 * place that rule is spelled, for every page that accepts an app's id.
 *
 * Usable is not trusted: the value is attacker-controlled text. Callers use
 * it to select or to carry, never to render.
 */
export function usableClientId(raw: string | null | undefined): string | null {
  const value = raw?.trim() ?? "";
  const usable =
    value.length > 0 &&
    value.length <= MAX_CLIENT_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value);
  return usable ? value : null;
}
