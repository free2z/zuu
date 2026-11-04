<script lang="ts">
  import { onMount } from "svelte";
  import { ChevronDown, ListTree } from "@lucide/svelte";
  import { loading, tStore as t } from "$lib/i18n";

  export let target: HTMLElement | undefined = undefined;

  type TocItem = {
    id: string;
    text: string;
    level: 1 | 2 | 3;
  };

  const SCROLL_OFFSET = 96;
  const MINIMAP_ITEM_SPACING = 8;
  const MINIMAP_MIN_HIT_AREA = 44;

  let items: TocItem[] = [];
  let headingEls: HTMLElement[] = [];
  let activeId = "";
  let inlineOpen = false;
  let indicatorVisible = false;
  let initialOpenStateSet = false;
  let observer: MutationObserver | undefined;
  let viewportTimer: number | undefined;
  let inlineTrigger: HTMLButtonElement;
  let tocAnchor: HTMLDivElement;
  let previewIndex: number | null = null;

  $: resolvedPreviewIndex =
    previewIndex !== null && previewIndex < items.length ? previewIndex : null;
  $: previewItem =
    resolvedPreviewIndex === null
      ? null
      : (items[resolvedPreviewIndex] ?? null);
  $: previewTop =
    resolvedPreviewIndex === null
      ? 0
      : getItemPosition(resolvedPreviewIndex, items.length);
  $: previewTranslate =
    resolvedPreviewIndex === 0
      ? "0%"
      : resolvedPreviewIndex === items.length - 1
        ? "-100%"
        : "-50%";

  function slugify(text: string) {
    return (
      text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-") || "section"
    );
  }

  // MarkdownContent appends a `#` permalink anchor inside each heading; it is
  // chrome, not part of the section title, so keep it out of the outline.
  function headingText(heading: HTMLElement) {
    return Array.from(heading.childNodes)
      .filter(
        (node) =>
          !(
            node instanceof HTMLElement &&
            node.classList.contains("heading-anchor")
          ),
      )
      .map((node) => node.textContent || "")
      .join("");
  }

  function uniqueHeadingId(
    heading: HTMLElement,
    used: Set<string>,
    scope: HTMLElement,
  ) {
    // Server-rendered headings already carry a gfmHeadingId, so this normally
    // takes the `heading.id ||` branch and changes nothing.
    const requestedId = heading.id || slugify(headingText(heading));
    let id = requestedId;
    let suffix = 2;

    // Deduping is scoped to `target`, not the whole document, on purpose. With
    // two MarkdownContent instances on one page (the article plus a comment
    // quoting the same heading), a document-wide check would rename the second
    // heading AFTER enhanceHeadings already baked href="#foo" into its own `#`
    // permalink — so that permalink would jump to the other element instead.
    while (
      used.has(id) ||
      Array.from(scope.querySelectorAll<HTMLElement>("[id]")).some(
        (element) => element !== heading && element.id === id,
      )
    ) {
      id = `${requestedId}-${suffix++}`;
    }

    heading.id = id;
    used.add(id);
    return id;
  }

  function collect() {
    if (!target) return;

    const headings = Array.from(
      target.querySelectorAll<HTMLElement>(
        '[data-article-heading="true"]:is(h1, h2, h3, h4)',
      ),
    );
    const levels = [
      ...new Set(headings.map((heading) => Number(heading.tagName[1]))),
    ].sort((a, b) => a - b);
    const visibleLevels = levels.slice(0, 3);
    const [top, second, third] = visibleLevels;

    headingEls = headings.filter((heading) => {
      const level = Number(heading.tagName[1]);
      return level === top || level === second || level === third;
    });

    const used = new Set<string>();
    let hasSemanticTopLevel = false;
    let hasSemanticSecondLevel = false;
    items = headingEls.map((heading) => {
      const semanticLevel =
        visibleLevels.indexOf(Number(heading.tagName[1])) + 1;
      let level: TocItem["level"] = 1;

      if (semanticLevel === 1) {
        hasSemanticTopLevel = true;
        hasSemanticSecondLevel = false;
      } else if (semanticLevel === 2 && hasSemanticTopLevel) {
        level = 2;
        hasSemanticSecondLevel = true;
      } else if (semanticLevel === 3) {
        level = hasSemanticSecondLevel ? 3 : hasSemanticTopLevel ? 2 : 1;
      }

      return {
        id: uniqueHeadingId(heading, used, target),
        text: headingText(heading).trim() || "Untitled section",
        level,
      };
    });

    if (!initialOpenStateSet && items.length > 2) {
      // Short outlines are useful at a glance. Longer ones begin collapsed so
      // they do not push the article itself below the fold.
      inlineOpen = items.length <= 6;
      initialOpenStateSet = true;
    }

    updateViewportState();
  }

  function updateActive() {
    let current = headingEls[0]?.id ?? "";
    for (const heading of headingEls) {
      if (heading.getBoundingClientRect().top <= SCROLL_OFFSET + 8)
        current = heading.id;
      else break;
    }
    activeId = current;
  }

  function updateViewportState() {
    updateActive();

    if (!tocAnchor || !target) {
      indicatorVisible = false;
      return;
    }

    const outlineBottom = tocAnchor.getBoundingClientRect().bottom;
    const articleBottom = target.getBoundingClientRect().bottom;
    indicatorVisible =
      outlineBottom <= SCROLL_OFFSET && articleBottom > SCROLL_OFFSET + 32;
  }

  function scheduleViewportUpdate() {
    if (viewportTimer !== undefined) return;
    viewportTimer = window.setTimeout(() => {
      viewportTimer = undefined;
      updateViewportState();
    }, 16);
  }

  function scrollToHeading(id: string) {
    const heading = document.getElementById(id);
    if (!heading) return;

    const top =
      heading.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    activeId = id;
  }

  function getItemPosition(index: number, itemCount: number) {
    if (itemCount <= 1) return 0;
    return (
      (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100
    );
  }

  function getTrackHeight(itemCount: number) {
    const naturalHeight = Math.max(1, (itemCount - 1) * MINIMAP_ITEM_SPACING);
    return `min(${naturalHeight}px, 70vh)`;
  }

  function getHitAreaHeight(itemCount: number) {
    const naturalHeight = Math.max(1, (itemCount - 1) * MINIMAP_ITEM_SPACING);
    return `min(max(${MINIMAP_MIN_HIT_AREA}px, ${naturalHeight}px), 70vh)`;
  }

  function getIndexFromPointer(event: MouseEvent) {
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : null;
    if (!rect || items.length === 0 || rect.height <= 0) return null;
    if (items.length === 1) return 0;

    const progress = Math.max(
      0,
      Math.min(1, (event.clientY - rect.top) / rect.height),
    );
    return Math.max(
      0,
      Math.min(items.length - 1, Math.round(progress * (items.length - 1))),
    );
  }

  function previewFromPointer(event: MouseEvent) {
    previewIndex = getIndexFromPointer(event);
  }

  function selectFromPointer(event: MouseEvent) {
    const index = getIndexFromPointer(event);
    const item = index === null ? null : items[index];
    if (item) scrollToHeading(item.id);
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.blur();
  }

  function movePreview(delta: number) {
    const activeIndex = Math.max(
      0,
      items.findIndex((item) => item.id === activeId),
    );
    const base = previewIndex ?? activeIndex;
    previewIndex = Math.max(0, Math.min(items.length - 1, base + delta));
  }

  function handleMinimapKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      movePreview(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      movePreview(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      previewIndex = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      previewIndex = items.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (previewItem) scrollToHeading(previewItem.id);
    }
  }

  function getMarkerWidth(
    index: number,
    item: TocItem,
    currentPreviewIndex: number | null,
  ) {
    if (currentPreviewIndex === null) {
      return item.level === 1 ? 24 : item.level === 2 ? 16 : 10;
    }

    const distance = Math.abs(index - currentPreviewIndex);
    if (distance === 0) return 28;
    if (distance === 1) return 20;
    if (distance === 2) return 14;
    return item.level === 1 ? 10 : item.level === 2 ? 8 : 6;
  }

  function handleDocumentKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    if (inlineOpen) {
      inlineOpen = false;
      inlineTrigger?.focus({ preventScroll: true });
    }
  }

  onMount(() => {
    observer = new MutationObserver(collect);
    document.addEventListener("keydown", handleDocumentKeydown);
    scheduleViewportUpdate();

    return () => {
      observer?.disconnect();
      document.removeEventListener("keydown", handleDocumentKeydown);
      if (viewportTimer !== undefined) window.clearTimeout(viewportTimer);
    };
  });

  // Markdown is injected into the article after mount. Observe the rendered
  // content so the outline also stays accurate after embeds and enhancements.
  $: if (observer && target) {
    observer.disconnect();
    observer.observe(target, { childList: true, subtree: true });
    collect();
  }
