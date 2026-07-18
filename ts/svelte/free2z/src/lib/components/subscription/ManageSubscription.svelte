<script lang="ts">
  import { onMount } from "svelte";
  import { BadgeCheck, BellOff } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button";
  import {
    createTuzisSubscribeDestroy,
    tuzisSubscribeRetrieve,
  } from "$lib/api/tuzis/tuzis";
  import type { CreatorDetail } from "$lib/api/f2z.schemas";

  type SubscriptionDetails = {
    max_price: string;
  };

  export let creator: CreatorDetail;
  export let onClose: () => void = () => {};

  let renewalCancelled = false;
  let detailsLoading = true;

  const unsubscribeMutation = createTuzisSubscribeDestroy();

  onMount(async () => {
    try {
      const details = (await tuzisSubscribeRetrieve(
        creator.username,
      )) as unknown as SubscriptionDetails;
      renewalCancelled = Number(details.max_price) === 0;
    } catch (error) {
      // Subscription membership still comes from the freshly loaded auth user.
      // A details failure should not hide the manage action.
      console.error("Failed to load subscription details:", error);
    } finally {
      detailsLoading = false;
    }
  });

  async function handleUnsubscribe() {
    try {
      await $unsubscribeMutation.mutateAsync({ username: creator.username });
      renewalCancelled = true;
      toast.info(`Subscription to ${creator.username} will not renew.`);
    } catch (error: any) {
      console.error(error);
      toast.error(
        error?.data?.error || "Failed to cancel subscription renewal.",
      );
    }
  }
</script>

<div class="flex flex-col items-center justify-center gap-6 py-4 text-center">
  <div class="rounded-full bg-primary/10 p-3">
    <BadgeCheck class="size-8 text-primary" />
  </div>

  <div class="space-y-1">
    <h3 class="text-xl font-bold tracking-tight">
      Subscribed to {creator.username}
    </h3>
    {#if renewalCancelled}
      <p
        class="mx-auto max-w-[320px] text-sm leading-relaxed text-muted-foreground"
      >
        Your access remains active for the current period. This subscription
        will not renew.
      </p>
    {:else}
      <p
        class="mx-auto max-w-[320px] text-sm leading-relaxed text-muted-foreground"
      >
        Your subscription is active and renews monthly.
      </p>
    {/if}
  </div>

  <div class="w-full max-w-xs space-y-3">
    {#if renewalCancelled}
      <div
        class="rounded-lg border border-border bg-muted/30 p-3 text-sm font-medium"
      >
        Renewal cancelled
      </div>
    {:else}
      <Button
        variant="destructive"
        class="w-full"
        onclick={handleUnsubscribe}
        disabled={detailsLoading || $unsubscribeMutation.isPending}
      >
        <BellOff class="mr-2 size-4" />
        {$unsubscribeMutation.isPending ? "Cancelling..." : "Cancel renewal"}
      </Button>
      <p class="text-[11px] text-muted-foreground">
        You will keep access through the current subscription period.
      </p>
    {/if}

    <Button variant="outline" class="w-full" onclick={onClose}>Done</Button>
  </div>
</div>
