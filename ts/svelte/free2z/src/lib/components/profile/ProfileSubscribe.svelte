<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { toast } from 'svelte-sonner';
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Drawer from "$lib/components/ui/drawer";
  import { Button, buttonVariants } from '$lib/components/ui/button';
  import { UserPlus, Check, Star } from '@lucide/svelte';
  import { tuzisSubscribeCreate } from '$lib/api/tuzis/tuzis';
  import { authStore } from '$lib/stores/auth';
  import type { CreatorDetail } from '$lib/api/f2z.schemas';
  import ManageSubscription from '$lib/components/subscription/ManageSubscription.svelte';

  let { creator }: { creator: CreatorDetail } = $props();

  let open = $state(false);
  let isSubmitting = $state(false);
  let isUnconfirmed = $state(false);
  let isDesktop = new MediaQuery("(min-width: 768px)");

  let user = $derived($authStore.creator);
  let isSubscribed = $derived(Boolean(user?.stars?.includes(creator.username)));
  let balance = $derived(user && user.tuzis ? Number(user.tuzis) : 0);
  let price = $derived(creator.member_price ? Number(creator.member_price) : 0);
  let canAfford = $derived(balance >= price);

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
      open = false;
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

{#snippet content()}
  {#if isSubscribed}
    <ManageSubscription {creator} onClose={() => open = false} />
  {:else}
    <div class="flex flex-col items-center justify-center gap-6 text-center py-2">
        <div class="bg-primary/10 rounded-full p-3">
          <UserPlus class="size-8 text-primary" />
        </div>
        
        <div class="space-y-1">
            <h3 class="font-bold text-xl tracking-tight">Subscribe to {creator.username}</h3>
            <p class="text-sm text-muted-foreground max-w-[280px] mx-auto leading-relaxed">
                Join the inner circle and unlock exclusive perks.
            </p>
        </div>

        <!-- Benefits List -->
        <div class="bg-muted/30 border border-border rounded-lg p-4 w-full max-w-xs text-left space-y-3">
             <div class="flex items-center gap-3 text-sm">
                 <div class="bg-primary/10 p-1 rounded-full"><Check class="size-3 text-primary" /></div>
                 <span class="text-foreground/80">Support {creator.username} directly</span>
             </div>
             <div class="flex items-center gap-3 text-sm">
                 <div class="bg-primary/10 p-1 rounded-full"><Check class="size-3 text-primary" /></div>
                 <span class="text-foreground/80">Access subscriber-only posts</span>
             </div>
             <div class="flex items-center gap-3 text-sm">
                 <div class="bg-primary/10 p-1 rounded-full"><Check class="size-3 text-primary" /></div>
                 <span class="text-foreground/80">Access to private broadcast streams</span>
             </div>
        </div>

        <div class="w-full max-w-xs space-y-4">
             <!-- Price Card -->
             <div class="border border-border rounded-lg p-4">
                 <div class="flex flex-col items-center">
                     <span class="text-xs uppercase font-medium text-muted-foreground mb-1">Monthly Subscription</span>
                     <div class="flex items-baseline gap-1">
                         <span class="text-2xl font-bold text-foreground">{price}</span>
                         <span class="text-sm font-medium text-muted-foreground">2Z</span>
                     </div>
                 </div>
             </div>

            {#if user}
                <div class="flex items-center justify-between text-xs px-2 text-muted-foreground">
                    <span>Your Balance:</span>
                    <span class="font-mono font-bold {balance < price ? 'text-destructive' : 'text-foreground'}">{balance.toFixed(2)} 2Z</span>
                </div>

                {#if !canAfford}
                    <div class="bg-destructive/5 border border-destructive/20 text-destructive p-3 rounded-lg text-xs font-medium text-center">
                        Insufficient funds. You need { (price - balance).toFixed(2) } more 2Z.
                    </div>
                     <Button href="/buy-2z" variant="default" class="w-full font-semibold h-11">
                        Buy 2Z
                     </Button>
                {:else}
                    <Button onclick={handleSubscribe} disabled={isSubmitting || isUnconfirmed} class="w-full font-semibold h-11" size="lg">
                        {#if isSubmitting}
                            Processing...
                        {:else if isUnconfirmed}
                            Status unconfirmed — reload to check
                        {:else}
                            <div class="flex items-center gap-2">
                                <Star class="size-4 fill-current" />
                                Confirm Subscription
                            </div>
                        {/if}
                    </Button>
                    {#if isUnconfirmed}
                      <p class="text-xs text-amber-600 dark:text-amber-400" role="alert">
                        Do not retry yet: the server may have completed the charge. Close and reload this page to check your subscription status.
                      </p>
                    {/if}
                {/if}
            {:else}
                <Button href="/login" variant="default" class="w-full h-11 font-semibold">
                    Log in to Subscribe
                </Button>
            {/if}
            
            <p class="text-[10px] text-muted-foreground text-center">
                Cancel anytime.
            </p>
        </div>
    </div>
  {/if}
{/snippet}

{#if isDesktop.current}
  <Dialog.Root bind:open>
    <Dialog.Trigger class={`${buttonVariants({ variant: "default", size: "sm" })} w-full sm:w-auto`}>
        {#if isSubscribed}
          <Check class="size-4" /> Subscribed
        {:else}
          <UserPlus class="size-4" /> Subscribe
        {/if}
    </Dialog.Trigger>
    <Dialog.Content class="sm:max-w-[425px]">
      <Dialog.Header>
        <Dialog.Title class="sr-only">{isSubscribed ? 'Manage subscription to' : 'Subscribe to'} {creator.username}</Dialog.Title>
        <Dialog.Description class="sr-only">
          {isSubscribed ? 'Manage subscription' : 'Subscription details'}
        </Dialog.Description>
      </Dialog.Header>
      {@render content()}
    </Dialog.Content>
  </Dialog.Root>
{:else}
  <Drawer.Root bind:open>
    <Drawer.Trigger class={`${buttonVariants({ variant: "default", size: "sm" })} w-full`}>
        {#if isSubscribed}
          <Check class="size-4" /> Subscribed
        {:else}
          <UserPlus class="size-4" /> Subscribe
        {/if}
    </Drawer.Trigger>
    <Drawer.Content>
      <Drawer.Header class="text-left sr-only">
        <Drawer.Title>{isSubscribed ? 'Manage subscription' : 'Subscribe'}</Drawer.Title>
        <Drawer.Description>{isSubscribed ? 'Manage subscription' : 'Subscription details'}</Drawer.Description>
      </Drawer.Header>
      <div class="px-4 pb-8">
        {@render content()}
      </div>
      {#if !isSubscribed}
        <Drawer.Footer class="pt-2">
          <Drawer.Close>
               <Button variant="outline" class="w-full">Cancel</Button>
          </Drawer.Close>
        </Drawer.Footer>
      {/if}
    </Drawer.Content>
  </Drawer.Root>
{/if}
