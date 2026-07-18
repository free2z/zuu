<script lang="ts">
  import { tuzisSubscribeCreate } from '$lib/api/tuzis/tuzis';
  import type { CreatorDetail } from '$lib/api/f2z.schemas';
  import { authStore } from '$lib/stores/auth';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { toast } from 'svelte-sonner';
  import ManageSubscription from '$lib/components/subscription/ManageSubscription.svelte';

  export let creator: CreatorDetail;
  export let open = false;
  export let onOpenChange: (open: boolean) => void = () => {};
  let isSubmitting = false;
  let isUnconfirmed = false;

  $: user = $authStore.creator;
  $: isSubscribed = Boolean(user?.stars?.includes(creator.username));
  $: balance = user && user.tuzis ? Number(user.tuzis) : 0;
  $: price = creator.member_price ? Number(creator.member_price) : 0;
  $: canAfford = balance >= price;

  async function handleSubscribe() {
    if (isSubmitting || isUnconfirmed || authStore.isSubscribedTo(creator.username)) {
      return;
    }

    if (!user) {
      toast.error("Please log in to subscribe.");
      return;
    }

    if (!canAfford) {
      toast.error("Insufficient funds. Please buy more 2Z.");
      return;
    }

    isSubmitting = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    try {
      await tuzisSubscribeCreate(creator.username, undefined, controller.signal);
      authStore.setSubscription(creator.username, true);
      toast.success(`Subscribed to ${creator.username}!`);
      onOpenChange(false);
      // Reconcile membership and refresh the balance without the auth cache.
      void authStore.checkAuth({ force: true, silent: true });
    } catch (e: any) {
      console.error(e);
      if (e?.name === 'AbortError') {
        isUnconfirmed = true;
        toast.error(
          "The server did not confirm the subscription. Check your subscriptions before trying again.",
        );
        return;
      }
      toast.error(
        e?.data?.error ||
          e?.data?.message ||
          e?.response?.data?.message ||
          "Failed to subscribe.",
      );
    } finally {
      window.clearTimeout(timeout);
      isSubmitting = false;
    }
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content>
    {#if isSubscribed}
      <Dialog.Header>
        <Dialog.Title class="sr-only">Manage subscription to {creator.username}</Dialog.Title>
        <Dialog.Description class="sr-only">Manage subscription renewal</Dialog.Description>
      </Dialog.Header>
      <ManageSubscription {creator} onClose={() => onOpenChange(false)} />
    {:else}
    <Dialog.Header>
      <Dialog.Title>Subscribe to {creator.full_name || creator.username}</Dialog.Title>
      <Dialog.Description>
        Support {creator.full_name || creator.username} and get access to exclusive content.
      </Dialog.Description>
    </Dialog.Header>

    <div class="py-4">
      <p class="text-lg mb-4">
        Price: <span class="font-bold">{price} 2Z</span> / month
      </p>
      
      {#if user}
        <p class="text-sm text-muted-foreground mb-2">
          Your balance: {balance.toFixed(2)} 2Z
        </p>
        
        {#if !canAfford}
          <div class="bg-destructive/10 text-destructive p-3 rounded-md text-sm">
            You need { (price - balance).toFixed(2) } more 2Z to subscribe.
          </div>
        {/if}
      {:else}
        <p class="text-sm text-muted-foreground">
          Please log in to subscribe.
        </p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
      {#if user}
        {#if canAfford}
          <Button onclick={handleSubscribe} disabled={isSubmitting || isUnconfirmed}>
            {#if isSubmitting}
              Subscribing...
            {:else if isUnconfirmed}
              Status unconfirmed — reload to check
            {:else}
              Subscribe for {price} 2Z
            {/if}
          </Button>
          {#if isUnconfirmed}
            <p class="text-xs text-amber-600 dark:text-amber-400" role="alert">
              Do not retry yet: the server may have completed the charge. Close and reload this page to check your subscription status.
            </p>
          {/if}
        {:else}
          <Button href="/buy-2z" variant="default">Buy 2Z</Button>
        {/if}
      {:else}
        <Button href="/login">Log in</Button>
      {/if}
    </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
