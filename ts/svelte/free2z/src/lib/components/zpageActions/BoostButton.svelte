<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Zap } from "@lucide/svelte";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { zpageFundCreate } from "$lib/api/zpage/zpage";
  import { ApiError } from "$lib/api/mutator";
  import UnifiedAuthModal from "$lib/components/auth/UnifiedAuthModal.svelte";
  import { Button } from "$lib/components/ui/button";
  import type { ButtonVariant } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    insufficientFundsFromError,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  import {
    clearIntentIdempotencyKey,
    isIdempotencyStorageUnavailable,
    isIdempotencyStorageCleanupFailure,
    intentIdempotencyKey,
  } from "$lib/subscribe-idempotency";

  let {
    pageId = null,
    score = null,
    showLabel = false,
    buttonClass = "",
    buttonVariant = "outline",
    onScoreChange = () => {},
    presentOutcomeInline = true,
    onPaymentOutcome,
  }: {
    pageId?: string | null;
    score?: number | string | null;
    showLabel?: boolean;
    buttonClass?: string;
    buttonVariant?: ButtonVariant;
    presentOutcomeInline?: boolean;
    onPaymentOutcome?: (outcome: {
      pageId: string | null;
      generation: number;
      message: string | null;
      funds: InsufficientFundsDetails | null;
    }) => void;
    onScoreChange?: (
      score: string,
      pageId: string,
      phase?: "pending" | "authoritative",
    ) => void;
  } = $props();

  function scoreText(value: unknown): string | null {
    const candidate =
      value !== null && typeof value === "object" && "f2z_score" in value
        ? (value as { f2z_score?: unknown }).f2z_score
        : value !== null && typeof value === "object" && "score" in value
          ? (value as { score?: unknown }).score
          : value;

    if (typeof candidate !== "number" && typeof candidate !== "string") {
      return null;
    }
    if (typeof candidate === "string" && !candidate.trim()) return null;

    const text = String(candidate).trim();
    return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : null;
  }

  function formatScore(value: string | number): string {
    // Scores are a display metric, not a balance: keep the compact notation
    // used by the page hero while retaining the raw decimal text in state.
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(number);
  }

  let localScore = $state(scoreText(score) ?? "0");
  let submitting = $state(false);
  let blocked = $state(false);
  let showAuthModal = $state(false);
  let insufficientFunds = $state<InsufficientFundsDetails | null>(null);
  let fundsOwner = $state<{ pageId: string; generation: number } | null>(null);
  let paymentError = $state<{
    message: string;
    generation: number;
    pageId: string | null;
  } | null>(null);
  $effect(() => {
    const generation = $toastPresentation.generation;
    if (
      paymentError &&
      (paymentError.generation !== generation || paymentError.pageId !== pageId)
    )
      paymentError = null;
    if (
      fundsOwner &&
      (fundsOwner.generation !== generation || fundsOwner.pageId !== pageId)
    ) {
      insufficientFunds = null;
      fundsOwner = null;
    }
  });
  $effect(() => {
    const generation = $toastPresentation.generation;
    const ownedError =
      paymentError?.generation === generation && paymentError.pageId === pageId
        ? paymentError.message
        : null;
    const ownedFunds =
      fundsOwner?.generation === generation && fundsOwner.pageId === pageId
        ? insufficientFunds
        : null;
    const publish = onPaymentOutcome;
    const outcome = {
      pageId,
      generation,
      message: ownedError,
      funds: ownedFunds,
    };
    if (publish) untrack(() => publish(outcome));
  });
  let requestKey = "";
  let requestPageId = "";
  let unblockTimer: ReturnType<typeof setTimeout> | undefined;

  // Keep the button synchronized with the route-owned authoritative score.
  $effect(() => {
    const nextScore = scoreText(score);
    if (nextScore !== null) localScore = nextScore;
  });

  async function doBoost() {
    const preflightActor = $currentUser?.id ?? $currentUser?.username;
    const authenticationOwner = authStore.captureRequestOwnership();
    let requestOwnership = authenticationOwner;
    const ownsPreflight =
      preflightActor !== undefined ? authenticationOwner : () => true;
    let operationNotice = captureAccountToast({
      onError: (message) => {
        paymentError = {
          message: String(message),
          generation: $toastPresentation.generation,
          pageId,
        };
      },
    });
    if (!pageId || blocked || submitting) return;
    const mutationPageId = pageId;
    insufficientFunds = null;
    fundsOwner = null;
    // Lock before the async auth check so rapid clicks cannot start two boosts.
    submitting = true;
    paymentError = null;

    try {
      const authenticated = await authStore.ensureAuthenticated();
      if (destroyed) return;
      if (!ownsPreflight()) {
        if (!destroyed && authenticationOwner.wasExpired?.()) {
          if (pageId === mutationPageId) showAuthModal = true;
          operationNotice.error(
            $t("economy.signInAgain", "Sign in again before continuing."),
          );
        }
        return;
      }
      if (!authenticated || !$currentUser) {
        showAuthModal = true;
        return;
      }
      requestOwnership = authStore.captureRequestOwnership();
      operationNotice = captureAccountToast({
        onError: (message) => {
          paymentError = {
            message: String(message),
            generation: $toastPresentation.generation,
            pageId: mutationPageId,
          };
        },
      });
      // Capture the resolved actor for both key derivation and retirement.
      // During hydration, a fallback actor would create a different retry
      // bucket from the authenticated request.
      const requestIdentity = {
        actor: $currentUser.username,
        action: "page_fund",
        resource: mutationPageId,
        amount: "2",
        intent: "boost",
      };
      requestKey = intentIdempotencyKey(requestIdentity);
      requestPageId = mutationPageId;

      // The server applies score multipliers, so keep the current score
      // visible until its authoritative value returns. This also clears a
      // prior live announcement without inventing a local increment.
      onScoreChange?.(localScore, mutationPageId, "pending");
      blocked = true;
      unblockTimer = setTimeout(() => (blocked = false), 900);

      const data: unknown = await zpageFundCreate(
        { id: mutationPageId, amount: 2 },
        { headers: { "Idempotency-Key": requestKey } },
      );

      const serverScore = scoreText(data);
      if (serverScore === null) {
        throw new Error(
          $t("pageActions.boost.invalidResponse", "Boost response was invalid"),
        );
      }
      // A route can be reused for another zPage while the request is pending.
      // Do not let an old response update the new page's controls.
      if (pageId !== mutationPageId || !operationNotice.isCurrent()) return;
      retirePaidIntent(requestIdentity, operationNotice);

      localScore = serverScore;
      onScoreChange?.(serverScore, mutationPageId, "authoritative");

      operationNotice.success(
        data !== null &&
          typeof data === "object" &&
          "replayed" in data &&
          (data as { replayed?: unknown }).replayed === true
          ? $t(
              "pageActions.boost.alreadyRecorded",
              "This boost was already recorded.",
            )
          : $t("pageActions.boost.success", "Thanks for the boost!"),
      );
    } catch (error: unknown) {
      if (isIdempotencyStorageUnavailable(error)) {
        operationNotice.error(
          $t(
            "payments.storageUnavailable",
            "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
          ),
        );
        return;
      }
      if (destroyed || pageId !== mutationPageId) return;
      if (!operationNotice.isCurrent()) {
        if (requestOwnership.wasExpired?.())
          operationNotice.error(
            $t("economy.signInAgain", "Sign in again before continuing."),
          );
        return;
      }
      const payload = error instanceof ApiError ? error.data : null;
      const authenticationFailed =
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403);
      if (authenticationFailed && !requestOwnership.wasExpired?.()) return;
      const message =
        (authenticationFailed
          ? $t(
              "pageActions.boost.loginRequired",
              "Please log in to boost this page",
            )
          : null) ||
        payload?.error ||
        payload?.message ||
        payload?.detail ||
        (typeof payload === "string" ? payload : null) ||
        (error instanceof Error ? error.message : null) ||
        $t("pageActions.boost.error", "Boost failed");
      insufficientFunds = insufficientFundsFromError(error);
      fundsOwner = insufficientFunds
        ? { pageId: mutationPageId, generation: $toastPresentation.generation }
        : null;
      if (insufficientFunds) return;
      operationNotice.error(message);
    } finally {
      submitting = false;
    }
  }

  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    if (unblockTimer) clearTimeout(unblockTimer);
  });

  function retirePaidIntent(
    identity: Parameters<typeof clearIntentIdempotencyKey>[0],
    notice: ReturnType<typeof captureAccountToast>,
  ) {
    try {
      clearIntentIdempotencyKey(identity);
    } catch (error) {
      if (!isIdempotencyStorageCleanupFailure(error)) throw error;
      notice.error(
        $t(
          "payments.storageCleanup",
          "Browser storage could not save this outcome. Check the request's outcome before retrying.",
        ),
      );
    }
  }
</script>

<Button
  variant={buttonVariant}
  class={`gap-2 ${buttonClass}`}
  onclick={doBoost}
  disabled={submitting || blocked}
  aria-busy={submitting}
  aria-label={$t("pageActions.boost.label", "Boost this page with 2Z")}
  title={$t("pageActions.boost.label", "Boost this page with 2Z")}
>
  <Zap class="size-4 shrink-0" strokeWidth={1.75} />
  {#if showLabel}
    <span>{$t("pageActions.actions.boost", "Boost · 2Z")}</span>
  {/if}
  <span
    data-testid="boost-score"
    class="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-xs font-bold text-primary tabular-nums"
    aria-label={`${$t("pageActions.boost.score", "Score")}: ${formatScore(localScore)}`}
  >
    {formatScore(localScore)}
  </span>
</Button>

{#if paymentError && presentOutcomeInline}
  <p
    role="alert"
    data-testid="payment-outcome-error"
    class="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
  >
    {paymentError.message}
  </p>
{/if}
{#if insufficientFunds && presentOutcomeInline}
  <InsufficientFunds funds={insufficientFunds} introHref="/edit" />
{/if}

<UnifiedAuthModal bind:open={showAuthModal} />
