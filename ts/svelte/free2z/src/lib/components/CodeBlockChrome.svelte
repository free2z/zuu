<script lang="ts" module>
  import { writable } from "svelte/store";

  // Shared, page-global wrap state so every code block's chrome stays in sync
  // when any one of them is toggled — without re-mounting (which jumped scroll).
  export const codeWrapStore = writable(false);
</script>

<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import { onDestroy } from "svelte";
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import TextWrap from "@lucide/svelte/icons/text-wrap";
  import * as Tooltip from "$lib/components/ui/tooltip";

  export let languageLabel: string;
  export let onToggleWrap: () => void = () => {};
  export let onCopyCode: () => Promise<boolean> = async () => false;

  $: isWrapped = $codeWrapStore;

  let copied = false;
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  async function handleCopy() {
    const didCopy = await onCopyCode();
    if (!didCopy) {
      return;
    }

    copied = true;

    if (copyTimer) {
      clearTimeout(copyTimer);
    }

    copyTimer = setTimeout(() => {
      copied = false;
      copyTimer = null;
    }, 1800);
  }

  onDestroy(() => {
    if (copyTimer) {
      clearTimeout(copyTimer);
    }
  });
</script>

<div
  class="pointer-events-none absolute inset-x-3 top-2.5 z-10 flex items-start justify-between gap-2.5"
>
  <div
    class="pointer-events-auto inline-flex max-w-[70%] items-center rounded-md border border-border/40 bg-background/45 px-2 py-0.75 text-[0.62rem] font-medium tracking-[0.08em] text-muted-foreground/85 uppercase backdrop-blur-sm"
  >
    <span class="truncate">{languageLabel}</span>
  </div>

  <div class="pointer-events-auto flex items-center gap-2">
    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger
          type="button"
          aria-label={copied
            ? $t("markdown.codeCopied", "Code copied")
            : $t("markdown.copyCode", "Copy code")}
          onclick={handleCopy}
          class="relative inline-flex size-9 cursor-pointer items-center justify-center rounded-md border border-border/40 bg-background/45 text-muted-foreground backdrop-blur-sm transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-background/70 hover:text-foreground"
        >
          {#if copied}
            <Check class="size-3.25" />
          {:else}
            <Copy class="size-3.25" />
          {/if}
        </Tooltip.Trigger>
        <Tooltip.Content side="top" sideOffset={8}>
          {copied
            ? $t("markdown.copied", "Copied")
            : $t("markdown.copyCode", "Copy code")}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>

    <Tooltip.Provider delayDuration={120}>
      <Tooltip.Root>
        <Tooltip.Trigger
          type="button"
          aria-label={isWrapped
            ? $t("markdown.disableCodeWrapping", "Disable code wrapping")
            : $t("markdown.wrapLongLines", "Wrap long lines")}
          aria-pressed={isWrapped}
          onclick={onToggleWrap}
          class="relative inline-flex size-9 cursor-pointer items-center justify-center rounded-md border border-border/40 bg-background/45 backdrop-blur-sm transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-background/70 hover:text-foreground {isWrapped
            ? 'text-primary'
            : 'text-muted-foreground'}"
        >
          <TextWrap class="size-3.25" />
        </Tooltip.Trigger>
        <Tooltip.Content side="top" sideOffset={8}>
          {isWrapped
            ? $t("markdown.disableWrapping", "Disable wrapping")
            : $t("markdown.wrapLongLines", "Wrap long lines")}
        </Tooltip.Content>
      </Tooltip.Root>
    </Tooltip.Provider>
  </div>
</div>
