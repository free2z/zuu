<script lang="ts">
  import type { PageData } from "./$types";
  import { ConverseThread } from "$lib/components/converse";
  import {
    deriveConverseTitle,
    getAvatarUrl,
  } from "$lib/components/converse/utils";
  import { Button } from "$lib/components/ui/button";
  import { ArrowLeft, ArrowUp } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";
  import SeoHead from "$lib/components/SeoHead.svelte";

  export let data: PageData;

  // The server resolved the `::embed[]` cards of what it rendered, as this
  // reader; hand them to the page's resolver so hydration renders
  // exactly the server's markup and the browser does not repeat those calls.
  const firstPartyCards = useFirstPartyCards();
  $: firstPartyCards.seed(data.firstPartyCardSeed);

  $: comment = data.comment;
  $: focusUuid = data.focusUuid;
  //the server walks at most a bounded stretch of the reply chain. When
  // it stopped short of the root, this is the parent of what it rendered; that
  // page walks the next stretch up.
  $: earlierUuid = data.earlierUuid;
  // Historic posts keep their headline; everything written since the composer
  // stopped asking for one is named by its opening line instead. The literal
  // word "Conversation" is the last resort only — as the title of every
  // untitled thread it made identical browser tabs and identical share cards.
  $: displayTitle =
    deriveConverseTitle(comment) || $t("converse.conversation", "Conversation");
  $: description = (comment?.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  //link unfurlers reach this page since the Django card tier
  // (comments/social.html) was retired, and that template carried og:image,
  // twitter:card and the rest. SeoHead is the one place every other public
  // page gets them from. The author's avatar is the card image, as it was on
  // the Django tier; the house card when there is none. Relative avatar paths
  // (`/uploadz/...`) are made absolute by SeoHead.
  $: cardImage = comment?.author ? getAvatarUrl(comment, "") : undefined;
</script>

<SeoHead
  title={`${displayTitle} • Free2Z`}
  {description}
  type="article"
  image={cardImage}
  imageAlt={displayTitle}
/>

<main class="flex-1 bg-background pb-20 text-foreground">
  <div class="container mx-auto max-w-3xl space-y-5 px-3 py-6 sm:px-4 sm:py-8">
    <!-- A back link and the thread. The banner that used to sit here
         announced "Conversation thread" and invited the reader to "add your
         perspective" above a page that is visibly a conversation thread with
         a reply box in it. The heading survives as the page's accessible
         name, carrying the thread's own title rather than a category. -->
    <header>
      <h1 class="sr-only">{displayTitle}</h1>
      <Button
        variant="ghost"
        size="sm"
        href="/converse"
        class="-ml-2 text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
      >
        <ArrowLeft strokeWidth={1.5} class="size-4" />
        {$t("converse.title", "Converse")}
      </Button>
    </header>

    {#if earlierUuid}
      <a
        href={`/converse/${earlierUuid}`}
        class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
        data-testid="converse-view-earlier"
      >
        <ArrowUp strokeWidth={1.5} class="size-4" />
        {$t("converse.viewEarlier", "View earlier replies")}
      </a>
    {/if}

    <ConverseThread post={comment} mode="detail" {focusUuid} />
  </div>
</main>
