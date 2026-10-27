<script lang="ts">
  /**
   * A row of tag links.
   *
   * Every tag leads to `/search?tag=<name>`, which filters through the API's
   * long-standing `?tags=` parameter. Tags that lead nowhere are decoration;
   * these are the entry point to the long tail, which is most of the reason to
   * have an open vocabulary at all.
   *
   * The chips are links and nothing else on the row is clickable, so there is
   * exactly one hover cue — the background — and no ring or shadow stacked on
   * top of it.
   */
  import { tagHref } from "$lib/tags.js";
  import { cn } from "$lib/utils.js";

  let {
    tags = [],
    limit,
    class: className = "",
    size = "sm",
  }: {
    tags: readonly string[] | null | undefined;
    /** Cap the row; the remainder is summarised rather than truncated silently. */
    limit?: number;
    class?: string;
    size?: "sm" | "md";
  } = $props();

  const cleaned = $derived(
    (tags ?? []).filter((tag) => typeof tag === "string" && tag.trim()),
  );
  const shown = $derived(limit ? cleaned.slice(0, limit) : cleaned);
  const overflow = $derived(cleaned.length - shown.length);
</script>

{#if shown.length > 0}
  <div class={cn("flex flex-wrap items-center gap-1.5", className)}>
    {#each shown as tag (tag)}
      <a
        href={tagHref(tag)}
        data-testid="tag-chip"
        class={cn(
          "inline-flex max-w-full items-center rounded-full border border-border bg-muted/60 font-medium text-muted-foreground no-underline transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        )}
      >
        <span class="truncate">#{tag}</span>
      </a>
    {/each}
    {#if overflow > 0}
      <span class="text-[11px] text-muted-foreground">+{overflow}</span>
    {/if}
  </div>
{/if}
