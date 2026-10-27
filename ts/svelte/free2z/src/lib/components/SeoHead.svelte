<script lang="ts">
  import * as env from "$app/env/public";
  import { page } from "$lib/kit-stores";
  import {
    normalizedPublicImageUrl,
    PUBLIC_SOCIAL_IMAGE_WIDTH,
    PUBLIC_SOCIAL_IMAGE_HEIGHT,
  } from "$lib/public-social-image";
  import {
    DEFAULT_ROBOTS,
    DEFAULT_SOCIAL_IMAGE,
    DEFAULT_SOCIAL_IMAGE_ALT,
    DEFAULT_SOCIAL_IMAGE_HEIGHT,
    DEFAULT_SOCIAL_IMAGE_WIDTH,
    CANONICAL_ORIGIN,
    FACEBOOK_APP_ID,
    SITE_NAME,
    TWITTER_CREATOR,
    TWITTER_SITE,
    canonicalPath as normalizePath,
    createPageJsonLd,
    escapeJsonForHtml,
    toAbsoluteUrl,
    type JsonLd,
  } from "$lib/seo";

  export let title: string;
  export let description: string;
  export let path: string | undefined = undefined;
  export let type: "website" | "article" | "profile" | "video.other" =
    "website";
  export let image: string | undefined = undefined;
  export let imageAlt: string = DEFAULT_SOCIAL_IMAGE_ALT;
  export let imageWidth: number | undefined = undefined;
  export let imageHeight: number | undefined = undefined;
  export let robots: string = DEFAULT_ROBOTS;
  export let structuredData: JsonLd | JsonLd[] = [];
  /**
   * The Person/Organization a `type="profile"` page is about. Required for the
   * ProfilePage rich result — omit it and the page node degrades to WebPage
   * rather than emitting a ProfilePage that Search Console flags as broken.
   */
  export let mainEntity: JsonLd | undefined = undefined;
  export let publishedTime: string | undefined = undefined;
  export let modifiedTime: string | undefined = undefined;
  export let author: string | undefined = undefined;
  /** ProfilePage-only `dateCreated` — see the option doc in `$lib/seo`. */
  export let dateCreated: string | undefined = undefined;

  const configuredOrigin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;
  // Keep this split: svelte-eslint-parser mistakes a literal closing script
  // tag in the JSON-LD expression for the end of this component's script block.
  const jsonLdClosingTag = "</" + "script>";

  $: origin = configuredOrigin;
  $: resolvedPath = normalizePath(path ?? $page.url.pathname);
  $: canonicalHref = toAbsoluteUrl(resolvedPath, origin);
  function resolveImage(value: string | undefined, base: string): string {
    try {
      const url = new URL(
        toAbsoluteUrl(value?.trim() || DEFAULT_SOCIAL_IMAGE, base),
      );
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Invalid social image URL");
      return url.href;
    } catch {
      return toAbsoluteUrl(DEFAULT_SOCIAL_IMAGE, base);
    }
  }
  $: sourceImageHref = resolveImage(image, origin);
  $: normalizedImageHref = normalizedPublicImageUrl(sourceImageHref, origin);
  $: imageHref = normalizedImageHref ?? sourceImageHref;
  $: defaultImage = imageHref === toAbsoluteUrl(DEFAULT_SOCIAL_IMAGE, origin);
  $: resolvedWidth = normalizedImageHref
    ? PUBLIC_SOCIAL_IMAGE_WIDTH
    : (imageWidth ?? (defaultImage ? DEFAULT_SOCIAL_IMAGE_WIDTH : undefined));
  $: resolvedHeight = normalizedImageHref
    ? PUBLIC_SOCIAL_IMAGE_HEIGHT
    : (imageHeight ?? (defaultImage ? DEFAULT_SOCIAL_IMAGE_HEIGHT : undefined));
  $: imageExtension = new URL(imageHref).pathname
    .split(".")
    .pop()
    ?.toLowerCase();
  $: imageType = (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
    } as Record<string, string>
  )[imageExtension || ""];
  $: structuredItems = Array.isArray(structuredData)
    ? structuredData
    : [structuredData];
  $: jsonLd = escapeJsonForHtml(
    JSON.stringify(
      createPageJsonLd({
        type,
        origin,
        canonicalHref,
        title,
        description,
        imageHref,
        imageWidth: resolvedWidth,
        imageHeight: resolvedHeight,
        publishedTime,
        modifiedTime,
        author,
        mainEntity,
        dateCreated,
        extra: structuredItems,
      }),
    ),
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
  {#if imageType}<meta property="og:image:type" content={imageType} />{/if}
  {#if resolvedWidth}<meta
      property="og:image:width"
      content={resolvedWidth.toString()}
    />{/if}
  {#if resolvedHeight}<meta
      property="og:image:height"
      content={resolvedHeight.toString()}
    />{/if}
  <meta property="og:image:alt" content={imageAlt} />
  {#if type === "article" && publishedTime}
    <meta property="article:published_time" content={publishedTime} />
  {/if}
  {#if type === "article" && modifiedTime}
    <meta property="article:modified_time" content={modifiedTime} />
  {/if}

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={description} />
  <meta name="twitter:url" content={canonicalHref} />
  <meta name="twitter:image" content={imageHref} />
  <meta name="twitter:image:alt" content={imageAlt} />
  <!-- Attribution parity with the Django card tier ( phase 3). -->
  <meta name="twitter:site" content={TWITTER_SITE} />
  <meta name="twitter:creator" content={TWITTER_CREATOR} />
  <meta property="fb:app_id" content={FACEBOOK_APP_ID} />

  {@html `<script type="application/ld+json">${jsonLd}${jsonLdClosingTag}`}
</svelte:head>
