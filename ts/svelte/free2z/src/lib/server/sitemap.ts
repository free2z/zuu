import { DEFAULT_LOCALE } from "$lib/locale.js";
import { CANONICAL_ORIGIN } from "$lib/seo";
import { isCanonicalTagSlug } from "$lib/tag-slug.js";
import {
  articleCanonicalHref,
  articleLanguageAlternates,
  cleanUrlLanguage,
} from "$lib/zpage-language.js";
import { zpageCanonicalPath } from "$lib/zpage-path.js";
import { parseApiDate } from "$lib/utils/date";

export type SitemapKind = "creators" | "zpages" | "tags";
/** One `xhtml:link rel="alternate"` inside a `<url>` group. */
export type SitemapAlternate = { hreflang: string; href: string };
export type SitemapEntry = {
  path: string;
  lastmod?: string | null;
  priority: string;
  changefreq: string;
  /**
   * The complete language cluster this URL belongs to, or absent when the URL
   * belongs to no cluster. Per the sitemap protocol every member of a cluster
   * lists every member *including itself*, so this array is shared verbatim by
   * each `<url>` the article produces.
   */
  alternates?: SitemapAlternate[];
};
export type SitemapPage = { page: number; count: number; revision: string };

export const SITEMAP_CHUNK_SIZE = 500;
export const MAX_SITEMAP_ENTRIES = 50_000;
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;

export const STATIC_SITEMAP_ENTRIES: SitemapEntry[] = [
  { path: "/", priority: "1.0", changefreq: "daily" },
  { path: "/creators", priority: "0.8", changefreq: "daily" },
  // Only page 1 of the default sort: later pages reorder URLs already listed
  // in the creator and zPage child sitemaps.
  { path: "/trending", priority: "0.8", changefreq: "daily" },
];

export class SitemapBuildError extends Error {}

export async function fetchSitemapBackend(
  fetch: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  requestSignal?: AbortSignal,
  timeoutMs = 55_000,
  headers?: HeadersInit,
) {
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(requestSignal?.reason);
  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException("Backend sitemap request timed out.", "TimeoutError"),
    );
  }, timeoutMs);

  if (requestSignal?.aborted) {
    abortFromRequest();
  } else {
    requestSignal?.addEventListener("abort", abortFromRequest, { once: true });
  }

  try {
    const response = await fetch(input, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { response, payload: undefined };
    }
    const payload = await response.json();
    return { response, payload };
  } finally {
    clearTimeout(timeout);
    requestSignal?.removeEventListener("abort", abortFromRequest);
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isoDate(value: string) {
  const date = parseApiDate(value);
  if (!date) {
    throw new SitemapBuildError("Backend sitemap date was invalid.");
  }
  return date.toISOString();
}

function validatePageManifest(value: unknown, label: string): SitemapPage[] {
  if (!Array.isArray(value)) {
    throw new SitemapBuildError(
      `Backend sitemap ${label} manifest was invalid.`,
    );
  }

  let previousPage = -1;
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["page", "count", "revision"]) ||
      !Number.isSafeInteger(item.page) ||
      (item.page as number) < 0 ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 1 ||
      (item.count as number) > SITEMAP_CHUNK_SIZE ||
      typeof item.revision !== "string" ||
      !/^[1-9]\d{0,3}-[A-Za-z0-9_-]{16}$/.test(item.revision) ||
      !item.revision.startsWith(`${item.count}-`) ||
      (item.page as number) <= previousPage
    ) {
      throw new SitemapBuildError(`Backend sitemap ${label} page was invalid.`);
    }
    previousPage = item.page as number;
    return {
      page: item.page as number,
      count: item.count as number,
      revision: item.revision as string,
    };
  });
}

