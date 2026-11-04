<script lang="ts">
  import { createEventDispatcher, onMount, tick } from "svelte";
  import { browser } from "$app/env";
  import { page } from "$app/state";
  import * as env from "$app/env/public";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import CommentVote from "$lib/components/comments/CommentVote.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";
  import * as Avatar from "$lib/components/ui/avatar";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { locale, tStore as t } from "$lib/i18n";
  import { ArrowUpRight, Clock3, MessageSquare, X } from "@lucide/svelte";
  import { slide } from "svelte/transition";
  import ConverseComposer from "./ConverseComposer.svelte";
  import CommentReportButton from "$lib/components/moderation/CommentReportButton.svelte";
  import { blockedUsernames, isBlockedIn } from "$lib/stores/blocks";
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
  export let focused = false;
  export let showOpenThread = false;

  const dispatch = createEventDispatcher();
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  let replyOpen = false;
  let reduceMotion = false;
  let sourceTitle: string | null = null;

  //Converse lists can be server-rendered without the reader's
  // session, so a blocked author's post is replaced here as well.
  $: hiddenByBlock = isBlockedIn($blockedUsernames, post.author.username);
  $: headline = getVisibleHeadline(post);
  $: sourceUrl = root ? getSourceUrl(post) : null;
  $: sourceIdentifier = root ? getSourceIdentifier(post) : null;
  $: avatarUrl = getAvatarUrl(post, apiBase);
  $: threadUrl = `/converse/${rootUuid}#comment-${post.uuid}`;
  // `::embed[]` of a zPage / converse thread: the page's ONE
  // resolver, as the VIEWER. A server-rendered post's cards arrive in the
  // page's seed (identical SSR and hydration); a post loaded in the browser
  // is resolved there, deduped across the page and inside its budget.
  const firstPartyCards = useFirstPartyCards();
  // Primitives, so each statement re-runs only when ITS value changes: a
  // card landing elsewhere on the page re-renders nothing here (review F3).
  $: cardGeneration = $firstPartyCards.generation;
  $: firstPartyCards.request(post.content, undefined, cardGeneration);
  $: cardSignature = firstPartyCards.signature(post.content, $firstPartyCards);
  $: content = processMarkdown(post.content, {
    firstPartyCards: firstPartyCards.cardsFor(post.content, cardSignature),
  });

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

{#if hiddenByBlock}
  <p
    id={`comment-${post.uuid}`}
    class="rounded-lg border border-dashed border-border/60 px-3 py-2 text-sm text-muted-foreground"
    data-testid="comment-blocked"
  >
    {$t(
      "moderation.block.hiddenComment",
      "Comment hidden because you blocked @{username}.",
      { username: post.author.username },
    )}
  </p>
{:else}
  <article
    id={`comment-${post.uuid}`}
    class={focused && !root
      ? "-m-2 scroll-mt-24 rounded-xl bg-primary/5 p-2 ring-1 ring-primary/25"
      : "scroll-mt-24"}
  >
    <!-- A badge only when it says something the card does not. "Started in
       Converse", stamped on every native post of a page called Converse, was
       a label for a fact the reader already had; the two survivors are the
       zPage a comment came from, and the fact that a card in the firehose is
       a reply rather than a root. -->
    {#if root && (sourceUrl || post.parent)}
      <div
        class="mb-3 flex flex-wrap items-center gap-2 {showOpenThread
          ? 'pr-6'
          : ''}"
      >
        {#if sourceUrl}
          <Badge
            href={sourceUrl}
            variant="outline"
            class="max-w-full cursor-pointer font-normal [a&]:hover:bg-transparent [a&]:hover:text-primary"
          >
            <span class="text-muted-foreground">
              {$t("converse.zpage", "zPage")}
            </span>
            <span class="text-muted-foreground/60" aria-hidden="true">·</span>
            <span>
              {sourceTitle || sourceIdentifier || $t("converse.zpage", "zPage")}
            </span>
          </Badge>
        {:else if post.parent}
          <!-- The stream view renders replies as top-level cards too, so this
             branch has to tell the truth about what the card is. In the
             thread/detail views `root` is only ever set on an actual root,
             which has no parent, so their badge is unchanged. -->
          <Badge variant="secondary" class="font-normal">
            {$t("converse.replyInThread", "Reply in Converse")}
          </Badge>
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
        <div
          class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 {showOpenThread &&
          !(root && (sourceUrl || post.parent))
            ? 'pr-6'
            : ''}"
        >
          <a
            href={`/${post.author.username}`}
            class="truncate text-sm font-semibold text-foreground hover:text-primary"
          >
            {post.author.username}
          </a>
          <span class="text-muted-foreground/50" aria-hidden="true">·</span>
          <a
            href={threadUrl}
            class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            title={formatPostDate(post.created_at, $locale)}
          >
            <Clock3 strokeWidth={1.5} class="size-3" />
            {formatRelativePostDate(post.created_at, $locale)}
          </a>
          <!-- The outer card anchors this link. Absolute positioning keeps
             it out of the byline's wrapping flow without changing tab order. -->
          {#if showOpenThread}
            <Button
              href={`/converse/${rootUuid}`}
              variant="ghost"
              size="icon-sm"
              class="absolute top-2 right-2 size-7 shrink-0 bg-transparent text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
              title={$t("converse.openThread", "Open thread")}
              aria-label={$t("converse.openThread", "Open thread")}
            >
              <ArrowUpRight strokeWidth={1.5} class="size-4" />
            </Button>
          {/if}
        </div>

        <div class={root ? "mt-3" : "mt-2"}>
          <!-- Always an h2. The page's single h1 is the thread's derived title
             (`converse/[uuid]/+page.svelte`), which exists whether or not this
             historic post happens to carry a headline — a heading level that
             appears only for some rows is not a document outline. -->
          {#if headline}
            <h2 class="mb-2 text-sm leading-relaxed font-bold text-foreground">
              {headline}
            </h2>
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
          <CommentReportButton
            commentUuid={post.uuid}
            authorUsername={post.author.username}
          />
        </div>

        {#if replyOpen}
          <div
            class="mt-3"
            transition:slide={{ duration: reduceMotion ? 0 : 180 }}
          >
            <ConverseComposer
              parent={post.uuid}
              parentContentUrl={post.content_url}
              threadAccess={post.thread_access}
              threadAccessOwnerId={post.thread_access_owner_id}
              compact={true}
              on:posted={handlePosted}
            />
          </div>
        {/if}
      </div>
    </div>
  </article>
{/if}
