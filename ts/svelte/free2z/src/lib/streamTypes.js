// Plain JS (not TS) so the closed enum can be imported and exercised directly
// by `npm test` (node --test), the same way src/lib/locale.js is.

/**
 * The stream types `/live/{username}?type=` serves, and the ONLY values
 * `/api/dyte/{username}/{type}` accepts.
 *
 * This is a closed enum on the server: `dyte/urls.py` routes that segment
 * through a path converter built from `PUBLIC_MEETING_TYPES`, so anything else
 * does not resolve at all. Mirroring it here is not belt-and-braces
 * politeness — it stops the UI navigating to, and POSTing to, URLs the API
 * will refuse.
 *
 * `private` is deliberately absent. A private room is `is_public=False` and
 * has its own two routes: the creator manages it at `/api/dyte/{username}/
 * private` (their own username only, 403 otherwise) and invitees join at
 * `/{username}/private/{secret}`, where the secret is the credential. Passing
 * `?type=private` here used to reach the creator-only manage route from an
 * ordinary page load, which recycled the caller's invite secret and minted a
 * fresh paid provider meeting on every reload.
 *
 * @type {readonly ["broadcast", "subscribers-only", "ppv"]}
 */
export const PUBLIC_STREAM_TYPES = Object.freeze([
  "broadcast",
  "subscribers-only",
  "ppv",
]);

/**
 * Every stream type the platform has, public and private. Used for the shapes
 * that legitimately describe a private room (the RTK meeting store), never for
 * routing to `/live/{username}`.
 *
 * @type {readonly ["broadcast", "subscribers-only", "ppv", "private"]}
 */
export const STREAM_TYPES = Object.freeze([
  "broadcast",
  "subscribers-only",
  "ppv",
  "private",
]);

/**
 * The public types that additionally require a signed-in visitor.
 *
 * `broadcast` is open to anyone; the other two are gated on the server (402
 * without a subscription / without the tuzis for a PPV join). The guard in
 * `/live/[username]/+page.server.ts` only sends people to log in first so the
 * gate has an identity to check.
 *
 * @type {readonly ["subscribers-only", "ppv"]}
 */
export const AUTHENTICATED_STREAM_TYPES = Object.freeze([
  "subscribers-only",
  "ppv",
]);

/**
 * @param {string | null | undefined} value
 * @returns {value is "broadcast" | "subscribers-only" | "ppv"}
 */
export function isPublicStreamType(value) {
  return (
    typeof value === "string" &&
    /** @type {readonly string[]} */ (PUBLIC_STREAM_TYPES).includes(value)
  );
}

/**
 * @param {string | null | undefined} value
 * @returns {value is "subscribers-only" | "ppv"}
 */
export function requiresAuthenticatedViewer(value) {
  return (
    typeof value === "string" &&
    /** @type {readonly string[]} */ (AUTHENTICATED_STREAM_TYPES).includes(
      value,
    )
  );
}
