<script lang="ts">
  import { createEventDispatcher, onMount, tick } from "svelte";
  import { slide } from "svelte/transition";
  import { page } from "$app/state";
  import { browser } from "$app/environment";
  import type { CommentData } from "./types";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import CommentVote from "./CommentVote.svelte";
  import CommentForm from "./CommentForm.svelte";
  import { env } from "$env/dynamic/public";
  import {
    ArrowUp,
    Clock3,
    MessageSquare,
    MessagesSquare,
    MoveUp,
    X,
  } from "@lucide/svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Button } from "$lib/components/ui/button";
  import { cn } from "$lib/utils";
  import { tStore as t, locale } from "$lib/i18n";

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

  function formatDate(dateString: string, currentLocale: string) {
    if (!dateString) return "";
    try {
      return new Date(dateString).toLocaleDateString(currentLocale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateString;
    }
  }

  function formatRelativeDate(dateString: string, currentLocale: string) {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      const diffMinutes = Math.round((Date.now() - date.getTime()) / 60000);

      if (Math.abs(diffMinutes) < 1) {
        return $t("comments.justNow", "just now");
      }

      const relativeTime = new Intl.RelativeTimeFormat(currentLocale, {
        numeric: "auto",
      });

      if (Math.abs(diffMinutes) < 60) {
        return relativeTime.format(-diffMinutes, "minute");
      }

      const diffHours = Math.round(diffMinutes / 60);
      if (Math.abs(diffHours) < 24) {
        return relativeTime.format(-diffHours, "hour");
      }

      const diffDays = Math.round(diffHours / 24);
      if (Math.abs(diffDays) < 7) {
        return relativeTime.format(-diffDays, "day");
      }

      return formatDate(dateString, currentLocale);
    } catch {
      return formatDate(dateString, currentLocale);
    }
  }

  function isPlaceholderHeadline(value: string) {
    return ["n/a", "re"].includes(value.trim().toLowerCase());
  }

  function normalizeContentUrl(url: string) {
    return url.replace(
      /^\/([^/?#]+)\/zpage\/([^/?#]+)(?=\/?(?:[?#]|$))/,
      "/$1/$2",
    );
  }

  function addCommentAnchor(url: string, commentUuid: string) {
    return `${url.replace(/#.*$/, "")}#comment-${commentUuid}`;
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
  $: isThreadPage = page.url.pathname === `/converse/${comment.uuid}`;
  $: contentUrl = comment.content_url
    ? addCommentAnchor(normalizeContentUrl(comment.content_url), comment.uuid)
    : null;
  $: navigationKind = comment.parent
    ? "parent"
    : contentUrl
      ? "content"
      : "conversation";
  $: navigationUrl = comment.parent
    ? `/converse/${comment.parent}`
    : contentUrl || `/converse/${comment.uuid}`;
  $: processedContent = processMarkdown(comment.content);
</script>

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

        {#if top && (navigationKind !== "conversation" || !isThreadPage)}
          <div class="-mt-1 -mr-1 flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              href={navigationUrl}
              title={navigationKind === "parent"
                ? $t("comments.navigateToParent", "Navigate to parent")
                : navigationKind === "content"
                  ? $t("comments.navigateToContent", "Navigate to content")
                  : $t("converse.openConversation", "Open conversation")}
              aria-label={navigationKind === "parent"
                ? $t("comments.navigateToParent", "Navigate to parent")
                : navigationKind === "content"
                  ? $t("comments.navigateToContent", "Navigate to content")
                  : $t("converse.openConversation", "Open conversation")}
              class="text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
            >
              {#if navigationKind === "parent"}
                <ArrowUp strokeWidth={1.5} class="size-4" />
              {:else if navigationKind === "content"}
                <MoveUp strokeWidth={1.5} class="size-4" />
              {:else}
                <MessageSquare strokeWidth={1.5} class="size-4" />
              {/if}
            </Button>
          </div>
        {/if}
      </div>

      <div class="mt-1.5">
        {#if showHeadline}
          <a
            href={`/converse/${comment.uuid}`}
            class="mb-1.5 block max-w-[65ch] text-base leading-snug font-semibold break-words text-foreground transition-colors hover:text-primary focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none"
          >
            {displayHeadline}
          </a>
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
              {$t("comments.viewReplies", "{count} replies").replace(
                "{count}",
                String(replyCount),
              )}
            </span>
          </Button>
        {/if}
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
