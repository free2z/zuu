<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { env } from "$env/dynamic/public";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { processMarkdown } from "$lib/utils/markdown";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import { toast } from "svelte-sonner";
  import {
    Coins,
    Eye,
    Loader2,
    MessageSquareReply,
    Send,
  } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";

  export let parent: string | undefined = undefined;
  export let replyingTo: string | undefined = undefined;
  export let compact = false;

  const dispatch = createEventDispatcher();
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  let headline = "";
  let content = "";
  let tuzis = 1;
  let preview = false;
  let submitting = false;

  $: isReply = Boolean(parent);
  $: canSubmit =
    content.trim().length > 0 &&
    (isReply || headline.trim().length > 0) &&
    Number.isInteger(tuzis) &&
    tuzis >= 1 &&
    tuzis <= 10000 &&
    !submitting;
  $: processedContent = processMarkdown(content);

  async function submit() {
    if (!canSubmit) return;

    const authenticated = await authStore.ensureAuthenticated();
    if (!authenticated || !$currentUser) {
      toast.error($t("comments.loginToComment", "Please log in to comment"));
      return;
    }

    submitting = true;
    try {
      const csrf = await authStore.ensureCSRFToken();
      const url = parent
        ? `/api/comments/${parent}/replies/`
        : "/api/comments/";
      const response = await fetch(`${apiBase}${url}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRFToken": csrf } : {}),
        },
        body: JSON.stringify({
          headline: isReply ? "N/A" : headline.trim(),
          content: content.trim(),
          tuzis,
          parent,
        }),
      });

      if (!response.ok) {
        if (authStore.handleAuthFailure(response.status)) {
          throw new Error(
            $t("comments.loginToComment", "Please log in to comment"),
          );
        }

        let message = $t("comments.postCommentError", "Failed to post comment");
        try {
          const data = await response.json();
          message = data?.error || data?.message || data?.detail || message;
        } catch {
          // Keep the friendly fallback message.
        }
        throw new Error(message);
      }

      const post = await response.json();
      headline = "";
      content = "";
      tuzis = 1;
      preview = false;
      dispatch("posted", { post });
      toast.success(
        isReply
          ? $t("converse.replyPosted", "Reply posted")
          : $t("converse.conversationPosted", "Conversation published"),
      );
    } catch (error: any) {
      console.error(error);
      toast.error(error?.message || "Could not publish your post");
    } finally {
      submitting = false;
    }
  }
</script>

{#if !$currentUser}
  <div
    class="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-4 sm:flex-row sm:items-center"
  >
    <div
      class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
    >
      <MessageSquareReply strokeWidth={1.5} class="size-5" />
    </div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-semibold text-foreground">
        {$t("converse.signInToJoin", "Sign in to join the conversation")}
      </p>
      <p class="mt-0.5 text-sm text-muted-foreground">
        {$t(
          "converse.signInHint",
          "Share a post, reply, or back an idea with 2Zs.",
        )}
      </p>
    </div>
    <Button
      href="/?login=true"
      size="sm"
      variant="outline"
      class="w-full sm:w-auto"
    >
      {$t("comments.signIn", "Sign in")}
    </Button>
  </div>
{:else}
  <form
    class={compact
      ? "rounded-xl border border-border/70 bg-background/70 p-3"
      : "rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-5"}
    on:submit|preventDefault={submit}
  >
    <div class="mb-3 flex items-center gap-2">
      <MessageSquareReply strokeWidth={1.5} class="size-4 text-primary" />
      <p class="text-sm font-semibold text-foreground">
        {isReply
          ? replyingTo
            ? $t("converse.replyingTo", "Replying to @{username}").replace(
                "{username}",
                replyingTo,
              )
            : $t("comments.reply", "Write a reply")
          : $t("converse.startPrompt", "Start a new conversation")}
      </p>
    </div>

    <div class="space-y-3">
      {#if !isReply}
        <div>
          <label for="converse-headline" class="sr-only">
            {$t("converse.titleLabel", "Conversation title")}
          </label>
          <Input
            id="converse-headline"
            bind:value={headline}
            maxlength={100}
            placeholder={$t(
              "converse.titlePlaceholder",
              "Give the conversation a clear title",
            )}
            class="border-0 bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
          />
          <div
            class="mt-1 text-right text-[11px] text-muted-foreground tabular-nums"
          >
            {headline.length}/100
          </div>
        </div>
      {/if}

      {#if preview}
        <div class="min-h-28 rounded-xl bg-muted/35 p-4">
          {#if content.trim()}
            <div class="prose prose-sm max-w-none dark:prose-invert">
              <MarkdownContent html={processedContent} />
            </div>
          {:else}
            <p class="text-sm text-muted-foreground">
              {$t("converse.previewEmpty", "Your preview will appear here.")}
            </p>
          {/if}
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
          bind:value={content}
          maxlength={1000}
          rows={compact ? 4 : 6}
          placeholder={isReply
            ? $t("converse.replyPlaceholder", "Add to the conversation…")
            : $t(
                "converse.bodyPlaceholder",
                "What do you want the community to discuss?",
              )}
          class="resize-y border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        />
      {/if}
    </div>

    <div
      class="mt-3 flex flex-col gap-3 border-t border-border/60 pt-3 sm:flex-row sm:items-center"
    >
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <Coins strokeWidth={1.5} class="size-4 shrink-0 text-primary" />
        <label
          for={isReply ? `reply-weight-${parent}` : "converse-weight"}
          class="text-xs text-muted-foreground"
        >
          {$t("converse.backWith", "Back with")}
        </label>
        <Input
          id={isReply ? `reply-weight-${parent}` : "converse-weight"}
          type="number"
          min={1}
          max={10000}
          step={1}
          bind:value={tuzis}
          class="h-8 w-20"
        />
        <span class="text-xs text-muted-foreground">2Zs</span>
        <span
          class="ml-auto text-[11px] text-muted-foreground tabular-nums sm:ml-2"
        >
          {content.length}/1000
        </span>
      </div>

      <div class="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onclick={() => (preview = !preview)}
          aria-pressed={preview}
        >
          <Eye strokeWidth={1.5} class="size-4" />
          {preview
            ? $t("converse.edit", "Edit")
            : $t("converse.preview", "Preview")}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {#if submitting}
            <Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
          {:else}
            <Send strokeWidth={1.5} class="size-4" />
          {/if}
          {isReply
            ? $t("comments.reply", "Reply")
            : $t("converse.publish", "Publish")}
        </Button>
      </div>
    </div>
  </form>
{/if}
