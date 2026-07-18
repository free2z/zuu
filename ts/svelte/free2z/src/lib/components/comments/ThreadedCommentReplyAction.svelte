<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import { MessageSquare } from '@lucide/svelte';
    import type { CommentData } from './types';
    import CommentForm from './CommentForm.svelte';
    import { Button } from "$lib/components/ui/button";
    import { tStore as t } from '$lib/i18n';

    export let comment: CommentData;
    export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
    export let object_uuid: string | undefined = undefined;

    let formOpen = false;
    const dispatch = createEventDispatcher();

    function handleCallback() {
        formOpen = false;
        dispatch('reload');
    }
</script>

<div class="w-full">
    <Button 
        variant="ghost"
        size="sm"
        class="text-primary hover:text-primary/80 w-full justify-start pl-2"
        onclick={() => formOpen = !formOpen}
    >
        <MessageSquare class="size-4 mr-2" />
        <span>{$t('comments.reply', "Reply")}</span>
    </Button>

    {#if formOpen}
        <div class="mt-3 pl-2 border-l-2 border-border">
            <CommentForm 
                {object_type} 
                {object_uuid} 
                parent={comment.uuid} 
                callback={handleCallback}
            />
        </div>
    {/if}
</div>