export function parseSitemapIndexPayload(payload: unknown) {
  // EXACTLY the current shape, or EXACTLY the previous one. Not "the required
  // keys plus whatever else": the strictness is a deliberate fail-closed
  // guard, and `tests/canonical-url.test.mjs` pins that an unexpected key 503s
  // rather than being ignored.
  //
  // The `tags` kind  is optional here only because Django and SvelteKit
  // roll independently. During a rollout an OLD Django pod can answer a NEW
  // SvelteKit pod, and an index that 503s takes down the whole root sitemap
  // rather than merely omitting tag hubs. The reverse skew — new Django, old
  // SvelteKit — cannot be fixed from this side and is a bounded, self-healing
  // 503 with `Retry-After` for the length of one rollout.
  const knownShape =
    isRecord(payload) &&
    (hasExactKeys(payload, ["chunk_size", "creators", "zpages", "tags"]) ||
      hasExactKeys(payload, ["chunk_size", "creators", "zpages"]));
  if (!knownShape || payload.chunk_size !== SITEMAP_CHUNK_SIZE) {
    throw new SitemapBuildError("Backend sitemap index contract was invalid.");
  }

  const creators = validatePageManifest(payload.creators, "creator");
  const zpages = validatePageManifest(payload.zpages, "zPage");
  const tags =
    payload.tags === undefined ? [] : validatePageManifest(payload.tags, "tag");
  const childCount = 1 + creators.length + zpages.length + tags.length;
  if (childCount > MAX_SITEMAP_ENTRIES) {
    throw new SitemapBuildError(
      "Sitemap index exceeds the 50,000-child limit.",
    );
  }

  return { creators, zpages, tags };
}

export function parseSitemapChild(value: string) {
  const match = /^(0|[1-9]\d*)-([1-9]\d{0,3}-[A-Za-z0-9_-]{16})$/.exec(value);
  if (!match) return null;
  const page = Number(match[1]);
  return Number.isSafeInteger(page) ? { page, revision: match[2] } : null;
}

function parseCreatorEntries(value: unknown): SitemapEntry[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SITEMAP_CHUNK_SIZE
  ) {
    throw new SitemapBuildError(
      "Backend creator sitemap chunk size was invalid.",
    );
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["username"]) ||
      typeof item.username !== "string" ||
      !item.username
    ) {
      throw new SitemapBuildError("Backend creator sitemap row was invalid.");
    }
    return {
      path: `/${encodeURIComponent(item.username)}`,
      priority: "0.7",
      changefreq: "weekly",
    };
  });
}

/**
 * The most published variants one zPage may declare.
 *
 * Mirrors `SITEMAP_MAX_VARIANTS_PER_ZPAGE` in `py/dj/apps/g12f/views/sitemap.py`,
 * which enforces it at the database. Re-checking it here is not redundancy for
 * its own sake: this parser's whole job is to refuse a backend payload that
 * does not match the contract, and an unbounded array is exactly the shape
 * that turns a 500-row chunk into an arbitrarily large URL set.
 *
 * The write path's own ceiling: / cap a zPage at
 * `MAX_PUBLISHED_TRANSLATION_VARIANTS_PER_ZPAGE` published *translations* and
 * the source is excluded from that count, so that cap + 1 is the largest list
 * the API can produce. Derived rather than guessed, because a
 * variant dropped here is a URL no crawler is ever told about. 97 = 96 + 1
 * since; it was 65 = 64 + 1 in.
 *
 * **This must stay at or under `SITEMAP_MAX_URLS_PER_ZPAGE`.**  * that ceiling — not this bound — is what keeps a chunk under the protocol's
 * 50,000 URLs, by cutting any wider article down to it; before  a chunk
 * of articles past it made `renderUrlset` throw and 503ed the whole child.
 * What staying under it buys now is that no legitimately-published variant is
 * ever cut from the sitemap. A chunk of maximally-translated articles emits
 * 500 x 97 = 48,500 URLs today, so the publish cap is bracketed at 99 on the
 * Python side — and past it it is `SITEMAP_CHUNK_SIZE` that has to move, not
 * this. `py/dj/apps/g12f/test_language_derived_bounds.py` reads both literals
 * out of this file and asserts the relationship.
 */
export const MAX_SITEMAP_VARIANTS_PER_ZPAGE = 97;

