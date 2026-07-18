<script lang="ts">
  import { createTuzisSubscribeCreate } from '$lib/api/tuzis/tuzis';
  import type { CreatorDetail } from '$lib/api/f2z.schemas';
  import { authStore } from '$lib/stores/auth';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { toast } from 'svelte-sonner';

  export let creator: CreatorDetail;
  export let open = false;
  export let onOpenChange: (open: boolean) => void = () => {};

  $: user = $authStore.creator;
  $: balance = user && user.tuzis ? Number(user.tuzis) : 0;
  $: price = creator.member_price ? Number(creator.member_price) : 0;
  $: canAfford = balance >= price;

  const subscribeMutation = createTuzisSubscribeCreate();

  async function handleSubscribe() {
    const hasActiveSession = await authStore.ensureAuthenticated();
    if (!hasActiveSession) {
      toast.error("Please log in to subscribe.");
      return;
    }

    if (!canAfford) {
      toast.error("Insufficient funds. Please buy more 2Z.");
      return;
    }

    try {
      await $subscribeMutation.mutateAsync({ username: creator.username });
      toast.success(`Subscribed to ${creator.username}!`);
      onOpenChange(false);
      // Refresh user to update balance
      authStore.checkAuth();
    } catch (e: any) {
      console.error(e);
      toast.error(e?.response?.data?.message || "Failed to subscribe.");
    }
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content>
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
          <Button onclick={handleSubscribe} disabled={$subscribeMutation.isPending}>
            {#if $subscribeMutation.isPending}
              Subscribing...
            {:else}
              Subscribe for {price} 2Z
            {/if}
          </Button>
        {:else}
          <Button href="/buy-2z" variant="default">Buy 2Z</Button>
        {/if}
      {:else}
        <Button href="/login">Log in</Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
