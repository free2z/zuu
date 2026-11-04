/**
 * Raise one upload's access tier and hand back the object the SERVER
 * re-serialized — never the one the caller already had.
 *
 * This is the whole reason the helper exists rather than being three inline
 * lines at each call site. `GenericFile._get_prefix()` derives the URL prefix
 * from `access`: `public` is served from `/uploadz/public/` with no auth
 * subrequest, everything else from `/uploadz/` behind one. So a promotion
 * rewrites `url`, `thumbnail`, `thumb`/`card`/`banner` and every
 * `variants[].url` at once.
 *
 * A caller that PATCHes and then keeps using the URL it was already holding
 * inserts the OLD prefix for the NEW tier — which is precisely the broken
 * image the promotion was supposed to prevent, now with the extra insult of a
 * write that succeeded. That mistake is impossible here because nothing but
 * the parsed response is ever returned: there is no merge, no spread of the
 * input, and a response that does not carry a usable `id` + `url` is an error
 * rather than a silent fall back to the stale object.
 *
 * `request` is injected so the module is a plain function with no SvelteKit
 * imports — the call sites pass `apiFetch` (which attaches the CSRF token and
 * `credentials: "include"`), and the tests pass a stub.
 */

import type { MediaAccess } from "./mediaAccess";

export type MediaAccessRequest = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface PromoteMediaAccessOptions<T> {
  /** The upload as the client currently knows it. Used for its `id` ONLY. */
  item: T;
  /** The tier to move it to. */
  access: MediaAccess;
  request: MediaAccessRequest;
  /** Origin prefix for the API, e.g. `https://free2z.cash`. May be empty. */
  apiBase?: string;
  /**
   * "Does this file already work where I want to put it?", asked against the
   * FRESH object read from the server, before anything is written.
   *
   * A picker can sit open for a long time, and `/api/myuploads/` is a snapshot
   * from whenever it was loaded. Without this, a file the creator made public
   * in another tab is still "private" here and the promotion — which picks the
   * LEAST open tier that satisfies the slot — would PATCH it down to `members`
   * and break every `/uploadz/public/...` reference already published against
   * it. Answering "yes" makes this a no-op that returns the fresh object.
   *
   * Optional: leave it out and the write is unconditional.
   */
  satisfies?: (candidate: T) => boolean;
}

/**
 * DRF answers a rejected write either as `{"detail": "..."}` or as
 * `{"<field>": ["..."]}`. Showing the server's own words beats a generic
 * failure — the value it rejected is the one the creator just chose.
 */
async function readErrorDetail(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return "";
  for (const value of Object.values(body as Record<string, unknown>)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return "";
}

export class MediaAccessPromotionError extends Error {
  /**
   * True when the write MAY have been committed and we cannot tell.
   *
   * A rejected request (`!response.ok`) is a clean failure: nothing changed.
   * A dropped connection, or a 2xx whose body we cannot read, is not — Django
   * may well have committed `access: "public"`. Reporting that as "could not
   * change it" leaves the creator believing a file is private while it is
   * anonymously fetchable, which is the one wrong answer here. Callers must
   * re-read the authoritative state and say so.
   */
  readonly indeterminate: boolean;

  constructor(message: string, indeterminate = false) {
    super(message);
    this.indeterminate = indeterminate;
  }
}

/** Parse one `/api/myuploads/<id>/` body, or null if it is unusable. */
function readUpload<T extends { id: number }>(value: unknown): T | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { id?: unknown }).id !== "number" ||
    typeof (value as { url?: unknown }).url !== "string"
  ) {
    return null;
  }
  return value as T;
}

/**
 * Read one upload as the server currently has it, or null.
 *
 * Exported because the freshness problem is not confined to the write path: a
 * picker's list is a snapshot, and a file demoted in another tab since it was
 * listed is one nobody but the owner can open — with the SAME URL, because
 * `private` and `members` share a prefix, so nothing about the markdown would
 * look wrong.
 */
