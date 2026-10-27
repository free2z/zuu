import { redirect } from "@sveltejs/kit";
import { slugifyTag } from "$lib/tag-slug.js";
import { tagPageHref } from "$lib/tag.js";

/**
 * `/search?tag=X` → 301 `/tag/<slug>`.
 *
 * Google has already crawled a batch of `/search?tag=…` URLs, and creators
 * have shared them. Those links keep working; they now land on the indexable
 * hub instead of a `noindex` search screen that canonicalises onto bare
 * `/search`.
 *
 * THREE things this deliberately does NOT redirect, because each is a live
 * capability rather than a legacy URL:
 *
 *  * `?q=` combined with `?tag=` — a genuine two-axis filter (text AND tag)
 *    that the hub cannot express. Redirecting it would silently drop the
 *    visitor's query, which is a regression, not a fix.
 *  * `?q=` alone — free-text search results must stay `noindex, follow`, and
 *    that half of the current policy is correct.
 *  * a tag with no slug (`?tag=🔥`) — there is no `/tag/` URL to send it to,
 *    so `/search` remains the way to browse it.
 *
 * `?page=` is dropped rather than carried across. The two lists page at
 * different sizes (10 on `/search`, `TAG_PAGE_SIZE` = 12 on the hub), so
 * `?page=3` names a different slice on each side; landing on the hub's first
 * page is honest, and it avoids a 301 into a page number that may not exist
 * and would then 302 again.
 *
 * A universal load rather than `+page.server.ts` on purpose: `/search` has no
 * server load today and does not need one — this way a client-side navigation
 * resolves the redirect in the browser with no round trip, while a crawler or
 * a cold load still gets a real 301 out of SSR.
 */
export function load({ url }) {
  const tag = (url.searchParams.get("tag") || "").trim();
  const query = (url.searchParams.get("q") || "").trim();
  if (!tag || query) return {};

  const slug = slugifyTag(tag);
  if (!slug) return {};

  redirect(301, tagPageHref({ slug }));
}