/**
 * The bytes ONE zPage may contribute to a sitemap child.
 *
 * **This is the constant that keeps a multilingual corpus from 503ing its own
 * sitemap, and it is a BYTE budget rather than a variant count on purpose.**
 *
 * An article with `n` named variants contributes `n` `<loc>` elements, and the
 * sitemap protocol requires every member of a language cluster to list every
 * member including itself — so the chunk pays `n²` `xhtml:link` lines. A chunk
 * holds up to `SITEMAP_CHUNK_SIZE` articles. Measured with this module's own
 * renderer over a full 500-row chunk:
 *
 * | variants | 8-char user / 24-char vanity | 150 ASCII / 128 | 150 CJK / 128 |
 * | --- | --- | --- | --- |
 * | 4  | 1.5 MiB | 4.4 MiB | 18.1 MiB |
 * | 8  | 4.8 MiB | 14.3 MiB | **60.1 MiB — over the 50 MiB ceiling** |
 * | 32 | **62.5 MiB — over** | 190 MiB | — |
 * | 65 | 246 MiB | 757 MiB | 3,249 MiB |
 *
 *  took `MAX_SITEMAP_VARIANTS_PER_ZPAGE` from 65 to 97 and this constant
 * did NOT have to move, which is the strongest evidence that it was expressed
 * in the right unit. It is `MAX_SITEMAP_BYTES / SITEMAP_CHUNK_SIZE / 2` — no
 * variant term at all — so a wider cluster simply crosses the budget sooner
 * and degrades the same way: drop the `xhtml:link` block first, truncate the
 * `<loc>` list only as a last resort. At 97 variants the quadratic column
 * would be ~547 MiB of `xhtml:link`, and none of it is ever emitted.
 *
 * Two lessons, and the second is why this is not a count:
 *
 * 1. The 32 column is not hypothetical. That was the bound before, and
 *     made every content language linkable, so a chunk of articles each
 *    carrying 31 translations renders 62.5 MiB, `assertSitemapByteLength`
 *    throws, and that sitemap child 503s — taking up to 499 unrelated articles
 *    with it. Exactly the "capacity guard that fires on success" failure the
 *    Python-side comment block was written about, arriving from the other
 *    direction.
 * 2. **A variant count cannot express this bound, because URL length is the
 *    other factor and it is not small.** The first cut of  capped the
 *    cluster at 8 variants, derived from the 150-ASCII column. Django's
 *    `UnicodeUsernameValidator` allows a 150-CHARACTER username, and 150 CJK
 *    characters percent-encode to 1,350 bytes — so the same 8-variant rule
 *    renders 60.1 MiB and 503s anyway (found by the codex adversarial review,
 *    reproduced above against the real renderer). Any number chosen from a
 *    measurement is a number chosen from an assumed username.
 *
 * So the rule is expressed in the unit the ceiling is expressed in. An article
 * keeps its inline cluster while its whole rendered contribution fits this
 * budget; over it the `xhtml:link` block is dropped and, if even the bare
 * `<loc>` list does not fit, that list is truncated. `SITEMAP_CHUNK_SIZE`
 * articles times this budget is **half** `MAX_SITEMAP_BYTES` by construction,
 * so the chunk fits whatever a username contains — a proof rather than a
 * measurement.
 *
 * Dropping the inline cluster is not a downgrade. `<head>` annotation and
 * sitemap annotation are the two interchangeable ways to declare hreflang; the
 * `<head>` cluster is linear per response rather than quadratic per chunk, and
 * every URL in it is one this sitemap just told the crawler to fetch. Nothing
 * is claimed in one place and denied in the other — the sitemap simply stops
 * repeating a claim that costs `n²` to repeat. Truncating the `<loc>` list is
 * a real loss, which is why it is the last resort and only reachable with URLs
 * around 1.5 kB.
 */
export const SITEMAP_MAX_BYTES_PER_ZPAGE = Math.floor(
  MAX_SITEMAP_BYTES / SITEMAP_CHUNK_SIZE / 2,
);

