import type { LayoutServerLoad } from "./$types";
import { getSessionCookie } from "$lib/server/backend";

export const load: LayoutServerLoad = ({ locals, cookies, url }) => {
  // The hook negotiates UI language from this query parameter. Declare the
  // dependency so SvelteKit reruns this load on client-side query navigation.
  url.searchParams.get("lang");
  return {
    locale: locals.locale,
    disabledLocales: locals.disabledLocales,
    localePersisted: locals.localePersisted,
    localeCatalogs: locals.localeCatalogs,
    // The only auth fact the server hands to the client.
    //
    // Django session auth cannot authenticate a request that carries no
    // `sessionid` cookie, so the cookie's ABSENCE is authoritative: this visitor
    // is anonymous, and the navbar renders Sign In in the server HTML with no
    // client round-trip and no placeholder. Its PRESENCE proves nothing — the
    // session may be expired or revoked — so it means only "do not claim logged
    // out yet"; `/api/auth/user/` remains the source of truth.
    //
    // Deliberately a boolean rather than the resolved user: putting the creator
    // object in the SSR payload would embed the visitor's email and 2Z balance
    // in cached-by-Vary HTML, and would put a blocking backend round-trip on the
    // render path of every signed-in page view. The cookie read costs nothing
    // and cannot fail.
    hasSession: Boolean(getSessionCookie(cookies)),
  };
};
