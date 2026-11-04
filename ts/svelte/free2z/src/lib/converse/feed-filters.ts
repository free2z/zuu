/**
 * URL <-> filter state for the Converse microblog stream.
 *
 * Three separate reasons this is a module and not inline in `+page.svelte`:
 *
 * 1. **A filtered stream has to be linkable.** Classic mirrored its filter
 *    state into the URL (`ConverseList.tsx:177-188`); the SvelteKit rewrite
 *    dropped that, so "the tag I follow, newest first" was un-shareable and
 *    did not survive a reload.
 * 2. **The backend filters already exist and were unreachable.** `tags` and
 *    `subscribed_to` are declared on `CommentFilter`
 *    (`py/dj/apps/comments/views.py:56-80`) and generated into
 *    `CommentsListParams` — the page hand-rolled its own `fetch` and used
 *    neither.
 * 3. **It is the only part of the feed a `node --test` run can hold still.**
 *    Everything else needs a browser.
 *
 * `subscribed_to` is the one filter that depends on who is asking:
 * `filter_subscribed_to` returns the queryset **unchanged** for an anonymous
 * caller rather than erroring, so an anonymous visitor on a `?subscribed=1`
 * link silently sees the unfiltered firehose. We make that explicit instead of
 * inheriting it: {@link converseListParams} omits the parameter entirely when
 * the caller is not authenticated, so the request we send says what we mean.
 * The URL keeps the flag, so signing in applies it without re-navigating.
 *
 * Nothing here widens visibility. `/api/comments/` is scoped by
 * `scope_comments_to_visible_parents`, which is what keeps a deactivated
 * author's standalone posts off the list  — these parameters only ever
 * narrow the already-scoped queryset.
 */
import type { CommentsListParams } from "$lib/api/f2z.schemas";

/** The global microblog feed, syndicated. Classic linked this from `/` and
 * `/converse`; the new UI shipped without it. */
export const CONVERSE_RSS_PATH = "/feeds/converse/recent.xml";

/** `ordering_fields = ['created_at', 'tuzis']` — anything else is a 400. */
export type ConverseSort = "new" | "hot";

/**
 * `stream` is the firehose: one card per post, newest first, exactly what the
 * API returned. `threads` is the root-collapsing digest.
 */
export type ConverseView = "stream" | "threads";

export interface ConverseFilters {
  search: string;
  sort: ConverseSort;
  tags: string[];
  subscribed: boolean;
  view: ConverseView;
  /** "Microblog only": standalone posts, no replies. `parent__isnull=true`
   * on the wire. */
  posts: boolean;
}

/** At most this many tags go on the wire. `CommaSeparatedCharFilter` ANDs one
 * `tags__name__iexact` JOIN per value, so an unbounded list from a hand-typed
 * URL is an unbounded number of joins. */
export const MAX_CONVERSE_TAGS = 8;

export const DEFAULT_CONVERSE_FILTERS: ConverseFilters = {
  search: "",
  sort: "new",
  tags: [],
  subscribed: false,
  view: "stream",
  posts: false,
};

const SORTS: readonly ConverseSort[] = ["new", "hot"];
const VIEWS: readonly ConverseView[] = ["stream", "threads"];

const ORDERING: Record<ConverseSort, string> = {
  new: "-created_at",
  hot: "-tuzis",
};

/**
 * Split a raw tag string into a clean list.
 *
 * **Commas only.** Tag names here genuinely contain spaces — the tag-filter
 * browser fixture uses `shielded-pool accounting notes` — and the backend
 * matches the whole name with `iexact`. Splitting on whitespace would turn
 * `?tags=zero%20knowledge` into two ANDed filters, `zero` and `knowledge`,
 * which matches nothing while looking like an empty result set. A comma is
 * also what goes on the wire, so the input separator and the wire separator
 * are the same character and there is nothing to get wrong.
 *
 * A leading `#` is stripped because people type it, and the list is
 * de-duplicated case-insensitively because `iexact` makes `Zcash,zcash` two
 * identical JOINs and zero extra results.
 */
