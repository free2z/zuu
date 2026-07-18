<script lang="ts">
  import type { PageData } from "./$types";
  import { ConverseThread } from "$lib/components/converse";
  import { Button } from "$lib/components/ui/button";
  import { ArrowLeft, MessagesSquare } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";

  export let data: PageData;

  $: comment = data.comment;
  $: focusUuid = data.focusUuid;
  $: rawHeadline = comment?.headline?.trim() || "";
  $: displayTitle =
    rawHeadline && !["n/a", "re"].includes(rawHeadline.toLowerCase())
      ? rawHeadline
      : $t("converse.conversation", "Conversation");
  $: description = (comment?.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
</script>

<svelte:head>
  <title>{displayTitle} • Free2Z</title>
  <meta name="description" content={description} />
  <meta property="og:title" content={`${displayTitle} • Free2Z`} />
  <meta property="og:description" content={description} />
  <meta property="og:type" content="article" />
</svelte:head>

<main class="flex-1 bg-background pb-20 text-foreground">
  <div class="container mx-auto max-w-3xl space-y-5 px-3 py-6 sm:px-4 sm:py-8">
    <header class="border-b border-border/70 pb-5">
      <Button
        variant="ghost"
        size="sm"
        href="/converse"
        class="-ml-2 text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
      >
        <ArrowLeft strokeWidth={1.5} class="size-4" />
        {$t("converse.allConversations", "All conversations")}
      </Button>

      <div class="mt-4 flex items-start gap-3">
        <div
          class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
        >
          <MessagesSquare strokeWidth={1.5} class="size-4" />
        </div>
        <div>
          <h1 class="text-xl font-semibold tracking-tight text-balance">
            {$t("converse.threadTitle", "Conversation thread")}
          </h1>
          <p class="mt-0.5 text-sm text-muted-foreground">
            {$t(
              "converse.threadSubtitle",
              "Read the full discussion or add your perspective.",
            )}
          </p>
        </div>
      </div>
    </header>

    <ConverseThread post={comment} mode="detail" {focusUuid} />
  </div>
</main>
