<script lang="ts">
  import { tuzisDonateCreate } from '$lib/api/tuzis/tuzis';
  import type { CreatorDetail } from '$lib/api/f2z.schemas';
  import { authStore } from '$lib/stores/auth';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { toast } from 'svelte-sonner';

  export let creator: CreatorDetail;
  export let price: number;
  export let open = false;
  export let onOpenChange: (open: boolean) => void = () => {};
  export let onSuccess: () => void = () => {};

  $: user = $authStore.creator;
  $: balance = user && user.tuzis ? Number(user.tuzis) : 0;
  $: canAfford = balance >= price;

  let loading = false;

  async function handlePayment() {
    const hasActiveSession = await authStore.ensureAuthenticated();
    if (!hasActiveSession) {
      toast.error("Please log in to unlock.");
      return;
    }

    if (!canAfford) {
      toast.error("Insufficient funds. Please buy more 2Z.");
      return;
    }

    loading = true;
    try {
      await tuzisDonateCreate(creator.username, {
        body: JSON.stringify({ amount: price, anon: false })
      });
      toast.success(`Payment successful!`);
      onOpenChange(false);
      authStore.checkAuth();
      onSuccess();
    } catch (e: any) {
      console.error(e);
      toast.error(e?.response?.data?.message || "Payment failed.");
    } finally {
      loading = false;
    }
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Unlock Stream</Dialog.Title>
      <Dialog.Description>
        This is a Pay-Per-View stream. You will be charged per minute while watching.
      </Dialog.Description>
    </Dialog.Header>

    <div class="py-4">
      <p class="text-lg mb-4">
        Price: <span class="font-bold">{price} 2Z / minute</span>
      </p>
      
      {#if user}
        <p class="text-sm text-muted-foreground mb-2">
          Your balance: {balance.toFixed(2)} 2Z
        </p>
        
        {#if !canAfford}
          <div class="bg-destructive/10 text-destructive p-3 rounded-md text-sm">
            You need { (price - balance).toFixed(2) } more 2Z to unlock.
          </div>
        {/if}
      {:else}
        <p class="text-sm text-muted-foreground">
          Please log in to unlock.
        </p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => onOpenChange(false)}>Cancel</Button>
      {#if user}
        {#if canAfford}
          <Button onclick={handlePayment} disabled={loading}>
            {#if loading}
              Processing...
            {:else}
              Start Watching ({price} 2Z)
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
