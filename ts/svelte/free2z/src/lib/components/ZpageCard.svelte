<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { Card, CardContent, CardFooter } from '$lib/components/ui/card';
	import SmoothImage from '$lib/components/SmoothImage.svelte';
	import { extractPlainText } from '$lib/utils/markdown';

	export let story: any;
	export let compactOnMobile = false;

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
		const img = c?.avatar_image?.thumbnail || c?.avatar_image?.url;
		return buildImageUrl(img);
	}

	function fmtDate(iso?: string): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function truncated(text: string | undefined, len = 140): string {
		return extractPlainText(text || '', len).replace(/\.\.\.$/, '…');
	}

	$: img = buildImageUrl(story?.featured_image?.thumbnail || story?.featured_image?.url);
	$: hav = avatarUrl(story?.creator);
</script>

<Card class={`group relative flex h-full overflow-hidden rounded-xl border border-primary/10 p-0 transition-all duration-200 hover:border-primary/30 ${compactOnMobile ? 'min-h-28 flex-row sm:min-h-0 sm:flex-col' : 'flex-col'} glass-card`}>
    <!-- Card Image with Tech Overlay (Link) -->
    <a href={articleHref(story)} class={`relative block shrink-0 overflow-hidden bg-muted ${compactOnMobile ? 'w-24 sm:h-44 sm:w-full' : 'h-44 w-full'}`}>
        {#if img}
            <SmoothImage
                src={img}
                alt={story.title}
                loading="lazy"
                class="w-full h-full"
                imgClass="transition-transform duration-200 group-hover:scale-[1.02]"
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
    <CardContent class={`relative flex flex-1 flex-col ${compactOnMobile ? 'min-w-0 p-3 sm:p-5 sm:pb-0' : 'p-5 pb-0'}`}>
        <!-- Date Badge -->
        <div class="mb-1.5 flex items-center justify-between sm:mb-2">
            <span class={`${compactOnMobile ? 'text-[11px] leading-none sm:text-xs sm:leading-normal' : 'text-xs'} flex items-center gap-1.5 text-muted-foreground`}>
                <span class="w-1.5 h-1.5 rounded-full bg-primary/40 group-hover:bg-primary transition-colors"></span>
                {fmtDate(story.created_at)}
            </span>
        </div>

        <a href={articleHref(story)} class="block flex-1 sm:mb-4">
            <h3 class={`${compactOnMobile ? 'text-sm leading-tight sm:text-xl sm:leading-snug' : 'text-xl leading-snug'} mb-1.5 line-clamp-2 font-bold tracking-tight transition-colors group-hover:text-primary sm:mb-2 ${compactOnMobile ? 'sm:min-h-[3.5rem]' : 'min-h-[3.5rem]'}`}>
                {story.title}
            </h3>

            <!-- Reserve a fixed blurb area so every card is the same height and
                 the footer lines up regardless of title/description length.
                 On compact mobile the reservation only applies at sm+. -->
            <div class={compactOnMobile ? 'sm:min-h-[2.5rem]' : 'min-h-[2.5rem]'}>
                {#if story?.description || story?.content}
                    <p class={`${compactOnMobile ? 'text-xs leading-snug sm:text-sm sm:leading-relaxed' : 'text-sm leading-relaxed'} line-clamp-2 text-muted-foreground opacity-80`}>
                        {truncated(story?.description || story?.content, 100)}
                    </p>
                {/if}
            </div>
        </a>
        
        </CardContent>
        <!-- Footer: Author & Action -->
        <CardFooter class={`${compactOnMobile ? 'hidden sm:flex' : 'flex'} mt-auto items-center justify-between gap-3 border-t border-primary/10 px-5 pt-3 pb-5`}>
            <a href="/{story?.creator?.username}" class="flex min-h-11 items-center gap-2 group/author z-10">
                <div class="relative w-8 h-8 rounded-md overflow-hidden border border-primary/20 group-hover/author:border-primary/50 transition-colors">
                    <SmoothImage src={hav} alt={story?.creator?.username} loading="lazy" class="w-full h-full" />
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

            <a href={articleHref(story)} class="flex min-h-11 min-w-11 items-center justify-end text-[10px] font-mono font-bold text-primary opacity-60 group-hover:opacity-100 transition-all duration-300 gap-1 group-hover:gap-1.5 hover:underline decoration-primary/50 underline-offset-4">
                Read
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
            </a>
        </CardFooter>
    <!-- Hover Glow Border Helper -->
    <div class="pointer-events-none absolute inset-0 rounded-xl border border-primary/0 transition-colors duration-200 group-hover:border-primary/20"></div>
</Card>
