<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { browser } from '$app/environment';
    import { page } from '$app/stores';
    import { beforeNavigate } from '$app/navigation';
    import {  currentUser } from '$lib/stores/auth';
    import { goto } from '$app/navigation';
    import { StreamService } from '$lib/services/stream';
    import { initDyteMeeting } from '$lib/utils/dyte-manager';
    import { liveStreamStore, participantCount, isConnected } from '$lib/stores/liveStreamStore';
    import type { StreamType } from '$lib/stores/liveStreamStore';
    import { defineCustomElements } from '@dytesdk/ui-kit/loader';
    import { provideDyteDesignSystem } from '@dytesdk/ui-kit';
    import { Users, Radio, DollarSign, Video, Lock, WifiOff, Mic, Settings } from '@lucide/svelte';
    import { Button, buttonVariants } from '$lib/components/ui/button';
    import { Input } from '$lib/components/ui/input';
    import { Label } from "$lib/components/ui/label";
    import { createMediaQuery } from "$lib/utils/media-query";
    import * as Dialog from "$lib/components/ui/dialog";
    import * as Drawer from "$lib/components/ui/drawer";
    import * as Select from "$lib/components/ui/select/index.js";
    import AudioRecorder from '$lib/components/stream/AudioRecorder.svelte';
    import { toast } from 'svelte-sonner';
    import PageHeader from '$lib/components/PageHeader.svelte';

    $: username = $page.params.username;
    // We can use the currentUser store directly as it was in the component
    $: user = $currentUser;
    $: meeting = $liveStreamStore.meeting;
    $: connected = $isConnected;
    $: count = $participantCount;
    $: isOffline = $liveStreamStore.isOffline;

    let streamType: StreamType = 'broadcast';
    let ppvPrice: number = 1;
    let loading = false;
    let error: string | null = null;
    let cleanup: (() => void) | null = null;
    let isLeaving = false;
    let meetingEl: HTMLElement;

    // Stream Settings
    let videoQuality = '720p';
    $: videoQualityLabel = qualityOptions.find((o) => o.value === videoQuality)?.label ?? "HD (720p)";
    const isDesktop = createMediaQuery("(min-width: 768px)");
    let settingsOpen = false;

    $: if (meetingEl) {
        provideDyteDesignSystem(meetingEl, {
            theme: 'dark',
            borderRadius: 'rounded',
            borderWidth: 'thin',
            colors: {
                brand: {
                    300: '#bef264', // Lime-300
                    400: '#a3e635', // Lime-400
                    500: '#84cc16', // Lime-500 (Primary)
                    600: '#65a30d', // Lime-600
                    700: '#4d7c0f'  // Lime-700
                },
                background: {
                    1000: '#060f06', // Black Green (App Secondary BG)
                    900: '#0a160a',  
                    800: '#112211',  
                    700: '#1a2e1a',  
                    600: '#243a24'   
                },
                text: '#ffffff',
                'text-on-brand': '#000000',
                'video-bg': '#060f06',
                danger: '#ef4444',  // Red-500
                success: '#84cc16', // Lime-500
                warning: '#eab308'  // Yellow-500
            }
        });
    }

    const qualityOptions = [
        { value: '360p', label: 'Low (360p)' },
        { value: '480p', label: 'Standard (480p)' },
        { value: '720p', label: 'HD (720p)' },
        { value: '1080p', label: 'Full HD (1080p)' }
    ];
    
    function handleBeforeUnload(event: BeforeUnloadEvent) {
        if (!connected || isLeaving) return;
        event.preventDefault();
        event.returnValue = '';
        return '';
    }

    function handleOnline() {
        liveStreamStore.setOffline(false);
        toast.success("Connection restored!");
    }

    function handleOffline() {
        liveStreamStore.setOffline(true);
        toast.error("You are offline. Stream may be interrupted.");
    }

    beforeNavigate(({ cancel, to }) => {
        if (connected && !isLeaving) {
            if (!confirm('Stream is active. Are you sure you want to leave? This will end the stream.')) {
                cancel();
            } else {
                if (to) {
                    cancel();
                    isLeaving = true;

                    const cleanupAndNavigate = async () => {
                        if (cleanup) {
                            await cleanup();
                            cleanup = null;
                        }
                        goto(to.url);
                    };
                    cleanupAndNavigate();
                } else {
                    isLeaving = true;
                }
            }
        }
    });

    onMount(() => {
        defineCustomElements();
        
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        
        // Initial check
        if (!navigator.onLine) {
            handleOffline();
        }

        // Server-side protection is in +page.server.ts
        // This is a client-side fallback
        if (!user || user.username !== username) {
           goto('/');
        }
    });

    onDestroy(() => {
        if (cleanup) cleanup();
        if (browser) {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        }
    });

    async function startStream() {
        if (!user) return;

        if (!user.can_stream) {
            error = "You need at least 150 Tuzis to start a live stream.";
            return;
        }
        
        loading = true;
        error = null;

        try {
            if (streamType === 'private') {
                // Private stream flow
                const { secret } = await StreamService.createPrivateStream(user.username);
                
                // Copy link to clipboard
                const url = `${window.location.origin}/${user.username}/private/${secret}`;
                try {
                    await navigator.clipboard.writeText(url);
                    toast.success('Secret link copied to clipboard!');
                } catch (e) {
                    console.error('Failed to copy link', e);
                    toast.error('Stream created. Click "Copy Link" on the next page.');
                }

                await goto(`/${user.username}/private/${secret}`);
                return;
            }

            // 1. Initialize Stream via API
            const { auth_token } = await StreamService.initStream(
                user.username, 
                streamType, 
                streamType === 'ppv' ? ppvPrice : undefined
            );

            // Helper to get constraints
            const getVideoConstraints = (quality: string) => {
                switch (quality) {
                    case '1080p': return { height: { ideal: 1080 }, width: { ideal: 1920 } };
                    case '720p': return { height: { ideal: 720 }, width: { ideal: 1280 } };
                    case '480p': return { height: { ideal: 480 }, width: { ideal: 854 } };
                    case '360p': return { height: { ideal: 360 }, width: { ideal: 640 } };
                    default: return { height: { ideal: 720 }, width: { ideal: 1280 } };
                }
            };

            // 2. Initialize Dyte Meeting
            const { cleanup: cleanupFn, meeting: meetingInstance } = await initDyteMeeting({
                authToken: auth_token,
                streamType,
                isHost: true,
                defaults: {
                    audio: true,
                    video: true,
                    mediaConfiguration: {
                        video: getVideoConstraints(videoQuality)
                    }
                }
            });
            cleanup = cleanupFn;

            if (meetingInstance) {
                meetingInstance.self.on('roomLeft', async ({ state }: { state: string }) => {
                    if (state === 'left' || state === 'ended') {
                        isLeaving = true;
                        if (cleanup) {
                            await cleanup();
                            cleanup = null;
                        }
                        toast.success('Stream ended.');
                        goto(`/${username}/dashboard/pages`);
                    }
                });
            }

            toast.success('Stream started successfully! You are live.');

        } catch (err: any) {
            console.error('Failed to start stream:', err);
            error = err.message || 'Failed to start stream';
            toast.error(error || 'Failed to start stream');
        } finally {
            loading = false;
        }
    }

