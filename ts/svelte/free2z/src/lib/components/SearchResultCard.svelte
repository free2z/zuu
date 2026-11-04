<script lang="ts">
  import { locale, tStore as t } from "$lib/i18n";
  import { formatRelativeTime } from "$lib/utils/date";
  import * as env from "$app/env/public";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Card, CardContent } from "$lib/components/ui/card";
  import { translateCategory } from "$lib/components/mdEditor/categoryNames";
  import TagChips from "$lib/components/TagChips.svelte";
  import { extractPlainText } from "$lib/utils/markdown";
  import { zpageCanonicalPath } from "$lib/zpage-path";

  export let article: any;

  // API base (remove trailing slash like other components)
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  // Build avatar URL
  function buildAvatarUrl(avatar: any): string {
    if (!avatar) return "";

    // Use the thumbnail if available, otherwise the main URL
    const imageUrl = avatar.thumbnail || avatar.url;
    if (!imageUrl) return "";

    // If the URL is already absolute, use it as-is
    if (/^https?:\/\//.test(imageUrl)) {
      return imageUrl;
    }

    // Otherwise prepend the API base URL and ensure single slash
    return `${apiBase}${imageUrl.startsWith("/") ? imageUrl : `/${imageUrl}`}`;
  }

  // Build featured image URL
  function buildFeaturedImageUrl(featuredImage: any): string {
    if (!featuredImage) return "";

    // Use the thumbnail if available, otherwise the main URL
    const imageUrl = featuredImage.thumbnail || featuredImage.url;
    if (!imageUrl) return "";

    // If the URL is already absolute, use it as-is
    if (/^https?:\/\//.test(imageUrl)) {
      return imageUrl;
    }

    // Otherwise prepend the API base URL and ensure single slash
    return `${apiBase}${imageUrl.startsWith("/") ? imageUrl : `/${imageUrl}`}`;
  }

  // Format article content for excerpt
  function getExcerpt(content: string, maxLength: number = 200): string {
    return extractPlainText(content, maxLength);
  }

  // Format date
  function formatDate(dateString: string, currentLocale: string): string {
    try {
      return formatRelativeTime(dateString, currentLocale);
    } catch {
      return dateString;
    }
  }

  function formatScore(value: unknown, currentLocale: string): string {
    return new Intl.NumberFormat(currentLocale, {
      maximumFractionDigits: 0,
    }).format(Number(value));
  }

  $: articleHref =
    zpageCanonicalPath(article || {}) ||
    article?.get_url?.replace("/zpage/", "/");

  $: avatarUrl = buildAvatarUrl(article?.creator?.avatar_image);
  $: featuredImageUrl = buildFeaturedImageUrl(article?.featured_image);
  $: excerpt = getExcerpt(article?.content || article?.description || "");
  $: createdDate = formatDate(article?.created_at, $locale);
  $: updatedDate = formatDate(article?.updated_at, $locale);
</script>

<Card
  class="block overflow-hidden rounded-xl text-inherit transition-colors duration-200 has-[a[aria-label]:hover]:border-primary"
>
  <CardContent class="p-4 md:p-6">
    <a
      href={articleHref}
      aria-label={$t("common.article.readArticle", "Read article: {title}", {
        title: article?.title || $t("editor.untitled", "Untitled"),
      })}
      class="block text-inherit no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <div
        class="grid grid-cols-1 items-start gap-4 md:grid-cols-[120px_1fr] md:gap-5 {!featuredImageUrl
          ? '!grid-cols-1'
          : ''}"
      >
        <!-- Featured Image (if available) -->
        {#if featuredImageUrl}
          <div
            class="-order-1 h-[150px] w-full shrink-0 overflow-hidden rounded-lg md:order-none md:h-[90px] md:w-[120px]"
          >
            <img
              src={featuredImageUrl}
              alt={article?.title || ""}
              loading="lazy"
              class="h-full w-full object-cover"
            />
          </div>
        {/if}

        <div class="min-w-0">
          <!-- Article Title -->
          <h3
            class="m-0 mb-3 line-clamp-2 text-lg leading-tight font-semibold text-foreground md:text-xl"
          >
            {article?.title || $t("editor.untitled", "Untitled")}
          </h3>

          <!-- Article Excerpt -->
          {#if excerpt}
            <p
              class="m-0 mb-4 line-clamp-3 leading-relaxed text-muted-foreground"
            >
              {excerpt}
            </p>
          {/if}

          <!-- Article Meta -->
          <div
            class="flex flex-col flex-wrap items-start gap-3 md:flex-row md:justify-between md:gap-4"
          >
            <!-- Author Info -->
            <div class="flex min-w-0 items-center gap-2 sm:gap-3">
              <Avatar.Root class="h-7 w-7 shrink-0 sm:h-8 sm:w-8">
                {#if avatarUrl}
                  <Avatar.Image
                    src={avatarUrl}
                    alt={article?.creator?.username ||
                      $t("common.article.author", "Author")}
                  />
                {/if}
                <Avatar.Fallback
                  class="bg-primary text-xs font-semibold text-primary-foreground sm:text-sm"
                >
                  {(article?.creator?.username || "A")[0].toUpperCase()}
                </Avatar.Fallback>
              </Avatar.Root>

              <div class="flex min-w-0 flex-col gap-1">
                <span class="text-sm font-medium text-foreground">
                  {$t("common.meta.createdBy")}
                  {article?.creator?.username || $t("common.meta.unknown")}
                </span>
                <span class="text-xs text-muted-foreground">
                  {#if article?.updated_at !== article?.created_at}
                    {$t("common.article.updatedOn")} {updatedDate}
                  {:else}
                    {$t("common.article.publishedOn")} {createdDate}
                  {/if}
                </span>
              </div>
            </div>

            <!-- Article Stats -->
            <div class="flex w-full flex-wrap items-center gap-2 md:w-auto">
              {#if article?.category}
                <Badge
                  variant="secondary"
                  class="py-0.5 text-[10px] font-medium tracking-wider uppercase md:text-xs"
                >
                  {translateCategory(article.category, $t)}
                </Badge>
              {/if}

              {#if article?.f2z_score && parseFloat(article.f2z_score) > 0}
                <Badge
                  class="border-0 bg-gradient-to-br from-amber-500 to-amber-600 py-0.5 text-[10px] font-semibold text-white hover:from-amber-600 hover:to-amber-700 md:text-xs"
                >
                  {formatScore(article.f2z_score, $locale)} ⚡
                </Badge>
              {/if}

              {#if article?.is_subscriber_only}
                <Badge
                  class="border-0 bg-gradient-to-br from-violet-500 to-violet-600 py-0.5 text-[10px] font-semibold text-white hover:from-violet-600 hover:to-violet-700 md:text-xs"
                >
                  🔒 {$t("common.article.premium", "Premium")}
                </Badge>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </a>

    <!-- Tag links are siblings of the article link, so each has one native
         destination and cannot trigger article navigation as well. -->
    <TagChips tags={article?.tags} limit={6} class="mt-3" />
  </CardContent>
</Card>
