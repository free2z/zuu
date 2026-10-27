const CLASSIC_STREAM_TYPES = new Set(["broadcast", "ppv", "subscribers-only"]);
const CLASSIC_PAGE_ROUTE_COLLISIONS = new Set([
  "broadcast",
  "null",
  "ppv",
  "private",
  "subscribers-only",
  "undefined",
  "dashboard",
  "zpage",
]);
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
 * React Router's legacy two-segment route serves both streams and canonical
 * zPages. CreatorLive historically lowercased this segment before choosing an
 * API route, so retain case-insensitive stream matching in the rollback image.
 */
export function isClassicStreamType(segment?: string): boolean {
  return (
    segment !== undefined && CLASSIC_STREAM_TYPES.has(segment.toLowerCase())
  );
}

type ClassicPageIdentity = {
  creator?: { username?: string };
  vanity?: string | null;
  free2zaddr?: string;
};

/**
 * Build the same collision-safe public URL used by the compatibility reader.
 * The retained editor must not keep minting the retired /zpage/ form while it
 * is available as a rollback surface.
 */
export function classicPageCanonicalPath(
  page: ClassicPageIdentity,
): string | undefined {
  const actualCreator = page.creator?.username;
  const identifier = [page.vanity, page.free2zaddr].find(
    (candidate) =>
      candidate && !CLASSIC_PAGE_ROUTE_COLLISIONS.has(candidate.toLowerCase()),
  );
  if (!actualCreator || !identifier) return undefined;
  if (prettyPathCollides(actualCreator, identifier)) {
    if (!page.free2zaddr) return undefined;
    return `/article/${encodeURIComponent(page.free2zaddr)}`;
  }
  return `/${encodeURIComponent(actualCreator)}/${encodeURIComponent(
    identifier,
  )}`;
}

/**
 * The detail API resolves a vanity globally, but a canonical URL also names
 * its creator. Never render a globally resolved page under a different
 * creator's trusted namespace: redirect to the returned page's real owner
 * before fund/donate controls can mount.
 */
export type ClassicPageOwnerResolution =
  | { status: "not-required" }
  | { status: "verified" }
  | { status: "redirect"; path: string }
  | { status: "unverifiable" };

export function resolveClassicPageOwner(
  requestedCreator: string | undefined,
  page: ClassicPageIdentity,
): ClassicPageOwnerResolution {
  if (!requestedCreator) return { status: "not-required" };

  const actualCreator = page.creator?.username;
  const canonicalPath = classicPageCanonicalPath(page);
  if (!actualCreator || !canonicalPath) return { status: "unverifiable" };
  if (canonicalPath.startsWith("/article/")) {
    return { status: "redirect", path: canonicalPath };
  }
  if (requestedCreator === actualCreator) return { status: "verified" };

  return { status: "redirect", path: canonicalPath };
}