</script>

<svelte:head>
    <title>Stream Dashboard - {username}</title>
</svelte:head>

<svelte:window on:beforeunload={handleBeforeUnload} />

<div class="w-full flex-1 flex flex-col">
    {#if !connected && !meeting}
        <PageHeader 
            title="Go Live" 
            titleSuffix="." 
            subtitle="Choose your audience and start streaming." 
            onBack={() => goto(`/${username}/dashboard/pages`)}
        />
    {/if}

    <div class={(!connected && !meeting) 
        ? "mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8 flex-1" 
        : "w-full h-screen flex flex-col"}>
        <div class="relative w-full h-full flex flex-col">
            
            <!-- Connection/Offline Status -->
            {#if isOffline}
                <div class="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
                    <div class="flex flex-col items-center gap-4 text-center p-6 bg-card border border-destructive rounded-xl shadow-lg animate-in fade-in zoom-in duration-300">
                            <div class="w-16 h-16 bg-destructive/20 rounded-full flex items-center justify-center text-destructive mb-2 animate-pulse">
                            <WifiOff class="w-8 h-8" />
                        </div>
                        <h3 class="text-xl font-bold text-destructive">Connection Lost</h3>
                        <p class="text-muted-foreground max-w-xs">You are currently offline. The stream may be interrupted for viewers.</p>
                    </div>
                </div>
            {/if}

            {#if !connected && !meeting}
                <!-- Setup Form -->
                <div class="w-full flex-1 flex flex-col justify-center ">
                
                {#if !user?.can_stream}
                    <div class="bg-yellow-500/10 border border-yellow-500/20 p-6 rounded-xl text-yellow-600 dark:text-yellow-400 text-center max-w-2xl mx-auto">
                        <p class="text-lg font-medium">You need at least 150 Tuzis to start a live stream.</p>
                        <p class="text-sm opacity-80 mt-2">Earn more Tuzis by engaging with the community.</p>
                    </div>
                {:else}
                    <div class="space-y-8 w-full max-w-5xl mx-auto ">
                        
                        <!-- Stream Settings & Audio Check -->
                        <div class="flex justify-end">
                            {#if $isDesktop}
                                <Dialog.Root bind:open={settingsOpen}>
                                    <Dialog.Trigger class={buttonVariants({ variant: "outline", size: "sm" })}>
                                        <Settings size={16} class="mr-2" />
                                        Settings
                                    </Dialog.Trigger>
                                    <Dialog.Content class="sm:max-w-[425px]">
                                        <Dialog.Header>
                                            <Dialog.Title>Stream Settings</Dialog.Title>
                                            <Dialog.Description>
                                                Configure your stream quality and test your audio.
                                            </Dialog.Description>
                                        </Dialog.Header>
                                        <div class="space-y-6 py-4">
                                            <div class="space-y-3">
                                                <Label>Video Quality</Label>
                                                <Select.Root type="single" bind:value={videoQuality}>
                                                    <Select.Trigger class="w-full">
                                                        {videoQualityLabel}
                                                    </Select.Trigger>
                                                    <Select.Content>
                                                        {#each qualityOptions as option}
                                                            <Select.Item value={option.value} label={option.label}>
                                                                {option.label}
                                                            </Select.Item>
                                                        {/each}
                                                    </Select.Content>
                                                </Select.Root>
                                                <p class="text-xs text-muted-foreground">Higher quality requires better internet connection.</p>
                                            </div>
                                            <div class="space-y-3">
                                                    <AudioRecorder />
                                            </div>
                                        </div>
                                    </Dialog.Content>
                                </Dialog.Root>
                            {:else}
                                <Drawer.Root bind:open={settingsOpen}>
                                    <Drawer.Trigger class={buttonVariants({ variant: "outline", size: "sm" })}>
                                        <Settings size={16} class="mr-2" />
                                        Settings
                                    </Drawer.Trigger>
                                    <Drawer.Content>
                                        <Drawer.Header class="text-left">
                                            <Drawer.Title>Stream Settings</Drawer.Title>
                                            <Drawer.Description>
                                                Configure your stream quality and test your audio.
                                            </Drawer.Description>
                                        </Drawer.Header>
                                        <div class="space-y-6 px-4 py-4">
                                            <div class="space-y-3">
                                                <Label >Video Quality</Label>
                                                <Select.Root type="single" bind:value={videoQuality}>
                                                    <Select.Trigger class="w-full">
                                                        {videoQualityLabel}
                                                    </Select.Trigger>
                                                    <Select.Content>
                                                        {#each qualityOptions as option}
                                                            <Select.Item value={option.value} label={option.label}>
                                                                {option.label}
                                                            </Select.Item>
                                                        {/each}
                                                    </Select.Content>
                                                </Select.Root>
                                                <p class="text-xs text-muted-foreground">Higher quality requires better internet connection.</p>
                                            </div>
                                            <div class="space-y-3">
                                                    <AudioRecorder />
                                            </div>
                                        </div>
                                        <Drawer.Footer class="pt-2">
                                            <Drawer.Close class={buttonVariants({ variant: "outline" })}>Close</Drawer.Close>
                                        </Drawer.Footer>
                                    </Drawer.Content>
                                </Drawer.Root>
                            {/if}
                        </div>

                        <!-- Stream Type Selection -->
                        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            <!-- Broadcast -->
                            <Button 
                                variant="outline"
                                class={`h-auto relative flex flex-col items-start p-6 rounded-xl border-2 transition-all duration-300 text-left group hover:-translate-y-1 hover:shadow-lg ${streamType === 'broadcast' ? 'border-primary bg-primary/5 ring-4 ring-primary/10' : 'border-border bg-card hover:border-primary/50 hover:bg-card'}`}
                                onclick={() => streamType = 'broadcast'}
                            >
                                <div class={`mb-4 rounded-full p-3 w-12 h-12 flex items-center justify-center transition-colors ${streamType === 'broadcast' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:bg-primary/20 group-hover:text-primary'}`}>
                                    <Radio size={24} />
                                </div>
                                <h3 class="font-bold text-lg mb-2">Broadcast</h3>
                                <p class="text-sm text-muted-foreground leading-relaxed whitespace-normal">Public, free for everyone. Maximize your reach.</p>
                                <p class="text-xs text-orange-500 mt-2 font-medium flex items-center gap-1">
                                    <span class="text-lg">⚠️</span> Cost: 1 Tuzi/2min per participant
                                </p>
                                {#if streamType === 'broadcast'}
                                    <div class="absolute top-4 right-4 text-primary">
                                        <div class="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
                                    </div>
                                {/if}
                            </Button>

                            <!-- Subscribers Only -->
                            <Button 
                                variant="outline"
                                class={`h-auto relative flex flex-col items-start p-6 rounded-xl border-2 transition-all duration-300 text-left group hover:-translate-y-1 hover:shadow-lg ${streamType === 'subscribers-only' ? 'border-purple-500 bg-purple-500/5 ring-4 ring-purple-500/10' : 'border-border bg-card hover:border-purple-500/50 hover:bg-card'}`}
                                onclick={() => streamType = 'subscribers-only'}
                            >
                                <div class={`mb-4 rounded-full p-3 w-12 h-12 flex items-center justify-center transition-colors ${streamType === 'subscribers-only' ? 'bg-purple-500 text-white' : 'bg-muted text-muted-foreground group-hover:bg-purple-500/20 group-hover:text-purple-500'}`}>
                                    <Users size={24} />
                                </div>
                                <h3 class="font-bold text-lg mb-2">Subscribers</h3>
                                <p class="text-sm text-muted-foreground leading-relaxed whitespace-normal">Exclusive content for your monthly supporters.</p>
                            </Button>

                            <!-- Pay Per View -->
                            <Button 
                                variant="outline"
                                class={`h-auto relative flex flex-col items-start p-6 rounded-xl border-2 transition-all duration-300 text-left group hover:-translate-y-1 hover:shadow-lg ${streamType === 'ppv' ? 'border-green-500 bg-green-500/5 ring-4 ring-green-500/10' : 'border-border bg-card hover:border-green-500/50 hover:bg-card'}`}
                                onclick={() => streamType = 'ppv'}
                            >
                                <div class={`mb-4 rounded-full p-3 w-12 h-12 flex items-center justify-center transition-colors ${streamType === 'ppv' ? 'bg-green-500 text-white' : 'bg-muted text-muted-foreground group-hover:bg-green-500/20 group-hover:text-green-500'}`}>
                                    <DollarSign size={24} />
                                </div>
                                <h3 class="font-bold text-lg mb-2">Pay Per View</h3>
                                <p class="text-sm text-muted-foreground leading-relaxed whitespace-normal">Monetize directly. Viewers pay per minute.</p>
                            </Button>

                            <!-- Private -->
                            <Button 
                                variant="outline"
                                class={`h-auto relative flex flex-col items-start p-6 rounded-xl border-2 transition-all duration-300 text-left group hover:-translate-y-1 hover:shadow-lg ${streamType === 'private' ? 'border-orange-500 bg-orange-500/5 ring-4 ring-orange-500/10' : 'border-border bg-card hover:border-orange-500/50 hover:bg-card'}`}
                                onclick={() => streamType = 'private'}
                            >
                                <div class={`mb-4 rounded-full p-3 w-12 h-12 flex items-center justify-center transition-colors ${streamType === 'private' ? 'bg-orange-500 text-white' : 'bg-muted text-muted-foreground group-hover:bg-orange-500/20 group-hover:text-orange-500'}`}>
                                    <Lock size={24} />
                                </div>
                                <h3 class="font-bold text-lg mb-2">Private</h3>
                                <p class="text-sm text-muted-foreground leading-relaxed whitespace-normal">1-on-1 private call. Generate a secret link.</p>
                            </Button>
                        </div>

                        <!-- PPV Settings -->
                        {#if streamType === 'ppv'}
                            <div class="bg-card border border-border rounded-xl p-6 animate-in fade-in slide-in-from-top-2 shadow-sm max-w-md mx-auto">
                                <span class="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 block">Price per Minute (Tuzis)</span>
                                <div class="relative">
                                    <DollarSign class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground z-10" size={16} />
                                    <Input 
                                        type="number" 
                                        min="0.1"
                                        step="0.1"
                                        bind:value={ppvPrice}
                                        class="w-full bg-background py-6 pl-10 pr-4 font-mono text-lg"
                                        placeholder="1.0"
                                    />
                                </div>
                            </div>
                        {/if}

                        {#if error}
                            <div class="text-destructive text-sm text-center bg-destructive/10 border border-destructive/20 p-4 rounded-lg flex items-center justify-center gap-2 max-w-2xl mx-auto animate-in fade-in">
                                <span>⚠️</span> {error}
                            </div>
                        {/if}

                        <div class="pt-8 flex justify-center">
                            <Button 
                                class="w-full max-w-md bg-primary hover:bg-primary/90 text-primary-foreground py-6 rounded-xl font-bold text-lg shadow-lg shadow-primary/20 hover:shadow-primary/40 hover:-translate-y-0.5 transition-all flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
                                disabled={loading}
                                onclick={startStream}
                            >
                                {#if loading}
                                    <div class="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                                    <span>Starting Stream...</span>
                                {:else}
                                    <Video size={24} />
                                    <span>Start {streamType === 'broadcast' ? 'Broadcast' : 'Stream'}</span>
                                {/if}
                            </Button>
                        </div>
                    </div>
                {/if}
            </div>

        {:else if meeting}
            <!-- Dyte Meeting Interface -->
            <div class="relative w-full h-full bg-[#060f06] rounded-2xl overflow-hidden shadow-2xl border border-white/10">
                <!-- Participant Count Overlay -->
                <div class="absolute top-4 left-4 z-10 flex items-center gap-2 pointer-events-none">
                    <div class="bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full flex items-center gap-2 text-white border border-white/10 shadow-lg">
                        <div class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                        <span class="font-bold text-xs tracking-wider">LIVE</span>
                        <span class="w-px h-3 bg-white/20"></span>
                        <div class="flex items-center gap-1.5">
                            <Users size={14} class="text-zinc-300" />
                            <span class="font-mono text-sm font-medium">{count}</span>
                        </div>
                    </div>
                </div>

                <!-- @ts-ignore -->
                <dyte-meeting
                    bind:this={meetingEl}
                    mode="fill"
                    meeting={meeting}
                    show-setup-screen={true}
                    class="w-full h-full"
                ></dyte-meeting>
            </div>
        {/if}
    </div>
</div>
</div>
