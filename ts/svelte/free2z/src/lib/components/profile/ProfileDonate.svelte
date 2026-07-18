<script lang="ts">
  import { MediaQuery } from "svelte/reactivity";
  import { toast } from 'svelte-sonner';
  import QRCode from 'qrcode';
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Drawer from "$lib/components/ui/drawer";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Button, buttonVariants } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Switch } from '$lib/components/ui/switch';
  import { Label } from '$lib/components/ui/label';
  import { Separator } from "$lib/components/ui/separator";
  import { Wallet, Copy, Check, Coins, Zap, VenetianMask } from '@lucide/svelte';
  import { tStore as t } from '$lib/i18n';
  import { authStore } from '$lib/stores/auth';
  import type { CreatorDetail } from '$lib/api/f2z.schemas';

  let { creator }: { creator: CreatorDetail } = $props();

  const DEFAULT_DONATION_AMOUNT = 2;

  let open = $state(false);
  let isDesktop = new MediaQuery("(min-width: 768px)");
  let copied = $state(false);
  let donationAmount = $state(DEFAULT_DONATION_AMOUNT);
  let anonymous = $state(false);
  let loading = $state(false);
  let copiedResetTimeout: ReturnType<typeof setTimeout> | undefined;

  // Zcash QR Logic
  let qrDataUrl = $state<string | null>(null);
  let qrError = $state(false);

  $effect(() => {
    if (!open) {
      donationAmount = DEFAULT_DONATION_AMOUNT;
      copied = false;
      clearTimeout(copiedResetTimeout);
    }
  });

  $effect(() => {
    if (creator?.p2paddr && open) {
      qrError = false;
      QRCode.toDataURL(creator.p2paddr, { margin: 1, width: 240, color: { dark: '#000000', light: '#ffffff' } })
        .then((url: string) => {
          qrDataUrl = url;
          qrError = false;
        })
        .catch(() => {
          qrDataUrl = null;
          qrError = true;
        });
    }
  });

  function copyAddressFallback(address: string) {
    const textarea = document.createElement('textarea');
    const previouslyFocused = document.activeElement as HTMLElement | null;

    textarea.value = address;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, address.length);

    try {
      return document.execCommand('copy');
    } finally {
      textarea.remove();
      previouslyFocused?.focus();
    }
  }

  async function copyAddress() {
    if (!creator?.p2paddr) return;

    let clipboardError: unknown;

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(creator.p2paddr);
    } catch (error) {
      clipboardError = error;
      try {
        if (!copyAddressFallback(creator.p2paddr)) {
          throw clipboardError;
        }
      } catch {
        toast.error($t('pageActions.donate.copyFailed', 'Copy failed'));
        return;
      }
    }

    copied = true;
    toast.success($t('pageActions.donate.copied', 'Address copied to clipboard'));
    clearTimeout(copiedResetTimeout);
    copiedResetTimeout = setTimeout(() => copied = false, 3000);
  }

  // Tuzi Donation Logic
  
  let user = $derived($authStore.creator);
  let balance = $derived(user && user.tuzis ? Number(user.tuzis) : 0);
  
  const QUICK_AMOUNTS = [2, 5, 10, 20];

  async function handleDonateTuzis() {
    const hasActiveSession = await authStore.ensureAuthenticated();
    if (!hasActiveSession) {
      toast.error("Please log in to donate.");
      return;
    }

    if (balance < donationAmount) {
      toast.error("Insufficient funds. Please buy more 2Z.");
      return;
    }
    if (!donationAmount || donationAmount < 1) {
        toast.error("Minimum donation is 1 2Z.");
        return;
    }

    loading = true;
    try {
      const csrf = await authStore.ensureCSRFToken();
      const res = await fetch(`/api/tuzis/donate/${creator.username}`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(csrf ? { 'X-CSRFToken': csrf } : {})
          },
          body: JSON.stringify({ amount: donationAmount, anon: anonymous })
      });

      if (!res.ok) {
          if (authStore.handleAuthFailure(res.status)) {
            throw new Error("Please log in to donate.");
          }
          const json = await res.json().catch(() => ({}));
          throw new Error(json.message || "Failed to donate.");
      }

      toast.success(`Donated ${donationAmount}Z to ${creator.username}${anonymous ? ' anonymously' : ''}!`);
      authStore.checkAuth(); // Refresh balance
      open = false;
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || "Failed to donate.");
    } finally {
        loading = false;
    }
  }
