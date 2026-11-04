<script lang="ts">
  import { onDestroy } from "svelte";
  import { locale, tStore as t } from "$lib/i18n";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button, buttonVariants } from "$lib/components/ui/button";
  import type { ButtonVariant } from "$lib/components/ui/button";
  import { UserPlus, Check, Star } from "@lucide/svelte";
  import {
    tuzisSubscribeConfirmedCreate,
    tuzisSubscribeRecoveryCreate,
  } from "$lib/api/tuzis/tuzis";
  import {
    clearSubscribeIdempotencyKey,
    isIdempotencyStorageUnavailable,
    isIdempotencyStorageCleanupFailure,
    markSubscribeIdempotencyAbandoned,
    retireSubscribeKeyResolvedByMembership,
    subscribeRecoveryKeys,
    subscribeIdempotencyHeaders,
  } from "$lib/subscribe-idempotency";
  import { authStore } from "$lib/stores/auth";
  import type { CreatorDetail, SimpleCreator } from "$lib/api/f2z.schemas";
  import ManageSubscription from "$lib/components/subscription/ManageSubscription.svelte";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    compareDecimalText,
    formatDecimalText,
    insufficientFundsFromError,
    makeInsufficientFunds,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";

  let {
    creator,
    triggerSize = "default",
    triggerVariant = "default",
    triggerClass = "",
    navigationPending = false,
  }: {
    creator: CreatorDetail | SimpleCreator;
    triggerSize?: "default" | "sm" | "lg";
    triggerVariant?: ButtonVariant;
    triggerClass?: string;
    navigationPending?: boolean;
  } = $props();

  let open = $state(false);
  let isSubmitting = $state(false);
  let isUnconfirmed = $state(false);
  let isIntentConflict = $state(false);
  let isRecoveringIntent = $state(false);
  let recoveryGeneration = 0;
  onDestroy(() => {
    recoveryGeneration += 1;
  });
  let paymentError = $state<{ message: string; generation: number } | null>(
    null,
  );
  $effect(() => {
    if (
      paymentError &&
      paymentError.generation !== $toastPresentation.generation
    )
      paymentError = null;
  });
  function capturePaymentNotice() {
    const requestGeneration = dialogGeneration;
    return captureAccountToast({
      onError: (message) => {
        if (requestGeneration !== dialogGeneration) return;
        paymentError = {
          message: String(message),
          generation: $toastPresentation.generation,
        };
      },
    });
  }
  let insufficientFunds = $state<InsufficientFundsDetails | null>(null);
  let lastFundsInputs = $state<string | null>(null);
  let dialogGeneration = 0;
  let lastContextKey = $state<string | null>(null);
  // The server refused the price this dialog showed (409 price_changed) and
  // told us the current one. It replaces the rendered price so the fan
  // confirms the NEW number; `priceChangedFrom` keeps the old one for the
  // notice. Never retried automatically.
  let currentPrice = $state<string | null>(null);
  let priceChangedFrom = $state<string | null>(null);

  // The zPage route is reused during a client navigation, while this dialog's
  // portal lives under document.body. Close it before the retained component
  // receives the destination article's creator props.
  $effect(() => {
    if (navigationPending) handleOpenChange(false);
  });

  // Route reuse can replace the creator while a purchase is still settling.
  // A generation also protects a close/reopen of the same creator, where the
  // props alone would look identical to the old request.
  $effect(() => {
    const contextKey = `${creator.id}|${creator.username}`;
    if (lastContextKey !== null && lastContextKey !== contextKey) {
      handleOpenChange(false);
    }
    lastContextKey = contextKey;
  });

  let user = $derived($authStore.creator);
  let isSubscribed = $derived(
    user?.star_ids
      ? user.star_ids.includes(creator.id)
      : Boolean(user?.stars?.includes(creator.username)),
  );
  let balance = $derived(user?.tuzis ?? "0");
  let price = $derived(currentPrice ?? creator.member_price ?? "0");
  // 0 is a FREE membership: a free follow that grants member access
  // and moves no 2Z. `member_price` is NOT NULL, so there is no "no
  // membership" state any more; the confirmed route accepts expected_price 0.
  let isFree = $derived(compareDecimalText(price, "0") <= 0);
  let canAfford = $derived(compareDecimalText(balance, price) >= 0);

  $effect(() => {
    const inputs = `${price}:${balance}`;
    if (lastFundsInputs !== null && lastFundsInputs !== inputs) {
      insufficientFunds = null;
      isUnconfirmed = false;
    }
    lastFundsInputs = inputs;
  });

  // An outstanding key is retired the moment the membership is observed to be
  // active — the same resolution a success gives us, arriving by the other
  // route (the "reload and check" the abort copy asks for). Without this the
  // key would have to age out on a clock, and a clock can only ever turn an
  // unresolved purchase back into a chargeable one. See
  // $lib/subscribe-idempotency.
  $effect(() => {
    if (isSubscribed) {
      // The payer is required here, unlike on the success path: an observed
      // membership proves the purchase RESOLVED, not WHO paid, and
      // localStorage is per browser rather than per account. See the helper.
      retireSubscribeKeyResolvedByMembership(
        {
          creatorId: creator.id,
          payerId: user?.id ?? "",
          username: creator.username,
          payerUsername: user?.username,
        },
        user?.id,
      );
    }
  });

  async function handleSubscribe() {
    const operationNotice = capturePaymentNotice();
    if (isSubmitting || isUnconfirmed || isSubscribed) {
      return;
    }

    if (!user) {
      operationNotice.error(
        $t("profile.subscribe.loginRequired", "Please log in to subscribe."),
      );
      return;
    }

    if (!canAfford) {
      insufficientFunds = makeInsufficientFunds(price, balance, "subscription");
      return;
    }

    isSubmitting = true;
    paymentError = null;
    isIntentConflict = false;
    insufficientFunds = null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);

    // Stable per purchase intent and persisted across a reload, so the retry
    // the abort copy below tells the user to make replays the original charge
    // instead of making a second one. orval emits nothing for
    // an `in: header` parameter, so this has to be passed by hand.
    // Both halves in one call: the fresh key to claim under, plus any key
    // this browser had to retire because the server no longer accepts its
    // format, sent as X-Superseded-Idempotency-Key so a receipt already
    // recorded under it replays instead of buying a second month.
    const subscriptionIdentity = {
      creatorId: creator.id,
      payerId: user.id,
      username: creator.username,
      payerUsername: user.username,
    };
    // The amount the fan just confirmed is the amount the server may debit:
    // the price this dialog RENDERED, captured here rather than re-read
    // later. The confirmed route binds the debit to it under the creator's
    // row lock and answers 409 price_changed instead of charging anything
    // else. The legacy POST /subscribe/ sends no price at all and
    // charges whatever the creator's price is by the time it runs.
    const expectedPrice = price;
    const submittedCreatorId = creator.id;
    const submittedCreatorUsername = creator.username;
    const requestGeneration = dialogGeneration;
    priceChangedFrom = null;
    let idempotencyHeaders: Record<string, string> = {};
    let idempotencyKey: string | undefined;

    try {
      idempotencyHeaders = subscribeIdempotencyHeaders(subscriptionIdentity);
      idempotencyKey = idempotencyHeaders["Idempotency-Key"];
      const result = await tuzisSubscribeConfirmedCreate(
        submittedCreatorUsername,
        { expected_price: expectedPrice, creator_id: submittedCreatorId },
        { headers: idempotencyHeaders },
        controller.signal,
      );
      let storageCleanupFailed = false;
      try {
        storageCleanupFailed =
          clearSubscribeIdempotencyKey(subscriptionIdentity, {
            expectedKey: idempotencyKey,
          }) === false;
      } catch (cleanupError) {
        if (
          !isIdempotencyStorageCleanupFailure(cleanupError) &&
          !isIdempotencyStorageUnavailable(cleanupError)
        )
          throw cleanupError;
        storageCleanupFailed = true;
      }
      if (storageCleanupFailed) {
        operationNotice.error(
          $t(
            "payments.storageCleanup",
            "Browser storage could not save this outcome. Check the request's outcome before retrying.",
          ),
        );
      }
      if (!operationNotice.isCurrent()) return;
      const payerStillMatches =
        user?.id === subscriptionIdentity.payerId &&
        user?.username === subscriptionIdentity.payerUsername;
      if (payerStillMatches) {
        authStore.setSubscription(
          submittedCreatorUsername,
          true,
          submittedCreatorId,
        );
      }
      const dialogStillShowsSubmittedCreator =
        requestGeneration === dialogGeneration &&
        creator.id === submittedCreatorId &&
        payerStillMatches;
      if (dialogStillShowsSubmittedCreator) {
        operationNotice.success(
          result.replayed
            ? $t(
                "profile.subscribe.alreadyRecorded",
                "This subscription was already recorded.",
              )
            : $t("profile.subscribe.success", "Subscribed to {username}!", {
                username: submittedCreatorUsername,
              }),
        );
        if (!storageCleanupFailed) handleOpenChange(false);
      } else {
        operationNotice.success(
          result.replayed
            ? $t(
                "profile.subscribe.alreadyRecorded",
                "This subscription was already recorded.",
              )
            : $t("profile.subscribe.success", "Subscribed to {username}!", {
                username: submittedCreatorUsername,
              }),
        );
      }
      void authStore.checkAuth({ force: true, silent: true });
    } catch (e: any) {
      console.error(e);
      if (!operationNotice.isCurrent()) {
        // Financial cleanup still belongs to the original payer; UI belongs to
        // the current account, including an A → B → A transition.
        if (
          e?.data?.code === "subscription_intent_abandoned" ||
          (e?.data?.code === "idempotency_mismatch" && e?.data?.key_resolved)
        ) {
          clearSubscribeIdempotencyKey(subscriptionIdentity, {
            expectedKey: idempotencyKey,
          });
        }
        return;
      }
      if (e?.code === "idempotency_adoption_conflict") {
        isIntentConflict = true;
        operationNotice.error(
          $t(
            "profile.subscribe.intentConflict",
            "A previous subscription request belongs to another account or creator. Resolve it before retrying. This attempt was not sent.",
          ),
        );
        return;
      }
      if (isIdempotencyStorageUnavailable(e)) {
        operationNotice.error(
          $t(
            "profile.subscribe.storageUnavailable",
            "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
          ),
        );
        return;
      }
      if (e?.name === "AbortError") {
        if (requestGeneration === dialogGeneration) {
          isUnconfirmed = true;
        }
        operationNotice.error(
          $t(
            "profile.subscribe.serverUnconfirmed",
            "The server did not confirm the subscription. Check your subscriptions before trying again.",
          ),
        );
        return;
      }
      const code = e?.data?.code;
      if (code === "subscription_intent_abandoned") {
        // Recovery has permanently fenced this key. Retire only the key that
        // the server answered for so a new deliberate purchase can proceed.
        clearSubscribeIdempotencyKey(subscriptionIdentity, {
          key: idempotencyHeaders["Idempotency-Key"],
        });
        isIntentConflict = false;
        isUnconfirmed = false;
        insufficientFunds = null;
        operationNotice.error(
          $t(
            "profile.subscribe.recoveryAbandoned",
            "The previous attempt was closed. You can start a new subscription.",
          ),
        );
        return;
      }
      if (code === "creator_changed") {
        if (requestGeneration === dialogGeneration) {
          isUnconfirmed = true;
        }
        operationNotice.error(
          "The creator changed before this purchase completed. Refresh and review the subscription again.",
        );
        return;
      }
      if (code === "price_changed" && e?.data?.current_price) {
        // Show the new price and require a fresh confirmation. Nothing was
        // charged and the key was released, so the next click is a new
        // confirmation of the NEW number, never a retry of the old one.
        if (requestGeneration === dialogGeneration) {
          priceChangedFrom = expectedPrice;
          currentPrice = String(e.data.current_price);
        }
        operationNotice.error(
          $t(
            "profile.subscribe.priceChanged",
            "The membership price changed from {previous} 2Z to {current} 2Z since this page loaded. Review the new price and confirm again.",
            {
              previous: expectedPrice,
              current: String(e.data.current_price),
            },
          ),
        );
        return;
      }
      if (code === "idempotency_mismatch" && e?.data?.key_resolved) {
        // The server PROVED the request recorded under this key FINISHED and
        // cannot be the one being made now -- another creator's, or a month
        // that has since ended. Keeping the key would answer 409 to every
        // attempt for the receipt's whole 365-day horizon, with no reload
        // able to clear it (codex adversarial review of ). Retire it;
        // the next deliberate click mints a fresh one. Never on a bare
        // mismatch: an unfinished claim may be a charge that is still
        // committing, and a finished receipt for a membership still IN HAND
        // is answered 200 `replayed` instead, never with this flag.
        clearSubscribeIdempotencyKey(subscriptionIdentity, {
          expectedKey: idempotencyKey,
        });
        operationNotice.error(
          $t(
            "profile.subscribe.staleKey",
            "That attempt has already been settled. Try subscribing again.",
          ),
        );
        return;
      }
      if (code === "request_in_progress" || code === "idempotency_mismatch") {
        // The original request under this key is still running, or it
        // completed for a different confirmed price. Either way the answer
        // is "check, do not click again", exactly like the abort path.
        if (requestGeneration === dialogGeneration) {
          isUnconfirmed = true;
        }
        operationNotice.error(
          $t(
            "profile.subscribe.serverUnconfirmed",
            "The server did not confirm the subscription. Check your subscriptions before trying again.",
          ),
        );
        return;
      }
      if (requestGeneration === dialogGeneration) {
        insufficientFunds = insufficientFundsFromError(e);
        if (insufficientFunds) return;
      }
      operationNotice.error(
        e?.data?.error ||
          e?.data?.message ||
          e?.response?.data?.message ||
          $t("profile.subscribe.failed", "Failed to subscribe."),
      );
    } finally {
      window.clearTimeout(timeout);
      // Closing or navigating away changes dialog visibility, not the state
      // of the in-flight purchase. Keep the lock until its request settles so
      // close/reopen cannot submit a second month.
      isSubmitting = false;
    }
  }

  async function handleRecoverIntent() {
    const operationNotice = capturePaymentNotice();
    if (!user || isRecoveringIntent) return;
    isRecoveringIntent = true;
    paymentError = null;
    const identity = {
      creatorId: creator.id,
      payerId: user.id,
      username: creator.username,
      payerUsername: user.username,
    };
    const recoveryCreatorId = creator.id;
    const recoveryCreatorUsername = creator.username;
    const recoveryPrice = price;
    const recoveryPayerId = identity.payerId;
    const recoveryPayerUsername = identity.payerUsername;
    const recoveryGenerationAtStart = recoveryGeneration;
    const recoveryIsCurrent = () =>
      recoveryGeneration === recoveryGenerationAtStart &&
      operationNotice.isCurrent();
    try {
      const keys = subscribeRecoveryKeys(identity);
      if (keys.length === 0) {
        operationNotice.error(
          $t(
            "profile.subscribe.recoveryUnavailable",
            "Sign in to the account that started the previous attempt to resolve it.",
          ),
        );
        return;
      }
      let abandonedAny = false;
      let resolvedAny = false;
      for (const key of keys) {
        if (!recoveryIsCurrent()) return;
        const result = await tuzisSubscribeRecoveryCreate(recoveryCreatorId, {
          key,
          username: recoveryCreatorUsername,
          expected_price: recoveryPrice,
        });
        if (!recoveryIsCurrent()) return;
        if (result.status === "abandoned") {
          markSubscribeIdempotencyAbandoned(identity, key);
          isIntentConflict = false;
          isUnconfirmed = false;
          insufficientFunds = null;
          abandonedAny = true;
          continue;
        }
        if (result.status === "resolved") {
          const reconciled = await authStore.checkAuth({
            force: true,
            silent: true,
            fresh: true,
          });
          if (!recoveryIsCurrent()) return;
          const refreshedUser = $authStore.creator;
          const hasCurrentPayer =
            refreshedUser?.id === recoveryPayerId &&
            refreshedUser?.username === recoveryPayerUsername;
          if (!reconciled || !hasCurrentPayer) {
            isUnconfirmed = true;
            throw new Error(
              $t(
                "profile.subscribe.recoveryFailed",
                "The previous subscription was recorded, but membership could not be confirmed. Check your subscriptions before trying again.",
              ),
            );
          }
          // A resolved receipt may describe a membership that has expired.
          // The refresh reconciles that state; the derived subscription flag
          // decides whether a fresh purchase is allowed.
          let cleanupFailed = false;
          try {
            cleanupFailed =
              clearSubscribeIdempotencyKey(identity, { key }) === false;
          } catch (cleanupError) {
            if (
              !isIdempotencyStorageCleanupFailure(cleanupError) &&
              !isIdempotencyStorageUnavailable(cleanupError)
            )
              throw cleanupError;
            cleanupFailed = true;
          }
          if (cleanupFailed) {
            isUnconfirmed = true;
            operationNotice.error(
              $t(
                "payments.storageCleanup",
                "Browser storage could not save this outcome. Check the request's outcome before retrying.",
              ),
            );
            return;
          }
          isIntentConflict = false;
          isUnconfirmed = false;
          insufficientFunds = null;
          resolvedAny = true;
          void authStore.checkAuth({ force: true, silent: true });
          continue;
        }
        if (result.status === "unchanged") {
          isUnconfirmed = true;
          operationNotice.error(
            $t(
              "profile.subscribe.recoveryUnchanged",
              "The previous attempt is still pending. Check your subscriptions before trying again.",
            ),
          );
          return;
        }
      }
      const remaining = subscribeRecoveryKeys(identity);
      if (remaining.length === 0) {
        isIntentConflict = false;
        isUnconfirmed = false;
        insufficientFunds = null;
        operationNotice.success(
          resolvedAny
            ? $t(
                "profile.subscribe.recoveryResolved",
                "The previous subscription was already recorded.",
              )
            : abandonedAny
              ? $t(
                  "profile.subscribe.recoveryAbandoned",
                  "The previous attempt was closed. You can start a new subscription.",
                )
              : $t(
                  "profile.subscribe.recoveryComplete",
                  "The previous attempt was reconciled.",
                ),
        );
      } else {
        isUnconfirmed = true;
        operationNotice.error(
          $t(
            "profile.subscribe.recoveryRemaining",
            "Resolve each outstanding subscription attempt before starting a new one.",
          ),
        );
      }
    } catch (e: any) {
      operationNotice.error(
        e?.message ||
          $t(
            "profile.subscribe.recoveryFailed",
            "The previous attempt could not be resolved.",
          ),
      );
    } finally {
      isRecoveringIntent = false;
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      paymentError = null;
      dialogGeneration += 1;
      // Closing changes dialog visibility, not the in-flight request lock.
      // These are presentation-only values and must not leak into the next
      // creator's dialog even when the request has not settled yet.
      insufficientFunds = null;
      isUnconfirmed = false;
      isIntentConflict = false;
      currentPrice = null;
      priceChangedFrom = null;
    }
    open = nextOpen;
  }
