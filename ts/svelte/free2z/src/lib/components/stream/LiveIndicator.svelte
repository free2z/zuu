<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { StreamService } from '$lib/services/stream';
    import type { StreamInfo } from '$lib/services/stream';
    import StreamSelectionModal from './StreamSelectionModal.svelte';
    import { Users } from '@lucide/svelte';
    import { fade } from 'svelte/transition';
    import { goto } from '$app/navigation';

    const LIVE_STATUS_POLL_INTERVAL_MS = 15000;

    export let username: string;
    export let showCount = true;
    export let size: 'sm' | 'md' | 'lg' = 'md';

    let isLive = false;
    let participantCount = 0;
    let streams: StreamInfo[] = [];
    let interval: number;
    let showModal = false;

    async function checkStatus() {
        const status = await StreamService.checkLiveStatus(username);
        isLive = status.is_live;
        participantCount = status.participant_count || 0;
        streams = status.streams || [];
    }

    function handleClick(e: MouseEvent | KeyboardEvent) {
        e.stopPropagation();
        e.preventDefault();
        
        if (streams.length > 1) {
            showModal = true;
        } else {
            goto(`/live/${username}`);
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' || e.key === ' ') {
            handleClick(e);
        }
    }

    onMount(() => {
        checkStatus();
        interval = window.setInterval(checkStatus, LIVE_STATUS_POLL_INTERVAL_MS);
    });

    onDestroy(() => {
        if (interval) clearInterval(interval);
    });

    const sizeClasses = {
        sm: 'text-xs px-1.5 py-0.5',
        md: 'text-sm px-2.5 py-0.5',
        lg: 'text-base px-3 py-1'
    };
</script>

{#if isLive}
    <div 
        role="button"
        tabindex="0"
        class="inline-flex items-center gap-2 group transition-transform hover:scale-105 cursor-pointer"
        transition:fade
        on:click={handleClick}
        on:keydown={handleKeydown}
    >
        <div class={`relative inline-flex items-center font-bold text-white bg-red-600 rounded-md shadow-sm ${sizeClasses[size]}`}>
            <span class="relative flex h-2 w-2 mr-1.5">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                <span class="relative inline-flex rounded-full h-2 w-2 bg-white"></span>
            </span>
            LIVE
        </div>
        
        {#if showCount && participantCount > 0}
            <div class={`flex items-center gap-1 text-muted-foreground font-medium bg-muted/50 border border-border rounded-md backdrop-blur-sm ${size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-0.5'}`}>
                <Users size={size === 'sm' ? 12 : 14} />
                <span>{participantCount}</span>
            </div>
        {/if}
    </div>

    <StreamSelectionModal bind:open={showModal} {username} {streams} />
{/if}