/**
 * The most `<loc>` elements ONE zPage may contribute to a sitemap child.
 *
 * The URL-count twin of `SITEMAP_MAX_BYTES_PER_ZPAGE`, and it exists for the
 * same reason: so the protocol's 50,000-URL ceiling holds **by construction,
 * whatever an article's variant count**, instead of only while an arithmetic
 * bracket on the publish cap happens to be respected. It is
 * `MAX_SITEMAP_ENTRIES / SITEMAP_CHUNK_SIZE` — 100 — so a full chunk of
 * articles each at this ceiling is exactly 50,000 URLs and `renderUrlset`
 * cannot throw on count.
 *
 * Before this, a chunk's URL count was `SITEMAP_CHUNK_SIZE x <locs per
 * article>`, and the only thing holding it under 50,000 was the publish cap
 * sitting at or below 99. That bracket was also one short: a row with a NULL
 * source and no `en` lists the clean URL ON TOP of every named variant, so
 * the widest row the parser accepts is `MAX_SITEMAP_VARIANTS_PER_ZPAGE + 1`
 * URLs, not `MAX_SITEMAP_VARIANTS_PER_ZPAGE`. Past the ceiling the failure
 * was a 503 on the whole child, taking up to 499 unrelated articles with it.
 *
 * Today it is never reached: `MAX_SITEMAP_VARIANTS_PER_ZPAGE + 1` is 98, so
 * every row the parser can accept keeps every URL, in the same order —
 * `py/dj/apps/g12f/test_language_derived_bounds.py` reads this literal and
 * asserts both that and the chunk product. If the publish cap ever outgrows
 * it, the article degrades (its least-important `?lang=` URLs leave the
 * sitemap, still discoverable through every other variant's `<head>`
 * cluster) instead of 503ing its neighbours. Keeping legitimately published
 * variants inside it is the ledger's job, not this function's.
 */
export const SITEMAP_MAX_URLS_PER_ZPAGE = 100;

/**
 * The URLs one published zPage contributes, with their hreflang cluster.
 *
 * The single rule underneath all of it: **a `<loc>` must be its own page's
 * `rel=canonical`.** Advertising a URL that canonicalizes elsewhere is worse
 * than not advertising it — the engine drops the cluster and it takes a
 * recrawl to recover. So every decision here is delegated to the very
 * functions the article page computes its own `<link rel=canonical>` and
 * `rel=alternate` from (`src/lib/zpage-language.js`, established by ),
 * never re-derived.
 *
 * 1. **One variant** (`cleanUrlLanguage` names a language). Nothing is
 *    negotiated, the clean URL *is* that language's URL and is its own
 *    canonical. One entry, no alternates — byte-for-byte what this sitemap
 *    emitted before multilingual entries existed, which is what the
 *    overwhelming majority of articles keep.
 * 2. **Several variants, none we can name** (a legacy `und` source plus, say,
 *    a German translation). The article page emits no `hreflang` for a
 *    language outside the supported set, so neither may we — `und` in
 *    particular is never an `hreflang`. One entry, no alternates.
 * 3. **Several variants, at least one nameable.** Each named language gets its
 *    own self-canonical `?lang=` `<loc>`. The clean URL is listed *as well*
 *    when — and only when — it is still its own canonical, which is decided by
 *    what a cookie-less visitor (which is what a crawler is) resolves to:
 *    English if a published English variant exists, otherwise the source. When
 *    that resolves to a nameable language the clean URL canonicalizes to that
 *    language's `?lang=` URL and must not be listed; when it resolves to
 *    something unnameable (`und`, `de`) the clean URL canonicalizes to itself
 *    and dropping it would silently delete a real, indexable page from the
 *    sitemap the moment its first translation was published. Either way the
 *    clean URL is always the cluster's `x-default`, because it is the URL that
 *    negotiates.
 * 4. **More bytes than `SITEMAP_MAX_BYTES_PER_ZPAGE`.** The `<loc>` list is
 *    unchanged — every variant is still advertised — but the inline
 *    `xhtml:link` cluster is dropped, because it is the one term here that
 *    grows as variants squared. Only if the bare `<loc>` list still does not
 *    fit is it truncated. See that constant for the measurement and why the
 *    rule is bytes rather than a variant count.
 * 5. **More URLs than `SITEMAP_MAX_URLS_PER_ZPAGE`.** Unreachable at today's
 *    publish cap. The `<loc>` list is cut to the ceiling before any byte
 *    accounting, keeping the clean URL and the source's own URL first, so a
 *    chunk's URL count is bounded no matter how many variants one article
 *    names. See that constant.
 *
 * Exported for the capacity tests, which drive it past the parser's own
 * variant bound to prove the chunk bounds hold for ANY variant count.
 */
