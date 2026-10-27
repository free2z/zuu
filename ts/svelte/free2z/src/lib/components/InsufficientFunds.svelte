<script lang="ts">
  import { currentUser, authStore } from "$lib/stores/auth";
  import { createInsufficientFundsBalanceDisplay } from "$lib/account-balance";
  import { Coins } from "@lucide/svelte";
  import { locale, tStore as t } from "$lib/i18n";
  import {
    formatDecimalText,
    compareDecimalText,
    makeInsufficientFunds,
    isServerFundsSnapshot,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";

  export let funds: InsufficientFundsDetails;
  export let owner: { username: string; id?: number } | undefined = undefined;
  const balanceDisplay = createInsufficientFundsBalanceDisplay(
    (owner, order) => {
      if (
        typeof window !== "undefined" &&
        owner &&
        isServerFundsSnapshot(funds)
      ) {
        if (order !== undefined)
          authStore.fenceAccountSnapshot(owner.username, order);
        // Dispatch order protects the immediate display, but cannot establish
        // when the server read its balance. Validate again after every refusal.
        authStore.observeAccountBalanceSnapshot({
          ...owner,
          tuzis: funds.balance,
        });
      }
    },
  );
  $: displayFunds = makeInsufficientFunds(
    funds.cost,
    balanceDisplay(funds, $currentUser, owner),
    funds.action,
  );
  $: covered = compareDecimalText(displayFunds.balance, displayFunds.cost) >= 0;
  export let introHref: string | null = null;
  export let introLabel: string | null = null;
  /** The creator already has a zPage: the door is to it, not a new one. */
  export let introWritten = false;
  /** Open the links in a new tab, so a composer without draft storage
   *  does not lose what is in the box. */
  export let newTab = false;

  $: linkTarget = newTab ? "_blank" : undefined;
  $: linkRel = newTab ? "noopener" : undefined;

  let values: {
    cost: string;
    balance: string;
    shortfall: string;
  };
  $: values = {
    cost: formatDecimalText(displayFunds.cost, $locale),
    balance: formatDecimalText(displayFunds.balance, $locale),
    shortfall: formatDecimalText(displayFunds.shortfall, $locale),
  };
</script>

<div
  class="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
  role={covered ? "status" : "alert"}
  data-testid="insufficient-funds"
>
  <div class="flex gap-2">
    <Coins class="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
    <div class="space-y-1">
      <p class="font-medium text-foreground">
        {#if covered}
          {$t(
            "insufficientFunds.covered",
            "This costs {cost} 2Z. You have {balance} 2Z. You can try again.",
            values,
          )}
        {:else}
          {$t(
            "insufficientFunds.message",
            "This costs {cost} 2Z. You have {balance} 2Z, so you need {shortfall} more.",
            values,
          )}
        {/if}
      </p>
      {#if !covered}
        <p class="text-muted-foreground">
          {$t("insufficientFunds.why", "That is why there is no spam here.")}
        </p>
      {/if}
      <p class="text-muted-foreground">
        {$t("insufficientFunds.notCharged", "You have not been charged.")}
      </p>
      {#if introHref}
        <!-- The intro link is a door only if someone says what is behind it:
             introduce yourself, and members can gift you 2Z. A new
             account starts with the welcome 2Z, so this is not the
             way in; it is the way back once those are spent. -->
        <p class="text-muted-foreground" data-testid="insufficient-funds-gift">
          {#if introWritten}
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
      {/if}
    </div>
  </div>
  <div class="flex flex-wrap gap-2 pl-6">
    {#if introHref}
      <a
        href={introHref}
        target={linkTarget}
        rel={linkRel}
        class="font-medium text-primary underline-offset-2 hover:underline"
        data-testid="insufficient-funds-intro"
      >
        {introLabel ??
          (introWritten
            ? $t("insufficientFunds.yourPages", "Your zPages")
            : $t("insufficientFunds.writeIntro", "Write your intro zPage"))}
      </a>
    {/if}
    <a
      href="/buy-2z"
      target={linkTarget}
      rel={linkRel}
      class="font-medium text-primary underline-offset-2 hover:underline"
      data-testid="insufficient-funds-buy"
    >
      {$t("insufficientFunds.buy", "Buy 2Z")}
    </a>
  </div>
</div>
