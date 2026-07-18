<script lang="ts">
  import type { ActionData, PageData } from './$types';
  import { browser } from '$app/environment';
  import { env } from '$env/dynamic/public';
  import { page } from '$app/stores';
  import { cn } from '$lib/utils.js';
  import QRCode from 'qrcode';
  import { enhance } from '$app/forms';
  import { Button, buttonVariants } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '$lib/components/ui/card';
  import { Tabs, TabsContent, TabsList, TabsTrigger } from "$lib/components/ui/tabs";
  import { Popover, PopoverContent, PopoverTrigger } from "$lib/components/ui/popover";
  import {
    CreditCard,
    History,
    Repeat2,
    AlertCircle,
    Wallet,
    Copy,
    Check,
    Coins,
    Info,
    ArrowUpRight,
    ArrowDownLeft,
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    Users
  } from '@lucide/svelte';

  export let data: PageData;
  export let form: ActionData;

  let quantity = 1000;
  let zcashAmount2z = 2500;
  let checkoutError = '';
  let redirectedToStripe = false;
  let zcashQrDataUrl: string | null = null;
  let zcashQrError = '';
  let copiedZcashUri = false;
  let paymentTab: 'stripe' | 'zcash' = 'stripe';
  let initializedPaymentTab = false;
  let billingTab: string = 'subscriptions';
  let initializedBillingTab = false;
