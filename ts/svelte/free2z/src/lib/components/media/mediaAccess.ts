/**
 * The three access tiers an upload can have, and the one question every media
 * surface keeps asking about them: can anybody other than the owner fetch this
 * URL?
 *
 * The tiers are `GenericFile.ACCESS_CHOICES` in
 * `py/dj/apps/uploads/models.py`, and the server enforces them in
 * `uploads/views.py`:
 *
 * - `public`  — `_public_access_ok()`: served from `/uploadz/public/`, no auth
 *               subrequest at all.
 * - `members` — `_members_access_ok()`: the owner is active AND
 *               `owner.has_fan(user)`, i.e. a paying subscriber. This is the
 *               "subscribers only" tier.
 * - `private` — nothing else matches, so the auth subrequest 401s everyone but
 *               the owner.
 *
 * Anything the server does not recognise falls through both checks and is
 * therefore owner-only, which is why `normalizeMediaAccess()` resolves an
 * unknown value to `private` rather than guessing: a value we cannot read must
 * never be advertised as shareable.
 *
 * `GenericFile._get_prefix()` derives the URL prefix from this field, so
 * changing it changes `url`, `thumbnail`, `thumb`/`card`/`banner` and every
 * `variants[].url`. A caller that flips the level must take the whole
 * re-serialized object back from the server, never patch the string locally.
 */

export type MediaAccess = "private" | "members" | "public";

/**
 * Render order for every access picker: most open first, so the safest option
 * is never the one sitting under the cursor by default.
 */
export const MEDIA_ACCESS_LEVELS = ["public", "members", "private"] as const;

/**
 * What a fresh upload gets when the user does not choose. Private matches the
 * old React uploader and is the only safe default: a file cannot be un-shared
 * once a link is out.
 */
export const DEFAULT_UPLOAD_ACCESS: MediaAccess = "private";

export function normalizeMediaAccess(value?: string | null): MediaAccess {
  return (MEDIA_ACCESS_LEVELS as readonly string[]).includes(value ?? "")
    ? (value as MediaAccess)
    : "private";
}

/**
 * Is there anybody other than the owner who could open this file's URL? False
 * for `private`, which is why the dashboard hides Share on those rows: the
 * link resolves to a 401 for every recipient.
 */
export function isShareableAccess(value?: string | null): boolean {
  return normalizeMediaAccess(value) !== "private";
}

/**
 * ---------------------------------------------------------------------------
 * Slot rules — what a particular place on a zPage NEEDS
 * ---------------------------------------------------------------------------
 *
 * Everything above answers what a tier MEANS. What follows answers whether a
 * given file is reachable by the people who will see the slot it is about to
 * go into, and the editor's two slots do not need the same thing — they need
 * opposite things.
 *
 * ## Body images
 *
 * The body of a subscriber-only page is redacted for everyone who is not a
 * subscriber: `zPageDetailSerializer.to_representation` replaces `content`
 * with "Subscribe for exclusive content" once
 * `g12f/views/exception_handler.custom_exception_handler` has set
 * `_redact_content`. So an image inside that body only ever reaches
 * subscribers anyway, and a `members` upload — which
 * `uploads/views._members_access_ok()` serves to exactly `has_fan()` users —
 * is the paid-content model working correctly, not a mistake.
 *
 * Filtering the picker down to `public` (what the old React
 * `FileSelectorDialog` did, with a hardcoded `access=public` on the query)
 * hides that legitimate choice. The real requirement is weaker and exactly
 * right: the image must be *at least as reachable as the page's own content*.
 *
 * ## The cover / featured image
 *
 * `_redact_content` touches `content` and nothing else. `title`,
 * `description` and `featured_image` stay in the response for anonymous
 * readers, because the cover IS the teaser — it is what listings, search
 * results and OG/Twitter cards render for a page nobody has paid for. A
 * `members` or `private` cover is therefore broken by construction, on a
 * subscriber-only page just as much as on a public one.
 *
 * Hence: the stricter rule belongs to the slot that sounds more private.
 *
 * These live here rather than in a module of their own because they are only
 * meaningful in terms of `normalizeMediaAccess`, and a second file would be
 * the obvious place for a second, subtly different copy of the tier order.
 */

/**
 * The places that take an upload: the zPage editor's two, and a public
 * Converse post.
 *
 * ## Converse posts
 *
 * `post` is a STANDALONE Converse post (`Comment.content_type IS NULL`), or a
 * reply in a thread whose root is one — a reply inherits its parent's
 * attachment. Those are served to everyone, signed in or not, from the
 * stream, the thread page and the RSS feed, so an image in one must be
 * `public`, full stop — the same rule as a cover, never widened by a
 * `subscriberOnly` a caller might pass by mistake.
 *
 * NOT every comment is one. A comment under a zPage or an AI conversation is
 * exactly as visible as that parent (`py/dj/apps/comments/visibility.py`):
 * subscriber-only, a draft, a private conversation. Those are not this slot;
 * the Converse composer switches images off for them, because the comment
 * payload does not carry the parent's tier.
 */
