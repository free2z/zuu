<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { env } from "$env/dynamic/public";
  import { toast } from "svelte-sonner";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import { Coins, Eye, Info, Loader2, Send, X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Textarea } from "$lib/components/ui/textarea";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import { tStore as t } from "$lib/i18n";

  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;
  export let parent: string | undefined = undefined;
  export let callback: (() => void) | undefined = undefined;
  export let mode: "comment" | "conversation" = "comment";

  let headline = "";
  let content = "";
  let tuzis = 1;
  let preview = false;
  let submitting = false;
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  const dispatch = createEventDispatcher();

  $: isConversation = mode === "conversation" && !parent;
  $: canSubmit =
    content.trim().length > 0 &&
    (!isConversation || headline.trim().length > 0) &&
    Number.isInteger(tuzis) &&
    tuzis >= 1 &&
    tuzis <= 10000 &&
    !submitting;
  $: processedContent = processMarkdown(content);

  async function handleSubmit() {
    if (!canSubmit) return;

    if (tuzis < 1 || tuzis > 10000 || !Number.isInteger(tuzis)) {
      toast.error(
        $t(
          "comments.tuzisRangeError",
          "Tuzis must be a whole number between 1 and 10000",
        ),
      );
      return;
    }

    let url = "";
    if (object_type && object_uuid) {
      url = `/api/comments/${object_type}/${object_uuid}/`;
    } else if (parent) {
      url = `/api/comments/${parent}/replies/`;
    } else {
      url = "/api/comments/";
    }

    submitting = true;

    try {
      const hasActiveSession = await authStore.ensureAuthenticated();
      if (!hasActiveSession || !$currentUser) {
        toast.error($t("comments.loginToComment", "Please log in to comment"));
        submitting = false;
        return;
      }

      const csrf = await authStore.ensureCSRFToken();
      const res = await fetch(`${apiBase}${url}`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRFToken": csrf } : {}),
        },
        body: JSON.stringify({
          headline: isConversation ? headline.trim() : "N/A",
          content: content.trim(),
          tuzis,
          parent,
        }),
      });

      if (!res.ok) {
        if (authStore.handleAuthFailure(res.status)) {
          throw new Error(
            $t("comments.loginToComment", "Please log in to comment"),
          );
        }

        let errorMessage = $t(
          "comments.postCommentError",
          "Failed to post comment",
        );
        try {
          const contentType = res.headers.get("content-type");
          if (contentType?.includes("application/json")) {
            const data = await res.json();
            if (typeof data === "string") {
              errorMessage = data;
            } else if (data?.error || data?.message || data?.detail) {
              errorMessage = data.error || data.message || data.detail;
            } else if (Array.isArray(data?.errors) && data.errors.length > 0) {
              errorMessage = data.errors[0];
            } else if (data?.errors && typeof data.errors === "object") {
              const firstKey = Object.keys(data.errors)[0];
              const firstError = firstKey ? data.errors[firstKey]?.[0] : null;
              if (firstError) errorMessage = firstError;
            }
          } else {
            errorMessage = $t(
              "comments.serverError",
              "Server error: {status} {statusText}",
            )
              .replace("{status}", String(res.status))
              .replace("{statusText}", res.statusText);
          }
        } catch (error) {
          console.error("Error parsing comment response:", error);
        }
        throw new Error(errorMessage);
      }

      headline = "";
      content = "";
      tuzis = 1;
      preview = false;

      callback?.();
      dispatch("success");
      toast.success(
        isConversation
          ? $t("converse.conversationPosted", "Conversation published")
          : $t("comments.commentPosted", "Comment posted!"),
      );
    } catch (error: any) {
      console.error(error);
      toast.error(
        error.message ||
          $t("comments.postCommentError", "Failed to post comment"),
      );
    } finally {
      submitting = false;
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
    <Button
      href="/?login=true"
      variant="outline"
      size="sm"
      class="w-full sm:w-auto"
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
          {isConversation
            ? $t("converse.startConversation", "Start a conversation")
            : $t("comments.joinDiscussion", "Join the discussion")}
        </span>
        <span class="hidden text-xs text-muted-foreground sm:inline">
          {$t("comments.markdownSupported", "Markdown supported")}
        </span>
      </div>
    {/if}

    <div class="space-y-3 p-3 sm:p-4">
      {#if isConversation}
        <div>
          <label for="conversation-headline" class="sr-only">
            {$t("converse.titleLabel", "Conversation title")}
          </label>
          <Input
            id="conversation-headline"
            type="text"
            bind:value={headline}
            placeholder={$t(
              "converse.titlePlaceholder",
              "Give your conversation a clear title",
            )}
            maxlength={100}
            class="h-11 bg-background text-base font-semibold placeholder:font-normal"
          />
        </div>
      {/if}

      <div class="relative">
        <label
          for={parent ? `reply-${parent}` : "comment-content"}
          class="sr-only"
        >
          {isConversation
            ? $t("converse.bodyLabel", "Conversation")
            : $t("comments.content", "Content")}
        </label>
        <Textarea
          id={parent ? `reply-${parent}` : "comment-content"}
          bind:value={content}
          placeholder={isConversation
            ? $t(
                "converse.bodyPlaceholder",
                "Share an idea, ask a question, or start a thoughtful discussion…",
              )
            : parent
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
            <span>
              {isConversation
                ? $t("converse.publish", "Publish conversation")
                : $t("comments.post", "Post")}
            </span>
          {/if}
        </Button>
      </div>
    </div>
  </div>
{/if}