export function zpageSitemapEntries(
  path: string,
  lastmod: string,
  languages: string[] | undefined,
  sourceLanguage: string | undefined,
  canonicalOrigin: string,
): SitemapEntry[] {
  const entry = {
    lastmod,
    priority: "0.8",
    changefreq: "weekly",
  };
  if (!languages || cleanUrlLanguage(languages, sourceLanguage) !== null) {
    return [{ path, ...entry }];
  }

  const alternates = articleLanguageAlternates(path, languages, sourceLanguage);
  const named = alternates.filter(
    (alternate) => alternate.hreflang !== "x-default",
  );
  if (named.length === 0) return [{ path, ...entry }];

  // What the clean URL serves to a request carrying neither `?lang=` nor a
  // locale cookie — `resolveArticleLanguage` defaults to DEFAULT_LOCALE, and
  // `resolve_zpage_variant` falls back to the source when that variant does
  // not exist. Feeding it back through `articleCanonicalHref` asks the exact
  // question that matters: does that page canonicalize to itself?
  const cleanUrlServes = languages.includes(DEFAULT_LOCALE)
    ? DEFAULT_LOCALE
    : sourceLanguage;
  let locs = named
    .map((alternate) => alternate.href)
    .filter((href) => href !== path);
  if (
    articleCanonicalHref(path, cleanUrlServes, sourceLanguage, languages) ===
    path
  ) {
    locs.unshift(path);
  }
  if (locs.length > SITEMAP_MAX_URLS_PER_ZPAGE) {
    // Over the per-article URL ceiling. Keep, in this order: the clean URL
    // (already first when listed — the cluster's x-default), then the
    // source's own URL (the language the article was written in, which a
    // plain slice of a tag-sorted list drops whenever its tag sorts late),
    // then the rest in their existing order. The byte-budget truncation below
    // slices from the front, so this order is what it preserves too.
    const sourceHref = articleCanonicalHref(
      path,
      sourceLanguage,
      sourceLanguage,
      languages,
    );
    const first = locs.filter((href) => href === path || href === sourceHref);
    const rest = locs.filter((href) => href !== path && href !== sourceHref);
    locs = [...first, ...rest].slice(0, SITEMAP_MAX_URLS_PER_ZPAGE);
  }
  // Fit the article into its byte budget, cheapest loss first. Measured with
  // the REAL `renderUrl` on this article's longest `<loc>` rather than from an
  // arithmetic model of the template: a model is one edit away from being
  // wrong about a document whose overrun mode is a 503, and it is O(1) per
  // article either way because every `<url>` this article emits carries the
  // same `alternates` array and differs only by a `?lang=` tag.
  const widest = locs.reduce((a, b) => (b.length >= a.length ? b : a));
  const bytesWith = (group?: SitemapAlternate[]) =>
    locs.length *
    (byteLength(
      renderUrl({ path: widest, ...entry, alternates: group }, canonicalOrigin),
    ) +
      1);

  if (bytesWith(alternates) <= SITEMAP_MAX_BYTES_PER_ZPAGE) {
    return locs.map((loc) => ({ path: loc, ...entry, alternates }));
  }
  // Over budget: the annotation moves to each page's `<head>`. Omitting the
  // key entirely (rather than passing `[]`) keeps `renderUrlset` from
  // declaring the xhtml namespace for a document that never uses it.
  const bare = bytesWith();
  if (bare <= SITEMAP_MAX_BYTES_PER_ZPAGE) {
    return locs.map((loc) => ({ path: loc, ...entry }));
  }
  // Even the bare list does not fit, which takes URLs around 1.5 kB — a
  // 150-character CJK username at the schema maximum. Truncate rather than
  // overrun: an overrun throws, and a throw here 503s the whole child and
  // takes up to 499 unrelated articles offline. Never below one URL, so an
  // article cannot vanish from the sitemap entirely, and the clean URL (when
  // it is listed at all) is first in `locs` and so is the one kept.
  const perUrl = bare / locs.length;
  const room = Math.max(1, Math.floor(SITEMAP_MAX_BYTES_PER_ZPAGE / perUrl));
  return locs.slice(0, room).map((loc) => ({ path: loc, ...entry }));
}