</script>

<svelte:window
  on:scroll={scheduleViewportUpdate}
  on:resize={scheduleViewportUpdate}
/>

{#if items.length > 2}
  <!-- Explicit outline at the article entrance. -->
  <div
    bind:this={tocAnchor}
    class="mx-auto w-full max-w-[800px] px-4 pt-7 sm:px-6"
  >
    <section aria-label="Table of contents">
      <button
        bind:this={inlineTrigger}
        type="button"
        class="group flex min-h-11 w-full cursor-pointer items-center gap-2.5 border-b border-border/70 px-0 pb-2 text-left transition-colors outline-none hover:text-primary focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/70"
        aria-expanded={inlineOpen}
        aria-controls="article-outline-inline"
        on:click={() => (inlineOpen = !inlineOpen)}
      >
        <ListTree class="size-4 shrink-0 text-primary/90" aria-hidden="true" />
        <span class="flex-1 text-sm font-medium">
          {!$loading ? $t("common.article.onThisPage") : "On this page"}
        </span>
        <ChevronDown
          class="size-4 shrink-0 text-muted-foreground transition-transform duration-200 {inlineOpen
            ? 'rotate-180'
            : ''}"
          aria-hidden="true"
        />
      </button>

      <div
        id="article-outline-inline"
        class="toc-inline-panel {inlineOpen ? 'is-open' : ''}"
        aria-hidden={!inlineOpen}
        inert={!inlineOpen}
      >
        <div class="min-h-0 overflow-hidden">
          <ol class="space-y-0.5 py-3">
            {#each items as item (item.id)}
              <li>
                <button
                  type="button"
                  class="group flex min-h-11 w-full cursor-pointer items-start gap-2 px-0 py-2.5 text-left text-sm leading-5 transition-colors outline-none hover:text-primary focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring/70 {item.level ===
                  3
                    ? 'pl-10 text-muted-foreground'
                    : item.level === 2
                      ? 'pl-5 text-muted-foreground'
                      : 'font-medium text-foreground'} {activeId === item.id
                    ? 'font-semibold text-foreground'
                    : ''}"
                  aria-current={activeId === item.id ? "location" : undefined}
                  on:click={() => scrollToHeading(item.id)}
                >
                  <span
                    class="mt-[0.6rem] block h-0.5 shrink-0 rounded-full transition-[width,background-color] duration-150 {activeId ===
                    item.id
                      ? 'w-5 bg-primary'
                      : item.level === 1
                        ? 'w-3 bg-muted-foreground/45'
                        : item.level === 2
                          ? 'w-2.5 bg-muted-foreground/35'
                          : 'w-2 bg-muted-foreground/30'}"
                    aria-hidden="true"
                  ></span>
                  <span class="text-pretty">{item.text}</span>
                </button>
              </li>
            {/each}
          </ol>
        </div>
      </div>
    </section>
  </div>

  <!-- Zrode-style minimap: preview one section, then click to jump. -->
  <nav
    class="toc-minimap fixed top-1/2 left-0 z-30 hidden w-20 -translate-y-1/2 xl:block {indicatorVisible
      ? 'opacity-100'
      : 'pointer-events-none -translate-x-1 opacity-0'}"
    aria-label="Article section navigator"
  >
    <div class="relative flex w-full items-center px-2 py-5 select-none">
      <button
        type="button"
        class="toc-rail relative w-11 cursor-pointer bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
        style:height={getHitAreaHeight(items.length)}
        aria-label={`Jump to section: ${previewItem?.text ?? items.find((item) => item.id === activeId)?.text ?? "Article section"} — use the up and down arrow keys to browse sections.`}
        on:blur={() => (previewIndex = null)}
        on:click={selectFromPointer}
        on:focus={() => {
          const currentIndex = items.findIndex((item) => item.id === activeId);
          previewIndex = currentIndex >= 0 ? currentIndex : 0;
        }}
        on:keydown={handleMinimapKeydown}
        on:mouseleave={() => (previewIndex = null)}
        on:mousemove={previewFromPointer}
        on:mousedown={(event) => event.preventDefault()}
      >
        <span
          class="pointer-events-none absolute top-1/2 left-0 w-11 -translate-y-1/2"
          style:height={getTrackHeight(items.length)}
          aria-hidden="true"
        >
          <span
            class="absolute top-0 left-3 h-full w-px bg-border/50"
            aria-hidden="true"
          ></span>

          {#each items as item, index (item.id)}
            <span
              class="toc-marker absolute left-0 h-0.5 -translate-y-1/2 rounded-full {activeId ===
              item.id
                ? 'bg-primary'
                : resolvedPreviewIndex === index
                  ? 'bg-foreground/75'
                  : 'bg-muted-foreground/35'}"
              style:top={`${getItemPosition(index, items.length)}%`}
              style:width={`${getMarkerWidth(index, item, resolvedPreviewIndex)}px`}
              aria-hidden="true"
            ></span>
          {/each}

          <span
            class="toc-preview absolute left-10 w-64 rounded-md bg-background/80 px-3 py-2.5 text-left text-foreground shadow-md shadow-black/10 backdrop-blur-md dark:shadow-black/30 {previewItem
              ? 'translate-x-0 opacity-100'
              : '-translate-x-1 opacity-0'}"
            style:top={`${previewTop}%`}
            style:transform={`translateY(${previewTranslate})`}
            aria-hidden={previewItem ? undefined : "true"}
          >
            <span class="block text-sm leading-5 font-medium text-pretty">
              {previewItem?.text ?? "Article section"}
            </span>
          </span>
        </span>
      </button>
    </div>
  </nav>
{/if}

<style>
  .toc-inline-panel {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows 200ms cubic-bezier(0.22, 1, 0.36, 1),
      opacity 150ms ease-out;
  }

  .toc-inline-panel.is-open {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .toc-minimap {
    transition:
      opacity 180ms ease-out,
      translate 180ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .toc-rail {
    border-radius: var(--f2z-radius-sm);
  }

  .toc-marker {
    transition:
      width 160ms cubic-bezier(0.22, 1, 0.36, 1),
      background-color 160ms ease-out;
  }

  .toc-preview {
    transition:
      opacity 160ms ease-out,
      translate 160ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .toc-inline-panel,
    .toc-minimap,
    .toc-marker,
    .toc-preview {
      transition-duration: 0.01ms;
    }
  }
</style>
