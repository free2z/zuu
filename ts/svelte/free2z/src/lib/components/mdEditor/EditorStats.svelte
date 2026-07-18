<script lang="ts">
  import { AlignLeft, Clock } from "@lucide/svelte";
  import { t } from "$lib/i18n";
  import type { EditorMode } from "./types";
  import { countWords, estimateReadTime } from "./utils";

  interface Props {
    content: string;
    mode: EditorMode;
  }

  let { content, mode }: Props = $props();

  let wordCount = $derived(countWords(content));
  let readTime = $derived(estimateReadTime(content));
</script>

{#if content && mode !== "write"}
  <div
    class="pointer-events-none fixed right-6 bottom-6 z-40 hidden items-center gap-1.5 rounded-full border border-border/60 bg-background/90 px-4 py-2 text-xs font-medium text-(--f2z-text-secondary) shadow-sm backdrop-blur-md md:flex"
  >
    <span class="flex items-center gap-1.5">
      <AlignLeft class="h-3.5 w-3.5 text-(--f2z-accent-primary)" />
      {wordCount}
      {t("editor.words", "words")}
    </span>
    <span class="text-(--f2z-text-secondary)/40" aria-hidden="true">·</span>
    <span class="flex items-center gap-1.5">
      <Clock class="h-3.5 w-3.5 text-(--f2z-accent-primary)" />
      {readTime}
      {t("editor.minRead", "min read")}
    </span>
  </div>
{/if}
