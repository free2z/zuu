import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { requireAuthenticatedUser } from "$lib/server/backend";
import { usableClientId } from "$lib/sdk-flow";

const CHECKOUT_REF_PATTERN = /^[a-zA-Z0-9_-]{3,128}$/;

/**
 * `/buy-2z` is the stable "get 2Z" link: the site's own buttons, the
 * `/checkout/<ref>` hand-off, and  SDK apps, which open
 * `/buy-2z?client_id=<id>` instead of selling 2Z themselves.
 *
 * It reads exactly three parameters and drops everything else, so no
 * caller can smuggle a `return`, `next` or any other value onto the billing
 * page:
 *
 * - `method`: `zcash`, `stripe`, or `card` (an alias for `stripe`), forwarded
 *   as `tab`. With no (or an unknown) method no `tab` is written: the billing
 *   page opens on Zcash by default, and only then may it fall back to Card
 *   when Zcash is unavailable. Writing `tab=zcash` here would turn "no
 *   preference" into an explicit choice and pin a visitor to an unavailable
 *   Zcash tab.
 * - `ref`: a `/checkout/<ref>` reference, by pattern.
 * - `client_id`: the app that sent the visitor, forwarded as `app` only when
 *   usable ($lib/sdk-flow `usableClientId`). The billing page never renders
 *   it; it only switches on one neutral "go back to your app" line.
 */
function billingQuery(url: URL): URLSearchParams {
  const query = new URLSearchParams();
  const method = url.searchParams.get("method");
  if (method === "stripe" || method === "card") query.set("tab", "stripe");
  else if (method === "zcash") query.set("tab", "zcash");

  const checkoutRef = url.searchParams.get("ref");
  if (checkoutRef && CHECKOUT_REF_PATTERN.test(checkoutRef)) {
    query.set("checkoutRef", checkoutRef);
  }

  const app = usableClientId(url.searchParams.get("client_id"));
  if (app) query.set("app", app);
  return query;
}

/** The same three parameters under their `/buy-2z` names, for the login return. */
function buyPath(query: URLSearchParams): string {
  const own = new URLSearchParams();
  const tab = query.get("tab");
  if (tab) own.set("method", tab);
  const checkoutRef = query.get("checkoutRef");
  if (checkoutRef) own.set("ref", checkoutRef);
  const app = query.get("app");
  if (app) own.set("client_id", app);
  const search = own.toString();
  return search ? `/buy-2z?${search}` : "/buy-2z";
}

export const load: PageServerLoad = async ({ cookies, fetch, url }) => {
  const query = billingQuery(url);
  // Only a 401/403 (or no session cookie) is "signed out"; a backend 5xx,
  // 429 or timeout is a 503 error page, never a login bounce. A
  // signed-out visitor comes back here after login, with the same sanitised
  // parameters and nothing else.
  const currentUser = await requireAuthenticatedUser(
    fetch,
    cookies,
    buyPath(query),
  );

  const search = query.toString();
  const billing = `/${currentUser.username}/dashboard/billing`;
  throw redirect(302, search ? `${billing}?${search}` : billing);
};
