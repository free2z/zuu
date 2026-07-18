<script lang="ts">
  import type { PageData } from './$types';
  import { env } from '$env/dynamic/public';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { goto } from '$app/navigation';
  import LiveIndicator from '$lib/components/stream/LiveIndicator.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { CheckCircle2, FileText, Settings, LayoutGrid, PenLine,  } from '@lucide/svelte';
  import * as Tabs from "$lib/components/ui/tabs";
  import * as Select from "$lib/components/ui/select";
  import * as Tooltip from "$lib/components/ui/tooltip";
  import ZpageCard from '$lib/components/ZpageCard.svelte';
  import TagFilter from '$lib/components/TagFilter.svelte';
  // @ts-ignore
  import CustomPagination from '$lib/components/CustomPagination.svelte';
  import MarkdownContent from '$lib/components/MarkdownContent.svelte';
  import { processMarkdown } from '$lib/utils/markdown';
  import ProfileDonate from '$lib/components/profile/ProfileDonate.svelte';
  import ProfileSubscribe from '$lib/components/profile/ProfileSubscribe.svelte';
  import ProfileShare from '$lib/components/profile/ProfileShare.svelte';
  import { page } from '$app/stores';

  export let data: PageData & {
    isOwner: boolean;
    tags?: { name: string; count: number }[];
  };

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || '';

  $: creator = data.creator;
  $: zpages = data.zpages?.results || [];
  $: next = data.zpages?.next;
  $: previous = data.zpages?.previous;
  $: totalCount = data.zpages?.count || 0;
  $: isOwner = data.isOwner;
  $: availableTags = data.tags || [];

  // Filter drafts and published if owner
  $: publishedPages = isOwner ? zpages.filter((p: any) => p.is_published === true) : zpages;
  $: drafts = isOwner ? zpages.filter((p: any) => p.is_published === false) : [];
  
  $: currentPage = parseInt($page.url.searchParams.get('page') || '1');
  $: currentSearch = $page.url.searchParams.get('search') || '';
  $: currentSort = $page.url.searchParams.get('ordering') || '-created_at';
  $: currentTag = $page.url.searchParams.get('tag') || '';

  let searchTimer: any;
  function handleSearch(e: Event) {
       const v = (e.target as HTMLInputElement).value;
       clearTimeout(searchTimer);
       searchTimer = setTimeout(() => {
           updateParams({ search: v });
       }, 500);
  }

  function updateParams(updates: Record<string, string | null>) {
       const newUrl = new URL($page.url);
       Object.entries(updates).forEach(([key, value]) => {
           if (value) newUrl.searchParams.set(key, value);
           else newUrl.searchParams.delete(key);
       });
       newUrl.searchParams.set('page', '1');
       goto(newUrl, { keepFocus: true, noScroll: true });
  }

  function handlePageChange(newPage: number) {
       const newUrl = new URL($page.url);
       newUrl.searchParams.set('page', newPage.toString());
       goto(newUrl, { noScroll: true });
  }

  function buildImageUrl(image: any) {
    if (!image?.url && !image?.thumbnail) return null;
    const imageUrl = image.thumbnail || image.url;
    if (/^https?:\/\//.test(imageUrl)) return imageUrl;
    return `${apiBase}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
  }

  $: avatarUrl = buildImageUrl(creator.avatar_image);
  $: bannerUrl = buildImageUrl(creator.banner_image);
  $: displayName = creator.full_name || creator.username;
  $: descriptionHtml = processMarkdown(creator.description || '');
</script>

<svelte:head>
  <title>{displayName} on Free2Z</title>
  <meta
    name="description"
    content={creator.description || `${displayName}'s profile on Free2Z`}
  />
</svelte:head>

<main class="flex-1 bg-background text-foreground pb-20">
  <!-- Banner -->
  <div class="relative h-72 md:h-96 w-full bg-muted overflow-hidden">
    {#if bannerUrl}
      <img src={bannerUrl} alt="Banner" class="h-full w-full object-cover" />
    {/if}
    <div class="absolute inset-0 bg-gradient-to-b from-transparent to-background/80"></div>
  </div>

  <div class="container max-w-6xl mx-auto px-4 -mt-12 relative z-10">
    <!-- Profile Info -->
    <header class="flex flex-col md:flex-row items-end gap-6 pb-8">
      <!-- Avatar -->
      <div class="relative shrink-0 mx-auto md:mx-0">
        <div class="h-24 w-24 md:h-28 md:w-28 rounded-xl border-4 border-background shadow-sm overflow-hidden bg-muted">
          {#if avatarUrl}
            <img src={avatarUrl} alt={displayName} class="h-full w-full object-cover" />
          {:else}
            <div class="h-full w-full flex items-center justify-center text-2xl font-bold text-muted-foreground bg-muted">
              {displayName.slice(0, 2).toUpperCase()}
            </div>
          {/if}
        </div>
        {#if creator.is_verified}
          <Tooltip.Root>
            <Tooltip.Trigger class="absolute -bottom-1 -right-1">
              <div class="bg-primary text-primary-foreground p-0.5 rounded-full border-2 border-background">
                <CheckCircle2 class="size-3.5" />
              </div>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>Verified Creator</p>
            </Tooltip.Content>
          </Tooltip.Root>
        {/if}
      </div>

      <!-- Name & Actions -->
      <div class="flex-1 min-w-0 w-full text-center md:text-left space-y-3 mb-1">
        <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div class="space-y-1.5">
            <h1 class="text-3xl font-bold tracking-tight truncate" title={displayName}>{displayName}</h1>
            <div class="flex items-center justify-center md:justify-start gap-3 flex-wrap">
              <span class="text-sm text-muted-foreground font-medium">@{creator.username}</span>
              <LiveIndicator username={creator.username} />
              <span class="text-sm text-muted-foreground">
                <span class="font-semibold text-foreground">{creator.zpages || 0}</span> articles
              </span>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="flex items-center gap-2 justify-center md:justify-end">
            <ProfileDonate {creator} />

            {#if !isOwner}
              <ProfileSubscribe {creator} />
            {/if}

            <ProfileShare username={creator.username} {displayName} />

            {#if isOwner}
              <Button href={`/${creator.username}/dashboard/profile`} variant="default">
                <LayoutGrid class="size-4 mr-2" /> Dashboard
              </Button>
              <Button href={`/${creator.username}/dashboard/settings`} variant="outline">
                <Settings class="size-4 mr-2" /> Settings
              </Button>
            {/if}
          </div>
        </div>
      </div>
    </header>

    <!-- Bio Section -->
    {#if creator.description}
      <div class="max-w-3xl pb-8">
        <div class="prose dark:prose-invert prose-sm max-w-none prose-a:text-primary prose-a:no-underline hover:prose-a:underline">
          <MarkdownContent html={descriptionHtml} />
        </div>
      </div>
    {/if}
  </div>

  <!-- Content Section -->
  <section class="container max-w-6xl mx-auto px-4 py-8 space-y-6">

     {#if isOwner}
          <Tabs.Root value="published" class="w-full space-y-6">
             <div class="flex flex-col md:flex-row items-center justify-between gap-4">
                 <Tabs.List>
                     <Tabs.Trigger value="published">
                         Published <Badge variant="secondary" class="ml-2">{publishedPages.length}</Badge>
                     </Tabs.Trigger>
                     <Tabs.Trigger value="drafts">
                         Drafts <Badge variant="outline" class="ml-2">{drafts.length}</Badge>
                     </Tabs.Trigger>
                 </Tabs.List>

                 <div class="flex flex-col md:flex-row items-center gap-3 w-full md:w-auto">
                     <Input 
                         placeholder="Search..." 
                         class="w-full md:w-48 h-9" 
                         value={currentSearch}
                         oninput={handleSearch}
                     />
                     
                     <Select.Root 
                        type="single"
                        value={currentSort}
                        onValueChange={(v) => updateParams({ ordering: v })}
                     >
                        <Select.Trigger class="w-full md:w-32 h-9">
                            <span class="truncate">
                                {currentSort === '-created_at' ? 'Newest' : 
                                 currentSort === 'created_at' ? 'Oldest' : 
                                 currentSort === '-f2z_score' ? 'Popular' : 'Sort by'}
                            </span>
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="-created_at">Newest</Select.Item>
                            <Select.Item value="created_at">Oldest</Select.Item>
                            <Select.Item value="-f2z_score">Popular</Select.Item>
                        </Select.Content>
                     </Select.Root>

                     {#if availableTags.length > 0}
                        <TagFilter 
                            {availableTags} 
                            currentTag={currentTag} 
                            onSelect={(tag) => updateParams({ tag })} 
                        />
                     {/if}

                     <Button href="/edit" variant="outline" size="sm" class="hidden md:flex shrink-0">
                        <PenLine class="size-4 mr-2" /> New Article
                     </Button>
                 </div>
             </div>
             
             <Tabs.Content value="published" class="mt-0 outline-none focus-visible:outline-none">
                 <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                      {#each publishedPages as zpage}
                        <ZpageCard story={zpage} />
                    {:else}
                          <div class="col-span-full flex flex-col items-center justify-center py-16 border-2 border-dashed rounded-xl text-center space-y-2">
                            <FileText class="size-10 text-muted-foreground/20" />
                            <p class="text-sm text-muted-foreground">No published articles found.</p>
                            <Button href="/edit" variant="link" size="sm">Create Article</Button>
                          </div>
                    {/each}
                 </div>
             </Tabs.Content>
             
             <Tabs.Content value="drafts" class="mt-0 outline-none focus-visible:outline-none">
                 <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                      {#each drafts as zpage}
                          <div class="relative group/draft">
                             <ZpageCard story={zpage} />
                             <div class="absolute top-3 right-3 z-20">
                                 <Badge variant="outline" class="bg-background/80 text-orange-500 border-orange-200 text-[10px] uppercase tracking-wider font-semibold">Draft</Badge>
                             </div>
                             <div class="absolute inset-0 bg-background/80 opacity-0 group-hover/draft:opacity-100 transition-all duration-200 z-20 flex items-center justify-center rounded-xl border border-primary/20">
                                 <Button href={`/edit?id=${encodeURIComponent(zpage.free2zaddr)}`} size="sm">
                                     Continue Writing
                                 </Button>
                             </div>
                          </div>
                     {:else}
                          <div class="col-span-full flex flex-col items-center justify-center py-16 border-2 border-dashed rounded-xl text-center space-y-2">
                            <FileText class="size-10 text-muted-foreground/20" />
                            <p class="text-sm text-muted-foreground">No drafts found.</p>
                          </div>
                    {/each}
                 </div>
             </Tabs.Content>

             {#if totalCount > 10}
                <div class="mt-8 flex justify-center">
                    <CustomPagination 
                        count={totalCount} 
                        perPage={10} 
                        {currentPage} 
                        onPageChange={handlePageChange} 
                    />
                </div>
            {/if}
          </Tabs.Root>
     {:else}
           <!-- Public View -->
          <div class="space-y-6">
            <div class="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b pb-6">
                <div class="space-y-1">
                    <h2 class="text-2xl font-bold tracking-tight">Latest Articles</h2>
                    <p class="text-sm text-muted-foreground">Explore thoughts and stories from {displayName}</p>
                </div>
                <div class="flex flex-col md:flex-row items-center gap-3 w-full md:w-auto">
                     <Input 
                         placeholder="Search..." 
                         class="w-full md:w-48 h-9" 
                         value={currentSearch}
                         oninput={handleSearch}
                     />
                     
                     <Select.Root 
                        type="single"
                        value={currentSort}
                        onValueChange={(v) => updateParams({ ordering: v })}
                     >
                        <Select.Trigger class="w-full md:w-32 h-9">
                            <span class="truncate">
                                {currentSort === '-created_at' ? 'Newest' : 
                                 currentSort === 'created_at' ? 'Oldest' : 
                                 currentSort === '-f2z_score' ? 'Popular' : 'Sort by'}
                            </span>
                        </Select.Trigger>
                        <Select.Content>
                            <Select.Item value="-created_at">Newest</Select.Item>
                            <Select.Item value="created_at">Oldest</Select.Item>
                            <Select.Item value="-f2z_score">Popular</Select.Item>
                        </Select.Content>
                     </Select.Root>

                     {#if availableTags.length > 0}
                        <TagFilter 
                            {availableTags} 
                            currentTag={currentTag} 
                            onSelect={(tag) => updateParams({ tag })} 
                        />
                     {/if}
                </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {#each zpages as zpage}
                    <ZpageCard story={zpage} />
                {:else}
                     <div class="col-span-full flex flex-col items-center justify-center py-16 border-2 border-dashed rounded-xl text-center space-y-2">
                        <FileText class="size-10 text-muted-foreground/20" />
                        <p class="text-sm font-semibold">No articles yet</p>
                        <p class="text-sm text-muted-foreground">This creator hasn't published any stories yet.</p>
                     </div>
                {/each}
            </div>

             {#if totalCount > 10}
                <div class="mt-8 flex justify-center">
                    <CustomPagination 
                        count={totalCount} 
                        perPage={10} 
                        {currentPage} 
                        onPageChange={handlePageChange} 
                    />
                </div>
            {/if}
          </div>
     {/if}

  </section>
</main>
