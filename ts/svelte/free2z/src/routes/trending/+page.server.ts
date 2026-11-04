import { redirect } from "@sveltejs/kit";
import { zpageList } from "$lib/api/zpage/zpage";
import * as env from "$app/env/private";
import {
  TRENDING_PAGE_SIZE,
  parseTrendingParams,
  trendingHref,
} from "$lib/trending.js";

// A real, paginated trending view. The homepage buttons that promise
// "more trending" used to point at /search's empty state, which renders a blank
// search box — a dead end for exactly the visitor who asked for more content.
export async function load(event) {
  const { sort, page } = parseTrendingParams(event.url.searchParams);

  // Forward the session cookie so signed-in visitors get the same visibility
  // rules the rest of the app applies; anonymous requests stay anonymous.
  //
  // This is now live: `customInstance` used to clobber `init.headers` with the
  // generated descriptor's (undefined) headers, so the cookie never reached the
  // API and every SSR list rendered anonymous. Fixed in.
  //
  // Consequence: this response is per-visitor now (an authenticated list can
  // include the viewer's own unpublished pages), so it must never be served
  // from a shared cache keyed on URL alone. Cookie-backed success responses
  // are private and every response varies on Cookie. Set the success headers
  // only after the fetch resolves: SvelteKit rejects a second setHeaders call,
  // so the failure path must be the one and only header write when the fetch
  // fails.
  const cookie = event.request?.headers?.get("cookie");
  const options = {
    headers: cookie ? { cookie } : undefined,
    baseURL: env.PRIVATE_API_BASE_URL || "",
  };

  try {
    const response: any = await zpageList(
      {
        homeSort: sort,
        page,
        page_size: TRENDING_PAGE_SIZE,
        lang: event.locals.locale,
      } as any,
      options,
    );

    event.setHeaders(
      cookie
        ? { "cache-control": "private, no-cache", vary: "Cookie" }
        : { vary: "Cookie" },
    );

    return {
      sort,
      page,
      count: Number(response?.count) || 0,
      hasNext: Boolean(response?.next),
      hasPrevious: page > 1,
      stories: response?.results || [],
      failed: false,
    };
  } catch (error: any) {
    // DRF's paginator 404s on a page past the end. A hand-edited or stale
    // `?page=` is a navigation mistake, not an outage, so send the visitor to
    // page 1 of the sort they asked for instead of showing them an error.
    // This is the only header write on the failure path. In particular, do
    // not set the success policy before `zpageList`: SvelteKit throws when a
    // load function tries to replace an already-set header.
    event.setHeaders({ "cache-control": "no-store", vary: "Cookie" });

    if (error?.status === 404 && page > 1) {
      redirect(302, trendingHref({ sort }));
    }

    // Render an empty-but-navigable page rather than a 500: this route is
    // linked from the homepage, so an upstream blip must not become a hard
    // error page for a visitor who only clicked "see more".
    //
    // The trade-off (raised by the codex review) is that a degraded page is
    // served as HTTP 200, so it must not be cached or indexed as if it were the
    // real thing: `no-store` keeps any CDN/browser from pinning the empty
    // version, and the page renders `noindex` whenever `failed` is set. The
    // console.error is the outage signal; /trending is not an uptime probe
    // target, so a 200 here does not silence any monitor.
    console.error("Trending: zpage fetch failed", error);
    return {
      sort,
      page,
      count: 0,
      hasNext: false,
      hasPrevious: page > 1,
      stories: [],
      failed: true,
    };
  }
}
