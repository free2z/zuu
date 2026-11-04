type ZPagePathIdentity = {
  creator?: { username?: string | null } | null;
  vanity?: string | null;
  free2zaddr?: string | null;
};

// Static product routes win before [username]/[vanity] in SvelteKit; the
// classic rollback router also treats the stream names case-insensitively.
const ROUTE_COLLISIONS = new Set([
  "broadcast",
  "dashboard",
  "null",
  "ppv",
  "private",
  "subscribers-only",
  "undefined",
  "zpage",
]);

// These literal prefixes own every two-segment URL in an ingress or at least
// one UI. The exact pairs below are narrower literal routes. Grandfathered
// creators can still hold these usernames, so their articles need the cross-UI
// /article/ escape hatch instead of a pretty URL that opens a product surface
// or is swallowed by an nginx asset/API namespace.
const TWO_SEGMENT_PREFIX_COLLISIONS = new Set([
  "_app",
  "adminzzz",
  "ai",
  "api",
  "article",
  "checkout",
  "classic-ui",
  "converse",
  "djstatic",
  "docs",
  "edit",
  "feeds",
  "gcsproxy",
  "live",
  "projects",
  "static",
  "tag",
  "try-new-ui",
  "uploads",
  "uploadz",
  "ws",
]);
const EXACT_TWO_SEGMENT_COLLISIONS = new Set([
  "begin/alt",
  "profile/kyc",
  "profile/uploads",
  "sitemap/static.xml",
  "tools/p2pe2e",
]);

function prettyPathCollides(username: string, identifier: string): boolean {
  const owner = username.toLowerCase();
  const child = identifier.toLowerCase();
  return (
    TWO_SEGMENT_PREFIX_COLLISIONS.has(owner) ||
    EXACT_TWO_SEGMENT_COLLISIONS.has(`${owner}/${child}`)
  );
}

/**
 * True when `/<username>/<identifier>` is owned by some other route and so
 * cannot be a pretty zPage URL — the same rules `zpageCanonicalPath` uses to
 * decide it must NOT emit that shape. Exported for the first-party embed
 * classifier, which reads URLs in the opposite direction.
 */
export function zpagePrettyPathCollides(
  username: string,
  identifier: string,
): boolean {
  return (
    ROUTE_COLLISIONS.has(identifier.toLowerCase()) ||
    prettyPathCollides(username, identifier)
  );
}

export function zpageCanonicalIdentifier(
  page: ZPagePathIdentity,
): string | null {
  for (const candidate of [page.vanity, page.free2zaddr]) {
    if (candidate && !ROUTE_COLLISIONS.has(String(candidate).toLowerCase())) {
      return String(candidate);
    }
  }
  return null;
}

export function zpageCanonicalPath(page: ZPagePathIdentity): string | null {
  const username = page.creator?.username;
  const identifier = zpageCanonicalIdentifier(page);
  // The immutable-address route is deliberately outside every creator
  // namespace. Even a grandfathered row whose vanity AND address now name
  // product routes remains reachable there: `/article/ppv` resolves `ppv` as
  // a zPage identifier, not as the creator livestream route.
  if (!identifier) {
    return page.free2zaddr
      ? `/article/${encodeURIComponent(String(page.free2zaddr))}`
      : null;
  }
  if (!username) return null;
  if (prettyPathCollides(username, identifier)) {
    return page.free2zaddr
      ? `/article/${encodeURIComponent(String(page.free2zaddr))}`
      : null;
  }
  return `/${encodeURIComponent(username)}/${encodeURIComponent(identifier)}`;
}
