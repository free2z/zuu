<script lang="ts">
  /**
   * A long, unbreakable value (Zcash address, hash, URI) rendered in full —
   * monospace, wrapping — as a single click-to-copy button.
   *
   * This component never truncates, and that is deliberate: it is used where
   * the user is being asked to verify or copy the whole string (QR/donate
   * flows, payout addresses), and a value you can only half read cannot be
   * checked.
   *
   * That is a rule about *this* component, not a blanket ban. Addresses are
   * routinely too long for a chip, a table cell or a phone-width row, and the
   * app's policy for those places is: truncate the MIDDLE, always keep the
   * tail, and keep the full value reachable (title + a copy button). The tail
   * carries the bech32/base58 checksum, so it is the part an attacker cannot
   * cheaply grind — a head-only truncation is forgeable and proves nothing.
   * `truncateZcashAddress` in `$lib/utils/zcashAddress` implements that policy;
   * use it for display chips and use this component wherever the full value
   * must be on screen and selectable.
   */
  import { Check, Copy } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import { copyToClipboard } from "$lib/utils/clipboard";
  import { tStore as t } from "$lib/i18n";
  import { cn } from "$lib/utils";

  interface Props {
    /** The exact string to display and copy. Copied verbatim. */
    value: string;
    /** Accessible description of what is being copied. */
    label?: string;
    /** Optional extra classes on the button. */
    class?: string;
    /** Notified after a copy attempt so a parent can mirror the feedback. */
    oncopied?: (succeeded: boolean) => void;
  }

  let { value, label, class: className, oncopied }: Props = $props();

  type CopyState = "idle" | "copied" | "failed";
  let state = $state<CopyState>("idle");
  let resetTimer: ReturnType<typeof setTimeout> | undefined;

  const describedValue = $derived(
    label || $t("common.copyValue", "Copy value to clipboard"),
  );

  async function handleCopy() {
    clearTimeout(resetTimer);
    const ok = await copyToClipboard(value);
    state = ok ? "copied" : "failed";
    oncopied?.(ok);
    resetTimer = setTimeout(() => (state = "idle"), 2000);
  }

  onDestroy(() => clearTimeout(resetTimer));
</script>

<button
  type="button"
  onclick={handleCopy}
  aria-label={describedValue}
  title={describedValue}
  class={cn(
    "flex w-full cursor-pointer items-start gap-2 rounded-md border border-input bg-muted/30 px-3 py-2 text-left transition-colors",
    "outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
    className,
  )}
>
  <span
    class="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
  >
    {value}
  </span>
  <span class="mt-0.5 shrink-0 text-muted-foreground">
    {#if state === "copied"}
      <Check class="size-4 text-emerald-500" />
    {:else}
      <Copy class="size-4" />
    {/if}
  </span>
</button>

<p class="sr-only" role="status" aria-live="polite">
  {#if state === "copied"}
    {$t("common.copied", "Copied!")}
  {:else if state === "failed"}
    {$t("common.copyFailed", "Copy failed")}
  {/if}
</p>
