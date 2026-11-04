<script lang="ts">
  /**
   * The 2Z currency mark.
   *
   * Free2Z values are denominated in 2Z (Tuzis), never dollars, so money UI
   * must not borrow lucide's `DollarSign`. The app already writes the currency
   * as the literal text "2Z" everywhere it appears (Footer wordmark badge,
   * CommentVote, ConverseComposer, ProfileDonate), so this component reuses
   * that glyph rather than inventing a new symbol — it just boxes it into a
   * square that drops in wherever a lucide icon used to sit.
   *
   * Decorative by default (`aria-hidden`): every current usage sits next to a
   * visible text label that already names the currency, and an announced "2Z"
   * would only duplicate it. Pass `label` when the mark is the only thing
   * carrying the meaning.
   */
  interface Props {
    /** Square edge length in px — mirrors the lucide `size` prop. */
    size?: number;
    /** Extra classes (color, spacing) applied to the mark. */
    class?: string;
    /** Accessible name. Omit to keep the mark decorative. */
    label?: string;
  }

  let { size = 16, class: className = "", label }: Props = $props();

  // 0.62 keeps "2Z" inside the box at every size we use (16/20/24px) without
  // the glyph looking shrunken next to same-size lucide strokes.
  const fontSize = $derived(Math.max(9, Math.round(size * 0.62)));
</script>

<span
  class="inline-flex shrink-0 items-center justify-center leading-none font-bold tracking-tight select-none {className}"
  style="width:{size}px;height:{size}px;font-size:{fontSize}px"
  role={label ? "img" : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}>2Z</span
>
