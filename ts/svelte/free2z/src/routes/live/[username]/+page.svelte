<script lang="ts">
    import { env } from '$env/dynamic/public';
    import { authStore } from '$lib/stores/auth';
    import LiveStreamViewer from '$lib/components/stream/LiveStreamViewer.svelte';
    import { Button } from '$lib/components/ui/button';
    import { ArrowLeft } from '@lucide/svelte';
    import SeoHead from '$lib/components/SeoHead.svelte';
    import { CANONICAL_ORIGIN, compactText, toAbsoluteUrl } from '$lib/seo';

    export let data: any;
    const canonicalOrigin =
        env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, '') || CANONICAL_ORIGIN;
    const mediaOrigin = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || canonicalOrigin;

    $: ({ username, type, creator } = data);
    $: currentUser = $authStore.creator;
    $: isHost = currentUser?.username === username;

    $: displayName = creator?.full_name || username;
    
    $: title = `${displayName} is Live! - Free2Z`;
    $: description = compactText(
        creator?.description,
        `Watch ${displayName}'s live stream on Free2Z.`,
    );
    
    $: bannerUrl = creator?.banner_image?.url || creator?.banner_image?.thumbnail ||
        (typeof creator?.banner_image === 'string' ? creator.banner_image : null);
    $: avatarUrl = creator?.avatar_image?.thumbnail || creator?.avatar_image?.url ||
        (typeof creator?.avatar_image === 'string' ? creator.avatar_image : null);
    $: ogImage = toAbsoluteUrl(bannerUrl || avatarUrl || '/brand/free2z-og.png', mediaOrigin);
</script>

<SeoHead
    {title}
    {description}
    path={`/live/${encodeURIComponent(username)}`}
    type="video.other"
    image={ogImage}
    imageAlt={`${displayName}'s live stream on Free2Z`}
/>

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
