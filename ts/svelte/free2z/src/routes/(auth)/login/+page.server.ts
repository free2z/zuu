import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import * as env from "$app/env/private";
import { getSafeNextPath } from "$lib/safe-next";

// The guard lives in $lib/safe-next — NOT $lib/server, because +page.svelte
// reads the same `next` for its post-login `goto()` and client code cannot
// import a server-only module. The login page and the retired classic entry
// points  therefore cannot drift apart. The version that used to be
// inline here accepted `/\evil.test/steal`, which browsers resolve to
// https://evil.test/steal — a same-origin open redirect. See that module.

export const load: PageServerLoad = async ({
  cookies,
  fetch,
  request,
  url,
}) => {
  const nextPath = getSafeNextPath(url.searchParams.get("next"));
  const apiBase = env.PRIVATE_API_BASE_URL || "";

  // No session cookie, no possible answer but "not signed in" — so do not
  // ask. This load runs for every arrival at the login page, and  now
  // routes the retired classic entry points (/begin, and anonymous
  // /profile, /profile/uploads, /events) here, which is precisely the
  // traffic that carries no cookie. Spending a backend round trip on it
  // turned a stalled Django into one occupied SSR request per visitor.
  if (!cookies.get("sessionid")) {
    return {};
  }

  // And when there IS a cookie, bound the lookup. Without a deadline this
  // fetch inherits the internal proxy's 200s patience while the public one
  // abandons new-ui at 60s, so a Django that accepts connections and then
  // stalls leaves abandoned requests piling up until the pod runs out of
  // sockets. Ten seconds is far more than a session lookup needs.
  const abort = new AbortController();
  const deadline = setTimeout(
    () => abort.abort(new Error("Login identity lookup timed out.")),
    10_000,
  );

  try {
    const cookieHeader = request.headers.get("cookie") || "";
    const userResponse = await fetch(`${apiBase}/api/auth/user/`, {
      signal: abort.signal,
      headers: {
        cookie: cookieHeader,
      },
    });

    if (userResponse.ok) {
      throw redirect(302, nextPath || "/");
    }
  } catch (err: any) {
    if (err?.status === 302) {
      throw err;
    }

    // If auth check fails, allow the page to render so user can log in.
  } finally {
    clearTimeout(deadline);
  }

  return {};
};
