<script lang="ts">
  import { Card, CardContent } from "$lib/components/ui/card";

  /**
   * One dashboard stat: an icon, a number, and a label.
   *
   * This geometry is not decorative — it is the fix from /, and the
   * reason it now lives in one component is that the profile dashboard and the
   * billing page each kept their own copy of it and only one of them was ever
   * fixed.
   *
   * Two rules it encodes, both regression-guarded:
   *
   * 1. The icon sits ABOVE the text below `lg`, not beside it. Beside it, the
   *    icon chip plus its gap eats ~52px of the tile, and what is left cannot
   *    hold "SUBSCRIPTIONS" (106px measured) on one line until the tile itself
   *    is ~160px wide — which, 4-up, means a 1024px viewport. The first cut of
   *    this component switched at `sm`, and a 640px viewport (2-up → 4-up AND
   *    stacked → side-by-side in the same breakpoint) left 56px for that
   *    106px label. Callers pair this with `grid-cols-2 md:grid-cols-4`.
   * 2. The value is `text-xl` below `sm`. At `text-2xl` a realistic balance
   *    ("64,672.23") measures 123px against 112px of content box.
   *
   * The billing copy had neither, and papered over the overflow with
   * `overflow-wrap: anywhere` — which does not truncate the copy, it BREAKS it
   * mid-word: a 320px phone rendered "SUBSCRI/PTIONS", "TRANSA/CTIONS" and a
   * balance split across three lines as "64,6/72.2/3". `anywhere` is therefore
   * absent here on purpose. UI copy wraps at word boundaries or not at all.
   */

  /** Renders the tile as a link. Omit for a non-interactive tile. */
  export let href: string | undefined = undefined;
  export let value: string;
  export let label: string;
  /** Spans both narrow columns. Use in pairs — an odd span leaves a hole. */
  export let wide = false;
  export let testId: string | undefined = undefined;
  /** Test hook on the VALUE element alone, for exact-text assertions. */
  export let valueTestId: string | undefined = undefined;

  const SHELL =
    "block min-w-0 rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

  $: shellClass = [
    href ? `group/stat ${SHELL}` : SHELL,
    wide ? "col-span-2 md:col-span-1" : "",
  ]
    .filter(Boolean)
    .join(" ");
  // Exactly one hover cue on a linked tile — the border. No shadow, no lift
  // and no text-colour shift stacked on top of it.
  $: cardClass = href
    ? "h-full min-w-0 transition-colors group-hover/stat:border-primary/50 group-focus-visible/stat:border-primary/50"
    : "h-full min-w-0";
</script>

<svelte:element
  this={href ? "a" : "div"}
  href={href || undefined}
  class={shellClass}
  data-testid={testId}
>
  <Card class={cardClass}>
    <CardContent
      class="flex flex-col items-start gap-2 p-4 lg:flex-row lg:items-center lg:gap-3"
    >
      <div class="shrink-0 rounded-full bg-primary/10 p-2.5">
        <slot name="icon" />
      </div>
      <div class="min-w-0">
        <p
          class="text-xl font-bold tabular-nums sm:text-2xl"
          data-stat-text="value"
          data-testid={valueTestId}
        >
          {value}
        </p>
        <p
          class="text-xs font-medium tracking-wider text-muted-foreground uppercase"
          data-stat-text="label"
        >
          {label}
        </p>
      </div>
    </CardContent>
  </Card>
</svelte:element>
