<script lang="ts">
  import { formatDateTime, formatRelativeTime } from "$lib/utils/date";
  import { createEventDispatcher, onMount, tick } from "svelte";
  import { slide } from "svelte/transition";
  import { page } from "$app/state";
  import { browser } from "$app/env";
  import type { CommentData } from "./types";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import CommentVote from "./CommentVote.svelte";
  import CommentForm from "./CommentForm.svelte";
  import * as env from "$app/env/public";
  import {
    ArrowUp,
    Clock3,
    MessageSquare,
    MessagesSquare,
    X,
  } from "@lucide/svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils";
  import { tStore as t, locale } from "$lib/i18n";
  import CommentReportButton from "$lib/components/moderation/CommentReportButton.svelte";
  import { blockedUsernames, isBlockedIn } from "$lib/stores/blocks";

  export let comment: CommentData;
  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;
  export let top: boolean = false;

  const dispatch = createEventDispatcher();
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  let replyOpen = false;
  let reduceMotion = false;
  let authorHover = false;

  function handleReplySuccess() {
    replyOpen = false;
    dispatch("reload");
  }

  const COMMENT_DATE_TIME: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };

  function formatDate(dateString: string, currentLocale: string) {
    return formatDateTime(dateString, currentLocale, COMMENT_DATE_TIME);
  }

  function formatRelativeDate(dateString: string, currentLocale: string) {
    return formatRelativeTime(dateString, currentLocale, {
      justNow: $t("comments.justNow", "just now"),
      absoluteAfterSeconds: 7 * 86400,
      absoluteOptions: COMMENT_DATE_TIME,
    });
  }

  function isPlaceholderHeadline(value: string) {
    return ["n/a", "re"].includes(value.trim().toLowerCase());
  }

  onMount(async () => {
    if (!browser) return;
    reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const id = page.url.hash.slice(1);
    if (id === `comment-${comment.uuid}`) {
      await tick();
      document.getElementById(id)?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
  });

  $: avatarUrl =
    comment.author.avatar_image?.thumbnail || comment.author.avatar_image?.url;
  $: fullAvatarUrl = avatarUrl
    ? avatarUrl.startsWith("http")
      ? avatarUrl
      : `${apiBase}${avatarUrl.startsWith("/") ? "" : "/"}${avatarUrl}`
    : undefined;
  $: displayHeadline = comment.headline?.trim() || "";
  $: showHeadline =
    displayHeadline.length > 0 && !isPlaceholderHeadline(displayHeadline);
  $: replyCount = Number(comment.num_children) || 0;
  //the API already drops a blocked author's comments from every list
  // it serves with the reader's session; this covers lists that reached the
  // browser without it (SSR, cached pages).
  $: hiddenByBlock = isBlockedIn($blockedUsernames, comment.author.username);

  $: isThreadPage = page.url.pathname === `/converse/${comment.uuid}`;
  $: navigationKind = comment.parent
    ? "parent"
    : comment.content_url
      ? "content"
      : "conversation";
  $: navigationUrl = comment.parent
    ? `/converse/${comment.parent}`
    : `/converse/${comment.uuid}`;
  // `::embed[]` of a zPage / converse thread: resolved by the page's
  // ONE resolver as the VIEWER (not the comment's author), deduped across
  // every comment on the page and bounded by the page budget. Until a card
  // arrives — and for anything this viewer cannot open — the neutral card.
  const firstPartyCards = useFirstPartyCards();
  // Primitives, so each statement re-runs only when ITS value changes: a
  // card landing elsewhere on the page re-renders nothing here (review F3).
  $: cardGeneration = $firstPartyCards.generation;
  $: firstPartyCards.request(comment.content, undefined, cardGeneration);
  $: cardSignature = firstPartyCards.signature(
    comment.content,
    $firstPartyCards,
  );
  $: processedContent = processMarkdown(comment.content, {
    firstPartyCards: firstPartyCards.cardsFor(comment.content, cardSignature),
  });
</script>

{#if hiddenByBlock}
  <p
    id={`comment-${comment.uuid}`}
    class="rounded-lg border border-dashed border-border/60 px-3 py-2 text-sm text-muted-foreground"
    data-testid="comment-blocked"
  >
    {$t(
      "moderation.block.hiddenComment",
      "Comment hidden because you blocked @{username}.",
      { username: comment.author.username },
    )}
  </p>
{:else}
  <article id={`comment-${comment.uuid}`} class="group/comment scroll-mt-24">
    <div class="flex gap-2.5 sm:gap-3">
      <a
        href={`/${comment.author.username}`}
        class="shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        on:mouseenter={() => (authorHover = true)}
        on:mouseleave={() => (authorHover = false)}
        on:focus={() => (authorHover = true)}
        on:blur={() => (authorHover = false)}
        aria-label={$t("comments.viewProfile", "View profile")}
      >
        <Avatar.Root
          class={cn(
            "border transition-transform duration-150 motion-reduce:transition-none",
            authorHover ? "scale-[1.03] border-primary/40" : "border-border/60",
            top ? "size-9 sm:size-10" : "size-8 sm:size-9",
          )}
        >
          <Avatar.Image src={fullAvatarUrl} alt={comment.author.username} />
          <Avatar.Fallback class="text-xs font-medium">
            {comment.author.username.substring(0, 2).toUpperCase()}
          </Avatar.Fallback>
        </Avatar.Root>
      </a>

      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <a
              href={`/${comment.author.username}`}
              class={cn(
                "truncate text-sm font-semibold tracking-tight transition-colors motion-reduce:transition-none",
                authorHover ? "text-primary" : "text-foreground",
              )}
              on:mouseenter={() => (authorHover = true)}
              on:mouseleave={() => (authorHover = false)}
              on:focus={() => (authorHover = true)}
              on:blur={() => (authorHover = false)}
            >
              {comment.author.username}
            </a>
            <a
              href={`/converse/${comment.uuid}`}
              class="inline-flex shrink-0 items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none"
              title={formatDate(comment.created_at, $locale)}
            >
              <Clock3 strokeWidth={1.5} class="size-3" />
              <span>{formatRelativeDate(comment.created_at, $locale)}</span>
            </a>
          </div>

          {#if top && navigationKind !== "content" && (navigationKind !== "conversation" || !isThreadPage)}
            <div
              class={cn(
                "-mt-1 flex shrink-0 items-center gap-0.5",
                replyCount > 0 ? "mr-8" : "-mr-1",
              )}
            >
              <Button
                variant="ghost"
                size="icon-sm"
                href={navigationUrl}
                title={navigationKind === "parent"
                  ? $t("comments.navigateToParent", "Navigate to parent")
                  : $t("converse.openConversation", "Open conversation")}
                aria-label={navigationKind === "parent"
                  ? $t("comments.navigateToParent", "Navigate to parent")
                  : $t("converse.openConversation", "Open conversation")}
                class="text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
              >
                {#if navigationKind === "parent"}
                  <ArrowUp strokeWidth={1.5} class="size-4" />
                {:else}
                  <MessageSquare strokeWidth={1.5} class="size-4" />
                {/if}
              </Button>
            </div>
          {/if}
        </div>

        <div class="mt-1.5">
          {#if showHeadline}
            <p
              class="mb-1.5 max-w-[70ch] text-sm leading-relaxed font-bold break-words text-foreground"
            >
              {displayHeadline}
            </p>
          {/if}
          <div
            class="prose prose-sm max-w-[70ch] break-words text-foreground dark:prose-invert"
          >
            <MarkdownContent html={processedContent} />
          </div>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2">
          <CommentVote {comment} />

          <Button
            variant="ghost"
            size="sm"
            class={cn(
              "h-8 rounded-lg px-2.5 text-muted-foreground hover:bg-transparent hover:text-primary sm:px-3 dark:hover:bg-transparent",
              replyOpen && "text-primary",
            )}
            onclick={() => (replyOpen = !replyOpen)}
            aria-expanded={replyOpen}
          >
            {#if replyOpen}
              <X strokeWidth={1.5} class="size-4 sm:mr-1" />
              <span class="sr-only sm:not-sr-only">
                {$t("comments.cancel", "Cancel")}
              </span>
            {:else}
              <MessageSquare strokeWidth={1.5} class="size-4 sm:mr-1" />
              <span class="sr-only sm:not-sr-only">
                {$t("comments.reply", "Reply")}
              </span>
            {/if}
          </Button>

          {#if top && replyCount > 0 && !isThreadPage}
            <Button
              variant="ghost"
              size="sm"
              href={`/converse/${comment.uuid}`}
              class="h-8 rounded-lg px-2.5 text-muted-foreground hover:bg-transparent hover:text-primary sm:px-3 dark:hover:bg-transparent"
            >
              <MessagesSquare strokeWidth={1.5} class="size-4 sm:mr-1" />
              <span>
                {replyCount === 1
                  ? $t("comments.viewReply", "{count} reply", {
                      count: replyCount,
                    })
                  : $t("comments.viewReplies", "{count} replies", {
                      count: replyCount,
                    })}
              </span>
            </Button>
          {/if}

          <CommentReportButton
            commentUuid={comment.uuid}
            authorUsername={comment.author.username}
          />
        </div>

        {#if replyOpen}
          <div
            class="mt-3"
            transition:slide={{ duration: reduceMotion ? 0 : 200 }}
          >
            <CommentForm
              {object_type}
              {object_uuid}
              parent={comment.uuid}
              callback={handleReplySuccess}
            />
          </div>
        {/if}
      </div>
    </div>
  </article>
{/if}
