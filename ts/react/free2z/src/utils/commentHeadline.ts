/**
 * Comment headlines are optional now, and historically the UIs wrote
 * sentinels instead of leaving the field empty: the new Svelte UI sent "N/A"
 * on every comment and reply, the classic reply flow sent "re". This UI
 * renders `comment.headline` as the MUI CardHeader title, so those sentinels
 * showed up verbatim as the card's title.
 *
 * Backend migration comments.0006 blanked the stored sentinels, but the filter
 * stays: a cached page, a rolled-back deploy, or an old client can still hand
 * us one, and the cost of keeping it is nothing.
 */
const PLACEHOLDER_HEADLINES = new Set(["n/a", "re"])

/**
 * The headline to display, or undefined when there is nothing worth showing.
 *
 * Returning undefined (not "") matters: MUI's CardHeader renders an empty
 * title element for "" and no title element at all for undefined.
 */
export function displayHeadline(headline?: string | null): string | undefined {
    const trimmed = (headline || "").trim()
    if (!trimmed) return undefined
    if (PLACEHOLDER_HEADLINES.has(trimmed.toLowerCase())) return undefined
    return trimmed
}
