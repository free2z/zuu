<script lang="ts">
  import { createEventDispatcher, onMount, tick } from "svelte";
  import { browser } from "$app/environment";
  import { page } from "$app/state";
  import { env } from "$env/dynamic/public";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import CommentVote from "$lib/components/comments/CommentVote.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { locale, tStore as t } from "$lib/i18n";
  import { ArrowUpRight, Clock3, MessageSquare, X } from "@lucide/svelte";
  import { slide } from "svelte/transition";
  import ConverseComposer from "./ConverseComposer.svelte";
  import type { ConversePostData } from "./types";
  import {
    formatPostDate,
    formatRelativePostDate,
    getAvatarUrl,
    getSourceIdentifier,
    getSourceUrl,
    getVisibleHeadline,
    resolveSourceTitle,
  } from "./utils";

  export let post: ConversePostData;
  export let rootUuid: string;
  export let root = false;
  export let detail = false;
  export let focused = false;
  export let showOpenThread = false;

  const dispatch = createEventDispatcher();
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  let replyOpen = false;
  let reduceMotion = false;
  let sourceTitle: string | null = null;

  $: headline = getVisibleHeadline(post);
  $: sourceUrl = root ? getSourceUrl(post) : null;
  $: sourceIdentifier = root ? getSourceIdentifier(post) : null;
  $: avatarUrl = getAvatarUrl(post, apiBase);
  $: threadUrl = `/converse/${rootUuid}#comment-${post.uuid}`;
  $: content = processMarkdown(post.content);

  function handlePosted() {
    replyOpen = false;
    dispatch("replyPosted");
  }

  onMount(async () => {
    if (!browser) return;
    if (sourceIdentifier) {
      sourceTitle = await resolveSourceTitle(sourceIdentifier, apiBase);
    }
    reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (focused || page.url.hash === `#comment-${post.uuid}`) {
      await tick();
      document.getElementById(`comment-${post.uuid}`)?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "center",
      });
    }
  });
</script>

<article
  id={`comment-${post.uuid}`}
  class={focused && !root
    ? "-m-2 scroll-mt-24 rounded-xl bg-primary/5 p-2 ring-1 ring-primary/25"
    : "scroll-mt-24"}
>
  {#if root}
    <div
      class="mb-4 flex flex-wrap items-center justify-between gap-2"
    >
      <Badge
        href={sourceUrl || undefined}
        variant={sourceUrl ? "outline" : "secondary"}
        class={sourceUrl
          ? "max-w-full cursor-pointer font-normal [a&]:hover:bg-transparent [a&]:hover:text-primary"
          : "font-normal"}
      >
        {#if sourceUrl}
          <span class="text-muted-foreground">
            {$t("converse.zpage", "zPage")}
          </span>
          <span class="text-muted-foreground/60" aria-hidden="true">·</span>
          <span>
            {sourceTitle || sourceIdentifier || $t("converse.zpage", "zPage")}
          </span>
        {:else}
          {$t("converse.nativeDiscussion", "Started in Converse")}
        {/if}
      </Badge>
      {#if showOpenThread}
        <Button
          href={`/converse/${rootUuid}`}
          variant="ghost"
          size="icon-sm"
          class="size-7 bg-transparent text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
          title={$t("converse.openThread", "Open thread")}
          aria-label={$t("converse.openThread", "Open thread")}
        >
          <ArrowUpRight strokeWidth={1.5} class="size-4" />
        </Button>
      {/if}
    </div>
  {/if}

  <div class="flex gap-3">
    <a
      href={`/${post.author.username}`}
      class="h-fit shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      aria-label={$t("comments.viewProfile", "View profile")}
    >
      <Avatar.Root
        class={root
          ? "size-10 border border-border/70"
          : "size-8 border border-border/60"}
      >
        <Avatar.Image src={avatarUrl} alt={post.author.username} />
        <Avatar.Fallback class="text-xs font-semibold">
          {post.author.username.substring(0, 2).toUpperCase()}
        </Avatar.Fallback>
      </Avatar.Root>
    </a>

    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <a
          href={`/${post.author.username}`}
          class="truncate text-sm font-semibold text-foreground hover:text-primary"
        >
          {post.author.username}
        </a>
        {#if root}
          <span class="text-xs text-muted-foreground">
            {$t("converse.threadStarter", "started this thread")}
          </span>
        {/if}
        <span class="text-muted-foreground/50" aria-hidden="true">·</span>
        <a
          href={threadUrl}
          class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title={formatPostDate(post.created_at, $locale)}
        >
          <Clock3 strokeWidth={1.5} class="size-3" />
          {formatRelativePostDate(post.created_at, $locale)}
        </a>
      </div>

      <div class={root ? "mt-3" : "mt-2"}>
        {#if headline}
          {#if detail}
            <h1
              class="mb-2 text-sm leading-relaxed font-bold text-foreground"
            >
              {headline}
            </h1>
          {:else}
            <h2
              class="mb-2 text-sm leading-relaxed font-bold text-foreground"
            >
              {headline}
            </h2>
          {/if}
        {/if}
        <div
          class="prose prose-sm max-w-none break-words text-foreground dark:prose-invert"
        >
          <MarkdownContent html={content} />
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <CommentVote comment={post} />
        <Button
          variant="ghost"
          size="sm"
          class={replyOpen
            ? "h-8 bg-transparent text-primary hover:bg-transparent dark:hover:bg-transparent"
            : "h-8 bg-transparent text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"}
          onclick={() => (replyOpen = !replyOpen)}
          aria-expanded={replyOpen}
        >
          {#if replyOpen}
            <X strokeWidth={1.5} class="size-4" />
            {$t("comments.cancel", "Cancel")}
          {:else}
            <MessageSquare strokeWidth={1.5} class="size-4" />
            {$t("comments.reply", "Reply")}
          {/if}
        </Button>
      </div>

      {#if replyOpen}
        <div
          class="mt-3"
          transition:slide={{ duration: reduceMotion ? 0 : 180 }}
        >
          <ConverseComposer
            parent={post.uuid}
            replyingTo={post.author.username}
            compact={true}
            on:posted={handlePosted}
          />
        </div>
      {/if}
    </div>
  </div>
</article>
