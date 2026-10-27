<script lang="ts">
  // The moment a creator who cannot cover a post opens a composer.
  //
  // Posting costs 1 2Z — $0.01, `USD_PER_TUZI` — on purpose: it is the
  // anti-spam mechanism. A new account starts with a small welcome grant
  // (`WELCOME_GRANT_2Z`), so this shows once that is spent. Said up
  // front, that is the reason the place has no spam; said only as a failed
  // post, it reads as a broken site or a paywall. So this says the price,
  // the balance, and BOTH ways in — be gifted 2Z by members who want to read
  // more of you (introduce yourself with a zPage), or buy them — before
  // anyone writes a word.
  //
  // It never disables or hides the composer: the balance it reads can be
  // stale (a gift may have just landed), the server is the authority, and
  // the 402 path still explains a refused post without losing the draft.
  // The links open a new tab for the same reason: following one must not
  // throw away what is already in the box.
  import { Coins } from "@lucide/svelte";
  import { locale, tStore as t } from "$lib/i18n";
  import { formatDecimalText, type IntroPath } from "$lib/insufficient-funds";

  interface Props {
    balance: string;
    intro: IntroPath;
  }

  let { balance, intro }: Props = $props();

  let formattedBalance = $derived(formatDecimalText(balance, $locale));
</script>

<div
  class="space-y-2 rounded-lg border border-border/70 bg-muted/40 p-3 text-sm"
  role="note"
  data-testid="posting-cost-notice"
>
  <div class="flex gap-2">
    <Coins class="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
    <div class="space-y-1">
      <p class="text-foreground">
        {$t(
          "insufficientFunds.postCost",
          "A post costs 1 2Z, about a penny. That is why there is no spam here. You have {balance} 2Z.",
          { balance: formattedBalance },
        )}
      </p>
      <p class="text-muted-foreground">
        {#if intro.written}
          {$t(
            "insufficientFunds.giftWaiting",
            "Your zPage is your introduction. Members can gift 2Z to writers they want to read more from.",
          )}
        {:else}
          {$t(
            "insufficientFunds.giftIntro",
            "Write a zPage introducing yourself: members can gift 2Z to writers they want to read more from.",
          )}
        {/if}
      </p>
    </div>
  </div>
  <div class="flex flex-wrap gap-2 pl-6">
    <a
      href={intro.href}
      target="_blank"
      rel="noopener"
      class="font-medium text-primary underline-offset-2 hover:underline"
      data-testid="posting-cost-intro"
    >
      {intro.written
        ? $t("insufficientFunds.yourPages", "Your zPages")
        : $t("insufficientFunds.writeIntro", "Write your intro zPage")}
    </a>
    <a
      href="/buy-2z"
      target="_blank"
      rel="noopener"
      class="font-medium text-primary underline-offset-2 hover:underline"
      data-testid="posting-cost-buy"
    >
      {$t("insufficientFunds.buy", "Buy 2Z")}
    </a>
  </div>
</div>
