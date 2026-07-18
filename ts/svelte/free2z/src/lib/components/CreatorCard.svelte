<script lang="ts">
	import { Check } from '@lucide/svelte';
	import { Card, CardContent } from '$lib/components/ui/card';
	import * as Avatar from '$lib/components/ui/avatar';
	import LiveIndicator from '$lib/components/stream/LiveIndicator.svelte';

	export let creator: any;
	export let avatarUrl: (c?: any) => string | null;
	export let buildImageUrl: (imagePath?: string | null) => string | null;
	export let fmtDate: (iso?: string) => string;
</script>

<Card class="group relative glass-card overflow-hidden hover:border-primary/50 transition-all duration-500 hover:-translate-y-2 flex flex-col sm:aspect-square h-[220px] sm:h-auto border-border/40 p-0 rounded-2xl">
	<a 
		href={`/${creator.username}`}
		class="absolute inset-0 z-0"
		aria-label={`View ${creator.display_name || creator.username}'s profile`}
	></a>

	<div 
		class="h-[35%] bg-muted bg-cover bg-center relative overflow-hidden shrink-0 pointer-events-none"
		style:background-image={buildImageUrl(creator.banner_image?.url || creator.banner_image?.thumbnail) ? `url(${buildImageUrl(creator.banner_image?.url || creator.banner_image?.thumbnail)})` : ''}
	>
		<div class="absolute inset-0 bg-linear-to-t from-background/90 to-black/20 group-hover:from-background/70 transition-all duration-500"></div>
		<div class="absolute inset-0 opacity-[0.03] group-hover:opacity-[0.07] pointer-events-none bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-size-[100%_4px,4px_100%] transition-opacity"></div>
	</div>

	<div class="absolute top-2 right-2 z-20 pointer-events-auto">
		<LiveIndicator username={creator.username} size="sm" showCount={false} />
	</div>
	
	<CardContent class="flex flex-col items-center text-center px-4 pb-4 -mt-10 relative z-10 grow justify-between pointer-events-none p-0">
		<div class="flex flex-col items-center w-full space-y-3">
			<div class="relative group/avatar">
				<!-- Glowing Ring -->
				<div class="absolute -inset-1 bg-linear-to-tr from-primary via-primary/50 to-blue-400 rounded-full blur opacity-10 group-hover:opacity-50 transition duration-700"></div>
				
				<Avatar.Root class="relative w-20 h-20 border-4 border-background shadow-md dark:shadow-2xl group-hover:scale-105 transition-transform duration-500">
					<Avatar.Image src={avatarUrl(creator) || undefined} alt={creator.username} class="object-cover" />
					<Avatar.Fallback class="bg-muted text-muted-foreground">{creator.username.substring(0, 2).toUpperCase()}</Avatar.Fallback>
				</Avatar.Root>
				
				{#if creator.is_verified}
					<div class="absolute bottom-1 right-1">
						<div class="bg-primary text-primary-foreground p-1 rounded-full shadow-lg border-2 border-background flex items-center justify-center">
							<Check class="w-2 h-2 stroke-4" />
						</div>
					</div>
				{/if}
			</div>
			
			<div class="w-full min-w-0 space-y-1">
				<h3 class="font-black text-sm sm:text-base truncate tracking-tight uppercase group-hover:text-primary transition-colors duration-300">
					{creator.display_name || creator.full_name || creator.username}
				</h3>
				
				<div class="flex flex-col items-center gap-1">
					<span class="text-[11px] font-mono font-bold text-primary tracking-widest uppercase opacity-70">
						@{creator.username}
					</span>
					
					<div class="flex items-center justify-center gap-1.5 text-[9px] font-black text-muted-foreground uppercase tracking-tighter">
						<span class="opacity-80">
							{creator.zpages || 0} {creator.zpages === 1 ? 'POST' : 'POSTS'}
						</span>
						{#if creator.last_post_at || creator.date_joined}
							<span class="w-0.5 h-0.5 rounded-full bg-muted-foreground/30"></span>
							<span class="opacity-60">{fmtDate(creator.last_post_at || creator.date_joined)}</span>
						{/if}
					</div>
				</div>
			</div>
		</div>
	</CardContent>
	<div class="h-0.5 w-full bg-linear-to-r from-transparent via-primary/10 to-transparent group-hover:via-primary/40 transition-all duration-500 pointer-events-none"></div>
</Card>