export async function readCurrentUpload<T extends { id: number }>({
  id,
  request,
  apiBase = "",
}: {
  id: number;
  request: MediaAccessRequest;
  apiBase?: string;
}): Promise<T | null> {
  return request(`${apiBase}/api/myuploads/${id}/`, { method: "GET" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => readUpload<T>(body))
    .catch(() => null);
}

/**
 * How open each tier is. Only the ORDER matters.
 *
 * Read through `accessRank()`, which maps anything unrecognised to the
 * `private` rung — the same direction `normalizeMediaAccess()` resolves an
 * unknown value, and for the same reason: a value we cannot read must never be
 * treated as more open than it might be. (Written out rather than imported so
 * this module keeps no runtime dependency and the node test runner can load it
 * on its own.)
 */
const ACCESS_RANK: Record<MediaAccess, number> = {
  private: 0,
  members: 1,
  public: 2,
};

function accessRank(value: string | null | undefined): number {
  return ACCESS_RANK[value as MediaAccess] ?? ACCESS_RANK.private;
}

export async function promoteMediaAccess<T extends { id: number }>({
  item,
  access,
  request,
  apiBase = "",
  satisfies,
}: PromoteMediaAccessOptions<T>): Promise<T> {
  const url = `${apiBase}/api/myuploads/${item.id}/`;

  // Re-read before writing, and NARROW the window — do not imagine it closes
  // it. `PATCH {access}` is an absolute assignment and `/api/myuploads/<id>/`
  // offers no ETag, `If-Match`, or promote-only operation to make this a
  // compare-and-set, so a write that lands between this read and the PATCH is
  // still overwritten: two tabs racing can still demote a file that a third
  // just made public, breaking every `/uploadz/public/...` link published
  // against it. Closing that needs a server-side precondition (raised by the
  // codex review of this PR; it is a `py/` change and deliberately not in this
  // one). What the read plus the rank check below buy is that the ORDINARY
  // stale-picker case — the snapshot is minutes old and nothing is racing —
  // cannot demote anything.
  if (satisfies) {
    const current = await readCurrentUpload<T>({
      id: item.id,
      request,
      apiBase,
    });

    // Refuse rather than fall through. This write is an ABSOLUTE tier
    // assignment on an object other pages may already reference: if the
    // authoritative state cannot be read, "promote" could just as easily be a
    // demotion that 401s every `/uploadz/public/...` link already published
    // against this file. Nothing has been written, so it is a clean failure
    // and a retry costs the creator one click.
    if (!current) {
      throw new MediaAccessPromotionError("");
    }

    if (satisfies(current)) return current;

    // Never write a tier LESS open than what the server just said. The caller
    // asks for the least-open tier that satisfies its slot, which is the right
    // request to make of a private file and the wrong one to make of a file
    // that turned out to be public. (Subject to the race above: this compares
    // against the read, not against the row at write time.)
    if (
      accessRank(access) <= accessRank((current as { access?: string }).access)
    ) {
      return current;
    }
  }

  let response: Response;
  try {
    response = await request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // ONLY `access`. Replaying title/description here would turn a
      // visibility change into a last-write-wins overwrite of fields this
      // dialog never showed the creator.
      body: JSON.stringify({ access }),
    });
  } catch (error) {
    // The request left; whether the server committed it is unknowable here.
    throw new MediaAccessPromotionError(
      error instanceof Error ? error.message : "",
      true,
    );
  }

  if (!response.ok) {
    // 4xx is Django answering: it looked at the request and refused it, so
    // nothing was committed. 5xx is not an answer — a worker restart, a proxy
    // timeout or a truncated upstream response all surface as an ordinary 502
    // or 504 that `fetch` RESOLVES, and any of them can follow a transaction
    // that already committed `access: "public"`. Calling that a clean failure
    // leaves the creator believing a file is private while it is anonymously
    // fetchable, so it joins the indeterminate bucket.
    throw new MediaAccessPromotionError(
      await readErrorDetail(response),
      response.status >= 500,
    );
  }

  const updated = readUpload<T>(await response.json().catch(() => null));

  // The write may well have landed, but without the new representation we
  // cannot know the new prefix, and guessing it is how a "fixed" image ships
  // broken. Refuse loudly — and as INDETERMINATE, not as a failure.
  if (!updated) throw new MediaAccessPromotionError("", true);

  return updated;
}
