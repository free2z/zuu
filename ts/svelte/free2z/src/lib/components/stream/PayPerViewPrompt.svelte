<script lang="ts">
  // Explains how a pay-per-view stream is paid for. It sells NOTHING.
  //
  // This dialog used to transfer the per-minute price to the creator as an
  // "unlock" and then retry the join. But admission is a server-side balance
  // reserve, ceil(price * 30) + 15 2Z, and PPV is billed per minute watched
  // when the viewer leaves -- no entitlement was ever recorded. The dialog was
  // only reachable after a join had been refused for being under that
  // reserve, so the unlock lowered the very balance the gate tests: pay, be
  // refused, pay again, until the account was empty. The server now refuses a
  // new PPV-intent donation, and this dialog joins without paying.
  import { authStore } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    compareDecimalText,
    formatDecimalText,
    makeInsufficientFunds,
  } from "$lib/insufficient-funds";
  import { ppvJoinThreshold } from "$lib/ppv-join-threshold.js";
  import { locale, tStore as t } from "$lib/i18n";

  export let price: number | string | null;
  export let open = false;
  export let onOpenChange: (open: boolean) => void = () => {};
  export let onSuccess: () => void = () => {};

  $: user = $authStore.creator;
  $: balance = user?.tuzis ?? "0";
  $: priceText = price === null ? "" : String(price);
  $: validPrice = price !== null && compareDecimalText(priceText, "0") > 0;
  // The same reserve the server's join gate applies (dyte/views.py).
  $: reserve = validPrice ? ppvJoinThreshold(priceText) : null;
  $: reserveText = reserve === null ? "" : String(reserve);
  $: canJoin =
    reserve !== null && compareDecimalText(balance, reserveText) >= 0;

  function formatAmount(value: string | number | null) {
    return formatDecimalText(value ?? "0", $locale, 3);
  }

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }

  function startWatching() {
    // No payment: the join itself is the purchase, priced per minute by the
    // server. A refusal there is shown by the stream viewer, not here.
    handleOpenChange(false);
    open = false;
    onSuccess();
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title
        >{$t("stream.types.payPerView", "Pay per view")}</Dialog.Title
      >
      <Dialog.Description>
        {$t(
          "stream.ppv.description",
          "This is a Pay-Per-View stream. You will be charged per minute while watching.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <div class="py-4">
      <p class="mb-4 text-lg">
        {$t("stream.ppv.pricePerMinute", "Price: {amount} 2Z per minute", {
          amount: validPrice
            ? formatAmount(priceText)
            : $t("stream.ppv.priceUnavailable", "unavailable"),
        })}
      </p>

      {#if reserve !== null}
        <p class="mb-2 text-sm text-muted-foreground" data-testid="ppv-reserve">
          {$t(
            "stream.ppv.entryReserve",
            "To join, keep at least {amount} 2Z in your balance. Nothing is charged up front: you pay for the minutes you watch.",
            { amount: formatAmount(reserveText) },
          )}
        </p>
      {/if}

      {#if user && reserve !== null}
        <p class="mb-2 text-sm text-muted-foreground">
          {$t("pageActions.donate.balance", "Your balance")}: {formatAmount(
            balance,
          )} 2Z
        </p>

        {#if !canJoin}
          <InsufficientFunds
            funds={makeInsufficientFunds(reserveText, balance, "stream_join")}
          />
        {/if}
      {:else if !user}
        <p class="text-sm text-muted-foreground">
          {$t("stream.ppv.loginRequired", "Please log in to unlock.")}
        </p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => handleOpenChange(false)}
        >{$t("common.cancel", "Cancel")}</Button
      >
      {#if user && reserve !== null}
        <!-- Reachable whatever the balance, and never a payment: the server's
             join gate is the authority, and the reserve here is computed from
             a cached quote. A creator who restarts at a lower price lowers
             the reserve, and only a join can find that out -- hiding the
             button below a STALE reserve would strand the viewer until a
             reload. But only with a rate on screen: admission starts paid
             per-minute viewing, so it is never offered beside "Price:
             unavailable". -->
        {#if canJoin}
          <Button onclick={startWatching} data-testid="ppv-start-watching">
            {$t("stream.ppv.startWatching", "Start Watching")}
          </Button>
        {:else}
          <Button
            variant="secondary"
            onclick={startWatching}
            data-testid="ppv-retry-join"
          >
            {$t("creators.retry", "Try again")}
          </Button>
        {/if}
      {:else if !user}
        <Button href="/login">{$t("auth.logIn", "Log in")}</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
