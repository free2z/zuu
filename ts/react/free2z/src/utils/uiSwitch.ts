const STREAM_TYPES = ["broadcast", "ppv", "subscribers-only"];

const CLASSIC_ONLY_ROOTS = new Set([
  "ai",
  "begin",
  "events",
  "micvizz",
  "profile",
  "secretbackdrop",
  "storytime",
  "tools",
]);

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function appendSearch(pathname: string, search: string): string {
  return `${pathname}${search || ""}`;
}

function withQueryParam(search: string, key: string, value: string): string {
  const params = new URLSearchParams(search);
  params.set(key, value);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function renameQueryParam(
  search: string,
  sourceKey: string,
  destinationKey: string,
): string {
  const params = new URLSearchParams(search);
  const value = params.get(sourceKey);
  params.delete(sourceKey);
  if (value !== null) {
    params.set(destinationKey, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Convert a route known to the classic React app into its new-UI equivalent.
 * Routes without a safe counterpart deliberately fall back to the homepage.
 */
export function mapToNewUi(pathname: string, search = ""): string {
  const path = normalizePathname(pathname);

  if (path === "/" || path === "/converse") {
    return appendSearch(path, search);
  }

  if (path.startsWith("/converse/")) {
    return appendSearch(path, search);
  }

  const segments = path.split("/").filter(Boolean);

  if (segments.length === 3 && segments[1] === "zpage") {
    return appendSearch(`/${segments[0]}/${segments[2]}`, search);
  }

  if (segments.length === 3 && segments[1] === "private") {
    return appendSearch(
      `/${segments[0]}/private/${segments[2]}`,
      search,
    );
  }

  if (segments.length === 2 && STREAM_TYPES.includes(segments[1])) {
    return `/live/${segments[0]}${withQueryParam(
      search,
      "type",
      segments[1],
    )}`;
  }

  if (path === "/find") {
    return `/search${renameQueryParam(search, "search", "q")}`;
  }

  if (segments.length === 2 && segments[0] === "edit") {
    return `/edit${withQueryParam(search, "id", segments[1])}`;
  }

  // The classic root route serves either a creator or a legacy root zPage.
  // Keeping the segment works for creators and for the common legacy links;
  // canonical zPage links use the explicit /:username/zpage/:id case above.
  if (segments.length === 1 && !CLASSIC_ONLY_ROOTS.has(segments[0])) {
    return appendSearch(path, search);
  }

  return "/";
}

// Nginx owns the cookie and receives the destination as the path suffix of
// this switch URL. Keeping the destination's query outside a nested `next`
// parameter preserves its existing encoding without a second escape pass.
export function newUiSwitchHref(
  pathname: string,
  search = "",
  hash = "",
): string {
  return `/try-new-ui${mapToNewUi(pathname, search)}${hash || ""}`;
}

export function switchToNewUi(): void {
  window.location.assign(
    newUiSwitchHref(
      window.location.pathname,
      window.location.search,
      window.location.hash,
    ),
  );
}
