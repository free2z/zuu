<script lang="ts">
    import { page } from "$app/state";
    import { env } from '$env/dynamic/public';
    import DisplayThreadedComment from './DisplayThreadedComment.svelte';
    import type { CommentData } from './types';

    export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
    export let object_uuid: string | undefined = undefined;
    export let parent: string | undefined = undefined;
    export let reload: number = 0;

    let comments: CommentData[] = [];
    const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '') || '';

    $: hasCommentTarget = page.url.hash.startsWith("#comment-");

    async function fetchComments(url: string, visitedUrls: Set<string>) {
        try {
            // If url is relative, prepend apiBase
            const fullUrl = url.startsWith('http') ? url : `${apiBase}${url}`;
            
            if (visitedUrls.has(fullUrl)) {
                console.warn('Circular pagination detected, stopping fetch');
                return;
            }
            visitedUrls.add(fullUrl);
            
            const res = await fetch(fullUrl);
            if (!res.ok) throw new Error('Failed to fetch comments');
            
            const data = await res.json();
            comments = [...comments, ...data.results];

            if (data.next) {
                fetchComments(data.next, visitedUrls);
            }
        } catch (error) {
            console.error(error);
        }
    }

    $: {
         // Trigger reactive statement when these props change
        const _ = { reload, parent, object_type, object_uuid };
        
        comments = [];
        let visitedUrls = new Set<string>();
        let url = '';
        if (object_type && object_uuid) {
            url = `/api/comments/${object_type}/${object_uuid}/?parent__isnull=True`;
        } else if (parent) {
            url = `/api/comments/${parent}/replies/`;
        }
        
        if (url) {
            fetchComments(url, visitedUrls);
        }
    }
</script>

{#if comments.length > 0}
    <div class="space-y-4 my-2">
        {#each comments as comment (comment.uuid)}
            <DisplayThreadedComment 
                {comment} 
                {object_type} 
                {object_uuid} 
                top={true} 
                expandAll={hasCommentTarget}
            />
        {/each}
    </div>
{/if}
