/**
 * The one guard for every "come back here after signing in" destination.
 *
 * A `next` parameter is an open-redirect sink: whatever it says ends up in a
 * `Location:` header on a free2z origin, which is exactly the shape a phishing
 * link wants. There is no second implementation of this on purpose — the login
 * page and the retired classic routes  both call it, so a fix here
 * cannot half-land.
 *
 * Rejected, and why each one matters:
 *
 *  * anything not starting with `/` — an absolute URL is another origin.
 *  * `//host` — protocol-relative, i.e. another origin wearing a leading
 *    slash.
 *  * `/\host` and `/%5Chost` — the one that is easy to miss. Browsers
 *    normalise a backslash to a forward slash while resolving a URL, so
 *    `/\evil.test/steal` reaches `https://evil.test/steal` even though it
 *    passes both checks above. This is the defect the codex review of
 *    found in the existing login guard.
 *  * control characters and whitespace — CR/LF is header injection, and a
 *    leading tab or newline is stripped by browsers before parsing, which can
 *    smuggle a `//` or `\\` past a naive prefix test.
 *
 * Callers hand this value over in different states of encoding
 * (`url.searchParams.get()` has already decoded once; `url.pathname` has not),
 * so BOTH the value as given and its decoded form must pass. The value is
 * returned unchanged: re-encoding is the caller's business, not the guard's.
 */
/** C0 controls, space and DEL, as escapes so the source stays plain text. */
const UNSAFE_NEXT = /[\u0000-\u0020\u007f]/;

/** Same-origin shape: one leading slash, and no backslash anywhere. */
function violatesPathShape(candidate: string): boolean {
  return (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\")
  );
}

export function getSafeNextPath(
  next: string | null | undefined,
): string | null {
  if (!next) return null;

  // Control characters and whitespace are judged on the RAW value only: they
  // are dangerous because of what a browser does with the bytes in the header
  // (strip a leading tab, break on CR/LF), and `%20` is none of those things.
  // Rejecting the decoded form here would throw away legitimate paths whose
  // segments contain an escaped space.
  if (UNSAFE_NEXT.test(next)) return null;

  if (violatesPathShape(next)) return null;

  // The SHAPE, though, must hold after decoding too — `/%5Cevil.test/steal`
  // is a backslash wearing a percent escape. A malformed escape is not a path
  // we are willing to guess at.
  let decoded: string;
  try {
    decoded = decodeURIComponent(next);
  } catch {
    return null;
  }

  if (violatesPathShape(decoded)) return null;

  return next;
}
