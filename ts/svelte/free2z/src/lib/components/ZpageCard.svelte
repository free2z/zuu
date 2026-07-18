<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Card, CardContent, CardFooter } from '$lib/components/ui/card';

	export let story: any;

	const apiBase = (env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '');

	function buildImageUrl(imagePath?: string | null): string | null {
		if (!imagePath) return null;
		if (/^https?:\/\//i.test(imagePath)) return imagePath;
		const normalized = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
		return `${apiBase}${normalized.startsWith('/uploadz/') ? '' : '/uploadz'}${normalized}`.replace('/uploadz/uploadz', '/uploadz');
	}

	function articleHref(a: any): string {
		const username = a?.creator?.username;
		if (username && a?.vanity) return `/${username}/${a.vanity}`;
		if (a?.get_url) return a.get_url;
		if (username && a?.free2zaddr) return `/${username}/${a.free2zaddr}`;
		return '/';
	}

	function avatarUrl(c: any): string | null {
		const img = c?.avatar_image?.url || c?.avatar_image?.thumbnail;
		return buildImageUrl(img);
	}

	function fmtDate(iso?: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function truncated(text: string | undefined, len = 140): string {
		if (!text) return '';
		const t = String(text).replace(/\s+/g, ' ').trim();
		if (t.length <= len) return t;
		const cut = t.slice(0, len);
		const last = cut.lastIndexOf(' ');
		return (last > 40 ? cut.slice(0, last) : cut) + '…';
	}

	$: img = buildImageUrl(story?.featured_image?.thumbnail || story?.featured_image?.url);
	$: hav = avatarUrl(story?.creator);
</script>

<Card class="group relative flex flex-col h-full overflow-hidden rounded-2xl glass-card border border-primary/10 transition-all duration-500 hover:border-primary/30 hover:shadow-[0_0_40px_-10px_rgba(132,204,22,0.2)] hover:-translate-y-1 p-0">
    <!-- Card Image with Tech Overlay (Link) -->
    <a href={articleHref(story)} class="relative h-44 overflow-hidden bg-muted block">
        {#if img}
            <img 
                src={img} 
                alt={story.title} 
                loading="lazy"
                class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
            <div class="absolute inset-0 bg-linear-to-t from-background/90 via-transparent to-transparent opacity-60"></div>
        {:else}
            <div class="w-full h-full flex items-center justify-center bg-muted/50">
                <!-- Placeholder Tech Pattern -->
                <svg class="w-12 h-12 text-primary/10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                </svg>
            </div>
        {/if}
        
        {#if story?.category}
            <div class="absolute top-3 right-3 px-2.5 py-1 bg-background/80 backdrop-blur-md rounded-md text-[10px] font-mono font-bold uppercase tracking-wider text-primary border border-primary/20 shadow-sm">
                {story.category}
            </div>
        {/if}
    </a>
    
    <!-- Card Body -->
    <CardContent class="flex-1 p-5 flex flex-col relative pb-0">
        <!-- Date Badge -->
        <div class="flex items-center justify-between mb-2">
            <span class="text-[10px] font-mono text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors"></span>
                {fmtDate(story.created_at)}
            </span>
        </div>

        <a href={articleHref(story)} class="block mb-4 flex-1">
            <h3 class="text-xl font-bold leading-snug group-hover:text-primary transition-colors line-clamp-2 mb-2 tracking-tight">
                {story.title}
            </h3>
            
            {#if story?.description || story?.content}
                <p class="text-sm text-muted-foreground line-clamp-2 leading-relaxed opacity-80">
                    {truncated(story?.description || story?.content, 100)}
                </p>
            {/if}
        </a>
        
        </CardContent>
        <!-- Footer: Author & Action -->
        <CardFooter class="mt-auto pt-3 pb-5 px-5 border-t border-primary/10 flex items-center justify-between gap-3">
            <a href="/{story?.creator?.username}" class="flex items-center gap-2 group/author z-10">
                <div class="relative w-8 h-8 rounded-md overflow-hidden border border-primary/20 group-hover/author:border-primary/50 transition-colors">
                    <img src={hav || undefined} alt={story?.creator?.username} class="w-full h-full object-cover">
                </div>
                <div class="flex flex-col">
                    {#if story?.creator?.full_name}
                        <span class="text-xs font-bold text-foreground line-clamp-1 group-hover/author:text-primary transition-colors">
                            {story.creator.full_name}
                        </span>
                        <span class="text-[10px] text-muted-foreground line-clamp-1">
                            @{story.creator.username}
                        </span>
                    {:else}
                        <span class="text-xs font-bold text-foreground line-clamp-1 group-hover/author:text-primary transition-colors">
                            @{story.creator.username}
                        </span>
                    {/if}
                </div>
            </a>

            <a href={articleHref(story)} class="flex items-center text-[10px] font-mono font-bold text-primary opacity-60 group-hover:opacity-100 transition-all duration-300 gap-1 group-hover:gap-1.5 hover:underline decoration-primary/50 underline-offset-4">
                READ
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
            </a>
        </CardFooter>
    <!-- Hover Glow Border Helper -->
    <div class="absolute inset-0 rounded-2xl pointer-events-none border border-primary/0 group-hover:border-primary/20 transition-colors duration-500"></div>
</Card>
