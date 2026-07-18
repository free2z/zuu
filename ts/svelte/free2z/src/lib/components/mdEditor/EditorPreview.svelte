<script lang="ts">
  import { Eye } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import MarkdownContent from "$lib/components/MarkdownContent.svelte";

  let {
    title,
    description,
    content,
    showCover,
    coverImage,
    showSubtitle,
    renderedHtml,
    mode,
  } = $props();
</script>

<div
  class="flex flex-col bg-muted/20 {mode === 'split'
    ? 'w-full lg:w-1/2'
    : 'w-full'}"
>
  {#if title || content}
    <article
      class="preview-content prose-styles mx-auto w-full max-w-[900px] flex-1 px-6 py-8 leading-relaxed text-foreground md:px-12 md:py-16"
    >
      {#if showCover && coverImage}
        <div class="mb-8 aspect-[4/1] w-full overflow-hidden rounded-2xl">
          <img
            src={coverImage}
            alt="Cover"
            class="h-full w-full object-cover"
          />
        </div>
      {/if}
      {#if title}
        <h1
          class="mb-4 text-4xl leading-tight font-bold text-foreground md:text-5xl"
        >
          {title}
        </h1>
      {/if}
      {#if showSubtitle && description}
        <p class="mb-8 text-xl text-muted-foreground">{description}</p>
      {/if}
      <MarkdownContent html={renderedHtml} />
    </article>
  {:else}
    <div
      class="flex h-full flex-col items-center justify-center text-muted-foreground"
    >
      <Eye class="mb-3 h-12 w-12 opacity-20" />
      <p>{$t("editor.noPreview", "Nothing to preview yet")}</p>
      <p class="mt-1 text-xs">
        {$t("editor.startWriting", "Start writing to see your content here")}
      </p>
    </div>
  {/if}
</div>

<style>
  /* Essential Prose Styles for dynamic markdown rendering */
  .prose-styles :global(h1) {
    font-size: 2.25rem;
    font-weight: 700;
    color: var(--foreground);
    margin-top: 0;
    margin-bottom: 1.5rem;
    line-height: 1.2;
  }
  .prose-styles :global(h2) {
    font-size: 1.75rem;
    font-weight: 600;
    color: var(--foreground);
    margin-top: 2.5rem;
    margin-bottom: 1rem;
    line-height: 1.3;
  }
  .prose-styles :global(h3) {
    font-size: 1.375rem;
    font-weight: 600;
    color: var(--foreground);
    margin-top: 2rem;
    margin-bottom: 0.75rem;
    line-height: 1.4;
  }
  .prose-styles :global(p) {
    margin: 1.25rem 0;
    color: var(--muted-foreground);
  }
  .prose-styles :global(a) {
    color: var(--primary);
    text-decoration: underline;
    font-weight: 500;
    transition: opacity 0.15s ease;
  }
  .prose-styles :global(a:hover) {
    opacity: 0.8;
  }
  .prose-styles :global(strong) {
    color: var(--foreground);
    font-weight: 600;
  }
  .prose-styles :global(code) {
    background: var(--muted);
    color: var(--primary);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-family: ui-monospace, monospace;
    font-size: 0.875em;
  }
  .prose-styles :global(pre) {
    background: var(--muted);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    padding: 1.5rem;
    overflow-x: auto;
    margin: 1.5rem 0;
  }
  .prose-styles :global(pre code) {
    background: transparent;
    padding: 0;
    color: var(--foreground);
    font-size: 0.875rem;
    line-height: 1.6;
  }
  .prose-styles :global(blockquote) {
    border-left: 4px solid var(--primary);
    padding-left: 1rem;
    margin: 1.5rem 0;
    color: var(--muted-foreground);
    font-style: italic;
  }
  .prose-styles :global(ul),
  .prose-styles :global(ol) {
    margin: 1.25rem 0;
    padding-left: 1.75rem;
  }
  .prose-styles :global(ul) {
    list-style-type: disc;
  }
  .prose-styles :global(ol) {
    list-style-type: decimal;
  }
  .prose-styles :global(li) {
    display: list-item;
    margin: 0.5rem 0;
    color: var(--muted-foreground);
  }
  .prose-styles :global(ul ul) {
    list-style-type: circle;
  }
  .prose-styles :global(ul ul ul) {
    list-style-type: square;
  }
  .prose-styles :global(ol ol) {
    list-style-type: lower-alpha;
  }
  .prose-styles :global(ol ol ol) {
    list-style-type: lower-roman;
  }
  .prose-styles :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 0.5rem;
    margin: 2rem 0;
  }
  .prose-styles :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 3rem 0;
  }
  .prose-styles :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 2rem 0;
  }
  .prose-styles :global(th) {
    background: var(--muted);
    color: var(--foreground);
    font-weight: 600;
    padding: 0.75rem 1rem;
    text-align: left;
    border-bottom: 2px solid var(--border);
  }
  .prose-styles :global(td) {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    color: var(--muted-foreground);
  }
</style>
