<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import Home from '@lucide/svelte/icons/home';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	const errorMap: Record<number, { title: string; description: string }> = {
		400: {
			title: 'Bad Request',
			description: 'The server could not understand the request due to invalid syntax.'
		},
		401: {
			title: 'Unauthorized',
			description: 'You need to be logged in to access this page.'
		},
		403: {
			title: 'Forbidden',
			description: 'You do not have permission to access this resource.'
		},
		404: {
			title: 'Not Found',
			description: "We couldn't find the page you're looking for. It may have been moved, renamed, or temporarily unavailable."
		},
		500: {
			title: 'Server Error',
			description: 'Something went wrong on our end. Please try again later.'
		},
		503: {
			title: 'Service Unavailable',
			description: 'The server is currently unavailable. Please try again later.'
		}
	};

	const currentStatus = $derived(page.status);
	const errorInfo = $derived({
		title: page.error?.message || errorMap[currentStatus]?.title || 'Unknown Error',
		description: errorMap[currentStatus]?.description || 'Something went wrong. Please try again or contact support.'
	});

	function goBack() {
		if (window.history.length > 1) {
			window.history.back();
			return;
		}

		void goto('/');
	}
</script>

<svelte:head>
	<title>{currentStatus} — {errorInfo.title} | Free2Z</title>
	<meta name="robots" content="noindex, nofollow, noarchive" />
</svelte:head>

<div class="relative h-[calc(100vh-3.5rem)] w-full shrink-0 flex flex-col items-center justify-center overflow-hidden bg-background">
	<!-- Abstract Background (Entire Page) -->
	<div class="absolute inset-0 overflow-hidden pointer-events-none select-none">
		<!-- Gradient -->
		<div class="absolute inset-0 bg-linear-to-b from-primary/5 via-transparent to-primary/5"></div>
		
		<!-- Animated Rings (Centered) -->
		<div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-50 scale-50 sm:scale-75 md:scale-100">
			<!-- Inner Ring -->
			<div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
				<div class="w-[300px] h-[300px] border-[3px] border-primary/30 rounded-full animate-[spin_12s_linear_infinite]"></div>
			</div>
			<!-- Middle Ring -->
			<div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
				<div class="w-[500px] h-[500px] border-2 border-dashed border-primary/20 rounded-full animate-[spin_20s_linear_infinite_reverse]"></div>
			</div>
			<!-- Outer Ring -->
			<div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
				<div class="w-[700px] h-[700px] border border-primary/30 rounded-full animate-[spin_30s_linear_infinite]"></div>
			</div>
			<!-- Extra Outer Ring -->
			<div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
				<div class="w-[900px] h-[900px] border-4 border-dotted border-primary/10 rounded-full animate-[spin_60s_linear_infinite_reverse]"></div>
			</div>
		</div>

		<!-- Floating Particles -->
		<div class="absolute top-1/4 left-1/4 w-4 h-4 bg-primary/20 rounded-full animate-bounce delay-100"></div>
		<div class="absolute bottom-1/3 right-1/4 w-3 h-3 bg-primary/10 rounded-full animate-bounce delay-300"></div>
		<div class="absolute top-1/3 right-1/3 w-2 h-2 bg-primary/10 rounded-full animate-pulse"></div>
		<div class="absolute bottom-1/4 left-1/3 w-2 h-2 bg-primary/20 rounded-full animate-pulse delay-700"></div>
	</div>

	<!-- Content -->
	<div class="relative z-10 text-center space-y-4 sm:space-y-8 max-w-lg mx-auto px-6 animate-float-up">
		<div class="space-y-4">
			<h1 class="text-[5rem] sm:text-[7rem] md:text-[10rem] leading-none font-black tracking-tighter text-transparent bg-clip-text bg-linear-to-b from-foreground to-foreground/50 transition-all duration-500 hover:scale-105 hover:to-primary/50 select-none cursor-default drop-shadow-sm">
				{currentStatus}
			</h1>
			<h2 class="text-2xl sm:text-3xl font-bold text-foreground tracking-tight">{errorInfo.title}</h2>
			<p class="text-muted-foreground text-base sm:text-lg max-w-md mx-auto leading-relaxed">
				{errorInfo.description}
			</p>
		</div>

		<div class="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 pt-4 sm:pt-8">
			<Button variant="outline" onclick={goBack} class="w-full sm:w-auto gap-2 min-w-[140px] transition-all ">
				<ArrowLeft class="w-4 h-4" />
				Go Back
			</Button>
			<Button href="/" variant="default" class="w-full sm:w-auto gap-2 min-w-[140px] transition-all  shadow-lg hover:shadow-primary/25">
				<Home class="w-4 h-4" />
				Return Home
			</Button>
		</div>
	</div>
</div>
