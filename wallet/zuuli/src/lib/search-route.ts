export const SEARCH_INPUT_LABEL = "Search creators, pages, and topics";

/** Search owns the chrome for every route mounted below `/search/*`. */
export function isSearchRoute(pathname: string): boolean {
  return pathname === "/search" || pathname.startsWith("/search/");
}

/** TopBar submissions enter the canonical Search route with a trimmed query. */
export function searchHref(query: string): string {
  const canonical = query.trim();
  return canonical ? `/search?q=${encodeURIComponent(canonical)}` : "/search";
}

/**
 * Update only Search's owned query parameter. Keeping unrelated parameters
 * makes this safe for future result filters and direct/bookmarked URLs.
 */
export function withSearchQuery(
  current: URLSearchParams,
  query: string,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (query) next.set("q", query);
  else next.delete("q");
  return next;
}
