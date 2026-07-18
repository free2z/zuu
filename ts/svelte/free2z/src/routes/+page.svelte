<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { isAuthenticated } from '$lib/stores/auth';
	import { Button } from '$lib/components/ui/button';
	import CreatorCard from '$lib/components/CreatorCard.svelte';
	import ZpageCard from '$lib/components/ZpageCard.svelte';
	import HomeCTA from '$lib/components/HomeCTA.svelte';
	export let data: {
		heroStory: any | null;
		trending: any[];
		popular: any[];
		creators: any[];
	};

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

	function avatarUrl(c?: any): string | null {
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

	const hero = data.heroStory;
	const trending = data.trending || [];
	const popular = data.popular || [];
	const creators = (() => {
		const all = data.creators || [];
		const seen = new Set();
		return all.filter((c) => {
			if (!c?.username || seen.has(c.username)) return false;
			seen.add(c.username);
			return true;
		});
	})();

	// Derive topics (tags + categories) from incoming items
	const topicCount = new Map<string, number>();
	function addTopic(t?: string) {
		if (!t) return;
		const key = t.trim();
		if (!key) return;
		topicCount.set(key, (topicCount.get(key) || 0) + 1);
	}
	[...trending, ...popular].forEach((a) => {
		(a?.tags || []).forEach((t: string) => addTopic(t));
		addTopic(a?.category);
	});
	const topics = Array.from(topicCount.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([t]) => t)
		.slice(0, 12);
</script>


<svelte:head>
	<title>Free2Z — Read. Publish. Get Discovered.</title>
	<meta name="description" content="Modern, multi‑author publishing on Free2Z. Discover trending stories, top creators, and popular reads." />
</svelte:head>

<div class="relative flex flex-col gap-24 py-12 mesh-gradient flex-1">
	<!-- Background Elements -->
	<div class="absolute inset-0 overflow-hidden pointer-events-none">
		<!-- Tech Grid Background -->
		<div
			class="absolute inset-0 bg-[linear-gradient(to_right,#8080800d_1px,transparent_1px),linear-gradient(to_bottom,#8080800d_1px,transparent_1px)] bg-size-[24px_24px] mask-[radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"
		></div>
		<!-- Animated Glow Effect -->
		<div
			class="absolute -top-[200px] left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-primary/15 rounded-full blur-[120px] animate-pulse"
		></div>
	</div>

	<!-- Top Section: Featured & Popular -->
	<section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
		<div class="grid lg:grid-cols-12 gap-12">
			
			<!-- Featured Post (Left) -->
			<div class="lg:col-span-8">
				{#if hero}
					{@const img = buildImageUrl(hero?.featured_image?.url || hero?.featured_image?.thumbnail)}
					{@const hav = avatarUrl(hero?.creator)}
					
					<div class="group flex flex-col gap-6">
						<!-- Header Meta -->
						<div class="flex items-center justify-between border-b border-dashed border-border/40 pb-4">
							<div class="flex items-center gap-3">
								<div class="relative flex h-1.5 w-1.5">
									<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
									<span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary"></span>
								</div>
								<span class="font-mono text-xs font-bold uppercase tracking-widest text-primary">Featured Story</span>
							</div>
							<span class="font-mono text-xs text-muted-foreground">{fmtDate(hero.created_at)}</span>
						</div>

							<div class="relative aspect-2/1 w-full rounded-2xl overflow-hidden shadow-sm border border-border/50 bg-muted/20 group-hover:border-primary/20 transition-colors">
								<a href={articleHref(hero)} class="block w-full h-full group/img">
									{#if img}
										<img 
											src={img} 
											alt={hero?.title} 
											class="w-full h-full object-cover transition-all duration-700 ease-out group-hover:scale-105"
										/>
										<div class="absolute inset-0 bg-linear-to-t from-background/10 to-transparent"></div>
									{:else}
										<div class="w-full h-full bg-muted/30 flex items-center justify-center">
											<svg class="w-20 h-20 text-muted-foreground/10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
											</svg>
										</div>
									{/if}
								</a>

								<!-- Floating Author Badge -->
								<a 
									href="/{hero?.creator?.username}"
									class="group/author absolute bottom-4 left-4 z-10 bg-background/90 backdrop-blur-md border border-border pr-5 pl-1.5 py-1.5 rounded-2xl flex items-center gap-3 shadow-lg hover:scale-105 transition-transform"
								>
									<div class="w-8 h-8 rounded-full overflow-hidden border border-primary/20 bg-muted">
										<img src={hav || undefined} alt={hero?.creator?.username} class="w-full h-full object-cover">
									</div>
									<div class="flex flex-col leading-none gap-0.5">
										<span class="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">By</span>
										<span class="text-xs font-bold text-foreground group-hover/author:text-primary transition-colors">{hero?.creator?.full_name || hero?.creator?.username}</span>
									</div>
								</a>
							</div>

						<div class="space-y-4">
							<a href={articleHref(hero)} class="block group/title space-y-3">
								<div class="inline-flex items-center px-2 py-1 bg-primary/5 border border-primary/10 rounded text-[10px] font-bold uppercase tracking-wider text-primary mb-2">
									{hero.category || 'Story'}
								</div>
								
								<h1 class="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tight leading-[1.05] pb-1 group-hover/title:text-primary transition-colors line-clamp-2">
									{hero?.title}
								</h1>
								
								{#if hero?.description || hero?.content}
									<p class="text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-3xl line-clamp-3 font-light">
										{truncated(hero?.description || hero?.content, 220)}
									</p>
								{/if}
							</a>

							<!-- Action Area -->
							<div class="pt-2">
								<a href={articleHref(hero)} class="inline-flex items-center gap-2 text-primary font-bold group-hover:gap-4 transition-all duration-300">
									<span class="relative text-sm tracking-wide uppercase">
										Read Full Story
										<span class="absolute -bottom-1 left-0 w-0 h-0.5 bg-primary transition-all duration-300 group-hover:w-full"></span>
									</span>
									<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
								</a>
							</div>
						</div>
					</div>
				{:else}
					<div class="space-y-6 animate-pulse">
						<div class="flex justify-between border-b pb-4 border-dashed border-border/40">
							<div class="h-4 w-32 bg-muted rounded"></div>
							<div class="h-4 w-24 bg-muted rounded"></div>
						</div>
						<div class="aspect-2/1 bg-muted rounded-2xl w-full"></div>
						<div class="space-y-4">
							<div class="h-16 bg-muted rounded-xl w-3/4"></div>
							<div class="h-24 bg-muted rounded-xl w-full"></div>
						</div>
					</div>
				{/if}
			</div>

			<!-- Popular Reads (Right) -->
			<div class="lg:col-span-4 space-y-8 pl-4">
				<div class="flex items-center justify-between pb-2 border-b border-border">
					<h2 class="text-xl font-black tracking-tight flex items-center gap-2">
						<span class="text-primary">#</span> Popular Reads
					</h2>
					<Button 
						variant="ghost" 
						href="#trending" 
						size="sm" 
						class="text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-primary gap-1 px-2 h-8"
					>
						View More
						<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
					</Button>
				</div>

				<div class="flex flex-col gap-2">
					{#each popular.slice(0, 5) as p, i}
						{@const thumb = buildImageUrl(p?.featured_image?.thumbnail || p?.featured_image?.url)}
						<a 
							href={articleHref(p)}
							class="group relative flex gap-4 items-center p-3 rounded-xl hover:bg-muted/40 transition-all duration-300 border border-transparent hover:border-primary/5"
						>
							<!-- Thumbnail -->
							<div class="w-20 h-20 shrink-0 rounded-lg overflow-hidden bg-muted border border-border/40 relative shadow-sm group-hover:shadow-md transition-all">
								{#if thumb}
									<img src={thumb} alt={p.title} class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
								{:else}
									<div class="w-full h-full flex items-center justify-center bg-muted/50">
										<svg class="w-6 h-6 text-muted-foreground/20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
										</svg>
									</div>
								{/if}
							</div>

							<!-- Content -->
							<div class="space-y-1.5 min-w-0 flex-1">
								<div class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider">
									<span class="text-primary transition-colors dark:group-hover:text-white">{p.category || 'Story'}</span>
									<span class="text-muted-foreground/40">•</span>
									<span class="text-muted-foreground">{fmtDate(p.created_at)}</span>
								</div>
								
								<h3 class="font-bold text-sm leading-snug line-clamp-2 group-hover:text-primary transition-colors">
									{p.title}
								</h3>
								
								<div class="flex items-center gap-2 pt-0.5">
									<div class="w-5 h-5 rounded-full overflow-hidden bg-muted border border-border shrink-0">
										{#if avatarUrl(p.creator)}
											<img src={avatarUrl(p.creator)} alt="" class="w-full h-full object-cover" />
										{/if}
									</div>
									<span class="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors truncate">
										{p?.creator?.full_name || p?.creator?.username}
									</span>
								</div>
							</div>
						</a>
					{/each}
				</div>

				<!-- Topics Quick Links -->
				{#if topics.length}
					<div class="pt-6 border-t border-dashed border-border">
						<h3 class="text-[10px] font-black uppercase tracking-widest text-muted-foreground mb-4 flex items-center gap-2">
							<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"/></svg>
							Trending
						</h3>
						<div class="flex flex-wrap gap-2">
							{#each topics.slice(0, 8) as t}
								<a 
									href="/search?q={encodeURIComponent(t)}" 
									class="text-xs px-2.5 py-1 rounded-md bg-muted/50 hover:bg-primary/10 hover:text-primary transition-colors font-medium border border-transparent hover:border-primary/20"
								>
									#{t}
								</a>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</section>

	<!-- Topics -->
	{#if topics.length}
		<section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
			<div class="glass-card rounded-2xl p-8 sm:p-12 relative overflow-hidden border border-primary/10">
				<!-- Animated background glow -->
				<div class="absolute top-0 right-0 w-96 h-96 bg-primary/10 rounded-full blur-[100px] -mr-32 -mt-32 pointer-events-none animate-pulse"></div>
				
				<div class="relative z-10 flex flex-col lg:flex-row lg:items-start gap-12">
					<div class="lg:w-1/3 space-y-6">
						<div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 w-fit">
							<svg class="w-3 h-3 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"/></svg>
							<span class="text-[10px] font-bold uppercase tracking-widest text-primary">Discover</span>
						</div>
						
						<h2 class="text-3xl font-black tracking-tighter">Explore by <span class="text-primary">Topic</span></h2>
						<p class="text-muted-foreground text-lg leading-relaxed">Dive into the conversations that matter. Find exactly what you're looking for across our diverse ecosystem.</p>
					</div>
					
					<div class="lg:w-2/3 flex flex-wrap content-start gap-3">
						{#each topics as t}
							<a 
								href="/search?q={encodeURIComponent(t)}" 
								class="px-4 py-2 rounded-lg bg-background/50 border border-border hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all duration-300 text-sm font-medium"
							>
								#{t}
							</a>
						{/each}
					</div>
				</div>
			</div>
		</section>
	{/if}

	<!-- Trending Grid -->
	<section id="trending" class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
		<!-- Background decorative elements -->
		<div class="absolute left-0 top-20 w-1/4 h-3/4 bg-primary/5 rounded-full blur-[120px] -z-10 pointer-events-none"></div>

		<div class="flex flex-col sm:flex-row sm:items-end justify-between gap-8 mb-12">
			<div class="space-y-4 max-w-2xl">
				<div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 w-fit">
					<span class="relative flex h-2 w-2">
					  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
					  <span class="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
					</span>
					<span class="text-[10px] font-bold uppercase tracking-widest text-primary">Trending Now</span>
				</div>
				
				<div>
					<h2 class="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tighter">
						Community <span class="text-primary">Favorites</span>
					</h2>
					<p class="mt-4 text-lg text-muted-foreground leading-relaxed">
						The stories, articles, and updates capturing the attention of the Free2Z community right now.
					</p>
				</div>
			</div>

			<Button 
				variant="outline" 
				href="/search"
				class="shrink-0 group gap-2 "
			>
				Explore All Trending
				<svg class="w-4 h-4 transition-transform group-hover:translate-x-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
			</Button>
		</div>
		
		<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-12">
			{#each trending.slice(0, 9) as a (a.free2zaddr)}
				<ZpageCard story={a} />
			{/each}
		</div>
	</section>

	<!-- Creators Spotlight -->
	{#if creators.length}
		<section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 relative">
			<!-- Decorative background element -->
			<div class="absolute right-0 top-0 w-1/3 h-full bg-linear-to-b from-primary/5 to-transparent blur-3xl -z-10 pointer-events-none"></div>

			<div class="flex flex-col sm:flex-row sm:items-end justify-between gap-6 mb-12">
				<div class="space-y-4 max-w-2xl">
					<div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 w-fit">
						<span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
						<span class="text-[10px] font-bold uppercase tracking-widest text-primary">Community</span>
					</div>
					
					<div>
						<h2 class="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tighter">
							Featured <span class="text-primary">Creators</span>
						</h2>
						<p class="mt-4 text-lg text-muted-foreground leading-relaxed">
							Discover the innovative voices and decentralized storytellers shaping the future of content on Free2Z.
						</p>
					</div>
				</div>
			<Button 
				variant="outline" 
			href="/creators"
				class="shrink-0 group gap-2 "
			>
		View Creator Directory
					<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
				</Button>

				
			</div>
			
			<div class="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6 lg:gap-8">
				{#each creators as creator (creator.username)}
					<div class="group relative">
						<div class="absolute -inset-px bg-linear-to-b from-primary/30 to-transparent rounded-xl opacity-0 group-hover:opacity-100 transition duration-500 pointer-events-none"></div>
						<CreatorCard {creator} {avatarUrl} {buildImageUrl} {fmtDate} />
					</div>
				{/each}
			</div>
		</section>
	{/if}
{#if !$isAuthenticated}
	<HomeCTA />
	{/if}

</div>

