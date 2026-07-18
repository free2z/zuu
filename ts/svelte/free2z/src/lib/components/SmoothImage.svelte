<script lang="ts">
	import { fade } from 'svelte/transition';
	import type { HTMLImgAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils.js';

	type Props = Omit<HTMLImgAttributes, 'src' | 'class'> & {
		src?: string | null;
		class?: string;
		imgClass?: string;
		showStatus?: boolean;
		loadingLabel?: string;
		errorLabel?: string;
	};

	let {
		src,
		alt = '',
		class: className,
		imgClass,
		showStatus = false,
		loadingLabel = 'Loading image…',
		errorLabel = 'Image unavailable',
		...restProps
	}: Props = $props();

	let img = $state<HTMLImageElement | null>(null);
	let loaded = $state(false);
	let failed = $state(false);
	let lastSrc = $state(src);

	// Cached images can finish before hydration attaches the load handler.
	$effect(() => {
		if (src !== lastSrc) {
			lastSrc = src;
			loaded = false;
			failed = false;
			img = null;
			return;
		}
		if (img?.complete) {
			if (img.naturalWidth > 0) loaded = true;
			else if (src) failed = true;
		}
	});
</script>

<div
	class={cn('relative overflow-hidden bg-muted', className)}
	aria-busy={src && !loaded && !failed ? 'true' : undefined}
>
	{#if src && !failed}
		{#key src}
			<img
				bind:this={img}
				{...restProps}
				{src}
				{alt}
				decoding="async"
				onload={() => (loaded = true)}
				onerror={() => {
					loaded = false;
					failed = true;
				}}
				class={cn('h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none', imgClass)}
				style:opacity={loaded ? null : 0}
			/>
		{/key}
	{/if}
	{#if !loaded}
		<div
			class={cn(
				'absolute inset-0 flex items-center justify-center bg-muted pointer-events-none',
				src && !failed && 'animate-pulse motion-reduce:animate-none'
			)}
			aria-hidden={showStatus ? undefined : 'true'}
			out:fade={{ duration: 300 }}
		>
			{#if showStatus}
				<span class="rounded-full bg-background/80 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
					{failed || !src ? errorLabel : loadingLabel}
				</span>
			{/if}
		</div>
	{/if}
	{#if showStatus}
		<span class="sr-only" aria-live="polite">
			{loaded ? `${alt || 'Image'} loaded` : failed || !src ? errorLabel : loadingLabel}
		</span>
	{/if}
</div>
