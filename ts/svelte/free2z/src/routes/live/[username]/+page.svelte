<script lang="ts">
    import { page } from '$app/stores';
    import { authStore } from '$lib/stores/auth';
    import LiveStreamViewer from '$lib/components/stream/LiveStreamViewer.svelte';
    import { Button } from '$lib/components/ui/button';
    import { ArrowLeft } from '@lucide/svelte';

    export let data: any;

    $: ({ username, type, creator } = data);
    $: currentUser = $authStore.creator;
    $: isHost = currentUser?.username === username;

    $: displayName = creator?.full_name || username;
    
    // SEO
    $: title = `${displayName} is Live! - Free2Z`;
    $: description = creator?.description 
        ? `Watch ${displayName}'s live stream. ${creator.description.slice(0, 150)}${creator.description.length > 150 ? '...' : ''}`
        : `Watch ${displayName}'s live stream on Free2Z.`;
    
    $: bannerUrl = creator?.banner_image?.url || creator?.banner_image;
    $: avatarUrl = creator?.avatar_image?.thumbnail || creator?.avatar_image?.url || creator?.avatar_image;
    $: ogImage = bannerUrl || avatarUrl;
</script>

<svelte:head>
    <title>{title}</title>
    <meta name="description" content={description} />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:type" content="video.other" />
    <meta property="og:url" content={$page.url.href} />
    {#if ogImage}
        <meta property="og:image" content={ogImage} />
    {/if}
</svelte:head>

<div class="flex-1 bg-black flex flex-col">
    <!-- Header -->
    <div class="bg-zinc-900 border-b border-zinc-800 p-4 flex items-center justify-between">
        <div class="flex items-center gap-4">
            <Button variant="ghost" size="sm" href={`/${username}`} class="text-zinc-400 hover:text-white">
                <ArrowLeft class="w-4 h-4 mr-2" />
                Back to Profile
            </Button>
            <div class="flex items-center gap-2">
                <div class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                <h1 class="text-white font-bold text-lg">
                    {displayName} <span class="text-zinc-500 font-normal">is live</span>
                </h1>
            </div>
        </div>
    </div>

    <!-- Main Viewer -->
    <div class="flex-1 relative">
        {#key `${username}-${type}`}
            <LiveStreamViewer 
                {username} 
                streamType={type} 
                {isHost} 
            />
        {/key}
    </div>
</div>
