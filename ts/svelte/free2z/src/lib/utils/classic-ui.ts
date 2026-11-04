import { browser } from "$app/env";

// nginx route (not a SvelteKit route) that clears the f2z_ui cookie and
// redirects to the equivalent classic route. It only
// exists on the domains where nginx serves both UIs side by side.
export const CLASSIC_UI_PATH = "/classic-ui";

const CLASSIC_UI_HOSTS = /(^|\.)(free2z\.cash|free2z\.com|free2give\.xyz)$/;
const STREAM_TYPES = ["broadcast", "ppv", "subscribers-only"];
const PRESERVED_CLASSIC_ROOTS = new Set([
  "docs",
  "events",
  "storytime",
  "tools",
]);
const NEW_UI_STATIC_ROOTS = new Set([
  "article",
  "buy-2z",
  "checkout",
  "converse",
  "creators",
  "dashboard",
  "edit",
  "healthz",
  "live",
  "login",
  "og",
  "private",
  "projects",
  "robots.txt",
  "search",
  "sitemap",
  "sitemap-v2.xml",
  "trending",
  "zpage",
]);

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function appendSearch(pathname: string, search: string): string {
  return `${pathname}${search || ""}`;
}

function queryWithout(search: string, key: string): string {
  const params = new URLSearchParams(search);
  params.delete(key);
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

export function classicUiAvailable(): boolean {
  return browser && CLASSIC_UI_HOSTS.test(window.location.hostname);
}

/**
 * Convert a new-UI route into its classic equivalent. The nginx switch route
 * still owns the cookie; this function only chooses the post-switch location.
 */
export function mapToClassicUi(pathname: string, search = ""): string {
  const path = normalizePathname(pathname);

  if (path === "/" || path === "/converse") {
    return appendSearch(path, search);
  }

  if (path.startsWith("/converse/")) {
    return appendSearch(path, search);
  }

  const segments = path.split("/").filter(Boolean);

  // These paths are served by the classic app or its docs location. They are
  // not new-UI zPages, so preserve them instead of applying the generic
  // two-segment username/vanity conversion.
  if (segments.length > 0 && PRESERVED_CLASSIC_ROOTS.has(segments[0])) {
    return appendSearch(path, search);
  }

  if (segments.length === 2 && segments[0] === "article") {
    return appendSearch(`/${segments[1]}`, search);
  }

  if (segments.length === 3 && segments[1] === "zpage") {
    return appendSearch(`/${segments[0]}/zpage/${segments[2]}`, search);
  }

  if (segments.length === 3 && segments[1] === "private") {
    return appendSearch(`/${segments[0]}/private/${segments[2]}`, search);
  }

  if (segments.length === 2 && segments[0] === "live") {
    const params = new URLSearchParams(search);
    const type = params.get("type") || "broadcast";
    if (STREAM_TYPES.includes(type)) {
      return `/${segments[1]}/${type}${queryWithout(search, "type")}`;
    }
    return "/";
  }

  if (path === "/search") {
    return `/find${renameQueryParam(search, "q", "search")}`;
  }

  if (path === "/creators") {
    return `/find${renameQueryParam(search, "q", "search")}`;
  }

  if (segments.length === 2 && segments[0] === "edit") {
    return appendSearch(`/edit/${segments[1]}`, search);
  }

  if (path === "/edit") {
    const params = new URLSearchParams(search);
    const id = params.get("id");
    if (id && id !== "new") {
      return `/edit/${encodeURIComponent(id)}${queryWithout(search, "id")}`;
    }
    return "/";
  }

  if (
    segments.length === 3 &&
    segments[1] === "dashboard" &&
    segments[2] === "notifications"
  ) {
    return appendSearch("/events", search);
  }

  if (segments.length === 3 && segments[1] === "dashboard") {
    return "/";
  }

  // New zPages use /:username/:vanity; the classic app's canonical equivalent
  // is /:username/zpage/:vanity. Static two-segment routes are excluded so a
  // new-only page can never turn into a misleading classic zPage URL.
  if (segments.length === 2 && !NEW_UI_STATIC_ROOTS.has(segments[0])) {
    return appendSearch(`/${segments[0]}/zpage/${segments[1]}`, search);
  }

  if (segments.length === 1 && !NEW_UI_STATIC_ROOTS.has(segments[0])) {
    return appendSearch(path, search);
  }

  return "/";
}

// Nginx owns the cookie and receives the destination as the path suffix of
// this switch URL. Keeping the destination's query outside a nested `next`
// parameter preserves its existing encoding without a second escape pass.
export function classicUiSwitchHref(
  pathname: string,
  search = "",
  hash = "",
): string {
  return `${CLASSIC_UI_PATH}${mapToClassicUi(pathname, search)}${hash || ""}`;
}

export function switchToClassicUi(): void {
  // Full-page navigation on purpose — the SvelteKit client router must not
  // intercept this path. nginx clears the cookie and redirects to the mapped
  // classic route.
  window.location.href = classicUiSwitchHref(
    window.location.pathname,
    window.location.search,
    window.location.hash,
  );
}
