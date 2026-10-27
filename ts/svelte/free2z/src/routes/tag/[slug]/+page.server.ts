import { error, redirect } from "@sveltejs/kit";
import * as env from "$app/env/private";
import { taggingHubRetrieve } from "$lib/api/tagging/tagging";
import { zpageList } from "$lib/api/zpage/zpage";
import { TAG_PAGE_SIZE, parseTagPage, tagPageHref } from "$lib/tag.js";
import { slugifyTag } from "$lib/tag-slug.js";

/**
 * `/tag/<slug>` — the indexable topic hub.
 *
 * This MUST render its results server-side. That is not a preference, it is
 * the entire point of the issue: `/search?tag=` already showed the same pages
 * to a human and nothing at all to a crawler, because the results were fetched
 * from the browser. A hub whose markup arrives empty earns a soft-404 rather
 * than a ranking, which is the  defect verbatim.
 *
 * Two upstream calls, sequential because the second needs the first's answer:
 *
 *   1. `GET /api/tagging/hub/{slug}` — which tag NAMES this slug denotes (a
 *      slug is deliberately lossy, so there can be several), how many live
 *      pages they cover in total, and whether that clears the indexing gate.
 *   2. `GET /api/zpage/?hub_slug=…` — the page of results, from the same list
 *      endpoint the rest of the site uses. The backend resolves the complete
 *      component server-side, so the bounded display names cannot omit a live
 *      51st spelling.
 *
 * ANONYMOUS ON PURPOSE — no cookie is forwarded, unlike `/trending`. A topic
 * hub is public, shared content: forwarding the session would make the same
 * URL render differently per visitor (an author would see their own drafts),
 * which would put `count` and the rendered list out of step and would make the
 * response uncacheable for the crawler tier that this page exists for.
 */
export async function load(event) {
  const requested = event.params.slug;

  // Normalise before asking the backend: `/tag/Zcash`, `/tag/a--b` and
  // `/tag/zcash/` are all links somebody will write, and each is a second URL
  // over one result set. Send them to the canonical one instead of 404ing.
  // A slug that normalises to nothing (`/tag/..`, `/tag/🔥`) has no hub at
  // all — see `tag-slug.js`.
  const page = parseTagPage(event.url.searchParams);
  const slug = slugifyTag(requested);
  if (!slug) error(404, "No such tag.");
  if (slug !== requested) redirect(301, tagPageHref({ slug, page }));

  const options = { baseURL: env.PRIVATE_API_BASE_URL || "" };

  let hub: any;
  try {
    hub = await taggingHubRetrieve(encodeURIComponent(slug), options);
  } catch (cause: any) {
    // 404 is the documented answer for "nothing live under this slug",
    // including the case where every page belongs to a creator who has been
    // deactivated. Pass it through as a real 404: a 200 with an empty list
    // would be a thin page we asked Google to index.
    if (cause?.status === 404) error(404, "No such tag.");
    console.error("Tag hub: resolve failed", slug, cause);
    error(503, "Tag pages are temporarily unavailable.");
  }

  // The slug resolved through a `TagAlias`, including a TagAlias whose
  // original Tag is still live. The backend has already widened `names` and
  // `count` to the complete union, so redirecting the URL cannot strand the
  // alias-only pages. Two indexable URLs over that union are duplicate
  // content, so keep only the canonical public slug.
  if (hub?.slug && hub.slug !== slug) {
    redirect(301, tagPageHref({ slug: hub.slug, page }));
  }

  const names: string[] = Array.isArray(hub?.names) ? hub.names : [];
  if (names.length === 0) error(404, "No such tag.");

  let results: any[] = [];
  let count = Number(hub?.count) || 0;
  try {
    const response: any = await zpageList(
      {
        hub_slug: slug,
        page,
        page_size: TAG_PAGE_SIZE,
        lang: event.locals.locale,
      } as any,
      options,
    );
    results = response?.results || [];
    // Prefer the list's own count: it and the rendered rows come from one
    // query, so the pager can never promise a page the list will not serve.
    count = Number(response?.count) || 0;
  } catch (cause: any) {
    // DRF 404s a page past the end. A stale or hand-edited `?page=` is a
    // navigation mistake, not an outage — send the visitor to page 1 rather
    // than showing an error page.
    if (cause?.status === 404 && page > 1) {
      redirect(302, tagPageHref({ slug }));
    }
    // Anything else IS an outage, and this page must not paper over it with a
    // 200. `/trending` renders an empty-but-navigable page because it is
    // linked from the homepage; a tag hub is a page we are asking a crawler to
    // index, and a 200 carrying no results is precisely the soft-404 the whole
    // change exists to avoid. 503 + Retry-After is the honest answer and the
    // one a crawler handles correctly.
    console.error("Tag hub: list failed", slug, cause);
    error(503, "Tag pages are temporarily unavailable.");
  }

  // A hub whose first page is empty is not a page worth serving. This is
  // reachable without an error: the resolve and the list are two queries, so a
  // page can be unpublished between them.
  if (count === 0) error(404, "No such tag.");

  // NOT `public`. An earlier draft used `public, max-age=60` on the reasoning
  // that no session cookie is forwarded, so one URL has one body — and that
  // reasoning was wrong in a way the codex adversarial review caught.
  //
  // The response IS per-visitor, just not via the session: `event.locals.locale`
  // comes from the `free2z-locale` cookie (`hooks.server.ts`) and is passed to
  // `zpageList` above, so the article excerpts and titles come back localized,
  // and the component renders localized UI around them. Cloud CDN keys on
  // host + path + query; `Vary: Cookie` is NOT part of that key. A Spanish
  // visitor would have filled the edge cache and every later visitor —
  // Googlebot included — would have received Spanish HTML for this English URL,
  // for 60s and up to 600s more while stale.
  //
  // So this route sets NO cache header at all, deliberately. `hooks.server.ts`
  // applies `private, no-cache` + `Vary: Cookie` to every HTML response that
  // has not already claimed one — its `!response.headers.has("cache-control")`
  // guard is exactly the safeguard the `public` header was stepping over.
  // Inheriting it means this route cannot drift away from the site-wide policy
  // the next time the policy changes.

  return {
    slug,
    name: String(hub?.name || slug),
    names,
    page,
    count,
    results,
    // The hub response and the list response are separate reads. Use the
    // authoritative list count for SEO so a 3 -> 2 race cannot leave an
    // otherwise thin page indexable.
    // Keep the backend's shared quality decision authoritative. Requiring
    // the counts to agree also preserves the stale-read protection above
    // without copying the backend's threshold into this route.
    indexable: Boolean(hub?.indexable && count === Number(hub?.count)),
  };
}
