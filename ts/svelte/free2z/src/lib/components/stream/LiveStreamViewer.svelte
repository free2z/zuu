<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { fade } from 'svelte/transition';
    import { StreamService, PaymentRequiredError, liveStatusQueryKey, type StreamInfo } from '$lib/services/stream';
    import { useQueryClient } from '@tanstack/svelte-query';
    import { initRtkMeeting } from '$lib/utils/rtk-manager';
    import { liveStreamStore } from '$lib/stores/liveStreamStore';
    import type { StreamType } from '$lib/stores/liveStreamStore';
    import { defineCustomElements } from '@cloudflare/realtimekit-ui/loader';
    import { Loader2, AlertCircle, Lock, WifiOff, RefreshCw, VideoOff, MicOff, CameraOff } from '@lucide/svelte';
    import Button from '../ui/button/button.svelte';
    import SubscribeToCreator from './SubscribeToCreator.svelte';
    import PayPerViewPrompt from './PayPerViewPrompt.svelte';
    import { createCreatorRetrieve } from '$lib/api/creator/creator';
    import { toast } from 'svelte-sonner';
    import { goto } from '$app/navigation';
    import { authStore } from '$lib/stores/auth';

    export let username: string;
    export let streamType: StreamType = 'broadcast';
    export let isHost: boolean = false;

    const queryClient = useQueryClient();

    let loading = true;
    let error: string | null = null;
    let warning: string | null = null;
    let isPaymentRequired = false;
    let cleanup: (() => void | Promise<void>) | null = null;
    
    let showSubscribe = false;
    let showPPV = false;
    let ppvPrice = 0;
    
    // Retry logic
    let retryCount = 0;
    const MAX_RETRIES = 5;
    let retryTimeout: NodeJS.Timeout;

    // Alternative streams
    let otherStreams: StreamInfo[] = [];

    // Subscribe to store
    $: meeting = $liveStreamStore.meeting;
    $: connectionStatus = $liveStreamStore.connectionStatus;
    $: isOffline = $liveStreamStore.isOffline;
    $: storeError = $liveStreamStore.error;

    // React to store errors
    $: if (storeError) {
        error = storeError;
        loading = false;
        // If we are disconnected unexpectedly, we might want to try auto-reconnecting
        if (connectionStatus === 'disconnected' && !isOffline && retryCount < MAX_RETRIES) {
             handleRetry();
        }
    }

    // React to stream end
    $: if (connectionStatus === 'ended') {
        toast.info('The stream has ended.');
        loading = false;
        error = null;
        void queryClient.invalidateQueries({ queryKey: liveStatusQueryKey(username) });
    }
    
    const creatorQuery = createCreatorRetrieve(username);
    $: creator = $creatorQuery.data;
    $: isSubscribed = Boolean($authStore.creator?.stars?.includes(username));

    function handleOnline() {
        liveStreamStore.setOffline(false);
        toast.success("You are back online!");
        if (error && !isPaymentRequired) {
             handleRetry();
        }
    }

    function handleOffline() {
        liveStreamStore.setOffline(true);
        toast.error("You are offline. Please check your connection.");
    }

    onMount(async () => {
        // Register RealtimeKit web components
        defineCustomElements();
        
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        
        // Initial check
        if (!navigator.onLine) {
            handleOffline();
        }

        await joinStream();
    });

    onDestroy(() => {
        if (cleanup) cleanup();
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
        clearTimeout(retryTimeout);
    });

    async function joinStream(retry = false) {
        if (cleanup) {
            await cleanup();
            cleanup = null;
        }

        if (!retry) {
            loading = true;
            retryCount = 0;
        }
        
        error = null;
        warning = null;
        isPaymentRequired = false;

        try {
            // 1. Get Auth Token
            const { auth_token } = await StreamService.initStream(username, streamType);

            // 2. Initialize Meeting
            const result = await initRtkMeeting({
                authToken: auth_token,
                streamType,
                isHost,
                defaults: {
                    audio: isHost,
                    video: isHost
                }
            });
            cleanup = result.cleanup;
            warning = result.warning || null;
            void queryClient.invalidateQueries({ queryKey: liveStatusQueryKey(username) });
            
            if (warning) {
                toast.warning(warning, { duration: 8000 });
            }

            if (!retry) {
                toast.success('Joined stream successfully!');
            }
            
            loading = false; // Ensure loading is false on success

        } catch (err: any) {
            console.error('Failed to join stream:', err);
            error = err.message || 'Failed to join stream';
            isPaymentRequired = err instanceof PaymentRequiredError;
            
            if (streamType === 'ppv' && isPaymentRequired) {
                 const status = await StreamService.checkLiveStatus(username);
                 const stream = status.streams?.find(s => s.type === 'ppv');
                 if (stream && stream.price_per_minute) {
                     ppvPrice = Number(stream.price_per_minute);
                 }
                 toast.info('Payment required to watch.', {
                    action: {
                        label: 'Pay Now',
                        onClick: openPPV
                    },
                    duration: 8000
                 });
            } else if (streamType === 'subscribers-only' && isPaymentRequired) {
                 toast.info('Subscribers only stream.', {
                    action: {
                        label: isSubscribed ? 'Manage' : 'Subscribe',
                        onClick: openSubscribe
                    },
                    duration: 8000
                 });
            } else if (!isPaymentRequired) {
                // Check for other streams if current one failed
                try {
                    const status = await StreamService.checkLiveStatus(username);
                    if (status.is_live && status.streams) {
                        otherStreams = status.streams.filter(s => s.type !== streamType);
                    }
                } catch (e) {
                    console.error('Failed to check alternative streams', e);
                }

                if (retryCount < MAX_RETRIES) {
                    // Auto-retry for non-payment errors (likely network or transient)
                    const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
                    console.log(`Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
                    retryCount++;
                    retryTimeout = setTimeout(() => joinStream(true), delay);
                    return; // Don't stop loading yet
                } else {
                     toast.error(error || 'Failed to join stream');
                }
            }
            // If we reached here without returning, we stop loading
            loading = false;
        }
    }

    function handleRetry() {
        clearTimeout(retryTimeout);
        joinStream();
    }
    
    function openSubscribe() {
        showSubscribe = true;
    }
    
    function openPPV() {
        showPPV = true;
    }

</script>

<div class="relative w-full h-full min-h-[400px] bg-black rounded-lg overflow-hidden flex flex-col items-center justify-center">
    
    {#if loading}
        <div class="flex flex-col items-center gap-4 text-white" transition:fade>
            <Loader2 class="w-10 h-10 animate-spin text-primary" />
            <div class="flex flex-col items-center">
                <p class="font-medium">{retryCount > 0 ? `Retrying connection...` : 'Joining stream...'}</p>
                {#if retryCount > 0}
                    <p class="text-sm text-gray-400">Attempt {retryCount}/{MAX_RETRIES}</p>
                    <Button variant="link" class="text-xs p-0 h-auto mt-2" onclick={handleRetry}>
                        Retry Now
                    </Button>
                {/if}
            </div>
        </div>
    {:else if isOffline}
         <div class="flex flex-col items-center gap-4 text-white p-8 text-center max-w-md" transition:fade>
            <div class="w-16 h-16 bg-yellow-500/20 rounded-full flex items-center justify-center text-yellow-500 mb-2">
                <WifiOff class="w-8 h-8" />
            </div>
            <h3 class="text-xl font-bold">You are Offline</h3>
            <p class="text-gray-300">Please check your internet connection.</p>
            <Button 
                class="bg-white/10 hover:bg-white/20 text-white px-6 py-2 rounded-full font-medium mt-4"
                onclick={handleRetry}
            >
                <RefreshCw class="w-4 h-4 mr-2" />
                Reconnect
            </Button>
        </div>
    {:else if connectionStatus === 'ended'}
        <div class="flex flex-col items-center gap-4 text-white p-8 text-center max-w-md" transition:fade>
            <div class="w-16 h-16 bg-zinc-800 rounded-full flex items-center justify-center text-zinc-400 mb-2">
                <VideoOff class="w-8 h-8" />
            </div>
            <h3 class="text-xl font-bold">Stream Ended</h3>
            <p class="text-gray-300">The broadcast has finished.</p>
            <Button 
                class="bg-white/10 hover:bg-white/20 text-white px-6 py-2 rounded-full font-medium mt-4"
                href={`/${username}`}
            >
                View Profile
            </Button>
        </div>
    {:else if error}
        <div class="flex flex-col items-center gap-4 text-white p-8 text-center max-w-md" transition:fade>
            <div class="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center text-red-500 mb-2">
                {#if isPaymentRequired}
                    <Lock class="w-8 h-8" />
                {:else}
                    <AlertCircle class="w-8 h-8" />
                {/if}
            </div>
            <h3 class="text-xl font-bold">Unable to Join</h3>
            <p class="text-gray-300">{error}</p>
            
            {#if streamType === 'subscribers-only' && isPaymentRequired}
                <Button 
                    class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-full font-medium mt-4"
                    onclick={openSubscribe}
                >
                    {isSubscribed ? 'Manage subscription' : `Subscribe to ${username}`}
                </Button>
            {:else if streamType === 'ppv' && isPaymentRequired}
                 <div class="flex flex-col gap-2 mt-4 w-full">
                    <p class="text-sm text-gray-400">This is a Pay-Per-View stream.</p>
                    <Button 
                        class="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-full font-medium w-full"
                        onclick={openPPV}
                    >
                        Start Watching ({ppvPrice > 0 ? `${ppvPrice} 2Z/min` : ''})
                    </Button>
                 </div>
            {:else}
                <Button 
                    class="bg-white/10 hover:bg-white/20 text-white px-6 py-2 rounded-full font-medium mt-4"
                    onclick={handleRetry}
                >
                    <RefreshCw class="w-4 h-4 mr-2" />
                    Try Again
                </Button>
            {/if}
            
            {#if otherStreams.length > 0}
                <div class="mt-6 pt-6 border-t border-white/10 w-full">
                    <h4 class="text-sm font-medium text-gray-400 mb-3">Other active streams:</h4>
                    <div class="flex flex-col gap-2">
                        {#each otherStreams as stream}
                            <Button 
                                class="bg-white/5 hover:bg-white/10 text-white justify-start w-full"
                                onclick={() => goto(`/live/${username}?type=${stream.type}`)}
                            >
                                <span>Watch {stream.type} ({stream.participant_count} viewers)</span>
                            </Button>
                        {/each}
                    </div>
                </div>
            {/if}
        </div>
    {:else if meeting}
        <!-- RealtimeKit Meeting Component -->
        <rtk-meeting
            mode="fill"
            {meeting}
            show-setup-screen={false}
            class="w-full h-full"
        ></rtk-meeting>

        <!-- Persistent Warning for Host (e.g. Permission Denied) -->
        {#if warning && isHost}
            <div class="absolute top-4 left-1/2 -translate-x-1/2 z-50 bg-yellow-500/90 text-black px-4 py-2 rounded-lg flex items-center gap-3 shadow-lg max-w-[90%] backdrop-blur-sm" transition:fade>
                <div class="shrink-0">
                    <MicOff class="w-5 h-5" />
                </div>
                <span class="text-sm font-medium">{warning}</span>
                <Button variant="ghost" size="icon" class="ml-2 h-6 w-6 rounded-full hover:bg-black/10 text-primary-foreground" onclick={() => warning = null}>
                    <span class="sr-only">Dismiss</span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                </Button>
            </div>
        {/if}
    {/if}
</div>

{#if creator}
    <SubscribeToCreator 
        {creator} 
        bind:open={showSubscribe} 
        onOpenChange={(open) => {
            showSubscribe = open;
            if (!open) {
                // Optional: retry joining if they closed the modal (assuming they might have subscribed)
                // But better to let them click "Try Again" or handle it in onSuccess if we added it.
                // For now, manual retry is fine.
            }
        }}
    />
    
    <PayPerViewPrompt
        {creator}
        price={ppvPrice}
        bind:open={showPPV}
        onSuccess={() => {
            joinStream();
        }}
    />
{/if}