function parseLanguages(value: unknown): string[] {
  // An EMPTY list is legal and means "this article names no language": since
  //  `source_language` is nullable, and NULL — "detection has not run
  // yet" — is what  M7 replaces `und` with. Such an article has exactly
  // one URL and no cluster, which is what `zpageSitemapEntries` does with `[]`.
  // Rejecting it would 503 an entire chunk the first day detection leaves a
  // row unlabelled.
  if (
    !Array.isArray(value) ||
    value.length > MAX_SITEMAP_VARIANTS_PER_ZPAGE ||
    !value.every((language) => typeof language === "string" && language)
  ) {
    throw new SitemapBuildError(
      "Backend zPage sitemap languages were invalid.",
    );
  }
  return value as string[];
}

function parseZPageEntries(
  value: unknown,
  canonicalOrigin: string,
): SitemapEntry[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SITEMAP_CHUNK_SIZE
  ) {
    throw new SitemapBuildError(
      "Backend zPage sitemap chunk size was invalid.",
    );
  }
  return value.flatMap((item) => {
    // Three accepted shapes, because Django and SvelteKit are separate
    // Deployments that roll independently: during a rollout a new SvelteKit
    // replica can be handed a chunk from a Django replica that predates
    // language entries. Accepting the older shape makes that direction emit
    // exactly today's sitemap instead of a 503. The newest shape adds the
    // immutable address needed to escape product-route collisions. It is
    // header-negotiated so an old SvelteKit replica still receives the exact
    // localized shape it knows while Django rolls independently.
    const localized =
      isRecord(item) &&
      hasExactKeys(item, [
        "username",
        "vanity",
        "updated_at",
        "languages",
        "source_language",
      ]);
    const collisionSafe =
      isRecord(item) &&
      hasExactKeys(item, [
        "username",
        "vanity",
        "free2zaddr",
        "updated_at",
        "languages",
        "source_language",
      ]);
    const hasLanguages = localized || collisionSafe;
    if (
      !isRecord(item) ||
      (!localized &&
        !collisionSafe &&
        !hasExactKeys(item, ["username", "vanity", "updated_at"])) ||
      typeof item.username !== "string" ||
      !item.username ||
      typeof item.vanity !== "string" ||
      !item.vanity ||
      (collisionSafe &&
        (typeof item.free2zaddr !== "string" || !item.free2zaddr)) ||
      typeof item.updated_at !== "string" ||
      // null is a real value here: "detection has not run yet".
      (hasLanguages &&
        item.source_language !== null &&
        typeof item.source_language !== "string")
    ) {
      throw new SitemapBuildError("Backend zPage sitemap row was invalid.");
    }
    const path = collisionSafe
      ? zpageCanonicalPath({
          creator: { username: item.username },
          vanity: item.vanity,
          free2zaddr: item.free2zaddr as string,
        })
      : `/${encodeURIComponent(item.username)}/${encodeURIComponent(item.vanity)}`;
    if (!path) {
      throw new SitemapBuildError("Backend zPage sitemap path was invalid.");
    }
    return zpageSitemapEntries(
      path,
      isoDate(item.updated_at),
      hasLanguages ? parseLanguages(item.languages) : undefined,
      hasLanguages
        ? ((item.source_language as string | null) ?? undefined)
        : undefined,
      canonicalOrigin,
    );
  });
}

/**
 * One `/tag/<slug>` topic hub per row.
 *
 * No `lastmod`: `taggit.models.Tag` has no `updated_at`, and inventing one
 * (say, the newest page carrying the tag) would cost a join on an aggregate
 * that already runs inside a 1s statement timeout. `lastmod` is optional in
 * the protocol and an absent one is honest; a wrong one trains a crawler to
 * ignore the field.
 *
 * `daily`/`0.5`: a hub's content changes whenever anyone publishes under the
 * tag, which is more often than a creator profile changes, but it is a
 * discovery surface rather than the thing being ranked — every article it
 * lists is already in the zPage children at 0.8.
 *
 * The slug is validated, not trusted: it is a path segment this process is
 * about to write into an XML document, and the backend is a separate
 * deployment that can be older than this one.
 */
function parseTagEntries(value: unknown): SitemapEntry[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SITEMAP_CHUNK_SIZE
  ) {
    throw new SitemapBuildError("Backend tag sitemap chunk size was invalid.");
  }
  return value.map((item) => {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ["slug"]) ||
      typeof item.slug !== "string" ||
      !isCanonicalTagSlug(item.slug)
    ) {
      throw new SitemapBuildError("Backend tag sitemap row was invalid.");
    }
    return {
      path: `/tag/${encodeURIComponent(item.slug)}`,
      priority: "0.5",
      changefreq: "daily",
    };
  });
}

