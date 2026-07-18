<script lang="ts">
  import type { PageData } from './$types';
  import { goto } from '$app/navigation';
  import { formatRelativeTime } from '$lib/utils/date';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { FileText, Plus, LayoutGrid, List, Search, Radio, Eye, Pencil } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import ZpageCard from '$lib/components/ZpageCard.svelte';
  import { Badge } from '$lib/components/ui/badge';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let zpages = $derived(data.zpages || []);
  let username = $derived(data.username);
  let count = $derived(data.count || 0);
  let currentPage = $derived(data.page || 1);
  let searchQuery = $state(data.search || '');

  let viewMode: 'card' | 'list' = $state('card'); // Default to card view for modern look

  let totalPages = $derived(Math.ceil(count / 12));
  let hasNextPage = $derived(currentPage < totalPages);
  let hasPrevPage = $derived(currentPage > 1);

  function handleCreateNew() {
    goto('/edit');
  }

  function toggleView(mode: 'card' | 'list') {
    viewMode = mode;
  }

  function handleSearch() {
    const url = new URL(window.location.href);
    if (searchQuery.trim()) {
      url.searchParams.set('q', searchQuery.trim());
    } else {
      url.searchParams.delete('q');
    }
    url.searchParams.delete('page'); // Reset to page 1
    goto(url.toString(), { replaceState: false });
  }

  function clearSearch() {
    searchQuery = '';
    handleSearch();
  }

  function goToPage(page: number) {
    const url = new URL(window.location.href);
    url.searchParams.set('page', page.toString());
    goto(url.toString(), { replaceState: false });
  }

  function pageUrl(page: any) {
    if (page?.get_url) return page.get_url;
    if (page?.vanity) return `/${username}/${page.vanity}`;
    return `/article/${page.free2zaddr}`;
  }
</script>

<svelte:head>
  <title>{t('dashboard.pages.title', 'My Pages')} - {username}</title>
  <meta name="description" content={t('dashboard.pages.subtitle', 'Manage all your published articles and drafts')} />
</svelte:head>

