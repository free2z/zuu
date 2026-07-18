<script lang="ts">
  import type { PageData } from './$types';
  import { env } from '$env/dynamic/public';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
  import MediaUploader from '$lib/components/media/MediaUploader.svelte';
  import { formatRelativeTime } from '$lib/utils/date';
  import { FileText, Sparkles, Users, Star, Wallet, CheckCircle2, Edit3, Eye, UploadCloud, User } from '@lucide/svelte';

  export let data: PageData;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || '';

  $: creator = data.creator;
  $: zpages = data.zpages || [];
  let publishedPages: any[] = [];
  let drafts: any[] = [];
  let sortedDrafts: any[] = [];

  $: {
    const pub = [];
    const dr = [];
    for (const page of zpages) {
      if (page.is_published) {
        pub.push(page);
      } else {
        dr.push(page);
      }
    }
    publishedPages = pub;
    drafts = dr;
    sortedDrafts = [...dr].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }

  $: displayName = creator.full_name || creator.username;

  function buildImageUrl(image: any) {
    if (!image?.url && !image?.thumbnail) return null;
    const imageUrl = image.thumbnail || image.url;
    if (/^https?:\/\//.test(imageUrl)) return imageUrl;
    return `${apiBase}${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
  }

  function pageUrl(page: any) {
    if (page?.get_url) return page.get_url;
    if (page?.vanity) return `/${creator.username}/${page.vanity}`;
    return `/article/${page.free2zaddr}`;
  }

  $: avatarUrl = buildImageUrl(creator.avatar_image);
  $: bannerUrl = buildImageUrl(creator.banner_image);
</script>

<svelte:head>
  <title>{displayName} • Profile Dashboard</title>
  <meta
    name="description"
    content={`Manage ${displayName}'s profile, pages, and creator stats.`}
  />
</svelte:head>

<main class="flex-1 bg-background text-foreground pb-20">
  <!-- Banner -->
  <div class="relative h-48 md:h-56 w-full bg-muted overflow-hidden">
    {#if bannerUrl}
      <img src={bannerUrl} alt="Banner" class="h-full w-full object-cover" />
    {/if}
    <div class="absolute inset-0 bg-gradient-to-b from-transparent to-background/80"></div>
  </div>

  <div class="container max-w-6xl mx-auto px-4 -mt-12 relative z-10 space-y-8">
    <header class="flex flex-col md:flex-row md:items-end justify-between gap-4">
      <div class="flex items-end gap-4">
        <!-- Avatar -->
        <div class="relative shrink-0">
          <div class="h-20 w-20 rounded-xl border-4 border-background shadow-sm overflow-hidden bg-muted">
            {#if avatarUrl}
              <img src={avatarUrl} alt={displayName} class="h-full w-full object-cover" />
            {:else}
              <div class="h-full w-full flex items-center justify-center text-lg font-bold text-muted-foreground bg-muted">
                {displayName.slice(0, 2).toUpperCase()}
              </div>
            {/if}
          </div>
          {#if creator.is_verified}
            <div class="absolute -bottom-1 -right-1 bg-primary text-primary-foreground p-0.5 rounded-full border-2 border-background" title="Verified Creator">
              <CheckCircle2 class="size-3.5" />
            </div>
          {/if}
        </div>

        <div class="space-y-1 mb-1">
          <div class="flex items-center gap-2">
            <h1 class="text-3xl font-bold tracking-tight">{displayName}</h1>
            {#if creator.is_verified}
              <Badge variant="secondary" class="text-blue-600 bg-blue-100 hover:bg-blue-100/80 dark:bg-blue-900/30 dark:text-blue-400 border-transparent">
                Verified
              </Badge>
            {/if}
          </div>
          <p class="text-muted-foreground">@{creator.username}</p>
        </div>
      </div>

      <div class="flex items-center gap-2 mb-1">
        <Button href={`/${creator.username}`} variant="outline">
          <Eye class="mr-2 size-4" /> Public View
        </Button>
        <Button href={`/${creator.username}/dashboard/settings`}>
          <User class="mr-2 size-4" /> Edit Profile
        </Button>
      </div>
    </header>

    <!-- Stats -->
    <section class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <FileText class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{publishedPages.length}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Published</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <Edit3 class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{drafts.length}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Drafts</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <Sparkles class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{creator.total || 0}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">2Zs Earned</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent class="p-4 flex items-center gap-3">
          <div class="bg-primary/10 p-2.5 rounded-full">
            <Users class="size-5 text-primary" />
          </div>
          <div>
            <p class="text-2xl font-bold tabular-nums">{creator.fans?.length || 0}</p>
            <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Fans</p>
          </div>
        </CardContent>
      </Card>
    </section>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
      <!-- Left Column: Quick Actions & About -->
      <div class="space-y-6">
        <!-- Quick Actions -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2">
            <Button href="/edit" class="w-full justify-start" variant="default">
              <Edit3 class="mr-2 size-4" /> Create New Article
            </Button>
            <Button href={`/${creator.username}/dashboard/stream`} variant="outline" class="w-full justify-start">
              <Users class="mr-2 size-4" /> Start Live Stream
            </Button>
            <Button href={`/${creator.username}/dashboard/media`} variant="outline" class="w-full justify-start">
              <UploadCloud class="mr-2 size-4" /> Upload Media
            </Button>
          </CardContent>
        </Card>

        <!-- Quick Upload -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Quick Upload</CardTitle>
          </CardHeader>
          <CardContent>
            <MediaUploader />
          </CardContent>
        </Card>

        <!-- About Card -->
        <Card>
          <CardHeader>
            <CardTitle class="text-base">Creator Bio</CardTitle>
          </CardHeader>
          <CardContent class="space-y-4">
            <p class="text-sm text-muted-foreground leading-relaxed">
              {creator.description || 'Add a bio to tell supporters what you are creating.'}
            </p>
            
            <div class="pt-4 border-t space-y-3">
              <div class="flex items-center justify-between">
                <span class="flex items-center text-xs font-medium text-muted-foreground">
                  <Wallet class="size-4 mr-2 text-primary" /> Zcash Wallet
                </span>
                {#if creator.p2paddr}
                  <span class="font-mono text-xs bg-muted px-2 py-1 rounded-md border text-foreground truncate max-w-[140px]" title={creator.p2paddr}>{creator.p2paddr}</span>
                {:else}
                  <Badge variant="secondary">Not Configured</Badge>
                {/if}
              </div>
              <div class="flex items-center justify-between">
                <span class="flex items-center text-xs font-medium text-muted-foreground">
                  <Star class="size-4 mr-2 text-primary" /> Membership
                </span>
                <span class="font-semibold text-sm">
                  {creator.member_price ? `${creator.member_price} 2Z/mo` : 'Free'}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Right Column: Content (Drafts & Published) -->
      <div class="lg:col-span-2 space-y-6">
        
        <!-- Drafts Section -->
        <Card>
          <CardHeader class="flex flex-row items-center justify-between space-y-0">
            <div class="space-y-1">
              <CardTitle class="flex items-center gap-2">
                <Edit3 class="size-5" />
                Drafts
              </CardTitle>
              <CardDescription>{drafts.length} work in progress</CardDescription>
            </div>
          </CardHeader>
          <CardContent class="space-y-3">
            {#if sortedDrafts.length > 0}
              {#each sortedDrafts as draft (draft.free2zaddr)}
                <div class="group rounded-xl border bg-card hover:border-primary/50 transition-colors p-4 space-y-2">
                  <div class="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                    <div class="flex-1 min-w-0 space-y-1">
                      <div class="flex items-center gap-2">
                        <Badge variant="secondary" class="text-[10px] uppercase tracking-wide">Draft</Badge>
                        <span class="text-xs text-muted-foreground">Modified {formatRelativeTime(draft.updated_at)}</span>
                      </div>
                      <h3 class="text-base font-semibold text-foreground truncate pr-4">{draft.title || 'Untitled'}</h3>
                      <p class="text-sm text-muted-foreground line-clamp-1">
                        {draft.description || 'No description provided yet.'}
                      </p>
                    </div>
                    <Button href={`/edit?id=${encodeURIComponent(draft.free2zaddr)}`} size="sm">
                      Continue Writing
                    </Button>
                  </div>
                </div>
              {/each}
            {:else}
              <div class="flex flex-col items-center justify-center py-12 text-center space-y-2 border-2 border-dashed rounded-xl">
                <Edit3 class="size-10 text-muted-foreground/20" />
                <p class="text-sm text-muted-foreground">No active drafts.</p>
                <Button href="/edit" variant="link" size="sm">Create a new page</Button>
              </div>
            {/if}
          </CardContent>
        </Card>

        <!-- Published Section -->
        <Card>
          <CardHeader class="flex flex-row items-center justify-between space-y-0">
            <div class="space-y-1">
              <CardTitle class="flex items-center gap-2">
                <CheckCircle2 class="size-5" />
                Published
              </CardTitle>
              <CardDescription>{publishedPages.length} live pages</CardDescription>
            </div>
          </CardHeader>
          <CardContent class="space-y-3">
            {#if publishedPages.length > 0}
              {#each publishedPages as page (page.free2zaddr)}
                <div class="group rounded-xl border bg-card hover:border-primary/50 transition-colors p-4 space-y-2">
                  <div class="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
                    <div class="flex-1 min-w-0 space-y-1">
                      <div class="flex items-center gap-2">
                        <Badge variant="default" class="text-[10px] uppercase tracking-wide">Published</Badge>
                        <span class="text-xs text-muted-foreground">{formatRelativeTime(page.updated_at)}</span>
                      </div>
                      <h3 class="text-base font-semibold text-foreground truncate pr-4">
                        <a href={pageUrl(page)} class="hover:text-primary transition-colors hover:underline">{page.title}</a>
                      </h3>
                      <p class="text-sm text-muted-foreground line-clamp-1">
                        {page.description || 'No description provided.'}
                      </p>
                      {#if page.tags?.length}
                        <div class="flex flex-wrap gap-1.5 pt-1">
                          {#each page.tags.slice(0, 3) as tag}
                            <Badge variant="outline" class="text-[10px]">#{tag}</Badge>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <div class="flex gap-2 shrink-0">
                      <Button href={`/edit?id=${encodeURIComponent(page.free2zaddr)}`} size="sm" variant="default">
                        <Edit3 class="mr-1.5 size-3.5" /> Edit
                      </Button>
                      <Button href={pageUrl(page)} size="sm" variant="outline">
                        <Eye class="mr-1.5 size-3.5" /> View
                      </Button>
                    </div>
                  </div>
                </div>
              {/each}
            {:else}
              <div class="flex flex-col items-center justify-center py-12 text-center space-y-2 border-2 border-dashed rounded-xl">
                <FileText class="size-10 text-muted-foreground/20" />
                <p class="text-sm text-muted-foreground">Nothing published yet.</p>
                <Button href="/edit" variant="link" size="sm">Create your first page</Button>
              </div>
            {/if}
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</main>

