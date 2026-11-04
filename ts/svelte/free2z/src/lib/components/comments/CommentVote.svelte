<script lang="ts">
  import { ThumbsDown, ThumbsUp } from "@lucide/svelte";
  import { onDestroy } from "svelte";
  import { authStore, currentUser } from "$lib/stores/auth";
  import * as env from "$app/env/public";
  import { apiFetch } from "$lib/api/config";
  import { readApiError } from "$lib/api/api-errors.js";
  import { requestTimeoutMessage } from "$lib/api/request-timeout.js";
  import type { CommentData } from "./types";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import { formatLocalizedNumber, locale, tStore as t } from "$lib/i18n";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import {
    insufficientFundsFromResponse,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  import {
    clearIntentIdempotencyKey,
    isIdempotencyStorageUnavailable,
    isIdempotencyStorageCleanupFailure,
    intentIdempotencyKey,
  } from "$lib/subscribe-idempotency";

  export let comment: CommentData;

  let tuzis = comment.tuzis;
  let pulsing: "up" | "down" | false = false;
  let voting = false;
  let insufficientFunds: InsufficientFundsDetails | null = null;
  let paymentError: { message: string; generation: number } | null = null;
  $: if (
    paymentError &&
    paymentError.generation !== $toastPresentation.generation
  )
    paymentError = null;
  let requestKey = "";
  let requestVote: "up" | "down" | null = null;
  let pulseTimeout: ReturnType<typeof setTimeout> | undefined;
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  $: tuzis = comment.tuzis;

  function applyFallbackVote(voteType: "up" | "down") {
    tuzis += voteType === "up" ? 1 : -1;
  }

  async function applyVoteResponse(
    res: Response,
    voteType: "up" | "down",
    isCurrent: () => boolean = () => true,
  ) {
    const text = await res.text();
    if (!isCurrent()) return;
    if (!text) {
      applyFallbackVote(voteType);
      return;
    }

    try {
      const data = JSON.parse(text);
      const nextTuzis =
        data?.tuzis === undefined || data?.tuzis === null
          ? NaN
          : Number(data.tuzis);
      if (Number.isFinite(nextTuzis)) {
        tuzis = nextTuzis;
        return;
      }
    } catch (error) {
      console.error("Error parsing vote response:", error);
    }

    applyFallbackVote(voteType);
  }

  function schedulePulseEnd() {
    if (pulseTimeout) clearTimeout(pulseTimeout);
    pulseTimeout = setTimeout(() => {
      pulsing = false;
      pulseTimeout = undefined;
    }, 450);
  }

  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    if (pulseTimeout) clearTimeout(pulseTimeout);
  });

  async function getVoteErrorMessage(res: Response): Promise<string> {
    const serverError = $t(
      "comments.serverError",
      "Server error: {status} {statusText}",
      {
        status: res.status,
        statusText: res.statusText,
      },
    );

    // The server's own sentence; never throws.
    const { message } = await readApiError(res);
    return message || serverError;
  }

  async function handleVote(voteType: "up" | "down") {
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
        };
      },
    });
    if (voting) return;
    // Lock synchronously, before auth/CSRF awaits. A disabled button only
    // updates after this handler yields, so it cannot be the first guard.
    voting = true;
    paymentError = null;
    requestVote = voteType;
    insufficientFunds = null;
    if (pulseTimeout) clearTimeout(pulseTimeout);
    pulsing = voteType;

    try {
      const hasActiveSession = await authStore.ensureAuthenticated();
      if (destroyed) return;
      if (!ownsPreflight()) {
        if (!destroyed && authenticationOwner.wasExpired?.()) {
          operationNotice.error(
            $t("economy.signInAgain", "Sign in again before continuing."),
          );
        }
        return;
      }
      if (!hasActiveSession || !$currentUser) {
        operationNotice.error(
          $t("comments.loginToVote", "Please log in to vote"),
        );
        return;
      }
      requestOwnership = authStore.captureRequestOwnership();
      operationNotice = captureAccountToast({
        onError: (message) => {
          paymentError = {
            message: String(message),
            generation: $toastPresentation.generation,
          };
        },
      });
      // The actor is deliberately captured only after authentication has
      // resolved. During hydration `$currentUser` is null, and an idempotency
      // key minted for a fallback actor would be a different retry bucket.
      const requestIdentity = {
        actor: $currentUser.username,
        action: "comment_vote",
        resource: comment.uuid,
        amount: "1",
        intent: voteType,
      };
      requestKey = intentIdempotencyKey(requestIdentity);
      // `apiFetch`: CSRF, credentials, and the write bound.
      const res = await apiFetch(
        `${apiBase}/api/comments/${comment.uuid}/vote/`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestKey,
          },
          body: JSON.stringify({ vote: voteType }),
        },
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          if (requestOwnership()) authStore.handleAuthFailure(res.status);
          if (!destroyed && requestOwnership.wasExpired?.())
            operationNotice.error(
              $t("economy.signInAgain", "Sign in again before continuing."),
            );
          return;
        }
        const funds = await insufficientFundsFromResponse(res);
        if (operationNotice.isCurrent()) insufficientFunds = funds;
        if (funds) return;
        operationNotice.error(await getVoteErrorMessage(res));
        return;
      }

      await applyVoteResponse(res, voteType, operationNotice.isCurrent);
      if (!operationNotice.isCurrent()) return;
      retirePaidIntent(requestIdentity, operationNotice);
      requestVote = null;
    } catch (error: any) {
      if (isIdempotencyStorageUnavailable(error)) {
        operationNotice.error(
          $t(
            "payments.storageUnavailable",
            "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
          ),
        );
        return;
      }
      console.error(error);
      operationNotice.error(
        requestTimeoutMessage(error) ||
          $t("comments.voteFailed", "Vote failed"),
      );
    } finally {
      voting = false;
      schedulePulseEnd();
    }
  }

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