<main class="flex-1 bg-background text-foreground font-sans relative overflow-hidden selection:bg-primary/30">
  <!-- Background Pattern -->
  <div class="absolute inset-0 bg-[linear-gradient(to_right,#8080800d_1px,transparent_1px),linear-gradient(to_bottom,#8080800d_1px,transparent_1px)] bg-size-[24px_24px] mask-[radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] opacity-20 pointer-events-none"></div>
  <div class="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-blue-500/5 pointer-events-none"></div>

  <div class="max-w-7xl mx-auto px-4 lg:px-8 py-8 lg:py-16 relative z-10">
    
    <!-- Header -->
    <div class="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 lg:mb-12 gap-6">
      <div class="space-y-2">
        <h1 class="text-3xl md:text-5xl font-black tracking-tighter text-foreground">
          My <span class="text-primary">Pages</span>
        </h1>
        <p class="text-muted-foreground text-lg max-w-xl leading-relaxed">
          {t('dashboard.pages.subtitle', 'Manage all your published articles and drafts')}
        </p>
      </div>
      <div class="flex flex-wrap gap-3 w-full md:w-auto">
         <Button href={`/${username}/dashboard/stream`} variant="outline" class="gap-2 border-primary/20 hover:bg-primary/5 hover:text-primary transition-colors">
            <Radio class="size-4" />
            Go Live
         </Button>
         <Button onclick={handleCreateNew} class="gap-2 shadow-lg shadow-primary/20 bg-primary hover:bg-primary/90 text-primary-foreground">
            <Plus class="size-4" />
            {t('dashboard.pages.createNew', 'Create New Page')}
         </Button>
      </div>
    </div>

    <!-- Search & Filter Bar -->
    {#if count > 0 || searchQuery}
      <div class="flex flex-col md:flex-row justify-between items-center gap-4 mb-8 p-1">
        <div class="relative flex-1 max-w-md w-full group">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground group-focus-within:text-primary transition-colors" size={18} />
          <Input
            type="text"
            placeholder={t('dashboard.pages.searchPlaceholder', 'Search pages...')}
            bind:value={searchQuery}
            onkeydown={(e) => e.key === 'Enter' && handleSearch()}
            class="pl-10 bg-muted/40 border-border focus:border-primary/50 focus:ring-primary/20 transition-all"
          />
        </div>
        
        <div class="flex gap-1 bg-muted/40 p-1 rounded-lg border border-border">
          <Button
            variant="ghost"
            size="sm"
            onclick={() => toggleView('list')}
            class="px-3 h-8 {viewMode === 'list' ? 'bg-background shadow-sm text-primary' : 'text-muted-foreground hover:text-foreground'}"
          >
            <List size={16} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onclick={() => toggleView('card')}
            class="px-3 h-8 {viewMode === 'card' ? 'bg-background shadow-sm text-primary' : 'text-muted-foreground hover:text-foreground'}"
          >
            <LayoutGrid size={16} />
          </Button>
        </div>
      </div>

      {#if zpages.length > 0}
        {#if viewMode === 'card'}
             <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
                {#each zpages as zpage (zpage.free2zaddr)}
                    <div class="group relative">
                        <div class="relative">
                            <ZpageCard story={zpage} />
                            
                            <!-- Overlay Actions for Owner -->
                            <div class="absolute top-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-20">
                                <Button href={`/edit?id=${encodeURIComponent(zpage.free2zaddr)}`} size="icon" variant="secondary" class="h-8 w-8 rounded-full bg-background/80 backdrop-blur text-foreground hover:text-primary shadow-sm border border-border">
                                    <Pencil class="size-3.5" />
                                </Button>
                            </div>
                            
                            <!-- Status Badge Overlay (if draft) -->
                            {#if !zpage.is_published}
                                <div class="absolute top-3 left-3 z-20">
                                    <Badge variant="secondary" class="bg-yellow-500/90 text-black border-none shadow-sm backdrop-blur-sm font-bold tracking-wider text-[10px]">DRAFT</Badge>
                                </div>
                            {/if}
                        </div>
                    </div>
                {/each}
             </div>
        {:else}
            <!-- List View -->
            <div class="flex flex-col gap-3">
                {#each zpages as zpage (zpage.free2zaddr)}
                  <div class="group flex items-center gap-4 p-4 bg-card/50 hover:bg-card border border-border rounded-xl transition-all duration-200 hover:border-primary/30 hover:shadow-sm">
                      <!-- Status Indicator Line -->
                      <div class="w-1 self-stretch rounded-full {zpage.is_published ? 'bg-green-500/50' : 'bg-yellow-500/50'}"></div>
                      
                      <div class="flex-1 min-w-0">
                          <div class="flex items-center gap-3 mb-1">
                              <h3 class="font-semibold text-foreground truncate text-lg group-hover:text-primary transition-colors">
                                  {zpage.title || 'Untitled'}
                              </h3>
                              {#if !zpage.is_published}
                                  <Badge variant="outline" class="text-[10px] border-yellow-500/30 text-yellow-500 bg-yellow-500/5 py-0 h-5">Draft</Badge>
                              {/if}
                          </div>
                          
                          <div class="flex items-center gap-4 text-xs text-muted-foreground">
                              <span>Updated {formatRelativeTime(zpage.updated_at)}</span>
                              {#if zpage.vanity}
                                  <span class="text-border">|</span>
                                  <span class="font-mono">/{zpage.vanity}</span>
                              {/if}
                          </div>
                      </div>

                      <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button href={pageUrl(zpage)} variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-foreground" title="View">
                              <Eye class="size-4" />
                          </Button>
                          <Button href={`/edit?id=${encodeURIComponent(zpage.free2zaddr)}`} variant="secondary" size="sm" class="h-8 gap-2">
                              <Pencil class="size-3.5" /> <span class="hidden sm:inline">Edit</span>
                          </Button>
                      </div>
                  </div>
                {/each}
            </div>
        {/if}

        <!-- Pagination -->
        {#if totalPages > 1}
          <div class="flex justify-center items-center gap-2 mt-12 py-8">
             <Button 
                variant="outline" 
                size="sm" 
                disabled={!hasPrevPage} 
                onclick={() => goToPage(currentPage - 1)}
                class="gap-1"
             >
                ← Previous
             </Button>

             <div class="flex gap-1 mx-2">
                {#each Array(Math.min(5, totalPages)) as _, i}
                  {@const pageNum = Math.max(1, Math.min(totalPages - 4, currentPage - 2)) + i}
                  {#if pageNum <= totalPages}
                     <Button 
                        variant={pageNum === currentPage ? "default" : "outline"} 
                        size="icon"
                        class="w-8 h-8"
                        onclick={() => goToPage(pageNum)}
                     >
                        {pageNum}
                     </Button>
                  {/if}
                {/each}
             </div>

             <Button 
                variant="outline" 
                size="sm" 
                disabled={!hasNextPage} 
                onclick={() => goToPage(currentPage + 1)}
                class="gap-1"
             >
                Next →
             </Button>
          </div>
        {/if}

      {:else}
        <div class="text-center py-24 border border-dashed border-border rounded-3xl bg-muted/20">
           <Search class="size-12 text-muted-foreground/30 mx-auto mb-4" />
           <p class="text-muted-foreground text-lg">{t('dashboard.pages.noSearchResults', 'No pages match your search "{query}"').replace('{query}', searchQuery)}</p>
           <Button variant="link" onclick={clearSearch} class="mt-2 text-primary">Clear search</Button>
        </div>
      {/if}
    {:else}
      <!-- Empty State -->
      <div class="flex flex-col items-center justify-center py-24 lg:py-32 text-center border border-dashed border-border rounded-3xl bg-muted/10">
        <div class="bg-primary/10 p-6 rounded-full mb-8 animate-pulse">
            <FileText class="size-16 text-primary" strokeWidth={1.5} />
        </div>
        <h2 class="text-3xl font-bold text-foreground mb-4 tracking-tight">{t('dashboard.pages.noPagesYet', 'No pages yet')}</h2>
        <p class="text-lg text-muted-foreground max-w-lg mb-10 leading-relaxed">
          {t('dashboard.pages.noPagesDescription', 'Get started by creating your first zPage. Share your thoughts, stories, and ideas with the world.')}
        </p>
        <Button onclick={handleCreateNew} size="lg" class="gap-2 rounded-full px-8 shadow-xl shadow-primary/20 bg-primary hover:bg-primary/90 text-primary-foreground">
          <Plus class="size-5" />
          {t('dashboard.pages.createFirst', 'Create Your First Page')}
        </Button>
      </div>
    {/if}
  </div>
</main>
