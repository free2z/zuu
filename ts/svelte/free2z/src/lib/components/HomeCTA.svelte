<script lang="ts">
	import { Button } from '$lib/components/ui/button';
</script>

<section class="relative z-10 mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6 sm:pb-24 lg:px-8">
	<div class="mx-auto max-w-5xl text-center">
		<h2 class="mb-6 text-4xl font-black tracking-tighter leading-[0.95] sm:mb-8 sm:text-6xl sm:leading-[0.9] lg:text-7xl">
			Own your content.<br />
			<span
				class="text-transparent bg-clip-text bg-linear-to-r from-primary to-emerald-400 animate-gradient bg-300%"
				>Monetize your mind.</span
			>
		</h2>

		<p
			class="text-lg sm:text-2xl text-muted-foreground font-light max-w-2xl mx-auto leading-relaxed"
		>
			Skip the gatekeepers. Publish on the blockchain, earn anonymously, and build a community
			that truly belongs to you.
		</p>

		<!-- Stats / Trust Indicators -->
		<div
			class="mx-auto mt-8 mb-8 grid max-w-2xl grid-cols-3 gap-2 border-y border-dashed border-border/60 py-6 sm:mt-12 sm:mb-12 sm:gap-8 sm:py-8"
		>
			<div class="flex flex-col group/stat hover:-translate-y-1 transition-transform">
				<span class="text-2xl font-black text-foreground sm:text-3xl">100%</span>
				<span class="mt-1 break-words text-[10px] font-bold uppercase tracking-normal text-muted-foreground sm:text-xs sm:tracking-wider"
					>Ownership</span
				>
			</div>
			<div class="flex flex-col group/stat hover:-translate-y-1 transition-transform delay-75">
				<span class="text-2xl font-black text-foreground sm:text-3xl">0</span>
				<span class="mt-1 break-words text-[10px] font-bold uppercase tracking-normal text-muted-foreground sm:text-xs sm:tracking-wider"
					>Intermediaries</span
				>
			</div>
			<div
				class="flex flex-col group/stat hover:-translate-y-1 transition-transform delay-150"
			>
				<span class="text-2xl font-black text-foreground sm:text-3xl">∞</span>
				<span class="mt-1 break-words text-[10px] font-bold uppercase tracking-normal text-muted-foreground sm:text-xs sm:tracking-wider"
					>Possibilities</span
				>
			</div>
		</div>

		<div class="flex flex-col sm:flex-row items-center justify-center gap-4">
			<Button
				href="/login?view=signup&next=%2Fedit"
				class="min-h-11 w-full sm:min-h-9 sm:w-auto group/btn"
			>
				Start Writing Now
				<svg
					class="w-4 h-4 transition-transform group-hover/btn:translate-x-1"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					><path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M13 7l5 5m0 0l-5 5m5-5H6"
					/></svg
				>
			</Button>
			<Button
				variant="outline"
				href="https://free2z.com/docs/getting-started/"
				target="_blank"
				rel="noreferrer"
				class="min-h-11 w-full sm:min-h-9 sm:w-auto"
			>
				How it Works
			</Button>
		</div>

		<p class="mt-6 text-xs font-mono text-muted-foreground opacity-60">
			// No credit card required. Private by default.
		</p>
	</div>
</section>