export function parseSitemapChunkPayload(
  payload: unknown,
  expectedKind: SitemapKind,
  expectedPage: number,
  // The `<loc>` and `xhtml:link` hrefs carry it, so it is part of the byte
  // budget in `zpageSitemapEntries`. Defaulted to the production origin rather than
  // required: every caller that renders also passes it, and a caller that only
  // parses still gets a realistic measurement.
  canonicalOrigin: string = CANONICAL_ORIGIN,
) {
  const entriesKey = expectedKind;
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ["kind", "page", entriesKey]) ||
    payload.kind !== expectedKind ||
    payload.page !== expectedPage
  ) {
    throw new SitemapBuildError("Backend sitemap chunk contract was invalid.");
  }

  if (expectedKind === "creators") return parseCreatorEntries(payload.creators);
  if (expectedKind === "tags") return parseTagEntries(payload.tags);
  return parseZPageEntries(payload.zpages, canonicalOrigin);
}

export function assertSitemapByteLength(
  byteLength: number,
  maxBytes = MAX_SITEMAP_BYTES,
) {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > maxBytes
  ) {
    throw new SitemapBuildError("Sitemap XML exceeds the 50 MiB limit.");
  }
}

export function renderSitemapIndex(paths: string[], canonicalOrigin: string) {
  if (paths.length < 1 || paths.length > MAX_SITEMAP_ENTRIES) {
    throw new SitemapBuildError("Sitemap index child count was invalid.");
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
  .map(
    (path) => `  <sitemap>
    <loc>${escapeXml(`${canonicalOrigin}${path}`)}</loc>
  </sitemap>`,
  )
  .join("\n")}
</sitemapindex>
`;
  assertSitemapByteLength(new TextEncoder().encode(body).byteLength);
  return body;
}

const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

function renderUrl(entry: SitemapEntry, canonicalOrigin: string) {
  // Element order is the sitemap 0.9 content model (loc, lastmod, changefreq,
  // priority) with the alternates immediately after `loc`, which is where
  // Google's hreflang annotation documents them.
  const lines = [
    "  <url>",
    `    <loc>${escapeXml(`${canonicalOrigin}${entry.path}`)}</loc>`,
    ...(entry.alternates ?? []).map(
      (alternate) =>
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}"` +
        ` href="${escapeXml(`${canonicalOrigin}${alternate.href}`)}"/>`,
    ),
  ];
  if (entry.lastmod) lines.push(`    <lastmod>${entry.lastmod}</lastmod>`);
  lines.push(
    `    <changefreq>${entry.changefreq}</changefreq>`,
    `    <priority>${entry.priority}</priority>`,
    "  </url>",
  );
  return lines.join("\n");
}

export function renderUrlset(entries: SitemapEntry[], canonicalOrigin: string) {
  if (entries.length < 1 || entries.length > MAX_SITEMAP_ENTRIES) {
    throw new SitemapBuildError("Sitemap URL count was invalid.");
  }
  // Declared only when something uses it, so a sitemap with no translated
  // article is byte-for-byte the document this route served before.
  const xhtml = entries.some((entry) => entry.alternates?.length)
    ? ` xmlns:xhtml="${XHTML_NAMESPACE}"`
    : "";
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtml}>
${entries.map((entry) => renderUrl(entry, canonicalOrigin)).join("\n")}
</urlset>
`;
  assertSitemapByteLength(new TextEncoder().encode(body).byteLength);
  return body;
}

export function xmlResponse(
  body: string,
  cacheControl = "public, max-age=3600",
) {
  return new Response(body, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": cacheControl,
    },
  });
}

export function badRequestResponse() {
  return new Response("Sitemap query parameters are not accepted.\n", {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function notFoundResponse() {
  return new Response("Sitemap child not found.\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function unavailableResponse(retryAfter = "300") {
  const safeRetryAfter = /^[0-9]+$/.test(retryAfter) ? retryAfter : "300";
  return new Response("Sitemap temporarily unavailable.\n", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": safeRetryAfter,
    },
  });
}
