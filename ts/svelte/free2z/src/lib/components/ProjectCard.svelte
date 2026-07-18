<script lang="ts">
  import { env } from '$env/dynamic/public';
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from '$lib/components/ui/card';
  import { Badge } from '$lib/components/ui/badge';

  export let project: any; // TODO: Type from API

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || '';

  // featured_image may provide `thumbnail` or `url` as a relative path like
  // `/uploadz/...`. Build an absolute URL if needed.
  function buildImageUrl() {
    const thumb =
      project?.featured_image?.thumbnail || project?.featured_image?.url;
    if (!thumb) return null;
    if (/^https?:\/\//.test(thumb)) return thumb;
    // avoid double-slashes
    return `${apiBase}${thumb.startsWith('/') ? '' : '/'}${thumb}`;
  }

  $: imageUrl = buildImageUrl();
</script>

<Card class="w-full">
  <div class="f2z-card-row flex flex-row items-center gap-4">
    <!-- Left: title (approx 2/3) -->
    <div class="f2z-card-title flex-1 p-4">
      <h3 class="text-lg font-semibold leading-tight">{project.title}</h3>
    </div>

    <!-- Right: image (approx 1/3) - uniform height 240px -->
    {#if imageUrl}
      <div
        class="f2z-card-image w-1/3 flex-shrink-0 h-60 overflow-hidden rounded"
      >
        <img
          src={imageUrl}
          alt={project.title}
          class="w-full h-full object-cover"
          loading="lazy"
        />
      </div>
    {/if}
  </div>

  <style>
    /* Component-scoped fallback CSS so layout works even if Tailwind utilities
       are not available while we debug the Tailwind/PostCSS pipeline. */
    .f2z-card-row {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 1rem;
    }
    .f2z-card-title {
      padding: 1rem;
      flex: 1 1 auto;
    }
    .f2z-card-image {
      flex-shrink: 0;
      width: 33%;
      height: 240px; /* uniform height */
      overflow: hidden;
      border-radius: 0.5rem;
    }
    .f2z-card-image img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    @media (max-width: 640px) {
      .f2z-card-row {
        flex-direction: column;
        align-items: stretch;
      }
      .f2z-card-image {
        width: 100%;
        height: 200px;
        border-top-left-radius: 0.5rem;
        border-top-right-radius: 0.5rem;
      }
    }
  </style>
</Card>