export type MediaSlot = "body" | "cover" | "post";

export interface MediaSlotContext {
  slot: MediaSlot;
  /**
   * `zPage.is_subscriber_only`. Only meaningful for `body`; the cover rule is
   * the same either way, which is the whole point of the comment above.
   */
  subscriberOnly?: boolean;
  /** Local bytes use the public-only upload endpoint. */
  localUploadsAllowed?: boolean;
}

/**
 * Every tier that is readable by this slot's audience, most open first.
 *
 * Never empty: `public` satisfies every slot, so a caller can always offer the
 * creator a way forward.
 */
export function allowedAccessForSlot(context: MediaSlotContext): MediaAccess[] {
  if (context.slot === "cover" || context.slot === "post") return ["public"];
  return context.subscriberOnly ? ["public", "members"] : ["public"];
}

/** Can this file be used in this slot as it stands? */
export function satisfiesSlot(
  access: string | null | undefined,
  context: MediaSlotContext,
): boolean {
  return allowedAccessForSlot(context).includes(normalizeMediaAccess(access));
}

/**
 * The LEAST open tier that would make this file work in this slot, or `null`
 * when it already works.
 *
 * Least privilege matters here: promoting a `private` file to `public` so it
 * can illustrate a subscribers-only page would publish, to the open internet,
 * the one thing the creator is charging for. `members` is enough, so `members`
 * is what we ask for.
 */
export function requiredAccessForSlot(
  access: string | null | undefined,
  context: MediaSlotContext,
): MediaAccess | null {
  if (satisfiesSlot(access, context)) return null;
  const allowed = allowedAccessForSlot(context);
  // `allowedAccessForSlot` is ordered most-open-first, so the last entry is
  // the least-open tier that still satisfies the slot.
  return allowed[allowed.length - 1];
}

/** Where `_get_prefix()` puts a file nobody has to authenticate for. */
export const PUBLIC_MEDIA_PREFIX = "/uploadz/public/";
/**...and where it puts every other tier, behind nginx's auth subrequest. */
export const RESTRICTED_MEDIA_PREFIX = "/uploadz/";

/**
 * Every distinct upload path in this markdown that a logged-out reader cannot
 * fetch.
 *
 * The slot rule above is evaluated against the page's tier AT INSERT TIME, and
 * that tier is mutable: a creator can legitimately put a `members` image in a
 * subscribers-only page and then turn "Subscribers Only" off, at which point
 * the body is public and the image 401s for everyone but them. Nothing on the
 * server re-checks it, and the creator's own preview keeps working because
 * they own the file — so it stays broken silently. (Found by the codex review
 * of the PR that introduced the `members` allowance.)
 *
 * No request is needed to detect it: `GenericFile._get_prefix()` puts public
 * files under `/uploadz/public/` and everything else under `/uploadz/`, so the
 * prefix in the markdown IS the answer. A path under `/uploadz/public/` also
 * starts with `/uploadz/`, hence the order of the two tests below.
 *
 * A warning signal, not an authorization decision, and it is approximate in
 * BOTH directions, because a file's tier can change from the media dashboard
 * without the markdown changing:
 *
 * - false positive — a path listed here may since have been made public;
 * - false negative — a `/uploadz/public/...` path already in the markdown
 *   stops working the moment that upload is demoted to `members`/`private`,
 *   and this cannot see it. Catching that needs a lookup per referenced file,
 *   which is a bigger feature than a hint beside a switch. (Raised by the
 *   codex review of this PR; it is not new behaviour — demoting an in-use
 *   upload has always broken the pages referencing it.)
 *
 * So: say "check these", never "these are broken", and never block a save.
 */
export function restrictedMediaPaths(markdown: string): string[] {
  const found = new Set<string>();
  // ROOT-RELATIVE references only — what every editor insert path writes. The
  // leading group is what keeps `https://example.com/uploadz/x.png`, a path on
  // somebody else's host that happens to share the segment, out of the result;
  // a lookbehind would say the same thing, but `eslint-plugin-compat` polices
  // the browser baseline here and a capture group needs no argument.
  //
  // The trailing class stops at whitespace and at the delimiters a markdown
  // image/link or an HTML attribute closes with, so `![x](/uploadz/a.png)`
  // yields the path without the bracket.
  for (const match of markdown.matchAll(
    /(?:^|[\s("'<>])(\/uploadz\/[^\s)"'<>]+)/g,
  )) {
    const path = match[1];
    if (!path.startsWith(PUBLIC_MEDIA_PREFIX)) found.add(path);
  }
  return [...found];
}
