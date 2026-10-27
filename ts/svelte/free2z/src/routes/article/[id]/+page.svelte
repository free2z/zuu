<script lang="ts">
  import { formatDate as formatApiDate } from "$lib/utils/date";
  import { goto } from "$app/navigation";
  import * as env from "$app/env/public";
  import { onDestroy } from "svelte";
  import {
    isSingularCount,
    locale,
    setDocumentContentLanguage,
    tStore as t,
    type TranslationFunction,
  } from "$lib/i18n";
  import {
    contentDirectionAttribute,
    normalizeContentLanguage,
  } from "$lib/zpage-language.js";
  import { Button } from "$lib/components/ui/button";
  import type { PageData } from "./$types";
  import { buildZPageMeta } from "$lib/meta";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";
  import ProfileSubscribe from "$lib/components/profile/ProfileSubscribe.svelte";
  import { processMarkdown } from "$lib/utils/markdown";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";
  import { buildVideoPosterMap } from "$lib/utils/embedded-media";
  import { LockKeyhole } from "@lucide/svelte";

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
  // The language this article is actually written in. `hooks.server.ts` renders
  // `<html lang>` from the server's answer; this keeps it true after hydration
  // and across a client-side navigation, where `setLocale` would otherwise hand
  // the attribute back to the UI locale (codex adversarial review).
  $: articleContentLanguage =
    normalizeContentLanguage((article as any)?.actual_language) ?? undefined;
  // Which way that language runs, from its script  — and `lang`/`dir` are
  // independent attributes, so  labelling an Arabic variant correctly left
  // it laid out left-to-right. Content only: `<html dir>` stays the
  // chrome's, which is the reader's UI locale and not this article's language
  // ( P8). `contentDirectionAttribute` so an unknown language becomes
  // `dir="auto"` rather than an omitted attribute.
  $: articleContentDirection = contentDirectionAttribute(
    (article as any)?.actual_language,
  );
  $: setDocumentContentLanguage(articleContentLanguage ?? null);
  onDestroy(() => setDocumentContentLanguage(null));
  // Same media list the JSON-LD reads, so the poster on the player and the
  // `thumbnailUrl` in the structured data cannot diverge.
  $: videoPosters = buildVideoPosterMap((article as any)?.media);
  // The article's own cards also seed the page resolver: a comment
  // embedding the same page reuses the server's answer, and the server's
  // calls count against the one page budget.
  const pageFirstPartyCards = useFirstPartyCards();
  $: pageFirstPartyCards.seed(data.firstPartyCardSeed);
  $: processedContent = article?.content
    ? processMarkdown(article.content, {
        videoPosters,
        firstPartyCards: data.firstPartyCards,
      })
    : "";

  function buildImageUrl() {
    const image =
      article?.featured_image?.url || article?.featured_image?.thumbnail;
    if (!image) return null;
    if (/^https?:\/\//.test(image)) return image;
    return `${apiBase}${image.startsWith("/") ? "" : "/"}${image}`;
  }

  function formatDate(dateString: string, currentLocale: string) {
    return formatApiDate(dateString, currentLocale, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  function buildAuthorName(translate: TranslationFunction) {
    const creator = article?.creator;
    return (
      creator?.full_name ||
      creator?.username ||
      translate("common.article.unknownAuthor", "Unknown author")
    );
  }

  function formatCount(value: number) {
    return value.toLocaleString($locale);
  }

  function goBack() {
    goto("/");
  }

  $: imageUrl = buildImageUrl();
  $: authorName = buildAuthorName($t);
  $: publishDate = formatDate(article?.created_at, $locale);
  $: pageMeta = buildZPageMeta(article, { translate: $t });
  $: jsonLdString = pageMeta.jsonLdString ?? null;
  // Keep this split: svelte-eslint-parser mistakes a literal closing script
  // tag in the JSON-LD expression for the end of this component's script block.
  const jsonLdClosingTag = "</" + "script>";
</script>

<svelte:head>
  <title>{pageMeta.title}</title>
  {#if pageMeta.canonical}
    <link rel="canonical" href={pageMeta.canonical} />
  {/if}
  <!-- One entry per published variant, closing with `x-default` on the clean
       URL that negotiates. `buildZPageMeta` has computed these all along and
       this route simply never rendered them, so the immutable `/article/<id>`
       URL declared a canonical with no cluster around it — and the
       `<head>` is the AUTHORITATIVE hreflang carrier: past
       `SITEMAP_MAX_BYTES_PER_ZPAGE` per article the sitemap deliberately stops
       repeating the cluster and relies on exactly this markup. It has to be in
       the server-rendered HTML, which `<svelte:head>` gives us; a crawler does
       not run hydration. -->
  {#each pageMeta.alternates as alternate}
    <link rel="alternate" hreflang={alternate.hreflang} href={alternate.href} />
  {/each}
  <!-- Explicit attributes, not `{...tag.props}`: a spread makes Svelte stamp a
       scoped-style class onto every `<meta>`. See the sibling comment in
       `[username]/[vanity]/+page.svelte`. This route has no `<style>` block
       today, so it emits clean tags either way — keeping the two head blocks
       identical is what stops one from regressing when a style is added. -->
  {#each pageMeta.tags as tag}
    {#if tag.props.property}
      <meta property={tag.props.property} content={tag.props.content} />
    {:else}
      <meta name={tag.props.name} content={tag.props.content} />
    {/if}
  {/each}
  {#if jsonLdString}
    {@html `<script type="application/ld+json">${jsonLdString}${jsonLdClosingTag}`}
  {/if}
</svelte:head>

<main class="min-h-screen bg-background text-foreground">
  <div class="mx-auto max-w-3xl px-4 py-12 sm:px-6">
    <!-- Back Button -->
    <div class="mb-12">
      <Button variant="ghost" size="sm" onclick={goBack}>
        {$t("common.article.backToHome", "Back to Homepage")}
      </Button>
    </div>

    <!-- Article Header -->
    <header class="mb-12">
      <h1
        lang={articleContentLanguage}
        dir={articleContentDirection}
        data-content-lang={articleContentLanguage}
        class="mb-6 text-4xl leading-tight font-bold sm:text-5xl"
      >
        {article?.title}
      </h1>

      <div
        class="mb-6 flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:gap-4"
      >
        <a
          class="rounded font-medium text-primary transition-colors hover:text-primary/80 hover:underline focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:outline-none"
          href={"/" + (article?.creator?.username || "")}
          rel="author"
          title={$t("common.article.viewProfile", "View {name}'s profile", {
            name: authorName,
          })}
        >
          <!-- Arbitrary user text in an LTR byline, isolated from it.
               The bullet and the date are separate flex items here, so nothing
               measurably reorders in today's markup; this is the correct
               construction for the moment one of them moves into the same
               inline run. -->
          <bdi>{authorName}</bdi>
        </a>
        <span class="hidden sm:inline">•</span>
        <span>{publishDate}</span>
      </div>

      {#if article?.teaser}
        <p
          lang={articleContentLanguage}
          dir={articleContentDirection}
          data-content-lang={articleContentLanguage}
          class="text-lg leading-relaxed text-muted-foreground italic"
        >
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
    {#if data.gated}
      <section
        class="mb-12 rounded-lg border border-border bg-muted/30 px-5 py-10 text-center sm:px-10"
        aria-labelledby="subscriber-gate-title"
      >
        <div
          class="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10"
        >
          <LockKeyhole class="size-6 text-primary" />
        </div>
        <h2
          id="subscriber-gate-title"
          class="mt-5 text-2xl font-semibold tracking-tight"
        >
          Subscriber-only story
        </h2>
        <p
          class="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground"
        >
          Subscribe to @<bdi>{article?.creator?.username}</bdi> to read this story
          and support their ongoing work.
        </p>
        <div class="mt-6 flex justify-center">
          <ProfileSubscribe creator={article.creator} />
        </div>
      </section>
    {:else}
      <article
        lang={articleContentLanguage}
        dir={articleContentDirection}
        data-content-lang={articleContentLanguage}
        class="prose prose-lg mb-12 max-w-none dark:prose-invert"
      >
        {#if processedContent}
          <MarkdownContent html={processedContent} />
        {:else}
          <p class="py-16 text-center text-muted-foreground italic">
            {$t(
              "common.article.noContent",
              "No content is available for this article.",
            )}
          </p>
        {/if}
      </article>
    {/if}

    <!-- Article Footer -->
    <footer class="border-t border-border pt-8">
      <div
        class="flex flex-col gap-4 text-sm text-muted-foreground sm:flex-row sm:gap-8"
      >
        {#if article?.vote_count}
          <span class="flex items-center gap-2"
            >👍 {isSingularCount(article.vote_count, $locale)
              ? $t("article.voteCountOne", "{count} vote", {
                  count: formatCount(article.vote_count),
                })
              : $t("article.voteCountMany", "{count} votes", {
                  count: formatCount(article.vote_count),
                })}
          </span>
        {/if}
        {#if article?.comment_count}
          <span class="flex items-center gap-2"
            >💬 {isSingularCount(article.comment_count, $locale)
              ? $t("article.commentCountOne", "{count} comment", {
                  count: formatCount(article.comment_count),
                })
              : $t("article.commentCountMany", "{count} comments", {
                  count: formatCount(article.comment_count),
                })}
          </span>
        {/if}
      </div>
    </footer>
  </div>
</main>
