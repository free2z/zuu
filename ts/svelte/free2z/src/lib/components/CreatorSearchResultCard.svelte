<script lang="ts">
  import * as env from "$app/env/public";
  import type { CreatorList } from "$lib/api/f2z.schemas";
  import * as Avatar from "$lib/components/ui/avatar/index.js";
  import { ArrowUpRight, BadgeCheck, FileText } from "@lucide/svelte";

  export let creator: CreatorList;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  function imageUrl(): string {
    const path = creator?.avatar_image?.thumbnail || creator?.avatar_image?.url;
    if (!path) return "";
    if (/^https?:\/\//.test(path)) return path;
    return `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
  }

  $: avatarUrl = imageUrl();
  $: displayName = creator?.full_name?.trim() || creator.username;
</script>

<a
  href="/{creator.username}"
  aria-label="View {displayName}'s profile"
  class="group flex min-w-0 items-center gap-4 rounded-xl border border-(--f2z-border-primary) bg-(--f2z-bg-secondary) p-4 transition-[border-color,background-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-(--f2z-accent-primary)/60 hover:shadow-lg hover:shadow-black/5 focus-visible:border-(--f2z-accent-primary) focus-visible:ring-3 focus-visible:ring-(--f2z-accent-primary)/15 focus-visible:outline-none dark:hover:bg-(--f2z-bg-tertiary)/55 dark:hover:shadow-black/20"
>
  <Avatar.Root class="size-12 shrink-0 border border-(--f2z-border-primary)">
    {#if avatarUrl}
      <Avatar.Image src={avatarUrl} alt={displayName} class="object-cover" />
    {/if}
    <Avatar.Fallback
      class="bg-(--f2z-bg-tertiary) font-semibold text-(--f2z-text-secondary)"
    >
      {displayName.slice(0, 1).toUpperCase()}
    </Avatar.Fallback>
  </Avatar.Root>

  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-1.5">
      <h3
        class="truncate font-semibold text-(--f2z-text-primary) transition-colors group-hover:text-(--f2z-accent-primary)"
      >
        {displayName}
      </h3>
      {#if creator.is_verified}
        <BadgeCheck
          class="size-4 shrink-0 fill-(--f2z-accent-primary) text-(--f2z-bg-primary)"
          aria-label="Verified creator"
        />
      {/if}
    </div>
    <div class="mt-1 flex items-center gap-2 text-xs text-(--f2z-text-muted)">
      <span class="truncate">@{creator.username}</span>
      <span aria-hidden="true">·</span>
      <span class="inline-flex shrink-0 items-center gap-1"
        ><FileText class="size-3" /> {creator.zpages || 0} pages</span
      >
    </div>
  </div>

  <span
    class="grid size-8 shrink-0 place-items-center rounded-full border border-(--f2z-border-primary) text-(--f2z-text-muted) transition-all group-hover:border-(--f2z-accent-primary) group-hover:bg-(--f2z-accent-primary) group-hover:text-primary-foreground"
  >
    <ArrowUpRight class="size-4" />
  </span>
</a>
