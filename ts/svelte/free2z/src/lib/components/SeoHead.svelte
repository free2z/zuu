<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { page } from '$app/stores';
  import {
    DEFAULT_ROBOTS,
    DEFAULT_SOCIAL_IMAGE,
    DEFAULT_SOCIAL_IMAGE_ALT,
    DEFAULT_SOCIAL_IMAGE_HEIGHT,
    DEFAULT_SOCIAL_IMAGE_WIDTH,
    CANONICAL_ORIGIN,
    SITE_NAME,
    canonicalPath as normalizePath,
    escapeJsonForHtml,
    toAbsoluteUrl,
    type JsonLd,
  } from '$lib/seo';

  export let title: string;
  export let description: string;
  export let path: string | undefined = undefined;
  export let type: 'website' | 'article' | 'profile' | 'video.other' = 'website';
  export let image: string | undefined = undefined;
  export let imageAlt: string = DEFAULT_SOCIAL_IMAGE_ALT;
  export let imageWidth: number = DEFAULT_SOCIAL_IMAGE_WIDTH;
  export let imageHeight: number = DEFAULT_SOCIAL_IMAGE_HEIGHT;
  export let robots: string = DEFAULT_ROBOTS;
  export let structuredData: JsonLd | JsonLd[] = [];
  export let publishedTime: string | undefined = undefined;
  export let modifiedTime: string | undefined = undefined;
  export let author: string | undefined = undefined;

  const configuredOrigin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, '') || CANONICAL_ORIGIN;

  $: origin = configuredOrigin;
  $: resolvedPath = normalizePath(path ?? $page.url.pathname);
  $: canonicalHref = toAbsoluteUrl(resolvedPath, origin);
  $: imageHref = toAbsoluteUrl(image ?? DEFAULT_SOCIAL_IMAGE, origin);
  $: imageType = imageHref.split('?')[0]?.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  $: structuredItems = Array.isArray(structuredData) ? structuredData : [structuredData];
  $: jsonLd = escapeJsonForHtml(
    JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': type === 'profile' ? 'ProfilePage' : type === 'article' ? 'Article' : 'WebPage',
          '@id': `${canonicalHref}#webpage`,
          name: title,
          headline: type === 'article' ? title : undefined,
          description,
          url: canonicalHref,
          image: imageHref,
          inLanguage: 'en',
          isAccessibleForFree: true,
          datePublished: publishedTime,
          dateModified: modifiedTime,
          author: author ? { '@type': 'Person', name: author } : undefined,
          primaryImageOfPage: {
            '@type': 'ImageObject',
            url: imageHref,
            width: imageWidth,
            height: imageHeight,
          },
          isPartOf: { '@id': `${origin}/#website` },
          publisher: { '@id': `${origin}/#organization` },
        },
        ...structuredItems,
      ],
    }),
  );
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={description} />
  <meta name="robots" content={robots} />
  <link rel="canonical" href={canonicalHref} />

  <meta property="og:title" content={title} />
  <meta property="og:description" content={description} />
  <meta property="og:type" content={type} />
  <meta property="og:url" content={canonicalHref} />
  <meta property="og:site_name" content={SITE_NAME} />
  <meta property="og:locale" content="en_US" />
  <meta property="og:image" content={imageHref} />
  <meta property="og:image:secure_url" content={imageHref} />
  <meta property="og:image:type" content={imageType} />
  <meta property="og:image:width" content={imageWidth.toString()} />
  <meta property="og:image:height" content={imageHeight.toString()} />
  <meta property="og:image:alt" content={imageAlt} />
  {#if type === 'article' && publishedTime}
    <meta property="article:published_time" content={publishedTime} />
  {/if}
  {#if type === 'article' && modifiedTime}
    <meta property="article:modified_time" content={modifiedTime} />
  {/if}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={description} />
  <meta name="twitter:url" content={canonicalHref} />
  <meta name="twitter:image" content={imageHref} />
  <meta name="twitter:image:alt" content={imageAlt} />

  {@html `<script type="application/ld+json">${jsonLd}</script>`}
</svelte:head>
