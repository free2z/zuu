/**
 * Where a full address genuinely does not fit, truncate the MIDDLE and always
 * keep the tail — never `slice(0, n) + "..."`.
 *
 * Why the tail is the part that matters: every Zcash address encoding ends in a
 * checksum over everything before it (bech32/bech32m for Sapling, Unified and
 * TEX; base58check for transparent). An attacker who wants an address that
 * *looks* like yours grinds a vanity prefix — that is cheap and it is exactly
 * what a head-only truncation displays. Grinding the trailing characters means
 * finding a different payload whose checksum collides on those characters, so
 * the tail is the part that cannot be cheaply faked. A head-only truncation is
 * therefore forgeable and useless for verification; the tail is the evidence.
 *
 * The tail is weighted at least as long as the head for the same reason, and
 * the full value must always remain reachable (title attribute, copy button,
 * or an untruncated rendering elsewhere) — this is a display affordance, never
 * a substitute for showing the address the user has to verify.
 */
export const ZCASH_ADDRESS_ELLIPSIS = "…";

export function truncateZcashAddress(
  address: string | null | undefined,
  opts: { head?: number; tail?: number } = {},
): string {
  if (!address) return "";
  const requestedHead = Math.max(0, Math.trunc(opts.head ?? 10));
  const requestedTail = Math.max(0, Math.trunc(opts.tail ?? 16));

  // A head-weighted request is SWAPPED, not grown: the smaller budget goes to
  // the head and the larger to the tail. So `{head: 30, tail: 2}` renders 2
  // leading and 30 trailing characters — the caller's total width budget is
  // respected exactly, and the weight lands on the part that cannot be forged.
  // (Clamping only the head, or only raising the tail, would silently return a
  // string wider than the caller sized its container for.)
  const head = Math.min(requestedHead, requestedTail);
  const tail = Math.max(requestedHead, requestedTail);

  // `{head: 0, tail: 0}` would render a bare ellipsis — the address erased
  // rather than shortened. Show the real thing instead.
  if (head + tail === 0) return address;

  // Truncating has to actually save characters, otherwise show the real thing.
  if (address.length <= head + tail + ZCASH_ADDRESS_ELLIPSIS.length) {
    return address;
  }
  return `${address.slice(0, head)}${ZCASH_ADDRESS_ELLIPSIS}${tail === 0 ? "" : address.slice(-tail)}`;
}