// TODO: this should be dinamyc,
  const TUZI_PER_ZEC = 2500;
  const MAX_CHECKOUT_QUANTITY = 1_000_000;
  const MAX_SUBSCRIPTION_MAX_PRICE = 1_000_000;
  const DEFAULT_F2Z_ZCASH_ADDRESS = 'zs1lm4vumxdpuz08w237n0lpxz490uq5nxasz6mql555f96hql4h7kc3ucf2a42j7mp0slck2uvjjk';

  $: creator = data.creator;
  $: subscriptions = data.subscriptions?.results || [];
  $: subscriptionsCount = data.subscriptions?.count || 0;
  $: subscribers = data.subscribers?.results || [];
  $: subscribersCount = data.subscribers?.count || 0;
  $: transactions = data.transactions?.results || [];
  $: transactionsCount = data.transactions?.count || 0;

  $: subscriptionsPage = data.subscriptionsPage || 1;
  $: subscribersPage = data.subscribersPage || 1;
  $: transactionsPage = data.transactionsPage || 1;
  $: subscriptionOrdering = data.subscriptionOrdering || '-max_price';
  $: subscriberOrdering = data.subscriberOrdering || '-max_price';
  $: checkoutRef = data.checkoutRef || '';
  $: pageSize = data.pageSize || 10;

  $: stripePublicKey = env.PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
  $: f2zZcashAddress = env.PUBLIC_F2Z_ZCASH_ADDRESS || DEFAULT_F2Z_ZCASH_ADDRESS;
  $: totalCents = Math.trunc(quantity * 1.05) + 100;
  $: feeAmount = totalCents - 100 - quantity;
  $: zecAmount = zcashAmount2z / TUZI_PER_ZEC;
  $: zcashMemo = JSON.stringify({
    act: 'buy_2z',
    id: creator?.username || '',
    ...(checkoutRef ? { ref: checkoutRef } : {}),
  });

  $: if (!initializedPaymentTab) {
    paymentTab = $page.url.searchParams.get('tab') === 'zcash' ? 'zcash' : 'stripe';
    initializedPaymentTab = true;
  }

  $: if (!initializedBillingTab) {
    const section = $page.url.searchParams.get('section');
    if (section === 'subscribers') billingTab = 'subscribers';
    else if (section === 'history') billingTab = 'history';
    else billingTab = 'subscriptions';
    initializedBillingTab = true;
  }

  $: zcashUri = getZcashUri(f2zZcashAddress, zecAmount, zcashMemo);

  $: if (browser && zcashUri) {
    zcashQrError = '';
    QRCode.toDataURL(zcashUri, { margin: 1, width: 240 })
      .then((url: string) => {
        zcashQrDataUrl = url;
        zcashQrError = '';
      })
      .catch(() => {
        zcashQrDataUrl = null;
        zcashQrError = 'Failed to generate QR code.';
      });
  }

  $: if (form?.checkoutSessionId && !redirectedToStripe) {
    redirectedToStripe = true;
    redirectToStripe(form.checkoutSessionId);
  }

  async function redirectToStripe(sessionId: string) {
    checkoutError = '';

    if (!stripePublicKey) {
      checkoutError = 'Stripe is not configured. Set PUBLIC_STRIPE_PUBLISHABLE_KEY in the UI environment.';
      return;
    }

    try {
      const stripeModule = await import('@stripe/stripe-js');
      const stripe = await stripeModule.loadStripe(stripePublicKey);

      if (!stripe) {
        checkoutError = 'Failed to initialize Stripe.';
        return;
      }

      const { error } = await stripe.redirectToCheckout({
        sessionId,
      });

      if (error) {
        checkoutError = error.message || 'Unable to redirect to Stripe.';
      }
    } catch (err: any) {
      checkoutError = err?.message || 'Unable to redirect to Stripe.';
    }
  }

  function asCurrency(cents: number) {
    return (cents / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
    });
  }

  function base64UrlEncode(value: string) {
    try {
      const bytes = new TextEncoder().encode(value);
      let binary = '';
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
    } catch {
      return '';
    }
  }

  function getZcashUri(address: string, amount: number, memo: string) {
    if (!address || amount <= 0) {
      return '';
    }

    const amountPart = `amount=${amount.toFixed(8)}`;

    if (address.startsWith('t')) {
      return `zcash:${address}?${amountPart}`;
    }

    const memo64 = base64UrlEncode(memo);
    if (!memo64) {
      return `zcash:${address}?${amountPart}`;
    }

    return `zcash:${address}?${amountPart}&memo=${memo64}`;
  }

  async function copyZcashUri() {
    if (!zcashUri || !browser) {
      return;
    }
    try {
      await navigator.clipboard.writeText(zcashUri);
      copiedZcashUri = true;
      setTimeout(() => {
        copiedZcashUri = false;
      }, 1500);
    } catch {
      checkoutError = 'Failed to copy Zcash payment URI.';
    }
  }

  function asDate(timestamp: string) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return date.toLocaleString();
  }

  function subscriptionState(expiresAt: string) {
    const now = new Date();
    const expires = new Date(expiresAt);

    if (Number.isNaN(expires.getTime())) {
      return 'Unknown';
    }

    return expires < now ? 'Expired' : 'Active';
  }

  function pageHref(
    nextSubPage = subscriptionsPage,
    nextTxPage = transactionsPage,
    nextFanPage = subscribersPage,
    nextSubOrder = subscriptionOrdering,
    nextFanOrder = subscriberOrdering,
    section: string = billingTab
  ) {
    const params = new URLSearchParams();
    params.set('subPage', String(nextSubPage));
    params.set('txPage', String(nextTxPage));
    params.set('fanPage', String(nextFanPage));
    params.set('subOrder', nextSubOrder);
    params.set('fanOrder', nextFanOrder);
    params.set('section', section);
    if (checkoutRef) params.set('checkoutRef', checkoutRef);
    if (paymentTab === 'zcash') params.set('tab', 'zcash');
    return `/${$page.params.username}/dashboard/billing?${params.toString()}`;
  }
</script>

<svelte:head>
  <title>Billing • {creator?.username || ''}</title>
  <meta name="description" content="Manage your top-ups, subscriptions, and billing history." />
</svelte:head>

