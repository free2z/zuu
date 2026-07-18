<script lang="ts">
    import { goto } from "$app/navigation";
    import * as Dialog from "$lib/components/ui/dialog";
    import { Users, Radio, DollarSign, Video } from "@lucide/svelte";
    import { Button } from '$lib/components/ui/button';
    import type { StreamInfo } from "$lib/services/stream";

    export let open = false;
    export let username: string;
    export let streams: StreamInfo[] = [];

    function handleJoin(stream: StreamInfo) {
        open = false;
        // Navigate to the stream with type param
        goto(`/live/${username}?type=${stream.type}`);
    }
</script>

<Dialog.Root bind:open>
    <Dialog.Content class="sm:max-w-[425px]">
        <Dialog.Header>
            <Dialog.Title>Join {username}'s Stream</Dialog.Title>
            <Dialog.Description>
                {username} has multiple live streams running. Choose which one you want to join.
            </Dialog.Description>
        </Dialog.Header>
        
        <div class="grid gap-4 py-4">
            {#each streams as stream}
                <Button
                    variant="outline"
                    class="h-auto flex items-center justify-between p-4 rounded-lg transition-all text-left group w-full border-zinc-700 bg-zinc-800/50 hover:bg-zinc-800 hover:border-zinc-600"
                    onclick={() => handleJoin(stream)}
                >
                    <div class="flex items-center gap-3">
                        <div class={`p-2 rounded-full ${
                            stream.type === 'broadcast' ? 'bg-blue-500/20 text-blue-400' :
                            stream.type === 'subscribers-only' ? 'bg-purple-500/20 text-purple-400' :
                            'bg-green-500/20 text-green-400'
                        }`}>
                            {#if stream.type === 'broadcast'}
                                <Radio size={20} />
                            {:else if stream.type === 'subscribers-only'}
                                <Users size={20} />
                            {:else}
                                <DollarSign size={20} />
                            {/if}
                        </div>
                        <div>
                            <h4 class="font-medium text-white group-hover:text-blue-400 transition-colors capitalize">
                                {stream.type.replace('-', ' ')}
                            </h4>
                            <div class="flex items-center gap-2 text-sm text-zinc-400">
                                <span class="flex items-center gap-1">
                                    <Users size={12} />
                                    {stream.participant_count} viewers
                                </span>
                                {#if stream.price_per_minute}
                                    <span>•</span>
                                    <span>{stream.price_per_minute} 2Zs/min</span>
                                {/if}
                            </div>
                        </div>
                    </div>
                    <div class="text-zinc-500 group-hover:text-white transition-colors">
                        <Video size={20} />
                    </div>
                </Button>
            {/each}
        </div>
    </Dialog.Content>
</Dialog.Root>
