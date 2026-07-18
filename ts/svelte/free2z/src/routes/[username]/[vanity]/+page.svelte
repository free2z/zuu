<script lang="ts">
  import { goto } from "$app/navigation";
  import { env } from "$env/dynamic/public";
  import { Button } from "$lib/components/ui/button";
  import type { PageData } from "./$types";
  import { tStore as t, loading } from "$lib/i18n";
  import { processMarkdown } from "$lib/utils/markdown";
  import { buildZPageMeta } from "$lib/meta";
  import PageActions from "$lib/components/zpageActions/PageActions.svelte";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import DisplayThreadedComments from "$lib/components/comments/DisplayThreadedComments.svelte";
  import CommentForm from "$lib/components/comments/CommentForm.svelte";

  export let data: PageData;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  let pageMeta = buildZPageMeta(undefined);
  let jsonLdString: string | null = null;

  $: article = data.article;
  $: processedContent = article?.content
    ? processMarkdown(article.content)
    : "";

  let reloadComments = 0;

  function handleCommentSuccess() {
    reloadComments++;
  }

  function buildImageUrl() {
    const image =
      article?.featured_image?.url || article?.featured_image?.thumbnail;
    if (!image) return null;
    if (/^https?:\/\//.test(image)) return image;
    return `${apiBase}${image.startsWith("/") ? "" : "/"}${image}`;
  }

  function buildAvatarUrl() {
    const avatar =
      article?.creator?.avatar_image?.url ||
      article?.creator?.avatar_image?.thumbnail;
    if (!avatar) return null;
    if (/^https?:\/\//.test(avatar)) return avatar;
    return `${apiBase}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
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
  $: avatarUrl = buildAvatarUrl();
  $: authorName = buildAuthorName();
  $: createdDate = formatDate(article?.created_at);
  $: updatedDate = formatDate(article?.updated_at);
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

<main class="flex flex-1 flex-col bg-background text-foreground">
  <!-- Back Button -->
  <div class="p-4 pt-4">
    <Button variant="ghost" size="sm" onclick={goBack}>
      {!$loading ? $t("common.article.backToHome") : "← Back to Stories"}
    </Button>
  </div>

  <!-- Above the Fold: Hero Section -->
  <section class="border-b border-border bg-card">
    <div
      class="mx-auto grid min-h-auto max-w-7xl grid-cols-1 gap-8 p-4 md:min-h-[70vh] md:grid-cols-2 md:gap-12 md:p-8"
    >
      <!-- Left: Large Hero Image -->
      <div
        class="flex h-[300px] items-center justify-center overflow-hidden rounded-lg bg-muted md:h-auto"
      >
        {#if imageUrl}
          <img
            src={imageUrl}
            alt={article?.title}
            class="block h-full w-full object-cover"
          />
        {:else}
          <div
            class="flex h-full w-full items-center justify-center text-6xl text-muted-foreground"
          >
            <span>📄</span>
          </div>
        {/if}
      </div>

      <!-- Right: Title and Meta Info -->
      <div class="flex flex-col justify-center gap-5">
        <h1
          class="m-0 text-3xl leading-tight font-bold text-foreground md:text-4xl"
        >
          {article?.title}
        </h1>

        <div class="my-0 border-y border-border py-4">
          <a
            class="group flex items-center gap-3 text-inherit no-underline transition-all duration-150 ease-in hover:text-secondary hover:underline focus:rounded-md focus:text-secondary focus:underline focus:outline-2 focus:outline-offset-3 focus:outline-primary"
            href={"/" + (article?.creator?.username || "")}
            rel="author"
            title={`View ${authorName}'s profile`}
          >
            {#if avatarUrl}
              <img
                src={avatarUrl}
                alt={authorName}
                class="h-12 w-12 rounded-full object-cover"
              />
            {:else}
              <div
                class="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground"
              >
                {authorName.charAt(0).toUpperCase()}
              </div>
            {/if}
            <div class="flex-1">
              <span
                class="block text-lg font-semibold text-primary transition-colors group-hover:text-secondary group-focus:text-secondary"
                >{authorName}</span
              >
              <div class="mt-1 flex flex-col gap-1">
                <span class="text-sm text-muted-foreground"
                  >Created: {createdDate}</span
                >
                {#if updatedDate !== createdDate}
                  <span class="text-sm text-muted-foreground"
                    >Updated: {updatedDate}</span
                  >
                {/if}
              </div>
            </div>
          </a>
        </div>

        {#if article?.description}
          <p class="m-0 text-lg leading-relaxed text-muted-foreground">
            {article.description}
          </p>
        {/if}

        <!-- Article Stats -->
        <div
          class="flex flex-col flex-wrap gap-3 text-sm text-muted-foreground md:flex-row md:gap-4"
        >
          {#if article?.total_raised}
            <span class="flex items-center gap-2"
              >💰 ${article.total_raised} raised</span
            >
          {/if}
          {#if article?.f2z_score}
            <span class="flex items-center gap-2"
              >⭐ {Number(article.f2z_score).toFixed(2)} score</span
            >
          {/if}
          {#if article?.category}
            <span
              class="flex items-center gap-2 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground"
              >{article.category}</span
            >
          {/if}
        </div>
      </div>
    </div>
  </section>

  <!-- Below the Fold: Article Content -->
  <section class="py-12">
    <div class="mx-auto max-w-[800px] px-4">
      <!-- Article Content -->
      <article
        class="prose mb-12 max-w-none prose-zinc dark:prose-invert prose-a:text-primary prose-a:no-underline hover:prose-a:text-primary/80 hover:prose-a:underline"
      >
        {#if processedContent}
          <MarkdownContent html={processedContent} />
        {:else}
          <p class="py-5 text-center text-muted-foreground italic">
            No content available for this article.
          </p>
        {/if}
      </article>

      <!-- Tags -->
      {#if article?.tags && article.tags.length > 0}
        <div class="mb-12 border-t border-border pt-6">
          <h3 class="m-0 mb-4 text-xl font-bold text-foreground">Tags</h3>
          <div class="flex flex-wrap gap-2">
            {#each article.tags as tag}
              <span
                class="rounded border border-border bg-muted px-2 py-1 text-sm text-foreground"
                >{tag}</span
              >
            {/each}
          </div>
        </div>
      {/if}

      <!-- Comments Section -->
      <div class="mb-12 border-t border-border pt-6">
        <h3 class="m-0 mb-4 text-xl font-bold text-foreground">
          {!$loading ? $t("common.article.comments") : "Comments"}
        </h3>

        <div class="mb-8">
          <CommentForm
            object_type="zpage"
            object_uuid={article?.free2zaddr}
            callback={handleCommentSuccess}
          />
        </div>

        <DisplayThreadedComments
          object_type="zpage"
          object_uuid={article?.free2zaddr}
          reload={reloadComments}
        />
      </div>

      <!-- Related Articles Placeholder -->
      <div class="mb-12 border-t border-border pt-6">
        <h3 class="m-0 mb-4 text-xl font-bold text-foreground">
          {!$loading
            ? $t("common.article.relatedArticles")
            : "Related Articles"}
        </h3>
        <p class="py-5 text-center text-muted-foreground italic">
          {!$loading
            ? $t("common.article.comingSoon")
            : "Related articles coming soon..."}
        </p>
      </div>
    </div>
  </section>
</main>

<!-- Floating Action Button -->
<PageActions {article} />
