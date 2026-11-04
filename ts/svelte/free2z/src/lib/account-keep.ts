/**
 * Account deletion's 30-day grace period (`dj.apps.g12f.account_deletion`).
 *
 * Every sign-in to an account whose deletion is pending is answered with
 * 409 `deletion_pending` and a short-lived keep token instead of a session.
 * The holder then chooses on `/account/keep`. The token rides in the URL
 * FRAGMENT, which the browser never sends to a server, so it reaches no
 * access log, proxy or Referer -- the same shape the X sign-in redirect uses.
 */
import { getSafeNextPath } from "$lib/safe-next";

export const KEEP_PAGE = "/account/keep";

export type DeletionPending = {
  code: "deletion_pending";
  keep_token: string;
  purge_after: string;
};

export function isDeletionPending(data: unknown): data is DeletionPending {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return (
    d.code === "deletion_pending" &&
    typeof d.keep_token === "string" &&
    d.keep_token.length > 0 &&
    typeof d.purge_after === "string"
  );
}

/**
 * The keep page for this answer. `next` is where the sign-in was headed (an
 * SDK app's `/oauth/authorize?...` above all): kept, the holder continues
 * there instead of starting the app's sign-in over.
 */
export function keepPageHref(
  pending: DeletionPending,
  next?: string | null,
): string {
  const fragment = new URLSearchParams({
    t: pending.keep_token,
    d: pending.purge_after,
  });
  const safeNext = getSafeNextPath(next ?? null);
  if (safeNext) fragment.set("n", safeNext);
  return `${KEEP_PAGE}#${fragment.toString()}`;
}

/** Where the current page's sign-in was headed (its `?next=`), if safe. */
export function currentNextPath(): string | null {
  try {
    return getSafeNextPath(
      new URL(window.location.href).searchParams.get("next"),
    );
  } catch (error) {
    console.error("account-keep: unreadable location", error);
    return null;
  }
}

/** Read (and the caller should then strip) the keep page's fragment. */
export function readKeepFragment(hash: string): {
  token: string;
  purgeAfter: string | null;
  next: string | null;
} | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("t");
  if (!token) return null;
  return {
    token,
    purgeAfter: params.get("d"),
    next: getSafeNextPath(params.get("n")),
  };
}
