/**
 * Display truncation for Zcash addresses and `zcash:` payment URIs.
 *
 * The rule, and the reason this file exists instead of five ad-hoc `slice`
 * calls: when an address does not fit, truncate the MIDDLE and always keep the
 * TAIL. Never `addr.slice(0, 15) + "..."`.
 *
 * Every Zcash address encoding ends in a checksum over everything before it —
 * bech32/bech32m for Sapling, Unified and TEX, base58check for transparent. An
 * attacker producing an address that *looks* like yours grinds a vanity
 * prefix; that is cheap, and a head-only truncation displays exactly the part
 * they ground. Matching the trailing characters instead means finding a
 * different payload whose checksum collides there, which is the part that
 * cannot be cheaply faked. So a head-only truncation is forgeable and proves
 * nothing, while the tail is the evidence a user can actually check.
 *
 * The tail is therefore never rendered shorter than the head, and the full
 * value must stay reachable (copy button, title, or an untruncated rendering)
 * wherever one of these is shown.
 */

export const ZCASH_ADDRESS_ELLIPSIS = "…";

export interface TruncateZcashAddressOptions {
    head?: number;
    tail?: number;
}

export function truncateZcashAddress(
    address: string | null | undefined,
    opts: TruncateZcashAddressOptions = {},
): string {
    if (!address) return "";
    const requestedHead = Math.max(0, Math.trunc(opts.head ?? 10));
    const requestedTail = Math.max(0, Math.trunc(opts.tail ?? 16));

    // A head-weighted request is SWAPPED, not grown: the smaller budget goes to
    // the head and the larger to the tail. So `{head: 30, tail: 2}` renders 2
    // leading and 30 trailing characters — the caller's total width budget is
    // respected exactly, and the weight lands on the part that cannot be
    // forged. (Clamping only the head, or only raising the tail, would silently
    // return a string wider than the caller sized its container for.)
    const head = Math.min(requestedHead, requestedTail);
    const tail = Math.max(requestedHead, requestedTail);

    // `{head: 0, tail: 0}` would render a bare ellipsis — the address erased
    // rather than shortened. Show the real thing instead.
    if (head + tail === 0) return address;

    // Truncating has to actually save characters, otherwise show the real thing.
    if (address.length <= head + tail + ZCASH_ADDRESS_ELLIPSIS.length) {
        return address;
    }
    const end = tail === 0 ? "" : address.slice(-tail);
    return `${address.slice(0, head)}${ZCASH_ADDRESS_ELLIPSIS}${end}`;
}

/**
 * What to render for a value that may be a bare address or a `zcash:` payment
 * URI (`zcash:<addr>?amount=…&memo=…`).
 *
 * For a URI the meaningful part is the address, not the query string — keeping
 * the literal tail of the URI would show `&memo=` and hide the checksum
 * entirely. So the scheme is preserved, the parameters are dropped, and the
 * address inside is middle-truncated by the rule above.
 */
export function formatZcashAddressForDisplay(
    value: string | null | undefined,
    opts: TruncateZcashAddressOptions = {},
): string {
    if (!value) return "";
    if (!value.startsWith("zcash:")) return truncateZcashAddress(value, opts);
    const withoutScheme = value.slice("zcash:".length);
    const address = withoutScheme.split("?")[0];
    return `zcash:${truncateZcashAddress(address, opts)}`;
}
