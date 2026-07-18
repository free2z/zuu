<script lang="ts">
 import * as Pagination from "$lib/components/ui/pagination/index.js";
 import { page } from '$app/stores';
 
 let { count, currentPage, perPage, onPageChange } = $props<{
  count: number;
  currentPage: number;
  perPage: number;
  onPageChange: (page: number) => void;
 }>();
 
 // The Pagination component from shadcn-svelte expects 1-based index for 'page' prop
 // and handles 'onPageChange' internally via binding or event.
 // However, the snippet provided uses a children snippet which exposes the `pages` array.
 // We need to wire up the `onPageChange` correctly.
 // The default `Pagination.Link` automatically handles navigation if `href` is provided,
 // but here we want to intercept it or use a callback.
 
 // Since we are using a custom `onPageChange` to update URL params via `goto` in the parent,
 // we should probably use `href` on the links or handle clicks.
 // The shadcn-svelte Pagination component's `Pagination.Link` has an `href` prop.
 
 // Let's construct the href for each page link.
 function getPageUrl(p: number) {
  const url = new URL($page.url);
  url.searchParams.set('page', p.toString());
  return url.toString();
 }
</script>
 
{#if count > 0}
 <Pagination.Root {count} {perPage} page={currentPage}>
  {#snippet children({ pages, currentPage })}
   <Pagination.Content>
    <Pagination.Item>
     <Pagination.PrevButton 
      onclick={() => onPageChange(currentPage - 1)}
      disabled={currentPage <= 1}
      class={currentPage <= 1 ? "pointer-events-none opacity-50" : ""}
     >
      <span class="hidden sm:block">Previous</span>
     </Pagination.PrevButton>
    </Pagination.Item>
    
    {#each pages as page (page.key)}
     {#if page.type === "ellipsis"}
      <Pagination.Item>
       <Pagination.Ellipsis />
      </Pagination.Item>
     {:else}
      <Pagination.Item>
       <!-- We use onclick to prevent full page reload if we want client-side feel, 
            but standard href is also fine. The parent `onPageChange` does `goto(..., { noScroll: true })`.
            So we should intercept click. -->
       <Pagination.Link 
        {page} 
        isActive={currentPage === page.value}
        onclick={(e) => {
         e.preventDefault();
         onPageChange(page.value);
        }}
        href={getPageUrl(page.value)}
       >
        {page.value}
       </Pagination.Link>
      </Pagination.Item>
     {/if}
    {/each}
    
    <Pagination.Item>
     <Pagination.NextButton 
      onclick={() => onPageChange(currentPage + 1)}
      disabled={currentPage >= Math.ceil(count / perPage)}
      class={currentPage >= Math.ceil(count / perPage) ? "pointer-events-none opacity-50" : ""}
     >
      <span class="hidden sm:block">Next</span>
     </Pagination.NextButton>
    </Pagination.Item>
   </Pagination.Content>
  {/snippet}
 </Pagination.Root>
{/if}