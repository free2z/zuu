<script lang="ts">
  import { goto } from "$app/navigation";
  import { env } from "$env/dynamic/public";
  import { Button } from "$lib/components/ui/button";
  import type { PageData } from "./$types";
  import { buildZPageMeta } from "$lib/meta";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import { processMarkdown } from "$lib/utils/markdown";

  type ArticleCreatorWithName = PageData["article"]["creator"] & {
    full_name?: string;
  };
  type ArticleWithExtras = PageData["article"] & {
    teaser?: string;
    vote_count?: number;
    comment_count?: number;
    creator?: ArticleCreatorWithName;
  };

  export let data: PageData;
  let article: ArticleWithExtras;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  let pageMeta;
  let jsonLdString: string | null;

  $: article = data.article as ArticleWithExtras;
  $: processedContent = article?.content
    ? processMarkdown(article.content)
    : "";

  function buildImageUrl() {
    const image =
      article?.featured_image?.url || article?.featured_image?.thumbnail;
    if (!image) return null;
    if (/^https?:\/\//.test(image)) return image;
    return `${apiBase}${image.startsWith("/") ? "" : "/"}${image}`;
  }

  function formatDate(dateString: string) {
    if (!dateString) return "";
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return dateString;
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (error) {
      return dateString;
    }
  }

  function buildAuthorName() {
    const creator = article?.creator;
    return creator?.full_name || creator?.username || "Unknown Author";
  }

  function goBack() {
    goto("/");
  }

  $: imageUrl = buildImageUrl();
  $: authorName = buildAuthorName();
  $: publishDate = formatDate(article?.created_at);
  $: pageMeta = buildZPageMeta(article);
  $: jsonLdString = pageMeta.jsonLdString ?? null;
</script>

<svelte:head>
  <title>{pageMeta.title}</title>
  {#if pageMeta.canonical}
    <link rel="canonical" href={pageMeta.canonical} />
  {/if}
  {#each pageMeta.tags as tag}
    <meta {...tag.props} />
  {/each}
  {#if jsonLdString}
    {@html `<script type="application/ld+json">${jsonLdString}</script>`}
  {/if}
</svelte:head>

<main class="min-h-screen bg-background text-foreground">
  <div class="mx-auto max-w-3xl px-4 py-12 sm:px-6">
    <!-- Back Button -->
    <div class="mb-12">
      <Button variant="ghost" size="sm" onclick={goBack}>
        ← Back to Stories
      </Button>
    </div>

    <!-- Article Header -->
    <header class="mb-12">
      <h1 class="mb-6 text-4xl leading-tight font-bold sm:text-5xl">
        {article?.title}
      </h1>

      <div
        class="mb-6 flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:gap-4"
      >
        <a
          class="rounded font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:outline-none"
          href={"/" + (article?.creator?.username || "")}
          rel="author"
          title={"View " + authorName + "'s profile"}
        >
          {authorName}
        </a>
        <span class="hidden sm:inline">•</span>
        <span>{publishDate}</span>
      </div>

      {#if article?.teaser}
        <p class="text-lg leading-relaxed text-muted-foreground italic">
          {article.teaser}
        </p>
      {/if}
    </header>

    <!-- Featured Image -->
    {#if imageUrl}
      <div class="mb-12 overflow-hidden rounded-lg">
        <img class="block h-auto w-full" src={imageUrl} alt={article?.title} />
      </div>
    {/if}

    <!-- Article Content -->
    <article class="prose prose-lg mb-12 max-w-none dark:prose-invert">
      {#if processedContent}
        <MarkdownContent html={processedContent} />
      {:else}
        <p class="py-16 text-center text-muted-foreground italic">
          No content available for this article.
        </p>
      {/if}
    </article>

    <!-- Article Footer -->
    <footer class="border-t border-border pt-8">
      <div
        class="flex flex-col gap-4 text-sm text-muted-foreground sm:flex-row sm:gap-8"
      >
        {#if article?.vote_count}
          <span class="flex items-center gap-2"
            >👍 {article.vote_count} votes</span
          >
        {/if}
        {#if article?.comment_count}
          <span class="flex items-center gap-2"
            >💬 {article.comment_count} comments</span
          >
        {/if}
      </div>
    </footer>
  </div>
</main>
