<script lang="ts">
  import { goto } from '$app/navigation';
  import { formatDistanceToNow } from 'date-fns';
  import { tStore as t } from '$lib/i18n';
  import { env } from '$env/dynamic/public';
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Card, CardContent } from "$lib/components/ui/card";
  import { extractPlainText } from '$lib/utils/markdown';

  export let article: any;

  // API base (remove trailing slash like other components)
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || '';

  // Build avatar URL
  function buildAvatarUrl(avatar: any): string {
    if (!avatar) return '';

    // Use the thumbnail if available, otherwise the main URL
    const imageUrl = avatar.thumbnail || avatar.url;
    if (!imageUrl) return '';

    // If the URL is already absolute, use it as-is
    if (/^https?:\/\//.test(imageUrl)) {
      return imageUrl;
    }

    // Otherwise prepend the API base URL and ensure single slash
    return `${apiBase}${imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`}`;
  }

  // Build featured image URL
  function buildFeaturedImageUrl(featuredImage: any): string {
    if (!featuredImage) return '';

    // Use the thumbnail if available, otherwise the main URL
    const imageUrl = featuredImage.thumbnail || featuredImage.url;
    if (!imageUrl) return '';

    // If the URL is already absolute, use it as-is
    if (/^https?:\/\//.test(imageUrl)) {
      return imageUrl;
    }

    // Otherwise prepend the API base URL and ensure single slash
    return `${apiBase}${imageUrl.startsWith('/') ? imageUrl : `/${imageUrl}`}`;
  }

  // Format article content for excerpt
  function getExcerpt(content: string, maxLength: number = 200): string {
    return extractPlainText(content, maxLength);
  }

  // Format date
  function formatDate(dateString: string): string {
    try {
      return formatDistanceToNow(new Date(dateString), { addSuffix: true });
    } catch {
      return dateString;
    }
  }

  // Handle click to navigate to article
  function handleClick() {
    if (article?.get_url) {
      // Transform URL from /username/zpage/vanity to /username/vanity
      const transformedUrl = article.get_url.replace('/zpage/', '/');
      goto(transformedUrl);
    }
  }

  // Handle keyboard navigation
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  }

  $: avatarUrl = buildAvatarUrl(article?.creator?.avatar_image);
  $: featuredImageUrl = buildFeaturedImageUrl(article?.featured_image);
  $: excerpt = getExcerpt(article?.content || article?.description || '');
  $: createdDate = formatDate(article?.created_at);
  $: updatedDate = formatDate(article?.updated_at);
</script>

<Card
  role="button"
  tabindex={0}
  onclick={handleClick}
  onkeydown={handleKeydown}
  aria-label="Read article: {article?.title}"
  class="block rounded-xl overflow-hidden transition-all duration-200 cursor-pointer text-inherit hover:border-primary hover:shadow-md hover:-translate-y-px focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
>
<CardContent class="p-4 md:p-6">
  <div class="grid gap-4 md:gap-5 grid-cols-1 md:grid-cols-[120px_1fr] items-start {!featuredImageUrl ? '!grid-cols-1' : ''}">
    <!-- Featured Image (if available) -->
    {#if featuredImageUrl}
      <div class="w-full h-[150px] md:w-[120px] md:h-[90px] rounded-lg overflow-hidden shrink-0 -order-1 md:order-none">
        <img src={featuredImageUrl} alt={article?.title || ''} loading="lazy" class="w-full h-full object-cover" />
      </div>
    {/if}

    <div class="min-w-0">
      <!-- Article Title -->
      <h3 class="text-lg md:text-xl font-semibold text-foreground m-0 mb-3 leading-tight line-clamp-2">
        {article?.title || 'Untitled'}
      </h3>

      <!-- Article Excerpt -->
      {#if excerpt}
        <p class="text-muted-foreground leading-relaxed m-0 mb-4 line-clamp-3">
          {excerpt}
        </p>
      {/if}

      <!-- Article Meta -->
      <div class="flex flex-col md:flex-row md:justify-between items-start gap-3 md:gap-4 flex-wrap">
        <!-- Author Info -->
        <div class="flex items-center gap-2 sm:gap-3 min-w-0">
          <Avatar.Root class="h-7 w-7 sm:h-8 sm:w-8 shrink-0">
            {#if avatarUrl}
              <Avatar.Image src={avatarUrl} alt={article?.creator?.username || 'Author'} />
            {/if}
            <Avatar.Fallback class="bg-primary text-primary-foreground font-semibold text-xs sm:text-sm">
              {(article?.creator?.username || 'A')[0].toUpperCase()}
            </Avatar.Fallback>
          </Avatar.Root>

          <div class="flex flex-col gap-1 min-w-0">
            <span class="text-sm font-medium text-foreground">
              {$t('common.meta.createdBy')}
              {article?.creator?.username || $t('common.meta.unknown')}
            </span>
            <span class="text-xs text-muted-foreground">
              {#if article?.updated_at !== article?.created_at}
                {$t('common.article.updatedOn')} {updatedDate}
              {:else}
                {$t('common.article.publishedOn')} {createdDate}
              {/if}
            </span>
          </div>
        </div>

        <!-- Article Stats -->
        <div class="flex flex-wrap items-center gap-2 w-full md:w-auto">
          {#if article?.category}
            <Badge variant="secondary" class="uppercase tracking-wider font-medium text-[10px] md:text-xs py-0.5">
              {article.category}
            </Badge>
          {/if}

          {#if article?.f2z_score && parseFloat(article.f2z_score) > 0}
            <Badge class="bg-gradient-to-br from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white border-0 font-semibold text-[10px] md:text-xs py-0.5">
              {parseFloat(article.f2z_score).toFixed(0)} ⚡
            </Badge>
          {/if}

          {#if article?.is_subscriber_only}
            <Badge class="bg-gradient-to-br from-violet-500 to-violet-600 hover:from-violet-600 hover:to-violet-700 text-white border-0 font-semibold text-[10px] md:text-xs py-0.5">
              🔒 Premium
            </Badge>
          {/if}
        </div>
      </div>
    </div>
  </div>
</CardContent>
</Card>