</script>

{#snippet content()}
  {#if isSubscribed}
    <ManageSubscription {creator} onClose={() => (open = false)} />
  {:else}
    <div
      class="flex flex-col items-center justify-center gap-6 py-2 text-center"
    >
      <div class="rounded-full bg-primary/10 p-3">
        <UserPlus class="size-8 text-primary" />
      </div>

      <div class="space-y-1">
        <h3 class="text-xl font-bold tracking-tight">
          {$t("profile.subscribe.title", "Subscribe to {username}", {
            username: creator.username,
          })}
        </h3>
        <p
          class="mx-auto max-w-[280px] text-sm leading-relaxed text-muted-foreground"
        >
          {$t(
            "profile.subscribe.tagline",
            "Join the inner circle and unlock exclusive perks.",
          )}
        </p>
      </div>

      <!-- Benefits List -->
      <div
        class="w-full max-w-xs space-y-3 rounded-lg border border-border bg-muted/30 p-4 text-left"
      >
        <div class="flex items-center gap-3 text-sm">
          <div class="rounded-full bg-primary/10 p-1">
            <Check class="size-3 text-primary" />
          </div>
          <span class="text-foreground/80"
            >{$t(
              "profile.subscribe.benefitSupport",
              "Support {username} directly",
              { username: creator.username },
            )}</span
          >
        </div>
        <div class="flex items-center gap-3 text-sm">
          <div class="rounded-full bg-primary/10 p-1">
            <Check class="size-3 text-primary" />
          </div>
          <span class="text-foreground/80"
            >{$t(
              "profile.subscribe.benefitPosts",
              "Access subscriber-only posts",
            )}</span
          >
        </div>
        <div class="flex items-center gap-3 text-sm">
          <div class="rounded-full bg-primary/10 p-1">
            <Check class="size-3 text-primary" />
          </div>
          <span class="text-foreground/80"
            >{$t(
              "profile.subscribe.benefitStreams",
              "Access to private broadcast streams",
            )}</span
          >
        </div>
      </div>

      <div class="w-full max-w-xs space-y-4">
        <!-- Price Card -->
        <div class="rounded-lg border border-border p-4">
          <div class="flex flex-col items-center">
            <span
              class="mb-1 text-xs font-medium text-muted-foreground uppercase"
              >{$t("profile.subscribe.monthly", "Monthly Subscription")}</span
            >
            <div class="flex items-baseline gap-1">
              <span
                class="text-2xl font-bold text-foreground"
                data-testid="profile-subscribe-price"
                >{isFree ? $t("profile.subscribe.free", "Free") : price}</span
              >
              {#if !isFree}
                <span class="text-sm font-medium text-muted-foreground">2Z</span
                >
              {/if}
            </div>
            {#if isFree}
              <p class="mt-1 text-xs text-muted-foreground">
                {$t(
                  "profile.subscribe.freeDescription",
                  "Free membership: following gives you member access for 30 days at no cost.",
                )}
              </p>
            {/if}
          </div>
        </div>
        {#if priceChangedFrom !== null}
          <p class="text-xs text-amber-600 dark:text-amber-400" role="alert">
            {$t(
              "profile.subscribe.priceChanged",
              "The membership price changed from {previous} 2Z to {current} 2Z since this page loaded. Review the new price and confirm again.",
              { previous: priceChangedFrom, current: price },
            )}
          </p>
        {/if}

        {#if user}
          <div
            class="flex items-center justify-between px-2 text-xs text-muted-foreground"
          >
            <span>{$t("profile.subscribe.balanceLabel", "Your Balance:")}</span>
            <span
              class="font-mono font-bold {compareDecimalText(balance, price) < 0
                ? 'text-destructive'
                : 'text-foreground'}"
              >{formatDecimalText(balance, $locale)} 2Z</span
            >
          </div>

          {#if !isFree && (!canAfford || insufficientFunds)}
            <InsufficientFunds
              funds={insufficientFunds ??
                makeInsufficientFunds(price, balance, "subscription")}
            />
          {/if}
          {#if isIntentConflict || isUnconfirmed}
            <Button onclick={handleRecoverIntent} disabled={isRecoveringIntent}>
              {isRecoveringIntent
                ? $t("profile.subscribe.resolving", "Resolving...")
                : $t(
                    "profile.subscribe.resolvePrevious",
                    "Resolve previous attempt",
                  )}
            </Button>
            <p class="text-xs text-amber-600 dark:text-amber-400" role="alert">
              {$t(
                "profile.subscribe.resolvePreviousHint",
                "Sign in to the account that started the previous attempt. No payment data is shared with this account.",
              )}
            </p>
          {/if}
          {#if canAfford && !isIntentConflict && !isUnconfirmed}
            <Button
              onclick={handleSubscribe}
              disabled={isSubmitting}
              class="h-11 w-full font-semibold"
              size="lg"
            >
              {#if isSubmitting}
                {$t("profile.subscribe.processing", "Processing...")}
              {:else}
                <div class="flex items-center gap-2">
                  <Star class="size-4 fill-current" />
                  {isFree
                    ? $t("profile.subscribe.followFree", "Follow")
                    : $t("profile.subscribe.confirm", "Confirm Subscription")}
                </div>
              {/if}
            </Button>
          {/if}
          {#if isUnconfirmed}
            <p class="text-xs text-amber-600 dark:text-amber-400" role="alert">
              {$t(
                "profile.subscribe.unconfirmedWarning",
                "Do not retry yet: the server may have completed the charge. Close and reload this page to check your subscription status.",
              )}
            </p>
          {/if}
        {:else}
          <Button
            href="/login"
            variant="default"
            class="h-11 w-full font-semibold"
          >
            {$t("profile.subscribe.loginAction", "Log in to Subscribe")}
          </Button>
        {/if}

        <p class="text-center text-[10px] text-muted-foreground">
          {$t("profile.subscribe.cancelAnytime", "Cancel anytime.")}
        </p>
      </div>
    </div>
  {/if}
{/snippet}

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Trigger
    class={buttonVariants({
      variant: triggerVariant,
      size: triggerSize,
      class: triggerClass,
    })}
  >
    {#if isSubscribed}
      <Check class="size-4" />
      {$t("profile.subscribe.subscribed", "Subscribed")}
    {:else}
      <UserPlus class="size-4" />
      {isFree
        ? $t("profile.subscribe.followFree", "Follow")
        : $t("profile.subscribe.subscribe", "Subscribe")}
    {/if}
  </Dialog.Trigger>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto sm:max-w-[425px]">
    {#if paymentError}
      <p
        role="alert"
        data-testid="payment-outcome-error"
        class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        {paymentError.message}
      </p>
    {/if}
    <Dialog.Header>
      <Dialog.Title class="sr-only">
        {isSubscribed
          ? $t("profile.subscribe.manage", "Manage subscription")
          : $t("profile.subscribe.title", "Subscribe to {username}", {
              username: creator.username,
            })}
      </Dialog.Title>
      <Dialog.Description class="sr-only">
        {isSubscribed
          ? $t("profile.subscribe.manage", "Manage subscription")
          : $t("profile.subscribe.details", "Subscription details")}
      </Dialog.Description>
    </Dialog.Header>
    {@render content()}
  </Dialog.Content>
</Dialog.Root>
