<script lang="ts">
  import { formatDate as formatApiDate } from "$lib/utils/date";
  import * as env from "$app/env/public";
  import { ArrowRight } from "@lucide/svelte";
  import { markdownToPlainText } from "$lib/utils/plainText";
  import FeaturedImageFrame from "$lib/components/FeaturedImageFrame.svelte";
  import { zpageCanonicalPath } from "$lib/zpage-path";

  export let story: any;

  const apiBase = (env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

  function buildAssetUrl(path?: string | null) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${apiBase}${normalized}`;
  }

  function articleHref() {
    return zpageCanonicalPath(story || {}) || story?.get_url || "/";
  }

  function formatDate(value?: string) {
    return formatApiDate(value, "en-US", undefined, "");
  }

  function authorName() {
    return (
      story?.creator?.full_name ||
      (story?.creator?.username
        ? `@${story.creator.username}`
        : "Free2Z creator")
    );
  }

  $: href = articleHref();
  $: imageUrl = buildAssetUrl(
    story?.featured_image?.thumbnail || story?.featured_image?.url,
  );
  $: avatarUrl = buildAssetUrl(
    story?.creator?.avatar_image?.thumbnail ||
      story?.creator?.avatar_image?.url,
  );
  $: excerpt = markdownToPlainText(
    story?.description || story?.content || "",
    130,
  );
</script>

<article
  class="group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors duration-200 hover:border-primary/40"
>
  <a {href} class="relative block aspect-[16/9] overflow-hidden bg-muted">
    {#if imageUrl}
      <FeaturedImageFrame
        src={imageUrl}
        alt={story?.featured_image?.title || story?.title || ""}
        loading="lazy"
        class="h-full w-full"
      />
    {:else}
      <div
        class="flex h-full items-center justify-center bg-muted text-sm text-muted-foreground"
      >
        Free2Z
      </div>
    {/if}
    {#if story?.category}
      <span
        class="absolute top-3 right-3 rounded-md border border-border bg-background/90 px-2 py-1 text-xs font-medium text-foreground"
      >
        {story.category}
      </span>
    {/if}
  </a>

  <div class="flex flex-1 flex-col p-4">
    <p class="mb-2 text-xs text-muted-foreground">
      {formatDate(story?.created_at)}
    </p>
    <a
      {href}
      class="inline-flex min-h-11 items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <h4
        class="line-clamp-2 text-base leading-snug font-semibold tracking-tight transition-colors group-hover:text-primary"
      >
        {story?.title}
      </h4>
    </a>
    {#if excerpt}
      <p
        class="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground"
      >
        {excerpt}
      </p>
    {/if}

    <div class="mt-auto flex items-center justify-between gap-3 pt-5">
      <a
        href="/{story?.creator?.username || ''}"
        class="flex min-h-11 min-w-0 items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span
          class="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted font-medium"
        >
          {#if avatarUrl}
            <img src={avatarUrl} alt="" class="h-full w-full object-cover" />
          {:else}
            {authorName().replace("@", "").charAt(0).toUpperCase()}
          {/if}
        </span>
        <span class="truncate">{authorName()}</span>
      </a>
      <a
        {href}
        class="inline-flex min-h-11 shrink-0 items-center gap-1 px-1 text-sm font-medium text-primary hover:underline"
        aria-label={`Read ${story?.title || "related article"}`}
      >
        Read <ArrowRight class="size-3.5" aria-hidden="true" />
      </a>
    </div>
  </div>
</article>