<main class="flex-1 bg-background text-foreground pb-20">
  <div class="container max-w-6xl mx-auto py-10 space-y-8">
    <!-- Header -->
    <header class="flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div class="space-y-1">
        <h1 class="text-3xl font-bold tracking-tight">Billing</h1>
        <p class="text-muted-foreground">Manage your 2Z balance, subscriptions, and transaction history.</p>
      </div>

      <Popover>
        <PopoverTrigger class={cn(buttonVariants({ variant: "ghost", size: "sm" }), "flex items-center gap-2 text-muted-foreground")}>
          <Info class="size-4" />
          <span>What are 2Zs?</span>
        </PopoverTrigger>
        <PopoverContent class="w-80">
          <div class="space-y-3">
            <h3 class="font-bold">What are 2Zs?</h3>
            <p class="text-sm text-muted-foreground leading-relaxed">
              2Zs are points worth $0.01 on Free2z. Use them for donations, subscriptions,
              commenting, voting, and boosting content.
            </p>
            <p class="text-sm text-muted-foreground leading-relaxed">
              Earn 2Zs by participating on the platform. Qualified creators can redeem them
              at up to their full value.
            </p>
            <a
              class="text-sm text-primary hover:underline font-medium inline-flex items-center gap-1"
              href="https://free2z.com/docs/revenue-sharing/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Learn more <ExternalLink class="size-3" />
            </a>
          </div>
        </PopoverContent>
      </Popover>
    </header>

    <!-- Alerts -->
    {#if form?.error || checkoutError}
      <div class="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive flex items-center gap-2">
        <AlertCircle class="size-4 shrink-0" />
        <span>{form?.error || checkoutError}</span>
      </div>
    {/if}

    {#if form?.success}
      <div class="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary flex items-center gap-2">
        <Check class="size-4 shrink-0" />
        <span>{form.success}</span>
      </div>
    {/if}

    <!-- Stats Row -->
    <section class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <Coins class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{(creator?.tuzis || 0).toLocaleString()}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Balance</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <Repeat2 class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{subscriptionsCount}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Subscriptions</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <Users class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{subscribersCount}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Subscribers</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <CreditCard class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{transactionsCount}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Transactions</p>
          </div>
        </CardContent>
      </Card>
    </section>

    <!-- Top Up Section -->
    <section class="space-y-6">
      <div class="space-y-1">
        <h2 class="text-xl font-semibold tracking-tight">Top Up Balance</h2>
        <p class="text-sm text-muted-foreground">Purchase 2Z to donate, subscribe, and boost content.</p>
      </div>

      <Tabs bind:value={paymentTab} class="space-y-4">
        <TabsList>
          <TabsTrigger value="stripe" class="flex items-center gap-2">
            <CreditCard class="size-4" />
            <span>Stripe</span>
          </TabsTrigger>
          <TabsTrigger value="zcash" class="flex items-center gap-2">
            <Wallet class="size-4" />
            <span>Zcash</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stripe">
          <Card>
            <CardHeader>
              <CardTitle>Buy 2Z with Stripe</CardTitle>
              <CardDescription>Credit card, Apple Pay, Google Pay</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-8 md:grid-cols-2">
              <form method="POST" action="?/checkout" class="space-y-6" use:enhance>
                {#if checkoutRef}
                  <input type="hidden" name="checkoutRef" value={checkoutRef} />
                {/if}
                <div class="space-y-4">
                  <div class="space-y-2">
                    <Label for="quantity">Purchase Amount (2Z)</Label>
                    <div class="relative">
                      <Input
                        id="quantity"
                        name="quantity"
                        type="number"
                        min="1"
                        max={MAX_CHECKOUT_QUANTITY}
                        bind:value={quantity}
                        required
                        class="pl-10 text-lg font-mono"
                      />
                      <div class="absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground pointer-events-none">
                        <Coins class="size-5" />
                      </div>
                    </div>
                    <p class="text-xs text-muted-foreground italic">1 to {MAX_CHECKOUT_QUANTITY.toLocaleString()} 2Z</p>
                  </div>

                  <div class="rounded-xl border bg-muted/30 p-4 space-y-3">
                    <div class="flex justify-between text-sm">
                      <span class="text-muted-foreground">2Z Credit</span>
                      <span class="font-mono">{quantity.toLocaleString()} 2Z</span>
                    </div>
                    <div class="flex justify-between text-sm">
                      <span class="text-muted-foreground">Processing Fee (5%)</span>
                      <span class="font-mono">{feeAmount.toLocaleString()} 2Z</span>
                    </div>
                    <div class="flex justify-between text-sm">
                      <span class="text-muted-foreground">Transaction Fee</span>
                      <span class="font-mono">100 2Z</span>
                    </div>
                    <div class="pt-2 border-t flex justify-between">
                      <span class="font-bold">Estimated Total</span>
                      <span class="font-bold text-lg text-primary">{asCurrency(totalCents)}</span>
                    </div>
                  </div>
                </div>

                <Button type="submit" size="lg" class="w-full" disabled={quantity < 1}>
                  {#if redirectedToStripe}
                    Redirecting...
                  {:else}
                    <span class="flex items-center gap-2">
                      <CreditCard class="size-4" />
                      Pay with Card
                    </span>
                  {/if}
                </Button>
              </form>

              <div class="hidden md:flex flex-col justify-center space-y-4 p-6 border-l text-sm text-muted-foreground">
                <div class="flex gap-3">
                  <div class="mt-0.5"><Check class="size-4 text-primary" /></div>
                  <p>Secure payment processing via <span class="font-semibold text-foreground">Stripe</span></p>
                </div>
                <div class="flex gap-3">
                  <div class="mt-0.5"><Check class="size-4 text-primary" /></div>
                  <p>Instant credit of <span class="font-semibold text-foreground">2Zs</span> upon successful payment</p>
                </div>
                <div class="flex gap-3">
                  <div class="mt-0.5"><Check class="size-4 text-primary" /></div>
                  <p>Support your favorite creators with ease</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="zcash">
          <Card>
            <CardHeader>
              <CardTitle>Buy 2Z with Zcash</CardTitle>
              <CardDescription>Private, low-fee Zcash payments</CardDescription>
            </CardHeader>
            <CardContent class="grid gap-10 md:grid-cols-2">
              <div class="space-y-6">
                <div class="space-y-2">
                  <Label for="zcash-amount">Purchase Amount (2Z)</Label>
                  <div class="relative">
                    <Input
                      id="zcash-amount"
                      type="number"
                      min="1"
                      bind:value={zcashAmount2z}
                      class="pl-10 text-lg font-mono"
                    />
                    <div class="absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground pointer-events-none">
                      <Coins class="size-5" />
                    </div>
                  </div>
                  <p class="text-xs font-medium text-primary">
                    Approximately <span class="font-mono">{zecAmount.toFixed(8)} ZEC</span>
                  </p>
                </div>

                <div class="space-y-4">
                  <div class="flex flex-col gap-2">
                    <Button href={zcashUri} variant="default" size="lg" class="w-full">
                      <ArrowUpRight class="mr-2 size-4" /> Open in Wallet
                    </Button>
                    <Button type="button" variant="outline" size="lg" class="w-full" onclick={copyZcashUri}>
                      {#if copiedZcashUri}
                        <Check class="mr-2 size-4 text-primary" /> Copied URI
                      {:else}
                        <Copy class="mr-2 size-4" /> Copy URI
                      {/if}
                    </Button>
                  </div>

                  <div class="rounded-lg border bg-muted/30 p-3">
                    <p class="text-[10px] text-muted-foreground uppercase font-bold tracking-widest mb-1.5">Payment Memo Required</p>
                    <p class="text-xs text-muted-foreground font-mono leading-tight break-all bg-background p-2 rounded border">
                      {zcashMemo}
                    </p>
                    <p class="text-[10px] text-primary font-medium mt-1.5 italic">
                      Include this memo so we can credit your account.
                    </p>
                  </div>
                </div>
              </div>

              <div class="flex flex-col items-center justify-center space-y-4">
                {#if zcashQrDataUrl}
                  <div class="bg-white p-4 rounded-2xl border-2 border-primary/20 shadow-md">
                    <img src={zcashQrDataUrl} alt="Zcash payment QR" class="size-48" />
                  </div>
                  <p class="text-sm font-medium">Scan to pay with a mobile wallet</p>
                {:else if zcashQrError}
                  <div class="bg-destructive/10 text-destructive p-8 rounded-2xl border border-destructive/20 text-center">
                    <AlertCircle class="size-8 mx-auto mb-2" />
                    <p class="text-sm">{zcashQrError}</p>
                  </div>
                {:else}
                  <div class="size-48 bg-muted rounded-2xl animate-pulse flex items-center justify-center">
                    <Wallet class="size-10 text-muted-foreground/30" />
                  </div>
                  <p class="text-sm text-muted-foreground italic">Generating payment QR...</p>
                {/if}
              </div>
            </CardContent>
            <CardFooter class="border-t bg-muted/10 p-4">
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <Info class="size-3.5 mt-0.5 shrink-0" />
                <p>Zcash payments are usually processed within minutes. Your 2Z balance will update after 1 confirmation on the blockchain.</p>
              </div>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </section>

    <!-- Billing Details Section -->
    <section class="space-y-6">
      <div class="space-y-1">
        <h2 class="text-xl font-semibold tracking-tight">Billing Details</h2>
        <p class="text-sm text-muted-foreground">View and manage your subscriptions, subscribers, and payment history.</p>
      </div>

      <Tabs bind:value={billingTab} class="space-y-4">
        <TabsList class="w-full sm:w-fit">
          <TabsTrigger value="subscriptions" class="flex-1 sm:flex-initial flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
            <Repeat2 class="size-4 hidden sm:block" />
            <span>Subs</span>
            {#if subscriptionsCount > 0}
              <Badge variant="secondary" class="h-5 min-w-5 px-1.5 text-[10px] rounded-full">{subscriptionsCount}</Badge>
            {/if}
          </TabsTrigger>
          <TabsTrigger value="subscribers" class="flex-1 sm:flex-initial flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
            <Users class="size-4 hidden sm:block" />
            <span>Fans</span>
            {#if subscribersCount > 0}
              <Badge variant="secondary" class="h-5 min-w-5 px-1.5 text-[10px] rounded-full">{subscribersCount}</Badge>
            {/if}
          </TabsTrigger>
          <TabsTrigger value="history" class="flex-1 sm:flex-initial flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
            <History class="size-4 hidden sm:block" />
            <span>History</span>
            {#if transactionsCount > 0}
              <Badge variant="secondary" class="h-5 min-w-5 px-1.5 text-[10px] rounded-full">{transactionsCount}</Badge>
            {/if}
          </TabsTrigger>
        </TabsList>

        <!-- Subscriptions Tab -->
        <TabsContent value="subscriptions">
          <Card>
            <CardHeader class="flex flex-row items-center justify-between space-y-0">
              <div class="space-y-1">
                <CardTitle>Your Subscriptions</CardTitle>
                <CardDescription>Creators you are supporting monthly.</CardDescription>
              </div>
              <div class="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={subscriptionOrdering === '-max_price' ? 'default' : 'ghost'}
                  href={pageHref(1, transactionsPage, subscribersPage, '-max_price', subscriberOrdering, 'subscriptions')}
                  class="h-7 px-2 text-[10px] uppercase font-bold tracking-wider"
                >
                  Price
                </Button>
                <Button
                  size="sm"
                  variant={subscriptionOrdering === 'expires' ? 'default' : 'ghost'}
                  href={pageHref(1, transactionsPage, subscribersPage, 'expires', subscriberOrdering, 'subscriptions')}
                  class="h-7 px-2 text-[10px] uppercase font-bold tracking-wider"
                >
                  Expiry
                </Button>
              </div>
            </CardHeader>
            <CardContent class="space-y-4">
              {#if subscriptions.length === 0}
                <div class="flex flex-col items-center justify-center py-12 text-center space-y-2 border-2 border-dashed rounded-xl">
                  <Repeat2 class="size-10 text-muted-foreground/20" />
                  <p class="text-sm text-muted-foreground">No active subscriptions found.</p>
                  <Button href="/creators" variant="link" size="sm">Find creators to support</Button>
                </div>
              {:else}
                <div class="grid gap-4 md:grid-cols-2">
                  {#each subscriptions as subscription}
                    <div class="group rounded-xl border bg-card hover:border-primary/50 transition-colors p-4 space-y-3">
                      <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3">
                          <div class="size-9 rounded-full bg-primary/10 flex items-center justify-center font-bold text-sm text-primary border border-primary/20">
                            {(subscription.star.username?.[0] || 'U').toUpperCase()}
                          </div>
                          <div>
                            <a class="font-bold text-sm hover:text-primary transition-colors" href={`/${subscription.star.username}`}>
                              @{subscription.star.username}
                            </a>
                            <p class="text-[10px] text-muted-foreground uppercase font-bold tracking-wider mt-0.5">
                              Renews {asDate(subscription.expires).split(',')[0]}
                            </p>
                          </div>
                        </div>
                        <Badge variant={subscriptionState(subscription.expires) === 'Active' ? 'default' : 'secondary'} class="rounded-md uppercase text-[10px] px-1.5 py-0">
                          {subscriptionState(subscription.expires)}
                        </Badge>
                      </div>

                      <div class="pt-3 border-t space-y-2">
                        <form method="POST" action="?/updateSubscription" class="flex items-end gap-2" use:enhance>
                          <input type="hidden" name="starUsername" value={subscription.star.username} />
                          <input type="hidden" name="memberPrice" value={subscription.star.member_price} />
                          <div class="flex-1 space-y-1">
                            <Label for={`max-${subscription.star.username}`} class="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Max 2Z / Month</Label>
                            <Input
                              id={`max-${subscription.star.username}`}
                              name="maxPrice"
                              type="number"
                              min={subscription.star.member_price}
                              max={creator?.tuzis ?? MAX_SUBSCRIPTION_MAX_PRICE}
                              value={subscription.max_price}
                              required
                              class="h-8 font-mono"
                            />
                          </div>
                          <Button type="submit" variant="outline" size="sm" class="h-8">Update</Button>
                        </form>

                        <form method="POST" action="?/unsubscribe" use:enhance>
                          <input type="hidden" name="starUsername" value={subscription.star.username} />
                          <Button type="submit" variant="ghost" size="sm" class="w-full h-7 text-xs text-destructive hover:text-destructive hover:bg-destructive/10">
                            Unsubscribe
                          </Button>
                        </form>
                      </div>
                    </div>
                  {/each}
                </div>

                {#if subscriptionsCount > pageSize}
                  {@const subTotalPages = Math.ceil(subscriptionsCount / pageSize)}
                  <div class="flex items-center justify-center gap-4 pt-4">
                    <Button
                      href={pageHref(Math.max(1, subscriptionsPage - 1), transactionsPage, subscribersPage, subscriptionOrdering, subscriberOrdering, 'subscriptions')}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscriptionsPage <= 1}
                    >
                      <ChevronLeft class="size-4" />
                    </Button>
                    <span class="text-xs font-medium">Page {subscriptionsPage} / {subTotalPages}</span>
                    <Button
                      href={pageHref(Math.min(subTotalPages, subscriptionsPage + 1), transactionsPage, subscribersPage, subscriptionOrdering, subscriberOrdering, 'subscriptions')}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscriptionsPage >= subTotalPages}
                    >
                      <ChevronRight class="size-4" />
                    </Button>
                  </div>
                {/if}
              {/if}
            </CardContent>
          </Card>
        </TabsContent>

        <!-- Subscribers Tab -->
        <TabsContent value="subscribers">
          <Card>
            <CardHeader class="flex flex-row items-center justify-between space-y-0">
              <div class="space-y-1">
                <CardTitle>Your Subscribers</CardTitle>
                <CardDescription>People who support you monthly.</CardDescription>
              </div>
              <div class="flex items-center gap-1">
                <Button
                  size="sm"
                  variant={subscriberOrdering === '-max_price' ? 'default' : 'ghost'}
                  href={pageHref(subscriptionsPage, transactionsPage, 1, subscriptionOrdering, '-max_price', 'subscribers')}
                  class="h-7 px-2 text-[10px] uppercase font-bold tracking-wider"
                >
                  Price
                </Button>
                <Button
                  size="sm"
                  variant={subscriberOrdering === 'expires' ? 'default' : 'ghost'}
                  href={pageHref(subscriptionsPage, transactionsPage, 1, subscriptionOrdering, 'expires', 'subscribers')}
                  class="h-7 px-2 text-[10px] uppercase font-bold tracking-wider"
                >
                  Expiry
                </Button>
              </div>
            </CardHeader>
            <CardContent class="space-y-4">
              {#if subscribers.length === 0}
                <div class="flex flex-col items-center justify-center py-12 text-center space-y-2 border-2 border-dashed rounded-xl">
                  <Users class="size-10 text-muted-foreground/20" />
                  <p class="text-sm text-muted-foreground">No subscribers found yet.</p>
                </div>
              {:else}
                <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {#each subscribers as subscription}
                    {@const fanUsername = subscription?.fan?.username || subscription?.star?.username || 'unknown'}
                    <div class="group rounded-xl border bg-card hover:border-primary/50 transition-colors p-4 space-y-3">
                      <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-3">
                          <div class="size-9 rounded-full bg-primary/10 flex items-center justify-center font-bold text-sm text-primary border border-primary/20">
                            {(fanUsername[0] || 'U').toUpperCase()}
                          </div>
                          <a class="font-bold text-sm hover:text-primary transition-colors" href={`/${fanUsername}`}>
                            @{fanUsername}
                          </a>
                        </div>
                        <Badge variant={subscriptionState(subscription.expires) === 'Active' ? 'default' : 'secondary'} class="rounded-md uppercase text-[10px] px-1.5 py-0">
                          {subscriptionState(subscription.expires)}
                        </Badge>
                      </div>
                      <div class="pt-3 border-t space-y-2">
                        <div class="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Max monthly</span>
                          <span class="font-mono text-foreground font-medium">{subscription.max_price?.toLocaleString?.() ?? subscription.max_price} 2Z</span>
                        </div>
                        <div class="flex items-center justify-between text-xs text-muted-foreground">
                          <span>Renews</span>
                          <span class="text-foreground font-medium">{asDate(subscription.expires).split(',')[0]}</span>
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>

                {#if subscribersCount > pageSize}
                  {@const fanTotalPages = Math.ceil(subscribersCount / pageSize)}
                  <div class="flex items-center justify-center gap-4 pt-4">
                    <Button
                      href={pageHref(subscriptionsPage, transactionsPage, Math.max(1, subscribersPage - 1), subscriptionOrdering, subscriberOrdering, 'subscribers')}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscribersPage <= 1}
                    >
                      <ChevronLeft class="size-4" />
                    </Button>
                    <span class="text-xs font-medium">Page {subscribersPage} / {fanTotalPages}</span>
                    <Button
                      href={pageHref(subscriptionsPage, transactionsPage, Math.min(fanTotalPages, subscribersPage + 1), subscriptionOrdering, subscriberOrdering, 'subscribers')}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscribersPage >= fanTotalPages}
                    >
                      <ChevronRight class="size-4" />
                    </Button>
                  </div>
                {/if}
              {/if}
            </CardContent>
          </Card>
        </TabsContent>

        <!-- Payment History Tab -->
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Payment History</CardTitle>
              <CardDescription>Your Stripe transaction history.</CardDescription>
            </CardHeader>
            <CardContent class="space-y-4">
              {#if transactions.length === 0}
                <div class="flex flex-col items-center justify-center py-12 text-center space-y-2 border-2 border-dashed rounded-xl">
                  <History class="size-10 text-muted-foreground/20" />
                  <p class="text-sm text-muted-foreground">No Stripe transactions yet.</p>
                </div>
              {:else}
                <div class="space-y-2">
                  {#each transactions as transaction}
                    <div class="group rounded-xl border p-4 flex items-center justify-between gap-4 bg-card hover:border-primary/50 transition-colors">
                      <div class="flex items-center gap-3">
                        <div class="size-9 rounded-full bg-primary/10 flex items-center justify-center">
                          <ArrowDownLeft class="size-4 text-primary" />
                        </div>
                        <div>
                          <div class="font-bold text-sm">{asCurrency(transaction.amount)}</div>
                          <div class="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">{asDate(transaction.timestamp).split(',')[0]}</div>
                        </div>
                      </div>
                      <div class="text-right">
                        <div class="text-sm font-bold text-primary">+{transaction.tuzis_credited.toLocaleString()} 2Z</div>
                        <div class="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Credited</div>
                      </div>
                    </div>
                  {/each}
                </div>

                {#if transactionsCount > pageSize}
                  {@const txTotalPages = Math.ceil(transactionsCount / pageSize)}
                  <div class="flex items-center justify-center gap-4 pt-4">
                    <Button
                      href={pageHref(subscriptionsPage, Math.max(1, transactionsPage - 1), subscribersPage, subscriptionOrdering, subscriberOrdering, 'history')}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={transactionsPage <= 1}
                    >
                      <ChevronLeft class="size-4" />
                    </Button>
                    <span class="text-xs font-medium">Page {transactionsPage} / {txTotalPages}</span>
                    <Button
                      href={pageHref(subscriptionsPage, Math.min(txTotalPages, transactionsPage + 1), subscribersPage, subscriptionOrdering, subscriberOrdering, 'history')}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={transactionsPage >= txTotalPages}
                    >
                      <ChevronRight class="size-4" />
                    </Button>
                  </div>
                {/if}
              {/if}
            </CardContent>
            <CardFooter class="border-t bg-muted/10 p-4">
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <Info class="size-3.5 mt-0.5 shrink-0" />
                <p>Zcash transactions are not listed here. They will appear in your 2Z balance once confirmed.</p>
              </div>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </section>
  </div>
</main>
