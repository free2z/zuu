<script lang="ts">
	import { Button } from '$lib/components/ui/button';
</script>
	<section class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-24">
		<div
			class="relative overflow-hidden rounded-3xl border border-primary/20 bg-background/50 backdrop-blur-3xl shadow-2xl group"
		>
			<!-- Tech Grid Background -->
			<div
				class="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-size-[24px_24px] mask-[radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"
			></div>

			<!-- Animated Glow Effect -->
			<div
				class="absolute -top-[200px] left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-primary/20 rounded-full blur-[120px] pointer-events-none animate-pulse"
			></div>

			<div class="relative z-10 px-8 py-20 sm:p-24 text-center">
				<!-- Badge -->
				<div
					class="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/30 bg-primary/5 backdrop-blur-sm mb-8 transition-all hover:bg-primary/10"
				>
					<span class="relative flex h-2 w-2">
						<span
							class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"
						></span>
						<span class="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
					</span>
					<span class="text-[10px] font-mono font-bold uppercase tracking-wider text-primary"
						>Web3 Publishing Reimagined</span
					>
				</div>

				<h2 class="text-5xl sm:text-6xl lg:text-7xl font-black tracking-tighter leading-[0.9] mb-8">
					Own Your Content.<br />
					<span
						class="text-transparent bg-clip-text bg-linear-to-r from-primary to-emerald-400 animate-gradient bg-300%"
						>Monetize Your Mind.</span
					>
				</h2>

				<p
					class="text-xl sm:text-2xl text-muted-foreground font-light max-w-2xl mx-auto leading-relaxed"
				>
					Skip the gatekeepers. Publish on the blockchain, earn anonymously, and build a community
					that truly belongs to you.
				</p>

				<!-- Stats / Trust Indicators -->
				<div
					class="grid grid-cols-3 gap-8 max-w-2xl mx-auto mt-12 mb-12 py-8 border-y border-dashed border-border/60"
				>
					<div class="flex flex-col group/stat hover:-translate-y-1 transition-transform">
						<span class="text-3xl font-black text-foreground">100%</span>
						<span class="text-xs text-muted-foreground uppercase tracking-wider font-bold mt-1"
							>Ownership</span
						>
					</div>
					<div class="flex flex-col group/stat hover:-translate-y-1 transition-transform delay-75">
						<span class="text-3xl font-black text-foreground">0</span>
						<span class="text-xs text-muted-foreground uppercase tracking-wider font-bold mt-1"
							>Intermediaries</span
						>
					</div>
					<div
						class="flex flex-col group/stat hover:-translate-y-1 transition-transform delay-150"
					>
						<span class="text-3xl font-black text-foreground">∞</span>
						<span class="text-xs text-muted-foreground uppercase tracking-wider font-bold mt-1"
							>Possibilities</span
						>
					</div>
				</div>

				<div class="flex flex-col sm:flex-row items-center justify-center gap-4">
					<Button
						href="/register"
						size="lg"
						class="h-14 px-8 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-lg font-bold w-full sm:w-auto shadow-[0_0_20px_rgba(132,204,22,0.3)] hover:shadow-[0_0_30px_rgba(132,204,22,0.5)] transition-all duration-300 group/btn"
					>
						Start Writing Now
						<svg
							class="w-5 h-5 ml-2 transition-transform group-hover/btn:translate-x-1"
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
						href="/about"
						size="lg"
						class="h-14 px-8 rounded-full border-primary/20 hover:bg-primary/5 text-lg font-bold w-full sm:w-auto backdrop-blur-sm"
					>
						How it Works
					</Button>
				</div>

				<p class="mt-6 text-xs font-mono text-muted-foreground opacity-60">
					// No credit card required. Private by default.
				</p>
			</div>
		</div>
	</section>
