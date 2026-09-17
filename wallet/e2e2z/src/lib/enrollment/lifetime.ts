/**
 * How long an `issue-device-credential` *request* stays answerable, in
 * milliseconds.
 *
 * Two minutes, against §3.4's five-minute ceiling. The user has to read a
 * confirmation in another app, so seconds are too few; the ceiling exists
 * because "nothing here is a continuous grant" (#904), so the whole window
 * should be no longer than the task needs.
 *
 * Its own module so the enrollment screen can count down the same deadline the
 * request carries without statically importing the intent client, which
 * `bridge.ts` loads lazily.
 */
export const REQUEST_LIFETIME_MS = 120_000;