export function parseTagList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of String(raw).split(",")) {
    // Collapse internal runs of whitespace so `zero   knowledge` and
    // `zero knowledge` are the same query.
    const tag = piece.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_CONVERSE_TAGS) break;
  }
  return tags;
}

function readParams(
  input: URLSearchParams | URL | string | null | undefined,
): URLSearchParams {
  if (!input) return new URLSearchParams();
  if (input instanceof URLSearchParams) return input;
  if (typeof input === "string")
    return new URLSearchParams(
      input.startsWith("?")
        ? input.slice(1)
        : input.includes("?")
          ? input.slice(input.indexOf("?") + 1)
          : input,
    );
  return input.searchParams;
}

function readFlag(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLocaleLowerCase();
  return normalized === "" || ["1", "true", "yes", "on"].includes(normalized);
}

/** Read filter state out of a URL. Unknown or malformed values fall back to
 * the default rather than failing — a hand-edited URL must still render a
 * feed. */
export function parseConverseFilters(
  input: URLSearchParams | URL | string | null | undefined,
): ConverseFilters {
  const params = readParams(input);
  const sort = params.get("sort")?.trim().toLocaleLowerCase() as ConverseSort;
  const view = params.get("view")?.trim().toLocaleLowerCase() as ConverseView;
  return {
    search: (params.get("q") || "").trim(),
    sort: SORTS.includes(sort) ? sort : DEFAULT_CONVERSE_FILTERS.sort,
    tags: parseTagList(params.get("tags")),
    subscribed: readFlag(params.get("subscribed")),
    view: VIEWS.includes(view) ? view : DEFAULT_CONVERSE_FILTERS.view,
    posts: readFlag(params.get("posts")),
  };
}

/**
 * Serialize filter state for the address bar. Defaults are omitted, so the
 * unfiltered feed stays a bare `/converse` and every parameter that IS present
 * is one the visitor chose.
 */
export function converseFiltersToSearchParams(
  filters: ConverseFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.sort !== DEFAULT_CONVERSE_FILTERS.sort)
    params.set("sort", filters.sort);
  if (filters.tags.length) params.set("tags", filters.tags.join(","));
  if (filters.subscribed) params.set("subscribed", "1");
  if (filters.view !== DEFAULT_CONVERSE_FILTERS.view)
    params.set("view", filters.view);
  if (filters.posts) params.set("posts", "1");
  return params;
}

/** `""` for the default feed, otherwise `"?..."` — ready to concatenate onto
 * a pathname. */
export function converseFiltersToQuery(filters: ConverseFilters): string {
  const query = converseFiltersToSearchParams(filters).toString();
  return query ? `?${query}` : "";
}

/** A stable identity for a filter set, so a reactive statement can tell a real
 * change from a re-render. */
export function converseFiltersKey(filters: ConverseFilters): string {
  return converseFiltersToSearchParams(filters).toString();
}

export interface ConverseRequestContext {
  /** Whether Django will recognise a session on this request. */
  authenticated: boolean;
}

/**
 * What identifies "the next page to fetch", per mode. **The stream's
 * token is the raw opaque `cursor` query-parameter VALUE extracted from the
 * response's `next` URL** -- never the full URL, which would couple the client
 * to where the API is hosted and double-encode on reuse. Numbered modes keep a
 * 1-based integer. `null` always means "page one" going in and "end of feed"
 * coming out.
 */
export type ConversePageToken = number | string | null;

/**
 * The stream view under the New sort is the only cursored combination: it is
 * a live firehose read newest-first, exactly the shape keyset pagination
 * exists for. A post arriving between two offset pages shifts every row by
 * one, so one post crosses the boundary and is served twice or -- because the
 * page de-dupes by uuid -- silently not at all. The thread digest keeps
 * page-number results by design (it consumes up to three API pages per
 * screenful), and Hot cannot be cursored at all: `-tuzis` is mutable, and the
 * backend refuses the combination with a 400.
 */
