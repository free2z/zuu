<script lang="ts">
  import { createEventDispatcher, onDestroy } from "svelte";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { loginDestination } from "$lib/login-destination";
  import { page } from "$lib/kit-stores";
  import * as env from "$app/env/public";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import { createFirstPartyPreviewResolver } from "$lib/first-party-card-resolver";
  import { Coins, Eye, Info, Loader2, Send, X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { tStore as t } from "$lib/i18n";
  import {
    clearCommentDraft,
    commentDraftKey,
    getDraftStorage,
    readCommentDraft,
    writeCommentDraft,
    DEFAULT_TUZIS,
  } from "$lib/commentDrafts";
  import { CANONICAL_CONTENT_URL_HEADERS } from "$lib/api/canonical-content-url";
  import { apiFetch } from "$lib/api/config";
  import { readApiError } from "$lib/api/api-errors.js";
  import { requestTimeoutMessage } from "$lib/api/request-timeout.js";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import PostingCostNotice from "$lib/components/PostingCostNotice.svelte";
  import {
    cannotCoverMinimumPost,
    introPath,
    insufficientFundsFromResponse,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  import {
    clearIntentIdempotencyKey,
    isIdempotencyStorageUnavailable,
    isIdempotencyStorageCleanupFailure,
    intentIdempotencyKey,
  } from "$lib/subscribe-idempotency";

  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;
  export let parent: string | undefined = undefined;
  export let callback: (() => void) | undefined = undefined;

  let content = "";
  let tuzis = DEFAULT_TUZIS;
  let preview = false;
  let submitting = false;
  let insufficientFunds: InsufficientFundsDetails | null = null;
  let paymentError: { message: string; generation: number } | null = null;
  $: if (
    paymentError &&
    paymentError.generation !== $toastPresentation.generation
  )
    paymentError = null;
  // Said before anyone writes, not after a refused comment. Only for
  // a balance the session actually reported; unknown is not zero.
  $: cannotCoverAComment = cannotCoverMinimumPost($currentUser?.tuzis);
  $: intro = introPath($currentUser);
  let requestKey = "";
  let requestSignature = "";
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  const dispatch = createEventDispatcher();

  // --- draft persistence  -------------------------------------------
  // The form is inside `{#if !$currentUser}`/`{:else}` and the layout
  // revalidates the session constantly (mount, pathname change, window focus,
  // visibilitychange). A transient auth blip - or SvelteKit re-creating the
  // page component - destroys this component and used to take the user's
  // half-typed comment with it. The draft therefore lives in sessionStorage,
  // keyed by what is being commented on, not in the component instance.
  const draftStorage = getDraftStorage();
  let draftKey: string | null = null;
  let draftRestoredFor: string | null = null;

  // Scoped to the signed-in user as well as the target: sessionStorage
  // outlives a logout, and one account must never inherit another's draft
  // (nor its staked 2Z amount) on a shared tab.
  $: draftKey = commentDraftKey({
    username: $currentUser?.username,
    object_type,
    object_uuid,
    parent,
  });

  // Load the draft whenever the key changes, guarded by `draftRestoredFor` so
  // a later reactive run (e.g. `content` changing as the user types) can never
  // re-run and clobber live input.
  //
  // Two distinct transitions, and conflating them is a bug:
  //
  //  - null -> key. The target simply became known (SSR, or the article load
  //    resolving after first paint). Anything already typed belongs to THIS
  //    key, so keep it and only fill the blanks from the stored draft. This is
  //    the  window.
  //
  //  - keyA -> keyB. A different article, a different parent, or a different
  //    account. The text on screen belongs to keyA and must not follow the
  //    user to keyB — that would post one page's comment on another, or hand
  //    account B account A's words and staked 2Z. Swap wholesale to keyB's
  //    own draft (or an empty form).
  $: if (draftKey && draftKey !== draftRestoredFor) {
    const isFirstResolution = draftRestoredFor === null;
    draftRestoredFor = draftKey;
    const draft = readCommentDraft(draftStorage, draftKey);

    if (isFirstResolution) {
      if (draft) {
        if (content.trim() === "") content = draft.content;
        if (tuzis === DEFAULT_TUZIS) tuzis = draft.tuzis;
      }
    } else {
      content = draft?.content ?? "";
      tuzis = draft?.tuzis ?? DEFAULT_TUZIS;
      preview = false;
    }
  }

  // Persist on every change once the key is known and the restore has run.
  // Skipped while submitting so the in-flight reset does not race the write.
  $: if (draftKey && draftKey === draftRestoredFor && !submitting) {
    writeCommentDraft(draftStorage, draftKey, {
      headline: "",
      content,
      tuzis: Number.isFinite(tuzis) ? tuzis : DEFAULT_TUZIS,
    });
  }

  $: canSubmit =
    content.trim().length > 0 &&
    Number.isInteger(tuzis) &&
    tuzis >= 1 &&
    tuzis <= 10000 &&
    !submitting;
  // The composer's preview resolves `::embed[]` cards as its author, only
  // while the preview is open, debounced and cached for this composer.
  const previewCards = createFirstPartyPreviewResolver();
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    previewCards.destroy();
  });
  $: if (preview) {
    previewCards.request(content, "comment", $previewCards.generation);
  }
  $: processedContent = processMarkdown(content, {
    firstPartyCards: $previewCards.cards,
  });

  async function handleSubmit() {
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
    if (!canSubmit) return;

    if (tuzis < 1 || tuzis > 10000 || !Number.isInteger(tuzis)) {
      operationNotice.error(
        $t(
          "comments.tuzisRangeError",
          "Tuzis must be a whole number between 1 and 10000",
        ),
      );
      return;
    }

    const submittedContent = content.trim();
    const submittedTuzis = tuzis;
    const submittedParent = parent;
    const signature = JSON.stringify({
      object_type,
      object_uuid,
      parent: submittedParent,
      content: submittedContent,
      tuzis: submittedTuzis,
    });
    requestSignature = signature;

    let url = "";
    if (object_type && object_uuid) {
      url = `/api/comments/${object_type}/${object_uuid}/`;
    } else if (parent) {
      url = `/api/comments/${parent}/replies/`;
    } else {
      url = "/api/comments/";
    }

    // Set the lock before authentication/CSRF awaits. Svelte does not get a
    // chance to re-render between two click handlers, so this synchronous
    // assignment is the actual double-click guard.
    submitting = true;
    paymentError = null;
    insufficientFunds = null;

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
          $t("comments.loginToComment", "Please log in to comment"),
        );
        submitting = false;
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
      // Do not mint an idempotency key from the pre-hydration null identity.
      // The captured identity also makes cleanup use the same retry bucket if
      // auth state changes while this request is in flight.
      const requestIdentity = {
        actor: $currentUser.username,
        action: "comment",
        resource: url,
        amount: String(submittedTuzis),
        intent: signature,
      };
      requestKey = intentIdempotencyKey(requestIdentity);
      const submittedDraftKey = draftKey;

      // `apiFetch`: CSRF, credentials, and the write bound.
      // A comment the server never answered left "Posting..." up forever.
      const res = await apiFetch(`${apiBase}${url}`, {
        method: "POST",
        headers: {
          ...CANONICAL_CONTENT_URL_HEADERS,
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        // No `headline`: plain comments and replies do not have one,
        // and the backend field is optional (blank=True) as of migration
        // comments.0006. Sending the old "N/A" sentinel surfaced literally in
        // the classic React UI and in auto-tweet image prompts.
        body: JSON.stringify({
          content: submittedContent,
          tuzis: submittedTuzis,
          parent: submittedParent,
        }),
      });

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
        if (funds) {
          retirePaidIntent(requestIdentity, operationNotice);
          return;
        }

        // The server's own sentence, else our copy with the
        // status. `readApiError` never throws and never invents a reason
        // (an HTML proxy page yields "").
        const { message } = await readApiError(res);
        throw new Error(
          message ||
            $t("comments.serverError", "Server error: {status} {statusText}", {
              status: res.status,
              statusText: res.statusText,
            }),
        );
      }

      // The comment is durably on the server now, so the draft is spent.
      const result = await res.json();
      // A retained draft needs its original replay key until its payer reconciles it.
      if (!operationNotice.isCurrent()) return;
      clearCommentDraft(draftStorage, submittedDraftKey);
      retirePaidIntent(requestIdentity, operationNotice);
      content = "";
      tuzis = DEFAULT_TUZIS;
      preview = false;
      requestKey = "";
      requestSignature = "";

      callback?.();
      dispatch("success");
      operationNotice.success(
        result?.replayed
          ? $t(
              "comments.commentAlreadyPosted",
              "This comment was already posted.",
            )
          : $t("comments.commentPosted", "Comment posted!"),
      );
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
      // A timeout keeps `requestKey`, so retrying replays rather than
      // charging twice.
      operationNotice.error(
        requestTimeoutMessage(error) ||
          error?.message ||
          $t("comments.postCommentError", "Failed to post comment"),
      );
    } finally {
      submitting = false;
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

{#if !$currentUser}
  <div
    class={parent
      ? "flex flex-col items-center gap-3 rounded-lg bg-muted/50 px-4 py-4 text-center sm:flex-row sm:text-left"
      : "flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-5 py-5 text-center sm:flex-row sm:px-6 sm:text-left"}
  >
    <div
      class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
    >
      <Coins strokeWidth={1.5} class="size-5" />
    </div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium text-foreground">
        {$t("comments.signInTitle", "Join the conversation")}
      </p>
      <p class="mt-0.5 text-sm text-muted-foreground">
        {$t(
          "comments.loginToCommentWith2Zs",
          "Log in to make a comment with 2Zs!",
        )}
      </p>
    </div>
    <!-- Opens the sign-in modal in place: the article, its scroll
         position and any draft in sessionStorage stay where they are. The
         href is the pre-hydration fallback — the real login page, back here. -->
    <Button
      href={loginDestination($page.url.pathname + $page.url.search)}
      onclick={(e) => {
        e.preventDefault();
        requestLogin({ trigger: e.currentTarget });
      }}
      variant="outline"
      size="sm"
      class="w-full sm:w-auto"
      data-testid="comment-login-prompt"
    >
      {$t("comments.signIn", "Log in")}
    </Button>
  </div>
{:else}
  <div
    class={parent
      ? "overflow-hidden rounded-lg bg-muted/40"
      : "overflow-hidden rounded-xl border border-border bg-card shadow-xs"}
  >
    {#if !parent}
      <div
        class="flex items-center justify-between gap-3 border-b border-border/70 px-3 py-2.5 sm:px-4"
      >
        <span class="text-sm font-semibold tracking-tight text-foreground">
          {$t("comments.joinDiscussion", "Join the discussion")}
        </span>
        <span class="hidden text-xs text-muted-foreground sm:inline">
          {$t("comments.markdownSupported", "Markdown supported")}
        </span>
      </div>
    {/if}

    <div class="space-y-3 p-3 sm:p-4">
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
        <InsufficientFunds
          funds={insufficientFunds}
          introHref={intro.href}
          introWritten={intro.written}
        />
      {:else if cannotCoverAComment}
        <PostingCostNotice balance={String($currentUser?.tuzis)} {intro} />
      {/if}
      <div class="relative">
        <label
          for={parent ? `reply-${parent}` : "comment-content"}
          class="sr-only"
        >
          {$t("comments.content", "Content")}
        </label>
        <Textarea
          id={parent ? `reply-${parent}` : "comment-content"}
          bind:value={content}
          placeholder={parent
            ? $t("comments.replyPlaceholder", "Write a thoughtful reply…")
            : $t(
                "comments.contentPlaceholder",
                "Write your comment (Markdown supported)...",
              )}
          class="max-h-[400px] min-h-[112px] resize-y overflow-y-auto bg-background pb-7 sm:min-h-[128px]"
          maxlength={1000}
        />
        <div
          class="pointer-events-none absolute right-3 bottom-2 text-xs tabular-nums {content.length >=
          1000
            ? 'text-destructive'
            : 'text-muted-foreground'}"
        >
          {content.length}/1000
        </div>
      </div>

      {#if preview && content.trim()}
        <div
          class="prose prose-sm max-w-none rounded-lg bg-muted/50 p-4 text-foreground dark:prose-invert"
        >
          <MarkdownContent html={processedContent} />
        </div>
      {/if}

      <div
        class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex max-w-full items-center gap-2 self-start">
          <Button
            variant="ghost"
            size="icon-sm"
            class="shrink-0 text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
            onclick={() => (preview = !preview)}
            aria-label={$t("comments.togglePreview", "Toggle Preview")}
            aria-pressed={preview}
            title={$t("comments.togglePreview", "Toggle Preview")}
          >
            {#if preview}
              <X strokeWidth={1.5} class="size-4" />
            {:else}
              <Eye strokeWidth={1.5} class="size-4" />
            {/if}
          </Button>

          <div
            class="flex h-9 min-w-0 items-center gap-1.5 rounded-lg border border-input bg-background pr-2 pl-3 transition-colors focus-within:border-ring"
          >
            <span class="shrink-0 text-xs font-medium text-muted-foreground">
              {$t("comments.backWith", "Back with")}
            </span>
            <Input
              type="number"
              bind:value={tuzis}
              min="1"
              max="10000"
              step="1"
              aria-label={$t("comments.weight", "Weight:")}
              class="h-full w-10 [appearance:textfield] border-none bg-transparent! px-0 py-0 text-center text-sm font-semibold tabular-nums shadow-none focus-visible:ring-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span class="shrink-0 text-xs font-semibold text-primary">2Zs</span>

            <Tooltip.Provider delayDuration={150}>
              <Tooltip.Root>
                <Tooltip.Trigger
                  type="button"
                  aria-label={$t(
                    "comments.weightInfoLabel",
                    "What does this do?",
                  )}
                  class="ml-0.5 inline-flex shrink-0 cursor-help items-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <Info strokeWidth={1.5} class="size-3.5" />
                </Tooltip.Trigger>
                <Tooltip.Content side="top" sideOffset={8} class="max-w-64">
                  {$t(
                    "comments.weightTooltip",
                    "The 2Zs you add to your comment. The more you add, the higher it shows up for everyone.",
                  )}
                </Tooltip.Content>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
        </div>

        <Button
          class="w-full sm:w-auto"
          onclick={handleSubmit}
          disabled={!canSubmit}
        >
          {#if submitting}
            <Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
            <span>{$t("comments.posting", "Posting...")}</span>
          {:else}
            <Send strokeWidth={1.5} class="size-4" />
            <span>{$t("comments.post", "Post")}</span>
          {/if}
        </Button>
      </div>
    </div>
  </div>
{/if}