</script>

{#snippet content()}
  <Tabs.Root value="tuzis" class="w-full md:min-h-[506px]">
    <Tabs.List class="grid w-full grid-cols-2 mb-4">
      <Tabs.Trigger value="tuzis" class="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">Tuzis (2Z)</Tabs.Trigger>
      <Tabs.Trigger value="zcash">Zcash (ZEC)</Tabs.Trigger>
    </Tabs.List>
    
    <Tabs.Content value="tuzis" class="py-2 md:h-[446px]">
      <div class="flex flex-col items-center justify-center gap-4 text-center md:h-full md:justify-between">
        <div class="flex flex-col items-center gap-4">
          <div class="bg-primary/10 rounded-full p-3">
            <Coins class="size-8 text-primary" />
          </div>

          <div class="space-y-1">
            <h3 class="font-bold text-xl tracking-tight">Donate 2Z</h3>
            <p class="text-sm text-muted-foreground max-w-[260px] mx-auto leading-relaxed">
              Support <span class="font-semibold text-foreground">{creator.username}</span> directly.
            </p>
          </div>
        </div>

        <div class="w-full max-w-sm space-y-6">
            <div class="space-y-4">
                 <div>
                    <div class="bg-background border border-border rounded-xl p-1 flex items-center">
                        <button
                            type="button"
                            aria-label="Decrease donation amount"
                            class="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted-foreground shadow-none transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
                            onclick={() => donationAmount = Math.max(1, donationAmount - 1)}
                        >
                            <span class="text-xl font-bold" aria-hidden="true">−</span>
                        </button>
                        <div class="flex-1 text-center">
                             <Input 
                                type="number" 
                                bind:value={donationAmount} 
                                min="1" 
                                step="1" 
                                class="border-none shadow-none text-center text-2xl font-bold h-12 !bg-transparent focus-visible:ring-0 p-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" 
                            />
                            <div class="text-[10px] uppercase tracking-wider font-medium text-muted-foreground mt-[-4px]">Tuzis</div>
                        </div>
                        <button
                            type="button"
                            aria-label="Increase donation amount"
                            class="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-muted-foreground shadow-none transition-colors hover:text-primary focus-visible:text-primary focus-visible:outline-none"
                            onclick={() => donationAmount = donationAmount + 1}
                        >
                            <span class="text-xl font-bold" aria-hidden="true">+</span>
                        </button>
                    </div>
                 </div>

                 <!-- Quick Amounts -->
                 <div class="grid grid-cols-4 gap-2">
                     {#each QUICK_AMOUNTS as amount}
                        <Button 
                            variant={donationAmount === amount ? "default" : "outline"}
                            size="sm"
                            class="text-xs font-semibold w-full h-8"
                            onclick={() => donationAmount = amount}
                        >
                            {amount}Z
                        </Button>
                     {/each}
                 </div>
             </div>

            <Separator class="bg-border/50" />

            {#if user}
                <div class="flex items-center justify-between px-2">
                     <span class="text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70">Your Balance</span>
                     <span class="font-mono text-xs font-medium {balance < donationAmount ? 'text-destructive' : 'text-muted-foreground'}">{balance.toFixed(2)} 2Z</span>
                </div>

                {#if balance < donationAmount}
                     <div class="space-y-3 pt-2">
                         <p class="text-xs text-destructive font-medium text-center bg-destructive/5 py-2 rounded-lg">Insufficient balance for this donation</p>
                         <Button href="/buy-2z" variant="default" class="w-full font-semibold h-11">
                            Buy 2Z
                         </Button>
                     </div>
                {:else}
                    <div class="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5">
                        <div class="flex items-center gap-2.5 min-w-0">
                            <VenetianMask class="size-4 shrink-0 text-muted-foreground" />
                            <div class="min-w-0">
                                <Label for="donate-anon" class="font-medium cursor-pointer">Donate anonymously</Label>
                                <p class="text-[11px] text-muted-foreground leading-tight">Hide your name from {creator.username}</p>
                            </div>
                        </div>
                        <Switch id="donate-anon" bind:checked={anonymous} />
                    </div>
                    <Button onclick={handleDonateTuzis} disabled={loading} class="w-full font-semibold h-11" size="lg">
                        {#if loading}
                            Sending...
                        {:else}
                            <div class="flex items-center gap-2">
                                <Zap class="size-4 fill-current" />
                                Send Donation
                            </div>
                        {/if}
                    </Button>
                {/if}
            {:else}
                <Button href="/login" variant="default" class="w-full h-11 font-semibold">
                    Log in to Donate
                </Button>
            {/if}
        </div>
      </div>
    </Tabs.Content>

    <Tabs.Content value="zcash" class="space-y-6 py-4">
      <div class="flex flex-col items-center gap-6">
        {#if creator?.p2paddr}
            <div>
                <div class="bg-white p-3 rounded-xl border">
                    {#if qrDataUrl}
                        <img src={qrDataUrl} alt="Zcash QR code" width="200" height="200" class="size-[200px] rounded-xl mix-blend-multiply md:size-[180px]" />
                    {:else if qrError}
                        <div class="flex size-[200px] items-center justify-center rounded-xl bg-destructive/5 p-4 text-center text-sm font-medium text-destructive md:size-[180px]">
                            Failed to generate QR code
                        </div>
                    {:else}
                        <div class="flex size-[200px] animate-pulse items-center justify-center rounded-xl bg-muted/20 text-sm text-muted-foreground md:size-[180px]">
                            Generating...
                        </div>
                    {/if}
                </div>
            </div>

            <div class="w-full space-y-4 max-w-sm">
                <div class="space-y-1.5 text-center">
                    <h4 class="font-bold text-foreground">Scan to Donate</h4>
                    <p class="text-xs text-muted-foreground">Scan this QR code with your Zcash wallet app</p>
                </div>

                <div>
                    <div class="flex h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm items-center gap-2">
                         <div class="font-mono text-[10px] md:text-xs truncate flex-1 text-muted-foreground select-all">
                             {creator.p2paddr}
                         </div>
                         <div class="h-6 w-[1px] bg-border"></div>
                         <Button
                            variant="ghost"
                            size="icon"
                            onclick={copyAddress}
                            aria-label={copied ? 'Zcash address copied' : 'Copy Zcash address'}
                            class="shrink-0 h-8 w-8 -mr-1"
                         >
                            {#if copied}
                                <Check class="size-4" />
                            {:else}
                                <Copy class="size-4" />
                            {/if}
                        </Button>
                    </div>
                </div>
                
                <div class="bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 p-3 rounded-lg text-[11px] text-center border border-yellow-500/20 font-medium leading-relaxed">
                    funds go directly to the creator's wallet. Free2Z does not take a cut.
                </div>
            </div>
        {:else}
            <div class="flex flex-col items-center justify-center py-12 text-center space-y-4">
                <div class="bg-muted p-6 rounded-full opacity-50">
                    <Wallet class="size-10 text-muted-foreground" />
                </div>
                <div class="space-y-1">
                    <h3 class="font-semibold">No Zcash Address</h3>
                    <p class="text-sm text-muted-foreground">This creator hasn't configured a Zcash address yet.</p>
                </div>
            </div>
        {/if}
      </div>
    </Tabs.Content>
  </Tabs.Root>
{/snippet}

{#if isDesktop.current}
  <Dialog.Root bind:open>
    <Dialog.Trigger class={`${buttonVariants({ variant: "outline", size: "sm" })} w-full sm:w-auto`}>
        <Wallet class="size-4" /> Donate
    </Dialog.Trigger>
    <Dialog.Content class="sm:max-w-[425px]">
      <Dialog.Header>
        <Dialog.Title>Support {creator.username}</Dialog.Title>
        <Dialog.Description>
          Choose a donation method to support this creator.
        </Dialog.Description>
      </Dialog.Header>
      {@render content()}
    </Dialog.Content>
  </Dialog.Root>
{:else}
  <Drawer.Root bind:open>
    <Drawer.Trigger class={`${buttonVariants({ variant: "outline", size: "sm" })} w-full`}>
        <Wallet class="size-4" /> Donate
    </Drawer.Trigger>
    <Drawer.Content>
      <Drawer.Header class="text-left">
        <Drawer.Title>Support {creator.username}</Drawer.Title>
        <Drawer.Description>
          Choose a donation method to support this creator.
        </Drawer.Description>
      </Drawer.Header>
      <div class="px-4 pb-8">
        {@render content()}
      </div>
      <Drawer.Footer class="pt-2">
        <Drawer.Close>
             <Button variant="outline">Cancel</Button>
        </Drawer.Close>
      </Drawer.Footer>
    </Drawer.Content>
  </Drawer.Root>
{/if}