export function isCursorStream(filters: ConverseFilters): boolean {
  return filters.sort === "new" && filters.view === "stream";
}

/** True when the URL asks for exactly what `converse/+page.server.ts`
 * fetches: the unfiltered, newest-first, cursored stream. Anything else must
 * discard the server-rendered page and load client-side. */
export function isServerRenderedStream(filters: ConverseFilters): boolean {
  return (
    isCursorStream(filters) &&
    !filters.search &&
    filters.tags.length === 0 &&
    !filters.subscribed &&
    !filters.posts
  );
}

/** Extract the opaque cursor token out of an envelope's `next` URL.
 * Anything malformed -- not a URL, a foreign path, no cursor parameter, an
 * empty one -- yields `null`, which callers treat as end-of-feed rather than
 * as an error: a broken link must not take down the feed. The host is
 * deliberately NOT checked: the token is opaque and is re-sent only to our
 * own API, where an invalid one is a 404 and therefore end-of-feed anyway. */
export function cursorFromNextUrl(next: unknown): string | null {
  if (typeof next !== "string" || !next) return null;
  try {
    const parsed = new URL(next, "https://free2z.invalid");
    if (parsed.pathname !== "/api/comments/") return null;
    return parsed.searchParams.get("cursor") || null;
  } catch {
    return null;
  }
}

/**
 * The next page token given one response envelope. Cursor mode carries the
 * token out of `next` ({@link cursorFromNextUrl}); numbered modes advance the
 * integer. A missing `next` means end-of-feed in both modes.
 */
export function nextPageToken(
  filters: ConverseFilters,
  response: { next?: unknown } | null | undefined,
  current: ConversePageToken,
): ConversePageToken {
  if (!response?.next) return null;
  if (isCursorStream(filters)) return cursorFromNextUrl(response.next);
  return pageNumber(current) + 1;
}

function pageNumber(token: ConversePageToken): number {
  return typeof token === "number" && Number.isSafeInteger(token) && token > 0
    ? token
    : 1;
}

/**
 * Build the `GET /api/comments/` query for one page of the feed.
 *
 * `pageToken` comes from {@link nextPageToken}: for the default stream view
 * under the New sort it is the opaque cursor string (or `null` for page one),
 * and the request opts into keyset stability via `pagination=cursor` with NO
 * `page` parameter -- the two are mutually exclusive on the backend. Every
 * other combination (threads digest, Hot sort) keeps numbered pages, sending
 * `page=1` explicitly because it makes the request self-describing in the
 * network tab and DRF treats it identically to no page at all.
 */
export function converseListParams(
  filters: ConverseFilters,
  pageToken: ConversePageToken,
  context: ConverseRequestContext,
): CommentsListParams {
  const ordering = ORDERING[filters.sort] ?? ORDERING.new;
  const params: CommentsListParams = isCursorStream(filters)
    ? { ordering, pagination: "cursor" }
    : { ordering, page: pageNumber(pageToken) };
  if (
    isCursorStream(filters) &&
    typeof pageToken === "string" &&
    pageToken.length > 0
  ) {
    params.cursor = pageToken;
  }
  if (filters.search) params.search = filters.search;
  if (filters.tags.length) params.tags = filters.tags.join(",");
  // "Microblog only" is BOTH conditions, never just `parent__isnull`: a
  // first-level comment on a zPage or an AI conversation also has no parent,
  // and would otherwise still show up in a feed labelled "Posts". A standalone
  // converse post is `parent IS NULL AND content_type IS NULL`.
  if (filters.posts) {
    params.parent__isnull = true;
    params.content_type__isnull = true;
  }
  // Anonymous callers never send it: the backend would ignore it silently and
  // return the unfiltered firehose under a UI that claims to be filtered.
  if (filters.subscribed && context.authenticated) params.subscribed_to = true;
  return params;
}
