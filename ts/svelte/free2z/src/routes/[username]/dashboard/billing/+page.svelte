<script lang="ts">
  import { formatDate, formatDateTime, toTimestamp } from "$lib/utils/date";
  import type { ActionData, PageData } from "./$types";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { browser } from "$app/env";
  import * as env from "$app/env/public";
  import { formatLocalizedNumber, locale, tStore as t } from "$lib/i18n";
  import {
    cardFeeCents,
    estimatedCardCents,
    fetchPricing,
    readCachedPricing,
    estimatedTuziPerZec,
    isEstimate,
    type Pricing,
    type ZecFundingCapacity,
    validZecFundingCapacity,
    exhaustedZecFundingCapacity,
    anchorServerTime,
    serverTimeNow,
    serverClockUncertain,
    type ServerTimeAnchor,
    zecFundingCapacityPreview,
  } from "$lib/pricing";
  import { page } from "$lib/kit-stores";
  import { usableClientId } from "$lib/sdk-flow";
  import {
    requestedPaymentTab,
    type PaymentTab,
  } from "$lib/billing-payment-tab";
  import { cn } from "$lib/utils.js";
  import { formatTuzis, formatTuzisDeficit } from "$lib/utils/format-tuzis";
  import {
    parsePrice,
    priceCeiling,
    subscriptionCardState,
    type PriceCeiling,
    type SubscriptionCardState,
  } from "$lib/subscription-ceiling.js";
  import QRCode from "qrcode";
  import { currentUser, authStore } from "$lib/stores/auth";
  import { createAccountBalanceDisplay } from "$lib/account-balance";
  import { createRenewalDisplay } from "$lib/billing-renewal-display";
  import {
    buildZcashPurchaseUri,
    zecAmountForPurchase,
  } from "$lib/zcash-purchase-uri";
  import { enhance } from "$app/forms";
  import { formatUsageMilli, creditedAllocation } from "$lib/economy-values.js";
  import {
    economyCapabilities,
    economyFundingResolutions,
  } from "$lib/api/economy/economy";
  import CreatorEarnings from "$lib/components/dashboard/CreatorEarnings.svelte";
  import StatTile from "$lib/components/dashboard/StatTile.svelte";
  import { Button, buttonVariants } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Badge } from "$lib/components/ui/badge";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
    CardFooter,
  } from "$lib/components/ui/card";
  import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
  } from "$lib/components/ui/tabs";
  import {
    Popover,
    PopoverContent,
    PopoverTrigger,
  } from "$lib/components/ui/popover";
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
    Users,
  } from "@lucide/svelte";

  export let data: PageData;
  export let form: ActionData;

  type BillingActionData = ActionData & {
    action?: string;
    ok?: boolean;
    messageKey?: string;
    messageParams?: Record<string, string | number>;
    checkoutActorId?: number;
    checkoutSessionId?: string;
    checkoutUrl?: string;
    checkoutQuote?: {
      checkoutIntentId: string;
      tuzis: number;
      amountCents: number;
      currency: string;
      pricingVersion: string;
    };
  };

  function issuedCredits(transaction: unknown): string | null {
    if (!transaction || typeof transaction !== "object") return null;
    const value = transaction as Record<string, unknown>;
    return value.status === "credited" &&
      value.credited === true &&
      typeof value.credited_m2z === "string" &&
      /^\d+$/.test(value.credited_m2z)
      ? value.credited_m2z
      : null;
  }

  let quantity = 1000;
  let zcashAmount2z = 2500;
  let checkoutError = "";
  let redirectingToStripe = false;
  let checkoutMounted = false;
  let appliedCheckoutSessionId = "";
  let zcashQrDataUrl: string | null = null;
  let zcashQrError = "";
  let copiedZcashUri = false;
  let zcashHandoffBusy = false;
  let zcashPolicy: {
    policy_version: number;
    active: boolean;
    zec_funding_method?: { version: string; digest: string; text: string };
    zec_funding_capacity?: ZecFundingCapacity | null;
  } | null = null;
  let verifiedZcashOwner: number | null = null;
  let zcashMounted = false;
  let zcashPolicyGeneration = 0;
  let zcashVerificationGeneration = 0;
  let zcashPolicyPendingGeneration: number | null = null;
  let zcashServerClock: ServerTimeAnchor | null = null;
  let zcashClockOwned: (() => boolean) | null = null;
  let zcashClockWallBaseline: number | null = null;
  let zcashClockInvalidated = false;
  let zcashResumeReadBusy = false;
  function invalidateZcashClock(policyOne = false) {
    if (
      !zcashMounted ||
      (!policyOne && zcashPolicy?.policy_version !== 1) ||
      zcashClockInvalidated
    )
      return;
    zcashClockInvalidated = true;
    zcashPolicyGeneration++;
    verifiedZcashOwner = null;
    pricingNow = NaN;
    zcashResumeReadBusy = true;
    void (async () => {
      if (await verifyZcashAccount()) await refreshZcashPricing();
    })()
      .catch(() => {})
      .finally(() => {
        zcashResumeReadBusy = false;
      });
  }
  function readPricingTime(): number {
    if (zcashClockOwned && !zcashClockOwned()) zcashServerClock = null;
    if (zcashPolicy?.policy_version !== 1) return Date.now();
    const monotonic = performance.now();
    if (
      serverClockUncertain(
        zcashServerClock,
        zcashClockWallBaseline,
        Date.now(),
        monotonic,
      )
    )
      invalidateZcashClock();
    return zcashClockInvalidated
      ? NaN
      : serverTimeNow(zcashServerClock, monotonic);
  }

  $: zcashOwnerMatches =
    $currentUser?.id === creator?.id &&
    $currentUser?.username === creator?.username;
  $: if (!zcashOwnerMatches) {
    zcashPolicyGeneration++;
    verifiedZcashOwner = null;
    zcashPolicy = null;
    zcashServerClock = null;
  }
  function fundingPolicyAllows(value: typeof zcashPolicy): boolean {
    return (
      !!value &&
      (value.policy_version === 0 ||
        (value.policy_version === 1 &&
          value.active &&
          value.zec_funding_method?.version === "zec-funding-v3" &&
          typeof value.zec_funding_method.digest === "string" &&
          !!value.zec_funding_method.digest &&
          typeof value.zec_funding_method.text === "string" &&
          !!value.zec_funding_method.text))
    );
  }
  $: zcashFundingAvailable =
    zcashOwnerMatches &&
    verifiedZcashOwner === creator?.id &&
    fundingPolicyAllows(zcashPolicy) &&
    (zcashPolicy?.policy_version !== 1 || !zcashClockInvalidated) &&
    (zcashPolicy?.policy_version === 0 ||
      validZecFundingCapacity(zcashPolicy?.zec_funding_capacity));

  async function refreshZcashPolicy(background = false) {
    if (background && zcashPolicyPendingGeneration !== null) return null;
    const generation = ++zcashPolicyGeneration;
    zcashPolicyPendingGeneration = generation;
    const originalId = creator?.id;
    const originalUsername = creator?.username;
    const actorStillOwns = authStore.captureRequestOwnership();
    try {
      const value = (await economyCapabilities({
        timeoutMs: 10000,
        cache: "no-store",
      })) as typeof zcashPolicy;
      if (
        generation !== zcashPolicyGeneration ||
        !actorStillOwns() ||
        !zcashMounted ||
        creator?.id !== originalId ||
        creator?.username !== originalUsername ||
        get(currentUser)?.id !== originalId ||
        get(currentUser)?.username !== originalUsername
      )
        return null;
      if (value?.policy_version === 0) {
        value.zec_funding_capacity = null;
        zcashServerClock = null;
      } else if (fundingPolicyAllows(value)) {
        const capacityRequestStarted = performance.now();
        const capacityWallStarted = Date.now();
        const financial = (await economyFundingResolutions(
          { expected_actor_id: originalId },
          { timeoutMs: 10000, cache: "no-store" },
        )) as unknown as {
          actor_id: number;
          zec_funding_capacity?: ZecFundingCapacity | null;
        };
        if (generation !== zcashPolicyGeneration || !actorStillOwns())
          return null;
        if (
          !zcashMounted ||
          creator?.id !== originalId ||
          creator?.username !== originalUsername ||
          get(currentUser)?.id !== originalId ||
          get(currentUser)?.username !== originalUsername ||
          financial.actor_id !== originalId ||
          !validZecFundingCapacity(financial.zec_funding_capacity)
        ) {
          zcashPolicy = null;
          if (!zcashMounted || !zcashOwnerMatches) zcashServerClock = null;
          return null;
        }
        if (
          serverClockUncertain(
            { monotonic_ms: capacityRequestStarted },
            capacityWallStarted,
            Date.now(),
            performance.now(),
          )
        ) {
          invalidateZcashClock(true);
          return null;
        }
        value!.zec_funding_capacity = financial.zec_funding_capacity;
        zcashServerClock = anchorServerTime(
          financial.zec_funding_capacity.as_of,
          capacityRequestStarted,
          performance.now(),
          zcashClockOwned?.() ? zcashServerClock : null,
        );
        zcashClockOwned = actorStillOwns;
        zcashClockWallBaseline = Date.now();
        zcashClockInvalidated = false;
      } else zcashServerClock = null;
      zcashPolicy = value;
      pricingNow = readPricingTime();
      return value;
    } catch {
      if (generation === zcashPolicyGeneration) {
        zcashPolicy = null;
        if (!actorStillOwns() || !zcashMounted || !zcashOwnerMatches)
          zcashServerClock = null;
      }
      return null;
    } finally {
      if (zcashPolicyPendingGeneration === generation)
        zcashPolicyPendingGeneration = null;
    }
  }

  async function verifyZcashAccount(): Promise<boolean> {
    const generation = ++zcashVerificationGeneration;
    const originalId = creator?.id;
    const originalUsername = creator?.username;
    const verificationStarted = performance.now();
    const verificationWallStarted = Date.now();
    const authenticated = await authStore.checkAuth({
      fresh: true,
      force: true,
      silent: true,
    });
    if (generation !== zcashVerificationGeneration || !zcashMounted)
      return false;
    const actor = get(currentUser);
    if (
      authenticated !== true ||
      creator?.id !== originalId ||
      creator?.username !== originalUsername ||
      actor?.id !== originalId ||
      actor?.username !== originalUsername
    ) {
      zcashPolicyGeneration++;
      verifiedZcashOwner = null;
      zcashPolicy = null;
      if (!zcashOwnerMatches || zcashClockOwned?.() === false)
        zcashServerClock = null;
      return false;
    }
    if (
      zcashPolicy?.policy_version === 1 &&
      serverClockUncertain(
        { monotonic_ms: verificationStarted },
        verificationWallStarted,
        Date.now(),
        performance.now(),
      )
    ) {
      invalidateZcashClock();
      return false;
    }
    verifiedZcashOwner = originalId;
    const policy = await refreshZcashPolicy();
    const verifiedActor = get(currentUser);
    return (
      generation === zcashVerificationGeneration &&
      zcashMounted &&
      creator?.id === originalId &&
      creator?.username === originalUsername &&
      verifiedActor?.id === originalId &&
      verifiedActor?.username === originalUsername &&
      fundingPolicyAllows(policy) &&
      (policy?.policy_version === 0 ||
        validZecFundingCapacity(policy?.zec_funding_capacity))
    );
  }

  onMount(() => {
    zcashMounted = true;
    const firstVerification = verifyZcashAccount();
    const firstVerificationGeneration = zcashVerificationGeneration;
    // Zcash is the default tab, never a dead end: when the first
    // check says Zcash cannot be offered right now and the visitor has not
    // picked a tab (by URL or by click), open Card instead. Only this first
    // answer decides; a later background refresh never moves the visitor.
    void firstVerification.then((available) => {
      if (
        !available &&
        zcashMounted &&
        firstVerificationGeneration === zcashVerificationGeneration &&
        !paymentTabChosen &&
        paymentTab === "zcash" &&
        stripeCheckoutEnabled
      )
        paymentTab = "stripe";
    });
    const timer = setInterval(() => void refreshZcashPolicy(true), 15000);
    const resume = () => invalidateZcashClock();
    const visible = () => {
      if (document.visibilityState === "visible") resume();
    };
    window.addEventListener("focus", resume);
    window.addEventListener("pageshow", resume);
    document.addEventListener("visibilitychange", visible);
    return () => {
      zcashMounted = false;
      zcashVerificationGeneration++;
      zcashServerClock = null;
      zcashPolicyGeneration++;
      clearInterval(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", visible);
      zcashQrGeneration++;
    };
  });
  let zcashQrGeneration = 0;

  function isStripeHostedCheckoutUrl(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.hostname === "checkout.stripe.com" &&
        parsed.port === "" &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }
  let paymentTab: PaymentTab = "zcash";
  // True once the URL (`?tab=`) or a click has picked a tab: the Card
  // fallback above never overrides a choice.
  let paymentTabChosen = false;
  let initializedPaymentTab = false;
  let billingTab: string = "subscriptions";
  let initializedBillingTab = false;
  let subscriptionMaxDrafts = new Map<string, string>();
  // Live, spread-adjusted 2Z-per-ZEC rate from /api/pricing/ (issue ).
  // Seeded from SSR only (reading localStorage here would diverge from the
  // server render and cause a hydration mismatch); the cached price and live
  // refresh are applied in onMount below.
  let livePricing: Pricing | null = data.pricing ?? null;
  let pricingNow = readPricingTime();
  let promoDraft = "";
  let appliedPromoCode = "";
  let promoError = "";
  let pricingPreviewBusy = false;
  let pricingValidated = false;
  let pricingMounted = false;
  let pricingRequestGeneration = 0;
  let promoOwnerId = data.creator.id;
  $: normalizedPromoDraft = promoDraft
    .trim()
    .replace(/[a-z]/g, (letter) => letter.toUpperCase());
  $: promotion = livePricing?.zec_promotion;
  $: hasEstimatedOffer = Number(promotion?.multiplier) > 1;
  $: offerExpired =
    hasEstimatedOffer &&
    !!promotion?.ends_at &&
    toTimestamp(promotion.ends_at) <= pricingNow;
  $: promotionPreviewUsable =
    !hasEstimatedOffer ||
    (pricingValidated && !priceIsEstimate && !offerExpired);
  $: if (
    pricingMounted &&
    (promoOwnerId !== creator?.id ||
      (!zcashOwnerMatches &&
        (promoDraft || appliedPromoCode || pricingPreviewBusy)))
  ) {
    promoOwnerId = creator.id;
    promoDraft = "";
    appliedPromoCode = "";
    promoError = "";
    pricingRequestGeneration++;
    pricingPreviewBusy = false;
    pricingValidated = false;
    livePricing = data.pricing ?? null;
  }
  $: liveTuzisPerZec = estimatedTuziPerZec(livePricing);
  $: priceIsEstimate = isEstimate(livePricing, pricingNow);
  $: estimateBuffer = Number(
    livePricing?.estimate_buffer ?? livePricing?.spread,
  );
  $: settlementSpread =
    livePricing?.estimate_buffer !== undefined
      ? Number(livePricing.spread)
      : NaN;
  const MAX_CHECKOUT_QUANTITY = 1_000_000;
  const MAX_SUBSCRIPTION_MAX_PRICE = 1_000_000;
  const DEFAULT_F2Z_ZCASH_ADDRESS =
    "u1ac9rjvjddcnshvawyc39qujxgll2yu07w5gehstq72z6rjmzurf5c9f65jjedfaedx2h8ajlc6ya0qyfec9mexkwajnfxj00m3a63p2zva6xr9s5ll08yfylth5wkunwvfk0c7qclz436wrc63q2f6089at5l4dxaz6avuq86sxvufyx3c9972cc0y5w3zlyf5erc40cghlwsn4alpk";

  $: creator = data.creator;
  const balanceDisplay = createAccountBalanceDisplay((owner) => {
    if (typeof window !== "undefined")
      authStore.observeAccountBalanceSnapshot(owner);
  });
  $: accountBalance = balanceDisplay(creator, $currentUser);
  $: subscriptions = data.subscriptions?.results || [];
  $: subscriptionsCount = data.subscriptions?.count || 0;
  $: subscribers = data.subscribers?.results || [];
  $: subscribersCount = data.subscribers?.count || 0;
  $: transactions = data.transactions?.results || [];
  $: transactionsCount = data.transactions?.count || 0;
  $: renewalSummary = data.renewalSummary;

  const renewalDisplay = createRenewalDisplay((owner, order) => {
    if (typeof window !== "undefined") {
      authStore.fenceAccountSnapshot(owner.username, order);
      authStore.observeAccountBalanceSnapshot(owner);
    }
  });
  // The summary has its own consistent balance; only a post-arrival auth read
  // can update its warning without borrowing an earlier creator observation.
  $: renewal = renewalDisplay(renewalSummary, creator, $currentUser);
  $: renewalStatus = renewal.status;
  $: renewalHorizonDays = renewal.horizonDays;
  $: renewalTotal = renewal.total;
  $: renewalShortfall = renewal.shortfall;

  $: actionData = form as BillingActionData;
  $: actionFallback = actionData?.ok
    ? $t(
        "dashboard.billing.actionSuccess",
        "Your request completed successfully.",
      )
    : $t(
        "dashboard.billing.actionFailed",
        "Your request could not be completed.",
      );
  $: actionMessage = actionData?.messageKey
    ? $t(
        actionData.messageKey,
        actionFallback,
        Object.fromEntries(
          Object.entries(actionData.messageParams || {}).map(([key, value]) => [
            key,
            typeof value === "number" ? value.toLocaleString($locale) : value,
          ]),
        ),
      )
    : "";
  $: if (
    typeof actionData?.checkoutSessionId === "string" &&
    actionData.checkoutSessionId !== appliedCheckoutSessionId &&
    Number.isInteger(actionData.checkoutQuote?.tuzis)
  ) {
    appliedCheckoutSessionId = actionData.checkoutSessionId;
    quantity = Number(actionData.checkoutQuote?.tuzis);
  }
  $: reviewedCheckout =
    typeof actionData?.checkoutSessionId === "string" &&
    actionData.checkoutSessionId.length > 0 &&
    isStripeHostedCheckoutUrl(actionData?.checkoutUrl) &&
    Number.isSafeInteger(actionData.checkoutActorId) &&
    actionData.checkoutActorId === creator?.id &&
    actionData.checkoutQuote &&
    Number(actionData.checkoutQuote.tuzis) === Number(quantity)
      ? {
          actorId: actionData.checkoutActorId!,
          sessionId: actionData.checkoutSessionId,
          url: actionData.checkoutUrl,
          quote: actionData.checkoutQuote,
        }
      : null;

  $: subscriptionsPage = data.subscriptionsPage || 1;
  $: subscribersPage = data.subscribersPage || 1;
  $: transactionsPage = data.transactionsPage || 1;
  $: subscriptionOrdering = data.subscriptionOrdering || "-max_price";
  $: subscriberOrdering = data.subscriberOrdering || "-max_price";
  $: checkoutRef = data.checkoutRef || "";
  $: pageSize = data.pageSize || 10;

  $: stripeCheckoutEnabled = env.PUBLIC_STRIPE_CHECKOUT_ENABLED === "true";
  $: f2zZcashAddress =
    env.PUBLIC_F2Z_ZCASH_ADDRESS || DEFAULT_F2Z_ZCASH_ADDRESS;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  async function refreshZcashPricing(code = appliedPromoCode) {
    if (!pricingMounted || pricingPreviewBusy) return;
    const generation = ++pricingRequestGeneration;
    const ownerId = creator.id;
    const ownerUsername = creator.username;
    const pricing = await fetchPricing(fetch, apiBase, code);
    if (
      !pricingMounted ||
      generation !== pricingRequestGeneration ||
      creator.id !== ownerId ||
      creator.username !== ownerUsername ||
      code !== appliedPromoCode
    )
      return;
    pricingNow = readPricingTime();
    const matchingCode =
      (!code && !pricing?.zec_promotion?.requested_code) ||
      (!!code &&
        !!pricing?.zec_promotion &&
        (pricing.zec_promotion.requested_code === code ||
          (pricing.zec_promotion.code_status === "unavailable" &&
            pricing.zec_promotion.requested_code === null)));
    pricingValidated = !!pricing && matchingCode;
    if (pricing && matchingCode) livePricing = pricing;
  }

  async function applyPromoCode() {
    const generation = ++pricingRequestGeneration;
    const ownerId = creator.id;
    const ownerUsername = creator.username;
    const code = normalizedPromoDraft;
    pricingPreviewBusy = true;
    promoError = "";
    try {
      if (!(await verifyZcashAccount())) throw new Error("account unavailable");
      if (generation !== pricingRequestGeneration) return;
      const pricing = await fetchPricing(fetch, apiBase, code);
      if (
        !pricingMounted ||
        generation !== pricingRequestGeneration ||
        creator.id !== ownerId ||
        creator.username !== ownerUsername ||
        get(currentUser)?.id !== ownerId ||
        get(currentUser)?.username !== ownerUsername ||
        normalizedPromoDraft !== code
      )
        return;
      if (
        !pricing ||
        (!code && !!pricing.zec_promotion?.requested_code) ||
        (code &&
          (!pricing.zec_promotion ||
            (pricing.zec_promotion.requested_code !== code &&
              !(
                pricing.zec_promotion.code_status === "unavailable" &&
                pricing.zec_promotion.requested_code === null
              ))))
      )
        throw new Error("preview unavailable");
      appliedPromoCode = code;
      livePricing = pricing;
      pricingValidated = true;
      pricingNow = readPricingTime();
    } catch {
      if (generation === pricingRequestGeneration)
        promoError =
          "Unable to refresh this estimate. Please retry before sending.";
    } finally {
      if (generation === pricingRequestGeneration) pricingPreviewBusy = false;
    }
  }

  onMount(() => {
    checkoutMounted = true;
    pricingMounted = true;
    if (!livePricing) livePricing = readCachedPricing();
    void refreshZcashPricing();
    const timer = setInterval(() => void refreshZcashPricing(), 45000);
    const clock = setInterval(() => {
      pricingNow = readPricingTime();
    }, 1000);
    return () => {
      pricingMounted = false;
      pricingRequestGeneration++;
      clearInterval(timer);
      clearInterval(clock);
    };
  });
  // Preview only. The payment confirmation below always uses the durable,
  // server-owned quote returned with the Checkout Session.
  $: validCardQuantity =
    Number.isInteger(quantity) &&
    quantity >= 1 &&
    quantity <= MAX_CHECKOUT_QUANTITY;
  // Derived from the live /api/pricing/ payload so the disclosed estimate
  // cannot drift from the backend's card-v3 formula (see $lib/pricing).
  $: totalCents = validCardQuantity
    ? estimatedCardCents(quantity, livePricing)
    : 0;
  $: cardFeeAmountCents = validCardQuantity
    ? cardFeeCents(quantity, livePricing)
    : 0;
  $: zecAmount = zecAmountForPurchase(zcashAmount2z, liveTuzisPerZec);
  $: zcashMemo = JSON.stringify({
    act: "buy_2z",
    id: creator?.username || "",
    ...(appliedPromoCode ? { promo: appliedPromoCode } : {}),
  });

  $: if (!initializedPaymentTab) {
    const requested = requestedPaymentTab($page.url);
    paymentTab = requested ?? "zcash";
    paymentTabChosen = requested !== null;
    initializedPaymentTab = true;
  }
  // An app sent the visitor here through `/buy-2z?client_id=`. The
  // id is never rendered: it only switches on one neutral line.
  $: returningApp = usableClientId($page.url.searchParams.get("app"));
  // The card form posts back to the Card tab: a submit that lands before
  // hydration (or without JS) is a full page load of this URL, and without
  // `tab=stripe` it would open on Zcash with the quote hidden behind it.
  // SvelteKit picks the action from the one `/`-prefixed parameter.
  $: checkoutAction = (() => {
    const params = new URLSearchParams({ tab: "stripe" });
    if (checkoutRef) params.set("checkoutRef", checkoutRef);
    if (returningApp) params.set("app", returningApp);
    return `?${params.toString()}&/checkout`;
  })();

  $: if (!initializedBillingTab) {
    const section = $page.url.searchParams.get("section");
    if (section === "subscribers") billingTab = "subscribers";
    else if (section === "history") billingTab = "history";
    else billingTab = "subscriptions";
    initializedBillingTab = true;
  }

  $: validZcashQuantity = Number.isFinite(zcashAmount2z) && zcashAmount2z >= 1;
  $: capacityPreview = zecFundingCapacityPreview(
    zecAmount,
    livePricing,
    zcashPolicy?.zec_funding_capacity,
    pricingNow,
  );
  $: zcashCapacityExhausted =
    zcashPolicy?.policy_version === 1 &&
    exhaustedZecFundingCapacity(zcashPolicy?.zec_funding_capacity);
  $: zcashOverCapacity =
    zcashCapacityExhausted ||
    (!!capacityPreview &&
      (capacityPreview.exceeds_credit_limit ||
        capacityPreview.exceeds_sale_limit));
  $: capacityProjectionAvailable =
    zcashPolicy?.policy_version === 0 || !!capacityPreview;
  function withinKnownZcashCapacity(): boolean {
    if (
      zcashPolicy?.policy_version === 1 &&
      exhaustedZecFundingCapacity(zcashPolicy?.zec_funding_capacity)
    )
      return false;
    const preview = zecFundingCapacityPreview(
      zecAmount,
      livePricing,
      zcashPolicy?.zec_funding_capacity,
      readPricingTime(),
    );
    return (
      zcashPolicy?.policy_version === 0 ||
      (!!preview &&
        !preview.exceeds_credit_limit &&
        !preview.exceeds_sale_limit)
    );
  }
  $: zcashUri =
    validZcashQuantity &&
    zcashFundingAvailable &&
    capacityProjectionAvailable &&
    !zcashOverCapacity &&
    !pricingPreviewBusy &&
    normalizedPromoDraft === appliedPromoCode &&
    promotionPreviewUsable
      ? buildZcashPurchaseUri(f2zZcashAddress, zecAmount, zcashMemo)
      : "";

  $: if (browser) updateZcashQr(zcashUri);

  async function updateZcashQr(uri: string) {
    const generation = ++zcashQrGeneration;
    zcashQrDataUrl = null;
    zcashQrError = "";
    copiedZcashUri = false;
    if (!uri) return;
    try {
      const url = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
      if (generation === zcashQrGeneration) zcashQrDataUrl = url;
    } catch {
      if (generation !== zcashQrGeneration) return;
      zcashQrError = $t(
        "dashboard.billing.errors.qrGenerationFailed",
        "Failed to generate QR code.",
      );
    }
  }

  async function redirectToStripe(checkoutUrl: string) {
    checkoutError = "";
    redirectingToStripe = true;

    if (!stripeCheckoutEnabled) {
      checkoutError = $t(
        "dashboard.billing.errors.stripeNotConfigured",
        "Stripe is not configured.",
      );
      redirectingToStripe = false;
      return;
    }

    const original = reviewedCheckout;
    const originalUsername = creator?.username;
    try {
      if (!original || original.url !== checkoutUrl)
        throw new Error("stale quote");
      const authenticated = await authStore.checkAuth({
        fresh: true,
        force: true,
        silent: true,
      });
      const authenticatedActor = get(currentUser);
      if (
        authenticated !== true ||
        authenticatedActor?.id !== original.actorId ||
        authenticatedActor?.username !== originalUsername ||
        creator?.id !== original.actorId ||
        creator?.username !== originalUsername ||
        reviewedCheckout?.sessionId !== original.sessionId ||
        reviewedCheckout?.url !== original.url ||
        Number(quantity) !== original.quote.tuzis
      ) {
        checkoutError = $t("economy.signInAgain");
        redirectingToStripe = false;
        return;
      }
      window.location.assign(original.url);
    } catch (err: any) {
      checkoutError = $t(
        "dashboard.billing.errors.stripeRedirectFailed",
        "Unable to redirect to Stripe.",
      );
      redirectingToStripe = false;
    }
  }

  function asCurrency(cents: number) {
    return (cents / 100).toLocaleString($locale, {
      style: "currency",
      currency: "USD",
    });
  }

  async function copyZcashUri() {
    if (
      !zcashUri ||
      !browser ||
      (zcashPolicy?.policy_version === 1 && zcashClockInvalidated)
    ) {
      return;
    }
    const original = zcashUri;
    zcashHandoffBusy = true;
    try {
      const authorizedUri = async () => {
        if (
          !(await verifyZcashAccount()) ||
          !withinKnownZcashCapacity() ||
          original !== zcashUri
        )
          throw new Error("stale funding instruction");
        return original;
      };
      if (
        typeof ClipboardItem === "function" &&
        typeof navigator.clipboard?.write === "function"
      ) {
        // Start the clipboard request in the click gesture (WebKit), but do
        // not provide any text until the original instruction is verified.
        const content = authorizedUri().then(
          (value) => new Blob([value], { type: "text/plain" }),
        );
        void content.catch(() => {});
        await navigator.clipboard.write([
          new ClipboardItem({ "text/plain": content }),
        ]);
      } else {
        await navigator.clipboard.writeText(await authorizedUri());
      }
      copiedZcashUri = true;
      setTimeout(() => {
        copiedZcashUri = false;
      }, 1500);
    } catch {
      checkoutError = $t(
        "dashboard.billing.errors.copyZcashUriFailed",
        "Failed to copy the Zcash payment URI.",
      );
    } finally {
      zcashHandoffBusy = false;
    }
  }

  async function openZcashWallet(event: MouseEvent) {
    event.preventDefault();
    const original = zcashUri;
    if (
      !original ||
      zcashHandoffBusy ||
      (zcashPolicy?.policy_version === 1 && zcashClockInvalidated)
    )
      return;
    zcashHandoffBusy = true;
    try {
      if (
        !(await verifyZcashAccount()) ||
        !withinKnownZcashCapacity() ||
        original !== zcashUri
      )
        throw new Error("stale funding instruction");
      window.location.assign(original);
    } catch {
      checkoutError = $t("funding.unavailable");
    } finally {
      zcashHandoffBusy = false;
    }
  }

  function asDate(timestamp: string) {
    return formatDate(timestamp, $locale, undefined, "—");
  }

  // Issue: the badge is derived from the card state, not the expiry clock
  // alone — a subscription can be paid through Sep 3 and still be doomed, and
  // saying "Active" there contradicts the notice right below it.
  function subscriptionStateLabel(state: SubscriptionCardState) {
    if (state === "active")
      return $t("dashboard.billing.status.active", "Active");
    if (state === "ending")
      return $t("dashboard.billing.status.ending", "Ending");
    if (state === "expired")
      return $t("dashboard.billing.status.expired", "Expired");
    return $t("dashboard.billing.status.unknown", "Unknown");
  }

  // Issue: the creator's current price is what the "Maximum 2Z per month"
  // ceiling is measured against, so show it on the card and warn when there is
  // little or no headroom left before a price rise ends the subscription. The
  // classifier itself lives in $lib/subscription-ceiling.js so the backend
  // invariants it encodes can be table-tested (issue ).

  // Red when the price itself is why renewal fails, amber when the headroom is
  // merely thin. Cancellation is about the fan's own cap, not the price, so the
  // price stays neutral there and the notice below carries the warning.
  function priceTone(ceiling: PriceCeiling) {
    if (ceiling === "over" || ceiling === "unpriced") return "text-destructive";
    if (ceiling === "at" || ceiling === "near")
      return "text-amber-600 dark:text-amber-400";
    return "text-foreground";
  }

  function noticeTone(ceiling: PriceCeiling) {
    if (ceiling === "free") return "text-muted-foreground";
    return ceiling === "at" || ceiling === "near"
      ? "text-amber-600 dark:text-amber-400"
      : "text-destructive";
  }

  function pageHref(
    nextSubPage = subscriptionsPage,
    nextTxPage = transactionsPage,
    nextFanPage = subscribersPage,
    nextSubOrder = subscriptionOrdering,
    nextFanOrder = subscriberOrdering,
    section: string = billingTab,
  ) {
    const params = new URLSearchParams();
    params.set("subPage", String(nextSubPage));
    params.set("txPage", String(nextTxPage));
    params.set("fanPage", String(nextFanPage));
    params.set("subOrder", nextSubOrder);
    params.set("fanOrder", nextFanOrder);
    params.set("section", section);
    if (checkoutRef) params.set("checkoutRef", checkoutRef);
    params.set("tab", paymentTab);
    if (returningApp) params.set("app", returningApp);
    return `/${$page.params.username}/dashboard/billing?${params.toString()}`;
  }
</script>

<svelte:head>
  <title
    >{$t("dashboard.billing.metaTitle", "Credits & Earnings • {username}", {
      username: creator?.username || "",
    })}</title
  >
  <meta
    name="description"
    content={$t(
      "dashboard.billing.metaDescription",
      "Manage your credits, creator earnings and subscriptions.",
    )}
  />
</svelte:head>

<main
  class="flex-1 bg-background pb-20 text-foreground"
  data-zcash-auth-mounted={zcashMounted}
>
  <div class="container mx-auto max-w-6xl space-y-8 py-10">
    <!-- Header -->
    <header
      class="flex flex-col justify-between gap-4 md:flex-row md:items-center"
    >
      <div class="space-y-1">
        <h1 class="text-3xl font-bold tracking-tight">
          {$t("dashboard.billing.heading", "Credits & Earnings")}
        </h1>
        <p class="text-muted-foreground">
          {$t(
            "dashboard.billing.description",
            "Manage your credits, creator earnings and subscriptions.",
          )}
        </p>
      </div>

      <Popover>
        <PopoverTrigger
          class={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "flex items-center gap-2 text-muted-foreground",
          )}
        >
          <Info class="size-4" />
          <span>{$t("dashboard.billing.about2Z.title", "What is 2Z?")}</span>
        </PopoverTrigger>
        <PopoverContent class="w-80">
          <div class="space-y-3">
            <h3 class="font-bold">
              {$t("dashboard.billing.about2Z.title", "What is 2Z?")}
            </h3>
            <p class="text-sm leading-relaxed text-muted-foreground">
              {$t(
                "dashboard.billing.about2Z.description",
                "2Z are usage credits for Free2Z services, including subscriptions, AI, livestream access, comments, votes, and boosts.",
              )}
            </p>
            <p class="text-sm leading-relaxed text-muted-foreground">
              {$t(
                "dashboard.billing.about2Z.earning",
                "Sharing or receiving credits does not create USD earnings. Creator earnings are recorded separately.",
              )}
            </p>
            <a
              class="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              href="/docs/revenue-sharing"
              target="_blank"
              rel="noopener noreferrer"
            >
              {$t("dashboard.billing.learnMore", "Learn more")}
              <ExternalLink class="size-3" />
            </a>
          </div>
        </PopoverContent>
      </Popover>
    </header>

    <!-- Alerts -->
    {#if (actionData && actionData.ok === false) || checkoutError}
      <div
        role="alert"
        class="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
      >
        <AlertCircle class="size-4 shrink-0" />
        <span>{checkoutError || actionMessage}</span>
      </div>
    {/if}

    {#if actionData?.ok === true && actionMessage}
      <div
        role="status"
        class="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary"
      >
        <Check class="size-4 shrink-0" />
        <span>{actionMessage}</span>
      </div>
    {/if}

    <!--
      Stats Row. The tile geometry is shared with the profile dashboard — see
      `$lib/components/dashboard/StatTile.svelte`. This page used to carry its
      own copy that never received the / fix: it kept the icon beside
      the text at every width and papered over the resulting overflow with
      `overflow-wrap: anywhere`, so a 320px phone rendered "SUBSCRI/PTIONS",
      "TRANSA/CTIONS", "BALANC/E" and a balance broken across three lines as
      "64,6 / 72.2 / 3".
    -->
    <section
      class="grid grid-cols-2 gap-4 md:grid-cols-4"
      data-testid="billing-stats"
    >
      <!--
        `creator.tuzis` is a DRF decimal STRING, and
        `String.prototype.toLocaleString` is a no-op that returns it unchanged —
        this tile printed a raw "64672.234" until. `formatTuzis` groups it
        and truncates toward zero on the TEXT, so a balance can never be
        displayed as more than the creator holds.
      -->
      <StatTile
        testId="billing-stat-balance"
        valueTestId="billing-balance-value"
        value={formatTuzis(accountBalance, $locale)}
        label={$t("dashboard.billing.balance", "Usage credits")}
      >
        <Coins slot="icon" class="size-5 text-primary" />
      </StatTile>

      <StatTile
        testId="billing-stat-subscriptions"
        value={subscriptionsCount.toLocaleString($locale)}
        label={$t("dashboard.billing.subscriptions", "Subscriptions")}
      >
        <Repeat2 slot="icon" class="size-5 text-primary" />
      </StatTile>

      <StatTile
        testId="billing-stat-subscribers"
        value={subscribersCount.toLocaleString($locale)}
        label={$t("dashboard.billing.subscribers", "Subscribers")}
      >
        <Users slot="icon" class="size-5 text-primary" />
      </StatTile>

      <StatTile
        testId="billing-stat-transactions"
        value={transactionsCount.toLocaleString($locale)}
        label={$t("dashboard.billing.transactions", "Card purchases")}
      >
        <CreditCard slot="icon" class="size-5 text-primary" />
      </StatTile>
    </section>

    <CreatorEarnings ownerUsername={$page.params.username || ""} />

    <!-- Renewal affordability is aggregate: every subscription draws from
         the same balance, so a per-card check cannot catch two individually
         affordable renewals whose combined cost is too high. -->
    {#if renewalStatus === "shortfall"}
      <div
        role="alert"
        class="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm"
      >
        <AlertCircle
          class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div class="space-y-1">
          <p class="font-semibold text-amber-700 dark:text-amber-300">
            {$t("dashboard.billing.renewalSummary.title", "Upcoming renewals")}
          </p>
          <p class="text-amber-700/90 dark:text-amber-300/90">
            {$t(
              "dashboard.billing.renewalSummary.shortfall",
              "At today's prices, renewals scheduled in the next {days} days total {total} 2Z. Your balance is short by {shortfall} 2Z.",
              {
                days: formatLocalizedNumber(renewalHorizonDays, $locale),
                total: formatTuzis(renewalTotal, $locale),
                shortfall: formatTuzisDeficit(renewalShortfall, $locale),
              },
            )}
          </p>
          <p class="text-xs text-amber-700/80 dark:text-amber-300/80">
            {$t(
              "dashboard.billing.renewalSummary.excluded",
              "Subscriptions shown as not renewing are not counted here.",
            )}
          </p>
        </div>
      </div>
    {:else if renewalStatus === "ok"}
      <div
        role="status"
        class="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm"
      >
        <Info class="mt-0.5 size-4 shrink-0 text-primary" />
        <div class="space-y-1">
          <p class="font-semibold text-foreground">
            {$t("dashboard.billing.renewalSummary.title", "Upcoming renewals")}
          </p>
          <p class="text-muted-foreground">
            {$t(
              "dashboard.billing.renewalSummary.covered",
              "At today's prices, your balance covers the renewals scheduled in the next {days} days ({total} 2Z).",
              {
                days: formatLocalizedNumber(renewalHorizonDays, $locale),
                total: formatTuzis(renewalTotal, $locale),
              },
            )}
          </p>
          <p class="text-xs text-muted-foreground">
            {$t(
              "dashboard.billing.renewalSummary.excluded",
              "Subscriptions shown as not renewing are not counted here.",
            )}
          </p>
        </div>
      </div>
    {:else if renewalStatus === "unknown"}
      <div
        role="status"
        class="flex items-start gap-3 rounded-lg border border-muted-foreground/20 bg-muted/30 px-4 py-3 text-sm"
      >
        <Info class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div class="space-y-1">
          <p class="font-semibold text-foreground">
            {$t("dashboard.billing.renewalSummary.title", "Upcoming renewals")}
          </p>
          <p class="text-muted-foreground">
            {$t(
              "dashboard.billing.renewalSummary.unknown",
              "We couldn't calculate your upcoming renewal total. Check each subscription before its renewal date.",
            )}
          </p>
        </div>
      </div>
    {/if}

    <!-- Top Up Section -->
    <section class="space-y-6">
      <div class="space-y-1">
        <h2 class="text-xl font-semibold tracking-tight">
          {$t("dashboard.billing.topUp.title", "Top Up Balance")}
        </h2>
        <p class="text-sm text-muted-foreground">
          {$t(
            "dashboard.billing.topUp.description",
            "Purchase 2Z to donate, subscribe, and boost content.",
          )}
        </p>
        {#if returningApp}
          <p class="text-sm text-muted-foreground" data-testid="return-to-app">
            {$t(
              "dashboard.billing.topUp.returnToApp",
              "When you're done, go back to your app. It will pick up your new balance once your payment is credited.",
            )}
          </p>
        {/if}
      </div>

      <Tabs
        bind:value={paymentTab}
        onValueChange={() => (paymentTabChosen = true)}
        class="space-y-4"
      >
        <TabsList>
          <TabsTrigger value="zcash" class="flex items-center gap-2">
            <Wallet class="size-4" />
            <span>{$t("dashboard.billing.topUp.zcashTab", "Zcash")}</span>
          </TabsTrigger>
          <TabsTrigger value="stripe" class="flex items-center gap-2">
            <CreditCard class="size-4" />
            <span>{$t("dashboard.billing.topUp.cardTab", "Card")}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stripe">
          <Card>
            <CardHeader>
              <CardTitle
                >{$t(
                  "dashboard.billing.stripe.title",
                  "Buy 2Z with Stripe",
                )}</CardTitle
              >
              <CardDescription
                >{$t(
                  "dashboard.billing.stripe.description",
                  "Credit card, Apple Pay, Google Pay",
                )}</CardDescription
              >
            </CardHeader>
            <CardContent class="grid gap-8 md:grid-cols-2">
              <form
                method="POST"
                action={checkoutAction}
                class="space-y-6"
                use:enhance
              >
                <input
                  type="hidden"
                  name="expected_actor_id"
                  value={creator.id}
                />
                {#if checkoutRef}
                  <input type="hidden" name="checkoutRef" value={checkoutRef} />
                {/if}
                {#if returningApp}
                  <input type="hidden" name="app" value={returningApp} />
                {/if}
                <div class="space-y-4">
                  <div class="space-y-2">
                    <Label for="quantity"
                      >{$t(
                        "dashboard.billing.purchaseAmount",
                        "Purchase Amount (2Z)",
                      )}</Label
                    >
                    <div class="relative">
                      <Input
                        id="quantity"
                        name="quantity"
                        type="number"
                        min="1"
                        max={MAX_CHECKOUT_QUANTITY}
                        bind:value={quantity}
                        required
                        class="pl-10 font-mono text-lg"
                      />
                      <div
                        class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground"
                      >
                        <Coins class="size-5" />
                      </div>
                    </div>
                    <p class="text-xs text-muted-foreground italic">
                      {$t(
                        "dashboard.billing.amountRange",
                        "{minimum} to {maximum} 2Z",
                        {
                          minimum: 1,
                          maximum:
                            MAX_CHECKOUT_QUANTITY.toLocaleString($locale),
                        },
                      )}
                    </p>
                  </div>

                  <div class="space-y-3 rounded-xl border bg-muted/30 p-4">
                    <div class="flex justify-between text-sm">
                      <span class="text-muted-foreground"
                        >{$t("dashboard.billing.credit", "2Z Credit")}</span
                      >
                      <span class="font-mono"
                        >{quantity.toLocaleString($locale)} 2Z</span
                      >
                    </div>
                    <div class="flex justify-between text-sm">
                      <span class="text-muted-foreground"
                        >{$t("dashboard.billing.cardFee", "Card Fee")}</span
                      >
                      <span class="font-mono"
                        >{asCurrency(cardFeeAmountCents)}</span
                      >
                    </div>
                    <div class="flex justify-between border-t pt-2">
                      <span class="font-bold"
                        >{$t(
                          "dashboard.billing.estimatedTotal",
                          "Estimated Total",
                        )}</span
                      >
                      <span class="text-lg font-bold text-primary"
                        >{asCurrency(totalCents)}</span
                      >
                    </div>
                  </div>
                </div>

                <Button
                  type="submit"
                  size="lg"
                  class="w-full"
                  disabled={!validCardQuantity || !stripeCheckoutEnabled}
                >
                  <span class="flex items-center gap-2">
                    <CreditCard class="size-4" />
                    {$t(
                      "dashboard.billing.reviewCardCharge",
                      "Review exact charge",
                    )}
                  </span>
                </Button>

                {#if reviewedCheckout}
                  <div
                    class="space-y-3 rounded-xl border border-primary/40 bg-primary/5 p-4"
                    data-testid="authoritative-card-quote"
                  >
                    <div class="flex items-center justify-between gap-3">
                      <span class="font-medium"
                        >{$t(
                          "dashboard.billing.exactCardCharge",
                          "Exact card charge",
                        )}</span
                      >
                      <span class="font-mono text-lg font-bold text-primary"
                        >{asCurrency(reviewedCheckout.quote.amountCents)}</span
                      >
                    </div>
                    <p class="text-sm text-muted-foreground">
                      {$t(
                        "dashboard.billing.exactCardCredit",
                        "Stripe will charge this amount for {quantity} 2Z.",
                        {
                          quantity:
                            reviewedCheckout.quote.tuzis.toLocaleString(
                              $locale,
                            ),
                        },
                      )}
                    </p>
                    <p class="text-sm text-muted-foreground">
                      {$t("dashboard.billing.creditPurchaseDisclosure")}
                    </p>
                    <a
                      class="text-sm text-primary underline"
                      href="/docs/legal/token-sale-and-usage-terms"
                      >{$t("dashboard.billing.creditPurchaseTerms")}</a
                    >
                    <Button
                      type="button"
                      class="w-full"
                      disabled={redirectingToStripe || !checkoutMounted}
                      onclick={() => redirectToStripe(reviewedCheckout.url)}
                    >
                      {redirectingToStripe
                        ? $t("dashboard.billing.redirecting", "Redirecting...")
                        : $t(
                            "dashboard.billing.continueToStripe",
                            "Continue to Stripe",
                          )}
                    </Button>
                  </div>
                {/if}
              </form>

              <div
                class="hidden flex-col justify-center space-y-4 border-l p-6 text-sm text-muted-foreground md:flex"
              >
                <div class="flex gap-3">
                  <div class="mt-0.5">
                    <Check class="size-4 text-primary" />
                  </div>
                  <p>
                    {$t(
                      "dashboard.billing.stripe.secureProcessing",
                      "Secure payment processing via Stripe",
                    )}
                  </p>
                </div>
                <div class="flex gap-3">
                  <div class="mt-0.5">
                    <Check class="size-4 text-primary" />
                  </div>
                  <p>
                    {$t(
                      "dashboard.billing.stripe.instantCredit",
                      "Payment processing; credits appear after confirmed issuance.",
                    )}
                  </p>
                </div>
                <div class="flex gap-3">
                  <div class="mt-0.5">
                    <Check class="size-4 text-primary" />
                  </div>
                  <p>
                    {$t(
                      "dashboard.billing.stripe.supportCreators",
                      "Support your favorite creators with ease",
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="zcash">
          <Card>
            <CardContent class="grid gap-10 md:grid-cols-2">
              <div class="space-y-6">
                <div class="space-y-2">
                  <Label for="zcash-amount">Estimated credits (2Z)</Label>
                  <div class="relative">
                    <Input
                      id="zcash-amount"
                      type="number"
                      min="1"
                      bind:value={zcashAmount2z}
                      class="pl-10 font-mono text-lg"
                    />
                    <div
                      class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-muted-foreground"
                    >
                      <Coins class="size-5" />
                    </div>
                  </div>
                  <p class="text-xs font-medium text-primary">
                    {$t(
                      "dashboard.billing.zcash.approximately",
                      "Approximately {amount} ZEC",
                      {
                        amount: zecAmount.toLocaleString($locale, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 8,
                        }),
                      },
                    )}
                  </p>
                  <div
                    class="space-y-1 text-xs text-muted-foreground"
                    data-testid="zcash-price-estimate"
                  >
                    <p>
                      Conservative estimated rate:
                      <span class="font-mono"
                        >{Math.round(liveTuzisPerZec).toLocaleString($locale)} 2Z
                        / ZEC</span
                      >
                    </p>
                    {#if livePricing && Number.isFinite(Number(livePricing.zec_usd)) && Number(livePricing.zec_usd) > 0}
                      <p>
                        {priceIsEstimate
                          ? "Reference market price"
                          : "Current market price"}: ZEC ≈ ${Number(
                          livePricing.zec_usd,
                        ).toLocaleString($locale, { maximumFractionDigits: 2 })}
                      </p>
                      {#if typeof livePricing.updated_at === "string" && Number.isFinite(Date.parse(livePricing.updated_at))}
                        <p>
                          Last updated: <time datetime={livePricing.updated_at}
                            >{formatDateTime(
                              livePricing.updated_at,
                              $locale,
                            )}</time
                          >
                        </p>
                      {/if}
                    {/if}
                    {#if Number.isFinite(estimateBuffer) && estimateBuffer >= 0 && estimateBuffer < 1}
                      <p>
                        Estimate buffer: {new Intl.NumberFormat($locale, {
                          style: "percent",
                        }).format(estimateBuffer)}.
                      </p>
                    {/if}
                    {#if Number.isFinite(settlementSpread) && settlementSpread >= 0 && settlementSpread < 1}
                      {#if settlementSpread === 0}
                        <p>
                          Free2Z currently charges no Zcash purchase fee or
                          spread.
                        </p>
                      {:else}
                        <p>
                          Settlement spread: {new Intl.NumberFormat($locale, {
                            style: "percent",
                          }).format(settlementSpread)}.
                        </p>
                      {/if}
                    {/if}
                  </div>
                  <div class="space-y-2">
                    <Label for="zcash-promo-code">Promo code (optional)</Label>
                    <div class="flex gap-2">
                      <Input
                        id="zcash-promo-code"
                        maxlength={64}
                        disabled={!zcashFundingAvailable}
                        bind:value={promoDraft}
                        autocomplete="off"
                        class="min-w-0"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onclick={applyPromoCode}
                        disabled={!zcashFundingAvailable}
                        data-testid="zcash-promo-apply"
                      >
                        {pricingPreviewBusy ? "Applying…" : "Apply"}
                      </Button>
                    </div>
                    {#if normalizedPromoDraft !== appliedPromoCode}
                      <p class="text-xs text-muted-foreground">
                        Apply this code to update the payment estimate.
                      </p>
                    {/if}
                    {#if appliedPromoCode}<p
                        class="text-xs text-muted-foreground"
                      >
                        Applied code: {appliedPromoCode}
                      </p>{/if}
                    {#if promotion?.code_status === "unavailable" && appliedPromoCode}
                      <p role="status" class="text-xs text-muted-foreground">
                        This code is unavailable. Your payment can still receive
                        the current global offer or standard credits.
                      </p>
                    {/if}
                    {#if promoError}<p
                        role="alert"
                        class="text-xs text-destructive"
                      >
                        {promoError}
                      </p>{/if}
                  </div>
                  {#if hasEstimatedOffer}
                    <div
                      class="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
                      data-testid="zcash-promotion"
                    >
                      <p class="text-xs text-muted-foreground">
                        {offerExpired
                          ? "Expired offer preview"
                          : !pricingValidated || priceIsEstimate
                            ? "Unverified offer preview"
                            : "Current offer"}
                      </p>
                      <Badge variant="secondary"
                        >{promotion?.title || "Zcash offer"} · {formatLocalizedNumber(
                          Number(promotion?.multiplier),
                          $locale,
                        )}×</Badge
                      >
                      {#if promotion?.ends_at}<p class="text-xs">
                          Offer ends: <time datetime={promotion.ends_at}
                            >{formatDateTime(promotion.ends_at, $locale)}</time
                          >
                        </p>{/if}
                      <p class="text-xs text-muted-foreground">
                        The offer must be active when your confirmed payment is
                        processed. A code never locks a bonus or rate; offers do
                        not stack.
                      </p>
                      {#if !promotionPreviewUsable}<p
                          role="status"
                          class="text-xs"
                        >
                          Refresh this promotion estimate before sending.
                        </p>{/if}
                    </div>
                  {/if}
                  {#if zcashFundingAvailable && zcashPolicy?.zec_funding_capacity && (zcashCapacityExhausted || zcashOverCapacity)}
                    <div
                      class="space-y-2 rounded-lg border p-3 text-xs"
                      data-testid="zcash-funding-capacity"
                    >
                      <p class="font-medium">This account’s purchase limits</p>
                      <p>
                        {formatUsageMilli(
                          zcashPolicy.zec_funding_capacity.remaining_m2z,
                          $locale,
                        )} in credits and ${(
                          Number(
                            zcashPolicy.zec_funding_capacity
                              .remaining_sale_nusd,
                          ) / 1_000_000_000
                        ).toLocaleString($locale, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 9,
                        })} USD in purchase value remain.
                      </p>
                      {#if zcashCapacityExhausted}
                        <p role="alert" class="text-destructive">
                          Zcash purchases are unavailable for this account. Do
                          not send a payment. Try again later or contact
                          support.
                        </p>
                      {:else if zcashOverCapacity && capacityPreview}
                        <p role="alert" class="text-destructive">
                          This payment exceeds your available limits at the
                          displayed rate. Reduce the estimated credits before
                          sending.
                        </p>
                        {#if capacityPreview.exceeds_credit_limit}<p>
                            Current-rate credit projection: {formatUsageMilli(
                              capacityPreview.projected_m2z,
                              $locale,
                            )}.
                          </p>{/if}
                        {#if capacityPreview.exceeds_sale_limit}<p>
                            Current-rate purchase value: ${(
                              Number(capacityPreview.projected_sale_nusd) /
                              1_000_000_000
                            ).toLocaleString($locale, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 9,
                            })} USD.
                          </p>{/if}
                      {/if}
                      <p>
                        Your opening balance, incoming credits and pending
                        funding count toward the credit limit.
                      </p>
                      <p>
                        No capacity or rate is reserved. Price, offers and other
                        account activity may change before processing. Payments
                        over a limit require support to resolve.
                      </p>
                    </div>
                  {/if}
                  <p
                    class="text-xs text-muted-foreground"
                    data-testid="zcash-estimate-disclosure"
                  >
                    This is a conservative estimate. You’ll likely receive more
                    2Z; it is not a guaranteed minimum. After at least three
                    confirmations, we credit the ZEC actually received using the
                    current market price when we process your payment. Wallet
                    and network fees are separate.
                  </p>
                  {#if priceIsEstimate}
                    <p class="text-[10px] text-amber-600">
                      Live price unavailable — this ZEC amount is an estimate.
                    </p>
                  {/if}
                </div>

                <div class="space-y-4">
                  {#if zcashPolicy?.zec_funding_method?.text}
                    <details
                      class="rounded-lg border p-3 text-sm"
                      data-testid="zcash-funding-terms"
                    >
                      <summary class="cursor-pointer font-medium"
                        >Read the funding terms</summary
                      >
                      <p class="mt-3 break-words whitespace-pre-wrap">
                        {zcashPolicy.zec_funding_method.text}
                      </p>
                    </details>
                  {/if}
                  <a
                    href="/docs/legal/token-sale-and-usage-terms"
                    class="text-sm text-primary underline"
                    >Full usage-credit purchase terms</a
                  >
                  <div
                    id="zcash-memo-required"
                    role="note"
                    class="space-y-3 rounded-lg border-2 border-amber-500/60 bg-amber-500/10 p-4"
                  >
                    <p class="text-sm font-semibold">
                      {$t(
                        "dashboard.billing.zcash.memoMandatory",
                        "Memo required — no memo, no automatic 2Z credit.",
                      )}
                    </p>
                    <p
                      class="rounded border bg-background p-2 font-mono text-xs leading-tight break-all text-muted-foreground"
                    >
                      {zcashMemo}
                    </p>
                    <p class="text-sm">
                      {$t(
                        "dashboard.billing.zcash.memoAttribution",
                        "This is a shared Free2Z address. You must send this exact memo so we can identify and credit your account.",
                      )}
                    </p>
                    <p class="text-sm">
                      {$t(
                        "dashboard.billing.zcash.memoWalletCheck",
                        "Open in Wallet, Copy URI, and the QR include this memo. Before sending, check that your wallet’s memo field contains the exact text above and that it will send a shielded payment.",
                      )}
                    </p>
                    <p class="text-sm font-medium">
                      {$t(
                        "dashboard.billing.zcash.memoWalletRequired",
                        "Use a wallet that preserves the memo. Do not send from an exchange or use a transparent transfer; they cannot include the required memo.",
                      )}
                    </p>
                  </div>
                  <div class="flex flex-col gap-2">
                    <Button
                      href={zcashUri || undefined}
                      onclick={openZcashWallet}
                      disabled={!zcashUri || zcashHandoffBusy}
                      aria-describedby="zcash-memo-required"
                      variant="default"
                      size="lg"
                      class="w-full"
                    >
                      <ArrowUpRight class="mr-2 size-4" />
                      {$t(
                        "dashboard.billing.zcash.openWallet",
                        "Open in Wallet",
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="lg"
                      class="w-full"
                      onclick={copyZcashUri}
                      disabled={!zcashUri || zcashHandoffBusy}
                      aria-describedby="zcash-memo-required"
                    >
                      {#if copiedZcashUri}
                        <Check class="mr-2 size-4 text-primary" />
                        {$t("dashboard.billing.zcash.copiedUri", "Copied URI")}
                      {:else}
                        <Copy class="mr-2 size-4" />
                        {$t("dashboard.billing.zcash.copyUri", "Copy URI")}
                      {/if}
                    </Button>
                  </div>
                </div>
              </div>

              <div class="flex flex-col items-center justify-center space-y-4">
                {#if !zcashFundingAvailable}
                  <p role="status" class="text-sm text-muted-foreground">
                    {$t("funding.unavailable")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={zcashResumeReadBusy}
                    onclick={async () => {
                      await verifyZcashAccount();
                      await refreshZcashPricing();
                    }}
                  >
                    Retry payment instructions
                  </Button>
                {:else if zcashCapacityExhausted}
                  <AlertCircle
                    class="size-10 text-destructive/40"
                    aria-hidden="true"
                  />
                {:else if !capacityProjectionAvailable && validZcashQuantity}
                  <p role="status" class="text-sm text-muted-foreground">
                    Waiting for current pricing to check your funding limits.
                    Payment instructions will appear when pricing is available.
                  </p>
                {:else if zcashOverCapacity}
                  <AlertCircle
                    class="size-10 text-destructive/40"
                    aria-hidden="true"
                  />
                {:else if pricingPreviewBusy}
                  <p role="status" class="text-sm text-muted-foreground">
                    Updating the payment estimate…
                  </p>
                {:else if normalizedPromoDraft !== appliedPromoCode}
                  <p role="status" class="text-sm text-muted-foreground">
                    Apply the code change before sending.
                  </p>
                {:else if !promotionPreviewUsable}
                  <p role="status" class="text-sm text-muted-foreground">
                    Refresh the promotion estimate before sending.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onclick={() => refreshZcashPricing()}
                    >Refresh estimate</Button
                  >
                {:else if !zcashUri}
                  <p role="status" class="text-sm text-destructive">
                    {$t(
                      "dashboard.billing.zcash.paymentRequestUnavailable",
                      "Enter a valid purchase amount. Payment is unavailable unless the required memo can be included.",
                    )}
                  </p>
                {:else if zcashQrDataUrl}
                  <div
                    class="rounded-2xl border-2 border-primary/20 bg-white p-4 shadow-md"
                  >
                    <img
                      src={zcashQrDataUrl}
                      alt={$t(
                        "dashboard.billing.zcash.qrAlt",
                        "Zcash payment QR code",
                      )}
                      class="size-48"
                      aria-describedby="zcash-memo-required"
                    />
                  </div>
                  <p class="text-sm font-medium">
                    {$t(
                      "dashboard.billing.zcash.scanToPay",
                      "Scan to pay with a mobile wallet",
                    )}
                  </p>
                {:else if zcashQrError}
                  <div
                    class="rounded-2xl border border-destructive/20 bg-destructive/10 p-8 text-center text-destructive"
                  >
                    <AlertCircle class="mx-auto mb-2 size-8" />
                    <p class="text-sm">{zcashQrError}</p>
                  </div>
                {:else}
                  <div
                    class="flex size-48 animate-pulse items-center justify-center rounded-2xl bg-muted"
                  >
                    <Wallet class="size-10 text-muted-foreground/30" />
                  </div>
                  <p class="text-sm text-muted-foreground italic">
                    {$t(
                      "dashboard.billing.zcash.generatingQr",
                      "Generating payment QR...",
                    )}
                  </p>
                {/if}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </section>

    <!-- Credit activity Section -->
    <section class="space-y-6">
      <div class="space-y-1">
        <h2 class="text-xl font-semibold tracking-tight">
          {$t("dashboard.billing.details.title", "Credit activity")}
        </h2>
        <p class="text-sm text-muted-foreground">
          {$t(
            "dashboard.billing.details.description",
            "View and manage your subscriptions, subscribers, and card purchases.",
          )}
        </p>
      </div>

      <Tabs bind:value={billingTab} class="space-y-4">
        <TabsList class="h-auto min-h-9 w-full flex-wrap gap-y-1 sm:w-fit">
          <TabsTrigger
            value="subscriptions"
            class="flex flex-1 items-center gap-1.5 text-xs sm:flex-initial sm:gap-2 sm:text-sm"
          >
            <Repeat2 class="hidden size-4 sm:block" />
            <span
              >{$t(
                "dashboard.billing.tabs.subscriptions",
                "Subscriptions",
              )}</span
            >
            {#if subscriptionsCount > 0}
              <Badge
                variant="secondary"
                class="h-5 min-w-5 rounded-full px-1.5 text-[10px]"
                >{formatLocalizedNumber(subscriptionsCount, $locale)}</Badge
              >
            {/if}
          </TabsTrigger>
          <TabsTrigger
            value="subscribers"
            class="flex flex-1 items-center gap-1.5 text-xs sm:flex-initial sm:gap-2 sm:text-sm"
          >
            <Users class="hidden size-4 sm:block" />
            <span
              >{$t("dashboard.billing.tabs.subscribers", "Subscribers")}</span
            >
            {#if subscribersCount > 0}
              <Badge
                variant="secondary"
                class="h-5 min-w-5 rounded-full px-1.5 text-[10px]"
                >{formatLocalizedNumber(subscribersCount, $locale)}</Badge
              >
            {/if}
          </TabsTrigger>
          <TabsTrigger
            value="history"
            class="flex flex-1 items-center gap-1.5 text-xs whitespace-normal sm:flex-initial sm:gap-2 sm:text-sm"
          >
            <History class="hidden size-4 sm:block" />
            <span>{$t("dashboard.billing.tabs.history", "Card purchases")}</span
            >
            {#if transactionsCount > 0}
              <Badge
                variant="secondary"
                class="h-5 min-w-5 rounded-full px-1.5 text-[10px]"
                >{formatLocalizedNumber(transactionsCount, $locale)}</Badge
              >
            {/if}
          </TabsTrigger>
        </TabsList>

        <!-- Subscriptions Tab -->
        <TabsContent value="subscriptions">
          <Card>
            <CardHeader
              class="flex flex-col items-start justify-between gap-3 space-y-0 sm:flex-row sm:items-center"
            >
              <div class="min-w-0 space-y-1">
                <CardTitle
                  >{$t(
                    "dashboard.billing.yourSubscriptions",
                    "Your Subscriptions",
                  )}</CardTitle
                >
                <CardDescription
                  >{$t(
                    "dashboard.billing.yourSubscriptionsDescription",
                    "Creators you support monthly.",
                  )}</CardDescription
                >
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant={subscriptionOrdering === "-max_price"
                    ? "default"
                    : "ghost"}
                  href={pageHref(
                    1,
                    transactionsPage,
                    subscribersPage,
                    "-max_price",
                    subscriberOrdering,
                    "subscriptions",
                  )}
                  class="h-9 px-3 text-[10px] font-bold tracking-wider uppercase sm:h-7 sm:px-2"
                >
                  {$t("dashboard.billing.sort.price", "Price")}
                </Button>
                <Button
                  size="sm"
                  variant={subscriptionOrdering === "expires"
                    ? "default"
                    : "ghost"}
                  href={pageHref(
                    1,
                    transactionsPage,
                    subscribersPage,
                    "expires",
                    subscriberOrdering,
                    "subscriptions",
                  )}
                  class="h-9 px-3 text-[10px] font-bold tracking-wider uppercase sm:h-7 sm:px-2"
                >
                  {$t("dashboard.billing.sort.expiry", "Expiry")}
                </Button>
              </div>
            </CardHeader>
            <CardContent class="space-y-4">
              {#if subscriptions.length === 0}
                <div
                  class="flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-12 text-center"
                >
                  <Repeat2 class="size-10 text-muted-foreground/20" />
                  <p class="text-sm text-muted-foreground">
                    {$t(
                      "dashboard.billing.noSubscriptions",
                      "No active subscriptions found.",
                    )}
                  </p>
                  <Button href="/creators" variant="link" size="sm"
                    >{$t(
                      "dashboard.billing.findCreators",
                      "Find creators to support",
                    )}</Button
                  >
                </div>
              {:else}
                <div class="grid gap-4 md:grid-cols-2">
                  {#each subscriptions as subscription}
                    {@const memberPrice = parsePrice(
                      subscription.star.member_price,
                    )}
                    {@const ceiling = priceCeiling(
                      subscription.star.member_price,
                      subscription.max_price,
                    )}
                    {@const cardState = subscriptionCardState(
                      subscription.expires,
                      ceiling,
                    )}
                    <!--: a deactivated creator stays listed (the row
                         carries the only unsubscribe control) but redacted.
                         Its profile 404s and the ceiling PATCH requires an
                         active creator, so neither is offered: only the
                         named state and Unsubscribe. `=== false`, so an
                         older backend without the field reads as active. -->
                    {@const starInactive =
                      subscription.star?.is_active === false}
                    <!-- Renewal skips an inactive creator (renew_subs'
                         `star__is_active` gate), so never say "Renews". -->
                    {@const starDateState =
                      starInactive && cardState === "active"
                        ? "ending"
                        : cardState}
                    <div
                      class="group space-y-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
                    >
                      <!--
                        `min-w-0` + `shrink-0` + `truncate`, all three: a flex
                        item defaults to `min-width: auto` and refuses to shrink
                        below its content, so at 320px an `@mutation_target`
                        grew the name column until it ran UNDER the state badge.
                        Usernames go to 150 characters.
                      -->
                      <div
                        class="flex min-w-0 items-center justify-between gap-2"
                      >
                        <div class="flex min-w-0 items-center gap-3">
                          <div
                            class="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-sm font-bold text-primary"
                          >
                            {(
                              subscription.star.username?.[0] || "U"
                            ).toUpperCase()}
                          </div>
                          <div class="min-w-0">
                            {#if starInactive}
                              <span
                                class="block min-h-6 truncate text-sm font-bold text-muted-foreground"
                              >
                                @{subscription.star.username}
                              </span>
                            {:else}
                              <a
                                class="block min-h-6 truncate text-sm font-bold transition-colors hover:text-primary"
                                href={`/${subscription.star.username}`}
                              >
                                @{subscription.star.username}
                              </a>
                            {/if}
                            <!-- Issue: never claim a renewal date the
                                 subscription cannot reach. When the ceiling
                                 blocks renewal, say when access ends. -->
                            {#if starDateState !== "unknown"}
                              <p
                                class="mt-0.5 text-[10px] font-bold tracking-wider text-muted-foreground uppercase"
                              >
                                {#if starDateState === "active"}
                                  {$t(
                                    "dashboard.billing.renewsOn",
                                    "Renews {date}",
                                    { date: asDate(subscription.expires) },
                                  )}
                                {:else if starDateState === "ending"}
                                  {$t(
                                    "dashboard.billing.accessEndsOn",
                                    "Access ends {date}",
                                    { date: asDate(subscription.expires) },
                                  )}
                                {:else}
                                  {$t(
                                    "dashboard.billing.accessEndedOn",
                                    "Access ended {date}",
                                    { date: asDate(subscription.expires) },
                                  )}
                                {/if}
                              </p>
                            {/if}
                          </div>
                        </div>
                        <Badge
                          variant={!starInactive && cardState === "active"
                            ? "default"
                            : "secondary"}
                          class="shrink-0 rounded-md px-1.5 py-0 text-[10px] whitespace-nowrap uppercase"
                        >
                          {starInactive
                            ? $t(
                                "dashboard.billing.status.inactive",
                                "Inactive",
                              )
                            : subscriptionStateLabel(cardState)}
                        </Badge>
                      </div>

                      <div class="space-y-2 border-t pt-3">
                        {#if starInactive}
                          <p
                            class="text-[11px] leading-snug text-muted-foreground"
                          >
                            {$t(
                              "dashboard.billing.creatorInactive",
                              "This creator's account is no longer active, so their profile and price are unavailable and your maximum cannot be changed. The subscription does not renew while the account is inactive. Unsubscribe to make sure it never does.",
                            )}
                          </p>
                        {:else}
                          <!-- Issue: the ceiling below is meaningless
                             without the price it is measured against. -->
                          <div
                            class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5"
                          >
                            <span
                              class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase"
                            >
                              {$t(
                                "dashboard.billing.creatorPriceNow",
                                "Creator's price now",
                              )}
                            </span>
                            <span
                              class={cn(
                                "font-mono text-sm font-bold tabular-nums",
                                priceTone(ceiling),
                              )}
                            >
                              {#if memberPrice === null}
                                {$t("dashboard.billing.priceNotSet", "Not set")}
                              {:else if memberPrice === 0}
                                {$t("dashboard.billing.priceFree", "Free")}
                              {:else}
                                {$t(
                                  "dashboard.billing.pricePerMonth",
                                  "{price} 2Z / month",
                                  {
                                    price: formatLocalizedNumber(
                                      memberPrice,
                                      $locale,
                                    ),
                                  },
                                )}
                              {/if}
                            </span>
                          </div>
                          {#if ceiling !== "unknown" && ceiling !== "ok"}
                            <p
                              class={cn(
                                "text-[11px] leading-snug",
                                noticeTone(ceiling),
                              )}
                            >
                              {#if ceiling === "unpriced"}
                                {$t(
                                  "dashboard.billing.creatorPriceUnset",
                                  "This creator has no chargeable price right now, so the subscription cannot renew until they set one.",
                                )}
                              {:else if ceiling === "free"}
                                {$t(
                                  "dashboard.billing.freeMembershipNotice",
                                  "Free membership — it won't renew on its own. Follow again when it ends to keep member access.",
                                )}
                              {:else if ceiling === "cancelled"}
                                {$t(
                                  "dashboard.billing.subscriptionCancelled",
                                  "You cancelled this subscription — it will not renew. Set a maximum at or above the price to restart it.",
                                )}
                              {:else if ceiling === "over"}
                                {$t(
                                  "dashboard.billing.maxOverCreatorPrice",
                                  "This price is above your maximum — your subscription will not renew until you raise it.",
                                )}
                              {:else if ceiling === "at"}
                                {$t(
                                  "dashboard.billing.maxAtCreatorPrice",
                                  "This price is exactly your maximum — any increase will end your subscription.",
                                )}
                              {:else}
                                {$t(
                                  "dashboard.billing.maxNearCreatorPrice",
                                  "Only {headroom} 2Z below your maximum — a small increase will end your subscription.",
                                  {
                                    headroom: formatLocalizedNumber(
                                      (parsePrice(subscription.max_price) ??
                                        0) - (memberPrice ?? 0),
                                      $locale,
                                    ),
                                  },
                                )}
                              {/if}
                            </p>
                          {/if}
                          <form
                            method="POST"
                            action="?/updateSubscription"
                            class="flex items-end gap-2"
                            use:enhance
                          >
                            <input
                              type="hidden"
                              name="starUsername"
                              value={subscription.star.username}
                            />
                            <input
                              type="hidden"
                              name="memberPrice"
                              value={subscription.star.member_price}
                            />
                            <div class="flex-1 space-y-1">
                              <Label
                                for={`max-${subscription.star.username}`}
                                class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase"
                                >{$t(
                                  "dashboard.billing.maxPerMonth",
                                  "Maximum 2Z per month",
                                )}</Label
                              >
                              <Input
                                id={`max-${subscription.star.username}`}
                                name="maxPrice"
                                type="number"
                                min={subscription.star.member_price}
                                max={accountBalance}
                                value={subscriptionMaxDrafts.get(
                                  subscription.star.username,
                                ) ?? subscription.max_price}
                                oninput={(event) => {
                                  subscriptionMaxDrafts = new Map(
                                    subscriptionMaxDrafts,
                                  ).set(
                                    subscription.star.username,
                                    event.currentTarget.value,
                                  );
                                }}
                                required
                                class="h-9 font-mono sm:h-8"
                              />
                            </div>
                            <Button
                              type="submit"
                              variant="outline"
                              size="sm"
                              class="h-9 sm:h-8"
                              >{$t(
                                "dashboard.billing.update",
                                "Update",
                              )}</Button
                            >
                          </form>
                        {/if}

                        <form method="POST" action="?/unsubscribe" use:enhance>
                          <input
                            type="hidden"
                            name="starUsername"
                            value={subscription.star.username}
                          />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            class="h-9 w-full text-xs text-destructive hover:bg-destructive/10 hover:text-destructive sm:h-8"
                          >
                            {$t("dashboard.billing.unsubscribe", "Unsubscribe")}
                          </Button>
                        </form>
                      </div>
                    </div>
                  {/each}
                </div>

                {#if subscriptionsCount > pageSize}
                  {@const subTotalPages = Math.ceil(
                    subscriptionsCount / pageSize,
                  )}
                  <div class="flex items-center justify-center gap-4 pt-4">
                    <Button
                      href={pageHref(
                        Math.max(1, subscriptionsPage - 1),
                        transactionsPage,
                        subscribersPage,
                        subscriptionOrdering,
                        subscriberOrdering,
                        "subscriptions",
                      )}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscriptionsPage <= 1}
                      aria-label={$t("common.search.previous", "Previous")}
                      title={$t("common.search.previous", "Previous")}
                    >
                      <ChevronLeft class="size-4" />
                    </Button>
                    <span class="text-xs font-medium"
                      >{$t(
                        "dashboard.billing.pagination",
                        "Page {current} of {total}",
                        {
                          current: subscriptionsPage.toLocaleString($locale),
                          total: subTotalPages.toLocaleString($locale),
                        },
                      )}</span
                    >
                    <Button
                      href={pageHref(
                        Math.min(subTotalPages, subscriptionsPage + 1),
                        transactionsPage,
                        subscribersPage,
                        subscriptionOrdering,
                        subscriberOrdering,
                        "subscriptions",
                      )}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscriptionsPage >= subTotalPages}
                      aria-label={$t("common.search.next", "Next")}
                      title={$t("common.search.next", "Next")}
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
            <CardHeader
              class="flex flex-col items-start justify-between gap-3 space-y-0 sm:flex-row sm:items-center"
            >
              <div class="min-w-0 space-y-1">
                <CardTitle
                  >{$t(
                    "dashboard.billing.yourSubscribers",
                    "Your Subscribers",
                  )}</CardTitle
                >
                <CardDescription
                  >{$t(
                    "dashboard.billing.yourSubscribersDescription",
                    "People who support you monthly.",
                  )}</CardDescription
                >
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant={subscriberOrdering === "-max_price"
                    ? "default"
                    : "ghost"}
                  href={pageHref(
                    subscriptionsPage,
                    transactionsPage,
                    1,
                    subscriptionOrdering,
                    "-max_price",
                    "subscribers",
                  )}
                  class="h-9 px-3 text-[10px] font-bold tracking-wider uppercase sm:h-7 sm:px-2"
                >
                  {$t("dashboard.billing.sort.price", "Price")}
                </Button>
                <Button
                  size="sm"
                  variant={subscriberOrdering === "expires"
                    ? "default"
                    : "ghost"}
                  href={pageHref(
                    subscriptionsPage,
                    transactionsPage,
                    1,
                    subscriptionOrdering,
                    "expires",
                    "subscribers",
                  )}
                  class="h-9 px-3 text-[10px] font-bold tracking-wider uppercase sm:h-7 sm:px-2"
                >
                  {$t("dashboard.billing.sort.expiry", "Expiry")}
                </Button>
              </div>
            </CardHeader>
            <CardContent class="space-y-4">
              {#if subscribers.length === 0}
                <div
                  class="flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-12 text-center"
                >
                  <Users class="size-10 text-muted-foreground/20" />
                  <p class="text-sm text-muted-foreground">
                    {$t(
                      "dashboard.billing.noSubscribers",
                      "No subscribers found yet.",
                    )}
                  </p>
                </div>
              {:else}
                <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {#each subscribers as subscription}
                    {@const fanUsername =
                      subscription?.fan?.username ||
                      subscription?.star?.username ||
                      "unknown"}
                    {@const maxPrice = parsePrice(subscription.max_price)}
                    <!-- Same serializer as Your Subscriptions, so `star` is
                         you: this fan's ceiling measured against your own
                         price tells you whether they actually renew. -->
                    {@const fanCardState = subscriptionCardState(
                      subscription.expires,
                      priceCeiling(subscription?.star?.member_price, maxPrice),
                    )}
                    <!--, the mirror: a deactivated fan is redacted to
                         a username whose profile 404s. Show that the
                         authorization exists and the account is gone. -->
                    {@const fanInactive =
                      subscription?.fan?.is_active === false}
                    <!-- An inactive fan's outgoing spend is frozen
                         (`renew_subscription`, ): no "Renews" claim. -->
                    {@const fanDateState =
                      fanInactive && fanCardState === "active"
                        ? "ending"
                        : fanCardState}
                    <div
                      class="group space-y-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
                    >
                      <!-- Same min-w-0/shrink-0/truncate triple as Your
                           Subscriptions above; a long fan username ran under
                           the state badge at 320px for the same reason. -->
                      <div
                        class="flex min-w-0 items-center justify-between gap-2"
                      >
                        <div class="flex min-w-0 items-center gap-3">
                          <div
                            class="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-sm font-bold text-primary"
                          >
                            {(fanUsername[0] || "U").toUpperCase()}
                          </div>
                          {#if fanInactive}
                            <span
                              class="block min-h-6 min-w-0 truncate text-sm font-bold text-muted-foreground"
                            >
                              @{fanUsername}
                            </span>
                          {:else}
                            <a
                              class="block min-h-6 min-w-0 truncate text-sm font-bold transition-colors hover:text-primary"
                              href={`/${fanUsername}`}
                            >
                              @{fanUsername}
                            </a>
                          {/if}
                        </div>
                        <Badge
                          variant={!fanInactive && fanCardState === "active"
                            ? "default"
                            : "secondary"}
                          class="shrink-0 rounded-md px-1.5 py-0 text-[10px] whitespace-nowrap uppercase"
                        >
                          {fanInactive
                            ? $t(
                                "dashboard.billing.status.inactive",
                                "Inactive",
                              )
                            : subscriptionStateLabel(fanCardState)}
                        </Badge>
                      </div>
                      <div class="space-y-2 border-t pt-3">
                        {#if fanInactive}
                          <p
                            class="text-[11px] leading-snug text-muted-foreground"
                          >
                            {$t(
                              "dashboard.billing.subscriberInactive",
                              "This subscriber's account is no longer active. Their subscription stays on record but does not renew while the account is inactive.",
                            )}
                          </p>
                        {/if}
                        <div
                          class="flex items-center justify-between text-xs text-muted-foreground"
                        >
                          <span
                            >{$t(
                              "dashboard.billing.maxMonthly",
                              "Maximum monthly",
                            )}</span
                          >
                          <span class="font-mono font-medium text-foreground"
                            >{maxPrice === null
                              ? "—"
                              : `${maxPrice.toLocaleString($locale)} 2Z`}</span
                          >
                        </div>
                        <!-- Fails closed exactly like the fan card: an
                             unreadable ceiling claims no date at all, rather
                             than a definite "Ends {date}" under a badge that
                             says the data could not be read. -->
                        {#if fanDateState !== "unknown"}
                          <div
                            class="flex items-center justify-between text-xs text-muted-foreground"
                          >
                            <span
                              >{#if fanDateState === "active"}{$t(
                                  "dashboard.billing.renews",
                                  "Renews",
                                )}{:else if fanDateState === "expired"}{$t(
                                  "dashboard.billing.ended",
                                  "Ended",
                                )}{:else}{$t(
                                  "dashboard.billing.ends",
                                  "Ends",
                                )}{/if}</span
                            >
                            <span class="font-medium text-foreground"
                              >{asDate(subscription.expires)}</span
                            >
                          </div>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>

                {#if subscribersCount > pageSize}
                  {@const fanTotalPages = Math.ceil(
                    subscribersCount / pageSize,
                  )}
                  <div class="flex items-center justify-center gap-4 pt-4">
                    <Button
                      href={pageHref(
                        subscriptionsPage,
                        transactionsPage,
                        Math.max(1, subscribersPage - 1),
                        subscriptionOrdering,
                        subscriberOrdering,
                        "subscribers",
                      )}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscribersPage <= 1}
                      aria-label={$t("common.search.previous", "Previous")}
                      title={$t("common.search.previous", "Previous")}
                    >
                      <ChevronLeft class="size-4" />
                    </Button>
                    <span class="text-xs font-medium"
                      >{$t(
                        "dashboard.billing.pagination",
                        "Page {current} of {total}",
                        {
                          current: subscribersPage.toLocaleString($locale),
                          total: fanTotalPages.toLocaleString($locale),
                        },
                      )}</span
                    >
                    <Button
                      href={pageHref(
                        subscriptionsPage,
                        transactionsPage,
                        Math.min(fanTotalPages, subscribersPage + 1),
                        subscriptionOrdering,
                        subscriberOrdering,
                        "subscribers",
                      )}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={subscribersPage >= fanTotalPages}
                      aria-label={$t("common.search.next", "Next")}
                      title={$t("common.search.next", "Next")}
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
              <CardTitle
                >{$t(
                  "dashboard.billing.history.title",
                  "Card purchases",
                )}</CardTitle
              >
              <CardDescription
                >{$t(
                  "dashboard.billing.history.description",
                  "Your credit purchases through Stripe.",
                )}</CardDescription
              >
            </CardHeader>
            <CardContent class="space-y-4">
              {#if transactions.length === 0}
                <div
                  class="flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-12 text-center"
                >
                  <History class="size-10 text-muted-foreground/20" />
                  <p class="text-sm text-muted-foreground">
                    {$t(
                      "dashboard.billing.history.empty",
                      "No card purchases to show.",
                    )}
                  </p>
                </div>
              {:else}
                <div class="space-y-2">
                  {#each transactions as transaction}
                    <div
                      class="group flex items-center justify-between gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-primary/50"
                    >
                      <div class="flex items-center gap-3">
                        <div
                          class="flex size-9 items-center justify-center rounded-full bg-primary/10"
                        >
                          <ArrowDownLeft class="size-4 text-primary" />
                        </div>
                        <div>
                          <div class="text-sm font-bold">
                            {asCurrency(transaction.amount)}
                          </div>
                          <div
                            class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase"
                          >
                            {asDate(transaction.timestamp)}
                          </div>
                        </div>
                      </div>
                      <div class="text-right">
                        <div class="text-sm font-bold text-primary">
                          {#if issuedCredits(transaction) !== null}
                            {formatUsageMilli(
                              issuedCredits(transaction)!,
                              $locale,
                            )}
                          {/if}
                        </div>
                        <div
                          class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase"
                        >
                          {#if issuedCredits(transaction) !== null}
                            {$t(
                              "dashboard.billing.history.credited",
                              "Credited",
                            )}
                            {@const allocation = creditedAllocation(
                              transaction,
                              issuedCredits(transaction)!,
                            )}
                            {#if allocation}
                              <p class="text-xs normal-case">
                                {$t("economy.usageAdded")}: {formatUsageMilli(
                                  allocation.added,
                                  $locale,
                                )}
                              </p>
                              <p class="text-xs normal-case">
                                {$t("economy.usageDebtRepaid")}: {formatUsageMilli(
                                  allocation.debtRepaid,
                                  $locale,
                                )}
                              </p>
                            {/if}
                          {:else}
                            {$t(
                              "dashboard.billing.history.issuanceUnavailable",
                              "Issuance status unavailable",
                            )}
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>

                {#if transactionsCount > pageSize}
                  {@const txTotalPages = Math.ceil(
                    transactionsCount / pageSize,
                  )}
                  <div class="flex items-center justify-center gap-4 pt-4">
                    <Button
                      href={pageHref(
                        subscriptionsPage,
                        Math.max(1, transactionsPage - 1),
                        subscribersPage,
                        subscriptionOrdering,
                        subscriberOrdering,
                        "history",
                      )}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={transactionsPage <= 1}
                      aria-label={$t("common.search.previous", "Previous")}
                      title={$t("common.search.previous", "Previous")}
                    >
                      <ChevronLeft class="size-4" />
                    </Button>
                    <span class="text-xs font-medium"
                      >{$t(
                        "dashboard.billing.pagination",
                        "Page {current} of {total}",
                        {
                          current: transactionsPage.toLocaleString($locale),
                          total: txTotalPages.toLocaleString($locale),
                        },
                      )}</span
                    >
                    <Button
                      href={pageHref(
                        subscriptionsPage,
                        Math.min(txTotalPages, transactionsPage + 1),
                        subscribersPage,
                        subscriptionOrdering,
                        subscriberOrdering,
                        "history",
                      )}
                      variant="outline"
                      size="icon"
                      class="size-8"
                      disabled={transactionsPage >= txTotalPages}
                      aria-label={$t("common.search.next", "Next")}
                      title={$t("common.search.next", "Next")}
                    >
                      <ChevronRight class="size-4" />
                    </Button>
                  </div>
                {/if}
              {/if}
            </CardContent>
            <CardFooter class="border-t bg-muted/10 p-4">
              <div class="flex items-start gap-2 text-xs text-muted-foreground">
                <Info class="mt-0.5 size-3.5 shrink-0" />
                <p>
                  {$t(
                    "dashboard.billing.history.zcashNotice",
                    "Zcash purchases and credit sharing are not listed here. Your credit balance updates after a Zcash payment is processed.",
                  )}
                </p>
              </div>
            </CardFooter>
          </Card>
        </TabsContent>
      </Tabs>
    </section>
  </div>
</main>
