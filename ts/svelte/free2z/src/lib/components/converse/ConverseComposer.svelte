<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import * as env from "$app/env/public";
  import { page } from "$lib/kit-stores";
  import { authStatus, authStore, currentUser } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { loginDestination } from "$lib/login-destination";
  import { processMarkdown } from "$lib/utils/markdown";
  import { createFirstPartyPreviewResolver } from "$lib/first-party-card-resolver";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import {
    Coins,
    Eye,
    ImagePlus,
    Loader2,
    Plus,
    Send,
    Video,
  } from "@lucide/svelte";
  import {
    formatLocalizedNumber,
    getCurrentLocale,
    isSingularCount,
    locale,
    tStore as t,
  } from "$lib/i18n";
  import EditorFloatingToolbar from "$lib/components/mdEditor/EditorFloatingToolbar.svelte";
  import EditorImagePicker from "$lib/components/mdEditor/EditorImagePicker.svelte";
  import EditorMentionMenu from "$lib/components/mdEditor/EditorMentionMenu.svelte";
  import EditorSlashMenu from "$lib/components/mdEditor/EditorSlashMenu.svelte";
  import {
    referencesUploadToken,
    stripUploadTokens,
  } from "$lib/components/mdEditor/inlineUploads";
  import type { CommentThreadAccess } from "$lib/components/comments/types";
  import { MarkdownTextareaController } from "$lib/components/mdEditor/markdownTextarea.svelte";
  import { detectMacPlatform } from "$lib/components/mdEditor/shortcuts";
  import { createConverseSlashCommands } from "$lib/components/mdEditor/slashCommands";
  import { CANONICAL_CONTENT_URL_HEADERS } from "$lib/api/canonical-content-url";
  import { apiFetch } from "$lib/api/config";
  import { readApiError } from "$lib/api/api-errors.js";
  import { requestTimeoutMessage } from "$lib/api/request-timeout.js";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import PostingCostNotice from "$lib/components/PostingCostNotice.svelte";
  import ConverseComposerFooter from "./ConverseComposerFooter.svelte";
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

  interface Props {
    parent?: string;
    /** `null` means this reply is in a standalone Converse thread. */
    parentContentUrl?: string | null;
    /**
     * The PARENT comment's access tier, exactly as the API sent it — how a
     * reply knows what media its thread may contain.
     *
     * A reply inherits its parent's `content_type`/`object_id`
     * (`ParentCommentListCreateAPIView.perform_create`), so every comment in a
     * thread shares its root's attachment, and `comments/visibility.py` makes
     * it exactly as visible as that root. A missing value is unknown and
     * fails closed.
     *
     * `private` also covers drafts, AI conversations and parent types without
     * an explicit media policy.
     */
    threadAccess?: CommentThreadAccess;
    /** Owner whose subscriber audience authorizes a members-tier image. */
    threadAccessOwnerId?: number | null;
    compact?: boolean;
    /** Flat mobile presentation for the top-level creation drawer only. */
    mobileDrawer?: boolean;
  }

  let {
    parent = undefined,
    parentContentUrl = undefined,
    threadAccess = undefined,
    threadAccessOwnerId = undefined,
    compact = false,
    mobileDrawer = false,
  }: Props = $props();

  const drawerPresentation = $derived(mobileDrawer && !parent && !compact);

  type ConverseMediaSlot =
    | { slot: "post"; subscriberOnly?: boolean }
    | {
        slot: "body";
        subscriberOnly: boolean;
        localUploadsAllowed?: boolean;
      };

  const hasParentContentUrl = $derived(
    typeof parentContentUrl === "string" && parentContentUrl.trim().length > 0,
  );
  let currentThreadAccess = $state<CommentThreadAccess | undefined>(
    threadAccess,
  );
  let currentThreadAccessOwnerId = $state<number | null | undefined>(
    threadAccessOwnerId,
  );
  $effect(() => {
    currentThreadAccess = threadAccess;
    currentThreadAccessOwnerId = threadAccessOwnerId;
  });

  const membersMediaOwnerMatches = $derived(
    typeof currentThreadAccessOwnerId === "number" &&
      $currentUser?.id === currentThreadAccessOwnerId,
  );

  /**
   * Which images this composer may add.
   *
   * A root post is public to everyone and uses the public-only `post` slot. A
   * reply in a standalone thread is also a `post`; a zPage reply uses the
   * thread's access tier: public and members threads use the `body` slot,
   * while private, contradictory and unknown metadata gets no slot at all.
   * Uploads become public as soon as they land, so guessing would publish
   * paid or private media.
   */
  const mediaSlot = $derived<ConverseMediaSlot | null>(
    !parent
      ? { slot: "post" }
      : parentContentUrl === null && currentThreadAccess === "public"
        ? { slot: "post" }
        : hasParentContentUrl && currentThreadAccess === "public"
          ? { slot: "body", subscriberOnly: false }
          : hasParentContentUrl && currentThreadAccess === "members"
            ? {
                slot: "body",
                subscriberOnly: membersMediaOwnerMatches,
                localUploadsAllowed: false,
              }
            : null,
  );
  // One composer per open reply can be on `/converse` at once, so the command
  // menu's ids are per instance.
  const uid = $props.id();
  const commandMenuId = `converse-command-menu-${uid}`;

  const dispatch = createEventDispatcher();
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  const THREAD_MEDIA_ACCESS_TIMEOUT_MS = 8_000;
  let threadAccessCheckId = 0;
  let threadAccessCheckController: AbortController | null = null;

  /**
   * `thread_access` arrives with the feed post, so it can be stale while a
   * reply stays open. Refresh it at each image insertion boundary: local
   * uploads become public immediately, and a tier change must fail closed.
   */
  async function refreshThreadMediaAccess() {
    if (!parent) return true;
    if (destroyed) return false;

    const checkId = ++threadAccessCheckId;
    threadAccessCheckController?.abort();
    const controller = new AbortController();
    threadAccessCheckController = controller;

    try {
      const response = await apiFetch(
        `${apiBase}/api/comments/${encodeURIComponent(parent)}/`,
        {
          signal: controller.signal,
          timeoutMs: THREAD_MEDIA_ACCESS_TIMEOUT_MS,
        },
      );
      if (destroyed || checkId !== threadAccessCheckId) return false;
      if (!response.ok) return false;

      const comment = (await response.json()) as {
        thread_access?: CommentThreadAccess;
        thread_access_owner_id?: number | null;
      };
      if (
        comment.thread_access !== "public" &&
        comment.thread_access !== "members" &&
        comment.thread_access !== "private"
      ) {
        return false;
      }

      currentThreadAccess = comment.thread_access;
      currentThreadAccessOwnerId = comment.thread_access_owner_id ?? null;
      return true;
    } catch {
      return false;
    } finally {
      if (checkId === threadAccessCheckId) {
        threadAccessCheckController = null;
      }
    }
  }

  const MAX_CONTENT = 1000;
  // The counter is a limit warning, not a scoreboard. A permanent "0/1,000"
  // sitting under an empty box is noise on every visit; what a writer actually
  // needs is notice as they approach the wall. Sighted users get it inside the
  // last 20%, screen-reader users get the exact count at all times from the
  // sr-only text below (which is the only accessible copy either way).
  const COUNTER_VISIBLE_FROM = Math.round(MAX_CONTENT * 0.8);

  // Auth here is THREE-state, not two, and it became load-bearing the
  // moment this composer stopped hiding behind a toggle: it is now rendered on
  // every visit to /converse, including the server-rendered first paint, where
  // the auth store is ALWAYS `unknown` (it is module-scoped and never written
  // during SSR, ). `!$currentUser` there would tell a signed-in creator
  // holding a valid session cookie to "Log in to post" — the single most
  // alarming thing this UI can say — and keep saying it for as long as
  // `/api/auth/user/` takes to answer.
  //
  // `page.data.hasSession` is the per-request server signal (no `sessionid`
  // cookie means Django cannot authenticate this request, full stop), so an
  // anonymous visitor still resolves synchronously and gets the prompt in the
  // SSR HTML. Same shape as `routes/converse/+page.svelte` and `Navbar.svelte`.
  //
  // There is deliberately NO local grace timer here, unlike the feed on
  // `routes/converse/+page.svelte`. The two fallbacks are not comparable: the
  // feed's is "fetch as-if-anonymous", which still shows the visitor a stream,
  // while this one would be "tell them they are logged out" — the claim the
  // whole three-state dance exists to avoid. The store already guarantees an
  // answer and already owns the deadline (AUTH_CHECK_TIMEOUT_MS x
  // AUTH_BOOTSTRAP_RETRY_DELAYS_MS, ~26s worst case, then it settles on
  // `anonymous` itself), and `+layout.svelte` drives it on every load. A
  // second, shorter deadline invented here would only ever fire DURING a
  // retry the store is still running, and would fire as a false logged-out
  // state — for exactly as long as the navbar beside it still shows a
  // placeholder. Wait for the same answer the navbar waits for.

  let content = $state("");
  let tuzis = $state(1);
  let preview = $state(false);
  let previewButtonRef = $state<HTMLButtonElement | null>(null);
  let submitting = $state(false);
  let insufficientFunds = $state<InsufficientFundsDetails | null>(null);
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
  // Said before anyone writes, not after a refused post. Only for a
  // balance the session actually reported; unknown is not zero.
  let cannotCoverAPost = $derived(cannotCoverMinimumPost($currentUser?.tuzis));
  let intro = $derived(introPath($currentUser));
  let requestKey = "";
  let requestSignature = "";

  // --- writing tools  -----------------------------------------------
  //
  // The same parts as the zPage body — "/" menu and "+" palette, mentions,
  // floating toolbar and shortcuts, list continuation, and the paste / drop /
  // picker upload pipeline — put together for a short public post: a reduced
  // command set with no headings, the "+" and an image button in the action
  // row (a gutter mark has no margin to live in on a phone-width card), and
  // images that must be PUBLIC, because a post has no subscriber tier.
  let textareaRef = $state<HTMLTextAreaElement | null>(null);
  let formRef = $state<HTMLFormElement | null>(null);
  let imagePickerRef = $state<{
    openPicker: (defaultTab?: "device" | "cloud") => void;
  } | null>(null);
  let videoPickerRef = $state<{
    openPicker: (defaultTab?: "device" | "cloud") => void;
  } | null>(null);
  let isMac = $state(false);
  // A post has no page-level "abandoned" signal the way `/edit` does: this
  // component going away (navigation, or a reply composer being cancelled)
  // IS the writer leaving. An upload still waiting on its limit read is then
  // never sent. Preview does not count — it only swaps the textarea out, and
  // the pipeline resolves into `content` while it is gone.
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    threadAccessCheckId += 1;
    threadAccessCheckController?.abort();
    threadAccessCheckController = null;
  });

  // No "Image" entry where images are switched off: a menu item that can
  // only answer "not here" is worse than not offering it.
  const commands = $derived.by(() =>
    createConverseSlashCommands($t).filter(
      (command) =>
        mediaSlot ||
        !["open-image-picker", "open-video-picker"].includes(
          command.action ?? "",
        ),
    ),
  );

  const editor = new MarkdownTextareaController({
    getValue: () => content,
    setValue: (next) => {
      content = next;
    },
    getTextarea: () => textareaRef,
    commands: () => commands,
    t: () => $t,
    locale: getCurrentLocale,
    mediaSlot: () => mediaSlot,
    beforeMediaInsert: refreshThreadMediaAccess,
    uploadsDisabledMessage: () =>
      mediaSlot?.slot === "body" && mediaSlot.localUploadsAllowed === false
        ? $t(
            "converse.localImagesOnlyFromCloud",
            "Local images can't be added to subscriber-only replies. Choose a saved members image.",
          )
        : $t(
            "converse.imagesOnlyInPublicThreads",
            "Images can only be added to public Converse threads.",
          ),
    isAbandoned: () => destroyed,
    openImagePicker: (defaultTab = "device") =>
      imagePickerRef?.openPicker(defaultTab),
    openVideoPicker: (defaultTab = "device") =>
      videoPickerRef?.openPicker(defaultTab),
    headingShortcuts: false,
    // Tab leaves the field for writing tools, backing and Post.
    tabIndents: false,
  });

  onMount(() => {
    isMac = detectMacPlatform();
    return editor.attach();
  });

  // "An upload is in flight" means "the body still mentions a token whose
  // request has not settled" — in ANY shape, since the writer can edit the
  // placeholder mid-upload. Not the bare in-flight count: deleting a
  // placeholder is how a writer cancels an upload, and the request may take a
  // long time to settle (codex review). Not "anything placeholder-shaped"
  // either: text the writer typed or pasted, with no upload of ours behind
  // it, must never block Post (review round 1).
  const uploading = $derived(
    editor.pendingMediaChecks > 0 ||
      referencesUploadToken(content, editor.uploadTokensInFlight),
  );

  const isReply = $derived(Boolean(parent));
  const resolvedAuthStatus = $derived(
    $authStatus !== "unknown"
      ? $authStatus
      : $page.data.hasSession === false
        ? "anonymous"
        : "unknown",
  );
  // The store hydrates from localStorage synchronously in the browser, so a
  // returning creator sees the box without waiting for the network.
  const signedIn = $derived(Boolean($currentUser));
  const waitingForAuth = $derived(
    !signedIn && resolvedAuthStatus === "unknown",
  );
  // `maxlength` only stops TYPING: an inserted image or mention is spliced in
  // programmatically and can carry the body past the limit the server
  // enforces (`Comment.content` is `max_length=1000`). Refuse here instead of
  // letting the request fail.
  const tooLong = $derived(content.length > MAX_CONTENT);
  const canSubmit = $derived(
    content.trim().length > 0 &&
      !tooLong &&
      // Never post a placeholder token: wait for every upload to resolve.
      !uploading &&
      Number.isInteger(tuzis) &&
      tuzis >= 1 &&
      tuzis <= 10000 &&
      !submitting,
  );
  // The composer's preview resolves `::embed[]` cards as its author, only
  // while the preview is open, debounced and cached for this composer.
  const previewCards = createFirstPartyPreviewResolver();
  onDestroy(() => previewCards.destroy());
  $effect(() => {
    if (preview) {
      previewCards.request(content, "converse", $previewCards.generation);
    }
  });
  const processedContent = $derived(
    processMarkdown(content, { firstPartyCards: $previewCards.cards }),
  );
  // Previewing nothing used to render an explanatory sentence in an empty box.
  // Not offering the mode is simpler than explaining it, and it deletes a
  // string. This guard is what makes "you can never be in preview with an
  // empty body" true rather than merely likely.
  $effect(() => {
    if (preview && !content.trim()) preview = false;
  });
  const avatarUrl = $derived.by(() => {
    const avatar =
      $currentUser?.avatar_image?.thumbnail || $currentUser?.avatar_image?.url;
    if (!avatar) return undefined;
    if (avatar.startsWith("http")) return avatar;
    return `${apiBase}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
  });

  function handleKeyDown(event: KeyboardEvent) {
    // An IME is composing: every key belongs to it (see the controller).
    if (event.isComposing || event.keyCode === 229) return;
    // Cmd/Ctrl+Enter posts — the short-post convention. Not while a menu
    // owns Enter.
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      !editor.showSlashMenu &&
      !editor.showMentionMenu
    ) {
      event.preventDefault();
      formRef?.requestSubmit();
      return;
    }

    editor.handleKeyDown(event);
  }

  function getCharacterCounterLabel(count: number, maximum: number) {
    const values = {
      count: formatLocalizedNumber(count, $locale),
      maximum: formatLocalizedNumber(maximum, $locale),
    };

    return isSingularCount(count, $locale)
      ? $t(
          "characterCounter.one",
          "{count} character used out of {maximum}",
          values,
        )
      : $t(
          "characterCounter.other",
          "{count} characters used out of {maximum}",
          values,
        );
  }

  async function responseError(response: Response) {
    // The server's own sentence: `detail`, `error`, `message`,
    // `non_field_errors`, then the first field error -- never a made-up one.
    const { message } = await readApiError(response);
    if (message) return message;
    return $t(
      "converse.publishError",
      "Could not publish your post (HTTP {status})",
      { status: response.status },
    );
  }

  async function submit(event?: SubmitEvent) {
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
    event?.preventDefault();
    // An upload still in flight is still referenced by the body. Refuse out
    // loud (the button is already disabled; this is the keyboard path) rather
    // than publish a dead image link.
    if (uploading) {
      operationNotice.error(
        editor.pendingMediaChecks > 0
          ? $t("editor.checkingMediaAccess", "Checking media access…")
          : $t(
              "converse.waitForUpload",
              "Wait for your files to finish uploading.",
            ),
      );
      return;
    }
    if (!canSubmit) return;
    // A token of ours that has SETTLED but is still in the body belongs to a
    // placeholder the writer mangled mid-upload, so the pipeline could not
    // swap it for the image. Its placeholder is stripped; if the token is
    // still there after that, the syntax around it is not one we can take
    // apart cleanly, and the post is refused rather than published with it.
    const issued = editor.issuedUploadTokens();
    const submittedContent = stripUploadTokens(content, issued).trim();
    if (referencesUploadToken(submittedContent, issued)) {
      operationNotice.error(
        $t(
          "converse.editedUploadPlaceholder",
          "An image placeholder in your post was edited. Remove it and try again.",
        ),
      );
      return;
    }
    if (!submittedContent) {
      operationNotice.error(
        $t(
          "converse.nothingLeftToPost",
          "Nothing to post: the only thing in it was an image that did not upload.",
        ),
      );
      return;
    }
    const submittedTuzis = tuzis;
    const submittedParent = parent;
    const signature = JSON.stringify({
      parent: submittedParent,
      content: submittedContent,
      tuzis: submittedTuzis,
    });
    requestSignature = signature;

    // Lock before authentication/CSRF awaits; otherwise two rapid submits
    // both pass the pre-await guard and each debit the author's balance.
    submitting = true;
    paymentError = null;
    insufficientFunds = null;
    try {
      const authenticated = await authStore.ensureAuthenticated();
      if (destroyed) return;
      if (!ownsPreflight()) {
        if (!destroyed && authenticationOwner.wasExpired?.()) {
          operationNotice.error(
            $t("economy.signInAgain", "Sign in again before continuing."),
          );
        }
        return;
      }
      if (!authenticated || !$currentUser) {
        operationNotice.error(
          $t("comments.loginToComment", "Please log in to comment"),
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
      const url = parent
        ? `/api/comments/${parent}/replies/`
        : "/api/comments/";
      const requestIdentity = {
        actor: $currentUser.username,
        action: "comment",
        resource: url,
        amount: String(submittedTuzis),
        intent: signature,
      };
      requestKey = intentIdempotencyKey(requestIdentity);
      // `apiFetch`: CSRF, credentials, and the write bound.
      // A post the server never answered left "Posting..." up forever.
      const response = await apiFetch(`${apiBase}${url}`, {
        method: "POST",
        headers: {
          ...CANONICAL_CONTENT_URL_HEADERS,
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        // No headline, ever. `Comment.headline` is `blank=True, default=''`
        // and the field stays in the API for the historic rows and for
        // clients that still send one — this UI simply stopped asking, so it
        // sends the empty string rather than the old "N/A"/"re" sentinels,
        // which leaked into card titles and auto-tweet prompts.
        body: JSON.stringify({
          headline: "",
          content: submittedContent,
          tuzis: submittedTuzis,
          parent: submittedParent,
        }),
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          if (requestOwnership()) authStore.handleAuthFailure(response.status);
          if (!destroyed && requestOwnership.wasExpired?.())
            operationNotice.error(
              $t("economy.signInAgain", "Sign in again before continuing."),
            );
          return;
        }
        const funds = await insufficientFundsFromResponse(response);
        if (operationNotice.isCurrent()) insufficientFunds = funds;
        if (funds) {
          retirePaidIntent(requestIdentity, operationNotice);
          return;
        }
        throw new Error(await responseError(response));
      }

      const post = await response.json();
      // Retained text must retain its replay key after account/session changes.
      if (!operationNotice.isCurrent()) return;
      retirePaidIntent(requestIdentity, operationNotice);
      content = "";
      tuzis = 1;
      preview = false;
      requestKey = "";
      requestSignature = "";
      dispatch("posted", { post });
      operationNotice.success(
        post?.replayed
          ? $t("converse.postAlreadyPosted", "This post was already posted.")
          : isReply
            ? $t("converse.replyPosted", "Reply posted")
            : $t("converse.conversationPosted", "Posted"),
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
      // A timeout keeps `requestKey`, so retrying the same post replays it
      // rather than charging twice: "try again" is safe advice.
      operationNotice.error(
        requestTimeoutMessage(error) ||
          error?.message ||
          $t("converse.publishError", "Could not publish your post"),
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

  function togglePreview() {
    // Removing the textarea does not guarantee a blur event (for example,
    // activation without moving focus). Retire its tools before reading.
    editor.showSlashMenu = false;
    editor.showCommandPalette = false;
    editor.showFloatingToolbar = false;
    editor.closeMentionMenu();
    preview = !preview;
    previewButtonRef?.focus();
  }
</script>

{#if waitingForAuth}
  <!-- The session is real (a `sessionid` cookie reached the server) but
       unconfirmed. Hold the composer's footprint and claim nothing rather
       than guess wrong in either direction. -->
  <div
    class="h-40 rounded-2xl border border-dashed border-border/50"
    data-testid="converse-composer-pending"
    aria-busy="true"
  ></div>
{:else if $currentUser}
  <form
    class={compact
      ? "rounded-xl border border-border/70 bg-background/70 p-3"
      : "rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"}
    class:drawer-composer={drawerPresentation}
    data-testid={isReply ? "converse-reply-composer" : "converse-composer"}
    bind:this={formRef}
    onsubmit={submit}
  >
    <!--
      Same two-column grid as the post cards below it: avatar, then a column of
      content. The composer is not a separate piece of furniture announcing
      itself — it is the next post in the stream, still empty.

      Keep the shared Input/Textarea chrome (border, radius, padding, focus
      ring) instead of stripping it with utility overrides. Two reasons:

      1. It cannot be stripped cleanly. `cn()` is tailwind-merge, which only
         de-dupes classes sharing a variant prefix, so a bare `bg-transparent`
         does not cancel the components' `dark:bg-input/30`. The dark-mode fill
         kept painting while the border/padding vanished, leaving a half-styled
         field on a themed card.
      2. `border-0` + `focus-visible:ring-0` on top of the components'
         `outline-none` left these fields with no visible focus indicator.

      Only override things that do not fight a component default.
    -->
    <div class="flex gap-3">
      {#if !compact}
        <div class="composer-avatar">
          <Avatar.Root class="size-10 shrink-0 border border-border/70">
            <Avatar.Image src={avatarUrl} alt={$currentUser.username} />
            <Avatar.Fallback class="text-xs font-semibold">
              {$currentUser.username.substring(0, 2).toUpperCase()}
            </Avatar.Fallback>
          </Avatar.Root>
        </div>
      {/if}

      <div class="min-w-0 flex-1">
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
            newTab
          />
        {:else if cannotCoverAPost}
          <PostingCostNotice balance={String($currentUser?.tuzis)} {intro} />
        {/if}
        {#if preview}
          <div
            class={drawerPresentation
              ? "min-h-36 rounded-md bg-muted/35 p-3 sm:min-h-28 sm:rounded-xl sm:p-4"
              : "min-h-28 rounded-xl bg-muted/35 p-4"}
          >
            <div class="prose prose-sm max-w-none dark:prose-invert">
              <MarkdownContent html={processedContent} />
            </div>
          </div>
        {:else}
          <label
            for={isReply ? `reply-${parent}` : "converse-content"}
            class="sr-only"
          >
            {isReply
              ? $t("comments.reply", "Reply")
              : $t("converse.bodyLabel", "Post")}
          </label>
          <Textarea
            id={isReply ? `reply-${parent}` : "converse-content"}
            bind:ref={textareaRef}
            bind:value={content}
            maxlength={MAX_CONTENT}
            rows={compact ? 3 : 4}
            placeholder={isReply
              ? $t("comments.reply", "Reply")
              : $t("converse.bodyPlaceholder", "Say something…")}
            class={`resize-y ${drawerPresentation ? "focus-visible:ring-1 sm:focus-visible:ring-[3px]" : ""} ${editor.dragActive ? "bg-primary/5 ring-2 ring-primary/40" : ""}`}
            aria-controls={commandMenuId}
            aria-haspopup="listbox"
            aria-expanded={editor.showSlashMenu}
            aria-activedescendant={editor.showSlashMenu &&
            editor.filteredCommands[editor.selectedSlashCommand]
              ? `${commandMenuId}-option-${editor.selectedSlashCommand}`
              : undefined}
            aria-busy={uploading}
            spellcheck="true"
            oninput={editor.handleInput}
            onkeydown={handleKeyDown}
            onpaste={editor.handlePaste}
            ondragover={editor.handleDragOver}
            ondragenter={editor.handleDragOver}
            ondragleave={editor.handleDragLeave}
            ondrop={editor.handleDrop}
            onselect={editor.handleSelectionChange}
            onmouseup={editor.handleSelectionChange}
            onkeyup={editor.handleSelectionChange}
            onblur={editor.handleBlur}
          />
          {#if !mediaSlot}
            <p
              class="mt-1.5 text-[11px] text-muted-foreground"
              data-testid="converse-images-disabled"
            >
              {$t(
                "converse.imagesOnlyInPublicThreads",
                "Images can only be added to public Converse threads.",
              )}
            </p>
          {/if}
        {/if}

        <ConverseComposerFooter
          mobileDrawer={drawerPresentation}
          showStatus={uploading || content.length >= COUNTER_VISIBLE_FROM}
        >
          {#snippet backing()}
            <!-- The one piece of instrumentation this composer keeps, because
               backing a post with 2Z is the thing Free2Z has that a microblog
               does not.

               Its two words stay VISIBLE. Everything else in this pass was
               deleted because the interface was describing itself to somebody
               already looking at it — but submitting debits the author's
               ledger by this amount (`CommentCreateSerializer.create` ->
               `dj.apps.tuzis.ledger`, up to 10,000 2Z), and a spend control
               whose only verb lives in an `aria-label` and a hover-only
               `title` discloses nothing to a sighted phone user. Quieter is
               the brief; unlabelled money is not. -->
            <span
              class={drawerPresentation ? "hidden sm:contents" : "contents"}
            >
              <Coins
                strokeWidth={1.5}
                class="size-4 shrink-0 text-primary"
                aria-hidden="true"
              />
            </span>
            <label
              for={isReply ? `reply-weight-${parent}` : "converse-weight"}
              class="text-xs text-muted-foreground"
            >
              {$t("converse.backWith", "Back with")}
            </label>
            <div
              class={drawerPresentation
                ? "flex h-9 w-[88px] items-center rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 sm:contents dark:bg-input/30"
                : "contents"}
            >
              <Input
                id={isReply ? `reply-weight-${parent}` : "converse-weight"}
                type="number"
                min={1}
                max={10000}
                step={1}
                bind:value={tuzis}
                class={drawerPresentation
                  ? "h-full w-16 shrink-0 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 sm:h-8 sm:w-20 sm:border sm:bg-background sm:px-3 sm:shadow-xs sm:focus-visible:ring-[3px] dark:bg-transparent sm:dark:bg-input/30"
                  : "h-8 w-20"}
              />
              <span
                class={drawerPresentation
                  ? "pr-1.5 text-xs text-muted-foreground sm:pr-0"
                  : "text-xs text-muted-foreground"}>2Z</span
              >
            </div>
          {/snippet}

          {#snippet status()}
            {#if uploading}
              <span
                class="flex items-center gap-1 text-[11px] text-muted-foreground"
                data-testid="converse-upload-status"
              >
                <Loader2
                  class="size-3 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {editor.pendingMediaChecks > 0
                  ? $t("editor.checkingMediaAccess", "Checking media access…")
                  : $t("editor.uploadingMedia", "Uploading files…")}
              </span>
            {/if}
            <span
              class={`text-[11px] tabular-nums ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
            >
              {#if content.length >= COUNTER_VISIBLE_FROM}
                <span
                  aria-hidden="true"
                  data-testid="converse-character-counter"
                >
                  {formatLocalizedNumber(
                    content.length,
                    $locale,
                  )}/{formatLocalizedNumber(MAX_CONTENT, $locale)}
                </span>
              {/if}
              <span class="sr-only"
                >{getCharacterCounterLabel(content.length, MAX_CONTENT)}</span
              >
            </span>
          {/snippet}

          {#snippet tools()}
            {#if !preview}
              <!-- Writing tools precede backing and publishing in reading and tab order.
                   Real buttons work with a
                   thumb. `pointerdown` keeps a mouse click from blurring the
                   textarea (which would close the palette it opens). -->
              <Button
                type="button"
                size={drawerPresentation ? "icon" : "icon-sm"}
                variant={drawerPresentation ? "outline" : "ghost"}
                data-testid="converse-insert-trigger"
                title={$t("editor.insertMenu", "Insert content")}
                aria-label={$t("editor.insertMenu", "Insert content")}
                aria-haspopup="listbox"
                aria-expanded={editor.showCommandPalette}
                aria-controls={commandMenuId}
                class={drawerPresentation
                  ? "group shadow-none aria-expanded:bg-accent sm:size-8 sm:border-0 sm:bg-transparent sm:dark:bg-transparent sm:dark:hover:bg-accent/50"
                  : "group aria-expanded:bg-accent"}
                onpointerdown={(event) => {
                  if (event.pointerType === "mouse") event.preventDefault();
                }}
                onclick={editor.toggleCommandPalette}
              >
                <Plus
                  strokeWidth={1.5}
                  class="size-4 transition-transform duration-150 group-aria-expanded:rotate-45"
                />
              </Button>
              {#if mediaSlot}
                <Button
                  type="button"
                  size={drawerPresentation ? "icon" : "icon-sm"}
                  variant={drawerPresentation ? "outline" : "ghost"}
                  class={drawerPresentation
                    ? "shadow-none sm:size-8 sm:border-0 sm:bg-transparent sm:dark:bg-transparent sm:dark:hover:bg-accent/50"
                    : ""}
                  data-testid="converse-image-trigger"
                  title={$t("editor.slashCommands.image", "Insert image")}
                  aria-label={$t("editor.slashCommands.image", "Insert image")}
                  onclick={() =>
                    imagePickerRef?.openPicker(
                      "localUploadsAllowed" in mediaSlot &&
                        mediaSlot.localUploadsAllowed === false
                        ? "cloud"
                        : "device",
                    )}
                >
                  <ImagePlus strokeWidth={1.5} class="size-4" />
                </Button>
                <Button
                  type="button"
                  size={drawerPresentation ? "icon" : "icon-sm"}
                  variant={drawerPresentation ? "outline" : "ghost"}
                  class={drawerPresentation
                    ? "shadow-none sm:size-8 sm:border-0 sm:bg-transparent sm:dark:bg-transparent sm:dark:hover:bg-accent/50"
                    : ""}
                  data-testid="converse-video-trigger"
                  title={$t("editor.insertVideo", "Insert video")}
                  aria-label={$t("editor.insertVideo", "Insert video")}
                  onclick={() =>
                    videoPickerRef?.openPicker(
                      "localUploadsAllowed" in mediaSlot &&
                        mediaSlot.localUploadsAllowed === false
                        ? "cloud"
                        : "device",
                    )}
                >
                  <Video strokeWidth={1.5} class="size-4" />
                </Button>
              {/if}
            {/if}
            <Button
              type="button"
              size="sm"
              variant={drawerPresentation ? "outline" : "ghost"}
              disabled={!content.trim() || uploading}
              onclick={togglePreview}
              bind:ref={previewButtonRef}
              aria-pressed={preview}
              title={preview
                ? $t("converse.edit", "Edit")
                : $t("converse.preview", "Preview")}
              aria-label={preview
                ? $t("converse.edit", "Edit")
                : $t("converse.preview", "Preview")}
              class={drawerPresentation
                ? "size-9 px-0 shadow-none has-[>svg]:px-0 max-sm:aria-pressed:bg-accent sm:h-8 sm:w-auto sm:border-0 sm:bg-transparent sm:px-3 sm:has-[>svg]:px-2.5 sm:dark:bg-transparent sm:dark:hover:bg-accent/50"
                : ""}
            >
              <Eye strokeWidth={1.5} class="size-4" />
              <span class={drawerPresentation ? "sr-only sm:not-sr-only" : ""}>
                {preview
                  ? $t("converse.edit", "Edit")
                  : $t("converse.preview", "Preview")}
              </span>
            </Button>
          {/snippet}

          {#snippet publish()}
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              aria-busy={submitting || uploading}
              class={drawerPresentation
                ? "relative h-9 w-18 px-2 has-[>svg]:px-2 sm:h-8 sm:w-auto sm:px-3 sm:has-[>svg]:px-2.5"
                : ""}
            >
              {#if submitting || uploading}
                <Loader2
                  class={drawerPresentation
                    ? "absolute left-1/2 size-4 -translate-x-1/2 animate-spin motion-reduce:animate-none sm:static sm:translate-x-0"
                    : "size-4 animate-spin motion-reduce:animate-none"}
                />
              {:else}
                <Send
                  strokeWidth={1.5}
                  class={drawerPresentation
                    ? "hidden size-4 sm:block"
                    : "size-4"}
                />
              {/if}
              <span
                class={drawerPresentation && (submitting || uploading)
                  ? "opacity-0 sm:opacity-100"
                  : ""}
              >
                {isReply
                  ? $t("comments.reply", "Reply")
                  : $t("converse.publish", "Post")}
              </span>
            </Button>
          {/snippet}
        </ConverseComposerFooter>
      </div>
    </div>
  </form>

  {#if mediaSlot}
    <EditorImagePicker
      bind:this={imagePickerRef}
      onChooseCloudImage={editor.insertCloudImage}
      onUploadLocalImages={editor.insertLocalImages}
      beforeChooseCloudImage={refreshThreadMediaAccess}
      accessSlot={mediaSlot.slot}
      subscriberOnly={mediaSlot.subscriberOnly}
      localUploadsAllowed={!("localUploadsAllowed" in mediaSlot) ||
        mediaSlot.localUploadsAllowed !== false}
    />
    <EditorImagePicker
      bind:this={videoPickerRef}
      mediaType="video"
      onChooseCloudImage={editor.insertCloudImage}
      onUploadLocalImages={(files) => editor.insertLocalImages(files, "video")}
      beforeChooseCloudImage={refreshThreadMediaAccess}
      accessSlot={mediaSlot.slot}
      subscriberOnly={mediaSlot.subscriberOnly}
      localUploadsAllowed={!("localUploadsAllowed" in mediaSlot) ||
        mediaSlot.localUploadsAllowed !== false}
    />
  {/if}

  <EditorFloatingToolbar
    wrapSelection={editor.wrapSelection}
    insertAtCursor={editor.insertAtCursor}
    onApplyBold={() => editor.applyInlineShortcut("**")}
    onApplyItalic={() => editor.applyInlineShortcut("*")}
    onApplyLink={editor.applyLinkShortcut}
    onApplyCode={() => editor.applyInlineShortcut("`")}
    onApplyBulletList={() => editor.applyLineShortcut("bullet")}
    onApplyOrderedList={() => editor.applyLineShortcut("ordered")}
    onApplyQuote={() => editor.applyLineShortcut("quote")}
    {isMac}
    showHeading={false}
    position={editor.floatingToolbarPosition}
    show={!preview && editor.showFloatingToolbar}
  />

  {#if !preview && editor.showSlashMenu}
    <EditorSlashMenu
      bind:slashMenuRef={editor.slashMenuRef}
      bind:selectedSlashCommand={editor.selectedSlashCommand}
      bind:selectedCommandRefs={editor.selectedCommandRefs}
      slashMenuPosition={editor.slashMenuPosition}
      filteredCommands={editor.filteredCommands}
      {isMac}
      menuId={commandMenuId}
      optionIdPrefix={`${commandMenuId}-option`}
      menuTitle={editor.showCommandPalette
        ? $t("editor.insertMenu", "Insert content")
        : undefined}
      insertSlashCommand={editor.insertSlashCommand}
    />
  {/if}

  {#if !preview && editor.showMentionMenu}
    <EditorMentionMenu
      bind:mentionMenuRef={editor.mentionMenuRef}
      bind:selectedMention={editor.selectedMention}
      bind:selectedMentionRefs={editor.selectedMentionRefs}
      mentionMenuPosition={editor.mentionMenuPosition}
      mentionResults={editor.mentionResults}
      insertMention={editor.insertMention}
      isLoading={editor.mentionLoading}
    />
  {/if}
{:else}
  <!-- The composer's ghost: it sits where the box would be, in the same
       shape, and it is a single control saying what it does. The version
       before it was a heading, a sentence of encouragement and a button whose
       label ("Log in") did not match the sentence's verb ("Sign in").

       Hydrated, it opens the sign-in modal IN PLACE  and the visitor
       keeps /converse; before hydration it is a real link to the real login
       page, which comes back here. The link it replaced went to a homepage
       sentinel nothing read, so the visitor lost /converse and got no login. -->
  <Button
    href={loginDestination($page.url.pathname + $page.url.search)}
    onclick={(e) => {
      e.preventDefault();
      requestLogin({ trigger: e.currentTarget });
    }}
    variant="outline"
    data-testid="converse-login-prompt"
    class="h-auto w-full justify-start rounded-2xl border-dashed px-4 py-4 text-sm font-normal text-muted-foreground"
  >
    {$t("converse.signInToJoin", "Log in to post")}
  </Button>
{/if}

<style>
  .composer-avatar {
    display: contents;
  }

  @media (width < 640px) {
    .drawer-composer {
      border: 0;
      border-radius: 0;
      background: transparent;
      padding: 0;
      box-shadow: none;
    }

    .drawer-composer .composer-avatar {
      display: none;
    }

    .drawer-composer :global(input[type="number"]) {
      appearance: textfield;
    }

    .drawer-composer :global(input[type="number"]::-webkit-inner-spin-button),
    .drawer-composer :global(input[type="number"]::-webkit-outer-spin-button) {
      appearance: none;
      margin: 0;
    }

    .drawer-composer :global([data-slot="textarea"]) {
      min-height: 144px;
      max-height: min(320px, 40dvh);
      overflow-y: auto;
      resize: none;
    }
  }
</style>