<div
  class="-ml-1.5 inline-flex items-center"
  role="group"
  aria-label={$t("comments.voteWeight", "Comment weight in 2Z")}
>
  <button
    type="button"
    onclick={() => handleVote("up")}
    disabled={voting}
    aria-label={$t("comments.upvote", "Upvote")}
    class="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
  >
    <ThumbsUp
      strokeWidth={1.5}
      class="size-4 transition-transform duration-200 motion-reduce:transition-none {pulsing ===
      'up'
        ? 'text-primary motion-safe:-translate-y-0.5 motion-safe:scale-110'
        : ''}"
    />
  </button>

  <span
    class="flex items-baseline gap-0.5 px-0.5 transition-transform duration-200 motion-reduce:transition-none {pulsing
      ? 'motion-safe:scale-110'
      : ''}"
    aria-live="polite"
  >
    <span
      class="min-w-[1.5ch] text-center text-sm font-bold tabular-nums {tuzis > 0
        ? 'text-primary'
        : 'text-foreground'}"
    >
      {formatLocalizedNumber(tuzis, $locale)}
    </span>
    <span class="text-[10px] font-medium text-muted-foreground">2Z</span>
  </span>

  <button
    type="button"
    onclick={() => handleVote("down")}
    disabled={voting}
    aria-label={$t("comments.downvote", "Downvote")}
    class="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
  >
    <ThumbsDown
      strokeWidth={1.5}
      class="size-4 transition-transform duration-200 motion-reduce:transition-none {pulsing ===
      'down'
        ? 'text-foreground motion-safe:translate-y-0.5 motion-safe:scale-110'
        : ''}"
    />
  </button>
</div>

{#if paymentError}
  <p
    role="alert"
    data-testid="payment-outcome-error"
    class="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
  >
    {paymentError.message}
  </p>
{/if}
{#if insufficientFunds}
  <InsufficientFunds funds={insufficientFunds} introHref="/edit" />
{/if}
