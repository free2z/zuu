<script lang="ts">
  import { onMount } from "svelte";
  import { BadgeCheck, BellOff, RefreshCw } from "@lucide/svelte";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import { Button } from "$lib/components/ui/button";
  import {
    createTuzisSubscribeDestroy,
    tuzisSubscribeRetrieve,
  } from "$lib/api/tuzis/tuzis";
  import type { CreatorDetail, SimpleCreator } from "$lib/api/f2z.schemas";
  import { isApiTimeoutError } from "$lib/api/request-timeout.js";
  import { tStore as t } from "$lib/i18n";

  type SubscriptionDetails = {
    max_price: string;
  };

  export let creator: CreatorDetail | SimpleCreator;
  export let onClose: () => void = () => {};

  /**
   * What we know about renewal. `unknown` is a real state, not a
   * default: when the details GET fails we do NOT know whether this
   * subscription renews, and the dialog used to assert "active and renews
   * monthly" — and offer Cancel — for one that may already be cancelled.
   */
  let renewal: "loading" | "renews" | "cancelled" | "free" | "unknown" =
    "loading";

  let paymentError: { message: string; generation: number } | null = null;
  let outcomeGeneration: number | null = null;
  $: if (
    outcomeGeneration !== null &&
    outcomeGeneration !== $toastPresentation.generation
  ) {
    paymentError = null;
    renewal = "unknown";
    outcomeGeneration = null;
  }
  const unsubscribeMutation = createTuzisSubscribeDestroy();

  async function loadDetails() {
    const operationNotice = captureAccountToast();
    outcomeGeneration = $toastPresentation.generation;
    renewal = "loading";
    try {
      const details = (await tuzisSubscribeRetrieve(
        creator.username,
      )) as unknown as SubscriptionDetails;
      if (!operationNotice.isCurrent()) return;
      // A free follow (price 0, ) records no renewal ceiling: it was
      // never cancelled, it simply lasts its 30 days.
      renewal =
        Number(details.max_price) !== 0
          ? "renews"
          : Number(creator.member_price) === 0 && creator.member_price != null
            ? "free"
            : "cancelled";
    } catch (error) {
      if (!operationNotice.isCurrent()) return;
      // Membership itself comes from the freshly loaded auth user, so the
      // dialog still opens — it just says it cannot tell, and offers a retry.
      console.error("Failed to load subscription details:", error);
      renewal = "unknown";
    }
  }

  onMount(loadDetails);

  async function handleUnsubscribe() {
    paymentError = null;
    const operationNotice = captureAccountToast({
      onError: (message) => {
        paymentError = {
          message: String(message),
          generation: $toastPresentation.generation,
        };
      },
    });
    outcomeGeneration = $toastPresentation.generation;
    try {
      await $unsubscribeMutation.mutateAsync({ username: creator.username });
      if (!operationNotice.isCurrent()) return;
      renewal = "cancelled";
      operationNotice.info(
        $t(
          "subscription.willNotRenew",
          "Subscription to {username} will not renew.",
          {
            username: creator.username,
          },
        ),
      );
    } catch (error: any) {
      console.error(error);
      // The server's reason when it gave one, a timeout's own
      // sentence, else our copy.
      operationNotice.error(
        error?.serverMessage ||
          (isApiTimeoutError(error) ? error.message : "") ||
          $t(
            "subscription.cancelFailed",
            "Failed to cancel subscription renewal.",
          ),
      );
    }
  }
</script>

<div class="flex flex-col items-center justify-center gap-6 py-4 text-center">
  {#if paymentError}
    <p
      role="alert"
      data-testid="payment-outcome-error"
      class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
    >
      {paymentError.message}
    </p>
  {/if}
  <div class="rounded-full bg-primary/10 p-3">
    <BadgeCheck class="size-8 text-primary" />
  </div>

  <div class="space-y-1">
    <h3 class="text-xl font-bold tracking-tight">
      {$t("subscription.subscribedTo", "Subscribed to {username}", {
        username: creator.username,
      })}
    </h3>
    {#if renewal === "cancelled"}
      <p
        class="mx-auto max-w-[320px] text-sm leading-relaxed text-muted-foreground"
      >
        {$t(
          "subscription.accessUntilPeriodEnd",
          "Your access remains active for the current period. This subscription will not renew.",
        )}
      </p>
    {:else if renewal === "free"}
      <p
        class="mx-auto max-w-[320px] text-sm leading-relaxed text-muted-foreground"
        data-testid="subscription-free"
      >
        {$t(
          "subscription.freeMembership",
          "Free membership: your member access lasts 30 days. Follow again when it ends to keep it.",
        )}
      </p>
    {:else if renewal === "renews"}
      <p
        class="mx-auto max-w-[320px] text-sm leading-relaxed text-muted-foreground"
      >
        {$t(
          "subscription.renewsMonthly",
          "Your subscription is active and renews monthly.",
        )}
      </p>
    {:else if renewal === "unknown"}
      <p
        class="mx-auto max-w-[320px] text-sm leading-relaxed text-destructive"
        role="alert"
        data-testid="subscription-renewal-unknown"
      >
        {$t(
          "subscription.renewalUnknown",
          "We couldn't load whether this subscription renews. Try again in a moment.",
        )}
      </p>
    {/if}
  </div>

  <div class="w-full max-w-xs space-y-3">
    {#if renewal === "free"}
      <!-- Nothing renews and nothing is charged: no cancel to offer. -->
    {:else if renewal === "cancelled"}
      <div
        class="rounded-lg border border-border bg-muted/30 p-3 text-sm font-medium"
      >
        {$t("subscription.renewalCancelled", "Renewal cancelled")}
      </div>
    {:else if renewal === "unknown"}
      <Button variant="outline" class="w-full" onclick={loadDetails}>
        <RefreshCw class="mr-2 size-4" />
        {$t("subscription.retryDetails", "Try again")}
      </Button>
    {:else}
      <Button
        variant="destructive"
        class="w-full"
        onclick={handleUnsubscribe}
        disabled={renewal === "loading" || $unsubscribeMutation.isPending}
      >
        <BellOff class="mr-2 size-4" />
        {$unsubscribeMutation.isPending
          ? $t("subscription.cancelling", "Cancelling...")
          : $t("subscription.cancelRenewal", "Cancel renewal")}
      </Button>
      <p class="text-[11px] text-muted-foreground">
        {$t(
          "subscription.keepAccess",
          "You will keep access through the current subscription period.",
        )}
      </p>
    {/if}

    <Button variant="outline" class="w-full" onclick={onClose}
      >{$t("common.done", "Done")}</Button
    >
  </div>
</div>
